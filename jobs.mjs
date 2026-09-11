import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

import { makeTurnStore } from './turn-store.mjs'
import { jobId, positiveInteger } from './core-fixes.mjs'

export const HOME = process.env.CHATGPT_WEB_HOME || path.join(os.homedir(), '.chatgpt-web')
export const JOBS_DIR = path.join(HOME, 'jobs')
export const PROFILE_DIR = path.join(HOME, 'profile')
export const LOG_FILE = path.join(HOME, 'runner.log')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function ensureDirs() {
  // Private from the start: prompts, replies and paths live under HOME, and
  // a 022 umask made them 0755/0644 by default.
  for (const dir of [HOME, JOBS_DIR, PROFILE_DIR, path.join(HOME, 'locks')]) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    fs.chmodSync(dir, 0o700)
  }
}

export function newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex')
}

function tmpName(p) {
  // Unique per writer: two writers sharing one temp filename renamed each
  // other's file out from under them. The pid alone is not enough — a
  // process can run two writers in parallel.
  return p + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp'
}

// atomicWriteJSON writes via a unique temp file and rename, so every reader
// sees either the old object or the new one.
function atomicWriteJSON(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = tmpName(p)
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2), { mode: 0o600 })
  fs.chmodSync(tmp, 0o600)
  fs.renameSync(tmp, p)
}

// jobPath resolves a job id inside JOBS_DIR only. A CLI-supplied id used to
// be joined unchecked; it must not escape the store.
export function jobPath(id) {
  return path.join(JOBS_DIR, jobId(id) + '.json')
}

export function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), 'utf8'))
  } catch {
    return null
  }
}

export function listJobs() {
  ensureDirs()
  return fs
    .readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8'))
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
}

export function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

// startupLeaseMs bounds how long a job may sit admitted-but-unclaimed
// before it is treated as a launch that never happened. The worker claims
// its generation (and records its pid) immediately after spawning; anything
// older than this is a parent or worker that died in the handoff.
export const startupLeaseMs = 90 * 1000

// runningJobs counts occupied turn slots. An admitted-but-unclaimed job is
// an occupied slot — a reservation — so the MAX_TABS check cannot admit a
// burst that only later discovers the caps.
export function runningJobs() {
  const now = Date.now()
  const out = []
  for (const j of listJobs()) {
    if (j.status !== 'running' && j.status !== 'streaming') continue
    if (!j.pid) {
      const age = now - Date.parse(j.createdAt || 0)
      if (age > startupLeaseMs) continue // dead handoff; reapStale files it
    }
    out.push(j)
  }
  return out
}

export const LOCKS_DIR = path.join(HOME, 'locks')

// withLock runs fn while holding an exclusive kernel advisory lock on a
// persistent lock file. The kernel, not a PID-and-age heuristic, owns lock
// lifetime: the lock dies with its file descriptor, mutual exclusion does
// not depend on reading stale metadata, and no removal race can admit two
// holders. Lock files are permanent — unlinking a live lock file would let
// different processes lock different inodes of the same name.
export async function withLock(name, fn, { timeoutMs = 600000 } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('invalid lock name')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('invalid lock timeout')
  const { default: fsExt } = await import('fs-ext')
  fs.mkdirSync(LOCKS_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(LOCKS_DIR, name + '.flock')
  const flags = fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW
  const fd = fs.openSync(file, flags, 0o600)
  const flock = (operation) =>
    new Promise((resolve, reject) => {
      fsExt.flock(fd, operation, (error) => (error ? reject(error) : resolve()))
    })
  const deadline = Date.now() + timeoutMs
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('lock is not a regular file')
    fs.fchmodSync(fd, 0o600)
    for (;;) {
      try {
        await flock('exnb')
        break
      } catch (error) {
        if (!['EAGAIN', 'EWOULDBLOCK', 'EINTR'].includes(error.code)) throw error
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error('lock timeout: ' + name)
        await sleep(Math.min(50, remaining))
      }
    }
    return await fn()
  } finally {
    // Close releases the kernel lock, including when fn throws. Process
    // death also releases it; no PID probe, lease stealing, or rm is needed.
    fs.closeSync(fd)
  }
}

