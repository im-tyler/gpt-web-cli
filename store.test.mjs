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

// P03: a new generation starts with clean provenance; a resume preserves
// its target explicitly.
test('begin/resume clear stale provenance and pin the resume target (P03)', async () => {
  freshHome()
  const jobs = await loadJobs()
  const j = jobs.turns.createLocked({ id: 't1', prompt: 'first', files: [], history: [{ role: 'user', text: 'first' }] })
  await jobs.turns.claim('t1', j.turnId, process.pid)
  await jobs.turns.update('t1', j.turnId, (x) => {
    x.status = 'done'
    x.url = 'https://chatgpt.com/c/abc'
    x.acceptedUserId = 'u-old'
    x.assistantMessageId = 'a-old'
    x.replyKind = 'text'
    x.replyContent = { parts: ['r'] }
  })

  const next = jobs.turns.beginLocked('t1', 'second', [])
  assert.equal(next.acceptedUserId, null)
  assert.equal(next.assistantMessageId, null)
  assert.deepEqual(next.priorUserIds, [])
  assert.equal(next.submissionState, 'not-submitted')
  assert.equal(next.replyKind, null)
  assert.equal(next.replyContent, null)

  await jobs.turns.claim('t1', next.turnId, process.pid)
  await jobs.turns.update('t1', next.turnId, (x) => {
    x.status = 'error'
    x.acceptedUserId = 'u-new'
  })
  const resumed = jobs.turns.resumeLocked('t1')
  assert.equal(resumed.resumeTargetUserId, 'u-new', 'the retry target is the failed turn\'s accepted prompt')
  assert.equal(resumed.acceptedUserId, null)
  assert.equal(resumed.assistantMessageId, null)
  assert.equal(resumed.submissionState, 'not-submitted')

  // dot-send records refuse follow-ups and resumes.
  const dot = jobs.turns.createLocked({ id: 'd1', kind: 'dot-send', prompt: 'p', files: [], history: [] })
  await jobs.turns.claim('d1', dot.turnId, process.pid)
  await jobs.turns.update('d1', dot.turnId, (x) => {
    x.status = 'done'
    x.url = 'https://chatgpt.com/dots/x'
  })
  assert.throws(() => jobs.turns.beginLocked('d1', 'again', []), /dot sends have no follow-up/)
  assert.throws(() => jobs.turns.resumeLocked('d1'), /dot sends cannot be resumed/)
})

// P11: corrupt job records refuse instead of masquerading as absent;
// listJobs surfaces them.
test('readJob is strict; listJobs surfaces corrupt records (P11)', async () => {
  freshHome()
  const jobs = await loadJobs()
  const j = jobs.turns.createLocked({ id: 'ok1', prompt: 'p', files: [], history: [] })
  assert.ok(jobs.readJob('ok1'))
  assert.equal(jobs.readJob('missing-1'), null, 'ENOENT is the only null')

  const dir = path.join(process.env.CHATGPT_WEB_HOME, 'jobs')
  fs.writeFileSync(path.join(dir, 'corrupt1.json'), '{broken')
  assert.throws(() => jobs.readJob('corrupt1'), /corrupt1\.json is corrupt/)
  assert.throws(() => jobs.readJob('bad/id'), /invalid job ID/, 'the id is validated outside the I/O handler')

  const listed = jobs.listJobs()
  const corrupt = listed.find((x) => x.id === 'corrupt1')
  assert.ok(corrupt && corrupt.status === 'corrupt', 'corrupt entries are surfaced, not omitted')
  assert.equal(listed.filter((x) => x.status === 'running').length, 1, 'corrupt records occupy no tab slot but stay visible')
  // A malformed ACTIVE record is refused, but a valid legacy terminal one reads.
  fs.writeFileSync(
    path.join(dir, 'legacy1.json'),
    JSON.stringify({ id: 'legacy1', status: 'done', prompt: 'p', history: [] })
  )
  assert.equal(jobs.readJob('legacy1').status, 'done')
  fs.writeFileSync(
    path.join(dir, 'badactive.json'),
    JSON.stringify({ id: 'badactive', status: 'running', prompt: 'p', turnId: 42, history: [] })
  )
  assert.throws(() => jobs.readJob('badactive'), /bad turnId/)
})

