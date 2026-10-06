#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execSync, execFileSync, execFile } from 'node:child_process'
import { chromium } from 'playwright-core'
import {
  PROFILE_DIR,
  HOME,
  sleep,
  limits,
  withLock,
  updateState,
  updateDot,
  readDot,
  readJob,
  turns,
  readState,
  runningJobs,
  withStoreLock,
} from './jobs.mjs'
import {
  positiveInteger,
  listenerPid,
  profileBusyArgv,
  profileProcessPattern,
  spawnStarted,
  saveArtifact,
  chatListingOutcome,
  dedupeByFileId,
  attachmentVerdict,
} from './core-fixes.mjs'
import {
  AuditError,
  canonicalPrompt,
  samePrompt,
  conversationId,
  conversationUrl,
  conversationSnapshot,
  findAcceptedUser,
  inspectReply,
  parseSliderDescription,
  sliderEqual,
  withRestoredPicker,
  dotPollBatch,
  afterDotSend,
  assertDotWindow,
  planDeletion,
  integerEnv,
  retriablePollError,
  pollDelayMs,
  pollBackoffMs,
  collectConversationListing,
} from './audit-core.mjs'
import {
  getBackendJSON,
  writeOutput,
  validateUploads,
  writeJSONAtomic,
  boundedBrowserDownload,
  evaluateBounded,
  ARTIFACT_MAX_BYTES,
} from './audit-io.mjs'

const jitter = (a, b) => a + Math.random() * (b - a)

const CHAT_URL = 'https://chatgpt.com/'

// Importing the runner installs no handlers, starts nothing and exits for
// nothing: environment validation happens in validateRunnerConfig(), called
// by the worker entry (and lazily wherever the config is first needed).
let cachedRunnerConfig = null
export function validateRunnerConfig() {
  if (cachedRunnerConfig) return cachedRunnerConfig
  cachedRunnerConfig = {
    turnTimeoutMs:
      integerEnv(process.env, 'CHATGPT_WEB_TIMEOUT', 300, { min: 1, max: 86400 }) * 1000,
    cdpPort: String(integerEnv(process.env, 'CHATGPT_WEB_CDP_PORT', 9777, { min: 1, max: 65535 })),
  }
  return cachedRunnerConfig
}

const cdpUrl = () => 'http://127.0.0.1:' + validateRunnerConfig().cdpPort

const COMPOSER_SEL = '#prompt-textarea, textarea[data-id], div[contenteditable="true"]'
const MESSAGE_SEL = '[data-message-author-role]'
const SUBMIT_SEL = '#composer-submit-button, [data-testid="send-button"], button[aria-label="Send"]'
const LOGIN_SEL = '[data-testid="login-button"], button:has-text("Log in")'
const NEW_CHAT_SEL = 'nav a[href="/"], [data-testid*="new-chat"] a, a:has-text("New chat")'
// Candidate attachment cards in the composer scope, plus the attachment
// slot itself. Live fixture (2026-10-06, main-chat surface): the composer's
// FORM scope contains a `ComposerLayoutAttachments-*` container with ZERO
// element children when no attachments exist — a structural empty-state
// sentinel. Cards inside it, or legacy chips in the scope, indicate
// attachments; their STATE is never guessed from visible text — only a
// fixture-backed profile may map card attributes to ready/uploading/error.
const ATTACH_CHIP_SEL =
  '[data-testid*="attach" i], [data-testid*="file" i], [class*="attachment" i], [class*="file-tile" i]'
const ATTACH_CONTAINER_SEL = '[class*="ComposerLayoutAttachments"]'

// ----- worker fencing (fatal errors abort before further mutation) -------

const operation = new AbortController()
let ownedPage = null

export function abortRunner(error) {
  operation.abort(error) // synchronous: prevents later browser mutations
  return ownedPage ? ownedPage.close().catch(() => {}) : Promise.resolve()
}

function assertRunnerLive() {
  operation.signal.throwIfAborted()
}

async function ownedUpdate(id, turnId, mutate) {
  assertRunnerLive()
  const updated = await turns.update(id, turnId, mutate)
  if (!updated) throw new AuditError('TURN_OWNERSHIP_LOST', 'turn no longer belongs to this worker')
  return updated
}

function assertOwnedBeforeMutation(id, turnId) {
  assertRunnerLive()
  const current = readJob(id)
  if (
    !current ||
    current.turnId !== turnId ||
    current.pid !== process.pid ||
    !['running', 'streaming'].includes(current.status)
  ) {
    throw new AuditError('TURN_OWNERSHIP_LOST', 'refusing browser mutation for a stale turn')
  }
}

function convIdOf(url) {
  const m = String(url || '').match(/\/c\/([0-9a-fA-F-]{8,})/)
  return m ? m[1] : null
}

function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

function debugLog(...args) {
  if (process.env.CHATGPT_WEB_DEBUG !== '1') return
  try {
    fs.appendFileSync(path.join(HOME, 'debug.log'), new Date().toISOString() + ' ' + args.join(' ') + '\n')
  } catch {}
}

const CHROME_CANDIDATES = process.env.CHATGPT_WEB_CHROME
  ? [process.env.CHATGPT_WEB_CHROME]
  : [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
    ]

function chromeBinary() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p
  return null
}

