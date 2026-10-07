// Pure audit-core: prompt identity, conversation snapshots, acceptance and
// reply inspection, model-picker math, dot checkpoints, deletion planning
// and CLI parsing. No node:fs, no process state, no page objects — every
// function here is unit-testable against fixtures and captured API shapes.
//
// Policy (2026-10-06 audit): identity checks compare authored text exactly
// (line endings only). Whitespace collapsing and self-link stripping used to
// make "different prompt" comparisons pass; a backend transformation must be
// a fixture-tested adapter, never an unconditional normalization. Strict
// comparison may refuse a transformed prompt — that is preferable to
// accepting a different prompt.

export class AuditError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AuditError'
    this.code = code
  }
}

export function positiveInteger(raw, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(raw).trim()
  const value = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  }
  return value
}

// Defaults apply only when the variable is absent. An explicitly invalid
// value throws, so caps and timers can never silently fall back.
export function integerEnv(env, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = env ? env[name] : undefined
  if (raw === undefined || raw === '') return fallback
  return positiveInteger(raw, name, { min, max })
}

// ----- prompt identity ----------------------------------------------------

export function canonicalPrompt(s) {
  return String(s ?? '').replace(/\r\n/g, '\n')
}

export function samePrompt(a, b) {
  return canonicalPrompt(a) === canonicalPrompt(b)
}

// The backend autolinks bare URLs in STORED user messages: authored
// "audit https://x end" is stored as "audit [https://x](https://x) end"
// (fixture 2026-10-07, smoke conversation 6ac447ea…, message d4bbe119…:
// every other byte identical — the paragraph break the composer RENDERS
// at the autolink boundary is not stored). storedPromptText reverts
// EXACTLY self-labeled links, where the label equals the target, so an
// authored link with a distinct label ("see [the repo](https://x)") stays
// a different prompt, and a link shape the regex cannot prove self-labeled
// (parens in the target) is left untouched — a refusal, never a false
// accept. Applied only to STORED text in acceptance comparisons; the
// authored side is never rewritten. samePrompt itself stays strict. A new
// storage transformation extends the fixture HERE, not a regex at a call
// site.
const SELF_LINK = /\[([^\]]+)\]\(([^()\s]+)\)/g
export function storedPromptText(s) {
  return String(s ?? '').replace(SELF_LINK, (whole, label, target) => (label === target ? label : whole))
}

// ----- conversation identity ----------------------------------------------

const CONV_ID_RE = /^[0-9a-fA-F-]{8,}$/

export function conversationId(input) {
  const s = String(input ?? '')
  const inUrl = s.match(/\/c\/([0-9a-fA-F-]{8,})/)
  if (inUrl) return inUrl[1]
  if (CONV_ID_RE.test(s)) return s
  throw new AuditError('CONVERSATION_ID', 'not a conversation id or URL: ' + s.slice(0, 80))
}

export function conversationUrl(url) {
  let u
  try {
    u = new URL(String(url))
  } catch {
    throw new AuditError('CONVERSATION_URL', 'not a bound conversation url: ' + String(url).slice(0, 120))
  }
  if (u.origin !== 'https://chatgpt.com') {
    throw new AuditError('CONVERSATION_URL', 'not a chatgpt.com conversation url: ' + u.origin)
  }
  const m = u.pathname.match(/^\/c\/([0-9a-fA-F-]{8,})/)
  if (!m) {
    throw new AuditError('CONVERSATION_URL', 'url has no conversation path: ' + String(url).slice(0, 120))
  }
  return 'https://chatgpt.com/c/' + m[1]
}

// ----- conversation snapshot / acceptance / reply --------------------------

function userFacingAssistant(entry) {
  if (entry.role !== 'assistant') return false
  // Channel info decides what is a user-facing answer: tool/analysis messages
  // carry a recipient other than "all" and/or tool content types. The
  // old flat parser discarded this and could answer with tool chatter.
  if (entry.recipient !== null && entry.recipient !== 'all') return false
  // 'text' is the authored answer; 'multimodal' is a user-facing answer
  // whose text part may be empty (reported as non-text). Tool payload
  // types are never candidates; unknown future types stay excluded until
  // a fixture says otherwise.
  return entry.contentType === null || entry.contentType === 'text' || entry.contentType === 'multimodal'
}