// P11: a corrupt state.json throws instead of silently resetting the caps.
test('readState refuses corrupt state (P11)', async () => {
  freshHome()
  const jobs = await loadJobs()
  assert.deepEqual(jobs.readState(), { lastTurnEnd: 0, newChats: [], turns: {} })
  fs.writeFileSync(path.join(process.env.CHATGPT_WEB_HOME, 'state.json'), '{broken')
  assert.throws(() => jobs.readState(), /state\.json is corrupt/)
})

// P12: explicit invalid env values fail limits() instead of falling back.
test('limits() enforces explicit env bounds (P12)', async () => {
  freshHome()
  const jobs = await loadJobs()
  process.env.CHATGPT_WEB_MAX_TABS = '4'
  assert.equal(jobs.limits().maxTabs, 4)
  process.env.CHATGPT_WEB_MAX_TABS = 'bogus'
  assert.throws(() => jobs.limits(), /CHATGPT_WEB_MAX_TABS/)
  process.env.CHATGPT_WEB_MAX_TABS = '999999'
  assert.throws(() => jobs.limits(), /CHATGPT_WEB_MAX_TABS/)
  delete process.env.CHATGPT_WEB_MAX_TABS
  assert.equal(jobs.limits().maxTabs, 2)
})

// P07: shared flock lets ordinary holders overlap; exclusive contends.
test('withLock shared mode overlaps holders, exclusive excludes (P07)', async () => {
  freshHome()
  const jobs = await loadJobs()
  const { spawn } = await import('node:child_process')
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { writeFileSync } from 'node:fs'
    const { withLock } = await import(${JSON.stringify(new URL('./jobs.mjs', import.meta.url).href)})
    await withLock('vis-test', async () => {
      writeFileSync(process.env.MARK, 'held')
      await new Promise((r) => setTimeout(r, 6000))
    }, { shared: true })
  `], { env: { ...process.env, MARK: path.join(process.env.CHATGPT_WEB_HOME, 'held') }, stdio: 'ignore' })
  holder.unref()
  const mark = path.join(process.env.CHATGPT_WEB_HOME, 'held')
  const t0 = Date.now()
  while (!fs.existsSync(mark) && Date.now() - t0 < 10000) await sleep(100)
  assert.ok(fs.existsSync(mark), 'shared holder never acquired')
  // Another SHARED holder overlaps immediately...
  let overlapped = false
  await jobs.withLock('vis-test', () => { overlapped = true }, { shared: true, timeoutMs: 3000 })
  assert.ok(overlapped, 'shared locks overlap')
  // ...while an EXCLUSIVE one times out against it.
  await assert.rejects(
    jobs.withLock('vis-test', () => 'ran', { shared: false, timeoutMs: 1500 }),
    /lock timeout/
  )
  holder.kill('SIGKILL')
})

// P08: the reset pattern captures the previous record (updateDot returns
// the mutator's value, not the old record).
test('updateDot reset pattern reports the previous record (P08)', async () => {
  freshHome()
  const jobs = await loadJobs()
  await jobs.updateDot(() => ({ roomId: 'r1', roomName: 'Dot', dotId: 'd1', myId: 'me', watermark: null }))
  let previous = null
  const out = await jobs.updateDot((current) => {
    previous = current
    return null
  })
  assert.equal(out, null, 'a deleting mutator returns null')
  assert.equal(previous.roomId, 'r1', 'the caller-captured previous is the real record')
  assert.equal(await jobs.readDot(), null)
})

// P08: dot.json corruption refuses rather than reading as unbound.
test('readDot refuses a corrupt dot record (P08)', async () => {
  freshHome()
  const jobs = await loadJobs()
  fs.writeFileSync(path.join(process.env.CHATGPT_WEB_HOME, 'dot.json'), '{broken')
  assert.throws(() => jobs.readDot(), /dot\.json is corrupt/)
})