function wantHeadless() {
  const v = String(process.env.CHATGPT_WEB_HEADLESS || '').toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

function chromeIsHeadlessBin() {
  try {
    // execFile with an argument vector: the profile path is data, never
    // shell syntax.
    const out = execFileSync('pgrep', ['-lf', profileProcessPattern(PROFILE_DIR)], { encoding: 'utf8' })
    return /--headless/.test(out)
  } catch {
    return false
  }
}

function setDaemonVisible(show) {
  if (process.platform !== 'darwin') return
  const pid = listenerPid(validateRunnerConfig().cdpPort)
  if (!pid) return
  try {
    execSync(
      `osascript -e 'tell application "System Events"\' -e \'set visible of (first process whose unix id is ${pid}) to ${show}\' -e \'end tell\'`,
      { stdio: 'ignore', timeout: 5000 }
    )
  } catch {}
}

// hidePidOnce re-asserts invisibility on a known pid without blocking the
// automation loop: osascript via execFile, fire-and-forget. The blocking
// setDaemonVisible is only for paths that must be sure (login unhides).
function hidePidOnce(pid) {
  if (process.platform !== 'darwin' || !pid) return
  execFile(
    'osascript',
    [
      '-e',
      'tell application "System Events" to set visible of (first process whose unix id is ' + pid + ') to false',
    ],
    { timeout: 5000 },
    () => {}
  )
}

function startHideLoop(pid) {
  hidePidOnce(pid)
  return setInterval(() => hidePidOnce(pid), 1200)
}

async function hideDaemon() {
  if (process.platform !== 'darwin') return
  for (let i = 0; i < 6; i++) {
    setDaemonVisible(false)
    await sleep(250)
  }
}

async function cdpVersion() {
  try {
    const res = await fetch(cdpUrl() + '/json/version', { signal: AbortSignal.timeout(1500) })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

// The daemon identity answers one question on reuse: is the process on this
// CDP port the one this HOME started, on this profile? Verification fails
// closed — an absent identity file or any mismatch is refused, because
// accepting an unknown browser means driving the wrong authenticated
// account. Accidental-cross-HOME protection, not a security boundary
// against a hostile same-user process.
const DAEMON_FILE = path.join(HOME, 'daemon.json')

function readDaemonIdentity() {
  try {
    return JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeDaemonIdentity({ pid, websocketUrl }) {
  writeJSONAtomic(DAEMON_FILE, {
    pid,
    profileDir: fs.realpathSync(PROFILE_DIR),
    port: Number(validateRunnerConfig().cdpPort),
    websocketUrl,
    at: Date.now(),
  })
}

async function verifyDaemonIdentity() {
  const version = await cdpVersion()
  const ident = readDaemonIdentity()
  const live = {
    profileDir: fs.realpathSync(PROFILE_DIR),
    port: Number(validateRunnerConfig().cdpPort),
    pid: listenerPid(validateRunnerConfig().cdpPort),
    websocketUrl: version?.webSocketDebuggerUrl,
  }
  const valid = (value) =>
    value && typeof value.profileDir === 'string' && value.profileDir.length > 0 &&
    Number.isSafeInteger(value.port) && value.port > 0 && value.port <= 65535 &&
    Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.websocketUrl === 'string' && value.websocketUrl.length > 0
  if (!valid(ident) || !valid(live)) {
    throw new Error("daemon identity is missing or unverifiable — quit any Chrome on this port and run a command to restart this HOME's daemon")
  }
  for (const key of ['profileDir', 'port', 'pid', 'websocketUrl']) {
    if (ident[key] !== live[key]) throw new Error('daemon identity mismatch: ' + key)
  }
  const endpoint = new URL(live.websocketUrl)
  if (
    endpoint.protocol !== 'ws:' ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
    Number(endpoint.port) !== live.port ||
    endpoint.username || endpoint.password ||
    !/^\/devtools\/browser\/[^/]+$/.test(endpoint.pathname) ||
    endpoint.search || endpoint.hash
  ) {
    throw new Error('unexpected browser WebSocket endpoint')
  }
  return live
}

// The WHOLE ensure/reuse decision is serialized, not just the spawn: a
// second process used to inspect a newly listening browser before the
// first had published its identity, and failed the verification spuriously.
// Identity publication stays inside the lock.
async function ensureBrowser(options = {}) {
  return withLock('daemon-startup', () => ensureBrowserLocked(options), { timeoutMs: 120000 })
}

async function ensureBrowserLocked(options = {}) {
  const version = await cdpVersion()
  if (version) {
    if (chromeIsHeadlessBin()) {
      throw new Error(
        'daemon is Chrome --headless (Cloudflare-blocked) — quit it and retry; CHATGPT_WEB_HEADLESS=1 hides a headed window'
      )
    }
    const identity = await verifyDaemonIdentity()
    if (wantHeadless() && !options.keepVisible) await hideDaemon()
    return identity
  }
  if (profileBusyArgv(PROFILE_DIR)) {
    throw new Error('chatgpt-web Chrome is open without remote debugging — quit it (Cmd+Q) and retry')
  }
  const bin = chromeBinary()
  if (!bin) throw new Error('no Chrome binary found — set CHATGPT_WEB_CHROME=/path/to/chrome')
  const args = [
    '--remote-debugging-port=' + validateRunnerConfig().cdpPort,
    '--user-data-dir=' + PROFILE_DIR,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]
  // Awaitable startup: a non-executable path rejects here, inside the
  // caller's control flow, instead of throwing from an event handler
  // nothing can catch.
  const child = await spawnStarted(bin, args, { detached: true, stdio: 'ignore' })
  child.unref()
  // Real Chrome launches foregrounded and paints before the debugging
  // port answers, so hidden mode re-asserts visibility on the spawned
  // pid from the first moment — the launch flash stays a blink instead
  // of stealing the operator's keyboard for the whole startup. Login
  // (keepVisible) opts out: its window must stay visible.
  const hideTimer = wantHeadless() && !options.keepVisible ? startHideLoop(child.pid) : null
  try {
    const deadline = Date.now() + 20000
    let version = null
    while (Date.now() < deadline && !version) {
      version = await cdpVersion()
      if (!version) {
        try {
          process.kill(child.pid, 0)
        } catch {
          throw new Error('chatgpt-web Chrome exited immediately after starting')
        }
        await sleep(300)
      }
    }
    if (!version) throw new Error('chatgpt-web Chrome started but the debugging port never came up')
    // Record identity only once the launched child provably owns the
    // listener; never adopt whatever happened to come up.
    if (listenerPid(validateRunnerConfig().cdpPort) !== child.pid) {
      throw new Error('another process took the debugging port during startup — retry')
    }
    writeDaemonIdentity({ pid: child.pid, websocketUrl: version.webSocketDebuggerUrl })
  } finally {
    if (hideTimer) clearInterval(hideTimer)
  }
  const identity = await verifyDaemonIdentity()
  if (wantHeadless() && !options.keepVisible) await hideDaemon()
  return identity
}

async function ensurePageTarget() {
  let tabs = []
  try {
    tabs = await (await fetch(cdpUrl() + '/json', { signal: AbortSignal.timeout(1500) })).json()
  } catch {
    return
  }
  if (Array.isArray(tabs) && tabs.some((t) => t.type === 'page')) return
  await fetch(cdpUrl() + '/json/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(2000) }).catch(() => {})
}

// withPage owns a command's tab. In hidden mode it also re-asserts daemon
// invisibility for the whole command: navigation can foreground the window
// mid-command (the old single hide ran before page.goto and lost), which
// stole focus and dropped the operator's keystrokes into Chrome. The loop
// shrinks any steal to the next tick. Login opts out — its window must be
// visible for the human.
//
// Visibility itself is lock-coordinated: ordinary pages hold a SHARED
// browser-visibility flock for their lifetime (they overlap freely), while
// login holds it EXCLUSIVELY for its whole run, so no other command's hide
// timer can fight the human's login window.
async function withPage(fn, { keepVisible = false } = {}) {
  return withLock(
    'browser-visibility',
    async () => {
      const identity = await ensureBrowser({ keepVisible })
      // Connect through the verified browser endpoint, not the mutable HTTP
      // port; the tab is created through this connection.
      const browser = await chromium.connectOverCDP(identity.websocketUrl, { noDefaults: true })
      let page = null
      let hideTimer = null
      try {
        const context = browser.contexts()[0]
        if (!context) throw new Error('no default context over CDP')
        if (wantHeadless() && !keepVisible) {
          hideTimer = startHideLoop(identity.pid)
        }
        page = await context.newPage()
        ownedPage = page
        return await fn(page)
      } finally {
        ownedPage = null
        if (hideTimer) clearInterval(hideTimer)
        if (page) await page.close().catch(() => {})
        await browser.close().catch(() => {})
        if (wantHeadless() && !keepVisible) await hideDaemon()
      }
    },
    { shared: !keepVisible }
  )
}

async function classifyPage(page, deadlineMs = 20000) {
  let outStreak = 0
  const deadline = Date.now() + deadlineMs
  for (;;) {
    const login = await page.locator(LOGIN_SEL).count().catch(() => 0)
    const comp = await page.locator(COMPOSER_SEL).count().catch(() => 0)
    if (login === 0 && comp > 0) return 'in'
    if (login > 0 && comp === 0) {
      outStreak++
      if (outStreak >= 6) return 'out'
    } else {
      outStreak = 0
    }
    if (Date.now() > deadline) return 'unknown'
    await sleep(jitter(500, 1000))
  }
}

// The Work interstitial ("Use Work") is ChatGPT suggesting a different
// surface on top of a failed turn. Standard-mode recovery is the failed
// turn's own Retry control; the CLI never clicks Use Work.
async function workGateState(page) {
  return page
    .evaluate(() => {
      const visible = (el) => el.offsetParent !== null
      const retry = document.querySelector('[data-testid="regenerate-thread-error-button"]')
      const work = Array.from(document.querySelectorAll('button, [role="button"]')).find(
        (b) => visible(b) && /^Use Work$/i.test((b.innerText || '').trim())
      )
      return { retry: !!(retry && visible(retry)), work: !!work }
    })
    .catch(() => ({ retry: false, work: false }))
}

async function waitForComposer(page) {
  const deadline = Date.now() + 45000
  for (;;) {
    const state = await classifyPage(page)
    if (state === 'in') {
      const gate = await workGateState(page)
      if (gate.work) {
        throw new Error(
          'conversation is gated by the ChatGPT Work prompt — standard-mode use is blocked for this thread; start a new chat (Work is never auto-clicked)'
        )
      }
      const el = await page.locator(COMPOSER_SEL).first()
      if ((await el.count().catch(() => 0)) > 0) return el
    }
    if (state === 'out' || page.url().includes('/auth/')) {
      throw new Error('not logged in — run: chatgpt-web login')
    }
    const body = await page.locator('body').innerText().catch(() => '')
    if (/verify you are human|unusual activity|access denied/i.test(body || '')) {
      throw new Error('bot check hit — retry, or run: chatgpt-web login')
    }
    if (Date.now() > deadline) {
      throw new Error('composer never appeared — retry, or run: chatgpt-web login')
    }
    await sleep(500)
  }
}

async function typePrompt(page, composer, text) {
  await composer.click({ force: true })
  const tag = await composer.evaluate((el) => el.tagName).catch(() => '')
  if (tag === 'TEXTAREA') {
    await composer.fill(text)
    return
  }
  await composer.evaluate((el) => {
    el.focus()
    const sel = window.getSelection()
    const range = document.createRange()
    range.selectNodeContents(el)
    sel.removeAllRanges()
    sel.addRange(range)
  })
  await page.keyboard.insertText(text)
}

// A fresh-chat view is empty by construction: no conversation route, no
// mounted transcript, and a readable composer. A preserved draft is
// tolerated: typePrompt replaces composer contents, and post-send
// verification compares the full prompt.
async function freshChatReady(page) {
  const conv = convIdOf(page.url())
  const mounted = await page.locator(MESSAGE_SEL).count().catch(() => 0)
  const composer = page.locator(COMPOSER_SEL).first()
  const ccount = (await composer.count().catch(() => 0)) > 0
  let text = null
  if (ccount) {
    text = await composer
      .evaluate((el) => (el.tagName === 'TEXTAREA' ? el.value : el.innerText))
      .catch(() => null)
  }
  const verdict = !conv && mounted === 0 && ccount && text !== null
  debugLog('freshChatReady', JSON.stringify({ conv, mounted, ccount, textLen: text === null ? null : text.length, verdict }))
  return verdict
}

async function ensureFreshChat(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(jitter(1500, 2500))
    if (await freshChatReady(page)) return
    const newChat = page.locator(NEW_CHAT_SEL).first()
    if ((await newChat.count().catch(() => 0)) === 0) continue
    await newChat.click({ force: true, timeout: 10000 }).catch(() => {})
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      if (await freshChatReady(page)) return
      await sleep(500)
    }
  }
  throw new Error(
    'ChatGPT resumed an existing conversation and a fresh chat could not be started — ' +
      'refusing to type into a conversation this job does not own'
  )
}

async function assertBoundConversation(page, job) {
  const want = convIdOf(job.url)
  if (!want) throw new Error('job url has no conversation id: ' + job.url)
  for (let attempt = 0; attempt < 2; attempt++) {
    await sleep(jitter(1500, 2500))
    if (convIdOf(page.url()) === want) return
    await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
  }
  throw new Error(`tab is not on the job's conversation (want ${want}, at ${page.url()}) — refusing to send`)
}

// sendPromptGuarded submits through one browser evaluation with no async
// gap: it re-validates the destination route, that the composer still holds
// exactly this prompt, the attachment set at the click boundary, and a
// unique visible enabled Send button — then clicks. The composer and button
// must be the UNIQUE visible match (querySelector/.first() could grab a
// hidden template element). The fallback Enter press is gone; the DOM
// priorIds collection is gone too — the acceptance baseline is the
// conversation API, taken in the caller before this runs. Unlike the
// API-only wait phases, drift here is FATAL: this is the mutation boundary.
export async function sendPromptGuarded(page, { boundUrl, prompt, files = [] }) {
  const bound = boundUrl ? conversationUrl(boundUrl) : null
  const route = bound ? conversationId(bound) : null
  const expected = [...(files || [])].map((f) => path.basename(f)).sort()
  const result = await page
    .evaluate(
      ({ wantConv, promptText, selectors, expected }) => {
        if (location.origin !== 'https://chatgpt.com') return { error: 'unexpected origin' }
        const current = location.pathname.match(/^\/c\/([0-9a-fA-F-]{8,})\/?$/)
        if (wantConv) {
          if (!current || current[1] !== wantConv) return { error: 'conversation changed before submission' }
        } else if (location.pathname !== '/' || document.querySelectorAll(selectors.messages).length !== 0) {
          return { error: 'fresh-chat destination changed before submission' }
        }
        const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
        const composers = [...document.querySelectorAll(selectors.composer)].filter(visible)
        if (composers.length !== 1) {
          return {
            error: composers.length === 0 ? 'composer disappeared before submission' : 'multiple composers visible before submission',
          }
        }
        const composer = composers[0]
        const text = composer.tagName === 'TEXTAREA' ? composer.value : composer.innerText
        // Exact authored text, line endings normalized only. Broad
        // whitespace flattening used to accept a different prompt; a
        // rendering-level divergence is a real refusal.
        const actual = String(text).replace(/\r\n/g, '\n')
        if (actual !== promptText) return { error: 'composer changed before submission', saw: actual.slice(0, 90) }
        // Attachment evidence at the click boundary (same evaluation — no
        // time-of-check/time-of-use gap). The ComposerLayoutAttachments
        // slot with zero children is the structural empty-state sentinel
        // (fixture 2026-10-06); a populated slot or legacy chips must be
        // exactly the requested multiset.
        const scope = composer.closest('form') || composer.parentElement?.parentElement || composer.parentElement
        if (!scope) return { error: 'composer scope unrecognized before submission' }
        const container = scope.querySelector(selectors.attachContainer)
        let names = null
        if (container) {
          if (container.childElementCount === 0) {
            names = []
          } else {
            names = [...container.children].map((card) => {
              const chip = card.matches(selectors.chips) ? card : card.querySelector(selectors.chips)
              return ((chip ? chip.innerText : card.innerText) || '').trim().split('\n')[0]?.trim() || null
            })
            if (names.includes(null)) return { error: 'attachment present without a readable name; refusing submission' }
          }
        } else {
          const chips = Array.from(scope.querySelectorAll(selectors.chips)).filter(
            (el) => el.closest('[data-message-author-role]') === null
          )
          names = []
          for (const chip of chips) {
            const name = (chip.innerText || '').trim().split('\n')[0]?.trim() || ''
            if (!name) return { error: 'attachment present without a readable name; refusing submission' }
            names.push(name)
          }
        }
        const got = [...names].sort()
        if (got.length !== expected.length || got.some((n, i) => n !== expected[i])) {
          return {
            error: expected.length ? 'attachment set changed before submission' : 'unexpected attachments present before submission',
            saw: got,
          }
        }
        const buttons = [...document.querySelectorAll(selectors.submit)].filter(visible)
        if (buttons.length !== 1) {
          return {
            error: buttons.length === 0 ? 'send button is missing' : 'multiple send buttons visible before submission',
          }
        }
        const button = buttons[0]
        if (button.disabled || button.getAttribute('aria-disabled') === 'true') {
          return { error: 'send button is disabled' }
        }
        button.click()
        return { ok: true }
      },
      {
        wantConv: route,
        promptText: canonicalPrompt(prompt),
        selectors: {
          composer: COMPOSER_SEL,
          submit: SUBMIT_SEL,
          messages: MESSAGE_SEL,
          chips: ATTACH_CHIP_SEL,
          attachContainer: ATTACH_CONTAINER_SEL,
        },
        expected,
      }
    )
    .catch((e) => ({ error: e.message }))
  if (!result?.ok) {
    const detail = result?.saw ? ` (held: ${JSON.stringify(result.saw)})` : ''
    throw new Error('submission guard: ' + (result?.error || 'unknown result') + detail)
  }
}

// fetchConversationMessages reads the conversation through the page's
// authenticated API and returns a conversationSnapshot: ordered branch with
// channel/end_turn info, plus allUserIds for acceptance baselines. This is
// the API-first source of truth (the DOM renders markdown and, since the
// 2026-10 UI, no message ids at all).
async function fetchConversationMessages(page, cid, timeoutMs = 15000) {
  const id = conversationId(cid)
  const response = await getBackendJSON(page, '/backend-api/conversation/' + id, timeoutMs)
  if (!response.ok) {
    const error = new AuditError('CONVERSATION_HTTP', `conversation GET failed (${response.status}): ${response.error}`)
    error.httpStatus = response.status
    throw error
  }
  return conversationSnapshot(response.data)
}

// rebindIfDrifted restores the bound conversation during the API-only wait
// phases. The backend GET needs only the chatgpt.com ORIGIN (cookies +
// bearer), but the daemon Chrome is a visible window the operator shares:
// navigating this tab mid-wait used to fail the whole turn
// (CONVERSATION_DRIFT) even though polling would have completed fine from
// any chatgpt.com page. Re-binding is bounded — persistent drift stays
// fatal. The MUTATION boundary (typing/clicking) keeps its strict route
// guards in sendPromptGuarded/assertBoundConversation; only the read-only
// phases re-bind.
async function rebindIfDrifted(page, boundUrl, { attempts = 3 } = {}) {
  let pageUrl = null
  try {
    pageUrl = conversationUrl(page.url())
  } catch {
    pageUrl = null
  }
  if (pageUrl === boundUrl) return
  for (let attempt = 0; attempt < attempts; attempt++) {
    await page.goto(boundUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => null)
    try {
      if (conversationUrl(page.url()) === boundUrl) return
    } catch {}
    await sleep(jitter(800, 1500))
  }
  throw new AuditError(
    'CONVERSATION_DRIFT',
    'page left the bound conversation and re-binding failed (at ' + page.url() + ')'
  )
}

// waitForAcceptedPrompt proves the submission landed: a NEW user message
// (id outside the API baseline captured before the click) whose authored
// text is exactly the prompt. Transient poll errors (status 0, 408/429,
// 5xx, 404) retry to the deadline with backoff — a poll is read-only and a
// single hiccup must not kill an in-flight turn; auth-class errors stay
// fatal. Operator navigation of the shared daemon tab is survived by
// re-binding (rebindIfDrifted).
export async function waitForAcceptedPrompt(page, prompt, priorIds, boundUrl, deadlineMs) {
  const url = conversationUrl(boundUrl)
  const cid = conversationId(url)
  const baseline = priorIds instanceof Set ? priorIds : new Set(priorIds || [])
  const deadline = Date.now() + deadlineMs
  let lastError = null
  let transient = 0
  while (Date.now() < deadline) {
    await rebindIfDrifted(page, url)
    try {
      const snapshot = await fetchConversationMessages(page, cid, Math.min(15000, Math.max(1, deadline - Date.now())))
      transient = 0
      const hit = findAcceptedUser(snapshot, { priorUserIds: baseline, prompt })
      if (hit) return hit.id
    } catch (e) {
      if (!retriablePollError(e.httpStatus)) throw e
      lastError = e
      transient++
      await sleep(Math.min(pollBackoffMs(transient, pollDelayMs('accept')), Math.max(0, deadline - Date.now())))
      continue
    }
    await sleep(Math.min(pollDelayMs('accept'), Math.max(0, deadline - Date.now())))
  }
  throw new AuditError(
    'ACCEPTANCE_UNKNOWN',
    'submission may have reached ChatGPT but was not uniquely observed; inspect ' + url +
      ' before sending again' + (lastError ? ' (' + lastError.message + ')' : '')
  )
}

// waitForReply tracks the answer through the conversation API: the last
// user-facing assistant message after the accepted user message, complete
// only on finished_successfully + end_turn (a "finished" intermediate
// message without end_turn is not the answer; there is no text-silence
// fallback). excludedAssistantIds keeps a retry from "completing" by
// re-reading a pre-existing answer. Transient poll errors retry to the
// deadline with backoff; drift re-binds (both as in waitForAcceptedPrompt).
export async function waitForReply(page, acceptedUserId, boundUrl, onPartial, excludedAssistantIds = new Set()) {
  const url = conversationUrl(boundUrl)
  const cid = conversationId(url)
  const deadline = Date.now() + validateRunnerConfig().turnTimeoutMs
  let previous = ''
  let lastError = null
  let transient = 0
  while (Date.now() < deadline) {
    assertRunnerLive()
    await rebindIfDrifted(page, url)
    try {
      const snapshot = await fetchConversationMessages(page, cid, Math.min(15000, Math.max(1, deadline - Date.now())))
      transient = 0
      const result = inspectReply(snapshot, acceptedUserId)
      if (!excludedAssistantIds.has(result.messageId)) {
        if (result.text !== previous) {
          previous = result.text
          if (onPartial) await onPartial(result.text)
        }
        if (result.state === 'done') return result
      }
    } catch (e) {
      if (!retriablePollError(e.httpStatus)) throw e
      lastError = e
      transient++
      await sleep(Math.min(pollBackoffMs(transient, pollDelayMs('reply')), Math.max(0, deadline - Date.now())))
      continue
    }
    await sleep(Math.min(pollDelayMs('reply'), Math.max(0, deadline - Date.now())))
  }
  throw new AuditError(
    'REPLY_TIMEOUT',
    'no verified terminal answer before the reply deadline (' +
      validateRunnerConfig().turnTimeoutMs / 1000 + 's; raise CHATGPT_WEB_TIMEOUT)' +
      (lastError ? ': ' + lastError.message : '')
  )
}

// readComposerAttachments is the DOM adapter over the composer's
// attachment slot. Live fixture (2026-10-06, main-chat surface): the
// composer's FORM scope contains a `ComposerLayoutAttachments-*` container
// with ZERO element children when no attachments exist — a structural
// empty-state sentinel (verified empty, not "zero selector matches").
// A populated slot (or legacy chips in scope) reports cards with an
// explicit 'unknown' state: state is NEVER guessed from visible text (a
// file named "failed.log" is a name, not a verdict), duplicate basenames
// are kept, and attachmentVerdict refuses what cannot be proven.
async function readComposerAttachments(page) {
  return page
    .evaluate(
      ({ composerSel, selectors }) => {
        const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
        const composers = [...document.querySelectorAll(composerSel)].filter(visible)
        if (composers.length !== 1) return { known: false }
        const composer = composers[0]
        const scope = composer.closest('form') || composer.parentElement?.parentElement || composer.parentElement
        if (!scope) return { known: false }
        const container = scope.querySelector(selectors.attachContainer)
        if (container) {
          if (container.childElementCount === 0) return { known: true, files: [] }
          // Cards exist; report their readable names with unknown state.
          const names = [...container.children].map((card) => {
            const chip = card.matches(selectors.chips) ? card : card.querySelector(selectors.chips)
            return ((chip ? chip.innerText : card.innerText) || '').trim().split('\n')[0]?.trim() || null
          })
          return { known: true, files: names.map((name) => ({ name, state: 'unknown' })) }
        }
        // No sentinel on this layout: fall back to candidate chips in the
        // composer scope (presence is evidence; emptiness here is only
        // "no chips matched", the documented residual).
        const chips = Array.from(scope.querySelectorAll(selectors.chips)).filter(
          (el) => el.closest('[data-message-author-role]') === null
        )
        const names = chips.map((chip) => (chip.innerText || '').trim().split('\n')[0]?.trim() || null)
        return { known: true, files: names.map((name) => ({ name, state: 'unknown' })) }
      },
      {
        composerSel: COMPOSER_SEL,
        selectors: { chips: ATTACH_CHIP_SEL, attachContainer: ATTACH_CONTAINER_SEL },
      }
    )
    .catch(() => ({ known: false }))
}

async function attachmentsReady(page, names) {
  return attachmentVerdict(await readComposerAttachments(page), names)
}

// Polls the composer until the exact requested file set is present and every
// upload has finished. "Still in progress" and not-yet-rendered chips are
// transient; a failed upload never recovers, so it fails fast.
async function waitForAttachments(page, names, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastError = 'attachment UI unrecognized; refusing submission'
  while (Date.now() < deadline) {
    const verdict = await attachmentsReady(page, names)
    if (verdict && verdict.ok) return
    if (verdict && verdict.error) {
      if (/attachment upload failed/.test(verdict.error)) throw new Error(verdict.error)
      lastError = verdict.error
    }
    await sleep(jitter(600, 1300))
  }
  throw new Error(
    `attachments not ready after ${timeoutMs}ms: ${lastError}` +
      (/state unrecognized/.test(lastError)
        ? ' — the attachment card markup has no verified state profile on this UI (UPLOAD_UNSUPPORTED_UI until remapped)'
        : '')
  )
}

// Chooser-opening retries are separated from upload completion: once files
// are selected, a readiness timeout is NOT permission to pick them again
// (re-selecting creates duplicate attachments). The wait runs once.
async function uploadFiles(page, paths) {
  const checked = validateUploads(paths)
  const names = checked.map((p) => path.basename(p))
  let chooser = null
  let lastError = null
  for (let attempt = 0; attempt < 3 && !chooser; attempt++) {
    try {
      // Open the menu first; only wait for the chooser once its trigger is
      // being clicked. The popover sometimes fails to open or renders
      // without the upload option — a failed attempt retries with a fresh
      // plus-click.
      await page.locator('[data-testid="composer-plus-btn"]').click({ timeout: 30000, force: true })
      const upload = page.getByText(/upload from computer/i).first()
      await upload.waitFor({ state: 'visible', timeout: 15000 })
      const fcP = page.waitForEvent('filechooser', { timeout: 12000 })
      fcP.catch(() => {})
      try {
        await upload.click({ timeout: 15000, force: true })
        chooser = await fcP
      } catch (e) {
        lastError = e
        await fcP.catch(() => {})
      }
    } catch (e) {
      lastError = e
    }
    if (!chooser) await sleep(jitter(1500, 3000))
  }
  if (!chooser) throw lastError || new Error('file chooser did not open')
  await chooser.setFiles(checked)
  await waitForAttachments(page, names, 45000)
}

// The submit button stays disabled while ChatGPT ingests an attached
// document. That is a waitable condition, not a failure: poll until a
// unique visible button is enabled so the fail-closed submission guard sees
// a submittable composer instead of racing file processing.
async function waitForSubmitEnabled(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const enabled = await page
      .evaluate((sel) => {
        const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
        const buttons = [...document.querySelectorAll(sel)].filter(visible)
        return buttons.length === 1 && !buttons[0].disabled && buttons[0].getAttribute('aria-disabled') !== 'true'
      }, SUBMIT_SEL)
      .catch(() => false)
    if (enabled) return
    await sleep(jitter(800, 1500))
  }
  throw new Error(`submit button still disabled after ${timeoutMs}ms (file still processing?)`)
}

// The 2026-10 web UI renders transcripts without data-message-author-role
// or data-message-id, so DOM reply tracking is dead — waitForReply (above)
// polls the conversation API.

// runResume retries a failed assistant turn in standard ChatGPT: it clicks
// the conversation's own Retry control (regenerate-thread-error-button) and
// waits for the regenerated reply. It never clicks "Use Work". Ownership is
// authorized BEFORE the click, from the stored accepted user id and the
// live branch — never from "the text matches some history entry".
export async function runResume(jobId, turnId) {
  const job = await turns.claim(jobId, turnId, process.pid)
  if (!job) {
    console.error(`turn ${turnId} of job ${jobId} is not admissible (stale, duplicate or terminal) — worker exiting`)
    process.exitCode = 1
    return
  }
  const tid = job.turnId
  const fail = async (msg) => {
    await turns.update(jobId, tid, (j) => {
      j.status = 'error'
      j.error = msg
    })
    notify('chatgpt-web: error', msg)
  }
  try {
    validateRunnerConfig()
    await ensureBrowser()
    await withPage(async (page) => {
      await page.goto(job.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await sleep(jitter(4000, 7000))
      const gate = await workGateState(page)
      if (gate.work) {
        throw new Error(
          'conversation is gated by the ChatGPT Work prompt — the backend insists on Work mode for this thread and standard-mode retry is inert; start a new chat (Work is never auto-clicked)'
        )
      }
      // Refuse before changing the remote conversation when this surface
      // has no verified retry control.
      const retry = page.locator('[data-testid="regenerate-thread-error-button"]').first()
      if ((await retry.count().catch(() => 0)) === 0) {
        throw new AuditError(
          'RESUME_UNSUPPORTED_UI',
          'no verified Retry control on this surface (the 2026-10 UI has no mapped retry adapter) — resume is unsupported until remapped'
        )
      }
      // Authorization before the click: the retry target must be this
      // record's stored accepted user id, live on the branch's tip, with
      // the exact turn prompt.
      const target = job.resumeTargetUserId
      if (!target) {
        throw new AuditError(
          'RESUME_TARGET_UNKNOWN',
          'this record has no verified accepted user ID; reconcile manually, do not click Retry'
        )
      }
      const before = await fetchConversationMessages(page, convIdOf(conversationUrl(job.url)))
      const branchUsers = before.branch.filter((m) => m.role === 'user')
      const latestUser = branchUsers.length ? branchUsers[branchUsers.length - 1] : null
      if (!latestUser || latestUser.id !== target || !samePrompt(latestUser.text, job.prompt)) {
        throw new AuditError('RESUME_NOT_OWNED', "the retry target is not this job's accepted prompt")
      }
      // The exclusion set: an existing answer must not "complete" the retry.
      const previousAssistantIds = new Set(
        before.branch.filter((m) => m.role === 'assistant').map((m) => m.id)
      )
      await withLock('send', async () => {
        const s = await updateState((st) => st)
        const L = limits()
        const since = Date.now() - (s.lastSendAt || s.lastTurnEnd || 0)
        const gap = L.minGapMs + Math.random() * 8000
        if (since < gap) await sleep(gap - since)
        assertOwnedBeforeMutation(jobId, tid)
        await retry.click({ force: true, timeout: 10000 })
        await updateState((st) => {
          st.lastSendAt = Date.now()
        })
      })
      await ownedUpdate(jobId, tid, (j) => {
        j.acceptedUserId = target
        j.submissionState = 'accepted'
      })
      let lastPartial = 0
      const result = await waitForReply(
        page,
        target,
        job.url,
        async (partial) => {
          if (Date.now() - lastPartial < 2000) return
          lastPartial = Date.now()
          await ownedUpdate(jobId, tid, (j) => {
            j.status = 'streaming'
            j.reply = partial
          })
        },
        previousAssistantIds
      )
      const finalSnapshot = await fetchConversationMessages(page, convIdOf(conversationUrl(job.url)))
      const verified = inspectReply(finalSnapshot, target)
      if (verified.state !== 'done' || verified.messageId !== result.messageId || verified.text !== result.text) {
        throw new AuditError('FINAL_CHANGED', 'final answer changed during verification')
      }
      await ownedUpdate(jobId, tid, (j) => {
        j.status = 'done'
        j.reply = result.text
        j.replyKind = result.nonText ? 'non-text' : 'text'
        j.replyContent = result.content ?? null
        j.assistantMessageId = result.messageId
        j.submissionState = 'completed'
        j.error = null
        j.history.push({ role: 'assistant', text: result.text, messageId: result.messageId })
      })
      notify('chatgpt-web: done', 'resume completed')
    })
  } catch (e) {
    await fail(String(e.message || e))
    process.exitCode = 1
  }
}

function notify(title, body) {  if (process.env.CHATGPT_WEB_NOTIFY === '0') return
  try {
    execSync(
      `osascript -e 'display notification "${String(body).replace(/["']/g, '').slice(0, 90)}" with title "${title}"'`,
      { stdio: 'ignore', timeout: 5000 }
    )
  } catch {}
}

export async function runTurn(jobId, turnId) {
  // Claim the admitted generation before any browser work. A worker whose
  // generation was superseded (or never existed) must not send.
  const job = await turns.claim(jobId, turnId, process.pid)
  if (!job) {
    console.error(`turn ${turnId} of job ${jobId} is not admissible (stale, duplicate or terminal) — worker exiting`)
    process.exitCode = 1
    return
  }
  const tid = job.turnId
  const fail = async (msg) => {
    // Failure reporting stays a plain (conditional) update: a stale worker
    // must still be able to file its own failure without owning the record.
    await turns.update(jobId, tid, (j) => {
      j.status = 'error'
      j.error = msg
    })
    notify('chatgpt-web: error', msg)
  }
  try {
    validateRunnerConfig()
    await ensureBrowser()
    await withPage(async (page) => {
      await page.goto(job.url || CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await waitForComposer(page)

      let boundUrl = job.url || null
      let acceptedUserId = null
      let priorUserIds = new Set()

      await withLock('send', async () => {
        const s = await updateState((st) => st)
        const L = limits()
        const since = Date.now() - (s.lastSendAt || s.lastTurnEnd || 0)
        const gap = L.minGapMs + Math.random() * 8000
        if (since < gap) await sleep(gap - since)
        await sleep(jitter(1500, 4000))

        const composer = await waitForComposer(page)
        if (job.url) {
          await assertBoundConversation(page, job)
        } else {
          await ensureFreshChat(page)
        }
        // Attachment state is checked even with no files: a leftover
        // attachment from a draft would silently ride along.
        if (job.files && job.files.length) {
          await uploadFiles(page, job.files)
        } else {
          const ready = await attachmentsReady(page, [])
          if (ready.error) throw new Error('unexpected attachments present: ' + ready.error)
        }

        // The upload's menus are when an SPA redirect can land; re-authorise
        // the destination before typing.
        if (job.url) {
          await assertBoundConversation(page, job)
        } else if (convIdOf(page.url())) {
          throw new Error('the tab left the fresh chat during preparation — refusing to type into ' + page.url())
        }

        // API acceptance baseline for an existing conversation: every user
        // message id present BEFORE the click. The acceptance check matches
        // a NEW id against authored text — the DOM-id baseline was always
        // empty on the 2026-10 UI, so a repeated verbatim prompt could be
        // "accepted" by an older identical message.
        priorUserIds = job.url
          ? (await fetchConversationMessages(page, convIdOf(conversationUrl(job.url)))).allUserIds
          : new Set()
        await ownedUpdate(jobId, tid, (j) => {
          j.priorUserIds = [...priorUserIds]
          j.submissionState = 'prepared'
        })

        // The 2026-10 UI syncs a server-side draft into the composer that
        // can land AFTER typing and clobber the prompt. Retyping is
        // permitted only for a PRE-CLICK composer mismatch reported by the
        // guard; a transport/evaluation error after a possible click is a
        // terminal ACCEPTANCE_UNKNOWN, never permission to click again.
        await ownedUpdate(jobId, tid, (j) => {
          j.submissionState = 'dispatching'
        })
        let submitErr = null
        for (let attempt = 0; attempt < 3; attempt++) {
          assertOwnedBeforeMutation(jobId, tid)
          await typePrompt(page, composer, job.prompt)
          await sleep(attempt === 0 ? 900 : jitter(1400, 2600))
          if (job.files && job.files.length) await waitForSubmitEnabled(page, 150000)
          try {
            await sendPromptGuarded(page, { boundUrl: job.url, prompt: job.prompt, files: job.files || [] })
            submitErr = null
            break
          } catch (e) {
            submitErr = e
            if (!/composer changed/.test(String(e.message))) throw e
          }
        }
        if (submitErr) throw submitErr
        await updateState((st) => {
          st.lastSendAt = Date.now()
        })
        await ownedUpdate(jobId, tid, (j) => {
          j.submissionState = 'dispatched'
        })
      })

      if (!boundUrl) {
        // The conversation url is persisted as soon as it exists, scoped to
        // this generation.
        const deadline = Date.now() + 60000
        while (Date.now() < deadline) {
          const id = convIdOf(page.url())
          if (id) {
            boundUrl = page.url()
            await ownedUpdate(jobId, tid, (j) => {
              j.url = boundUrl
            })
            break
          }
          await sleep(500)
        }
        if (!boundUrl) throw new Error('conversation url never appeared after send (no /c/<id>)')
      }

      // The accepted user message is the identity every later check hangs
      // on: partial publication, the final reply, and their association.
      acceptedUserId = await waitForAcceptedPrompt(page, job.prompt, priorUserIds, boundUrl, 60000)
      await ownedUpdate(jobId, tid, (j) => {
        j.acceptedUserId = acceptedUserId
        j.submissionState = 'accepted'
      })

      let lastPartial = 0
      const result = await waitForReply(page, acceptedUserId, boundUrl, async (partial) => {
        if (Date.now() - lastPartial < 2000) return
        lastPartial = Date.now()
        await ownedUpdate(jobId, tid, (j) => {
          j.status = 'streaming'
          j.reply = partial
        })
      })

      // Final verification against a fresh snapshot: the answer this turn
      // publishes is the answer that is on the record.
      const finalSnapshot = await fetchConversationMessages(page, convIdOf(conversationUrl(boundUrl)))
      const verified = inspectReply(finalSnapshot, acceptedUserId)
      if (verified.state !== 'done' || verified.messageId !== result.messageId || verified.text !== result.text) {
        throw new AuditError('FINAL_CHANGED', 'final answer changed during verification')
      }

      await ownedUpdate(jobId, tid, (j) => {
        j.status = 'done'
        j.reply = result.text
        j.replyKind = result.nonText ? 'non-text' : 'text'
        j.replyContent = result.content ?? null
        j.assistantMessageId = result.messageId
        j.submissionState = 'completed'
        j.error = null
        j.history.push({ role: 'assistant', text: result.text, messageId: result.messageId })
      })
      notify('chatgpt-web: done', result.text.slice(0, 90))
    })
  } catch (e) {
    let msg = String(e && e.message ? e.message : e)
    if (/singleton/i.test(msg)) msg = 'profile is in use — quit the chatgpt-web Chrome window first'
    await fail(msg)
    process.exitCode = 1
  } finally {
    await updateState((st) => {
      st.lastTurnEnd = Date.now()
    })
  }
}

export async function runLogin() {
  // The unhide runs INSIDE the withPage callback, after its browser ensure —
  // an outer call raced withPage's own ensureBrowser hide sweeps (and any
  // concurrent command's), fighting the login window. withPage also holds
  // the browser-visibility lock exclusively for the whole login, so no
  // other command's hide timer can intervene.
  await withPage(
    async (page) => {
      setDaemonVisible(true)
      console.error('Chrome is open for login; waiting up to five minutes')
      await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const deadline = Date.now() + 300000
      while (Date.now() < deadline) {
        if ((await classifyPage(page)) === 'in') return
        await sleep(1500)
      }
      throw new Error('timed out waiting for login')
    },
    { keepVisible: true }
  )
  console.error('verified: logged in')
}

export async function runChats(opts = {}) {
  const deleteIds = opts.deleteIds || null
  const deleteAll = !!opts.deleteAll
  await withPage(async (page) => {
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const state = await classifyPage(page)
    if (state !== 'in') {
      console.error(state === 'out' ? 'not logged in — run: chatgpt-web login' : 'session unknown — run: chatgpt-web login')
      process.exitCode = 1
      return
    }
    // The listing is driven page-by-page from the Node side: every in-page
    // fetch is abort-bounded and every evaluate is wall-clock bounded (a
    // wedged fetch must never suspend this command forever), while the
    // pagination/completeness contract itself lives in audit-core's
    // collectConversationListing.
    const result = await collectConversationListing(async (offset) => {
      const res = await evaluateBounded(
        page,
        async ({ path, timeoutMs }) => {
          try {
            const session = await (
              await fetch('/api/auth/session', {
                credentials: 'include',
                signal: AbortSignal.timeout(timeoutMs),
              })
            ).json()
            const token = session && session.accessToken
            if (!token) return { error: 'no session token' }
            const r = await fetch(path, {
              credentials: 'include',
              headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
              signal: AbortSignal.timeout(timeoutMs),
            })
            if (!r.ok) return { error: 'conversations http ' + r.status }
            const j = await r.json()
            return { items: Array.isArray(j && j.items) ? j.items : [] }
          } catch (e) {
            return { error: String((e && e.message) || e) }
          }
        },
        { path: `/backend-api/conversations?offset=${offset}&limit=50&order=updated`, timeoutMs: 20000 },
        30000,
        'chats listing page'
      )
      return res && res.error ? { error: res.error } : { items: (res && res.items) || [] }
    })
    // Honesty before any empty-list shortcut: an error with zero rows is a
    // failure, not "no chats found".
    const outcome = chatListingOutcome(result)
    if (outcome.error) {
      console.error('chats listing failed: ' + outcome.error + (outcome.items.length ? ` (showing ${outcome.items.length} fetched before the failure as a partial result)` : ''))
      process.exitCode = 1
      if (!outcome.items.length) return
    }
    if (!outcome.items.length) {
      console.log('no chats found')
      return
    }
    if (deleteIds || deleteAll) {
      // Destructive deletes need a complete frozen inventory: refuse on any
      // listing error or cap, on unknown ids, and on conversations with
      // running turns — never delete a partial set after reporting an
      // inventory error.
      const activeIds = runningJobs().map((j) => convIdOf(j.url)).filter(Boolean)
      const plan = planDeletion({
        items: outcome.items,
        listingError: outcome.error,
        hitCap: !!result.hitCap,
        deleteIds,
        deleteAll,
        confirmed: opts.yes === true,
        activeIds,
      })
      if (plan.error) {
        console.error('refusing to delete: ' + plan.error)
        process.exitCode = 1
        return
      }
      if (!plan.targets.length) {
        console.log(plan.note || 'nothing to delete')
        return
      }
      console.log(`deleting ${plan.targets.length} conversation(s)…`)
      // Targets are frozen; the active-turn revalidation and the PATCHes
      // run under the same store lock admissions use, so no turn can be
      // admitted against a conversation being deleted. Every fetch inside
      // the loop is abort-bounded and the whole evaluation is wall-clock
      // bounded: one wedged PATCH must not hold the store flock (and thereby
      // block every admission/worker update CLI-wide) for more than one
      // transport timeout. A network-level failure stops the loop — hammering
      // the remaining ids on a dead transport cannot succeed.
      let del = null
      await withStoreLock(async () => {
        const live = runningJobs().map((j) => convIdOf(j.url)).filter(Boolean)
        const clash = plan.targets.filter((id) => live.includes(id))
        if (clash.length) {
          throw new Error('refusing to delete conversations with running turns: ' + clash.join(', '))
        }
        // Soft-delete via the same endpoint the sidebar uses:
        // is_visible=false hides the thread from the sidebar. Recovery
        // terms are the service's to define — check its UI.
        del = await evaluateBounded(
          page,
          async ({ ids, timeoutMs }) => {
            try {
              const session = await (
                await fetch('/api/auth/session', {
                  credentials: 'include',
                  signal: AbortSignal.timeout(timeoutMs),
                })
              ).json()
              const token = session && session.accessToken
              if (!token) return { error: 'no session token' }
              const headers = {
                Authorization: 'Bearer ' + token,
                Accept: 'application/json',
                'Content-Type': 'application/json',
              }
              const results = []
              for (const id of ids) {
                try {
                  const r = await fetch('/backend-api/conversation/' + id, {
                    method: 'PATCH',
                    credentials: 'include',
                    headers,
                    body: JSON.stringify({ is_visible: false }),
                    signal: AbortSignal.timeout(timeoutMs),
                  })
                  results.push({ id, ok: r.ok, http: r.status })
                } catch (e) {
                  const reason = String((e && e.message) || e)
                  results.push({ id, ok: false, http: 0, error: reason })
                  return { results, error: 'network failure at ' + id + ': ' + reason }
                }
                await new Promise((res) => setTimeout(res, 400))
              }
              return { results }
            } catch (e) {
              return { error: String((e && e.message) || e) }
            }
          },
          { ids: plan.targets, timeoutMs: 20000 },
          Math.max(60000, plan.targets.length * 25000),
          'chats delete'
        )
      })
      if (del.error) {
        console.error('delete failed: ' + del.error)
        process.exitCode = 1
        if (!del.results) return
      }
      const ok = del.results.filter((r) => r.ok).length
      for (const r of del.results) {
        if (!r.ok) console.error('delete failed: ' + r.id + ' http ' + r.http)
      }
      console.log(
        `deleted ${ok}/${del.results.length} chats (hidden from the sidebar — check the service UI, e.g. Settings > Deleted chats, for available recovery)`
      )
      if (ok < del.results.length) process.exitCode = 1
      return
    }
    const idW = 36
    console.log(['ID'.padEnd(idW), 'STATUS'.padEnd(10), 'UPDATED'.padEnd(20), 'TITLE'].join(' '))
    for (const it of outcome.items) {
      const id = String(it.id || '')
      const status = it.async_status || 'idle'
      const updated = String(it.update_time || '').replace('T', ' ').slice(0, 16)
      const title = String(it.title || '').replace(/\s+/g, ' ').slice(0, 60)
      console.log([id.padEnd(idW), String(status).padEnd(10), updated.padEnd(20), title].join(' '))
    }
    if (outcome.error) process.exitCode = 1
    if (result.hitCap) console.error('listing capped at 200 conversations — older chats are not shown')
  })
}

const ICON_SEL = '[data-testid="library-file-icon"]'
const CAPTURE_DEADLINE_MS = 5 * 60 * 1000

async function assertChatUrl(page, chatId) {
  await sleep(3000)
  if (convIdOf(page.url()) !== chatId) {
    throw new Error(`left the requested conversation (at ${page.url()}) — refusing to capture from it`)
  }
}

async function captureChatFiles(page, chatId) {
  const url = CHAT_URL + 'c/' + chatId
  const deadline = Date.now() + CAPTURE_DEADLINE_MS
  const out = []
  for (let i = 0; ; i++) {
    if (Date.now() > deadline) throw new Error('file capture exceeded its deadline')
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await assertChatUrl(page, chatId)
    await sleep(6000)
    const icons = await page.locator(ICON_SEL).count().catch(() => 0)
    if (icons === 0) {
      if (i === 0) throw new Error('no file cards in this conversation')
      break
    }
    if (i >= icons) break

    const estuaryP = page.waitForResponse((r) => /estuary\/content/.test(r.url()), { timeout: 8000 }).catch(() => null)
    const simpleP = page.waitForResponse((r) => /\/files\/.+\/simple/.test(r.url()), { timeout: 8000 }).catch(() => null)
    await page.locator(ICON_SEL).nth(i).click()
    let resp = await estuaryP
    let simple = null
    if (!resp) resp = simple = await simpleP
    if (!resp) {
      out.push({ index: i, ok: false, reason: 'no file response for this card' })
      continue
    }
    if (!resp.ok()) {
      out.push({ index: i, ok: false, reason: 'http ' + resp.status() })
      continue
    }
    const u = new URL(resp.url())
    let id = u.searchParams.get('id') || ''
    let name = u.searchParams.get('fn') || ''
    if (!id && simple) {
      id = simple.url().split('/files/')[1].split('/')[0]
      try {
        const j = JSON.parse((await simple.body()).toString('utf8'))
        name = j.file_name || name
      } catch {}
    }
    if (!id) {
      out.push({ index: i, ok: false, reason: 'no file id' })
      continue
    }
    const existing = out.find((f) => f.ok && f.file && f.file.id === id)
    if (existing) {
      out.push({ index: i, ok: true, file: existing.file, duplicateOf: existing.index })
      continue
    }
    let bytes = null
    try {
      bytes = await fileBytes(page, resp, { kind: simple ? 'descriptor' : 'artifact' })
    } catch (e) {
      out.push({ index: i, ok: false, reason: e.message })
      continue
    }
    out.push({ index: i, ok: true, file: { id, name: name || id + '.bin', bytes } })
  }
  return out
}

// Bounded transfers: an intercepted artifact body rejects an excessive
// declared Content-Length before allocation (a chunked/no-length body
// cannot be pre-bounded — the streaming path below covers re-fetches); a
// descriptor download goes through boundedBrowserDownload (exact origins,
// no redirects, hard byte cap, compact base64 transfer instead of a
// per-byte numeric array).
async function fileBytes(page, resp, { kind = 'artifact' } = {}) {
  if (kind === 'artifact') {
    const declared = Number(resp.headers()['content-length']) || 0
    if (declared > ARTIFACT_MAX_BYTES) {
      throw new Error(`artifact exceeds the transfer cap (${declared} > ${ARTIFACT_MAX_BYTES} bytes)`)
    }
    return Buffer.from(await resp.body()) // JSON is valid file content, too.
  }
  if (kind !== 'descriptor') throw new Error('unknown file response kind')
  let descriptor
  try {
    descriptor = JSON.parse((await resp.body()).toString('utf8'))
  } catch {
    throw new Error('file descriptor is not valid JSON')
  }
  if (typeof descriptor?.download_url !== 'string' || !descriptor.download_url) {
    throw new Error('file descriptor has no download_url')
  }
  const url = new URL(descriptor.download_url, resp.url())
  return boundedBrowserDownload(page, url.href)
}

async function manifestFor(page, chatId) {
  return captureChatFiles(page, chatId)
}

export async function runFiles(chatId) {
  if (!chatId) throw new Error('usage: chatgpt-web files <chat-id>')
  await withPage(async (page) => {
    const manifest = await manifestFor(page, chatId)
    let shown = 0
    let failed = 0
    manifest.forEach((m) => {
      if (!m.ok) {
        console.log(String(m.index + 1).padEnd(4), `(capture failed: ${m.reason})`)
        failed++
        return
      }
      shown++
      console.log(String(m.index + 1).padEnd(4), m.file.name.slice(0, 48).padEnd(50), m.file.id)
    })
    if (!shown && !failed) console.log('no files')
    if (failed) process.exitCode = 1
  })
}

export async function runDownload(chatId, what, outdir) {
  if (!chatId) throw new Error('usage: chatgpt-web download <chat-id> [n|all] [outdir]')
  const target = what || 'all'
  const dir = outdir || process.cwd()
  await withPage(async (page) => {
    const manifest = await manifestFor(page, chatId)
    if (!manifest.length) {
      console.log('no files')
      return
    }
    let picks
    try {
      const { selectDownloads } = await import('./core-fixes.mjs')
      picks = selectDownloads(manifest, target)
      if (target === 'all' || target === undefined) picks = dedupeByFileId(picks)
    } catch (e) {
      // `all` on an incomplete manifest fails loudly; an explicit index
      // owns its own failure. Either way nothing partial is saved silently.
      console.error(e.message)
      process.exitCode = 1
      return
    }
    fs.mkdirSync(dir, { recursive: true })
    for (const m of picks) {
      const p = saveArtifact(dir, m.file.name, m.file.id, m.file.bytes)
      console.log(p, `(${m.file.bytes.length} bytes)`)
    }
  })
}

// The model picker: candidate selectors plus a composer-scoped positional
// fallback, and a clear failure message when the UI moves. The 2026-10
// trigger has no testid; its stable hook is the aria-label.
const MODEL_BTN_CANDIDATES = [
  'button[aria-label="Select ChatGPT model"]',
  '[data-testid="model-switcher-dropdown-button"]',
  '#model-switcher-dropdown-button',
]

async function modelButton(page) {
  for (const sel of MODEL_BTN_CANDIDATES) {
    const loc = page.locator(sel).first()
    if ((await loc.count().catch(() => 0)) > 0) return loc
  }
  await page.evaluate(() => {
    const composer = document.querySelector('#prompt-textarea, div[contenteditable="true"]')
    if (!composer) return
    const notModel = /more|account|profile|thinking|effort|tools|attach/i
    for (let el = composer.closest('form') || composer.parentElement; el && el !== document.body; el = el.parentElement) {
      for (const b of el.querySelectorAll('button[aria-haspopup="menu"]')) {
        const t = (b.innerText || '').trim()
        if (t && !notModel.test(t)) {
          b.setAttribute('data-cgw-model-btn', '1')
          return
        }
      }
    }
  })
  return page.locator('[data-cgw-model-btn="1"]').first()
}

// parseSliderDescription (audit-core) reads the Power slider's value out of
// its aria-describedby text. The row exposes no aria-valuenow; the current
// stop is only in the described text: "Pro, 5 of 5. Use Left and Right arrow
// keys to adjust power". It rejects non-safe integers and unreasonable
// bounds outright.
function describePick(p) {
  return p.kind === 'model' ? p.label : p.label + ' (' + p.n + ' of ' + p.total + ')'
}

// pickPickerMatch resolves a user fragment against BOTH the named models
// and the power-slider stops. A stop is matchable by its stop name or its
// effective label ("pro" and "6 pro" both hit stop 5, one entry). Named
// models keep the old substring semantics; ambiguity refuses.
export function pickPickerMatch(modelLabels, stops, want) {
  const w = normText(want).toLowerCase()
  if (!w) return { error: 'empty model fragment' }
  const cands = []
  for (const label of modelLabels || []) {
    const l = normText(label)
    if (l) cands.push({ kind: 'model', label: l })
  }
  for (const s of stops || []) {
    const name = normText(s.name)
    if (!name) continue
    cands.push({ kind: 'slider', label: name, alt: normText(s.effective || ''), effective: normText(s.effective || ''), n: s.n, total: s.total })
  }
  const hits = []
  for (const c of cands) {
    const hay = c.kind === 'slider' && c.alt && c.alt !== c.label ? c.label + ' ' + c.alt : c.label
    if (hay.toLowerCase().includes(w)) hits.push(c)
  }
  // A stop matched through both its name and its effective label is one
  // candidate, not two.
  const uniq = hits.filter((h, i) => !hits.slice(0, i).some((p) => p.kind === h.kind && (h.kind === 'model' ? p.label === h.label : p.n === h.n)))
  if (uniq.length === 1) return uniq[0]
  if (uniq.length > 1) {
    return { error: `"${want}" matches ${uniq.length} options: ${uniq.map(describePick).join(' | ')} — be more specific` }
  }
  return { error: `no model or power stop matches "${want}"` }
}

// openPickerMenu robustly opens the model popover. The radix trigger does
// not react to every DOM click (observed live), so plain el.click() and the
// full pointer sequence alternate across retries; an already-open menu is
// left alone (toggling would close it).
async function openPickerMenu(page, btn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const open = await page
      .evaluate(() => !!document.querySelector('[data-radix-popper-content-wrapper] [role="menu"], [role="menu"][data-state="open"]'))
      .catch(() => false)
    if (open) return true
    await btn
      .evaluate((el, mode) => {
        if (mode === 'dom') {
          el.click()
          return
        }
        const r = el.getBoundingClientRect()
        const o = {
          bubbles: true, cancelable: true, composed: true,
          clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0,
          pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window,
        }
        el.dispatchEvent(new PointerEvent('pointerover', o))
        el.dispatchEvent(new PointerEvent('pointerdown', o))
        el.dispatchEvent(new PointerEvent('pointerup', o))
        el.click()
      }, attempt % 2 === 0 ? 'dom' : 'pointer')
      .catch(() => {})
    await sleep(1500 + attempt * 400)
    const nowOpen = await page
      .evaluate(() => !!document.querySelector('[data-radix-popper-content-wrapper] [role="menu"], [role="menu"][data-state="open"]'))
      .catch(() => false)
    if (nowOpen) return true
  }
  return false
}

// readSliderState reads the power slider's live position from the open
// menu: parsed stop ("Pro", 5 of 5) plus the "Select model" row's effective
// label ("6 Pro"). Null when the row is absent.
async function readSliderState(page) {
  const raw = await page
    .evaluate(() => {
      const power =
        document.querySelector('[data-reasoning-slider="true"]') ||
        Array.from(document.querySelectorAll('[role="menuitem"]')).find((e) => e.getAttribute('aria-label') === 'Power')
      if (!power) return null
      const desc = (power.getAttribute('aria-describedby') || '').split(/\s+/)
      const descText = desc
        .map((id) => document.getElementById(id))
        .filter(Boolean)
        .map((e) => (e.innerText || '').replace(/\s+/g, ' ').trim())
        .join(' ')
      const selModel = Array.from(document.querySelectorAll('[role="menuitem"]')).find((e) => e.getAttribute('aria-label') === 'Select model')
      return { descText, effective: selModel ? (selModel.innerText || '').replace(/\s+/g, ' ').trim() : null }
    })
    .catch(() => null)
  if (!raw) return null
  const parsed = parseSliderDescription(raw.descText)
  return parsed ? { ...parsed, effective: raw.effective } : null
}

// checkedRadioLabel reads the currently selected named model from the open
// menu (used to snapshot/verify the full picker state).
async function checkedRadioLabel(page) {
  return page
    .evaluate(() => {
      const radios = Array.from(document.querySelectorAll('[role="menuitemradio"]'))
      const hit = radios.find(
        (e) => e.getAttribute('data-state') === 'checked' || e.getAttribute('aria-checked') === 'true'
      )
      return hit ? (hit.innerText || '').replace(/\s+/g, ' ').trim() : null
    })
    .catch(() => null)
}

// focusSlider is kept only as a belt-and-braces aid: synthetic key events
// (stepSlider) drive the row without document focus, but a focused row
// behaves identically to a human's arrows for the UI's own tracking.
async function focusSlider(page) {
  return page
    .evaluate(() => {
      const power =
        document.querySelector('[data-reasoning-slider="true"]') ||
        Array.from(document.querySelectorAll('[role="menuitem"]')).find((e) => e.getAttribute('aria-label') === 'Power')
      if (!power) return false
      power.focus()
      return document.activeElement === power
    })
    .catch(() => false)
}

// stepSlider drives the slider with element-dispatched KeyboardEvents.
// page.keyboard presses are at the mercy of radix's roving focus during the
// popover's mount settle (observed: stretches of ignored CDP key events);
// synthetic events on the row itself register regardless of focus, and the
// read-back in the caller is the authority on whether a step landed.
async function stepSlider(page, dir) {
  const before = await readSliderState(page)
  await page
    .evaluate((key) => {
      const p =
        document.querySelector('[data-reasoning-slider="true"]') ||
        Array.from(document.querySelectorAll('[role="menuitem"]')).find((e) => e.getAttribute('aria-label') === 'Power')
      if (!p) return
      for (const type of ['keydown', 'keyup']) {
        p.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true, composed: true }))
      }
    }, dir)
    .catch((e) => debugLog('synth press failed', String(e)))
  await sleep(jitter(350, 650))
  const after = await readSliderState(page)
  debugLog('stepSlider', dir, before ? before.n : null, '->', after ? after.n : null)
  if (after && before && after.n === before.n) await focusSlider(page)
  return after
}

// settleSliderReads waits out the slider's animation lag: the described
// position can keep drifting after the last key event landed, so a single
// read is stale. Two consecutive reads agreeing on the FULL state (name,
// position, total, effective label) is "settled"; a number agreeing across
// two reads does not prove the label settled. Unsettled throws.
async function settleSliderReads(page, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs
  let previous = null
  while (Date.now() < deadline) {
    const current = await readSliderState(page)
    if (sliderEqual(previous, current)) return current
    previous = current
    await sleep(Math.min(700, Math.max(0, deadline - Date.now())))
  }
  throw new AuditError('SLIDER_NOT_SETTLED', 'power state did not settle')
}

// moveSliderTo presses toward targetN until a SETTLED read agrees. Any
// read-based loop that skips the settle can both over-press and accept a
// position the UI then drifts away from.
async function moveSliderTo(page, targetN, total) {
  let cur = await settleSliderReads(page)
  for (let round = 0; round < 3 && cur && cur.n !== targetN; round++) {
    let guard = 2 * total + 2
    while (cur && cur.n !== targetN && guard-- > 0) {
      cur = await stepSlider(page, cur.n < targetN ? 'ArrowRight' : 'ArrowLeft')
    }
    cur = await settleSliderReads(page)
  }
  return cur
}

// enumerateSliderStops walks the slider left to stop 1, right to its last
// stop, and back to where it started, recording every stop's name and
// effective label. The walk runs inside withRestoredPicker: the snapshot
// covers BOTH the checked named model and the full slider state, and a
// restoration failure is always reported (a list command must not leave the
// account default moved). Every position 1..total must have been observed —
// a partial menu is never reported as exhaustive.
async function enumerateSliderStops(page) {
  return withRestoredPicker({
    snapshot: async () => ({
      slider: await readSliderState(page),
      modelLabel: await checkedRadioLabel(page),
    }),
    restore: async (original) => {
      let ok = true
      if (original.slider) {
        const back = await moveSliderTo(page, original.slider.n, original.slider.total)
        if (!back || back.n !== original.slider.n) ok = false
      }
      if (ok && original.modelLabel && original.modelLabel !== (await checkedRadioLabel(page))) {
        ok = false // the named selection moved unexpectedly — report it
      }
      return ok
    },
    body: async (original) => {
      const initial = original.slider
      if (!initial) throw new Error('power slider not present in the open model menu')
      const total = initial.total
      const stops = new Map()
      const record = (s) => {
        if (s) stops.set(s.n, { n: s.n, name: s.name, effective: s.effective, total: s.total })
        return s
      }
      record(initial)
      await focusSlider(page)
      let cur = initial
      let guard = 2 * total + 2
      while (cur && cur.n > 1 && guard-- > 0) cur = record(await stepSlider(page, 'ArrowLeft'))
      guard = 2 * total + 2
      while (cur && cur.n < total && guard-- > 0) cur = record(await stepSlider(page, 'ArrowRight'))
      for (let n = 1; n <= total; n++) {
        if (!stops.has(n)) {
          throw new AuditError('SLIDER_ENUM_INCOMPLETE', `enumeration missed stop ${n} of ${total} — partial menus are not reported as exhaustive`)
        }
      }
      const restored = await moveSliderTo(page, initial.n, total)
      if (restored) record(restored)
      return { stops: [...stops.values()].sort((a, b) => a.n - b.n), final: restored || initial }
    },
  })
}

// applySliderStop moves the slider to targetN with arrow presses and
// verifies twice: settled in-menu, and again after closing and reopening
// the popover (the read-back the owner can see).
async function applySliderStop(page, btn, targetN, total) {
  await focusSlider(page)
  const cur = await moveSliderTo(page, targetN, total)
  if (!cur || cur.n !== targetN) return null
  const applied = cur
  await page.keyboard.press('Escape').catch(() => {})
  await sleep(jitter(900, 1500))
  if (!(await openPickerMenu(page, btn))) return null
  const recheck = await settleSliderReads(page, 4000)
  await page.keyboard.press('Escape').catch(() => {})
  if (!recheck || recheck.n !== targetN) return null
  return recheck.effective ? recheck : applied
}

async function openModelMenu(page, btn) {
  const radios = page.locator('[role="menuitemradio"]')
  // Idempotent: toggling an already-open menu would close it, leaving the
  // retry with nothing to select.
  if ((await radios.count().catch(() => 0)) === 0) {
    const anyMenuOpen = await page
      .evaluate(() => !!document.querySelector('[data-radix-popper-content-wrapper] [role="menu"], [role="menu"][data-state="open"]'))
      .catch(() => false)
    if (!anyMenuOpen) {
      // DOM click, not a playwright coordinate click: the radix trigger does
      // not open reliably under forced pointer events in the hidden window.
      await btn.evaluate((el) => el.click()).catch(() => {})
    }
  }
  await radios.first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {})
  let n = await radios.count().catch(() => 0)
  if (n === 0) {
    // 2026-10 picker: the menu can open in a "simple" effort view; the
    // model list lives behind the in-menu view toggle.
    const toggle = page.locator('[data-model-picker-view-toggle]')
    if ((await toggle.count().catch(() => 0)) > 0) {
      await toggle.first().evaluate((el) => el.click()).catch(() => {})
      await radios.first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {})
      n = await radios.count().catch(() => 0)
    }
  }
  if (n === 0) return null
  const labels = []
  for (let i = 0; i < n; i++) {
    const t = normText(await radios.nth(i).innerText().catch(() => ''))
    labels.push(t)
  }
  const checked = await radios
    .evaluateAll(
      (els) =>
        els.findIndex((e) => e.getAttribute('data-state') === 'checked' || e.getAttribute('aria-checked') === 'true')
    )
    .catch(() => -1)
  return { labels, checked, radios }
}

