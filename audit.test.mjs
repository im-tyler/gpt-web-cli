// Regression suite for the 2026-10-06 audit fixes: prompt identity, API
// acceptance baselines, branch-aware reply inspection, dot checkpoints,
// deletion planning, CLI parsing, strict env/IO. All pure-fixture tests —
// no browser, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  canonicalPrompt,
  samePrompt,
  conversationId,
  conversationUrl,
  conversationSnapshot,
  findAcceptedUser,
  inspectReply,
  parseSliderDescription,
  integerEnv,
  planDeletion,
  parseCli,
  assertWaitGeneration,
  boundedArtifactName,
  withRestoredPicker,
  dotPollBatch,
  afterDotSend,
  assertDotWindow,
  retriablePollError,
  pollDelayMs,
  pollBackoffMs,
  collectConversationListing,
  dotSendInterruption,
  deleteEvalBoundMs,
  sequentialFetchBoundMs,
  acceptanceBackoffMs,
} from './audit-core.mjs'
import { writeJSONAtomic, readJSONStrict, validateUploads, ARTIFACT_MAX_BYTES, evaluateBounded, installInterruptionFence } from './audit-io.mjs'
import { attachmentVerdict } from './core-fixes.mjs'

// ----- P01: prompt identity -------------------------------------------------

test('canonicalPrompt normalizes line endings only', () => {
  assert.equal(canonicalPrompt('a\r\nb'), 'a\nb')
  assert.equal(canonicalPrompt('a\n\nb'), 'a\n\nb', 'blank lines are authored content, not noise')
  assert.equal(canonicalPrompt('  indented\n    code  '), '  indented\n    code  ', 'indentation is preserved')
  assert.equal(canonicalPrompt('a b'), 'a b')
})

test('samePrompt refuses whitespace-flattened equivalents', () => {
  assert.ok(samePrompt('a\nb', 'a\r\nb'))
  assert.ok(!samePrompt('a b', 'a\nb'), 'a space is not a newline')
  assert.ok(!samePrompt('a\n\nb', 'a\nb'), 'a collapsed blank line is a different prompt')
  // The old self-link normalization rewrote literal markdown; it is gone.
  assert.ok(!samePrompt('see [x](x)', 'see x'))
})

test('conversationId / conversationUrl extract and normalize', () => {
  const id = 'abc12345-1234-1234-1234-1234567890ab'
  assert.equal(conversationId('https://chatgpt.com/c/' + id + '?stuff=1'), id)
  assert.equal(conversationId(id), id)
  assert.throws(() => conversationId('nonsense/../etc'), /not a conversation id/)
  assert.equal(conversationUrl('https://chatgpt.com/c/' + id + '/'), 'https://chatgpt.com/c/' + id)
  assert.equal(conversationUrl('https://chatgpt.com/c/' + id + '?x=1#frag'), 'https://chatgpt.com/c/' + id)
  assert.throws(() => conversationUrl('https://evil.com/c/' + id), /not a chatgpt\.com/)
  assert.throws(() => conversationUrl('https://chatgpt.com/'), /no conversation path/)
})

// Build API-shaped conversation fixtures.
let seq = 0
function msg(id, role, text, { create, status = 'finished_successfully', endTurn = true, recipient = 'all', contentType = 'text', parts } = {}) {
  return {
    id,
    author: { role },
    create_time: create ?? ++seq,
    content: { content_type: contentType, parts: parts !== undefined ? parts : [text] },
    status,
    end_turn: endTurn,
    recipient,
  }
}
function fixture(...messages) {
  const mapping = {}
  for (const m of messages) mapping[m.id] = { message: m, children: [] }
  return { mapping }
}

test('conversationSnapshot: parts concatenate without invented separators; allUserIds complete', () => {
  const snap = conversationSnapshot(
    fixture(
      msg('u1', 'user', '', { parts: ['hel', 'lo'] }),
      msg('a1', 'assistant', '', { parts: ['wor', 'ld'] })
    )
  )
  assert.equal(snap.branch[0].text, 'hello', 'no \\n join between parts')
  assert.equal(snap.branch[1].text, 'world')
  assert.deepEqual([...snap.allUserIds], ['u1'], 'empty-text user messages still baseline their id')
})