// conversationSnapshot linearizes the conversation mapping. Order is
// create_time with mapping insertion order as the tiebreak (the mapping is a
// tree; abandoned regenerate branches carry earlier create_times than the
// active tip, so a latest-match scan stays on the active branch).
export function conversationSnapshot(data) {
  const mapping = data && typeof data === 'object' && data.mapping ? data.mapping : {}
  const entries = []
  let order = 0
  for (const key of Object.keys(mapping)) {
    const node = mapping[key]
    const m = node && node.message
    if (!m || !m.content) continue
    const role = m.author && m.author.role
    if (role !== 'user' && role !== 'assistant') continue
    // Text serialization: string parts are concatenated without inventing
    // separators (a '\n' join rewrites two-part authored text). Non-string
    // parts (images, tool results) are not text.
    const parts = Array.isArray(m.content.parts) ? m.content.parts : []
    const text = parts.filter((p) => typeof p === 'string').join('')
    entries.push({
      id: String(m.id || key),
      role,
      create: Number(m.create_time) || 0,
      order: order++,
      text,
      status: typeof m.status === 'string' ? m.status : null,
      endTurn: m.end_turn === true ? true : m.end_turn === false ? false : null,
      recipient: typeof m.recipient === 'string' ? m.recipient : null,
      contentType: typeof m.content.content_type === 'string' ? m.content.content_type : null,
      content: m.content,
    })
  }
  entries.sort((a, b) => a.create - b.create || a.order - b.order)
  const allUserIds = new Set(entries.filter((e) => e.role === 'user').map((e) => e.id))
  return { branch: entries, allUserIds }
}

// findAcceptedUser is the acceptance decision: a user message that is NEW
// (id absent from the prior baseline) and whose authored text is exactly the
// prompt. The DOM-id baseline was always empty on the 2026-10 UI, so a
// newest-text-only match could re-accept an older identical prompt — the id
// baseline is what proves newness. Where a second human/device could submit
// identical text concurrently, this remains "one newly observed matching
// message", not a proof against an adversarial simultaneous submission.
export function findAcceptedUser(snapshot, { priorUserIds, prompt } = {}) {
  const branch = snapshot && Array.isArray(snapshot.branch) ? snapshot.branch : []
  const seen = priorUserIds instanceof Set ? priorUserIds : new Set(priorUserIds || [])
  let hit = null
  for (const m of branch) {
    if (m.role !== 'user' || seen.has(m.id)) continue
    // Stored text carries the backend's autolink transformation; the
    // adapter reverts exactly self-labeled links before the strict
    // compare (see storedPromptText).
    if (samePrompt(storedPromptText(m.text), prompt)) hit = m // newest matching new message wins
  }
  return hit
}

// inspectReply reports the turn's answer: the LAST user-facing assistant
// message in the window after the accepted user message (up to the next user
// message). Completion requires finished_successfully AND end_turn — an
// intermediate "finished" assistant message without end_turn must not end
// the wait — with one legacy allowance for explicitly terminal no-channel
// answers that predate both fields.
export function inspectReply(snapshot, acceptedUserId) {
  const branch = snapshot && Array.isArray(snapshot.branch) ? snapshot.branch : []
  const accIdx = branch.findIndex((m) => m.id === acceptedUserId)
  if (accIdx < 0) {
    return { state: 'waiting', messageId: null, text: '', nonText: false, content: null }
  }
  let candidate = null
  for (let i = accIdx + 1; i < branch.length; i++) {
    const m = branch[i]
    if (m.role === 'user') break // the next turn's prompt ends this window
    if (userFacingAssistant(m)) candidate = m
  }
  if (!candidate) {
    return { state: 'waiting', messageId: null, text: '', nonText: false, content: null }
  }
  const terminalLegacy = candidate.endTurn === null && candidate.recipient === null
  const done =
    candidate.status === 'finished_successfully' && (candidate.endTurn === true || terminalLegacy)
  return {
    state: done ? 'done' : 'waiting',
    messageId: candidate.id,
    text: candidate.text,
    nonText: done && candidate.text.trim() === '',
    content: done ? candidate.content : null,
  }
}

// ----- model picker --------------------------------------------------------

const SLIDER_MAX_TOTAL = 64

