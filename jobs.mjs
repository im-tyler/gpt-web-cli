import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const HOME = process.env.CHATGPT_WEB_HOME || path.join(os.homedir(), '.chatgpt-web')
export const JOBS_DIR = path.join(HOME, 'jobs')
export const PROFILE_DIR = path.join(HOME, 'profile')
export const LOG_FILE = path.join(HOME, 'runner.log')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function ensureDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true })
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
}

export function newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex')
}

function tmpName(p) {
  // Unique per writer: two writers sharing one temp filename renamed each
  // other's file out from under them (F09). The pid alone is not enough —
  // a process can run two writers in parallel.
  return p + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp'
}

// atomicWriteJSON writes via a unique temp file and rename, so every reader
// sees either the old object or the new one.
function atomicWriteJSON(p, v) {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = tmpName(p)
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2))
  fs.renameSync(tmp, p)
}

export function jobPath(id) {
  return path.join(JOBS_DIR, id + '.json')
}

export function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), 'utf8'))
  } catch {
    return null
  }
}

// terminal reports whether a job status can no longer change for its turn.
// A completed job ('done') must never be overwritten by a stale snapshot
// from a reaper or a waiter that read the job before the runner finished
// (F08).
export function isTerminal(job) {
  return job && (job.status === 'done' || job.status === 'error')
}

// persistJobGuarded writes a job, refusing to regress a terminal record: if
// the job on disk is already 'done' and this write would replace it with
// anything else, the completed record wins and is returned unchanged. Every
// writer — runner, CLI, reaper — goes through here (directly or via
// writeJob), which is what makes the refusal hold against all of them (F08).
function persistJobGuarded(job) {
  const disk = readJob(job.id)
  if (disk && disk.status === 'done' && job.status !== 'done') {
    return disk
  }
  job.updatedAt = new Date().toISOString()
  job.rev = (disk ? disk.rev || 0 : 0) + 1
  atomicWriteJSON(jobPath(job.id), job)
  return job
}

// writeJob persists a job under the store lock. Callers already inside
// withStoreLock (admission, reaping) must use writeJobLocked instead — the
// mkdir lock is not reentrant, and re-acquiring it from its own holder
// deadlocks.
export async function writeJob(job) {
  return withStoreLock(() => persistJobGuarded(job))
}

export function writeJobLocked(job) {
  return persistJobGuarded(job)
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

// startupLeaseMs bounds how long a job may sit in 'running' with no pid
// before it is treated as a launch that never happened. The parent installs
// the runner's pid immediately after spawn; anything older than this is a
// parent that died in the handoff window (F12).
export const startupLeaseMs = 90 * 1000

// runningJobs counts occupied turn slots. A just-admitted job with no pid
// yet is an occupied slot — a reservation, not a ghost — so the MAX_TABS
// check cannot admit a burst that only later discovers the caps (F10). A
// reservation whose lease expired is reaped first, so a dead handoff cannot
// wedge a slot forever.
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

// withLock runs fn while holding an inter-process mkdir lock. Cleanup is
// token-guarded: the holder only removes the lock directory in finally if
// the directory still names its own token — a holder that was displaced by
// staleness must not delete the successor's lock, which is what let a third
// contender in (F11).
export async function withLock(name, fn, { staleMs = 120000, timeoutMs = 600000 } = {}) {
  fs.mkdirSync(LOCKS_DIR, { recursive: true })
  const dir = path.join(LOCKS_DIR, name + '.lock')
  const token = crypto.randomUUID()
  const ownerFile = path.join(dir, 'owner.json')
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      fs.mkdirSync(dir)
      fs.writeFileSync(ownerFile, JSON.stringify({ pid: process.pid, token, at: Date.now() }))
      break
    } catch (e) {
      if (e.code !== 'EEXIST') throw e
      try {
        const owner = JSON.parse(fs.readFileSync(ownerFile, 'utf8'))
        if (Date.now() - owner.at > staleMs && !pidAlive(owner.pid)) {
          fs.rmSync(dir, { recursive: true, force: true })
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
    } catch {}
  }
}

// withStoreLock serialises every job-store admission and reconciliation
// decision. Checking liveness or capacity outside it, then writing inside,
// admitted two runners to one job and five starts under a cap of two — the
// check and the write have to be one transaction (F07, F10).
export function withStoreLock(fn, opts) {
  return withLock('store', fn, opts)
}

// reapStale files dead workers, conditionally. It runs under the store lock
// and re-reads the job inside: a runner that committed 'done' and exited
// between an outside read and this call is seen as terminal and left alone —
// the old code wrote its stale 'error' snapshot over the completed reply
// (F08). A pid-less running job inside its startup lease is a handoff in
// progress, not a failure (F12).
export async function reapStale() {
  const now = Date.now()
  for (const j of listJobs()) {
    if (j.status !== 'running' && j.status !== 'streaming') continue
    await withStoreLock(() => {
      const cur = readJob(j.id)
      if (!cur || (cur.status !== 'running' && cur.status !== 'streaming')) return
      if (!cur.pid) {
        const age = now - Date.parse(cur.createdAt || 0)
        if (age > startupLeaseMs) {
          cur.status = 'error'
          cur.error = 'runner never started (parent died during handoff)'
          writeJobLocked(cur)
        }
        return
      }
      if (!pidAlive(cur.pid)) {
        cur.status = 'error'
        cur.error = `runner died (pid ${cur.pid})`
        writeJobLocked(cur)
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

// updateState is the only way state.json changes. Every field of that file
// is an accounting decision (caps, pacing, send timestamps), and two
// processes each doing read-mutate-write on it silently dropped each other's
// increments (F09).
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
  const n = parseInt(process.env[name] || '', 10)
  if (!Number.isFinite(n) || n < min) return fallback
  return n
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