// HEADLINE 1: the repeated-prompt acceptance bug. The DOM-id baseline was
// always empty on the 2026-10 UI, so the old newest-text match could
// "accept" an earlier identical message. The API baseline fixes it.
test('findAcceptedUser requires a NEW id, not just matching text', () => {
  const snap = conversationSnapshot(
    fixture(
      msg('u1', 'user', 'deliver the report please'),
      msg('a1', 'assistant', 'here it is'),
      msg('u2', 'user', 'deliver the report please') // the repeat being sent NOW
    )
  )
  // Empty baseline (the old DOM snapshot): the repeat matches — this is the
  // residual, documented limitation, newest wins.
  assert.equal(findAcceptedUser(snap, { priorUserIds: [], prompt: 'deliver the report please' }).id, 'u2')
  // Correct API baseline: u1 is prior, so acceptance must be u2 and only u2.
  assert.equal(
    findAcceptedUser(snap, { priorUserIds: new Set(['u1']), prompt: 'deliver the report please' }).id,
    'u2'
  )
  // If the send did NOT land, the baseline excludes every candidate: the
  // old code accepted u2-by-text or u1; the new one accepts nothing.
  const before = conversationSnapshot(fixture(msg('u1', 'user', 'deliver the report please'), msg('a1', 'assistant', 'here it is')))
  assert.equal(
    findAcceptedUser(before, { priorUserIds: new Set(['u1']), prompt: 'deliver the report please' }),
    null,
    'an existing identical prompt is not the new submission'
  )
  // Strict identity: a whitespace-flattened "match" is not a match.
  assert.equal(findAcceptedUser(before, { priorUserIds: new Set(), prompt: 'deliver  the report please' }), null)
})

// HEADLINE 2: reply selection finishing before the answer is done.
test('inspectReply: a finished intermediate message without end_turn is NOT the answer', () => {
  const streaming = fixture(
    msg('u1', 'user', 'question'),
    msg('a1', 'assistant', 'Let me check.', { status: 'finished_successfully', endTurn: false }),
    msg('a2', 'assistant', 'Working on it…', { status: 'in_progress', endTurn: false })
  )
  let r = inspectReply(conversationSnapshot(streaming), 'u1')
  assert.equal(r.state, 'waiting', 'the old code returned a1 as final here')
  assert.equal(r.messageId, 'a2', 'the candidate is the latest user-facing message')

  const done = fixture(
    msg('u1', 'user', 'question'),
    msg('a1', 'assistant', 'Let me check.', { status: 'finished_successfully', endTurn: false }),
    msg('a2', 'assistant', 'The answer is 42.', { status: 'finished_successfully', endTurn: true })
  )
  r = inspectReply(conversationSnapshot(done), 'u1')
  assert.equal(r.state, 'done')
  assert.equal(r.messageId, 'a2')
  assert.equal(r.text, 'The answer is 42.')
  assert.equal(r.nonText, false)
  assert.deepEqual(r.content.parts, ['The answer is 42.'], 'final content is carried for storage')
})

test('inspectReply: tool/analysis channels are never the answer', () => {
  const snap = conversationSnapshot(
    fixture(
      msg('u1', 'user', 'search for x'),
      msg('t1', 'assistant', 'search("x")', { recipient: 'browser', contentType: 'text' }),
      msg('t2', 'assistant', 'results…', { recipient: 'browser', contentType: 'execution_output' }),
      msg('a1', 'assistant', 'Found: x is y.', { status: 'finished_successfully', endTurn: true })
    )
  )
  const r = inspectReply(snap, 'u1')
  assert.equal(r.state, 'done')
  assert.equal(r.messageId, 'a1')
  assert.equal(r.text, 'Found: x is y.')
})

test('inspectReply: the next user message ends the window; regenerate branches pick the newest', () => {
  const snap = conversationSnapshot(
    fixture(
      msg('u1', 'user', 'q', { create: 1 }),
      msg('a1', 'assistant', 'abandoned answer', { status: 'finished_successfully', endTurn: true, create: 2 }),
      msg('a2', 'assistant', 'regenerated answer', { status: 'finished_successfully', endTurn: true, create: 3 }),
      msg('u2', 'user', 'next turn', { create: 4 }),
      msg('a3', 'assistant', 'other turn', { status: 'finished_successfully', endTurn: true, create: 5 })
    )
  )
  const r = inspectReply(snap, 'u1')
  assert.equal(r.messageId, 'a2', 'latest user-facing assistant in the window, not the abandoned branch')
  assert.equal(inspectReply(snap, 'u2').messageId, 'a3')
  assert.equal(inspectReply(snap, 'missing').state, 'waiting')
})

test('inspectReply: legacy terminal no-channel answers still complete', () => {
  const snap = conversationSnapshot(
    fixture(msg('u1', 'user', 'q'), msg('a1', 'assistant', 'old shape', { endTurn: null, recipient: null }))
  )
  const entry = snap.branch[1]
  assert.equal(entry.endTurn, null)
  assert.equal(entry.recipient, null)
  const r = inspectReply(snap, 'u1')
  assert.equal(r.state, 'done')
})