// Selection uses the menu that is already open on the first attempt and
// reopens only after a close: calling openModelMenu again on a toggle button
// closes the menu, and clicking a stale unmounted item throws.
async function applyModelSelection(page, btn, open, label) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const items = attempt === 0 ? open : await openModelMenu(page, btn)
    if (!items) continue
    const idx = items.labels.findIndex((l) => l === label)
    if (idx < 0) continue
    // Full pointer sequence: 2026-10 menu items are radix-managed and a
    // bare el.click() does not register; checked state is aria-checked.
    await items.radios
      .nth(idx)
      .evaluate((el) => {
        el.scrollIntoView({ block: 'center' })
        const rect = el.getBoundingClientRect()
        const cx = rect.left + rect.width / 2
        const cy = rect.top + rect.height / 2
        const opts = {
          bubbles: true, cancelable: true, composed: true,
          clientX: cx, clientY: cy, button: 0,
          pointerId: 1, pointerType: 'mouse', isPrimary: true, view: window,
        }
        el.dispatchEvent(new PointerEvent('pointerover', opts))
        el.dispatchEvent(new PointerEvent('pointerenter', opts))
        el.dispatchEvent(new PointerEvent('pointerdown', opts))
        el.dispatchEvent(new PointerEvent('pointerup', opts))
        el.click()
      })
      .catch(() => {})
    await sleep(1500)
    const check = await openModelMenu(page, btn)
    if (check && check.labels[check.checked] === label) {
      await page.keyboard.press('Escape').catch(() => {})
      return true
    }
  }
  return false
}