export function parseSliderDescription(text) {
  const m = String(text ?? '').match(/^(.+?),\s*(\d+)\s+of\s+(\d+)\b/)
  if (!m) return null
  const name = m[1].replace(/\s+/g, ' ').trim()
  const n = Number(m[2])
  const total = Number(m[3])
  if (!name) return null
  if (!Number.isSafeInteger(n) || !Number.isSafeInteger(total)) return null
  if (n < 1 || total < 1 || n > total || total > SLIDER_MAX_TOTAL) return null
  return { name, n, total }
}

// Equality on the full readable state (name, position, total, effective
// label). Two agreeing position numbers do not prove the effective label
// settled.
export function sliderEqual(a, b) {
  if (a == null && b == null) return true
  if (a == null || b == null) return false
  return (
    a.n === b.n && a.total === b.total && a.name === b.name &&
    (a.effective ?? null) === (b.effective ?? null)
  )
}

// withRestoredPicker runs a mutating picker operation (slider enumeration,
// experimental selection) inside snapshot/restore fencing. Restoration runs
// in the finally path; a restoration failure is always reported — appended
// to the body's error when both fail, thrown on its own when only
// restoration failed (the account default must never be silently left
// changed).
export async function withRestoredPicker({ snapshot, restore, body }) {
  if (typeof snapshot !== 'function' || typeof restore !== 'function' || typeof body !== 'function') {
    throw new TypeError('withRestoredPicker needs snapshot, restore and body functions')
  }
  const original = await snapshot()
  let bodyError = null
  try {
    return await body(original)
  } catch (e) {
    bodyError = e
    throw e
  } finally {
    let restoreError = null
    let restored = true
    try {
      restored = await restore(original)
    } catch (e) {
      restoreError = e
    }
    if (restoreError || restored === false) {
      const note =
        'model picker restoration failed — the account default may be left changed: ' +
        (restoreError ? restoreError.message : 'state differs after restore')
      if (bodyError) bodyError.message = bodyError.message + '; ' + note
      else throw new AuditError('PICKER_RESTORE_FAILED', note)
    }
  }
}

// ----- poll retry classification + cadence (wait loops) ---------------------

// A failed poll inside an API-only wait is read-only: retrying it is
// unconditionally safe, so the forgiven class is broad. 404 (conversation
// not yet readable after the send), 5xx, 408/429 (rate limiting is the
// likeliest answer to polling) and status 0 (client-side failures: a
// session-endpoint hiccup, an aborted evaluate, a destroyed execution
// context) all retry to the deadline. 401/403 and anything unknown stay
// fatal — those mean the session is gone, not that the server hiccuped.
const RETRIABLE_POLL_STATUSES = [0, 404, 408, 429, 500, 502, 503, 504]

export function retriablePollError(status) {
  // Strictly-typed: only a KNOWN status number is classified transient.
  // null/undefined/NaN (no status information) stay fatal — absence of
  // information is not evidence of a hiccup. (Number(null) === 0 would
  // otherwise make a statusless error retriable.)
  return typeof status === 'number' && RETRIABLE_POLL_STATUSES.includes(status)
}

// Jittered poll cadence — the documented camouflage envelope. A metronomic
// fixed interval (two requests per tick, same gap, sustained for minutes)
// is exactly the machine tell the pacing section exists to avoid.
// 'reply' honors the documented ~0.6–1.3s; 'accept' polls a little wider
// while the submission settles.
export function pollDelayMs(phase = 'reply', rand = Math.random) {
  const lo = phase === 'accept' ? 1200 : 600
  const hi = phase === 'accept' ? 2500 : 1300
  return lo + rand() * (hi - lo)
}

// Backoff across consecutive transient poll failures (status 0 / 429 /
// 5xx): retry to the deadline, but ease the cadence while the page or the
// rate limit is unwell instead of hammering at the base interval. A
// successful poll resets the caller's counter.
export function pollBackoffMs(consecutive, baseMs, { maxMs = 15000 } = {}) {
  const n = Number.isSafeInteger(consecutive) ? Math.max(1, consecutive) : 1
  return Math.min(maxMs, Math.round(baseMs * Math.pow(2, n - 1)))
}

