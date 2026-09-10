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
  listJobs,
  reapStale,
  runningJob,
  pidAlive,
  sleep,
  readState,
  checkLimits,
  recordTurn,
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
  chats               list ChatGPT conversations in the profile (sidebar)
  files <chat-id>     list files created in a conversation
  download <chat-id> [n|all] [outdir]
                      save conversation files to disk (default: all, current dir)
  login               open the chatgpt-web Chrome window and wait until you log in

The Chrome window stays open in the background (minimize it) — it owns the
login session and all turns run through it.

env: CHATGPT_WEB_HOME=${HOME}
     CHATGPT_WEB_TIMEOUT=<secs per turn, default 300>
     CHATGPT_WEB_CDP_PORT=<default 9777>
     CHATGPT_WEB_MAX_TURNS_DAY=<default 100>  CHATGPT_WEB_MAX_NEW_CHATS=<per hour, default 6>
     CHATGPT_WEB_MIN_GAP=<secs between turns, default 8>  CHATGPT_WEB_NOTIFY=0 disables notifications`)
}

function spawnRunner(args) {
  const log = fs.openSync(LOG_FILE, 'a')
  const child = spawn(process.execPath, [RUNNER, ...args], {
    detached: true,
    stdio: ['ignore', log, log],
  })
  child.unref()
  return child
}

function cmdStart(prompt, files) {
  if (!prompt) err('start needs a prompt: chatgpt-web start "prompt" [--file path]')
  for (const f of files) {
    if (!fs.existsSync(f)) err(`no such file: ${f}`)
  }
  ensureDirs()
  reapStale()
  const r = runningJob()
  if (r) err(`job ${r.id} is still running — run: chatgpt-web wait ${r.id}`)
  const s = readState()
  const lim = checkLimits(s, true)
  if (lim) err(lim)
  recordTurn(s, true)
  const job = {
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
  }
  writeJob(job)
  const child = spawnRunner(['job', job.id])
  const j = readJob(job.id)
  j.pid = child.pid
  writeJob(j)
  console.log(job.id)
}

function cmdSend(id, text, files) {
  if (!id || !text) err('usage: chatgpt-web send <id> "text" [--file path]')
  for (const f of files) {
    if (!fs.existsSync(f)) err(`no such file: ${f}`)
  }
  ensureDirs()
  reapStale()
  const job = readJob(id)
  if (!job) err(`no such job: ${id}`)
  if (job.status === 'running' || job.status === 'streaming') err(`job ${id} is still running — run: chatgpt-web wait ${id}`)
  if (!job.url) err(`job ${id} never completed a turn (no conversation url) — start a new one`)
  const s = readState()
  const lim = checkLimits(s, false)
  if (lim) err(lim)
  recordTurn(s, false)
  job.files = files.map((f) => path.resolve(f))
  job.status = 'running'
  job.prompt = text
  job.reply = null
  job.error = null
  job.history.push({ role: 'user', text })
  writeJob(job)
  const child = spawnRunner(['job', id])
  const j = readJob(id)
  j.pid = child.pid
  writeJob(j)
  console.log(id)
}

async function cmdWait(id, timeoutSec, stream) {
  if (!id) err('usage: chatgpt-web wait <id> [secs] [--stream]')
  const timeout = parseInt(timeoutSec || '600', 10) * 1000
  ensureDirs()
  const deadline = Date.now() + timeout
  let printed = 0
  for (;;) {
    const j = readJob(id)
    if (!j) err(`no such job: ${id}`)
    if (stream && (j.status === 'streaming' || j.status === 'done') && (j.reply || '').length > printed) {
      process.stdout.write(j.reply.slice(printed))
      printed = j.reply.length
    }
    if (j.status === 'done') {
      if (stream) {
        if ((j.reply || '').length > printed) process.stdout.write(j.reply.slice(printed))
        process.stdout.write('\n')
      } else {
        process.stdout.write((j.reply || '') + '\n')
      }
      return
    }
    if (j.status === 'error') err(j.error || 'job failed')
    if ((j.status === 'running' || j.status === 'streaming') && j.pid && !pidAlive(j.pid)) {
      j.status = 'error'
      j.error = `runner died (pid ${j.pid})`
      writeJob(j)
      err(j.error)
    }
    if (Date.now() > deadline) err(`timed out after ${timeout / 1000}s — job still running, retry: chatgpt-web wait ${id}`)
    await sleep(400)
  }
}

function cmdList() {
  ensureDirs()
  reapStale()
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
  reapStale()
  const r = runningJob()
  if (r) err(`job ${r.id} is running — wait for it first`)
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
    cmdStart(a, fileArgs)
    break
  case 'send':
    cmdSend(a, b, fileArgs)
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