// runModel lists or sets the account's chat model. The popover carries two
// controls: the named-model radios and the thinking-power slider (the
// "6 Pro" stop the UI exposes). The slider is an account-wide default —
// once set here, every later composer (including runner-started fresh
// chats) inherits it, so `start`/`send` need no model work of their own.
//
// The whole operation runs under the send lock (taken BEFORE the page is
// created — a cached composer can carry stale picker state), so a model
// change never reorders against a live send/dot-send/retry. A plain
// listing never walks the slider: the walk temporarily moves the
// account-wide default, so stop names are discovered only for an explicit
// set.
export async function runModel(want) {
  await withLock('send', async () => {
    await withPage(async (page) => {
      await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await waitForComposer(page)
      const btn = await modelButton(page)
      if (!btn || (await btn.count().catch(() => 0)) === 0) {
        throw new Error('model picker not found — the web UI changed; update modelButton in runner.mjs')
      }
      if (!(await openPickerMenu(page, btn))) {
        throw new Error('model menu did not open — the web UI changed; update openPickerMenu in runner.mjs')
      }
      // openModelMenu is idempotent (sees the open menu) and knows the radio
      // view-toggle fallback from the 2026-10 simple view.
      const menu = await openModelMenu(page, btn)
      const modelLabels = menu ? menu.labels.filter(Boolean) : []
      let slider = await readSliderState(page)
      if (!modelLabels.length && !slider) {
        await page.keyboard.press('Escape').catch(() => {})
        throw new Error('model menu opened but listed no models and no power slider — the web UI changed')
      }

      let stops = slider ? [slider] : []
      if (slider && want) {
        const walk = await enumerateSliderStops(page)
        stops = walk.stops
        slider = walk.final
      }

      const closeMenu = () => page.keyboard.press('Escape').catch(() => {})
      if (!want) {
        // Mark against the ORIGINAL radio index: menu.checked indexes the
        // unfiltered radio list, modelLabels is filtered — a filtered index
        // marks the wrong row whenever a label came back empty.
        menu?.labels.forEach((label, originalIndex) => {
          if (label) console.log((originalIndex === menu.checked ? '* ' : '  ') + label)
        })
        if (slider) {
          console.log('')
          console.log('slider (thinking power):')
          const s = stops.find((x) => x.n === slider.n && x.total === slider.total) || slider
          console.log(`* ${s.n}  ${s.name}${s.effective && s.effective !== s.name ? `  (${s.effective})` : ''}`)
          console.log('  (other stops are listed only when setting one, e.g.: chatgpt-web model 6 pro)')
        }
        await closeMenu()
        return
      }

      const pick = pickPickerMatch(modelLabels, stops || [], want)
      if (pick.error) {
        console.error(pick.error)
        if (!pick.error.includes('matches ')) {
          modelLabels.forEach((l) => console.error('  ' + l))
          if (stops && stops.length) {
            console.error('  slider (thinking power):')
            for (const s of stops) {
              console.error(`  ${s.n}  ${s.name}${s.effective && s.effective !== s.name ? '  (' + s.effective + ')' : ''}`)
            }
          }
        }
        await closeMenu()
        process.exitCode = 1
        return
      }

      // A failed explicit selection restores the original complete picker
      // state (named model + slider) where possible, and always reports a
      // restoration failure instead of silently leaving a changed default.
      const originalSlider = slider ? { ...slider } : null
      const originalModel = menu && typeof menu.checked === 'number' ? menu.labels[menu.checked] || null : null
      const restoreOriginal = async () => {
        let ok = true
        try {
          if (originalSlider) {
            if (!(await openPickerMenu(page, btn))) return false
            const back = await moveSliderTo(page, originalSlider.n, originalSlider.total)
            if (!back || back.n !== originalSlider.n) ok = false
          }
          if (ok && originalModel) {
            const again = await openModelMenu(page, btn)
            if (!again || !(await applyModelSelection(page, btn, again, originalModel))) ok = false
          }
        } catch {
          ok = false
        }
        return ok
      }
      const reportFailure = async (note) => {
        let message = note
        try {
          if (!(await restoreOriginal())) message += '; restoration to the original picker state could not be confirmed — check the picker manually'
        } catch (e) {
          message += '; restoration failed: ' + e.message
        }
        console.error(message)
        process.exitCode = 1
      }

      if (pick.kind === 'model') {
        let applied = false
        try {
          applied = await applyModelSelection(page, btn, menu, pick.label)
        } catch (e) {
          await reportFailure(`selecting "${pick.label}" failed: ${e.message}`)
          return
        }
        if (!applied) {
          await reportFailure(`could not confirm "${pick.label}" was selected — check the picker manually`)
          return
        }
        console.log(`model set: ${pick.label}`)
        return
      }

      // Slider stop: the enumeration left the menu open at the original
      // position; applySliderStop moves, verifies, closes, reopens and
      // re-verifies.
      let result = null
      try {
        result = await applySliderStop(page, btn, pick.n, pick.total)
      } catch (e) {
        await reportFailure(`setting power stop "${pick.label}" (${pick.n} of ${pick.total}) failed: ${e.message}`)
        return
      }
      if (!result) {
        await reportFailure(
          `could not confirm power stop "${pick.label}" (${pick.n} of ${pick.total}) — check the picker manually`
        )
        return
      }
      const eff = result.effective && result.effective !== pick.label ? ` — effective: ${result.effective}` : ''
      console.log(`model set: ${pick.label} (${pick.n} of ${pick.total})${eff}`)
    })
  })
}

