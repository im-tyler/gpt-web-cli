// Behavioral regression tests for the API-only wait loops (pass-A audit):
// transient poll failures must retry to the deadline with backoff (A1),
// operator navigation of the shared daemon tab must re-bind instead of
// failing the turn (A4), and drift at the MUTATION boundary stays fatal.
// All tests run against fake page objects — no browser, no network.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'

// Set before any runner.mjs import binds its config (each test file gets
// its own process; the runner is cache-busted per test so env changes bind).
function freshHome(timeoutSecs = '15') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-waits-test-'))
  process.env.CHATGPT_WEB_HOME = home
  process.env.CHATGPT_WEB_MIN_GAP = '0'
  process.env.CHATGPT_WEB_TIMEOUT = timeoutSecs
  return home
}

const loadRunner = () => import(`./runner.mjs?h=${crypto.randomUUID()}`)

const CONV = '11111111-1114-1144-1144-111111111111'
const BOUND = 'https://chatgpt.com/c/' + CONV
const OTHER = 'https://chatgpt.com/c/22222222-2222-2222-2222-222222222222'

function conv(messages) {
  const mapping = {}
  for (const m of messages) mapping[m.id] = { message: m, children: [] }
  return { mapping }
}

function message(id, role, text, create) {
  return {
    id,
    author: { role },
    create_time: create,
    content: { content_type: 'text', parts: [text] },
    status: 'finished_successfully',
    end_turn: role === 'assistant',
    recipient: 'all',
  }
}

const DONE = () =>
  conv([message('u1', 'user', 'question', 1), message('a1', 'assistant', 'the answer', 2)])

const ACCEPTED = () =>
  conv([
    message('u0', 'user', 'older prompt', 0),
    message('a0', 'assistant', 'older answer', 0.5),
    message('u1', 'user', 'question', 1),
  ])

function fakePage(evaluate, url = () => BOUND, goto = async () => {}) {
  return { url, goto, evaluate }
}

// A1: status-0 storms (session hiccup, destroyed execution context, abort)
// used to fail the whole turn; they must retry to the deadline.
test('waitForReply survives transient status-0 polls and completes (A1)', async () => {
  freshHome()
  const runner = await loadRunner()
  let calls = 0
  const page = fakePage(async () => {
    calls++
    if (calls <= 3) return { error: 'Execution context was destroyed' } // -> status 0
    return { status: 200, data: DONE() }
  })
  const result = await runner.waitForReply(page, 'u1', BOUND, null, new Set())
  assert.equal(result.state, 'done')
  assert.equal(result.text, 'the answer')
  assert.ok(calls >= 4, 'the transient failures were actually served')
})

// A1: 429 is the likeliest poll answer under pressure — retriable.
test('waitForReply forgives HTTP 429 with backoff (A1)', async () => {
  freshHome()
  const runner = await loadRunner()
  let calls = 0
  const page = fakePage(async () => {
    calls++
    if (calls <= 2) return { status: 429, error: 'http 429' }
    return { status: 200, data: DONE() }
  })
  const result = await runner.waitForReply(page, 'u1', BOUND, null, new Set())
  assert.equal(result.state, 'done')
  assert.ok(calls >= 3)
})

// A1: auth-class failures are NOT transient — fail fast, no retry-to-deadline.
test('waitForReply fails fast on 403 instead of retrying (A1)', async () => {
  freshHome()
  const runner = await loadRunner()
  let calls = 0
  const page = fakePage(async () => {
    calls++
    return { status: 403, error: 'http 403' }
  })
  await assert.rejects(
    runner.waitForReply(page, 'u1', BOUND, null, new Set()),
    (e) => e.code === 'CONVERSATION_HTTP' && e.httpStatus === 403
  )
  assert.equal(calls, 1, 'no retries for a fatal class')
})

// A1: a persistently dead page still terminates — at the reply deadline,
// reporting the transient cause (bounded, not infinite).
test('waitForReply retries a dead page to the deadline, then reports it (A1)', async () => {
  freshHome('2')
  const runner = await loadRunner()
  let calls = 0
  const page = fakePage(async () => {
    calls++
    return { error: 'net::ERR_INTERNET_DISCONNECTED' }
  })
  await assert.rejects(
    runner.waitForReply(page, 'u1', BOUND, null, new Set()),
    (e) => e.code === 'REPLY_TIMEOUT' && /net::ERR_INTERNET_DISCONNECTED/.test(e.message)
  )
  assert.ok(calls >= 2, 'the loop retried before giving up at the deadline')
})