test('inspectReply: done with empty text reports non-text', () => {
  const snap = conversationSnapshot(
    fixture(msg('u1', 'user', 'q'), msg('a1', 'assistant', '', { contentType: 'multimodal' }))
  )
  const r = inspectReply(snap, 'u1')
  assert.equal(r.state, 'done')
  assert.equal(r.nonText, true)
})

// ----- P06: picker math -----------------------------------------------------

test('parseSliderDescription strictness', () => {
  assert.deepEqual(parseSliderDescription('Pro, 5 of 5. arrows'), { name: 'Pro', n: 5, total: 5 })
  assert.equal(parseSliderDescription('Use Left and Right arrow keys to adjust power'), null)
  assert.equal(parseSliderDescription('Weird, 2 of 5000.'), null, 'unreasonable total')
  assert.equal(parseSliderDescription('Overflow, 3 of 99999999999999999999.'), null, 'non-safe integers refuse')
})

test('withRestoredPicker reports restoration failure and appends to body errors', async () => {
  const good = await withRestoredPicker({
    snapshot: async () => 'orig',
    restore: async () => true,
    body: async () => 'ran',
  })
  assert.equal(good, 'ran')

  // Body fails AND restoration fails: the body error carries the note.
  await assert.rejects(
    withRestoredPicker({
      snapshot: async () => 'orig',
      restore: async () => false,
      body: async () => {
        throw new Error('body blew up')
      },
    }),
    (e) => /body blew up.*restoration failed/s.test(e.message)
  )

  // Body succeeds but restoration failed: the changed default is reported.
  await assert.rejects(
    withRestoredPicker({
      snapshot: async () => 'orig',
      restore: async () => {
        throw new Error('could not move back')
      },
      body: async () => 'fine',
    }),
    (e) => /restoration failed.*could not move back/s.test(e.message)
  )
})

// ----- P08: dot checkpoints ---------------------------------------------------

const M = (id, at, mine, text) => ({ id, at, mine, text, iso: new Date(at).toISOString() })

test('assertDotWindow refuses a full page with no checkpoint overlap', () => {
  const full = Array.from({ length: 32 }, (_, i) => M('m' + i, 1000 + i, i % 2 === 0, 'x'))
  assert.throws(() => assertDotWindow(full, { t: 500, ids: ['other'] }, 32), /no checkpoint overlap/)
  assert.doesNotThrow(() => assertDotWindow(full, { t: 500, ids: ['m0'] }, 32), 'overlap passes')
  assert.doesNotThrow(() => assertDotWindow(full.slice(0, 10), { t: 500, ids: ['other'] }, 32), 'short page passes')
  assert.doesNotThrow(() => assertDotWindow(full, null, 32), 'first poll initializes')
})

test('dotPollBatch: first poll initializes; later polls deliver new-by-id', () => {
  const msgs = [M('a', 100, false, 'hi'), M('b', 200, true, 'hello')]
  const first = dotPollBatch(msgs, null, { limit: 32 })
  assert.equal(first.initialized, true)
  assert.deepEqual(first.messages, [])
  assert.deepEqual(first.watermark, { v: 2, t: 200, ids: ['a', 'b'] })

  const next = dotPollBatch([M('a', 100, false, 'hi'), M('b', 200, true, 'hello'), M('c', 300, false, 'reply')], first.watermark, { limit: 32 })
  assert.equal(next.initialized, false)
  assert.deepEqual(next.messages.map((m) => m.id), ['c'])
  assert.deepEqual(next.watermark, { v: 2, t: 300, ids: ['a', 'b', 'c'] })
})

test('dotPollBatch: timestamp precision drift cannot hide an already-delivered id', () => {
  const wm = { v: 2, t: 200, ids: ['b'] }
  // The server re-reports b with a slightly different created_at.
  const batch = dotPollBatch([M('b', 1997, true, 'hello')], wm, { limit: 32 })
  assert.deepEqual(batch.messages, [], 'id membership wins over time equality')
})