// ----- dots: always-on agent threads over chatgpt.com messaging rooms -----
//
// A dot conversation is NOT a /c/<id> thread: /backend-api/conversation
// returns 404 and the thread never appears in /backend-api/conversations
// (verified 2026-10-03). The dot surface is a messaging room — reads go
// through /backend-api/messaging/rooms/<room>/messages (authored text in
// content.text, authorship by account_user_id), and sends go through the
// page composer like every other turn. The dot replies on its own horizon,
// so there is no wait: poll replaces blocking.

const DOTS_URL = 'https://chatgpt.com/dots'
const DOT_SUBMIT_SEL = 'button[aria-label="Send" i]'
const DOT_ROOM_LIST_LIMIT = 20
// The messaging endpoints 422 above their cap: rooms max 20, messages max 32
// (both are the page's own request sizes; 422 observed on 50 and 100).
const DOT_MSG_PAGE_LIMIT = 32

// Every exported dot operation (discovery, status, poll, context, send,
// reset) runs entirely inside one operation lock, and the binding is
// re-read AFTER acquiring it — stale reads used to race and could overwrite
// checkpoints or resurrect a reset record. This is a separate lock, not a
// recursive acquisition of updateDot's short write lock.
const withDotOperation = (fn) => withLock('dot-operation', fn)

