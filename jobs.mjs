import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { makeTurnStore } from './turn-store.mjs'
import { jobId } from './core-fixes.mjs'
import { integerEnv } from './audit-core.mjs'
import { writeJSONAtomic, readJSONStrict } from './audit-io.mjs'

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
// atomicWriteJSON writes via a unique temp file and rename, so every reader
// sees either the old object or the new one (full durability + cleanup
// discipline lives in audit-io's writeJSONAtomic).
function atomicWriteJSON(p, v) {
  writeJSONAtomic(p, v)
}

// jobPath resolves a job id inside JOBS_DIR only. A CLI-supplied id used to
// be joined unchecked; it must not escape the store.
export function jobPath(id) {
  return path.join(JOBS_DIR, jobId(id) + '.json')
}

// validJobRecord is the shape contract for persisted records. Valid legacy
// TERMINAL records (no turnId) stay readable; an ACTIVE record without the
// generation fields is malformed and refused, not guessed at.
function validJobRecord(j, id) {
  if (!j || typeof j !== 'object') return 'not an object'
  if (typeof j.id !== 'string' || j.id !== id) return 'id mismatch'
  if (typeof j.status !== 'string' || !['running', 'streaming', 'done', 'error'].includes(j.status)) {
    return 'bad status ' + JSON.stringify(j.status)
  }
  if (typeof j.prompt !== 'string') return 'prompt missing'
  if (j.turnId != null && typeof j.turnId !== 'string') return 'bad turnId'
  if (j.pid != null && (!Number.isSafeInteger(j.pid) || j.pid <= 0)) return 'bad pid'
  return null
}

// readJob validates the id outside its I/O handler, returns null only for
// ENOENT, and refuses corrupt/unreadable records instead of treating them
// as absent (an invisible "running" job used to free a tab slot).
export function readJob(id) {
  const file = jobPath(id) // throws on an invalid id, before any I/O
  return readJSONStrict(file, { missing: null, validate: (j) => validJobRecord(j, id) })
}

// listJobs surfaces corrupt entries (status 'corrupt') with their filename
// rather than silently omitting them.
export function listJobs() {
  ensureDirs()
  return fs
    .readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const id = f.replace(/\.json$/, '')
      try {
        const j = JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8'))
        const problem = validJobRecord(j, id)
        if (problem) throw new Error(problem)
        return j
      } catch (e) {
        return {
          id,
          status: 'corrupt',
          prompt: '(unreadable job record: ' + e.message + ')',
          history: [],
          corrupt: true,
          createdAt: '',
          updatedAt: '',
        }
      }
    })
    .sort((a, b) => ((a.createdAt || '') < (b.createdAt || '') ? -1 : 1))
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

// withLock runs fn while holding a kernel advisory lock on a persistent lock
// file. The kernel, not a PID-and-age heuristic, owns lock lifetime: the
// lock dies with its file descriptor, mutual exclusion does not depend on
// reading stale metadata, and no removal race can admit two holders. Lock
// files are permanent — unlinking a live lock file would let different
// processes lock different inodes of the same name. { shared: true } takes a
// shared flock (ordinary page lifetimes overlap; login takes it exclusively).
export async function withLock(name, fn, { timeoutMs = 600000, shared = false } = {}) {
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error('invalid lock name')
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0) throw new Error('invalid lock timeout')
  const { default: fsExt } = await import('fs-ext')
  fs.mkdirSync(LOCKS_DIR, { recursive: true, mode: 0o700 })
  const file = path.join(LOCKS_DIR, name + '.flock')
  const flags = fs.constants.O_CREAT | fs.constants.O_RDWR | fs.constants.O_NOFOLLOW
  const fd = fs.openSync(file, flags, 0o600)
  const operation = shared ? 'shnb' : 'exnb'
  const flock = (op) =>
    new Promise((resolve, reject) => {
      fsExt.flock(fd, op, (error) => (error ? reject(error) : resolve()))
    })
  const deadline = Date.now() + timeoutMs
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Error('lock is not a regular file')
    fs.fchmodSync(fd, 0o600)
    for (;;) {
      try {
        await flock(operation)
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

function validUsage(s) {
  if (!s || typeof s !== 'object') return 'not an object'
  if (s.lastTurnEnd != null && !Number.isFinite(s.lastTurnEnd)) return 'bad lastTurnEnd'
  if (s.lastSendAt != null && !Number.isFinite(s.lastSendAt)) return 'bad lastSendAt'
  if (s.newChats != null && !Array.isArray(s.newChats)) return 'bad newChats'
  if (s.turns != null && typeof s.turns !== 'object') return 'bad turns'
  return null
}

// A corrupt state.json used to reset the caps silently (fresh counters =
// over-use). It throws instead; only a genuinely absent file starts clean.
export function readState() {
  const s = readJSONStrict(STATE_FILE, { missing: { lastTurnEnd: 0, newChats: [], turns: {} }, validate: validUsage })
  return s ? structuredClone(s) : { lastTurnEnd: 0, newChats: [], turns: {} }
}

// The dot thread record: which messaging room is the dot, who am I in it,
// and how far reading has progressed. One file, written only under the
// 'dot' lock (updateDot), same atomic-rename discipline as state.json.
export const DOT_FILE = path.join(HOME, 'dot.json')

function validDot(d) {
  if (!d || typeof d !== 'object') return 'not an object'
  if (d.roomId != null && typeof d.roomId !== 'string') return 'bad roomId'
  if (d.dotId != null && typeof d.dotId !== 'string') return 'bad dotId'
  if (d.myId != null && typeof d.myId !== 'string') return 'bad myId'
  return null
}

export function readDot() {
  const d = readJSONStrict(DOT_FILE, { missing: null, validate: validDot })
  return d ? structuredClone(d) : null
}

// updateDot is the only way dot.json changes; the mutator runs inside the
// dot lock against freshly read state. Returning null deletes the record.
export async function updateDot(mutator) {
  return withLock('dot', () => {
    const cur = readDot()
    const out = mutator(cur)
    if (out === null) {
      try {
        fs.unlinkSync(DOT_FILE)
      } catch {}
      return null
    }
    const next = out || cur
    if (next) atomicWriteJSON(DOT_FILE, next)
    return next
  })
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

// Explicit invalid env values throw (integerEnv); defaults apply only to
// absent variables. These are local resource bounds, not service limits.
export function limits() {
  return {
    maxNewChatsHour: integerEnv(process.env, 'CHATGPT_WEB_MAX_NEW_CHATS', 6, { min: 1, max: 100000 }),
    maxTurnsDay: integerEnv(process.env, 'CHATGPT_WEB_MAX_TURNS_DAY', 100, { min: 1, max: 100000 }),
    minGapMs: integerEnv(process.env, 'CHATGPT_WEB_MIN_GAP', 8, { min: 0, max: 86400 }) * 1000,
    maxTabs: integerEnv(process.env, 'CHATGPT_WEB_MAX_TABS', 2, { min: 1, max: 16 }),
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