test('afterDotSend does not advance the read checkpoint past unread messages', () => {
  const current = { roomId: 'r', watermark: { v: 2, t: 1000, ids: ['old1'] }, lastSentAt: null, lastSentText: null }
  const out = afterDotSend(current, { id: 'sent1', at: 5000 }, 'ping', 12345)
  assert.equal(out.watermark.t, 1000, 'the floor did not move — older unread survive')
  assert.deepEqual(out.watermark.ids, ['old1', 'sent1'], 'the sent id joins the delivered set')
  assert.equal(out.lastSentAt, 12345)
  assert.equal(out.lastSentText, 'ping')
  // A fast dot reply after the send is still fresh on the next poll.
  const batch = dotPollBatch([M('old1', 900, false, 'old'), M('sent1', 5000, true, 'ping'), M('reply', 5100, false, 'pong')], out.watermark, { limit: 32 })
  assert.deepEqual(batch.messages.map((m) => m.id), ['reply'])
  // Unread messages OLDER than the send also survive (the old v1 send
  // clobbered them).
  const batch2 = dotPollBatch([M('unread', 1100, false, 'missed me'), M('sent1', 5000, true, 'ping')], out.watermark, { limit: 32 })
  assert.deepEqual(batch2.messages.map((m) => m.id), ['unread'])
  // No prior checkpoint (bind, then send before ever polling): the send
  // seeds one WITHOUT a time floor. A bootstrap t at the send time used to
  // filter out every unread message older than the send forever — the exact
  // silent-history-loss class v2 exists to close (A6).
  const fresh = afterDotSend({ roomId: 'r', watermark: null }, { id: 's', at: 42 }, 'x')
  assert.deepEqual(fresh.watermark, { v: 2, t: 0, ids: ['s'] })
  const bootstrap = dotPollBatch(
    [M('older', 40, false, 'unread before the first send'), M('s', 42, true, 'x')],
    fresh.watermark,
    { limit: 32 }
  )
  assert.deepEqual(bootstrap.messages.map((m) => m.id), ['older'], 'pre-send history survives the bootstrap send')
})

// ----- P09: deletion planning --------------------------------------------------

const ITEMS = [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }]

test('planDeletion refuses partial inventories, unknown ids, active turns, and unconfirmed --all', () => {
  assert.match(planDeletion({ items: [], listingError: 'http 500', deleteIds: ['c1'] }).error, /partial inventory/)
  assert.match(planDeletion({ items: ITEMS, listingError: 'http 429', deleteIds: ['c1'] }).error, /partial inventory/)
  assert.match(planDeletion({ items: ITEMS, deleteIds: ['nope'] }).error, /not in the visible chat list/)
  assert.match(planDeletion({ items: ITEMS, deleteIds: ['c1'], activeIds: ['c1'] }).error, /running turns/)
  assert.match(planDeletion({ items: ITEMS, deleteAll: true, confirmed: false }).error, /requires --yes/)
  assert.match(planDeletion({ items: ITEMS, hitCap: true, deleteAll: true, confirmed: true }).error, /cap/)
  assert.deepEqual(planDeletion({ items: ITEMS, deleteIds: ['c1', 'c2'] }).targets, ['c1', 'c2'])
  assert.deepEqual(planDeletion({ items: ITEMS, deleteAll: true, confirmed: true }).targets, ['c1', 'c2', 'c3'])
})

// ----- P10: CLI parsing ----------------------------------------------------------

test('parseCli: dot -- --poll is a MESSAGE, not a flag', () => {
  const { command, args, options } = parseCli(['dot', '--', '--poll'])
  assert.equal(command, 'dot')
  assert.deepEqual(args, ['--poll'])
  assert.equal(options.poll, undefined)
})

// A2: the documented `dot --context --json` form used to silently run
// status (both flags dropped), and `dot --context --poll` silently ran
// poll alone — advancing the watermark uninvited.
test('parseCli: bare --context defaults before any flag, not only at end of argv (A2)', () => {
  const p = parseCli(['dot', '--context', '--json'])
  assert.equal(p.command, 'dot')
  assert.deepEqual(p.options, { file: [], context: 20, json: true })
  assert.throws(() => parseCli(['dot', '--context', '--poll']), /choose one/)
  // Guard: the already-working orders keep working.
  assert.equal(parseCli(['dot', '--json', '--context']).options.context, 20)
  assert.equal(parseCli(['dot', '--context']).options.context, 20)
  assert.equal(parseCli(['dot', '--context', '8', '--json']).options.context, 8)
})

// A9: required option values must not swallow flag-looking tokens.
test('parseCli: required value options refuse flag-like values (A9)', () => {
  assert.throws(() => parseCli(['start', 'p', '--file', '--stream']), /--file needs a value/)
  assert.throws(() => parseCli(['wait', 'id', '--turn', '--json']), /--turn needs a value/)
  assert.throws(() => parseCli(['start', 'p', '-f']), /needs a value/)
  assert.deepEqual(parseCli(['start', 'p', '--file', 'a.png']).options.file, ['a.png'])
  assert.match(
    parseCli(['wait', 'job-1', '--turn', '11111111-1111-1111-1111-111111111111']).options.turn,
    /^11111111/
  )
})

// A9: `chats some-id` used to list everything and silently ignore the id.
test('parseCli: chats rejects stray operands outside --delete (A9)', () => {
  assert.throws(() => parseCli(['chats', 'some-id']), /chats takes no arguments/)
  assert.doesNotThrow(() => parseCli(['chats']))
  assert.doesNotThrow(() => parseCli(['chats', '--delete', 'some-id']))
  assert.doesNotThrow(() => parseCli(['chats', '--delete', '--all', '--yes']))
})

