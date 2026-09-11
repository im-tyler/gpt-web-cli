#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import {
  PROFILE_DIR,
  HOME,
  readJob,
  writeJob,
  sleep,
  limits,
  withLock,
  updateState,
} from './jobs.mjs'

const jitter = (a, b) => a + Math.random() * (b - a)

const CHAT_URL = 'https://chatgpt.com/'
const TURN_TIMEOUT_MS = parseInt(process.env.CHATGPT_WEB_TIMEOUT || '300', 10) * 1000
const CDP_PORT = process.env.CHATGPT_WEB_CDP_PORT || '9777'
const CDP_URL = 'http://127.0.0.1:' + CDP_PORT

const COMPOSER_SEL = '#prompt-textarea, textarea[data-id], div[contenteditable="true"]'
const ASSISTANT_SEL = '[data-message-author-role="assistant"]'
const USER_SEL = '[data-message-author-role="user"]'
const MESSAGE_SEL = '[data-message-author-role]'
const MESSAGE_ID_ATTR = 'data-message-id'
const STOP_SEL = '[data-testid="stop-button"], button[aria-label*="stop" i]'
const SEND_SEL = '[data-testid="send-button"], button[aria-label*="send" i]'
const LOGIN_SEL = '[data-testid="login-button"], button:has-text("Log in")'
const NEW_CHAT_SEL = 'nav a[href="/"], [data-testid*="new-chat"] a, a:has-text("New chat")'
const SUBMIT_SEL = '#composer-submit-button, [data-testid="send-button"]'

function convIdOf(url) {
  const m = String(url || '').match(/\/c\/([0-9a-fA-F-]{8,})/)
  return m ? m[1] : null
}

function normText(s) {
  return String(s || '').replace(/\s+/g, ' ').trim()
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
    const out = execSync('pgrep -lf "user-data-dir=' + PROFILE_DIR + '"', { encoding: 'utf8' })
    return /--headless/.test(out)
  } catch {
    return false
  }
}

