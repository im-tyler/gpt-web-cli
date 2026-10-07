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
// instead of dying mid-window on a transient class. (B5 changed the fixture:
// a logged-out session is now auth-fatal, not a retriable transient — the
// transient here is a transport-class status 0.)
test('waitForAcceptedPrompt ends in ACCEPTANCE_UNKNOWN after transient storms (A1)', async () => {
  freshHome()
  const runner = await loadRunner()
  const page = fakePage(async () => ({ error: 'Execution context was destroyed' }))
  await assert.rejects(
    runner.waitForAcceptedPrompt(page, 'question', new Set(), BOUND, 1200),
    (e) => e.code === 'ACCEPTANCE_UNKNOWN' && /inspect/.test(e.message) && /Execution context was destroyed/.test(e.message)
  )
})

// B5: a logged-out session (no access token / session endpoint refusing)
// is auth-gone, not a status-0 transient — the wait must fail fast with
// login guidance instead of hammering a dead session to the deadline.
test('waitForReply fails fast on a logged-out session instead of retrying to the deadline (B5)', async () => {
  freshHome('10')
  const runner = await loadRunner()
  let calls = 0
  const page = fakePage(async () => {
    calls++
    return { error: 'not logged in (session auth failed 401)', auth: true, status: 401 }
  })
  await assert.rejects(
    runner.waitForReply(page, 'u1', BOUND, null, new Set()),
    (e) =>
      e.code === 'CONVERSATION_HTTP' && e.httpStatus === 401 && /not logged in — run: chatgpt-web login/.test(e.message)
  )
  assert.equal(calls, 1, 'no retries for an auth-gone session')
})

// B5: the same classification reaches the acceptance window.
test('waitForAcceptedPrompt fails fast on a logged-out session (B5)', async () => {
  freshHome()
  const runner = await loadRunner()
  let calls = 0
  const page = fakePage(async () => {
    calls++
    return { error: 'not logged in (session auth failed 403)', auth: true, status: 403 }
  })
  await assert.rejects(
    runner.waitForAcceptedPrompt(page, 'question', new Set(), BOUND, 60000),
    (e) => e.code === 'CONVERSATION_HTTP' && e.httpStatus === 403 && /chatgpt-web login/.test(e.message)
  )
  assert.equal(calls, 1)
})

