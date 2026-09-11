#!/usr/bin/env node
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOME,
  LOG_FILE,
  ensureDirs,
  newId,
  readJob,
  writeJob,
  writeJobLocked,
  listJobs,
  reapStale,
  runningJobs,
  withStoreLock,
  updateState,
  limits,
  checkLimits,
  recordTurn,
  sleep,
} from './jobs.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(__dirname, 'runner.mjs')

function err(msg) {
  console.error(String(msg))
  process.exit(1)
}

function usage() {
  console.log(`usage: chatgpt-web <command>

  start "prompt"      create a job and send the prompt to ChatGPT (prints job id)
                      optional: --file <path> (repeatable) attaches files
  send <id> "text"    send a follow-up in the job's conversation (prints job id)
  wait <id> [secs]    block until the job finishes, print the reply (default 600s)
                      optional: --stream prints the reply as it grows
  list                list jobs
  status              daemon, session, usage caps, running job
  chats               list ChatGPT conversations (id, async status, updated, title)
  model [name]        list the account's models, or set one by name fragment
                      (manual only — the CLI never switches models on its own)
  files <chat-id>     list files created in a conversation
  download <chat-id> [n|all] [outdir]
                      save conversation files to disk (default: all, current dir)
  login               open the chatgpt-web Chrome window and wait until you log in

The Chrome window stays open in the background (minimize it) — it owns the
login session and all turns run through it. CHATGPT_WEB_HEADLESS=1 hides that
headed window (does not use Chrome --headless; Cloudflare blocks that).

env: CHATGPT_WEB_HOME=${HOME}
     CHATGPT_WEB_TIMEOUT=<secs per turn, default 300>
     CHATGPT_WEB_CDP_PORT=<default 9777>
     CHATGPT_WEB_HEADLESS=1
     CHATGPT_WEB_MAX_TABS=<concurrent turns, default 2>
     CHATGPT_WEB_MAX_TURNS_DAY=<default 100>  CHATGPT_WEB_MAX_NEW_CHATS=<per hour, default 6>
     CHATGPT_WEB_MIN_GAP=<secs between sends, default 8>  CHATGPT_WEB_NOTIFY=0 disables notifications

Concurrent turns (up to CHATGPT_WEB_MAX_TABS) run in separate tabs of the same
Chrome window; sends are paced globally, response waits happen in parallel.`)
}

function spawnRunner(args) {
  const log = fs.openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [RUNNER, ...args], {
    detached: true,
    stdio: ['ignore', log, log],
  })
  // A Chrome/node path that exists but cannot execute surfaces here as an
  // 'error' event, not a throw — without a listener it took down the CLI
  // with an unhandled event instead of failing the job cleanly (F15).
  child.on('error', (e) => {
    console.error(`runner failed to start: ${e.message}`)
    try { fs.closeSync(log) } catch {}
  })
  child.unref()
  return child
}

// checkPrompt refuses whitespace-only and empty prompts outright: they skip
// every conversation-verification guard (nothing to match) and burn a turn
// saying nothing (F02).
function checkPrompt(prompt) {
  if (!prompt || !prompt.trim()) err('prompt is empty or whitespace only')
}

// parseCount parses a strict positive integer (wait seconds, download index).
// "1junk" and negative values became NaN/negative slicing downstream and
// selected the wrong file or waited forever (F26).
function parseCount(label, raw, { min = 1 } = {}) {
  const n = parseInt(String(raw), 10)
  if (!Number.isFinite(n) || n < min || String(n) !== String(raw).trim()) {
    err(`${label} must be an integer >= ${min}, got ${JSON.stringify(raw)}`)
  }
  return n
}