// ----- A1: poll retry classification ----------------------------------------------

test('retriablePollError forgives transient classes; auth failures stay fatal (A1)', () => {
  for (const s of [0, 404, 408, 429, 500, 502, 503, 504]) {
    assert.equal(retriablePollError(s), true, 'status ' + s + ' is retriable')
  }
  for (const s of [200, 400, 401, 403, 405, 418, undefined, null, 'x']) {
    assert.equal(retriablePollError(s), false, 'status ' + String(s) + ' is fatal')
  }
})

test('pollBackoffMs grows exponentially across consecutive failures and caps (A1)', () => {
  assert.equal(pollBackoffMs(0, 800), 800)
  assert.equal(pollBackoffMs(1, 800), 800)
  assert.equal(pollBackoffMs(2, 800), 1600)
  assert.equal(pollBackoffMs(3, 800), 3200)
  assert.equal(pollBackoffMs(4, 800), 6400)
  assert.equal(pollBackoffMs(10, 800), 15000, 'capped at 15s')
  assert.equal(pollBackoffMs(99, 20000), 15000, 'never above the cap')
})

// A7: the wait loops dropped the documented jittered cadence for a fixed
// metronomic interval — restore-and-pin the envelope.
test('pollDelayMs jitters inside the documented camouflage envelope (A7)', () => {
  let lo = Infinity
  let hi = -Infinity
  let varies = false
  let prev = null
  for (let i = 0; i < 200; i++) {
    const d = pollDelayMs('reply')
    assert.ok(d >= 600 && d <= 1300, 'reply cadence within ~0.6-1.3s')
    lo = Math.min(lo, d)
    hi = Math.max(hi, d)
    if (prev !== null && d !== prev) varies = true
    prev = d
  }
  assert.ok(varies, 'the cadence varies — not a metronome')
  assert.ok(hi - lo > 100, `observed spread is real (${lo.toFixed(0)}..${hi.toFixed(0)}ms)`)
  for (let i = 0; i < 50; i++) {
    const d = pollDelayMs('accept')
    assert.ok(d >= 1200 && d <= 2500, 'accept cadence bounds')
  }
})

// ----- A8: listing pagination ------------------------------------------------------

const pageOf = (n, off) => Array.from({ length: n }, (_, i) => ({ id: 'c' + (off + i) }))

test('collectConversationListing: exactly-cap inventory is complete, not capped (A8)', async () => {
  const fourFullThenEmpty = async (offset) => (offset < 200 ? { items: pageOf(50, offset) } : { items: [] })
  const r = await collectConversationListing(fourFullThenEmpty)
  assert.equal(r.items.length, 200)
  assert.equal(r.hitCap, false, '4×50 then an empty boundary page proves completeness')
  assert.equal(r.lastError, null)

  const fiveFull = async (offset) => ({ items: pageOf(50, offset) })
  const capped = await collectConversationListing(fiveFull)
  assert.equal(capped.hitCap, true, 'a full boundary page means more beyond the cap')
  assert.equal(capped.items.length, 200)

  const short = async (offset) => (offset === 0 ? { items: pageOf(30, 0) } : { items: [] })
  const s = await collectConversationListing(short)
  assert.equal(s.hitCap, false, 'a short page proves completeness without a probe')

  const errMidListing = async (offset) => (offset === 0 ? { items: pageOf(50, 0) } : { error: 'http 500' })
  const e = await collectConversationListing(errMidListing)
  assert.equal(e.lastError, 'http 500')
  assert.equal(e.items.length, 50, 'partial rows stay honest')

  const probeFails = async (offset) => (offset < 200 ? { items: pageOf(50, offset) } : { error: 'http 429' })
  const p = await collectConversationListing(probeFails)
  assert.equal(p.hitCap, true, 'an unprovable boundary is treated as capped (fail closed)')
  assert.equal(p.lastError, 'http 429')
})

// ----- A5: foreground dot-send interruption classification --------------------------

test('dotSendInterruption classifies by dispatch progress, never as a runner crash (A5/B6)', () => {
  assert.match(dotSendInterruption('dispatched'), /may have been sent; inspect the dot thread before retrying/)
  assert.match(dotSendInterruption('dispatching'), /may have been sent/, 'the click window counts as uncertain')
  const early = dotSendInterruption(undefined)
  assert.match(early, /nothing was sent; retry is safe/)
  assert.doesNotMatch(early, /runner died/)
  assert.doesNotMatch(dotSendInterruption('dispatched'), /runner died/)
})

