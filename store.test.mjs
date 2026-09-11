import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// Every test gets its own HOME so the real ~/.chatgpt-web is untouched.
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-test-'))
  process.env.CHATGPT_WEB_HOME = home
  process.env.CHATGPT_WEB_MIN_GAP = '0'
  return home
}

async function loadJobs() {
  // Invalidate any cached ESM instance from a previous HOME.
  const mod = await import(`./jobs.mjs?h=${crypto.randomUUID()}`)
  return mod
}

test('writeJob refuses to regress a completed job (F08)', async () => {
  freshHome()
  const jobs = await loadJobs()
  const j = {
    id: 't1',
    status: 'running',
    prompt: 'p',
    history: [{ role: 'user', text: 'p' }],
    createdAt: new Date().toISOString(),
  }
  await jobs.writeJob({ ...j, status: 'done', reply: 'the real reply' })
  // A stale reaper snapshot arrives after the completion:
  const kept = await jobs.writeJob({ ...j, status: 'error', error: 'runner died' })
  assert.equal(kept.status, 'done')
  assert.equal(kept.reply, 'the real reply')
  const onDisk = jobs.readJob('t1')
  assert.equal(onDisk.status, 'done')
  assert.equal(onDisk.reply, 'the real reply')
})

test('reapStale files a dead pid but never touches a done job (F08)', async () => {
  freshHome()
  const jobs = await loadJobs()
  await jobs.writeJob({
    id: 'dead',
    status: 'streaming',
    createdAt: new Date().toISOString(),
    pid: 99999999,
    prompt: 'p',
  })
  await jobs.writeJob({
    id: 'alive-and-done',
    status: 'done',
    createdAt: new Date().toISOString(),
    pid: 99999999, // dead pid on a done job: must not matter
    prompt: 'p',
    reply: 'r',
  })
  await jobs.reapStale()
  assert.equal(jobs.readJob('dead').status, 'error')
  assert.match(jobs.readJob('dead').error, /runner died/)
  assert.equal(jobs.readJob('alive-and-done').status, 'done')
})

test('a pid-less running job is a reservation inside its lease, reaped after (F10, F12)', async () => {
  freshHome()
  const jobs = await loadJobs()
  const fresh = {
    id: 'fresh',
    status: 'running',
    pid: null,
    createdAt: new Date().toISOString(),
    prompt: 'p',
  }
  await jobs.writeJob(fresh)
  assert.equal(jobs.runningJobs().length, 1, 'reservation occupies a slot')
  await jobs.reapStale()
  assert.equal(jobs.readJob('fresh').status, 'running', 'lease still valid')

  const stale = {
    ...fresh,
    id: 'stale',
    createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
  }
  await jobs.writeJob(stale)
  // A reservation past its lease does not occupy a slot: the dead handoff
  // must not wedge admission until someone reaps it by hand.
  assert.equal(jobs.runningJobs().length, 1, 'expired reservation still held a slot')
  await jobs.reapStale()
  assert.equal(jobs.readJob('stale').status, 'error')
  assert.match(jobs.readJob('stale').error, /never started/)
  assert.equal(jobs.runningJobs().length, 1)
})

test('admission is a transaction: concurrent starts cannot exceed the cap (F07, F10)', async () => {
  freshHome()
  const jobs = await loadJobs()
  process.env.CHATGPT_WEB_MAX_TABS = '2'
  const attempts = 8
  const results = await Promise.all(
    Array.from({ length: attempts }, () =>
      jobs.withStoreLock(async () => {
        if (jobs.runningJobs().length >= 2) return 'rejected'
        const limErr = await jobs.updateState((s) => {
          const e = jobs.checkLimits(s, true)
          if (!e) jobs.recordTurn(s, true)
          return e
        })
        if (limErr) return 'rejected'
        const j = {
          id: 'j' + crypto.randomUUID().slice(0, 6),
          status: 'running',
          pid: null,
          createdAt: new Date().toISOString(),
          prompt: 'p',
          history: [{ role: 'user', text: 'p' }],
        }
        jobs.writeJobLocked(j)
        return 'admitted'
      })
    )
  )
  const admitted = results.filter((r) => r === 'admitted').length
  assert.equal(admitted, 2, `admitted ${admitted}, want exactly the cap of 2`)
})

test('updateState serialises: concurrent recordTurn increments all survive (F09)', async () => {
  freshHome()
  const jobs = await loadJobs()
  await Promise.all(
    Array.from({ length: 10 }, () => jobs.updateState((s) => jobs.recordTurn(s, true)))
  )
  const s = jobs.readState()
  const today = s.turns[new Date().toISOString().slice(0, 10)]
  assert.equal(today, 10, `counted ${today}, want 10 — lost updates`)
})

test('saveArtifact never clobbers: collisions get distinct names, symlinks refused (F17)', async () => {
  const { saveArtifact } = await import(`./runner.mjs?h=${crypto.randomUUID()}`)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-dl-'))
  const a = saveArtifact(dir, 'a b.txt', 'IDONE', Buffer.from('first'))
  const b = saveArtifact(dir, 'a?b.txt', 'IDTWO', Buffer.from('second'))
  assert.notEqual(a, b, 'distinct artifacts collapsed onto one path')
  assert.equal(fs.readFileSync(a, 'utf8'), 'first')
  assert.equal(fs.readFileSync(b, 'utf8'), 'second')

  const pre = path.join(dir, 'existing-IDX-file.txt')
  fs.writeFileSync(pre, 'precious')
  const c = saveArtifact(dir, 'existing file.txt', 'IDX', Buffer.from('new'))
  assert.notEqual(c, pre)
  assert.equal(fs.readFileSync(pre, 'utf8'), 'precious', 'pre-existing file overwritten')

  const link = path.join(dir, 'linked_file-IDY.txt')
  fs.symlinkSync(pre, link)
  assert.throws(() => saveArtifact(dir, 'linked file.txt', 'IDY', Buffer.from('x')), /symlink/)
})

test('withLock cleanup is token-guarded: a displaced holder cannot delete a successor (F11)', async () => {
  freshHome()
  const jobs = await loadJobs()
  const dir = path.join(process.env.CHATGPT_WEB_HOME, 'locks', 'guarded.lock')
  fs.mkdirSync(dir, { recursive: true })
  // Simulate a displaced holder's finally: the lock now belongs to someone
  // else's token.
  fs.writeFileSync(
    path.join(dir, 'owner.json'),
    JSON.stringify({ pid: process.pid, token: 'successor-token', at: Date.now() })
  )
  let ran = false
  await jobs.withLock('guarded', () => {
    ran = true
  }, { timeoutMs: 3000 }).catch(() => {})
  assert.equal(ran, false, 'second holder acquired while the successor held it?')
  // The successor's lock directory must still exist.
  assert.ok(fs.existsSync(dir), 'displaced holder deleted the successor lock')
})