// acceptanceBackoffMs scales the backoff cap to the acceptance window
// (B3): the global 15s cap starves a fixed 60s window down to ~6 attempts
// under a consecutive-failure storm, so a send landing at t≈55s was never
// observed and the turn filed ACCEPTANCE_UNKNOWN. Two adjustments:
//   - the cap is window/10 (min 1s, still ≤15s): ≥10 consecutive-failure
//     attempts fit inside any window, whatever the jittered base;
//   - 404 never grows — it is the documented indexing delay ("conversation
//     not yet readable after the send"), which is time-based, not
//     load-based; exponential growth answers the wrong failure mode.
export function acceptanceBackoffMs(consecutive, baseMs, windowMs, status = null) {
  const cap = Math.min(15000, Math.max(1000, Math.round(Number(windowMs) / 10)))
  if (status === 404) return Math.min(baseMs, cap)
  return pollBackoffMs(consecutive, baseMs, { maxMs: cap })
}

// ----- wall-clock bound sizing for evaluateBounded (B1) ----------------------

// A wall-clock bound wrapping sequential in-page fetches must dominate the
// SUM of their per-fetch abort budgets (plus pacing gaps and a margin), or
// slow-but-successful fetches turn into spurious "timed out" command
// failures — and on the delete PATCH loop, a fired bound detaches a
// still-running mutation from the store lock that was supposed to fence it.
//
// deleteEvalBoundMs: one session fetch + n × (PATCH + 400ms pacing gap) +
// margin ⇒ 20400·n + 30000 ms at the shipped budgets (worst case is
// 20000 + 20400·n; every n ≥ 1 clears it with ≥5s to spare).
export function deleteEvalBoundMs(targetCount, { sessionMs = 20000, fetchMs = 20000, gapMs = 400, marginMs = 10000 } = {}) {
  const n = Number.isSafeInteger(targetCount) ? Math.max(0, targetCount) : 0
  return sessionMs + n * (fetchMs + gapMs) + marginMs
}

// sequentialFetchBoundMs: `fetchCount` sequential in-page fetches, each
// abort-bounded at fetchMs, plus margin. The chats listing page is
// session + conversations (2 × 20s + 10s = 50s, was 30s); dot reads are
// session + rooms/messages (2 × timeoutMs + 5s, was timeoutMs + 5s).
export function sequentialFetchBoundMs(fetchCount, fetchMs = 20000, marginMs = 10000) {
  if (!Number.isSafeInteger(fetchCount) || fetchCount < 1) throw new Error('invalid fetch count')
  if (!Number.isSafeInteger(fetchMs) || fetchMs <= 0) throw new Error('invalid fetch timeout')
  return fetchCount * fetchMs + marginMs
}

// ----- dot checkpoints ------------------------------------------------------

const DOT_BACKFILL_MS = 2000
const DOT_CHECKPOINT_MAX_IDS = 512

function normalizeWatermark(w) {
  if (!w || typeof w !== 'object') return null
  const ids = Array.isArray(w.ids) ? w.ids.map(String).filter(Boolean) : []
  return { v: 2, t: Number(w.t) || 0, ids }
}

function maxAt(msgs) {
  let t = 0
  for (const m of msgs) if (Number(m.at) > t) t = Number(m.at)
  return t
}

// A full message page whose ids do not overlap the checkpoint means more
// pending messages than one page can return: older ones would be silently
// lost. Refuse instead of reporting a truncated batch as complete.
export function assertDotWindow(msgs, watermark, limit) {
  if (!watermark) return
  if (!Array.isArray(msgs) || msgs.length < limit) return
  const ids = new Set((watermark.ids || []).map(String))
  const overlap = msgs.some((m) => ids.has(String(m.id)))
  if (!overlap) {
    throw new AuditError(
      'DOT_WINDOW_TRUNCATED',
      `more than ${limit} new dot messages are pending (full page, no checkpoint overlap) — older ones would be lost; ` +
        'read them via dot --context, then rebaseline with dot --reset'
    )
  }
}

// dotPollBatch decides what a poll delivers and the next checkpoint.
// Membership is by id (created_at has varying sub-second precision between
// fetches); t stays a coarse backfill floor. v2 retains all delivered ids
// (bounded) so a send can no longer clobber unread messages out of the
// checkpoint.
export function dotPollBatch(msgs, watermark, { limit = 32 } = {}) {
  const list = Array.isArray(msgs) ? msgs : []
  const prev = normalizeWatermark(watermark)
  if (!prev) {
    return {
      initialized: true,
      messages: [],
      watermark: list.length ? { v: 2, t: maxAt(list), ids: list.map((m) => String(m.id)) } : null,
    }
  }
  const ids = new Set(prev.ids)
  const fresh = list.filter((m) => !ids.has(String(m.id)) && Number(m.at) >= prev.t - DOT_BACKFILL_MS)
  const merged = [...new Set([...prev.ids, ...list.map((m) => String(m.id))])]
  const idsTail = merged.length > DOT_CHECKPOINT_MAX_IDS ? merged.slice(merged.length - DOT_CHECKPOINT_MAX_IDS) : merged
  // Raising t to the page tip is safe only because every page id was merged:
  // anything between the old tip and the new one is inside the page (a full
  // page without overlap is refused by assertDotWindow first).
  return {
    initialized: false,
    messages: fresh,
    watermark: { v: 2, t: Math.max(prev.t, maxAt(list)), ids: idsTail },
  }
}