// B6: 'accepted'/'sent' mean the send was VERIFIED (a new API message id
// with the exact authored text). An interrupt after that point must not
// re-open the inspect-before-retry question the code already answered.
test('dotSendInterruption reports verified sends as verified, not uncertain (B6)', () => {
  for (const state of ['accepted', 'sent']) {
    const msg = dotSendInterruption(state)
    assert.match(msg, /verified/, state + ' is a verified send')
    assert.doesNotMatch(msg, /may have been sent/, state + ' must not claim uncertainty')
    assert.doesNotMatch(msg, /runner died/)
  }
})

// ----- B1: wall-clock bound sizing dominates in-page sequential budgets ------

test('deleteEvalBoundMs dominates the in-page worst case for every target count (B1)', () => {
  // In-page worst: one 20s session fetch + n × (20s PATCH abort budget +
// 400ms pacing gap). The bound must clear it with margin (audit spec:
// ≥ 20000 + n·20400 + 5000).
  for (let n = 1; n <= 10; n++) {
    const worst = 20000 + n * 20400
    assert.ok(
      deleteEvalBoundMs(n) >= worst + 5000,
      `n=${n}: bound ${deleteEvalBoundMs(n)} must dominate worst ${worst} + 5000 margin`
    )
  }
  // The undersized HEAD bounds failed exactly these cases.
  for (const n of [2, 3, 4]) {
    const headBound = Math.max(60000, n * 25000)
    assert.ok(deleteEvalBoundMs(n) > headBound, `n=${n}: the fixed bound must exceed the old ${headBound}`)
    assert.ok(headBound < 20000 + n * 20400, `n=${n}: the old bound was genuinely undersized (test sanity)`)
  }
  assert.equal(deleteEvalBoundMs(0), 30000, 'no targets: session + margin')
})

test('sequentialFetchBoundMs sizes the two-fetch evaluations (B1)', () => {
  // Chats listing: session + conversations, both 20s-aborted → ≥ 40s work.
  assert.equal(sequentialFetchBoundMs(2, 20000), 50000)
  assert.ok(sequentialFetchBoundMs(2, 20000) >= 40000, 'listing bound dominates the 40s in-page worst')
  // Dot reads: session + target at 15s → ≥ 30s work (old bound was 20s).
  assert.equal(sequentialFetchBoundMs(2, 15000, 5000), 35000)
  assert.ok(sequentialFetchBoundMs(2, 15000, 5000) >= 30000, 'dot bound dominates the 30s in-page worst')
  assert.throws(() => sequentialFetchBoundMs(0), /invalid fetch count/)
})

test('collectConversationListing routes a REJECTING fetchPage into the honesty channel (B1)', async () => {
  // evaluateBounded's wall-clock rejection used to bypass chatListingOutcome
  // and surface as a raw CLI crash; the contract is {error} conversion.
  const boom = async () => {
    throw new Error('chats listing page timed out after 50000ms')
  }
  const result = await collectConversationListing(boom)
  assert.deepEqual(result.items, [])
  assert.match(result.lastError, /timed out after 50000ms/)
  assert.equal(result.hitCap, false)

  // Same contract for the boundary probe rejection: capped AND errored.
  let calls = 0
  const probeBoom = async () => {
    calls++
    return calls <= 4 ? { items: Array.from({ length: 50 }, (_, i) => ({ id: 'i' + calls + '-' + i })) } : Promise.reject(new Error('probe timed out'))
  }
  const capped = await collectConversationListing(probeBoom)
  assert.equal(capped.hitCap, true)
  assert.match(capped.lastError, /probe timed out/)
})

// ----- B3: acceptance-window backoff keeps the window fed ----------------------

test('acceptanceBackoffMs caps to the window and never grows 404 (B3)', () => {
  // Any storm, worst-case jittered base: ≥10 consecutive-failure attempts
  // fit in the window (sum of the first 10 backoffs ≤ 60s).
  let total = 0
  for (let n = 1; n <= 10; n++) total += acceptanceBackoffMs(n, 2500, 60000, 429)
  assert.ok(total <= 60000, `10 attempts must fit a 60s window (sum ${total}ms)`)
  assert.equal(acceptanceBackoffMs(99, 20000, 60000), 6000, 'cap is window/10')
  // 404 is the documented indexing delay — time-based, not load-based.
  assert.equal(acceptanceBackoffMs(7, 1800, 60000, 404), 1800, '404 stays at the base cadence')
  assert.ok(acceptanceBackoffMs(7, 1800, 60000, 404) < acceptanceBackoffMs(7, 1800, 60000, 429))
  // Small windows floor the cap at 1s (never hammer, however tiny the
  // window); big windows never exceed 15s.
  assert.equal(acceptanceBackoffMs(5, 5000, 3000, 429), 1000)
  assert.equal(acceptanceBackoffMs(5, 5000, 300000, 429), 15000)
})