// A1: acceptance polling keeps the inspect-first guidance (ACCEPTANCE_UNKNOWN)
// instead of dying mid-window on a transient class.
test('waitForAcceptedPrompt ends in ACCEPTANCE_UNKNOWN after transient storms (A1)', async () => {
  freshHome()
  const runner = await loadRunner()
  const page = fakePage(async () => ({ error: 'no access token' }))
  await assert.rejects(
    runner.waitForAcceptedPrompt(page, 'question', new Set(), BOUND, 1200),
    (e) => e.code === 'ACCEPTANCE_UNKNOWN' && /inspect/.test(e.message) && /no access token/.test(e.message)
  )
})

test('waitForAcceptedPrompt accepts a new API message after transient 429s (A1)', async () => {
  freshHome()
  const runner = await loadRunner()
  let calls = 0
  const page = fakePage(async () => {
    calls++
    if (calls <= 2) return { status: 429, error: 'http 429' }
    return { status: 200, data: ACCEPTED() }
  })
  const id = await runner.waitForAcceptedPrompt(page, 'question', new Set(['u0']), BOUND, 15000)
  assert.equal(id, 'u1', 'acceptance matched the NEW user message, not the prior identical-ish one')
})

// A4: the operator navigates the shared daemon tab mid-wait — the wait is
// API-only, so re-bind and keep going instead of failing the turn.
test('waitForReply re-binds after operator navigation instead of dying (A4)', async () => {
  freshHome()
  const runner = await loadRunner()
  let current = OTHER // the operator already navigated this tab away
  let rebinds = 0
  const page = fakePage(
    async () => ({ status: 200, data: DONE() }),
    () => current,
    async (u) => {
      rebinds++
      current = u
    }
  )
  const result = await runner.waitForReply(page, 'u1', BOUND, null, new Set())
  assert.equal(result.state, 'done')
  assert.ok(rebinds >= 1, 'drift was repaired by goto, not fatal')
  assert.equal(current, BOUND)
})

test('waitForAcceptedPrompt also re-binds on drift (A4)', async () => {
  freshHome()
  const runner = await loadRunner()
  let current = OTHER
  const page = fakePage(
    async () => ({ status: 200, data: ACCEPTED() }),
    () => current,
    async (u) => {
      current = u
    }
  )
  const id = await runner.waitForAcceptedPrompt(page, 'question', new Set(['u0']), BOUND, 15000)
  assert.equal(id, 'u1')
})

// A4: drift stays fatal when re-binding cannot restore the conversation.
test('waitForReply stays fatal when re-binding cannot restore the route (A4)', async () => {
  freshHome()
  const runner = await loadRunner()
  const page = fakePage(
    async () => {
      throw new Error('must not poll from a foreign page')
    },
    () => OTHER,
    async () => {
      throw new Error('net::ERR_CONNECTION_REFUSED')
    }
  )
  await assert.rejects(
    runner.waitForReply(page, 'u1', BOUND, null, new Set()),
    (e) => e.code === 'CONVERSATION_DRIFT'
  )
})

// A4: the strictness BELONGS at the mutation boundary — the submission
// guard must still refuse a drifted route, never click from a foreign page.
test('sendPromptGuarded keeps drift fatal at the mutation boundary (A4)', async () => {
  freshHome()
  const runner = await loadRunner()
  const page = {
    url: () => OTHER,
    goto: async () => {
      throw new Error('the guard never navigates')
    },
    evaluate: async (fn, arg) => {
      globalThis.location = { origin: 'https://chatgpt.com', pathname: '/c/22222222-2222-2222-2222-222222222222' }
      try {
        return await fn(arg)
      } finally {
        delete globalThis.location
      }
    },
  }
  await assert.rejects(
    runner.sendPromptGuarded(page, { boundUrl: BOUND, prompt: 'hi', files: [] }),
    /submission guard: conversation changed before submission/
  )
})
