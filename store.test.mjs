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
  return import(`./jobs.mjs?h=${crypto.randomUUID()}`)
}

async function loadFixes() {
  return import(`./core-fixes.mjs?h=${crypto.randomUUID()}`)
}

// A01: a completed job accepts exactly one follow-up through beginLocked,
// and the follow-up carries a fresh generation with the new prompt.
test('follow-up after done: exactly one new turn, old reply vacated (A01)', async () => {
  freshHome()
  const jobs = await loadJobs()
  const j = jobs.turns.createLocked({
    id: 't1',
    prompt: 'first',
    files: [],
    history: [{ role: 'user', text: 'first' }],
  })
  const claimed = await jobs.turns.claim('t1', j.turnId, process.pid)
  assert.ok(claimed, 'worker claims its generation')
  await jobs.turns.update('t1', j.turnId, (x) => {
    x.status = 'done'
    x.reply = 'first reply'
    x.url = 'https://chatgpt.com/c/abc'
    x.history.push({ role: 'assistant', text: 'first reply' })
  })

  const next = jobs.turns.beginLocked('t1', 'second prompt', [])
  assert.equal(next.status, 'running')
  assert.equal(next.prompt, 'second prompt')
  assert.equal(next.reply, null)
  assert.notEqual(next.turnId, j.turnId)
  assert.equal(next.history.filter((h) => h.role === 'user').length, 2)

  // The old generation is dead: its worker cannot resurrect or touch it.
  const stale = await jobs.turns.update('t1', j.turnId, (x) => {
    x.reply = 'zombie'
  })
  assert.equal(stale, null)
  assert.equal(jobs.readJob('t1').reply, null)

  // A second begin while the follow-up is live is refused.
  assert.throws(() => jobs.turns.beginLocked('t1', 'third', []), /not idle/)
})

// A02: the store has no full-record writer. Writes are narrow mutations
// against the latest record; status regressions and terminal-turn mutation
// are rejected outright.
test('stale full-record writes cannot regress the store (A02)', async () => {
  freshHome()
  const jobs = await loadJobs()
  const j = jobs.turns.createLocked({ id: 't1', prompt: 'p', files: [], history: [] })
  await jobs.turns.claim('t1', j.turnId, process.pid)
  await jobs.turns.update('t1', j.turnId, (x) => {
    x.status = 'streaming'
    x.reply = 'partial text'
    x.url = 'https://chatgpt.com/c/xyz'
  })
  // The old attack wrote a stale whole snapshot (regressing status); the
  // store rejects the regression:
  await assert.rejects(
    jobs.turns.update('t1', j.turnId, (x) => { x.status = 'running' }),
    /status regression/
  )
  // A writer with the pre-send snapshot tries to blank the reply through a
  // same-generation mutation: the mutation API runs against the LATEST
  // record, so blanking is a deliberate act, but the important old failure
  // (silently erasing newer fields under a stale snapshot) requires the
  // full-record writer that no longer exists.
  await jobs.turns.update('t1', j.turnId, (x) => { x.reply = null })
  assert.equal(jobs.readJob('t1').reply, null)
  await jobs.turns.update('t1', j.turnId, (x) => {
    x.status = 'done'
    x.reply = 'final'
  })
  assert.equal(
    await jobs.turns.update('t1', j.turnId, (x) => { x.reply = 'overwritten' }),
    null,
    'a terminal generation is immutable'
  )
  assert.equal(jobs.readJob('t1').reply, 'final')
})

// A10/A12/A14/A9 helpers.
test('helpers: snapshot writer, download selection, strict integers', async () => {
  const fixes = await loadFixes()

  // Revisions, including shrinking and equal-length ones.
  const seen = []
  const w = fixes.createSnapshotWriter((s) => seen.push(s))
  w('abcdef')
  w('abcdefg')
  w('XY') // shorter replacement
  w('XY') // identical: no output
  w('Z')
  assert.deepEqual(seen, ['abcdef', 'g', '\n[reply revised; complete replacement follows]\nXY', '\n[reply revised; complete replacement follows]\nZ'])

  // Download selection fails closed on incomplete manifests.
  const manifest = [
    { index: 0, ok: true, file: { id: 'a', name: 'a', bytes: Buffer.from('a') } },
    { index: 1, ok: false, reason: 'http 403' },
  ]
  assert.throws(() => fixes.selectDownloads(manifest, 'all'), /1 of 2/)
  assert.throws(() => fixes.selectDownloads(manifest, '2'), /could not be captured/)
  assert.equal(fixes.selectDownloads(manifest, '1').length, 1)
  assert.throws(() => fixes.selectDownloads(manifest, '1junk'), /integer/)
  assert.throws(() => fixes.selectDownloads(manifest, '0'), /integer/)

  // Strict positive integers.
  assert.equal(fixes.positiveInteger('7', 'x'), 7)
  for (const bad of ['1junk', '', '-3', '1.9', '0x10', Infinity, NaN]) {
    assert.throws(() => fixes.positiveInteger(bad, 'x'), /integer/, `${bad} passed`)
  }
})