// afterDotSend records a send WITHOUT advancing the read checkpoint: the
// sent id joins the delivered set, but t and every other delivered id stay,
// so unread messages older than the send survive for the next poll. The
// bootstrap branch (no prior checkpoint — bind, then send before ever
// polling) seeds t = 0 for the same reason: a floor at the send time would
// filter out every unread message older than the send forever. The next
// poll then delivers full history (at-least-once, consistent with the
// documented replay semantics).
export function afterDotSend(current, accepted, prompt, now = Date.now()) {
  if (!current || typeof current !== 'object') {
    throw new TypeError('afterDotSend needs the current dot record')
  }
  const id = String((accepted && accepted.id) || '')
  if (!id) throw new TypeError('afterDotSend needs the accepted message id')
  const prev = normalizeWatermark(current.watermark)
  const watermark = prev
    ? { v: 2, t: prev.t, ids: [...new Set([...prev.ids, id])] }
    : { v: 2, t: 0, ids: [id] }
  return { ...current, watermark, lastSentAt: now, lastSentText: String(prompt) }
}

// dotSendInterruption classifies an interrupted FOREGROUND dot send by how
// far it got. After dispatch (or during the click window) the message may
// already have landed: the honest filing says so and asks for inspection
// before any retry — never the reaper's "runner died", which invites a
// blind duplicate send. 'accepted'/'sent' mean the send was VERIFIED
// (B6): a new API message id with the exact authored text was already
// proven, so the filing states that instead of re-opening an inspection
// question the code has already answered.
export function dotSendInterruption(submissionState, detail = '') {
  const verified = ['accepted', 'sent'].includes(submissionState)
  const dispatched = ['dispatching', 'dispatched', 'accepted', 'sent'].includes(submissionState)
  const suffix = detail ? ' (' + detail + ')' : ''
  if (verified) {
    return 'dot send was interrupted after the send was verified — the message is on the thread; only the bookkeeping was cut short' + suffix
  }
  return dispatched
    ? 'dot send interrupted after dispatch — the message may have been sent; inspect the dot thread before retrying' + suffix
    : 'dot send interrupted before dispatch — nothing was sent; retry is safe' + suffix
}

// ----- destructive deletes ---------------------------------------------------

// planDeletion is the gate before any delete PATCH: it refuses a partial or
// capped inventory, unknown ids, and conversations with running turns. A
// destructive command must not proceed on a guess.
export function planDeletion({ items, listingError, hitCap, deleteIds, deleteAll, confirmed, activeIds }) {
  const list = Array.isArray(items) ? items : []
  const known = new Set(list.map((it) => String((it && it.id) || '')).filter(Boolean))
  if (listingError) {
    return { error: 'listing failed: ' + listingError + ' — refusing to delete from a partial inventory' }
  }
  if (deleteAll && !confirmed) {
    return { error: 'chats --delete --all is destructive and requires --yes' }
  }
  let wanted = null
  if (deleteAll) {
    if (hitCap) {
      return {
        error: 'conversation listing hit its cap — --all cannot prove the complete inventory; delete explicit ids instead',
      }
    }
    wanted = [...known]
    if (!wanted.length) return { targets: [], note: 'nothing to delete' }
  } else {
    wanted = [...(deleteIds || [])].map(String)
    const unknown = wanted.filter((id) => !known.has(id))
    if (unknown.length) return { error: 'not in the visible chat list: ' + unknown.join(', ') }
  }
  const active = new Set((activeIds || []).map(String))
  const clash = wanted.filter((id) => active.has(id))
  if (clash.length) {
    return { error: 'refusing to delete conversations with running turns: ' + clash.join(', ') }
  }
  return { targets: wanted }
}