// B3: the acceptance window is fixed — backoff scaled to the window (and
// 404 held at base cadence) keeps it fed. Under a fake clock, a send that
// only becomes observable at the 20th poll (~t≤47.5s even at worst-case
// jitter) must still be accepted inside the 60s window; the HEAD backoff
// (2s,4s,8s,15s,15s…) had already starved the window to ~6 polls.
test('waitForAcceptedPrompt observes a late-landing send under a sustained 404 storm (B3)', async () => {
  freshHome()
  const runner = await loadRunner()
  let t = Date.now()
  const now = () => t
  const sleep = async (ms) => {
    t += ms
  }
  let calls = 0
  const startedAt = t
  const page = fakePage(async () => {
    calls++
    if (calls < 20) return { status: 404, error: 'http 404' }
    return { status: 200, data: ACCEPTED() }
  })
  const id = await runner.waitForAcceptedPrompt(page, 'question', new Set(['u0']), BOUND, 60000, { now, sleep })
  assert.equal(id, 'u1')
  assert.ok(calls >= 20, `the window kept polling (${calls} attempts, not a starved ~6)`)
  assert.ok(t - startedAt < 60000, `acceptance happened inside the 60s window (simulated ${(t - startedAt) / 1000}s)`)
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

// guardPage fakes enough DOM for sendPromptGuarded's in-page evaluation:
// one visible contenteditable composer holding `held`, an empty structural
// attachment slot, and one visible enabled Send button that records its
// click. Mirrors the 2026-10-06 live failure fixture: the composer's
// innerText renders a paragraph break at the autolink boundary.
function guardPage(held, { path = '/c/' + CONV, emptySlot = true, scopeKnown = true } = {}) {
  let clicked = false
  const scope = {
    querySelector: (sel) => (emptySlot && sel.includes('ComposerLayoutAttachments') ? { childElementCount: 0 } : null),
    querySelectorAll: () => [],
  }
  const composer = {
    tagName: 'DIV',
    innerText: held,
    getClientRects: () => [1],
    closest: () => scopeKnown ? scope : null,
  }
  const button = {
    disabled: false,
    getAttribute: () => null,
    getClientRects: () => [1],
    click: () => {
      clicked = true
    },
  }
  return {
    clicked: () => clicked,
    url: () => BOUND,
    goto: async () => {
      throw new Error('the guard never navigates')
    },
    evaluate: async (fn, arg) => {
      globalThis.location = { origin: 'https://chatgpt.com', pathname: path }
      globalThis.getComputedStyle = () => ({ visibility: 'visible' })
      globalThis.document = {
        querySelectorAll: (sel) => {
          if (sel === arg.selectors.composer || sel === arg.composerSel) return [composer]
          if (sel === arg.selectors.submit) return [button]
          if (sel === arg.selectors.messages) return []
          return []
        },
      }
      try {
        return await fn(arg)
      } finally {
        delete globalThis.location
        delete globalThis.getComputedStyle
        delete globalThis.document
      }
    },
  }
}

// 2026-10-06 regression (4 failed audit sends): the contenteditable renders
// the first space before an autolinked URL as a paragraph break — held
// "audit \nhttps://…" for authored "audit https://…". innerText block
// boundaries are RENDERING, not content; authored identity is proven after
// the click by the API acceptance (new id + exact text). The guard must
// click. (Strict line-endings-only compare, restored by pass P, refused all
// three attempts and nothing was ever sent.)
test('sendPromptGuarded clicks through a rendered paragraph break at the autolink boundary', async () => {
  freshHome()
  const runner = await loadRunner()
  const prompt = 'audit https://github.com/neutron-build/neutron for bugs and improvements across the framework'
  const held = 'audit \nhttps://github.com/neutron-build/neutron for bugs and improvements across the framework'
  const page = guardPage(held)
  await runner.sendPromptGuarded(page, { boundUrl: BOUND, prompt, files: [] })
  assert.equal(page.clicked(), true, 'the guard clicked the send button')
})

// The flattening must not open the hole strict compare closed: a server
// draft that clobbers the typed prompt with DIFFERENT TOKENS still refuses.
test('sendPromptGuarded still refuses a different prompt under the flattened compare', async () => {
  freshHome()
  const runner = await loadRunner()
  const page = guardPage('a server-synced draft replaced the typed prompt entirely')
  await assert.rejects(
    runner.sendPromptGuarded(page, {
      boundUrl: BOUND,
      prompt: 'audit https://github.com/neutron-build/neutron for bugs',
      files: [],
    }),
    /submission guard: composer changed before submission/
  )
  assert.equal(page.clicked(), false, 'nothing was clicked')
})

// Multi-line prompts: the Oct-4 flattening compared the flattened held text
// against a line-preserved prompt, so a multi-line prompt could never match.
// Both sides flatten now — an extra blank-line run in the rendering is the
// same rendering divergence as the autolink break.
test('sendPromptGuarded flattens both sides for multi-line prompts', async () => {
  freshHome()
  const runner = await loadRunner()
  const prompt = 'first line\nsecond line\n\nnew paragraph with a url https://example.com/x'
  const held = 'first line\n\nsecond line\n\n\nnew paragraph with a url \nhttps://example.com/x'
  const page = guardPage(held)
  await runner.sendPromptGuarded(page, { boundUrl: BOUND, prompt, files: [] })
  assert.equal(page.clicked(), true, 'the guard clicked the send button')
})

// B2: the final verification fetch (post-done) gets the poll loops'
// transient classification — one 429 after a proven-complete answer must
// not fail the turn; a fatal class (403) still rejects immediately; and
// exhaustion after sustained transients surfaces the transient cause.
test('fetchConversationMessagesRetrying forgives a transient verification blip (B2)', async () => {
  freshHome()
  const runner = await loadRunner()
  let calls = 0
  const page = fakePage(async () => {
    calls++
    if (calls === 1) return { status: 429, error: 'http 429' }
    return { status: 200, data: DONE() }
  })
  const snapshot = await runner.fetchConversationMessagesRetrying(page, CONV)
  assert.ok(snapshot.allUserIds.has('u1'), 'the retried read returned the real snapshot')
  assert.equal(calls, 2)
})

test('fetchConversationMessagesRetrying stays fatal on auth-class failures (B2)', async () => {
  freshHome()
  const runner = await loadRunner()
  let calls = 0
  const page = fakePage(async () => {
    calls++
    return { status: 403, error: 'http 403' }
  })
  await assert.rejects(
    runner.fetchConversationMessagesRetrying(page, CONV),
    (e) => e.code === 'CONVERSATION_HTTP' && e.httpStatus === 403
  )
  assert.equal(calls, 1, 'a fatal class never retries')
})

test('fetchConversationMessagesRetrying exhausts bounded and reports the transient (B2)', async () => {
  freshHome()
  const runner = await loadRunner()
  let calls = 0
  const page = fakePage(async () => {
    calls++
    return { status: 503, error: 'http 503' }
  })
  await assert.rejects(
    runner.fetchConversationMessagesRetrying(page, CONV, { attempts: 3, budgetMs: 60000 }),
    (e) => e.code === 'CONVERSATION_HTTP' && e.httpStatus === 503
  )
  assert.equal(calls, 3, 'attempts are bounded — this is not a retry-to-deadline loop')
})

// B4: one drift event must not overshoot the reply deadline by minutes of
// unbounded 3×60s gotos — every goto timeout is clamped to the remaining
// deadline and attempts stop once it is exhausted.
test('waitForReply bounds re-bind attempts by the reply deadline (B4)', async () => {
  freshHome('2') // 2s reply deadline
  const runner = await loadRunner()
  const gotoTimeouts = []
  let gots = 0
  const page = fakePage(
    async () => {
      throw new Error('must not poll from a foreign page')
    },
    () => OTHER,
    async (u, opts) => {
      gots++
      gotoTimeouts.push(opts.timeout)
      // goto "hangs" until its own timeout, then fails to navigate
    }
  )
  const started = Date.now()
  await assert.rejects(
    runner.waitForReply(page, 'u1', BOUND, null, new Set()),
    (e) => e.code === 'CONVERSATION_DRIFT'
  )
  const elapsed = Date.now() - started
  assert.ok(gots >= 1, 'a re-bind was attempted')
  for (const t of gotoTimeouts) assert.ok(t <= 2000, `goto timeout clamped to the deadline (saw ${t}ms)`)
  assert.ok(elapsed < 2400, `the drift path ended near the deadline (${elapsed}ms), not at deadline + minutes`)
})

// B1: the in-page delete PATCH loop is cancellable — it arms the stop flag
// at entry and checks it before every PATCH, so a fired wall-clock bound
// stops it at the current id with the real partial results (never a
// detached loop that keeps hiding conversations after the lock released).
test('deletePatchLoopInPage stops at the cancel flag before the next PATCH (B1)', async () => {
  freshHome()
  const runner = await loadRunner()
  const patched = []
  const realFetch = globalThis.fetch
  globalThis.window = {}
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u === '/api/auth/session') return { ok: true, status: 200, json: async () => ({ accessToken: 'tok' }) }
    patched.push(u)
    if (patched.length === 1) window.__cgwDelCancel = true // the bound fires mid-loop
    return { ok: true, status: 200 }
  }
  try {
    const result = await runner.deletePatchLoopInPage({ ids: ['a', 'b', 'c'], timeoutMs: 50 })
    assert.equal(result.cancelled, true, 'the loop reports that it was cancelled')
    assert.equal(result.results.length, 1, 'only the in-flight PATCH is in the results')
    assert.deepEqual(patched, ['/backend-api/conversation/a'], 'b and c were never patched after the cancel')
  } finally {
    globalThis.fetch = realFetch
    delete globalThis.window
  }
})

