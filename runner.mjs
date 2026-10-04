#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execSync, execFileSync, execFile } from 'node:child_process'
import crypto from 'node:crypto'
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
  turns,
  readState,
  runningJobs,
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

const jitter = (a, b) => a + Math.random() * (b - a)

const CHAT_URL = 'https://chatgpt.com/'
const TURN_TIMEOUT_MS = (() => {
  try {
    return positiveInteger(process.env.CHATGPT_WEB_TIMEOUT ?? '300', 'CHATGPT_WEB_TIMEOUT', { max: 86400 }) * 1000
  } catch (e) {
    console.error(String(e.message))
    process.exit(1)
  }
})()
const CDP_PORT = String((() => {
  try {
    return positiveInteger(process.env.CHATGPT_WEB_CDP_PORT ?? '9777', 'CHATGPT_WEB_CDP_PORT', { max: 65535 })
  } catch (e) {
    console.error(String(e.message))
    process.exit(1)
  }
})())
const CDP_URL = 'http://127.0.0.1:' + CDP_PORT

const COMPOSER_SEL = '#prompt-textarea, textarea[data-id], div[contenteditable="true"]'
const ASSISTANT_SEL = '[data-message-author-role="assistant"]'
const USER_SEL = '[data-message-author-role="user"]'
const MESSAGE_SEL = '[data-message-author-role]'
const MESSAGE_ID_ATTR = 'data-message-id'
const STOP_SEL = '[data-testid="stop-button"], button[aria-label*="stop" i]'
const SUBMIT_SEL = '#composer-submit-button, [data-testid="send-button"], button[aria-label="Send"]'
const LOGIN_SEL = '[data-testid="login-button"], button:has-text("Log in")'
const NEW_CHAT_SEL = 'nav a[href="/"], [data-testid*="new-chat"] a, a:has-text("New chat")'

function convIdOf(url) {
  const m = String(url || '').match(/\/c\/([0-9a-fA-F-]{8,})/)
  return m ? m[1] : null
}

function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
}

// Only line endings are normalized for prompt comparison: broad whitespace
// collapsing can alter code prompts.
const normPrompt = (s) =>
  String(s || '')
    .replace(/\r\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()

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
  const pid = listenerPid(CDP_PORT)
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
    const res = await fetch(CDP_URL + '/json/version', { signal: AbortSignal.timeout(1500) })
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
  const body = JSON.stringify(
    { pid, profileDir: fs.realpathSync(PROFILE_DIR), port: Number(CDP_PORT), websocketUrl, at: Date.now() },
    null,
    2
  )
  const tmp = DAEMON_FILE + '.' + crypto.randomUUID() + '.tmp'
  fs.mkdirSync(path.dirname(DAEMON_FILE), { recursive: true })
  fs.writeFileSync(tmp, body, { mode: 0o600 })
  fs.renameSync(tmp, DAEMON_FILE)
}