// collectConversationListing drives one conversations-listing page fetch at
// a time and decides completeness honestly. A short page proves the end. A
// FULL page at the item cap proves nothing either way: an inventory of
// exactly `cap` items is complete when the next page is empty and capped
// when it is not — one boundary probe decides, instead of reporting every
// at-cap listing as truncated (which also refused legitimate
// `chats --delete --all --yes` runs). fetchPage(offset) resolves
// {items} or {error}; a REJECTING fetchPage (e.g. evaluateBounded's
// wall-clock bound) is converted into that same {error} channel so the
// partial-result honesty path sees it instead of crashing the command
// (B1); pure so the pagination contract is testable.
export async function collectConversationListing(fetchPage, { limit = 50, cap = 200 } = {}) {
  const items = []
  let lastError = null
  let hitCap = false
  let offset = 0
  for (;;) {
    let page
    try {
      page = await fetchPage(offset)
    } catch (e) {
      lastError = String((e && e.message) || e)
      break
    }
    if (!page || page.error) {
      lastError = (page && page.error) || 'listing fetch failed'
      break
    }
    const batch = Array.isArray(page.items) ? page.items : []
    items.push(...batch)
    if (batch.length < limit) break // a short page proves completeness
    if (items.length >= cap) {
      // Boundary probe. A probe failure is treated as capped AND errored:
      // completeness is unproven, and destructive deletes refuse on either.
      let probe
      try {
        probe = await fetchPage(offset + limit)
      } catch (e) {
        probe = { error: String((e && e.message) || e) }
      }
      if (!probe || probe.error) {
        lastError = (probe && probe.error) || 'listing boundary probe failed'
        hitCap = true
        break
      }
      hitCap = (probe.items || []).length > 0
      break
    }
    offset += limit
  }
  return { items, lastError, hitCap }
}

// ----- wait generation pinning ------------------------------------------------

export function assertWaitGeneration(job, expectedTurnId) {
  if (!job) throw new Error('no such job')
  if ((job.turnId || null) !== (expectedTurnId || null)) {
    throw new Error(
      `the job record moved to a newer turn (wait started on ${expectedTurnId || 'the pre-generation record'}, ` +
        `record now has ${job.turnId || 'the pre-generation record'}) — the awaited reply was superseded; ` +
        'wait again, optionally with --turn <turnId> to pin a generation'
    )
  }
  return job
}

// ----- artifact names ----------------------------------------------------------