test('deletePatchLoopInPage completes without cancellation and reports every id (B1)', async () => {
  freshHome()
  const runner = await loadRunner()
  const patched = []
  const realFetch = globalThis.fetch
  globalThis.window = {}
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u === '/api/auth/session') return { ok: true, status: 200, json: async () => ({ accessToken: 'tok' }) }
    patched.push(u)
    return { ok: true, status: 200 }
  }
  try {
    const result = await runner.deletePatchLoopInPage({ ids: ['a', 'b'], timeoutMs: 50 })
    assert.equal(result.cancelled, undefined)
    assert.deepEqual(result.results.map((r) => r.id), ['a', 'b'])
    assert.ok(result.results.every((r) => r.ok))
    assert.deepEqual(patched, ['/backend-api/conversation/a', '/backend-api/conversation/b'])
  } finally {
    globalThis.fetch = realFetch
    delete globalThis.window
  }
})

test('sendPromptGuarded refuses unmapped attachment emptiness before clicking (P05)', async () => {
  freshHome()
  const runner = await loadRunner()
  const page = guardPage('question', { emptySlot: false })
  await assert.rejects(runner.sendPromptGuarded(page, { boundUrl: BOUND, prompt: 'question', files: [] }),
    /attachment empty-state unrecognized/)
  assert.equal(page.clicked(), false)
})

test('readComposerAttachments requires a mapped empty sentinel (P05)', async () => {
  freshHome()
  const runner = await loadRunner()
  assert.deepEqual(await runner.readComposerAttachments(guardPage('question', { emptySlot: false })), { known: false })
  assert.deepEqual(await runner.readComposerAttachments(guardPage('question')), { known: true, files: [] })
})

test('dot submit refuses an unknown attachment slot or composer scope (P05)', async () => {
  freshHome()
  const runner = await loadRunner()
  for (const options of [{ emptySlot: false }, { scopeKnown: false }]) {
    const page = guardPage('question', { path: '/dots/' + CONV, ...options })
    await assert.rejects(runner.sendDotPromptGuarded(page, { dotId: CONV, prompt: 'question' }),
      /unrecognized/)
    assert.equal(page.clicked(), false)
  }
})

test('dot submit accepts the mapped empty slot (P05)', async () => {
  freshHome()
  const runner = await loadRunner()
  const page = guardPage('question', { path: '/dots/' + CONV })
  await runner.sendDotPromptGuarded(page, { dotId: CONV, prompt: 'question' })
  assert.equal(page.clicked(), true)
})
