#!/usr/bin/env node
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  HOME,
  LOG_FILE,
  ensureDirs,
  readJob,
  listJobs,
  reapStale,
  runningJobs,
  withStoreLock,
  turns,
  updateState,
  checkLimits,
  recordTurn,
  sleep,
  limits,
} from './jobs.mjs'
import { spawnRunnerLogged, createSnapshotWriter, positiveInteger } from './core-fixes.mjs'

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

function checkPrompt(prompt) {
  if (!prompt || !prompt.trim()) err('prompt is empty or whitespace only')
}

function parseCount(label, raw, opts = {}) {
  try {
    return positiveInteger(raw, label, opts)
  } catch (e) {
    err(e.message)
  }
}

// launchAdmitted starts the worker for an admitted turn generation and
// files the generation as failed when the launch itself fails — the
// reservation must not sit out its lease when the launcher already knows.
async function launchAdmitted(job) {
  try {
    return await spawnRunnerLogged(process.execPath, RUNNER, ['job', job.id, job.turnId], LOG_FILE)
  } catch (e) {
    await turns.update(job.id, job.turnId, (j) => {
      j.status = 'error'
      j.error = 'runner failed to start: ' + e.message
    })
    throw e
  }
}

async function cmdStart(prompt, files) {
  checkPrompt(prompt)
  for (const f of files) {
    if (!fs.existsSync(f)) err(`no such file: ${f}`)
  }
  ensureDirs()
  await reapStale()

  // Admission is one transaction: caps, slot reservation and job creation
  // under the same lock, committed through the turn store with a fresh
  // generation.
  let admitted = null
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
    admitted = turns.createLocked({
      id: newIdSafe(),
      prompt,
      files: files.map((f) => path.resolve(f)),
      reply: null,
      url: null,
      history: [{ role: 'user', text: prompt }],
      error: null,
      rev: 0,
    })
  })
  if (limErr) err(limErr)
  try {
    await launchAdmitted(admitted)
  } catch (e) {
    err(e.message)
  }
  console.log(admitted.id)
}

function newIdSafe() {
  // Kept as a local indirection so id policy stays in one place.
  return Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 6)
}

async function cmdSend(id, text, files) {
  checkPrompt(text)
  for (const f of files) {
    if (!fs.existsSync(f)) err(`no such file: ${f}`)
  }
  ensureDirs()
  await reapStale()

  let limErr = null
  let admitted = null
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
    if (running.length >= limits().maxTabs) {
      limErr = `${running.length} turns already running (max ${limits().maxTabs}, CHATGPT_WEB_MAX_TABS) — wait: chatgpt-web wait ${running[0].id}`
      return
    }
    limErr = await updateState((s) => {
      const e = checkLimits(s, false)
      if (!e) recordTurn(s, false)
      return e
    })
    if (limErr) return
    // beginLocked is the explicit new-turn transition: it vacates the
    // previous terminal state under a fresh generation, which the old
    // persistence guard refused — leaving `send` to launch a worker that
    // re-sent the previous prompt.
    try {
      admitted = turns.beginLocked(id, text, files.map((f) => path.resolve(f)))
    } catch (e) {
      limErr = e.message
    }
  })
  if (limErr) err(limErr)
  try {
    await launchAdmitted(admitted)
  } catch (e) {
    err(e.message)
  }
  console.log(id)
}

async function cmdWait(id, timeoutSec, stream) {
  let timeout = 600000
  if (timeoutSec !== undefined) {
    timeout = parseCount('wait seconds', timeoutSec, { max: 86400 }) * 1000
  }
  ensureDirs()
  const deadline = Date.now() + timeout
  // The printed stream is a sequence of revisions, not a guaranteed prefix
  // of the final reply: a replacement is labelled and reprinted in full
  // rather than spliced onto the old text.
  const writer = stream ? createSnapshotWriter((s) => process.stdout.write(s)) : null
  for (;;) {
    const j = readJob(id)
    if (!j) err(`no such job: ${id}`)
    if (writer && (j.status === 'streaming' || j.status === 'done')) {
      writer(j.reply ?? '')
    }
    if (j.status === 'done') {
      if (!stream) process.stdout.write((j.reply || '') + '\n')
      else process.stdout.write('\n')
      return
    }
    if (j.status === 'error') err(j.error || 'job failed')
    if ((j.status === 'running' || j.status === 'streaming') && j.pid && !pidAliveLocal(j.pid)) {
      // Conditional: the worker may have committed a terminal state between
      // the read above and now; reapStale re-reads under the store lock.
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
    const turnCount = String(Math.max(1, Math.ceil((j.history || []).length / 2)))
    const updated = (j.updatedAt || '').replace('T', ' ').slice(0, 19)
    const prompt = (j.prompt || '').replace(/\s+/g, ' ').slice(0, 48)
    console.log([j.id.padEnd(14), j.status.padEnd(8), turnCount.padEnd(6), updated.padEnd(20), prompt].join(''))
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
const [cmd, a, b, c] = positional
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
    // The outdir comes from the filtered positional list, like every other
    // operand — it used to read raw argv, which shifted with flag order.
    await cmdRunner('runDownload', a, b, c)
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
