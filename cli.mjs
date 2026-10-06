#!/usr/bin/env node
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
import { spawnRunnerLogged, positiveInteger } from './core-fixes.mjs'
import { parseCli, conversationId, assertWaitGeneration } from './audit-core.mjs'
import { writeOutput, validateUploads } from './audit-io.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const RUNNER = path.join(__dirname, 'runner-entry.mjs')

function usage() {
  console.log(`usage: chatgpt-web <command>

  start "prompt"      create a job and send the prompt to ChatGPT (prints job id)
                      optional: --file <path> (repeatable) attaches files
  send <id> "text"    send a follow-up in the job's conversation (prints job id)
  resume <id>         retry a failed assistant turn in standard ChatGPT (never clicks "Use Work")
  wait <id> [secs]    block until the job finishes, print the reply (default 600s)
                      optional: --stream prints reply revisions as they grow
                      --turn <turnId> pins a generation; --json prints a
                      structured final result (not combinable with --stream)
  list                list jobs
  status              daemon, session, usage caps, running job
  chats               list ChatGPT conversations (id, async status, updated, title)
  chats --delete <id>... | chats --delete --all --yes
                      hide conversations from the sidebar (destructive; --all
                      needs --yes and a complete listing)
  model [name]        list models + the current power-slider stop (read-only),
                        or set one by name fragment — a named model or a slider
                        stop, e.g. "6 pro" (manual only; the CLI never switches
                        models on its own. The slider is account-wide: sends
                        inherit whatever it holds)
  files <chat-id>     list files created in a conversation
  download <chat-id> [n|all] [outdir]
                      save conversation files to disk (default: all, current dir)
  dot                 bind + status of the account's dot thread
  dot "message"       send one message into the dot thread (paced, capped turn;
                      no reply wait — the dot answers on its own horizon.
                      Recorded as a dot-send job: done means sent, not replied)
  dot --poll [--json] print messages since the last poll, advance watermark
  dot --context [n] [--json]
                      print the last n messages (1..32; watermark untouched)
  dot --reset         forget the stored dot thread (re-discovered on next use)
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
  if (!prompt || !prompt.trim()) throw new Error('prompt is empty or whitespace only')
}

// launchAdmitted starts the worker for an admitted turn generation and
// files the generation as failed when the launch itself fails — the
// reservation must not sit out its lease when the launcher already knows.
async function launchAdmitted(job, mode = 'job') {
  try {
    return await spawnRunnerLogged(process.execPath, RUNNER, [mode, job.id, job.turnId], LOG_FILE)
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
  const checked = validateUploads(files)
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
      files: checked,
      reply: null,
      url: null,
      history: [{ role: 'user', text: prompt }],
      error: null,
      rev: 0,
    })
  })
  if (limErr) throw new Error(limErr)
  try {
    await launchAdmitted(admitted)
  } catch (e) {
    throw new Error(e.message)
  }
  console.log(admitted.id)
}

function newIdSafe() {
  // Kept as a local indirection so id policy stays in one place.
  return Date.now().toString(36) + '-' + crypto.randomUUID().slice(0, 6)
}

async function cmdSend(id, text, files) {
  checkPrompt(text)
  const checked = validateUploads(files)
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
    if (job.kind === 'dot-send') {
      limErr = 'dots are messaged with: chatgpt-web dot "text" (no send/resume/wait)'
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
    // previous terminal state under a fresh generation (clearing stale
    // provenance), which the old persistence guard refused — leaving
    // `send` to launch a worker that re-sent the previous prompt.
    try {
      admitted = turns.beginLocked(id, text, checked)
    } catch (e) {
      limErr = e.message
    }
  })
  if (limErr) throw new Error(limErr)
  try {
    await launchAdmitted(admitted)
  } catch (e) {
    throw new Error(e.message)
  }
  console.log(id)
}

// cmdResume retries a failed assistant turn in standard ChatGPT by clicking
// the conversation's own Retry control. It never clicks "Use Work": the
// Work interstitial is ChatGPT suggesting a different surface, and the CLI
// must stay on the surface its selectors are built for.
async function cmdResume(id) {
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
    if (job.kind === 'dot-send') {
      limErr = 'dots are messaged with: chatgpt-web dot "text" (no send/resume/wait)'
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
    try {
      admitted = turns.resumeLocked(id)
    } catch (e) {
      limErr = e.message
    }
  })
  if (limErr) throw new Error(limErr)
  try {
    await launchAdmitted(admitted, 'resume')
  } catch (e) {
    throw new Error(e.message)
  }
  console.log(id)
}

// cmdWait blocks on a PINNED turn generation: once a wait starts, the job
// record moving to a newer turn (error → resume/send) is reported as a
// supersession, never silently answered with the newer turn's reply.
async function cmdWait(id, timeoutSec, stream, opts = {}) {
  const timeout = timeoutSec === undefined ? 600000 : positiveInteger(timeoutSec, 'wait seconds', { max: 86400 }) * 1000
  ensureDirs()
  await reapStale()
  const initial = readJob(id)
  if (!initial) throw new Error('no such job: ' + id)
  if (initial.kind === 'dot-send') {
    throw new Error('dot sends have no reply wait — the dot answers on its own horizon; poll: chatgpt-web dot --poll')
  }
  const expectedTurnId = opts.turn || initial.turnId
  assertWaitGeneration(initial, expectedTurnId)
  const deadline = Date.now() + timeout
  let previous = ''
  let nextReap = 0
  for (;;) {
    if (Date.now() >= nextReap) {
      await reapStale() // includes admitted-but-unclaimed startup failures
      nextReap = Date.now() + 1000
    }
    const j = assertWaitGeneration(readJob(id), expectedTurnId)
    // The printed stream is a sequence of revisions, not a guaranteed
    // prefix of the final reply: a replacement is labelled and reprinted
    // in full rather than spliced onto the old text.
    if (stream && typeof j.reply === 'string' && j.reply !== previous) {
      const bytes = j.reply.startsWith(previous)
        ? j.reply.slice(previous.length)
        : '\n[reply revised; complete replacement follows]\n' + j.reply
      await writeOutput(process.stdout, bytes)
      previous = j.reply
    }
    if (j.status === 'done') {
      if (opts.json) {
        await writeOutput(
          process.stdout,
          JSON.stringify({
            id: j.id,
            turnId: j.turnId ?? null,
            status: j.status,
            url: j.url ?? null,
            acceptedUserId: j.acceptedUserId ?? null,
            assistantMessageId: j.assistantMessageId ?? null,
            reply: j.reply ?? '',
            replyKind: j.replyKind ?? 'text',
          }) + '\n'
        )
      } else if (!stream) {
        await writeOutput(
          process.stdout,
          (j.replyKind === 'non-text'
            ? '[completed with non-text output; inspect the conversation files]'
            : j.reply ?? '') + '\n'
        )
      } else {
        await writeOutput(process.stdout, '\n')
      }
      return
    }
    if (j.status === 'error') throw new Error(j.error || 'job failed')
    if (Date.now() >= deadline) {
      throw new Error(`wait timed out after ${timeout / 1000}s — the worker was not cancelled; retry: chatgpt-web wait ${id}`)
    }
    await sleep(Math.min(400, Math.max(0, deadline - Date.now())))
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
    console.log([String(j.id).padEnd(14), String(j.status).padEnd(8), turnCount.padEnd(6), updated.padEnd(20), prompt].join(''))
  }
}

async function cmdLogin() {
  ensureDirs()
  const running = runningJobs()
  if (running.length) throw new Error(`jobs running (${running.map((j) => j.id).join(', ')}) — wait for them first`)
  const { runLogin } = await import('./runner.mjs')
  await runLogin()
}

async function cmdRunner(fn, ...args) {
  ensureDirs()
  const mod = await import('./runner.mjs')
  await mod[fn](...args)
}

// cmdDotMessage admits and runs one dot send. The message is dispatched
// from ALREADY-PARSED argv (a literal "--poll" reached here as text through
// `--`; it must never be re-parsed). A dot send occupies a real store
// generation (kind dot-send): its slot is visible to admission, a dead CLI
// process is filed via the startup lease/reaper, and 'done' means sent —
// never 'assistant replied'.
async function cmdDotMessage(text) {
  checkPrompt(text)
  ensureDirs()
  await reapStale()
  let limErr = null
  let admitted = null
  await withStoreLock(async () => {
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
    admitted = turns.createLocked({
      id: newIdSafe(),
      kind: 'dot-send',
      prompt: text,
      files: [],
      reply: null,
      url: null,
      history: [{ role: 'user', text }],
      error: null,
      rev: 0,
    })
  })
  if (limErr) throw new Error(limErr)
  const claimed = await turns.claim(admitted.id, admitted.turnId, process.pid)
  if (!claimed) throw new Error('dot-send reservation was superseded before launch')
  const { runDotSend } = await import('./runner.mjs')
  try {
    await runDotSend(text, { jobId: admitted.id, turnId: admitted.turnId })
    await turns.update(admitted.id, admitted.turnId, (j) => {
      j.status = 'done'
      j.submissionState = 'sent'
      j.error = null
    })
  } catch (e) {
    await turns.update(admitted.id, admitted.turnId, (j) => {
      j.status = 'error'
      j.error = String(e.message || e)
    })
    throw e
  }
  console.log(`dot-send job: ${admitted.id} (done = sent, not replied)`)
}

async function main(argv) {
  const { command, args, options } = parseCli(argv)
  switch (command) {
    case 'help':
      return usage()
    case 'start':
      return cmdStart(args[0], options.file || [])
    case 'send':
      return cmdSend(args[0], args[1], options.file || [])
    case 'resume':
      return cmdResume(args[0])
    case 'wait':
      return cmdWait(args[0], args[1], !!options.stream, options)
    case 'list':
      await reapStale()
      return cmdList()
    case 'status':
      await reapStale()
      return cmdRunner('runStatus')
    case 'login':
      await reapStale()
      return cmdLogin()
    case 'chats':
      return cmdRunner('runChats', {
        deleteIds: options.delete && !options.all ? args : null,
        deleteAll: !!options.all,
        yes: !!options.yes,
      })
    case 'model':
      // Fragments are multi-word: "model 6 pro" must reach the matcher as
      // "6 pro", not just "6".
      return cmdRunner('runModel', args.join(' '))
    case 'files':
      return cmdRunner('runFiles', conversationId(args[0]))
    case 'download':
      // The outdir comes from the parsed operand list, like every other
      // operand — it used to read raw argv, which shifted with flag order.
      return cmdRunner('runDownload', conversationId(args[0]), args[1], args[2])
    case 'dot': {
      // Flags were validated against the dot contract by parseCli; the
      // message branch hands ALREADY-PARSED text to admission — never a
      // second parsing stage.
      if (options.reset) return cmdRunner('runDotReset')
      if (options.context !== undefined) return cmdRunner('runDotContext', options.context, !!options.json)
      if (options.poll) return cmdRunner('runDotPoll', !!options.json)
      if (!args.length) return cmdRunner('runDotStatus')
      return cmdDotMessage(args[0])
    }
    default:
      throw new Error(`unknown command: ${command} — run: chatgpt-web help`)
  }
}

try {
  await main(process.argv.slice(2))
} catch (e) {
  console.error(String(e.message || e))
  process.exitCode = 1
}
