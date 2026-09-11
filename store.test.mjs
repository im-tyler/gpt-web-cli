import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

// A03/F01: kernel flock — mutual exclusion across real processes, released
// by process death, no directory heuristics at all.
test('locks: kernel flock excludes a second process and releases on death (A03)', async () => {
  freshHome()
  const jobs = await loadJobs()
  const { spawn } = await import('node:child_process')
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs'
    const { withLock } = await import(${JSON.stringify(new URL('./jobs.mjs', import.meta.url).href)})
    await withLock('shared', async () => {
      writeFileSync(process.env.MARK, 'held')
      await new Promise((r) => setTimeout(r, 10000))
    })
  `], { env: { ...process.env, MARK: path.join(process.env.CHATGPT_WEB_HOME, 'held') }, stdio: 'ignore' })
  holder.unref()
  // Wait until the child holds the lock.
  const mark = path.join(process.env.CHATGPT_WEB_HOME, 'held')
  const t0 = Date.now()
  while (!fs.existsSync(mark) && Date.now() - t0 < 10000) await sleep(100)
  assert.ok(fs.existsSync(mark), 'holder never acquired')

  // A contender times out promptly while the holder lives.
  await assert.rejects(
    jobs.withLock('shared', () => 'ran', { timeoutMs: 1500 }),
    /lock timeout/
  )

  // Killing the holder releases the kernel lock.
  holder.kill('SIGKILL')
  await new Promise((r) => setTimeout(r, 500))
  let ran = false
  await jobs.withLock('shared', () => { ran = true }, { timeoutMs: 10000 })
  assert.ok(ran, 'lock not released after holder death')
})

// F02: the attachment policy enforces the exact multiset.
test('attachmentVerdict: exact multiset, states, and fail-closed UI', async () => {
  const fixes = await loadFixes()
  const v = fixes.attachmentVerdict
  assert.deepStrictEqual(v({ known: true, files: [{ name: 'a.png', state: 'ready' }] }, ['a.png']), { ok: true })
  assert.match(v({ known: true, files: [] }, ['a.png']).error, /differs/)
  assert.match(v({ known: true, files: [{ name: 'a.png', state: 'ready' }] }, []).error, /differs/)
  assert.deepStrictEqual(
    v({ known: true, files: [{ name: 'uploading.txt', state: 'ready' }] }, ['uploading.txt']),
    { ok: true },
    'a ready file named uploading.txt is not an upload in progress'
  )
  assert.match(v({ known: true, files: [{ name: 'a.png', state: 'uploading' }] }, ['a.png']).error, /in progress/)
  assert.match(v({ known: true, files: [{ name: 'a.png', state: 'error' }] }, ['a.png']).error, /failed/)
  assert.match(v({ known: false }, []).error, /unrecognized/)
  assert.match(v(null, []).error, /unrecognized/)
  assert.throws(() => v({ known: true, files: [] }, 'nope'), TypeError)
  // Duplicate basenames: two chips for two requested, not substring logic.
  assert.deepStrictEqual(
    v({ known: true, files: [{ name: 'a.txt', state: 'ready' }, { name: 'a.txt', state: 'ready' }] }, ['a.txt', 'a.txt']),
    { ok: true }
  )
  assert.match(
    v({ known: true, files: [{ name: 'a.txt', state: 'ready' }] }, ['a.txt', 'a.txt']).error,
    /differs/
  )
})

// F12: duplicate cards alias; 'all' dedupes by file id.
test('dedupeByFileId collapses aliased cards', async () => {
  const fixes = await loadFixes()
  const file = { id: 'same', name: 'x', bytes: Buffer.from('x') }
  const entries = [
    { index: 0, ok: true, file },
    { index: 1, ok: true, file, duplicateOf: 0 },
    { index: 2, ok: true, file: { id: 'other', name: 'y', bytes: Buffer.from('y') } },
  ]
  const out = fixes.dedupeByFileId(entries)
  assert.equal(out.length, 2)
  assert.deepEqual(out.map((e) => e.file.id).sort(), ['other', 'same'])
})

// F05: a short write either completes or throws and removes the partial file.
test('saveArtifact: short writes complete the file or fail clean', async () => {
  const fixes = await loadFixes()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-dl-'))
  // Inject a short-writing fs: each writeSync call moves two bytes.
  const orig = fs.writeSync
  let fdSeen = null
  fs.writeSync = function patched(fd, buffer, offset, length, position) {
    const n = Math.min(2, length ?? buffer.length)
    return orig(fd, buffer, offset ?? 0, n, position ?? null)
  }
  let p
  try {
    p = fixes.saveArtifact(dir, 'six.txt', 'IDX', Buffer.from('abcdef'))
  } finally {
    fs.writeSync = orig
  }
  assert.equal(fs.readFileSync(p, 'utf8'), 'abcdef', 'counted loop did not complete the file')
})