export function boundedArtifactName(name) {
  let safe = String(name ?? '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '_')
  if (!safe) safe = 'file'
  if (safe.length > 128) {
    const ext = (/\.[A-Za-z0-9]{1,15}$/.exec(safe) || [''])[0]
    safe = safe.slice(0, 128 - ext.length).replace(/\.+$/, '') + ext
  }
  return safe
}

// ----- CLI parsing ---------------------------------------------------------------

const FLAG_OPTIONS = {
  '--stream': 'stream',
  '--json': 'json',
  '--poll': 'poll',
  '--reset': 'reset',
  '--delete': 'delete',
  '--all': 'all',
  '--yes': 'yes',
}
const VALUE_OPTIONS = {
  '--file': 'file',
  '-f': 'file',
  '--turn': 'turn',
  '--context': 'context',
}
const OPTIONAL_VALUE = new Set(['--context'])

const COMMAND_SPECS = {
  help: { operands: [0, 0], options: [] },
  start: { operands: [1, 1], options: ['file'] },
  send: { operands: [2, 2], options: ['file'] },
  resume: { operands: [1, 1], options: [] },
  wait: { operands: [1, 2], options: ['stream', 'turn', 'json'] },
  list: { operands: [0, 0], options: [] },
  status: { operands: [0, 0], options: [] },
  chats: { operands: [0, Infinity], options: ['delete', 'all', 'yes'] },
  model: { operands: [0, Infinity], options: [] },
  files: { operands: [1, 1], options: [] },
  download: { operands: [1, 3], options: [] },
  dot: { operands: [0, 1], options: ['json', 'poll', 'reset', 'context'] },
  login: { operands: [0, 0], options: [] },
}

// parseCli validates the whole command line: option names per command,
// `--` operand escaping, option-value consumption, operand counts, numeric
// bounds and combination rules. Callers never re-parse raw argv (a literal
// message like "--poll" reaches the dot sender as text, via `--`).
export function parseCli(argv) {
  const raw = Array.isArray(argv) ? argv : []
  if (raw.length === 0) return { command: 'help', args: [], options: { file: [] } }
  // Pass 1 is purely lexical: split flags, option values and operands with
  // `--` escaping, without knowing the command (an option value never
  // becomes an operand, wherever it appears).
  const operands = []
  const flags = []
  const values = {}
  let escaped = false
  let wantsHelp = false
  for (let i = 0; i < raw.length; i++) {
    const token = raw[i]
    if (escaped) {
      operands.push(token)
      continue
    }
    if (token === '--') {
      escaped = true
      continue
    }
    if (token.startsWith('--') || /^-[a-z]$/i.test(token)) {
      if (token === '--help' || token === '-h') {
        wantsHelp = true
        continue
      }
      if (token in VALUE_OPTIONS) {
        const next = raw[i + 1]
        // An optional value (--context) defaults whenever the value is
        // absent — at end of argv OR before another flag. Defaulting only
        // at end-of-argv made the documented `dot --context --json` form
        // silently run status instead (A2).
        if (OPTIONAL_VALUE.has(token) && (next === undefined || next.startsWith('--'))) {
          values[VALUE_OPTIONS[token]] = values[VALUE_OPTIONS[token]] ?? 20
          continue
        }
        // A required value must not swallow a flag-looking token:
        // `start --file --stream "hi"` used to error as "no such file:
        // --stream" and `wait id --turn --json` ate --json as the value.
        if (next === undefined || next.startsWith('--') || /^-[a-z]$/i.test(next)) {
          throw new Error(`${token} needs a value`)
        }
        const key = VALUE_OPTIONS[token]
        values[key] = key === 'file' ? [...(values.file || []), next] : next
        i++
        continue
      }
      if (token in FLAG_OPTIONS) {
        flags.push(FLAG_OPTIONS[token])
        continue
      }
      throw new Error(`unknown option ${token}`)
    }
    operands.push(token)
  }
  if (wantsHelp) return { command: 'help', args: [], options: { file: [] } }
  const command = operands[0]
  if (typeof command !== 'string') throw new Error('missing command — run: chatgpt-web help')
  const spec = COMMAND_SPECS[command]
  if (!spec) throw new Error(`unknown command: ${command} — run: chatgpt-web help`)
  // Pass 2 validates against the command's contract.
  const allowed = new Set(spec.options)
  const options = { file: [] }
  for (const key of flags) {
    if (!allowed.has(key)) throw new Error(`--${key} is not valid for: ${command}`)
    options[key] = true
  }
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) throw new Error(`--${key} is not valid for: ${command}`)
    options[key] = value
  }
  const args = operands.slice(1) // drop the command word
  const [min, max] = spec.operands
  if (args.length < min || args.length > max) {
    const want = min === max ? String(min) : max === Infinity ? `at least ${min}` : `${min}..${max}`
    throw new Error(`${command} takes ${want} argument(s), got ${args.length}`)
  }
  if (command === 'wait') {
    if (options.json && options.stream) throw new Error('wait: --json and --stream cannot be combined')
    if (options.turn !== undefined && !/^[0-9a-fA-F-]{8,}$/.test(String(options.turn))) {
      throw new Error('wait: --turn needs a turn id')
    }
    if (args[1] !== undefined) positiveInteger(args[1], 'wait seconds', { max: 86400 })
  }
  if (command === 'chats') {
    if (options.all && !options.delete) throw new Error('chats: --all belongs to --delete')
    if (options.delete && !options.all && args.length === 0) {
      throw new Error('chats --delete needs chat ids, or --all (with --yes)')
    }
    // Operands only mean something to --delete; a bare `chats some-id` used
    // to list everything and silently ignore the id.
    if (!options.delete && args.length) {
      throw new Error('chats takes no arguments — to hide chats: chats --delete <id>...')
    }
  }
  if (command === 'dot') {
    // After the parser fix, context is always the number 20 or a numeric
    // string here — the old `=== true` branch was unreachable dead code.
    if (options.context !== undefined) {
      options.context = positiveInteger(options.context, 'context count', { min: 1, max: 32 })
    }
    const modes = [options.poll, options.reset, options.context !== undefined, args.length > 0].filter(Boolean).length
    if (modes > 1) throw new Error('dot: choose one of a message, --poll, --context [n], --reset')
  }
  return { command, args, options }
}
