// Turn generations: the store's unit of ownership.
//
// A job is a conversation; a turn is one prompt within it. The old store
// conflated them: a completed job's record was immutable, which made the
// follow-up `send` a write the persistence guard refused — the command
// launched a worker anyway, and the worker re-sent the previous prompt.
// Every write is now scoped to a turnId created at admission; workers claim
// their generation before touching the browser; terminal states are
// immutable within a generation and vacated by beginning a new one.
//
// `_Locked` operations run inside the shared store lock; the asynchronous
// wrappers take it. Mutators must be synchronous.
import crypto from 'node:crypto'

const active = (j) => j && (j.status === 'running' || j.status === 'streaming')
const terminal = (j) => j && (j.status === 'done' || j.status === 'error')

export function makeTurnStore({ readJob, commitLocked, withStoreLock, now = () => new Date().toISOString() }) {
  function commit(previous, next) {
    next.rev = (previous?.rev || 0) + 1
    next.updatedAt = now()
    commitLocked(next)
    return structuredClone(next)
  }
  function createLocked(job) {
    if (readJob(job.id)) throw new Error('job already exists: ' + job.id)
    return commit(null, {
      ...structuredClone(job), status: 'running', turnId: crypto.randomUUID(),
      pid: null, claimedAt: null, createdAt: now(),
    })
  }
  function beginLocked(id, prompt, files = []) {
    const old = readJob(id)
    if (!old) throw new Error('no such job: ' + id)
    if (!terminal(old)) throw new Error('job is not idle: ' + id)
    if (!old.url) throw new Error('job has no conversation URL')
    if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('empty prompt')
    return commit(old, {
      ...structuredClone(old), turnId: crypto.randomUUID(), status: 'running',
      prompt, files: [...files], reply: null, error: null, pid: null,
      claimedAt: null, createdAt: now(),
      history: [...(old.history || []), { role: 'user', text: prompt }],
    })
  }
  function updateLocked(id, turnId, mutate) {
    const old = readJob(id)
    if (!active(old) || !turnId || old.turnId !== turnId) return null
    const next = structuredClone(old)
    const outcome = mutate(next)
    if (outcome && typeof outcome.then === 'function') throw new TypeError('store mutators must be synchronous')
    if (outcome === false) return null
    if (next.id !== old.id || next.turnId !== old.turnId) throw new Error('immutable job identity changed')
    if (!active(next) && !terminal(next)) throw new Error('invalid job status')
    if (old.status === 'streaming' && next.status === 'running') throw new Error('status regression')
    return commit(old, next)
  }
  const update = (id, turnId, mutate) => withStoreLock(() => updateLocked(id, turnId, mutate))
  async function claim(id, turnId, pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('invalid worker PID')
    return withStoreLock(() => updateLocked(id, turnId, (job) => {
      if (job.status !== 'running' || job.claimedAt || (job.pid && job.pid !== pid)) return false
      job.pid = pid
      job.claimedAt = now()
    }))
  }
  return { createLocked, beginLocked, updateLocked, update, claim }
}