test('parseCli: shapes, counts, values and combinations', () => {
  assert.deepEqual(parseCli(['start', 'hi', '--file', 'a.png', '-f', 'b.png']).options.file, ['a.png', 'b.png'])
  assert.throws(() => parseCli(['start']), /takes 1/)
  assert.throws(() => parseCli(['send', 'only-one']), /takes 2/)
  assert.throws(() => parseCli(['start', 'p', '--poll']), /not valid for/)
  assert.throws(() => parseCli(['wait', 'id', '10', '--json', '--stream']), /cannot be combined/)
  assert.throws(() => parseCli(['wait', 'id', 'abc']), /wait seconds/)
  assert.throws(() => parseCli(['chats', '--all']), /belongs to --delete/)
  assert.throws(() => parseCli(['chats', '--delete']), /needs chat ids/)
  assert.throws(() => parseCli(['frobnicate']), /unknown command/)
  assert.throws(() => parseCli(['start', 'p', '--nope']), /unknown option/)
  assert.throws(() => parseCli(['dot', '--context', '50']), /context count/)
  assert.equal(parseCli(['dot', '--context']).options.context, 20)
  assert.equal(parseCli(['dot', '--context', '8']).options.context, 8)
  assert.throws(() => parseCli(['dot', '--poll', '--reset']), /choose one/)
  assert.throws(() => parseCli(['dot', 'a', 'b']), /takes 0\.\.1/)
  const wait = parseCli(['wait', 'job-1', '30', '--turn', '11111111-1111-1111-1111-111111111111'])
  assert.deepEqual([wait.command, wait.args, wait.options.turn], ['wait', ['job-1', '30'], '11111111-1111-1111-1111-111111111111'])
  const none = parseCli([])
  assert.equal(none.command, 'help')
  assert.equal(parseCli(['--help']).command, 'help')
  assert.equal(parseCli(['dot', '--', '--help']).command, 'dot', '--help after -- stays an operand')
})

// ----- P03: wait generation pinning ------------------------------------------------

test('assertWaitGeneration refuses a superseded record', () => {
  const job = { turnId: 't-1' }
  assert.equal(assertWaitGeneration(job, 't-1'), job)
  assert.throws(() => assertWaitGeneration({ turnId: 't-2' }, 't-1'), /superseded/)
  const legacy = { status: 'done' }
  assert.equal(assertWaitGeneration(legacy, undefined), legacy, 'legacy records pin on absence')
})

// ----- P12: env bounds --------------------------------------------------------------

test('integerEnv: defaults only for absent values; invalid throws; bounds enforced', () => {
  assert.equal(integerEnv({}, 'X', 7), 7)
  assert.equal(integerEnv({ X: '' }, 'X', 7), 7)
  assert.equal(integerEnv({ X: '42' }, 'X', 7), 42)
  assert.throws(() => integerEnv({ X: 'abc' }, 'X', 7), /integer/)
  assert.throws(() => integerEnv({ X: '-1' }, 'X', 7), /integer/)
  assert.throws(() => integerEnv({ X: '1.5' }, 'X', 7), /integer/)
  assert.throws(() => integerEnv({ X: '999' }, 'X', 7, { max: 16 }), /integer/)
})

// ----- P11: local IO -----------------------------------------------------------------

test('boundedArtifactName sanitizes, bounds length, keeps extensions', () => {
  assert.equal(boundedArtifactName('report .md'), 'report_.md')
  assert.equal(boundedArtifactName('.hidden'), '_hidden')
  assert.equal(boundedArtifactName(''), 'file')
  assert.equal(boundedArtifactName('???'), '___')
  const long = 'x'.repeat(300) + '.tar.gz'
  const bounded = boundedArtifactName(long)
  assert.ok(bounded.length <= 128)
  assert.ok(bounded.endsWith('.gz'), 'the final extension survives truncation')
})

test('writeJSONAtomic: atomic write, private mode, no temp leftovers; failure cleans up', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-atomic-'))
  const file = path.join(dir, 'state.json')
  writeJSONAtomic(file, { a: 1 })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 })
  assert.equal((fs.statSync(file).mode & 0o777), 0o600)
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.endsWith('.tmp')), [])
  // Failure path: target occupied by a non-empty directory -> rename fails,
  // temp is cleaned.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-atomic-'))
  const blocker = path.join(dir2, 'state.json')
  fs.mkdirSync(blocker)
  fs.writeFileSync(path.join(blocker, 'keep'), 'x')
  assert.throws(() => writeJSONAtomic(blocker, { a: 1 }))
  assert.deepEqual(fs.readdirSync(dir2).filter((f) => f.endsWith('.tmp')), [])
})