function dotRouteId(url) {
  const m = String(url || '').match(/\/dots\/([0-9a-fA-F-]{8,})/)
  return m ? m[1] : null
}

// authedFetchInPage runs a GET against a backend-api path from the page's
// origin so the session cookies and bearer token apply. Reads only. Both
// fetches are abort-bounded and the evaluate is wall-clock bounded: the dot
// read commands are synchronous, and an unbounded hang used to leave the
// CLI (and its dot-operation lock) wedged until the process was killed.
async function authedFetchInPage(page, urlPath, timeoutMs = 15000) {
  const result = await evaluateBounded(
    page,
    async ({ u, timeoutMs }) => {
      try {
        const s = await (
          await fetch('/api/auth/session', {
            credentials: 'include',
            signal: AbortSignal.timeout(timeoutMs),
          })
        ).json()
        const token = s && s.accessToken
        if (!token) return { error: 'no session token' }
        const r = await fetch(u, {
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
          credentials: 'include',
          signal: AbortSignal.timeout(timeoutMs),
        })
        let body = null
        try {
          body = await r.json()
        } catch {}
        return { status: r.status, body }
      } catch (e) {
        return { error: String((e && e.message) || e) }
      }
    },
    { u: urlPath, timeoutMs },
    timeoutMs + 5000,
    'dot api fetch'
  ).catch((e) => ({ error: e.message }))
  return result
}