async function cmdStart(prompt, files) {
  checkPrompt(prompt)
  if (!prompt) err('start needs a prompt: chatgpt-web start "prompt" [--file path]')
  for (const f of files) {
    if (!fs.existsSync(f)) err(`no such file: ${f}`)
  }
  ensureDirs()
  await reapStale()

  // Admission is one transaction: caps, slot reservation and job creation
  // under the same lock. The check outside and the write inside admitted
  // concurrent starts past every cap (F07, F10).
  let job = null
  let limErr = null
  await withStoreLock(async () => {
    const running = runningJobs()
    if (running.length >= limits().maxTabs) {
      limErr = `${running.length} turns already running (max ${limits().maxTabs}, CHATGPT_WEB_MAX_TABS) — wait: chatgpt-web wait ${running[0].id}`
      return
    }
    limErr = await updateState((s) => {
      const e = checkLimits(s, true)
      if (!e) recordTurn(s, true)
      return e
    })
    if (limErr) return
    job = {
      id: newId(),
      status: 'running',
      prompt,
      files: files.map((f) => path.resolve(f)),
      reply: null,
      url: null,
      history: [{ role: 'user', text: prompt }],
      error: null,
      pid: null,
      createdAt: new Date().toISOString(),
      rev: 0,
    }
    writeJobLocked(job)
  })
  if (limErr) err(limErr)
  const child = spawnRunner(['job', job.id])
  await writeJob({ ...readJob(job.id), pid: child.pid })
  console.log(job.id)
}

async function cmdSend(id, text, files) {
  checkPrompt(text)
  if (!id || !text) err('usage: chatgpt-web send <id> "text" [--file path]')
  for (const f of files) {
    if (!fs.existsSync(f)) err(`no such file: ${f}`)
  }
  ensureDirs()
  await reapStale()

  // Same transaction as start, plus the job re-read inside: two sends that
  // both saw an idle job used to both claim it and both spawn (F07).
  let limErr = null
  let ok = false
  await withStoreLock(async () => {
    const job = readJob(id)
    if (!job) {
      limErr = `no such job: ${id}`
      return
    }
    if (job.status === 'running' || job.status === 'streaming') {
      limErr = `job ${id} is still running — run: chatgpt-web wait ${id}`
      return
    }
    if (!job.url) {
      limErr = `job ${id} never completed a turn (no conversation url) — start a new one`
      return
    }
    const running = runningJobs()
    const L = limits()
    if (running.length >= L.maxTabs) {
      limErr = `${running.length} turns already running (max ${L.maxTabs}, CHATGPT_WEB_MAX_TABS) — wait: chatgpt-web wait ${running[0].id}`
      return
    }
    limErr = await updateState((s) => {
      const e = checkLimits(s, false)
      if (!e) recordTurn(s, false)
      return e
    })
    if (limErr) return
    job.files = files.map((f) => path.resolve(f))
    job.status = 'running'
    job.prompt = text
    job.reply = null
    job.error = null
    job.pid = null
    job.createdAt = new Date().toISOString()
    job.history.push({ role: 'user', text })
    writeJobLocked(job)
    ok = true
  })
  if (limErr) err(limErr)
  if (!ok) err('send was not admitted')
  const child = spawnRunner(['job', id])
  await writeJob({ ...readJob(id), pid: child.pid })
  console.log(id)
}

