#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execSync } from 'node:child_process'
import { chromium } from 'playwright-core'
import { PROFILE_DIR, readJob, writeJob, sleep, readState, writeState, limits, dayKey, runningJob } from './jobs.mjs'

const jitter = (a, b) => a + Math.random() * (b - a)

const CHAT_URL = 'https://chatgpt.com/'
const TURN_TIMEOUT_MS = parseInt(process.env.CHATGPT_WEB_TIMEOUT || '300', 10) * 1000
const CDP_PORT = process.env.CHATGPT_WEB_CDP_PORT || '9777'
const CDP_URL = 'http://127.0.0.1:' + CDP_PORT

const COMPOSER_SEL = '#prompt-textarea, textarea[data-id], div[contenteditable="true"]'
const ASSISTANT_SEL = '[data-message-author-role="assistant"]'
const STOP_SEL = '[data-testid="stop-button"], button[aria-label*="stop" i]'
const SEND_SEL = '[data-testid="send-button"], button[aria-label*="send" i]'
const LOGIN_SEL = '[data-testid="login-button"], button:has-text("Log in")'

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

async function ensureBrowser() {
  if (await cdpAlive()) return
  if (profileBusy()) {
    throw new Error('chatgpt-web Chrome is open without remote debugging — quit it (Cmd+Q) and retry')
  }
  const bin = chromeBinary()
  if (!bin) throw new Error('no Chrome binary found — set CHATGPT_WEB_CHROME=/path/to/chrome')
  const child = spawn(
    bin,
    [
      '--remote-debugging-port=' + CDP_PORT,
      '--user-data-dir=' + PROFILE_DIR,
      '--no-first-run',
      '--no-default-browser-check',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' }
  )
  child.unref()
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    if (await cdpAlive()) return
    await sleep(300)
  }
  throw new Error('chatgpt-web Chrome started but the debugging port never came up')
}

async function withPage(fn) {
  const browser = await chromium.connectOverCDP(CDP_URL)
  try {
    const context = browser.contexts()[0]
    if (!context) throw new Error('no default context over CDP')
    let page = context.pages().find((p) => !p.isClosed())
    if (!page) page = await context.newPage()
    return await fn(page)
  } finally {
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
  await composer.click()
  const tag = await composer.evaluate((el) => el.tagName).catch(() => '')
  if (tag === 'TEXTAREA') await composer.fill(text)
  else await page.keyboard.insertText(text)
}

async function sendPrompt(page) {
  const btn = page.locator(SEND_SEL).last()
  try {
    await btn.click({ timeout: 4000 })
  } catch {
    await page.keyboard.press('Enter')
  }
}

async function waitForReply(page, before) {
  const msgs = page.locator(ASSISTANT_SEL)
  const started = Date.now()
  while (Date.now() - started < TURN_TIMEOUT_MS) {
    if ((await msgs.count().catch(() => 0)) > before) break
    await sleep(jitter(600, 1200))
  }
  if (!((await msgs.count().catch(() => 0)) > before)) {
    throw new Error(`no response started within ${Math.round(TURN_TIMEOUT_MS / 1000)}s`)
  }
  let lastText = ''
  let stable = 0
  while (Date.now() - started < TURN_TIMEOUT_MS) {
    const text = await msgs.last().innerText().catch(() => null)
    if (text !== null && text === lastText && text.trim()) {
      stable++
      const busy = await page.locator(STOP_SEL).count().catch(() => 0)
      if (stable >= 2 && !busy) return text.trim()
    } else {
      stable = 0
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

async function humanPace() {
  const s = readState()
  const L = limits()
  const since = Date.now() - (s.lastTurnEnd || 0)
  const gap = L.minGapMs + Math.random() * 8000
  if (since < gap) await sleep(gap - since)
}

export async function runTurn(jobId) {
  try {
    const job = readJob(jobId)
    if (!job) throw new Error('job not found: ' + jobId)
    await ensureBrowser()
    await withPage(async (page) => {
      await page.goto(job.url || CHAT_URL, { waitUntil: 'domcontentloaded', timeout: 60000 })
      const composer = await waitForComposer(page)
      await humanPace()
      await sleep(jitter(1500, 4000))
      const before = await page.locator(ASSISTANT_SEL).count()
      await typePrompt(page, composer, job.prompt)
      await sendPrompt(page)
      const reply = await waitForReply(page, before)
      const url = page.url()
      const j = readJob(jobId)
      j.status = 'done'
      j.reply = reply
      j.url = url
      j.error = null
      j.history.push({ role: 'assistant', text: reply })
      writeJob(j)
      notify('chatgpt-web: done', reply.slice(0, 90))
    })
  } catch (e) {
    let msg = String(e && e.message ? e.message : e)
    if (/singleton/i.test(msg)) msg = 'profile is in use — quit the chatgpt-web Chrome window first'
    const j = readJob(jobId)
    if (j) {
      j.status = 'error'
      j.error = msg
      writeJob(j)
    }
    notify('chatgpt-web: error', msg)
  } finally {
    const s = readState()
    s.lastTurnEnd = Date.now()
    writeState(s)
  }
}

export async function runLogin() {
  await ensureBrowser()
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
    let links = []
    for (;;) {
      const state = await classifyPage(page)
      if (state === 'out') {
        console.error('not logged in — run: chatgpt-web login')
        process.exitCode = 1
        return
      }
      if (state === 'in') {
        links = await page.locator('nav a[href*="/c/"]').all()
        if (links.length) break
      }
      if (Date.now() > deadline) break
      await sleep(500)
    }
    if (!links.length) {
      console.log('no chats found')
      return
    }
    for (const l of links) {
      const href = (await l.getAttribute('href')) || ''
      const id = ((href.split('/c/')[1] || '').split('/')[0]).split('?')[0]
      const title = ((await l.innerText().catch(() => '')).split('\n')[0] || '').trim()
      console.log(id.padEnd(16), title.slice(0, 60))
    }
  })
}

const ICON_SEL = '[data-testid="library-file-icon"]'

async function captureChatFiles(page, chatId) {
  const url = CHAT_URL + 'c/' + chatId
  const files = []
  for (let i = 0; ; i++) {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
    await sleep(6000)
    const icons = await page.locator(ICON_SEL).count().catch(() => 0)
    if (icons === 0) {
      if (i === 0) throw new Error('no file cards in this conversation')
      break
    }
    if (i >= icons) break
    const respP = page
      .waitForResponse((r) => /estuary\/content/.test(r.url()), { timeout: 8000 })
      .catch(() => null)
    await page.locator(ICON_SEL).nth(i).click()
    let resp = await respP
    let simple = null
    if (!resp) {
      const simpleP = page
        .waitForResponse((r) => /\/files\/.+\/simple/.test(r.url()), { timeout: 3000 })
        .catch(() => null)
      await page.locator(ICON_SEL).nth(i).click()
      resp = simple = await simpleP
    }
    if (!resp) continue
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
    if (!id || seen(files, id)) continue
    const bytes = await fileBytes(page, resp)
    files.push({ id, name: name || id + '.bin', bytes })
    if (files.length >= icons) break
  }
  return files
}

function seen(files, id) {
  return files.some((f) => f.id === id)
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
          return new Uint8Array(await r.arrayBuffer())
        }, du)
      )
    }
  }
  return bytes
}

