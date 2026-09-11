#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { execSync, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import { chromium } from 'playwright-core'
import {
  PROFILE_DIR,
  HOME,
  sleep,
  limits,
  withLock,
  updateState,
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
const SUBMIT_SEL = '#composer-submit-button, [data-testid="send-button"]'
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
const normPrompt = (s) => String(s || '').replace(/\r\n/g, '\n').trim()

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

async function withPage(fn) {
  const identity = await ensureBrowser()
  // Connect through the verified browser endpoint, not the mutable HTTP
  // port; the tab is created through this connection.
  const browser = await chromium.connectOverCDP(identity.websocketUrl, { noDefaults: true })
  let page = null
  try {
    const context = browser.contexts()[0]
    if (!context) throw new Error('no default context over CDP')
    page = await context.newPage()
    return await fn(page)
  } finally {
    if (page) await page.close().catch(() => {})
    await browser.close().catch(() => {})
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

async function waitForComposer(page) {
  const deadline = Date.now() + 45000
  for (;;) {
    const state = await classifyPage(page)
    if (state === 'in') {
      const el = page.locator(COMPOSER_SEL).first()
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
        if (text.replace(/\r\n/g, '\n').trim() !== promptText) return { error: 'composer changed before submission' }
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

// assertAcceptedPrompt requires a NEW user message whose full text is this
// prompt. Text alone cannot identify a turn — repeated prompts and
// truncated renderings both pass it — so the message id must not have
// existed before the send, and the text must match completely. Where the UI
// truncates the display, verification fails closed instead of accepting a
// prefix.
function assertAcceptedPrompt({ priorIds, currentId, text, prompt }) {
  if (!currentId) return { error: 'no identified user message' }
  if (priorIds && priorIds.includes(currentId)) {
    return { error: 'user message existed before this send' }
  }
  const shown = normPrompt(text)
  const want = normPrompt(prompt)
  if (shown !== want) {
    return {
      error:
        shown.length < want.length && want.startsWith(shown)
          ? 'prompt is displayed truncated; cannot verify the full submission — expand or shorten'
          : 'displayed user message does not match this prompt',
    }
  }
  return { id: currentId }
}

async function waitForAcceptedPrompt(page, prompt, priorIds, boundUrl, deadlineMs) {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (boundUrl && convIdOf(page.url()) !== convIdOf(boundUrl)) {
      await page.goto(boundUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await sleep(jitter(1500, 3000))
    }
    const snap = await page
      .locator(USER_SEL)
      .last()
      .evaluate((el, attr) => {
        const container = el.closest('[' + attr + ']')
        return { currentId: container ? container.getAttribute(attr) : null, text: el.innerText }
      }, MESSAGE_ID_ATTR)
      .catch(() => null)
    if (snap) {
      const verdict = assertAcceptedPrompt({ priorIds, ...snap, prompt })
      if (!verdict.error) return verdict.id
    }
    await sleep(800)
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
        scope.querySelectorAll('[data-testid*="attach" i], [data-testid*="file" i], [class*="attachment" i]')
      ).filter((el) => el.closest('[data-message-author-role]') === null)
      const files = []
      for (const chip of chips) {
        const name = (chip.innerText || '').trim().split('\n')[0]?.trim() || ''
        const text = (chip.innerText || '').toLowerCase()
        if (!name) continue
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

async function uploadFiles(page, paths) {
  const fcP = page.waitForEvent('filechooser', { timeout: 12000 })
  fcP.catch(() => {})
  await page.locator('[data-testid="composer-plus-btn"]').click({ timeout: 30000, force: true })
  await sleep(jitter(600, 1200))
  await page.getByText(/upload from computer/i).first().click({ timeout: 30000, force: true })
  const fc = await fcP
  await fc.setFiles(paths.map((p) => path.resolve(p)))
  await waitForAttachments(page, paths.map((p) => path.basename(p)), 45000)
}

// The reply is the first assistant message AFTER the accepted user message,
// in document order — not merely "one that didn't exist before the send",
// which a late-mounting previous answer could satisfy.
async function replyAfterUser(page, acceptedUserId) {
  return page
    .evaluate(
      ([aSel, uSel, attr, userId]) => {
        const users = Array.from(document.querySelectorAll('[' + attr + '="' + userId + '"] ' + uSel + ', ' + uSel))
        const accepted = document.querySelector(`[${attr}="${userId}"]`)
        if (!accepted) return null
        const assistants = Array.from(document.querySelectorAll(aSel))
        for (const a of assistants) {
          const container = a.closest('[' + attr + ']')
          if (container && accepted.compareDocumentPosition(container) & Node.DOCUMENT_POSITION_FOLLOWING) {
            return { id: container.getAttribute(attr), text: a.innerText }
          }
        }
        return null
      },
      [ASSISTANT_SEL, USER_SEL, MESSAGE_ID_ATTR, acceptedUserId]
    )
    .catch(() => null)
}

async function waitForReply(page, acceptedUserId, boundUrl, onPartial) {
  const boundId = convIdOf(boundUrl)
  const onBound = async () => convIdOf(page.url()) === boundId
  const rebind = async () => {
    await page.goto(boundUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await sleep(jitter(1500, 3000))
  }
  const started = Date.now()

  let replyId = null
  let streak = 0
  while (Date.now() - started < TURN_TIMEOUT_MS) {
    if (!(await onBound().catch(() => false))) {
      await rebind()
      streak = 0
      await sleep(jitter(600, 1200))
      continue
    }
    const found = await replyAfterUser(page, acceptedUserId)
    if (found && found.id) {
      streak++
      if (streak >= 2) {
        replyId = found.id
        break
      }
    } else {
      streak = 0
    }
    await sleep(jitter(600, 1200))
  }
  if (!replyId) {
    throw new Error(`no response started within ${Math.round(TURN_TIMEOUT_MS / 1000)}s`)
  }

  const textOf = () =>
    page
      .evaluate(
        ([attr, id]) => {
          const el = document.querySelector(`[${attr}="${id}"]`)
          return el ? el.innerText : null
        },
        [MESSAGE_ID_ATTR, replyId]
      )
      .catch(() => null)

  let lastText = ''
  let stable = 0
  while (Date.now() - started < TURN_TIMEOUT_MS) {
    if (!(await onBound().catch(() => false))) {
      await rebind()
      continue
    }
    let text = await textOf()
    if (text === null) {
      // The tracked message id vanished: the streaming skeleton carries an
      // id that is replaced when the real message mounts. Re-acquire by
      // document position instead of stalling on the dead id forever.
      const found = await replyAfterUser(page, acceptedUserId)
      if (found && found.id && found.id !== replyId) {
        replyId = found.id
        lastText = ''
        stable = 0
        continue
      }
      text = null
    }
    if (text !== null && text === lastText && text.trim()) {
      stable++
      const busy = await page.locator(STOP_SEL).count().catch(() => 0)
      if (stable >= 2 && !busy) return text.trim()
    } else {
      stable = 0
      if (text !== null && text !== lastText && onPartial && text.trim()) await onPartial(text.trim())
      lastText = text ?? ''
    }
    await sleep(jitter(700, 1300))
  }
  throw new Error('response never finished streaming (raise CHATGPT_WEB_TIMEOUT)')
}

function notify(title, body) {
  if (process.env.CHATGPT_WEB_NOTIFY === '0') return
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
      // prompt.
      const snap = await page
        .locator(USER_SEL)
        .last()
        .evaluate((el, attr) => {
          const container = el.closest('[' + attr + ']')
          return { currentId: container ? container.getAttribute(attr) : null, text: el.innerText }
        }, MESSAGE_ID_ATTR)
        .catch(() => null)
      if (!snap || snap.currentId !== acceptedUserId || normPrompt(snap.text) !== normPrompt(job.prompt)) {
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
  await withPage(async (page) => {
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const deadline = Date.now() + 300000
    for (;;) {
      const state = await classifyPage(page)
      if (state === 'in') return true
      if (Date.now() > deadline) throw new Error('timed out waiting for login (5 min)')
      await sleep(1500)
    }
  })
  console.error('verified: logged in.')
}

export async function runChats() {
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
    await btn.click({ force: true, timeout: 10000 })
  }
  await radios.first().waitFor({ state: 'attached', timeout: 8000 }).catch(() => {})
  const n = await radios.count().catch(() => 0)
  if (n === 0) return null
  const labels = []
  for (let i = 0; i < n; i++) {
    const t = normText(await radios.nth(i).innerText().catch(() => ''))
    labels.push(t)
  }
  const checked = await radios
    .evaluateAll((els) => els.findIndex((e) => e.getAttribute('data-state') === 'checked'))
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
    await items.radios.nth(idx).click({ force: true, timeout: 10000 })
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
}