function daemonPid() {
  try {
    const out = execSync('lsof -nP -t -iTCP:' + CDP_PORT + ' -sTCP:LISTEN', { encoding: 'utf8' })
    const n = parseInt(out.trim().split('\n')[0], 10)
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

function setDaemonVisible(show) {
  if (process.platform !== 'darwin') return
  const pid = daemonPid()
  if (!pid) return
  try {
    execSync(
      'osascript -e \'tell application "System Events"\' -e \'set visible of (first process whose unix id is ' +
        pid +
        ') to ' +
        show +
        "' -e 'end tell'",
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

function profileBusy() {
  try {
    execSync('pgrep -f "user-data-dir=' + PROFILE_DIR + '"', { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

async function cdpAlive() {
  try {
    const res = await fetch(CDP_URL + '/json/version', { signal: AbortSignal.timeout(1500) })
    return res.ok
  } catch {
    return false
  }
}

// The daemon identity file answers one question on reuse: is the Chrome on
// this CDP port the one this HOME started, on this profile? A healthy port
// alone used to be enough to send through whatever profile happened to own
// it (F13).
const DAEMON_FILE = path.join(HOME, 'daemon.json')

function readDaemonIdentity() {
  try {
    return JSON.parse(fs.readFileSync(DAEMON_FILE, 'utf8'))
  } catch {
    return null
  }
}

async function verifyDaemonIdentity() {
  const ident = readDaemonIdentity()
  if (!ident) return
  if (ident.profileDir && ident.profileDir !== PROFILE_DIR) {
    throw new Error(
      `CDP port ${CDP_PORT} belongs to a daemon on profile ${ident.profileDir}, not this HOME's ${PROFILE_DIR} — ` +
        'quit that Chrome or set CHATGPT_WEB_CDP_PORT for this home'
    )
  }
  if (ident.pid && daemonPid() && ident.pid !== daemonPid()) {
    // Port is held by a different process than the recorded daemon; not
    // necessarily wrong after a restart, but combined with a foreign profile
    // record above it is refused. With the same profile, refresh below.
  }
}

function writeDaemonIdentity(pid) {
  try {
    fs.writeFileSync(
      DAEMON_FILE,
      JSON.stringify({ pid, profileDir: PROFILE_DIR, cdpPort: CDP_PORT, at: Date.now() }, null, 2)
    )
  } catch {}
}

async function ensureBrowser() {
  if (await cdpAlive()) {
    if (chromeIsHeadlessBin()) {
      throw new Error(
        'daemon is Chrome --headless (Cloudflare-blocked) — quit it and retry; CHATGPT_WEB_HEADLESS=1 hides a headed window'
      )
    }
    await verifyDaemonIdentity()
    if (wantHeadless()) await hideDaemon()
    return
  }
  // Startup is serialised: two cold starts racing each both spawned Chrome
  // and the loser diagnosed the winner's not-yet-ready port as a profile
  // without debugging (F14).
  await withLock('daemon-startup', async () => {
    if (await cdpAlive()) return
    if (profileBusy()) {
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
    const child = spawn(bin, args, { detached: true, stdio: 'ignore' })
    child.on('error', (e) => {
      // Exists-but-not-executable surfaces here, not as a throw (F15).
      throw new Error('Chrome failed to start: ' + e.message)
    })
    child.unref()
    const deadline = Date.now() + 20000
    while (Date.now() < deadline) {
      if (await cdpAlive()) {
        writeDaemonIdentity(daemonPid())
        return
      }
      // Early exit: a Chrome that died immediately should fail now, not run
      // out the whole readiness window (F15).
      try {
        process.kill(child.pid, 0)
      } catch {
        throw new Error('chatgpt-web Chrome exited immediately after starting')
      }
      await sleep(300)
    }
    throw new Error('chatgpt-web Chrome started but the debugging port never came up')
  }, { staleMs: 60000, timeoutMs: 120000 })
  if (wantHeadless()) await hideDaemon()
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
  await ensurePageTarget()
  const browser = await chromium.connectOverCDP(CDP_URL, { noDefaults: true })
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
// mounted transcript, and an empty composer. Treating an unreadable editor
// as empty made the check fail open exactly when it mattered (F06).
async function freshChatReady(page) {
  if (convIdOf(page.url())) return false
  const mounted = await page.locator(MESSAGE_SEL).count().catch(() => 0)
  if (mounted > 0) return false
  const composer = page.locator(COMPOSER_SEL).first()
  if ((await composer.count().catch(() => 0)) === 0) return false
  const text = await composer
    .evaluate((el) => (el.tagName === 'TEXTAREA' ? el.value : el.innerText))
    .catch(() => null)
  if (text === null) return false
  return !text.trim()
}

async function ensureFreshChat(page) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await sleep(jitter(1500, 2500))
    if (await freshChatReady(page)) return
    if (!convIdOf(page.url())) {
      const mounted = await page.locator(MESSAGE_SEL).count().catch(() => 0)
      if (mounted === 0) {
        const composer = page.locator(COMPOSER_SEL).first()
        if ((await composer.count().catch(() => 0)) > 0) {
          await composer.click({ force: true }).catch(() => {})
          await page.keyboard
            .press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A')
            .catch(() => {})
          await page.keyboard.press('Backspace').catch(() => {})
          const clearDeadline = Date.now() + 5000
          while (Date.now() < clearDeadline) {
            if (await freshChatReady(page)) return
            await sleep(500)
          }
        }
      }
    }
    const newChat = page.locator(NEW_CHAT_SEL).first()
    if ((await newChat.count().catch(() => 0)) > 0) {
      await newChat.click({ force: true, timeout: 10000 }).catch(() => {})
      const deadline = Date.now() + 10000
      while (Date.now() < deadline) {
        if (await freshChatReady(page)) return
        await sleep(500)
      }
    }
    await page.keyboard
      .press(process.platform === 'darwin' ? 'Meta+Shift+O' : 'Control+Shift+O')
      .catch(() => {})
    const shortcutDeadline = Date.now() + 10000
    while (Date.now() < shortcutDeadline) {
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
  throw new Error(
    `tab is not on the job's conversation (want ${want}, at ${page.url()}) — refusing to send`
  )
}

async function captureConversationUrl(page, jobId) {
  const deadline = Date.now() + 60000
  while (Date.now() < deadline) {
    const id = convIdOf(page.url())
    if (id) {
      const url = page.url()
      const j = readJob(jobId)
      if (j && j.status !== 'error') {
        j.url = url
        await writeJob(j)
      }
      return url
    }
    await sleep(500)
  }
  throw new Error('conversation url never appeared after send (no /c/<id>)')
}

// Prompt verification identifies THIS turn: the last user message must be
// this prompt, not merely contain its first characters — two prompts sharing
// a preamble, or a short prompt appearing inside an unrelated message, used
// to pass (F02). Long prompts can render truncated behind "Show more"; for
// those the full visible prefix must match, and it must be long enough that
// coincidence is implausible.
async function verifyPromptLanded(page, prompt) {
  const want = normText(prompt)
  if (!want) throw new Error('reply verification skipped: empty prompt')
  const users = page.locator(USER_SEL)
  const n = await users.count().catch(() => 0)
  if (n === 0) throw new Error('reply verification failed: no user message in conversation')
  const last = normText(await users.last().innerText().catch(() => ''))
  const ok = last === want || (last.length >= 60 && want.startsWith(last))
  if (!ok) {
    throw new Error(
      "reply verification failed: the conversation's last user message is not this turn's prompt — " +
        'refusing to record a possibly foreign reply (conversation cross-talk guard)'
    )
  }
}

// assistantIds snapshots the mounted assistant messages' identities, so the
// reply can be tracked by WHO it is rather than by counting messages. Counts
// misidentified a previous turn's answer as this turn's after navigation
// (F04) and could consume the very response they were waiting for (F05).
async function assistantIds(page) {
  return page.locator(ASSISTANT_SEL).evaluateAll((els, attr) =>
    els.map((el) => el.closest('[' + attr + ']')?.getAttribute(attr) || '').filter(Boolean),
    MESSAGE_ID_ATTR
  ).catch(() => [])
}

async function replyTextById(page, id) {
  return page
    .evaluate(
      ([sel, attr, wantId]) => {
        const el = document.querySelector(`[${attr}="${wantId}"]`)
        if (!el) return null
        const inner = el.querySelector(sel) || el.closest(sel)
        return inner ? inner.innerText : null
      },
      [ASSISTANT_SEL, MESSAGE_ID_ATTR, id]
    )
    .catch(() => null)
}

// waitForReply tracks the first assistant message that did not exist before
// the send. Drift away from the bound conversation re-navigates and waits
// for that same message again; a previous turn's answer can never be
// returned as this one's, no matter what remounts around it.
async function waitForReply(page, knownIds, boundUrl, onPartial) {
  const boundId = convIdOf(boundUrl)
  const known = new Set(knownIds)
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
    const ids = await assistantIds(page)
    const fresh = ids.find((id) => !known.has(id))
    if (fresh) {
      streak++
      if (streak >= 2) {
        replyId = fresh
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

  let lastText = ''
  let stable = 0
  while (Date.now() - started < TURN_TIMEOUT_MS) {
    if (!(await onBound().catch(() => false))) {
      await rebind()
      continue
    }
    const text = await replyTextById(page, replyId)
    if (text !== null && text === lastText && text.trim()) {
      stable++
      const busy = await page.locator(STOP_SEL).count().catch(() => 0)
      if (stable >= 2 && !busy) return text.trim()
    } else {
      stable = 0
      if (text !== null && text !== lastText && onPartial && text.trim()) onPartial(text.trim())
      lastText = text ?? ''
    }
    await sleep(jitter(700, 1300))
  }
  throw new Error('response never finished streaming (raise CHATGPT_WEB_TIMEOUT)')
}

// uploadFiles waits for the attachments to actually be ready in the
// composer, not merely for their names to appear somewhere on the page —
// body text also contains old conversation mentions and error toasts (F21).
async function uploadFiles(page, paths) {
  const fcP = page.waitForEvent('filechooser', { timeout: 12000 })
  fcP.catch(() => {})
  await page.locator('[data-testid="composer-plus-btn"]').click({ timeout: 30000, force: true })
  await sleep(jitter(600, 1200))
  await page.getByText(/upload from computer/i).first().click({ timeout: 30000, force: true })
  const fc = await fcP
  await fc.setFiles(paths.map((p) => path.resolve(p)))
  const names = paths.map((p) => path.basename(p))
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const body = await page.locator('body').innerText().catch(() => '')
    const uploading = /uploading|upload failed/i.test(body || '')
    const allShown = names.every((n) => body.includes(n))
    if (allShown && !uploading) {
      await sleep(jitter(2000, 3000))
      const recheck = await page.locator('body').innerText().catch(() => '')
      if (names.every((n) => recheck.includes(n)) && !/uploading|upload failed/i.test(recheck)) {
        return
      }
    }
    await sleep(800)
  }
  throw new Error('upload never completed (attachments not ready)')
}

// sendPrompt submits only through an enabled button: both the ARIA state and
// the native disabled property are checked, because a natively disabled
// button without aria-disabled still received the click and the send was
// reported as made (F25).
async function sendPrompt(page) {
  await page.waitForFunction(
    () => {
      const b = document.querySelector('#composer-submit-button, [data-testid="send-button"]')
      return !!b && b.getAttribute('aria-disabled') !== 'true' && b.disabled !== true
    },
    null,
    { timeout: 180000 }
  )
  const clicked = await page.evaluate(() => {
    const b = document.querySelector('#composer-submit-button, [data-testid="send-button"]')
    if (!b || b.disabled || b.getAttribute('aria-disabled') === 'true') return false
    b.click()
    return true
  })
  if (!clicked) {
    const btn = page.locator(SUBMIT_SEL).first()
    if (!(await btn.isEnabled().catch(() => false))) {
      throw new Error('send button is disabled — prompt was not submitted')
    }
    await page.keyboard.press('Enter')
  }
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

export async function runTurn(jobId) {
  try {
    const job = readJob(jobId)
    if (!job) throw new Error('job not found: ' + jobId)
    await ensureBrowser()
    await withPage(async (page) => {
      await page.goto(job.url || CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      await waitForComposer(page)

      let boundUrl = job.url || null
      let knownIds = []
      let reply = null

      // Everything that authorises the destination — fresh-chat enforcement,
      // conversation binding, prompt typing, submission — happens inside the
      // send critical section, after pacing and uploads. Guards that ran
      // before the lock expired by submission time: an SPA resume during the
      // pacing window sent the prompt into a foreign conversation and
      // verified it there, because the prompt really had landed (F01).
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
        if (job.files && job.files.length) await uploadFiles(page, job.files)

        // The upload's menus and file dialogs are exactly when an SPA
        // redirect can land; re-authorise the destination before typing.
        if (job.url) {
          await assertBoundConversation(page, job)
        } else if (convIdOf(page.url())) {
          throw new Error(
            'the tab left the fresh chat during preparation — refusing to type into ' + page.url()
          )
        }

        knownIds = await assistantIds(page)
        await typePrompt(page, composer, job.prompt)
        await sendPrompt(page)
        await updateState((st) => {
          st.lastSendAt = Date.now()
        })
      })

      if (!boundUrl) boundUrl = await captureConversationUrl(page, jobId)

      // Partial output is published only after the conversation has been
      // verified to contain this turn's prompt; an unverified snapshot used
      // to stream foreign text into the job and stay there after a failed
      // final check (F03).
      let verifiedOnce = false
      let lastPartial = 0
      reply = await waitForReply(page, knownIds, boundUrl, async (partial) => {
        if (!verifiedOnce) {
          if (convIdOf(page.url()) !== convIdOf(boundUrl)) return
          try {
            await verifyPromptLanded(page, job.prompt)
            verifiedOnce = true
          } catch {
            return
          }
        }
        if (Date.now() - lastPartial < 2000) return
        lastPartial = Date.now()
        const j = readJob(jobId)
        if (j && j.status !== 'error') {
          j.status = 'streaming'
          j.reply = partial
          await writeJob(j)
        }
      })

      if (convIdOf(page.url()) !== convIdOf(boundUrl)) {
        await page.goto(boundUrl, { waitUntil: 'domcontentloaded', timeout: 60000 })
        await sleep(jitter(1500, 3000))
      }
      await verifyPromptLanded(page, job.prompt)
      const j = readJob(jobId)
      if (j && j.status !== 'error') {
        j.status = 'done'
        j.reply = reply
        j.url = boundUrl
        j.error = null
        j.history.push({ role: 'assistant', text: reply })
        await writeJob(j)
      }
      notify('chatgpt-web: done', reply.slice(0, 90))
    })
  } catch (e) {
    let msg = String(e && e.message ? e.message : e)
    if (/singleton/i.test(msg)) msg = 'profile is in use — quit the chatgpt-web Chrome window first'
    const j = readJob(jobId)
    if (j) {
      j.status = 'error'
      j.error = msg
      await writeJob(j)
    }
    notify('chatgpt-web: error', msg)
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
  await ensureBrowser()
  await withPage(async (page) => {
    await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
    const state = await classifyPage(page)
    if (state === 'out') {
      console.error('not logged in — run: chatgpt-web login')
      process.exitCode = 1
      return
    }
    if (state !== 'in') {
      console.error('session unknown — run: chatgpt-web login')
      process.exitCode = 1
      return
    }
    const result = await page.evaluate(async () => {
      const session = await fetch('/api/auth/session', { credentials: 'include' }).then((r) => r.json())
      const token = session && session.accessToken
      if (!token) return { error: 'no session token' }
      const items = []
      let offset = 0
      let lastError = null
      let hitCap = false
      const limit = 50
      for (;;) {
        const r = await fetch(
          '/backend-api/conversations?offset=' + offset + '&limit=' + limit + '&order=updated',
          {
            credentials: 'include',
            headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
          }
        )
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
    const items = result.items || []
    // A failed later page is a partial result and must say so with a nonzero
    // exit — printing fifty rows and exiting zero presented a truncated
    // account as the whole truth (F22).
    if (result.error && !items.length) {
      console.error(result.error)
      process.exitCode = 1
      return
    }
    if (!items.length) {
      console.log('no chats found')
      return
    }
    const idW = 36
    console.log(['ID'.padEnd(idW), 'STATUS'.padEnd(10), 'UPDATED'.padEnd(20), 'TITLE'].join(' '))
    for (const it of items) {
      const id = String(it.id || '')
      const status = it.async_status || 'idle'
      const updated = String(it.update_time || '').replace('T', ' ').slice(0, 16)
      const title = String(it.title || '').replace(/\s+/g, ' ').slice(0, 60)
      console.log([id.padEnd(idW), String(status).padEnd(10), updated.padEnd(20), title].join(' '))
    }
    if (result.lastError) {
      console.error(`partial listing: ${result.lastError} (showing ${items.length} fetched before the failure)`)
      process.exitCode = 1
    }
    if (result.hitCap) {
      console.error('listing capped at 200 conversations — older chats are not shown')
    }
  })
}

const ICON_SEL = '[data-testid="library-file-icon"]'
const CAPTURE_DEADLINE_MS = 5 * 60 * 1000

// onConversation verifies after every load that the tab still shows the
// requested conversation — a redirect to another chat used to be invisible
// to capture, which then clicked and returned whatever that chat showed
// (F18).
async function assertChatUrl(page, chatId) {
  await sleep(3000)
  if (convIdOf(page.url()) !== chatId) {
    throw new Error(`left the requested conversation (at ${page.url()}) — refusing to capture from it`)
  }
}

// captureChatFiles builds a per-card manifest. Both supported response forms
// are awaited before the single click (the old code armed the second watcher
// only after the first timed out, and a cache-served second click never
// re-fired it — F19). Indices are original and stable: a failed capture
// leaves a hole rather than shifting every later file down (F19).
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

    const estuaryP = page
      .waitForResponse((r) => /estuary\/content/.test(r.url()), { timeout: 8000 })
      .catch(() => null)
    const simpleP = page
      .waitForResponse((r) => /\/files\/.+\/simple/.test(r.url()), { timeout: 8000 })
      .catch(() => null)
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
    if (!id || out.some((f) => f.file && f.file.id === id)) {
      out.push({ index: i, ok: false, reason: id ? 'duplicate card' : 'no file id' })
      continue
    }
    let bytes = null
    try {
      bytes = await fileBytes(page, resp)
    } catch (e) {
      out.push({ index: i, ok: false, reason: e.message })
      continue
    }
    out.push({ index: i, ok: true, file: { id, name: name || id + '.bin', bytes } })
  }
  return out
}

async function fileBytes(page, resp) {
  let bytes = Buffer.from(await resp.body())
  const ct = resp.headers()['content-type'] || ''
  if (ct.includes('json')) {
    let du = null
    try {
      du = JSON.parse(bytes.toString('utf8')).download_url
    } catch {}
    if (du) {
      bytes = Buffer.from(
        await page.evaluate(async (u) => {
          const r = await fetch(u, { credentials: 'include' })
          // An error body saved as the artifact is worse than no artifact:
          // check the status before reading (F20).
          if (!r.ok) throw new Error('download http ' + r.status)
          return new Uint8Array(await r.arrayBuffer())
        }, du)
      )
    }
  }
  return bytes
}

// manifestFor lists a chat's files, failing loudly when any card could not
// be captured rather than compacting the successes (F19).
async function manifestFor(page, chatId) {
  const manifest = await captureChatFiles(page, chatId)
  const failed = manifest.filter((m) => !m.ok)
  if (failed.length === manifest.length && failed.length > 0) {
    throw new Error(`no file could be captured: ${failed[0].reason}`)
  }
  return manifest
}

export async function runFiles(chatId) {
  if (!chatId) throw new Error('usage: chatgpt-web files <chat-id>')
  await ensureBrowser()
  await withPage(async (page) => {
    const manifest = await manifestFor(page, chatId)
    let shown = 0
    manifest.forEach((m) => {
      if (!m.ok) {
        console.log(String(m.index + 1).padEnd(4), `(capture failed: ${m.reason})`)
        return
      }
      shown++
      console.log(String(m.index + 1).padEnd(4), m.file.name.slice(0, 48).padEnd(50), m.file.id)
    })
    if (!shown) console.log('no files')
  })
}

// saveArtifact writes bytes under a collision-safe, never-clobbering name.
// Distinct files whose sanitized names collide used to overwrite each other,
// and so did pre-existing files in the target directory (F17). Symlinked
// destinations are refused rather than followed.
export function saveArtifact(dir, name, id, bytes) {
  const safeBase = name.replace(/[^A-Za-z0-9._-]/g, '_') || 'file'
  const ext = path.extname(safeBase)
  const stem = safeBase.slice(0, safeBase.length - ext.length)
  const idTag = String(id).replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
  let dest = path.join(dir, `${stem}-${idTag}${ext}`)
  for (let n = 2; ; n++) {
    let st
    try {
      st = fs.lstatSync(dest)
    } catch {
      st = null
    }
    if (st && st.isSymbolicLink()) {
      throw new Error(`refusing to write through symlink ${dest}`)
    }
    if (!st) break
    dest = path.join(dir, `${stem}-${idTag}-${n}${ext}`)
  }
  // O_EXCL: the name we settled on is ours alone; no concurrent writer can
  // slip in between the check above and the create below.
  const fd = fs.openSync(dest, 'wx')
  try {
    fs.writeSync(fd, bytes)
  } finally {
    fs.closeSync(fd)
  }
  return dest
}

export async function runDownload(chatId, what, outdir) {
  if (!chatId) throw new Error('usage: chatgpt-web download <chat-id> [n|all] [outdir]')
  const target = what || 'all'
  const dir = outdir || process.cwd()
  await ensureBrowser()
  await withPage(async (page) => {
    const manifest = await manifestFor(page, chatId)
    const goods = manifest.filter((m) => m.ok)
    if (!goods.length) {
      console.log('no files')
      return
    }
    let picks
    if (target === 'all') {
      picks = goods
    } else {
      const n = parseInt(target, 10)
      if (!Number.isFinite(n) || n < 1 || n > manifest.length) {
        console.error(`no file #${target} (cards 1..${manifest.length})`)
        process.exitCode = 1
        return
      }
      // n addresses the card's original position — a hole left by a failed
      // capture is a hard error for that n, not a silent shift (F19).
      const entry = manifest[n - 1]
      if (!entry.ok) {
        console.error(`file #${n} could not be captured: ${entry.reason}`)
        process.exitCode = 1
        return
      }
      picks = [entry]
    }
    fs.mkdirSync(dir, { recursive: true })
    for (const m of picks) {
      const p = saveArtifact(dir, m.file.name, m.file.id, m.file.bytes)
      console.log(p, `(${m.file.bytes.length} bytes)`)
    }
  })
}

export async function runStatus() {
  const up = await cdpAlive()
  const mode = !up ? '' : chromeIsHeadlessBin() ? ', headless' : wantHeadless() ? ', hidden' : ', windowed'
  console.log('daemon:', up ? 'up (CDP port ' + CDP_PORT + mode + ')' : 'down (next command starts it)')
  const { readState, runningJobs } = await import('./jobs.mjs')
  const s = readState()
  const L = limits()
  const hourChats = (s.newChats || []).filter((t) => Date.now() - t < 3600000).length
  const rs = runningJobs()
  console.log(
    `usage: ${(s.turns || {})[new Date().toISOString().slice(0, 10)] || 0}/${L.maxTurnsDay} turns today, ` +
      `${hourChats}/${L.maxNewChatsHour} new chats this hour, min gap ${L.minGapMs / 1000}s, ` +
      `max ${L.maxTabs} concurrent`
  )
  console.log(
    'running jobs:',
    rs.length ? rs.map((j) => j.id + ' — ' + (j.prompt || '').slice(0, 40)).join(' | ') : 'none'
  )
  if (up) {
    await withPage(async (page) => {
      await page.goto(CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const state = await classifyPage(page, 10000)
      console.log(
        'session:',
        state === 'in' ? 'logged in' : state === 'out' ? 'logged out — run: chatgpt-web login' : 'unknown'
      )
    })
  }
}

// The model picker is the most volatile DOM surface the CLI touches — hence
// candidate selectors plus a composer-scoped positional fallback, and a clear
// failure message rather than silence when the UI moves. As of this writing
// it is a button[aria-haspopup=menu] beside the composer showing the current
// model's short name, with no stable testid.
const MODEL_BTN_CANDIDATES = [
  '[data-testid="model-switcher-dropdown-button"]',
  '#model-switcher-dropdown-button',
]

async function modelButton(page) {
  for (const sel of MODEL_BTN_CANDIDATES) {
    const loc = page.locator(sel).first()
    if ((await loc.count().catch(() => 0)) > 0) return loc
  }
  // Composer-scoped: the menu-opener inside the composer's container. This
  // excludes the profile menu and sidebar "More", which live elsewhere, and
  // the sibling pills that are not the model picker ("Thinking effort",
  // tools, attach). The found element is marked so the rest of the command
  // can use a locator.
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

// pickModelMatch resolves a user's fragment against the menu labels:
// exactly one substring hit selects, several hits ask for more specificity,
// none lists what exists.
export function pickModelMatch(labels, want) {
  const w = normText(want).toLowerCase()
  const hits = labels.filter((l) => normText(l).toLowerCase().includes(w))
  if (hits.length === 1) return { label: hits[0] }
  if (hits.length > 1) {
    return { error: `"${want}" matches ${hits.length} models: ${hits.join(' | ')} — be more specific` }
  }
  return { error: `no model matches "${want}"` }
}

// runModel lists or sets the account's model. Selection is manual only: the
// web UI's "retry with a faster model" banners are information for the user,
// never a trigger the CLI acts on. ChatGPT persists the choice for future
// chats, so this is a switch, not a per-turn option.
// openModelMenu force-clicks the picker and returns the radio-item labels
// plus their locator, or null when the menu cannot be read. The checked
// index is included: it is the only trustworthy statement of the current
// model (the pill's label can be anything).
async function openModelMenu(page, btn) {
  await btn.click({ force: true, timeout: 10000 })
  const radios = page.locator('[role="menuitemradio"]')
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

export async function runModel(want) {
  await ensureBrowser()
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
    // Selection is verified by the menu's own checked state, never by the
    // pill's label — and retried once, because a force-click into a Radix
    // popover occasionally does not take.
    let applied = false
    for (let attempt = 0; attempt < 2 && !applied; attempt++) {
      const items = (await openModelMenu(page, btn)) || menu
      const idx = items.labels.findIndex((l) => l === pick.label)
      if (idx < 0) break
      await items.radios.nth(idx).click({ force: true, timeout: 10000 })
      await sleep(1500)
      const check = (await openModelMenu(page, btn)) || items
      applied = check.labels[check.checked] === pick.label
      await page.keyboard.press('Escape').catch(() => {})
    }
    if (!applied) {
      console.error(`could not confirm "${pick.label}" was selected — check the picker manually`)
      process.exitCode = 1
      return
    }
    console.log(`model set: ${pick.label}`)
  })
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'job') {
  await runTurn(arg)
}