// discoverDotRoom binds the dot: the /dots route redirects to the primary
// dot's thread (its slug ids the dot), and the rooms list names exactly one
// DM room per dot. Ambiguity refuses — two dots cannot share one record.
// Discovery preserves an existing same-room record (its watermark and
// last-send fields) instead of replacing it, and refuses a changed binding
// unless it was explicitly reset.
async function ensureDotRecord() {
  const existing = readDot()
  if (existing && existing.roomId && existing.dotId && existing.myId) return existing
  const record = await withPage(async (page) => {
    await page.goto(DOTS_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    let dotId = null
    const deadline = Date.now() + 25000
    while (Date.now() < deadline) {
      dotId = dotRouteId(page.url())
      if (dotId) break
      await sleep(700)
    }
    if (!dotId) {
      const state = await classifyPage(page, 8000)
      if (state === 'out') throw new Error('not logged in — run: chatgpt-web login')
      throw new Error('no dot thread found at /dots — this account has no dot, or the surface changed')
    }
    await waitForComposer(page)
    const res = await authedFetchInPage(page, '/backend-api/messaging/rooms?limit=' + DOT_ROOM_LIST_LIMIT)
    if (res.error) throw new Error('rooms fetch failed: ' + res.error)
    if (res.status !== 200) throw new Error('rooms fetch http ' + res.status)
    const rooms = (res.body && res.body.items) || []
    // Complete-inventory rule: a full first page could hide additional
    // eligible rooms behind pagination — refuse rather than guess.
    if (rooms.length >= DOT_ROOM_LIST_LIMIT) {
      throw new AuditError(
        'DOT_ROOMS_PAGE_FULL',
        `room listing returned a full page (${rooms.length}) — additional rooms may exist beyond it; refusing to bind from a partial inventory`
      )
    }
    const dms = rooms.filter((r) => r.type === 'DM' && r.app_source === 'chatgpt:messaging')
    if (dms.length === 0) throw new Error('no dot messaging room on this account')
    if (dms.length > 1) {
      throw new Error(
        `${dms.length} dot rooms found — this build tracks exactly one; rooms: ` +
          dms.map((r) => `${r.id} (${r.name || 'unnamed'})`).join(', ')
      )
    }
    const room = dms[0]
    const mine = (room.members || []).find((m) => typeof m.account_user_id === 'string' && m.account_user_id.startsWith('user-'))
    if (!mine) throw new Error('dot room has no human member — refusing to guess authorship')
    return {
      roomId: room.id,
      roomName: room.name || 'Dot',
      dotId,
      url: DOTS_URL + '/' + dotId,
      myId: mine.account_user_id,
      discoveredAt: new Date().toISOString(),
      lastSentAt: null,
      lastSentText: null,
      watermark: null,
    }
  })
  return updateDot((cur) => {
    if (cur && (cur.roomId || cur.dotId)) {
      if (cur.roomId !== record.roomId || cur.dotId !== record.dotId) {
        throw new Error(
          `stored dot binding (${cur.roomId || '?'}) differs from the discovered room (${record.roomId}) — run: chatgpt-web dot --reset to rebind`
        )
      }
      return cur // same room: preserve watermark/last-send checkpoints
    }
    return record
  })
}

// fetchDotMessages returns the room's messages oldest-first, each as
// { id, at, iso, mine, text }. Authorship is the member id, not the role
// field: the dot's own messages also carry role "user" (verified shape).
async function fetchDotMessages(page, dot, limit = DOT_MSG_PAGE_LIMIT) {
  const res = await authedFetchInPage(page, '/backend-api/messaging/rooms/' + dot.roomId + '/messages?limit=' + limit)
  if (res.error) throw new Error('dot messages fetch failed: ' + res.error)
  if (res.status !== 200) throw new Error('dot messages fetch http ' + res.status)
  const items = (res.body && res.body.items) || []
  const msgs = items.map((m) => ({
    id: String(m.id || ''),
    at: Date.parse(m.created_at || 0) || 0,
    iso: String(m.created_at || ''),
    mine: m.account_user_id === dot.myId,
    text: String((m.content && m.content.text) || ''),
  }))
  msgs.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1))
  return msgs
}

