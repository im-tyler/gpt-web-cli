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

// withLock runs fn while holding an inter-process mkdir lock.
//
// Stealing a stale lock is done by RENAMING the stale directory aside: the
// rename is atomic, so exactly one contender wins it, and the others see
// the directory gone and race for a fresh mkdir. The old read-check-delete
// sequence let two contenders who both read a dead owner race, with the
// loser deleting the winner's freshly created lock and entering beside it.
// A holder displaced by a steal finds its owner.json gone with the renamed
// directory and removes nothing. An ownerless lock directory (a crash
// between mkdir and publishing owner.json) is stealable by directory age,
// so it cannot wedge acquisition forever.
export async function withLock(name, fn, { staleMs = 120000, timeoutMs = 600000 } = {}) {
  fs.mkdirSync(LOCKS_DIR, { recursive: true })
  const dir = path.join(LOCKS_DIR, name + '.lock')
  const ownerFile = path.join(dir, 'owner.json')
  const token = crypto.randomUUID()
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.mkdirSync(dir)
      // Publish owner.json atomically (write a dotfile, rename it in): a
      // crash between mkdir and publish must not leave a lock that reads
      // as both ownerless and unparseable.
      const pending = path.join(dir, '.owner.' + crypto.randomUUID())
      fs.writeFileSync(pending, JSON.stringify({ pid: process.pid, token, at: Date.now() }), { mode: 0o600 })
      fs.renameSync(pending, ownerFile)
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        let stealable = false
        try {
          const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
          // A published owner decides: steal only when it recorded itself
          // long enough ago AND its pid is gone. The owner's timestamp, not
          // the directory's mtime — a holder that died the moment it took
          // the lock is dead regardless of how young the directory is.
          stealable = Date.now() - (owner.at || 0) > staleMs && !pidAlive(owner.pid)
        } catch {
          // No owner published (crash between mkdir and publish): the
          // directory's age is the only witness.
          const st = fs.statSync(dir)
          stealable = Date.now() - st.mtimeMs > staleMs
        }
        if (stealable) {
          // Atomic steal: the rename succeeds for exactly one contender.
          // The renamed copy is dead evidence; the winner removes it rather
          // than letting steals accumulate directories forever.
          const quarantine = dir + '.stale-' + crypto.randomUUID()
          try {
            fs.renameSync(dir, quarantine)
            fs.rmSync(quarantine, { recursive: true, force: true })
          } catch {
            // Someone else stole it first; loop for the fresh mkdir.
          }
        }
      } catch {}
      if (Date.now() > deadline) throw new Error('lock timeout: ' + name)
      await sleep(500 + Math.random() * 500)
    }
  }
  try {
    return await fn()
  } finally {
    try {
      const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
      if (owner && owner.token === token) {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    } catch {
      // The lock was stolen and renamed away: nothing of ours to remove.
    }
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