export async function runFiles(chatId) {
  if (!chatId) throw new Error('usage: chatgpt-web files <chat-id>')
  await ensureBrowser()
  await withPage(async (page) => {
    const files = await captureChatFiles(page, chatId)
    if (!files.length) {
      console.log('no files')
      return
    }
    files.forEach((f, i) => {
      console.log(String(i + 1).padEnd(4), f.name.slice(0, 48).padEnd(50), f.id)
    })
  })
}

export async function runDownload(chatId, what, outdir) {
  if (!chatId) throw new Error('usage: chatgpt-web download <chat-id> [n|all] [outdir]')
  const target = what || 'all'
  const dir = outdir || process.cwd()
  await ensureBrowser()
  await withPage(async (page) => {
    const files = await captureChatFiles(page, chatId)
    if (!files.length) {
      console.log('no files')
      return
    }
    const picks =
      target === 'all' ? files : files.slice(parseInt(target, 10) - 1, parseInt(target, 10))
    if (!picks.length) {
      console.error(`no file #${target} (have ${files.length})`)
      process.exitCode = 1
      return
    }
    fs.mkdirSync(dir, { recursive: true })
    for (const f of picks) {
      const safe = f.name.replace(/[^A-Za-z0-9._-]/g, '_')
      const p = path.join(dir, safe)
      fs.writeFileSync(p, f.bytes)
      console.log(p, `(${f.bytes.length} bytes)`)
    }
  })
}

export async function runStatus() {
  const up = await cdpAlive()
  console.log('daemon:', up ? 'up (CDP port ' + CDP_PORT + ')' : 'down (next command starts it)')
  const s = readState()
  const L = limits()
  const hourChats = (s.newChats || []).filter((t) => Date.now() - t < 3600000).length
  console.log(
    `usage: ${(s.turns || {})[dayKey()] || 0}/${L.maxTurnsDay} turns today, ` +
      `${hourChats}/${L.maxNewChatsHour} new chats this hour, min gap ${L.minGapMs / 1000}s`
  )
  const r = runningJob()
  console.log('running job:', r ? r.id + ' — ' + (r.prompt || '').slice(0, 50) : 'none')
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

const [cmd, arg] = process.argv.slice(2)
if (cmd === 'job') {
  await runTurn(arg)
}