function renderDotMessage(m) {
  const d = new Date(m.at)
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  const who = m.mine ? 'you' : 'dot'
  const body = m.text.trim() || '(non-text message)'
  return `[${stamp}] ${who}: ${body}`
}

// Watermark semantics live in audit-core (dotPollBatch/afterDotSend):
// membership by id, created_at only a coarse backfill floor, and v2
// checkpoints retain delivered ids so a send cannot clobber unread ones.

// withDotReadPage runs reads against a chatgpt.com page for the session
// origin. Everything happens inside the callback: withPage owns the tab and
// closes it when the callback returns.
async function withDotReadPage(fn) {
  return withPage(async (page) => {
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await waitForComposer(page)
    return fn(page)
  })
}

export async function runDotStatus() {
  await withDotOperation(async () => {
    const dot = await ensureDotRecord()
    await withDotReadPage(async (page) => {
      const msgs = await fetchDotMessages(page, dot)
      const batch = dotPollBatch(msgs, dot.watermark, { limit: DOT_MSG_PAGE_LIMIT })
      console.log(`dot room ${dot.roomId} (${dot.roomName})`)
      console.log(`thread: ${dot.url}`)
      console.log(`messages on record: ${msgs.length}, new since last poll: ${batch.messages.length}`)
      if (dot.lastSentAt) {
        console.log(`last sent: ${new Date(dot.lastSentAt).toISOString()} — ${String(dot.lastSentText || '').replace(/\s+/g, ' ').slice(0, 60)}`)
      } else {
        console.log('last sent: never (this record)')
      }
      if (msgs.length) console.log('latest: ' + renderDotMessage(msgs[msgs.length - 1]).slice(0, 120))
      if (batch.messages.length) console.log('run: chatgpt-web dot --poll')
    })
  })
}

// runDotPoll delivers at-least-once: output is written before the
// checkpoint advances, so a crash in between can replay a message on the
// next poll. The v2 checkpoint retains delivered ids; a full page with no
// checkpoint overlap is refused rather than silently truncating history.
export async function runDotPoll(asJson) {
  await withDotOperation(async () => {
    const dot = await ensureDotRecord()
    await withDotReadPage(async (page) => {
      const msgs = await fetchDotMessages(page, dot)
      const legacy = dot.watermark && dot.watermark.v !== 2
      assertDotWindow(msgs, dot.watermark, DOT_MSG_PAGE_LIMIT)
      const batch = dotPollBatch(msgs, dot.watermark, { limit: DOT_MSG_PAGE_LIMIT })
      const payload = {
        room: dot.roomId,
        url: dot.url,
        initialized: batch.initialized,
        messages: batch.messages,
      }
      if (asJson) {
        await writeOutput(process.stdout, JSON.stringify(payload, null, 2) + '\n')
      } else if (batch.initialized) {
        console.log(`tracking ${msgs.length} messages (watermark set, nothing printed) — run: chatgpt-web dot --context 20 for history`)
      } else {
        if (!batch.messages.length) console.log('no new messages')
        for (const m of batch.messages) console.log(renderDotMessage(m))
      }
      if (legacy) {
        console.error('note: dot checkpoint upgraded to v2 — a one-time replay of older messages is possible')
      }
      if (batch.watermark) {
        await updateDot((current) => {
          if (!current || current.roomId !== dot.roomId || current.dotId !== dot.dotId) {
            throw new Error('dot binding changed during poll')
          }
          return { ...current, watermark: batch.watermark }
        })
      }
    })
  })
}

export async function runDotContext(count, asJson) {
  await withDotOperation(async () => {
    const dot = await ensureDotRecord()
    await withDotReadPage(async (page) => {
      // The messaging endpoint 422s above 32; the parser enforces 1..32.
      const msgs = await fetchDotMessages(page, dot)
      const slice = msgs.slice(-count)
      if (asJson) {
        console.log(JSON.stringify({ room: dot.roomId, url: dot.url, messages: slice }, null, 2))
        return
      }
      if (!slice.length) {
        console.log('no messages on record')
        return
      }
      for (const m of slice) console.log(renderDotMessage(m))
    })
  })
}

export async function runDotReset() {
  await withDotOperation(async () => {
    // updateDot returns the mutator's value (null here), NOT the previous
    // record — capture it inside the mutator or the command always reports
    // "no dot record stored".
    let previous = null
    await updateDot((current) => {
      previous = current
      return null
    })
    console.log(previous ? `cleared dot record for room ${previous.roomId}` : 'no dot record stored')
  })
}

// sendDotPromptGuarded is the dot-side mirror of sendPromptGuarded: it
// re-validates the /dots/<id> route, the composer contents (exact authored
// text, line endings only), attachment emptiness, and a unique visible
// enabled Send button in one evaluation, then clicks. The dot composer's
// submit is button[aria-label="Send"], not #composer-submit-button
// (verified shape).
async function sendDotPromptGuarded(page, { dotId, prompt }) {
  const result = await page
    .evaluate(
      ({ wantDot, promptText, selectors }) => {
        if (location.origin !== 'https://chatgpt.com') return { error: 'unexpected origin' }
        const route = location.pathname.match(/^\/dots\/([0-9a-fA-F-]{8,})\/?$/)
        if (!route || route[1] !== wantDot) return { error: 'not on the dot thread before submission' }
        const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden'
        const composers = [...document.querySelectorAll(selectors.composer)].filter(visible)
        if (composers.length !== 1) {
          return {
            error: composers.length === 0 ? 'composer disappeared before submission' : 'multiple dot composers visible before submission',
          }
        }
        const composer = composers[0]
        const text = composer.tagName === 'TEXTAREA' ? composer.value : composer.innerText
        const actual = String(text).replace(/\r\n/g, '\n')
        if (actual !== promptText) return { error: 'composer changed before submission', saw: actual.slice(0, 90) }
        // The dot surface has no --file support: the attachment slot must
        // be structurally empty (sentinel with zero children) or chip-free.
        const scope = composer.closest('form') || composer.parentElement?.parentElement || composer.parentElement
        if (scope) {
          const container = scope.querySelector(selectors.attachContainer)
          if (container ? container.childElementCount > 0 : scope.querySelectorAll(selectors.chips).length > 0) {
            return { error: 'dot attachments are not supported — remove the attachment before sending' }
          }
        }
        const buttons = [...document.querySelectorAll(selectors.submit)].filter(
          (b) => visible(b) && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
        )
        if (buttons.length !== 1) {
          return {
            error: buttons.length === 0 ? 'dot Send button is missing or disabled' : 'multiple dot Send buttons visible before submission',
          }
        }
        buttons[0].click()
        return { ok: true }
      },
      {
        wantDot: dotId,
        promptText: canonicalPrompt(prompt),
        selectors: {
          composer: COMPOSER_SEL,
          submit: DOT_SUBMIT_SEL,
          chips: ATTACH_CHIP_SEL,
          attachContainer: ATTACH_CONTAINER_SEL,
        },
      }
    )
    .catch((e) => ({ error: e.message }))
  if (!result?.ok) {
    const detail = result?.saw ? ` (held: ${JSON.stringify(result.saw)})` : ''
    throw new Error('dot submission guard: ' + (result?.error || 'unknown result') + detail)
  }
}

// runDotSend sends one message into the dot thread. Acceptance is
// API-ONLY: a NEW message id authored by this account whose authored text
// is exactly the prompt. The old DOM self-row count fallback mistook
// hydration (or another device's send) for acceptance — a larger row count
// is not evidence this send landed. Failure to verify is an uncertain
// send, never a successful one. `reservation` (when the CLI created a
// dot-send store generation) is ownership-checked before the click.
export async function runDotSend(text, reservation = null) {
  if (!text || !String(text).trim()) throw new Error('dot message is empty')
  const prompt = String(text)
  await withDotOperation(async () => {
    const dot = await ensureDotRecord()
    await ensureBrowser()
    await withPage(async (page) => {
      await page.goto(dot.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await waitForComposer(page)

      await withLock('send', async () => {
        const s = await updateState((st) => st)
        const L = limits()
        const since = Date.now() - (s.lastSendAt || s.lastTurnEnd || 0)
        const gap = L.minGapMs + Math.random() * 8000
        if (since < gap) await sleep(gap - since)
        await sleep(jitter(1500, 4000))

        const composer = await waitForComposer(page)
        if (dotRouteId(page.url()) !== dot.dotId) {
          await page.goto(dot.url, { waitUntil: 'domcontentloaded', timeout: 60000 })
          await sleep(jitter(1500, 3000))
          if (dotRouteId(page.url()) !== dot.dotId) throw new Error('tab is not on the dot thread — refusing to send')
        }
        // API baseline: my message ids present before the click.
        const prior = await fetchDotMessages(page, dot, 20)
        const priorMineIds = new Set(prior.filter((m) => m.mine).map((m) => m.id))

        // The reservation's submission state brackets the click window so
        // an interrupted foreground CLI (or any later failure) can be filed
        // honestly: after 'dispatching' the message may already have
        // landed, and the filed error must say so instead of inviting a
        // blind duplicate retry.
        const setSubmissionState = (state) =>
          reservation
            ? turns.update(reservation.jobId, reservation.turnId, (j) => {
                j.submissionState = state
              })
            : Promise.resolve()
        if (reservation) assertOwnedBeforeMutation(reservation.jobId, reservation.turnId)
        await setSubmissionState('dispatching')
        await typePrompt(page, composer, prompt)
        await sendDotPromptGuarded(page, { dotId: dot.dotId, prompt })
        await updateState((st) => {
          st.lastSendAt = Date.now()
        })
        await setSubmissionState('dispatched')

        const deadline = Date.now() + 60000
        let accepted = null
        while (Date.now() < deadline && !accepted) {
          const now = await fetchDotMessages(page, dot, 20).catch(() => null)
          if (now) {
            accepted = now.find((m) => m.mine && !priorMineIds.has(m.id) && samePrompt(m.text, prompt)) || null
          }
          if (!accepted) await sleep(jitter(1500, 2500))
        }
        if (!accepted) {
          throw new Error(
            'the dot message was not observed as a new API message — it may still have been sent; inspect the thread manually before retrying'
          )
        }
        // The sent id joins the delivered set, but the READ checkpoint is
        // not advanced by a send: unread messages older than this send
        // survive for the next poll, and a fast dot reply is still fresh.
        await updateDot((current) => {
          if (!current || current.roomId !== dot.roomId) throw new Error('dot binding changed during send')
          return afterDotSend(current, accepted, prompt)
        })
        console.log(`sent to dot room ${dot.roomId}`)
        console.log(`thread: ${dot.url}`)
        console.log(`message: ${String(prompt).replace(/\s+/g, ' ').slice(0, 80)}`)
        console.log('replies land on their own schedule — read them: chatgpt-web dot --poll')
      })
    })
  })
}

export async function runStatus() {
  const up = !!(await cdpVersion())
  const mode = !up ? '' : chromeIsHeadlessBin() ? ', headless' : wantHeadless() ? ', hidden' : ', windowed'
  console.log('daemon:', up ? 'up (CDP port ' + validateRunnerConfig().cdpPort + mode + ')' : 'down (next command starts it)')
  const s = readState()
  const L = limits()
  const hourChats = (s.newChats || []).filter((t) => Date.now() - t < 3600000).length
  const rs = runningJobs()
  console.log(
    `usage: ${(s.turns || {})[new Date().toISOString().slice(0, 10)] || 0}/${L.maxTurnsDay} turns today, ` +
      `${hourChats}/${L.maxNewChatsHour} new chats this hour, min gap ${L.minGapMs / 1000}s, ` +
      `max ${L.maxTabs} concurrent`
  )
  console.log('running jobs:', rs.length ? rs.map((j) => j.id + ' — ' + (j.prompt || '').slice(0, 40)).join(' | ') : 'none')
  const dot = readDot()
  if (dot) {
    console.log(
      `dot: room ${dot.roomId} (${dot.roomName}), last sent ${dot.lastSentAt ? new Date(dot.lastSentAt).toISOString().slice(0, 16).replace('T', ' ') : 'never'}`
    )
  }
  if (up) {
    await withPage(async (page) => {
      await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const state = await classifyPage(page, 10000)
      console.log('session:', state === 'in' ? 'logged in' : state === 'out' ? 'logged out — run: chatgpt-web login' : 'unknown')
    })
  }
}