async function verifyDaemonIdentity() {
  const version = await cdpVersion()
  const ident = readDaemonIdentity()
  const live = {
    profileDir: fs.realpathSync(PROFILE_DIR),
    port: Number(CDP_PORT),
    pid: listenerPid(CDP_PORT),
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

async function ensureBrowser() {
  const version = await cdpVersion()
  if (version) {
    if (chromeIsHeadlessBin()) {
      throw new Error(
        'daemon is Chrome --headless (Cloudflare-blocked) — quit it and retry; CHATGPT_WEB_HEADLESS=1 hides a headed window'
      )
    }
    const identity = await verifyDaemonIdentity()
    if (wantHeadless()) await hideDaemon()
    return identity
  }
  // Startup is serialised: two cold starts racing each spawned Chrome, and
  // the loser diagnosed the winner's not-yet-ready port as a profile
  // without debugging.
  await withLock(
    'daemon-startup',
    async () => {
      if (await cdpVersion()) return
      if (profileBusyArgv(PROFILE_DIR)) {
        throw new Error('chatgpt-web Chrome is open without remote debugging — quit it (Cmd+Q) and retry')
      }
      const bin = chromeBinary()
      if (!bin) throw new Error('no Chrome binary found — set CHATGPT_WEB_CHROME=/path/to/chrome')
      const args = [
        '--remote-debugging-port=' + CDP_PORT,
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
      // of stealing the operator's keyboard for the whole startup.
      const hideTimer = wantHeadless() ? startHideLoop(child.pid) : null
      try {
        const deadline = Date.now() + 20000
        while (Date.now() < deadline) {
          const v = await cdpVersion()
          if (v) {
            // Record identity only once the launched child provably owns the
            // listener; never adopt whatever happened to come up.
            if (listenerPid(CDP_PORT) !== child.pid) {
              throw new Error('another process took the debugging port during startup — retry')
            }
            writeDaemonIdentity({ pid: child.pid, websocketUrl: v.webSocketDebuggerUrl })
            return
          }
          try {
            process.kill(child.pid, 0)
          } catch {
            throw new Error('chatgpt-web Chrome exited immediately after starting')
          }
          await sleep(300)
        }
        throw new Error('chatgpt-web Chrome started but the debugging port never came up')
      } finally {
        if (hideTimer) clearInterval(hideTimer)
      }
    },
    { staleMs: 60000, timeoutMs: 120000 }
  )
  const identity = await verifyDaemonIdentity()
  if (wantHeadless()) await hideDaemon()
  return identity
}

async function ensurePageTarget() {
  let tabs = []
  try {
    tabs = await (await fetch(CDP_URL + '/json', { signal: AbortSignal.timeout(1500) })).json()
  } catch {
    return
  }
  if (Array.isArray(tabs) && tabs.some((t) => t.type === 'page')) return
  await fetch(CDP_URL + '/json/new?about:blank', { method: 'PUT', signal: AbortSignal.timeout(2000) }).catch(() => {})
}

// withPage owns a command's tab. In hidden mode it also re-asserts daemon
// invisibility for the whole command: navigation can foreground the window
// mid-command (the old single hide ran before page.goto and lost), which
// stole focus and dropped the operator's keystrokes into Chrome. The loop
// shrinks any steal to the next tick. Login opts out — its window must be
// visible for the human.
async function withPage(fn, { keepVisible = false } = {}) {
  const identity = await ensureBrowser()
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
    return await fn(page)
  } finally {
    if (hideTimer) clearInterval(hideTimer)
    if (page) await page.close().catch(() => {})
    await browser.close().catch(() => {})
    if (wantHeadless() && !keepVisible) await hideDaemon()
  }
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

// userIds snapshots mounted user-message identities, for accepted-turn
// verification below.
async function userIds(page) {
  return page
    .locator(USER_SEL)
    .evaluateAll((els, attr) => els.map((el) => el.closest('[' + attr + ']')?.getAttribute(attr) || '').filter(Boolean), MESSAGE_ID_ATTR)
    .catch(() => [])
}

async function assistantIds(page) {
  return page
    .locator(ASSISTANT_SEL)
    .evaluateAll((els, attr) => els.map((el) => el.closest('[' + attr + ']')?.getAttribute(attr) || '').filter(Boolean), MESSAGE_ID_ATTR)
    .catch(() => [])
}

// sendPromptGuarded submits through one browser evaluation with no async
// gap: it re-validates the destination route and that the composer still
// holds this prompt, then clicks an enabled button. The old final check
// looked only at the button, so a navigation during the ready-wait could
// submit into whatever page was showing; the fallback Enter press is gone.
async function sendPromptGuarded(page, { boundUrl, prompt }) {
  const bound = boundUrl ? new URL(boundUrl) : null
  const route = bound?.pathname.match(/^\/c\/([0-9a-fA-F-]{8,})\/?$/)
  if (bound && (bound.origin !== 'https://chatgpt.com' || !route)) {
    throw new Error('invalid bound conversation URL')
  }
  const result = await page
    .evaluate(
      ({ wantConv, promptText, selectors }) => {
        if (location.origin !== 'https://chatgpt.com') return { error: 'unexpected origin' }
        const current = location.pathname.match(/^\/c\/([0-9a-fA-F-]{8,})\/?$/)
        if (wantConv) {
          if (!current || current[1] !== wantConv) return { error: 'conversation changed before submission' }
        } else if (location.pathname !== '/' || document.querySelectorAll(selectors.messages).length !== 0) {
          return { error: 'fresh-chat destination changed before submission' }
        }
        const composer = document.querySelector(selectors.composer)
        if (!composer) return { error: 'composer disappeared before submission' }
        const text = composer.tagName === 'TEXTAREA' ? composer.value : composer.innerText
        const flat = text.replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
        if (flat !== promptText) return { error: 'composer changed before submission' }
        const button = document.querySelector(selectors.submit)
        if (!button || button.disabled || button.getAttribute('aria-disabled') === 'true') {
          return { error: 'send button is disabled' }
        }
        const priorIds = Array.from(document.querySelectorAll(selectors.users), (el) =>
          el.closest('[' + selectors.idAttr + ']')?.getAttribute(selectors.idAttr)
        )
        if (priorIds.some((id) => !id)) return { error: 'cannot identify existing user messages' }
        button.click()
        return { ok: true, priorIds }
      },
      {
        wantConv: route?.[1] || null,
        promptText: normPrompt(prompt),
        selectors: { composer: COMPOSER_SEL, submit: SUBMIT_SEL, messages: MESSAGE_SEL, users: USER_SEL, idAttr: MESSAGE_ID_ATTR },
      }
    )
    .catch((e) => ({ error: e.message }))
  if (!result?.ok) throw new Error('submission guard: ' + (result?.error || 'unknown result'))
  return result.priorIds
}

// The transcript renders user messages as markdown, so DOM innerText can
// diverge from the authored prompt (list markers, emphasis, blank-line
// runs). The conversation API returns the authored parts verbatim; all
// prompt-identity checks go through it. Ids are the same space as DOM
// data-message-id (mapping key == message.id).
async function fetchConversationMessages(page, cid) {
  return page
    .evaluate(async (cid) => {
      const s = await (await fetch('/api/auth/session', { credentials: 'include' })).json()
      if (!s || !s.accessToken) return { error: 'no access token' }
      const r = await fetch('/backend-api/conversation/' + cid, {
        headers: { Authorization: 'Bearer ' + s.accessToken },
        credentials: 'include',
      })
      if (!r.ok) return { error: 'conversation fetch ' + r.status }
      const j = await r.json()
      const out = []
      for (const k of Object.keys(j.mapping || {})) {
        const m = j.mapping[k].message
        if (!m || !m.content) continue
        const role = m.author && m.author.role
        if (role !== 'user' && role !== 'assistant') continue
        const parts = (m.content.parts || [])
          .map((p) => (typeof p === 'string' ? p : p && p.text ? p.text : ''))
          .filter(Boolean)
        const text = parts.join('\n')
        if (!text.trim()) continue
        out.push({ id: m.id || k, role, create: m.create_time || 0, text, status: m.status || null })
      }
      out.sort((a, b) => a.create - b.create)
      return { msgs: out }
    }, cid)
    .catch((e) => ({ error: e.message }))
}

async function waitForAcceptedPrompt(page, prompt, priorIds, boundUrl, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  const cid = convIdOf(boundUrl || page.url())
  if (!cid) throw new Error('no conversation id to verify the accepted prompt against')
  while (Date.now() < deadline) {
    if (boundUrl && convIdOf(page.url()) !== convIdOf(boundUrl)) {
      await page.goto(boundUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await sleep(jitter(1500, 3000))
    }
    const got = await fetchConversationMessages(page, cid)
    if (got && got.msgs) {
      // Newest match wins: on the 2026-10 UI the DOM priorIds snapshot is
      // always empty (no data-message-id nodes), so an oldest-first scan
      // would re-accept an earlier identical prompt (the agent-mode
      // "deliver the report" recovery sends repeat verbatim).
      const hit = [...got.msgs]
        .reverse()
        .find(
          (m) => m.role === 'user' && normPrompt(m.text) === normPrompt(prompt) && !(priorIds || []).includes(m.id)
        )
      if (hit) return hit.id
    }
    await sleep(jitter(1500, 2500))
  }
  throw new Error('the submitted prompt was not observed as a new user message — refusing to wait on or record a reply')
}

// readComposerAttachments is the DOM adapter: chips scoped to the
// composer's own container, each with an explicit state. A container with
// no chips reports zero attachments (known); an unrecognized layout
// refuses. Transcript text and toasts are never attachment state.
async function readComposerAttachments(page) {
  return page
    .evaluate((composerSel) => {
      const composer = document.querySelector(composerSel)
      if (!composer) return { known: false }
      const scope = composer.closest('form') || composer.parentElement?.parentElement || composer.parentElement
      if (!scope) return { known: false }
      const chips = Array.from(
        scope.querySelectorAll(
          '[data-testid*="attach" i], [data-testid*="file" i], [class*="attachment" i], [class*="file-tile" i]'
        )
      ).filter((el) => el.closest('[data-message-author-role]') === null)
      const files = []
      const seen = new Set()
      for (const chip of chips) {
        const name = (chip.innerText || '').trim().split('\n')[0]?.trim() || ''
        const text = (chip.innerText || '').toLowerCase()
        if (!name || seen.has(name)) continue
        seen.add(name)
        let state = 'ready'
        if (/error|failed/.test(text)) state = 'error'
        else if (/uploading/.test(text) || /\b\d+\s*%\b/.test(text)) state = 'uploading'
        files.push({ name, state })
      }
      return { known: true, files }
    }, COMPOSER_SEL)
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
  throw new Error(`attachments not ready after ${timeoutMs}ms: ${lastError}`)
}

async function uploadFiles(page, paths) {
  const names = paths.map((p) => path.basename(p))
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const fcP = page.waitForEvent('filechooser', { timeout: 12000 })
    fcP.catch(() => {})
    try {
      await page.locator('[data-testid="composer-plus-btn"]').click({ timeout: 30000, force: true })
      await sleep(jitter(600, 1200))
      // The popover sometimes fails to open or renders without the upload
      // option; a failed attempt is retried with a fresh plus-click.
      await page.getByText(/upload from computer/i).first().click({ timeout: 15000, force: true })
      const fc = await fcP
      await fc.setFiles(paths.map((p) => path.resolve(p)))
      await waitForAttachments(page, names, 45000)
      return
    } catch (e) {
      lastErr = e
      await fcP.catch(() => {})
    }
    await sleep(jitter(1500, 3000))
  }
  throw lastErr
}

// The submit button stays disabled while ChatGPT ingests an attached
// document. That is a waitable condition, not a failure: poll until the
// button is enabled so the fail-closed submission guard sees a submittable
// composer instead of racing file processing.
async function waitForSubmitEnabled(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const enabled = await page
      .evaluate((sel) => {
        const b = document.querySelector(sel)
        return !!b && !b.disabled && b.getAttribute('aria-disabled') !== 'true'
      }, SUBMIT_SEL)
      .catch(() => false)
    if (enabled) return
    await sleep(jitter(800, 1500))
  }
  throw new Error(`submit button still disabled after ${timeoutMs}ms (file still processing?)`)
}

// The 2026-10 web UI renders transcripts without data-message-author-role
// or data-message-id, so the old DOM reply tracker is dead. The conversation
// API is the source of truth: poll it for the first assistant message after
// the accepted user message, surface growing text as partials, and finish
// when the backend marks the message finished (with a quiet-period fallback
// for messages that never expose a terminal status).
async function waitForReply(page, acceptedUserId, boundUrl, onPartial) {
  const boundId = convIdOf(boundUrl)
  if (!boundId) throw new Error('no bound conversation url for reply wait')
  const started = Date.now()
  const rebindIfDrifted = async () => {
    if (convIdOf(page.url()) !== boundId) {
      await page.goto(boundUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {})
      await sleep(jitter(1500, 3000))
    }
  }

  let lastPartial = ''
  let stable = 0
  let firstSeen = 0
  while (Date.now() - started < TURN_TIMEOUT_MS) {
    await rebindIfDrifted()
    const got = await fetchConversationMessages(page, boundId)
    if (got && got.msgs) {
      const accIdx = got.msgs.findIndex((m) => m.id === acceptedUserId)
      if (accIdx >= 0) {
        const reply = got.msgs.slice(accIdx + 1).find((m) => m.role === 'assistant')
        if (reply && reply.text.trim()) {
          if (!firstSeen) firstSeen = Date.now()
          const text = reply.text.trim()
          if (onPartial && text !== lastPartial) {
            lastPartial = text
            await onPartial(text)
          }
          if (reply.status === 'finished_successfully') return text
          if (!reply.status) {
            stable = text === lastPartial ? stable + 1 : 0
            if (stable >= 4 && Date.now() - firstSeen > 20000) return text
          } else {
            stable = 0
          }
        }
      }
    }
    await sleep(jitter(800, 1500))
  }
  throw new Error(
    `response never finished within ${Math.round(TURN_TIMEOUT_MS / 1000)}s (raise CHATGPT_WEB_TIMEOUT)`
  )
}

// runResume retries a failed assistant turn in standard ChatGPT: it clicks
// the conversation's own Retry control (regenerate-thread-error-button) and
// waits for the regenerated reply. It never clicks "Use Work".
export async function runResume(jobId, turnId) {
  const job = await turns.claim(jobId, turnId, process.pid)
  if (!job) {
    console.error(`turn ${turnId} of job ${jobId} is not admissible (stale, duplicate or terminal) — worker exiting`)
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
      const retry = page.locator('[data-testid="regenerate-thread-error-button"]').first()
      if ((await retry.count().catch(() => 0)) === 0) {
        throw new Error('no thread error to retry — the conversation is not in a retryable state')
      }
      await withLock('send', async () => {
        const s = await updateState((st) => st)
        const L = limits()
        const since = Date.now() - (s.lastSendAt || s.lastTurnEnd || 0)
        const gap = L.minGapMs + Math.random() * 8000
        if (since < gap) await sleep(gap - since)
        await retry.click({ force: true, timeout: 10000 })
        await updateState((st) => {
          st.lastSendAt = Date.now()
        })
      })
      const got = await fetchConversationMessages(page, convIdOf(job.url))
      const lastUser = got && got.msgs ? [...got.msgs].reverse().find((m) => m.role === 'user') : null
      const known = lastUser
        ? (job.history || []).some((h) => h.role === 'user' && normPrompt(h.text) === normPrompt(lastUser.text))
        : false
      if (!lastUser || !known) {
        throw new Error("cannot resume: the conversation's last user message does not belong to this job")
      }
      await turns.update(jobId, tid, (j) => {
        j.acceptedUserId = lastUser.id
      })
      let lastPartial = 0
      const reply = await waitForReply(page, lastUser.id, job.url, async (partial) => {
        if (Date.now() - lastPartial < 2000) return
        lastPartial = Date.now()
        await turns.update(jobId, tid, (j) => {
          j.status = 'streaming'
          j.reply = partial
        })
      })
      await turns.update(jobId, tid, (j) => {
        j.status = 'done'
        j.reply = reply
        j.error = null
        j.history.push({ role: 'assistant', text: reply })
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
    await ensureBrowser()
    await withPage(async (page) => {
      await page.goto(job.url || CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await waitForComposer(page)

      let boundUrl = job.url || null
      let acceptedUserId = null
      let priorUserIds = []

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

        await typePrompt(page, composer, job.prompt)
        if (job.files && job.files.length) await waitForSubmitEnabled(page, 150000)
        priorUserIds = await sendPromptGuarded(page, { boundUrl: job.url, prompt: job.prompt })
        await updateState((st) => {
          st.lastSendAt = Date.now()
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
            await turns.update(jobId, tid, (j) => {
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
      await turns.update(jobId, tid, (j) => {
        j.acceptedUserId = acceptedUserId
      })

      let lastPartial = 0
      const reply = await waitForReply(page, acceptedUserId, boundUrl, async (partial) => {
        if (Date.now() - lastPartial < 2000) return
        lastPartial = Date.now()
        await turns.update(jobId, tid, (j) => {
          j.status = 'streaming'
          j.reply = partial
        })
      })

      if (convIdOf(page.url()) !== convIdOf(boundUrl)) {
        await page.goto(boundUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await sleep(jitter(1500, 3000))
      }
      // Final verification: the accepted turn still says exactly this
      // prompt (via the API; the DOM renders markdown, not authored text).
      const fin = await fetchConversationMessages(page, convIdOf(boundUrl))
      const lastUser = fin && fin.msgs ? [...fin.msgs].reverse().find((m) => m.role === 'user') : null
      if (!lastUser || lastUser.id !== acceptedUserId || normPrompt(lastUser.text) !== normPrompt(job.prompt)) {
        throw new Error("final verification failed: the conversation's last user message is not this turn's prompt")
      }

      await turns.update(jobId, tid, (j) => {
        j.status = 'done'
        j.reply = reply
        j.url = boundUrl
        j.error = null
        j.history.push({ role: 'assistant', text: reply })
      })
      notify('chatgpt-web: done', reply.slice(0, 90))
    })
  } catch (e) {
    let msg = String(e && e.message ? e.message : e)
    if (/singleton/i.test(msg)) msg = 'profile is in use — quit the chatgpt-web Chrome window first'
    await fail(msg)
  } finally {
    await updateState((st) => {
      st.lastTurnEnd = Date.now()
    })
  }
}

export async function runLogin() {
  await ensureBrowser()
  setDaemonVisible(true)
  console.error('chatgpt-web Chrome is open — log in to ChatGPT in its window. Waiting up to 5 minutes...')
  await withPage(
    async (page) => {
      await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const deadline = Date.now() + 300000
      for (;;) {
        const state = await classifyPage(page)
        if (state === 'in') return true
        if (Date.now() > deadline) throw new Error('timed out waiting for login (5 min)')
        await sleep(1500)
      }
    },
    { keepVisible: true }
  )
  console.error('verified: logged in.')
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
    const result = await page.evaluate(async () => {
      const session = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json())
      const token = session && session.accessToken
      if (!token) return { error: 'no session token', items: [] }
      const items = []
      let offset = 0
      let lastError = null
      let hitCap = false
      const limit = 50
      for (;;) {
        const r = await fetch('/backend-api/conversations?offset=' + offset + '&limit=' + limit + '&order=updated', {
          credentials: 'include',
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        })
        if (!r.ok) {
          lastError = 'conversations http ' + r.status
          break
        }
        const j = await r.json()
        const batch = j.items || []
        items.push(...batch)
        if (batch.length < limit || items.length >= 200) {
          hitCap = items.length >= 200
          break
        }
        offset += limit
      }
      return { items, lastError, hitCap }
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
      const known = new Set(outcome.items.map((it) => String(it.id || '')))
      const wanted = deleteAll ? [...known] : deleteIds
      const unknown = wanted.filter((id) => !known.has(id))
      if (unknown.length) {
        console.error('not in visible chat list (cap 200): ' + unknown.join(', '))
        process.exitCode = 1
      }
      const targets = wanted.filter((id) => known.has(id))
      if (!targets.length) return
      // Soft-delete via the same endpoint the sidebar uses: is_visible=false
      // moves the thread to Deleted chats (30-day recovery). The old
      // `PATCH /backend-api/conversation?id=` form started returning 405
      // (verified 2026-09-17); the path-parameter form is the current one.
      const del = await page.evaluate(async (ids) => {
        const session = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json())
        const token = session && session.accessToken
        if (!token) return { error: 'no session token' }
        const headers = { Authorization: 'Bearer ' + token, Accept: 'application/json', 'Content-Type': 'application/json' }
        const results = []
        for (const id of ids) {
          const r = await fetch('/backend-api/conversation/' + id, {
            method: 'PATCH',
            credentials: 'include',
            headers,
            body: JSON.stringify({ is_visible: false }),
          })
          results.push({ id, ok: r.ok, http: r.status })
          await new Promise((res) => setTimeout(res, 400))
        }
        return { results }
      }, targets)
      if (del.error) {
        console.error('delete failed: ' + del.error)
        process.exitCode = 1
        return
      }
      const ok = del.results.filter((r) => r.ok).length
      for (const r of del.results) {
        if (!r.ok) console.error('delete failed: ' + r.id + ' http ' + r.http)
      }
      console.log('deleted ' + ok + '/' + del.results.length + ' chats (recoverable 30 days in Settings > Deleted chats)')
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

async function fileBytes(page, resp, { kind = 'artifact' } = {}) {
  const bytes = Buffer.from(await resp.body())
  if (kind === 'artifact') return bytes // JSON is valid file content, too.
  if (kind !== 'descriptor') throw new Error('unknown file response kind')
  let descriptor
  try {
    descriptor = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error('file descriptor is not valid JSON')
  }
  if (typeof descriptor?.download_url !== 'string' || !descriptor.download_url) {
    throw new Error('file descriptor has no download_url')
  }
  const url = new URL(descriptor.download_url, resp.url())
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error('invalid artifact URL')
  const values = await page.evaluate(async (href) => {
    const response = await fetch(href, { credentials: 'same-origin', signal: AbortSignal.timeout(30000) })
    if (!response.ok) throw new Error('download http ' + response.status)
    return Array.from(new Uint8Array(await response.arrayBuffer()))
  }, url.href)
  return Buffer.from(values)
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
// fallback, and a clear failure message when the UI moves.
const MODEL_BTN_CANDIDATES = [
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

export function pickModelMatch(labels, want) {
  const w = normText(want).toLowerCase()
  const hits = labels.filter((l) => normText(l).toLowerCase().includes(w))
  if (hits.length === 1) return { label: hits[0] }
  if (hits.length > 1) {
    return { error: `"${want}" matches ${hits.length} models: ${hits.join(' | ')} — be more specific` }
  }
  return { error: `no model matches "${want}"` }
}

async function openModelMenu(page, btn) {
  const radios = page.locator('[role="menuitemradio"]')
  // Idempotent: toggling an already-open menu would close it, leaving the
  // retry with nothing to select.
  if ((await radios.count().catch(() => 0)) === 0) {
    // DOM click, not a playwright coordinate click: the radix trigger does
    // not open reliably under forced pointer events in the hidden window.
    await btn.evaluate((el) => el.click()).catch(() => {})
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

export async function runModel(want) {
  await withPage(async (page) => {
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await waitForComposer(page)
    const btn = await modelButton(page)
    if (!btn || (await btn.count().catch(() => 0)) === 0) {
      throw new Error('model picker not found — the web UI changed; update modelButton in runner.mjs')
    }
    const menu = await openModelMenu(page, btn)
    if (!menu || !menu.labels.filter(Boolean).length) {
      await page.keyboard.press('Escape').catch(() => {})
      throw new Error('model menu opened but listed no models — the web UI changed')
    }
    if (!want) {
      menu.labels.forEach((l, i) => console.log((i === menu.checked ? '* ' : '  ') + l))
      await page.keyboard.press('Escape').catch(() => {})
      return
    }
    const pick = pickModelMatch(menu.labels.filter(Boolean), want)
    if (pick.error) {
      console.error(pick.error)
      if (!pick.error.includes('matches ')) menu.labels.filter(Boolean).forEach((l) => console.error('  ' + l))
      await page.keyboard.press('Escape').catch(() => {})
      process.exitCode = 1
      return
    }
    const applied = await applyModelSelection(page, btn, menu, pick.label)
    if (!applied) {
      console.error(`could not confirm "${pick.label}" was selected — check the picker manually`)
      process.exitCode = 1
      return
    }
    console.log(`model set: ${pick.label}`)
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
const DOT_SELF_ROW_SEL = '.message-row.self'
const DOT_ROOM_LIST_LIMIT = 20
// The messaging endpoints 422 above their cap: rooms max 20, messages max 32
// (both are the page's own request sizes; 422 observed on 50 and 100).
const DOT_MSG_PAGE_LIMIT = 32

function dotRouteId(url) {
  const m = String(url || '').match(/\/dots\/([0-9a-fA-F-]{8,})/)
  return m ? m[1] : null
}

// authedFetchInPage runs a GET against a backend-api path from the page's
// origin so the session cookies and bearer token apply. Reads only.
async function authedFetchInPage(page, urlPath) {
  return page
    .evaluate(async (u) => {
      const s = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json())
      const token = s && s.accessToken
      if (!token) return { error: 'no session token' }
      const r = await fetch(u, {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
        credentials: 'include',
      })
      let body = null
      try {
        body = await r.json()
      } catch {}
      return { status: r.status, body }
    }, urlPath)
    .catch((e) => ({ error: e.message }))
}

// discoverDotRoom binds the dot: the /dots route redirects to the primary
// dot's thread (its slug ids the dot), and the rooms list names exactly one
// DM room per dot. Ambiguity refuses — two dots cannot share one record.
async function ensureDotRecord() {
  const existing = readDot()
  if (existing && existing.roomId && existing.dotId && existing.myId) return existing
  return withPage(async (page) => {
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
    const record = {
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
    await updateDot(() => record)
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

// messagesAfter applies the watermark by ID, with created_at only as a
// coarse floor: the server returns created_at with varying sub-second
// precision between fetches (observed live), so exact time equality cannot
// decide membership. Anything whose id is already counted is old; anything
// unseen but more than 2s before the watermark is an old backfill.
function messagesAfter(msgs, watermark) {
  if (!watermark) return msgs
  return msgs.filter((m) => !watermark.ids.includes(m.id) && m.at >= watermark.t - 2000)
}

function watermarkAt(msgs) {
  if (!msgs.length) return null
  const last = msgs[msgs.length - 1]
  return { t: last.at, ids: msgs.filter((m) => m.at === last.at).map((m) => m.id) }
}

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
  const dot = await ensureDotRecord()
  await withDotReadPage(async (page) => {
    const msgs = await fetchDotMessages(page, dot)
    const fresh = messagesAfter(msgs, dot.watermark)
    console.log(`dot room ${dot.roomId} (${dot.roomName})`)
    console.log(`thread: ${dot.url}`)
    console.log(`messages on record: ${msgs.length}, new since last poll: ${fresh.length}`)
    if (dot.lastSentAt) {
      console.log(`last sent: ${new Date(dot.lastSentAt).toISOString()} — ${String(dot.lastSentText || '').replace(/\s+/g, ' ').slice(0, 60)}`)
    } else {
      console.log('last sent: never (this record)')
    }
    if (msgs.length) console.log('latest: ' + renderDotMessage(msgs[msgs.length - 1]).slice(0, 120))
    if (fresh.length) console.log('run: chatgpt-web dot --poll')
  })
}

export async function runDotPoll(asJson) {
  const dot = await ensureDotRecord()
  await withDotReadPage(async (page) => {
    const msgs = await fetchDotMessages(page, dot)
    if (!dot.watermark) {
      const wm = watermarkAt(msgs)
      await updateDot((d) => ({ ...(d || dot), watermark: wm }))
      console.log(`tracking ${msgs.length} messages (watermark set, nothing printed) — run: chatgpt-web dot --context 20 for history`)
      return
    }
    const fresh = messagesAfter(msgs, dot.watermark)
    if (asJson) {
      console.log(JSON.stringify({ room: dot.roomId, url: dot.url, messages: fresh }, null, 2))
    } else {
      if (!fresh.length) console.log('no new messages')
      for (const m of fresh) console.log(renderDotMessage(m))
    }
    const wm = watermarkAt(msgs)
    if (wm) await updateDot((d) => ({ ...(d || dot), watermark: wm }))
  })
}

export async function runDotContext(count, asJson) {
  const dot = await ensureDotRecord()
  await withDotReadPage(async (page) => {
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
}

export async function runDotReset() {
  const had = await updateDot(() => null)
  console.log(had ? `cleared dot record for room ${had.roomId}` : 'no dot record stored')
}

// sendDotPromptGuarded is the dot-side mirror of sendPromptGuarded: it
// re-validates the /dots/<id> route, the composer contents, and the enabled
// Send button in one evaluation, then clicks. The dot composer's submit is
// button[aria-label="Send"], not #composer-submit-button (verified shape).
async function sendDotPromptGuarded(page, { dotId, prompt }) {
  const result = await page
    .evaluate(
      ({ wantDot, promptText, selectors }) => {
        if (location.origin !== 'https://chatgpt.com') return { error: 'unexpected origin' }
        const route = location.pathname.match(/^\/dots\/([0-9a-fA-F-]{8,})\/?$/)
        if (!route || route[1] !== wantDot) return { error: 'not on the dot thread before submission' }
        const composer = document.querySelector(selectors.composer)
        if (!composer) return { error: 'composer disappeared before submission' }
        const text = composer.tagName === 'TEXTAREA' ? composer.value : composer.innerText
        const flat = text.replace(/\r\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
        if (flat !== promptText) return { error: 'composer changed before submission' }
        const button = Array.from(document.querySelectorAll(selectors.submit)).find(
          (b) => !b.disabled && b.getAttribute('aria-disabled') !== 'true' && b.offsetParent !== null
        )
        if (!button) return { error: 'dot Send button is missing or disabled' }
        button.click()
        return { ok: true }
      },
      {
        wantDot: dotId,
        promptText: normPrompt(prompt),
        selectors: { composer: COMPOSER_SEL, submit: DOT_SUBMIT_SEL },
      }
    )
    .catch((e) => ({ error: e.message }))
  if (!result?.ok) throw new Error('dot submission guard: ' + (result?.error || 'unknown result'))
}

export async function runDotSend(text) {
  if (!text || !String(text).trim()) throw new Error('dot message is empty')
  const prompt = String(text)
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
      const priorSelfRows = await page.locator(DOT_SELF_ROW_SEL).count().catch(() => 0)
      const prior = await fetchDotMessages(page, dot, 20)
      const priorMineIds = prior.filter((m) => m.mine).map((m) => m.id)

      await typePrompt(page, composer, prompt)
      await sendDotPromptGuarded(page, { dotId: dot.dotId, prompt })
      await updateState((st) => {
        st.lastSendAt = Date.now()
      })

      // Acceptance: a NEW message authored by me whose authored text matches,
      // API-first; the DOM self-row count is the fallback if the endpoint
      // hiccups. The dot surface has no /c/<id> accepted-prompt endpoint.
      const deadline = Date.now() + 60000
      let accepted = null
      while (Date.now() < deadline && !accepted) {
        try {
          const now = await fetchDotMessages(page, dot, 20)
          accepted =
            now.find((m) => m.mine && !priorMineIds.includes(m.id) && normPrompt(m.text) === normPrompt(prompt)) || null
        } catch {}
        if (!accepted) {
          const rows = await page.locator(DOT_SELF_ROW_SEL).count().catch(() => 0)
          if (rows > priorSelfRows) {
            accepted = { id: 'dom-self-row', at: Date.now(), iso: new Date().toISOString(), mine: true, text: prompt }
          }
        }
        if (!accepted) await sleep(jitter(1500, 2500))
      }
      if (!accepted) throw new Error('the dot message was not observed as sent — check the thread manually')

      // The watermark moves to the sent message, not the room tip: a fast
      // dot reply must survive for the next poll.
      const wm = { t: accepted.at, ids: [accepted.id] }
      await updateDot((d) => ({
        ...(d || dot),
        watermark: wm,
        lastSentAt: Date.now(),
        lastSentText: prompt,
      }))
      console.log(`sent to dot room ${dot.roomId}`)
      console.log(`thread: ${dot.url}`)
      console.log(`message: ${String(prompt).replace(/\s+/g, ' ').slice(0, 80)}`)
      console.log('replies land on their own schedule — read them: chatgpt-web dot --poll')
    })
  })
}

export async function runStatus() {
  const up = !!(await cdpVersion())
  const mode = !up ? '' : chromeIsHeadlessBin() ? ', headless' : wantHeadless() ? ', hidden' : ', windowed'
  console.log('daemon:', up ? 'up (CDP port ' + CDP_PORT + mode + ')' : 'down (next command starts it)')
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

const [cmd, arg, turnId] = process.argv.slice(2)
if (cmd === 'job') {
  await runTurn(arg, turnId)
} else if (cmd === 'resume') {
  await runResume(arg, turnId)
}