async function cmdWait(id, timeoutSec, stream) {
  if (!id) err('usage: chatgpt-web wait <id> [secs] [--stream]')
  let timeout = 600000
  if (timeoutSec !== undefined) {
    timeout = parseCount('wait seconds', timeoutSec) * 1000
  }
  ensureDirs()
  const deadline = Date.now() + timeout
  // The printed stream must be a prefix of the final reply. Snapshots can be
  // REPLACEMENTS (an edit, a regenerate, a correction), and printing
  // snapshot[n].slice(printed) spliced an obsolete prefix onto a new suffix —
  // a corrupt transcript reported as success (F23).
  let printed = ''
  let replaced = false
  for (;;) {
    const j = readJob(id)
    if (!j) err(`no such job: ${id}`)
    const text = j.reply || ''
    if (stream && (j.status === 'streaming' || j.status === 'done') && text.length > 0) {
      if (!replaced && text.startsWith(printed)) {
        process.stdout.write(text.slice(printed.length))
        printed = text
      } else if (!replaced) {
        replaced = true
        process.stdout.write('\n[reply was revised; discarding earlier output]\n')
        printed = text
        process.stdout.write(printed)
      } else if (text.length > printed.length) {
        // Still growing after a replacement we already adopted.
        if (text.startsWith(printed)) {
          process.stdout.write(text.slice(printed.length))
          printed = text
        } else {
          printed = text
          process.stdout.write('\n[reply was revised again]\n' + printed)
        }
      }
    }
    if (j.status === 'done') {
      if (stream) {
        if (!replaced && (j.reply || '').length > printed.length) {
          process.stdout.write((j.reply || '').slice(printed.length))
        }
        process.stdout.write('\n')
      } else {
        process.stdout.write((j.reply || '') + '\n')
      }
      return
    }
    if (j.status === 'error') err(j.error || 'job failed')
    if ((j.status === 'running' || j.status === 'streaming') && j.pid && !pidAliveLocal(j.pid)) {
      // Conditional, not unconditional: the runner may have committed 'done'
      // between the read above and now. reapStale re-reads under the store
      // lock and only files genuinely dead workers (F08).
      await reapStale()
      const now = readJob(id)
      if (now.status === 'error') err(now.error || 'runner died')
    }
    if (Date.now() > deadline) err(`timed out after ${timeout / 1000}s — job still running, retry: chatgpt-web wait ${id}`)
    await sleep(400)
  }
}

function pidAliveLocal(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

function cmdList() {
  ensureDirs()
  const jobs = listJobs()
  if (!jobs.length) {
    console.log('no jobs')
    return
  }
  console.log(['ID'.padEnd(14), 'STATUS'.padEnd(8), 'TURNS'.padEnd(6), 'UPDATED'.padEnd(20), 'PROMPT'].join(''))
  for (const j of jobs) {
    const turns = String(Math.max(1, Math.ceil((j.history || []).length / 2)))
    const updated = (j.updatedAt || '').replace('T', ' ').slice(0, 19)
    const prompt = (j.prompt || '').replace(/\s+/g, ' ').slice(0, 48)
    console.log([j.id.padEnd(14), j.status.padEnd(8), turns.padEnd(6), updated.padEnd(20), prompt].join(''))
  }
}

async function cmdLogin() {
  ensureDirs()
  const running = runningJobs()
  if (running.length) err(`jobs running (${running.map((j) => j.id).join(', ')}) — wait for them first`)
  const { runLogin } = await import('./runner.mjs')
  await runLogin()
}

async function cmdChats() {
  ensureDirs()
  const { runChats } = await import('./runner.mjs')
  await runChats()
}

async function cmdRunner(fn, ...args) {
  ensureDirs()
  const mod = await import('./runner.mjs')
  await mod[fn](...args)
}

const raw = process.argv.slice(2)
const fileArgs = []
const rest = []
for (let i = 0; i < raw.length; i++) {
  if (raw[i] === '--file' || raw[i] === '-f') {
    if (!raw[i + 1]) err('--file needs a path')
    fileArgs.push(raw[i + 1])
    i++
  } else if (raw[i] === '--stream') {
    rest.push('--stream')
  } else {
    rest.push(raw[i])
  }
}
const stream = rest.includes('--stream')
const positional = rest.filter((x) => x !== '--stream')
const [cmd, a, b] = positional
switch (cmd) {
  case 'start':
    await cmdStart(a, fileArgs)
    break
  case 'send':
    await cmdSend(a, b, fileArgs)
    break
  case 'wait':
    await cmdWait(a, b, stream)
    break
  case 'list':
    cmdList()
    break
  case 'chats':
    await cmdChats()
    break
  case 'model':
    await cmdRunner('runModel', a)
    break
  case 'files':
    await cmdRunner('runFiles', a)
    break
  case 'download':
    await cmdRunner('runDownload', a, b, process.argv[5])
    break
  case 'status':
    await cmdRunner('runStatus')
    break
  case 'login':
    await cmdLogin()
    break
  default:
    usage()
    process.exit(cmd ? 1 : 0)
}