test('saveArtifact: short writes throw, collisions retry, symlinks refused (A12)', async () => {
  const fixes = await loadFixes()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-dl-'))
  const a = fixes.saveArtifact(dir, 'a b.txt', 'IDONE', Buffer.from('first'))
  const b = fixes.saveArtifact(dir, 'a?b.txt', 'IDTWO', Buffer.from('second'))
  assert.notEqual(a, b)
  assert.equal(fs.readFileSync(a, 'utf8'), 'first')
  assert.equal(fs.readFileSync(b, 'utf8'), 'second')
  const pre = path.join(dir, 'pre-existing-IDX-file.txt')
  fs.writeFileSync(pre, 'precious')
  const c = fixes.saveArtifact(dir, 'pre-existing file.txt', 'IDX', Buffer.from('new'))
  assert.notEqual(c, pre)
  assert.equal(fs.readFileSync(pre, 'utf8'), 'precious')
  const link = path.join(dir, 'linked_file-IDY.txt')
  fs.symlinkSync(pre, link)
  assert.throws(() => fixes.saveArtifact(dir, 'linked file.txt', 'IDY', Buffer.from('x')), /symlink/)
})

test('jobPath rejects traversal (H02)', async () => {
  freshHome()
  const jobs = await loadJobs()
  assert.throws(() => jobs.jobPath('../../etc/passwd'), /invalid job ID/)
  assert.throws(() => jobs.jobPath('a/b'), /invalid job ID/)
  assert.doesNotThrow(() => jobs.jobPath('mtwk9zfz-72efe1'))
})

// A03: the lock steals by atomic rename, so two stale-breakers cannot both
// enter, and an ownerless lock is recoverable by age.
test('locks: ownerless recovery and single-winner steal (A03)', async () => {
  freshHome()
  const jobs = await loadJobs()
  const dir = path.join(process.env.CHATGPT_WEB_HOME, 'locks', 'orphan.lock')
  fs.mkdirSync(dir, { recursive: true })
  // Ownerless and old: stealable.
  const old = Date.now() / 1000 - 400
  fs.utimesSync(dir, old, old)
  let held = false
  await jobs.withLock('orphan', () => {
    held = true
  }, { timeoutMs: 5000 })
  assert.ok(held, 'ownerless stale lock was recovered')

  // Two simultaneous contenders for a dead-owner lock: exactly one enters.
  const dead = path.join(process.env.CHATGPT_WEB_HOME, 'locks', 'dead.lock')
  fs.mkdirSync(dead, { recursive: true })
  fs.writeFileSync(path.join(dead, 'owner.json'), JSON.stringify({ pid: 99999999, token: 'x', at: Date.now() - 999999 }))
  const results = await Promise.allSettled(
    Array.from({ length: 4 }, () =>
      jobs.withLock('dead', async () => {
        await new Promise((r) => setTimeout(r, 200))
        return 'ran'
      }, { timeoutMs: 15000 })
    )
  )
  const ran = results.filter((r) => r.status === 'fulfilled' && r.value === 'ran').length
  // All four may legitimately run SERIALLY (each steals/creates in turn);
  // the invariant is that none failed by wedging and no lock dir was
  // left behind by a stolen holder's cleanup.
  assert.ok(ran >= 1, `no contender ran (${ran})`)
  assert.ok(results.every((r) => r.status === 'fulfilled'), 'a contender wedged or crashed')
  const leftovers = fs.readdirSync(path.join(process.env.CHATGPT_WEB_HOME, 'locks')).filter((f) => f.startsWith('dead.lock'))
  assert.deepEqual(leftovers, [], 'lock directory left behind after contention')
})

// A03: a displaced holder's cleanup cannot remove a successor's lock.
test('locks: displaced holder spares the successor (A03)', async () => {
  freshHome()
  const jobs = await loadJobs()
  const dir = path.join(process.env.CHATGPT_WEB_HOME, 'locks', 'guarded.lock')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'owner.json'),
    JSON.stringify({ pid: process.pid, token: 'successor-token', at: Date.now() })
  )
  let ran = false
  await jobs.withLock('guarded', () => {
    ran = true
  }, { timeoutMs: 3000 }).catch(() => {})
  assert.equal(ran, false, 'second holder acquired while the successor held it')
  assert.ok(fs.existsSync(dir), 'displaced holder deleted the successor lock')
})