test('readJSONStrict: ENOENT yields missing; corrupt throws; validation throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-strict-'))
  const missing = path.join(dir, 'nope.json')
  assert.equal(readJSONStrict(missing, { missing: null }), null)
  const corrupt = path.join(dir, 'corrupt.json')
  fs.writeFileSync(corrupt, '{not json')
  assert.throws(() => readJSONStrict(corrupt, { missing: null }), /corrupt.*refusing to treat it as absent/)
  const bad = path.join(dir, 'bad.json')
  fs.writeFileSync(bad, JSON.stringify({ nope: true }))
  assert.throws(() => readJSONStrict(bad, { validate: (s) => (s.nope ? 'shape' : null) }), /failed validation: shape/)
})

test('validateUploads checks existence, regular files, and the size cap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-up-'))
  const f = path.join(dir, 'a.txt')
  fs.writeFileSync(f, 'x')
  assert.deepEqual(validateUploads([f]), [f])
  assert.throws(() => validateUploads([path.join(dir, 'missing')]), /no such file/)
  assert.throws(() => validateUploads([dir]), /not a regular file/)
  const bigStub = { size: ARTIFACT_MAX_BYTES + 1, isFile: () => true }
  const origStat = fs.statSync
  fs.statSync = () => bigStub
  try {
    assert.throws(() => validateUploads([f]), /transfer cap/)
  } finally {
    fs.statSync = origStat
  }
})

// ----- P05: attachment verdict contract ---------------------------------------------

test('attachmentVerdict refuses unknown card states instead of guessing ready', () => {
  assert.match(
    attachmentVerdict({ known: true, files: [{ name: 'error.log', state: 'unknown' }] }, ['error.log']).error,
    /state unrecognized/,
    'a status-like filename is a name, not a verdict'
  )
  // Duplicate basenames survive the adapter: the multiset decides.
  assert.deepEqual(
    attachmentVerdict(
      { known: true, files: [{ name: 'a.txt', state: 'ready' }, { name: 'a.txt', state: 'ready' }] },
      ['a.txt', 'a.txt']
    ),
    { ok: true }
  )
})

// ----- B1/B6: audit-io behaviors ---------------------------------------------------

// B1: a fired bound on a CANCELLABLE (mutation) evaluation must not detach
// the in-page loop — it signals cancel, then lets the evaluation settle so
// the caller observes the loop's real termination and per-item outcome.
test('evaluateBounded cancels and settles a slow mutation evaluation instead of detaching it (B1)', async () => {
  let cancelled = false
  const page = { evaluate: async (fn, arg) => fn(arg) }
  const res = await evaluateBounded(
    page,
    async () => {
      // "Loop" that finishes after the bound fires, reporting the flag.
      await new Promise((r) => setTimeout(r, 120))
      return { results: [{ id: 'a', ok: true }], cancelled }
    },
    null,
    30,
    'test mutation loop',
    {
      cancel: async () => {
        cancelled = true
      },
      settleMs: 1000,
    }
  )
  assert.equal(res.cancelled, true, 'the evaluation observed the cancel flag')
  assert.equal(res.results.length, 1, 'the settled value — not a rejection — reached the caller')
})

// B1: without a cancel hook the old semantics hold — the bound rejects
// (read-only sites) and the losing evaluation's eventual rejection is
// absorbed (no unhandled rejection escapes later).
test('evaluateBounded still rejects at the bound for uncancellable evaluations (B1)', async () => {
  const page = { evaluate: async (fn, arg) => fn(arg) }
  await assert.rejects(
    evaluateBounded(
      page,
      async () => {
        await new Promise((r) => setTimeout(r, 10000))
        return { late: true }
      },
      null,
      30,
      'test read'
    ),
    /test read timed out after 30ms/
  )
})

// B6: the fence runs cleanup (close the page) BEFORE filing and BEFORE the
// exit — the exit used to fire inside withPage, leaking a stray daemon tab
// per interrupted dot send.
test('interruption fence orders cleanup, file, exit — and a terminal record is never overwritten (B6)', async () => {
  const order = []
  let releaseExit
  const exited = new Promise((r) => {
    releaseExit = r
  })
  const fence = installInterruptionFence({
    cleanup: async () => {
      await Promise.resolve()
      order.push('cleanup')
    },
    file: async () => {
      order.push('file')
    },
    exit: (code) => {
      order.push('exit:' + code)
      releaseExit(code)
    },
  })
  await fence.interrupt('SIGINT')
  const code = await exited
  assert.equal(code, 130)
  assert.deepEqual(order, ['cleanup', 'file', 'exit:130'], 'cleanup strictly precedes filing and exit')
  fence.close()
  process.exitCode = 0 // the fence sets it on the real process; tests restore it
})