// withStoreLock serialises every job-store admission and reconciliation
// decision: the check and the write have to be one transaction.
export function withStoreLock(fn, opts) {
  return withLock('store', fn, opts)
}

// The turn store: the only production writer of job records. Writes are
// narrow mutations scoped to an admitted turnId; full-record writes from a
// stale snapshot used to erase newer replies, URLs and statuses despite the
// lock, because the lock serialised the write but not the preceding read.
export const turns = makeTurnStore({
  readJob,
  withStoreLock,
  commitLocked: (job) => atomicWriteJSON(jobPath(job.id), job),
})

// reapStale files dead workers, conditionally, inside the store lock. A
// legacy record from before turn generations (active, no turnId) is filed
// as an interrupted upgrade rather than mutated as if it were known.
export async function reapStale() {
  const now = Date.now()
  for (const j of listJobs()) {
    if (j.status !== 'running' && j.status !== 'streaming') continue
    await withStoreLock(() => {
      const cur = readJob(j.id)
      if (!cur || (cur.status !== 'running' && cur.status !== 'streaming')) return
      if (!cur.turnId) {
        const age = now - Date.parse(cur.createdAt || 0)
        if (age > startupLeaseMs) {
          cur.status = 'error'
          cur.error = 'interrupted upgrade from a pre-generation record'
          cur.updatedAt = new Date().toISOString()
          cur.rev = (cur.rev || 0) + 1
          atomicWriteJSON(jobPath(cur.id), cur)
        }
        return
      }
      if (!cur.pid) {
        const age = now - Date.parse(cur.createdAt || 0)
        if (age > startupLeaseMs) {
          turns.updateLocked(cur.id, cur.turnId, (job) => {
            job.status = 'error'
            job.error = 'runner never claimed its turn'
          })
        }
        return
      }
      if (!pidAlive(cur.pid)) {
        turns.updateLocked(cur.id, cur.turnId, (job) => {
          job.status = 'error'
          job.error = `runner died (pid ${job.pid})`
        })
      }
    })
  }
}

export const STATE_FILE = path.join(HOME, 'state.json')

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { lastTurnEnd: 0, newChats: [], turns: {} }
  }
}

// updateState is the only way state.json changes; the mutator runs inside
// the state lock against freshly read state.
export async function updateState(mutator) {
  return withLock('state', () => {
    const s = readState()
    const out = mutator(s)
    atomicWriteJSON(STATE_FILE, s)
    return out
  })
}

export function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

function intEnv(name, fallback, { min = 0 } = {}) {
  const raw = String(process.env[name] || '').trim()
  if (!/^\d+$/.test(raw)) return fallback
  return positiveInteger(raw, name, { min })
}

export function limits() {
  return {
    maxNewChatsHour: intEnv('CHATGPT_WEB_MAX_NEW_CHATS', 6, { min: 1 }),
    maxTurnsDay: intEnv('CHATGPT_WEB_MAX_TURNS_DAY', 100, { min: 1 }),
    minGapMs: intEnv('CHATGPT_WEB_MIN_GAP', 8, { min: 0 }) * 1000,
    maxTabs: intEnv('CHATGPT_WEB_MAX_TABS', 2, { min: 1 }),
  }
}

export function checkLimits(s, isNewChat) {
  const L = limits()
  const today = (s.turns || {})[dayKey()] || 0
  if (today >= L.maxTurnsDay) {
    return `daily turn cap reached (${today}/${L.maxTurnsDay}) — raise CHATGPT_WEB_MAX_TURNS_DAY or wait`
  }
  if (isNewChat) {
    const recent = (s.newChats || []).filter((t) => Date.now() - t < 3600000)
    if (recent.length >= L.maxNewChatsHour) {
      return `new-chat cap reached (${recent.length}/${L.maxNewChatsHour} per hour) — use send on an existing job or wait`
    }
  }
  return null
}

export function recordTurn(s, isNewChat) {
  const k = dayKey()
  s.turns = s.turns || {}
  s.turns[k] = (s.turns[k] || 0) + 1
  for (const old of Object.keys(s.turns)) if (old !== k && Object.keys(s.turns).length > 7) delete s.turns[old]
  if (isNewChat) {
    s.newChats = [...(s.newChats || []).filter((t) => Date.now() - t < 3600000), Date.now()]
  }
}
