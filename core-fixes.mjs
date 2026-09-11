// Strict inputs, revision rendering, result selection, artifact writes,
// awaited process startup, and shell-free process probes — the small shared
// fixes from the round-2 audit that every command touches.
import fs from 'node:fs'
import path from 'node:path'
import { spawn, execFileSync } from 'node:child_process'
import crypto from 'node:crypto'

export function positiveInteger(raw, label, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const text = String(raw).trim()
  const value = Number(text)
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`)
  }
  return value
}

export function jobId(raw) {
  if (typeof raw !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(raw)) {
    throw new Error('invalid job ID')
  }
  return raw
}

// createSnapshotWriter renders a sequence of snapshots onto a write-only
// stream. Appends append; a replacement says so and reprints in full — plain
// stdout cannot retract bytes, so the honest contract is "a sequence of
// revisions", not "a prefix of the final reply".
export function createSnapshotWriter(write) {
  let previous = ''
  return (text) => {
    text = String(text ?? '')
    if (text === previous) return
    if (text.startsWith(previous)) {
      write(text.slice(previous.length))
    } else {
      write('\n[reply revised; complete replacement follows]\n' + text)
    }
    previous = text
  }
}

// selectDownloads resolves a download target against a capture manifest.
// `all` refuses an incomplete manifest — a failed card must not vanish
// behind the successes — while an explicit index owns its own failure.
export function selectDownloads(manifest, target = 'all') {
  if (target === 'all') {
    const failed = manifest.filter((m) => !m.ok)
    if (failed.length) {
      const err = new Error(
        `${failed.length} of ${manifest.length} file card(s) could not be captured: ${failed
          .map((f) => `#${f.index + 1} (${f.reason})`)
          .join(', ')}`
      )
      err.code = 'INCOMPLETE_MANIFEST'
      throw err
    }
    return manifest
  }
  const n = positiveInteger(target, 'download index', { max: manifest.length })
  const entry = manifest[n - 1]
  if (!entry.ok) {
    const err = new Error(`file #${n} could not be captured: ${entry.reason}`)
    err.code = 'CAPTURE_FAILED'
    throw err
  }
  return [entry]
}

// profileProbe reports whether any process is running with this profile as
// its user-data-dir, without interpolating the path into a shell string —
// a path containing $(...) was command substitution, and regex
// metacharacters changed what matched.
export function profileBusyArgv(profileDir) {
  try {
    execFileSync('pgrep', ['-f', 'user-data-dir=' + profileDir], { stdio: 'pipe' })
    return true
  } catch (e) {
    // pgrep exits 1 when nothing matched; anything else is a real failure.
    if (e.status === 1) return false
    throw new Error('pgrep failed: ' + (e.stderr ? e.stderr.toString().trim() : e.message))
  }
}

// listenerPid reports the pid listening on port, via an argument vector.
export function listenerPid(port) {
  positiveInteger(port, 'CDP port', { max: 65535 })
  try {
    const out = execFileSync('lsof', ['-nP', '-t', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' })
    const n = parseInt(out.trim().split('\n')[0], 10)
    return Number.isInteger(n) ? n : null
  } catch {
    return null
  }
}

// spawnStarted spawns and awaits startup via the child's own 'spawn' and
// 'error' events: an exists-but-not-executable path rejects the returned
// promise instead of throwing inside an event handler the caller can never
// catch.
export function spawnStarted(bin, args, { detached = true, stdio = 'ignore' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { detached, stdio })
    child.once('error', (e) => reject(new Error(bin + ' failed to start: ' + e.message)))
    child.once('spawn', () => resolve(child))
  })
}

// spawnRunner starts a detached worker and closes the parent's log
// descriptor on every path. Launch failure rejects, so the caller can file
// the admitted generation as failed instead of leaving a reservation.
export async function spawnRunnerLogged(nodeBin, script, args, logFile) {
  const log = fs.openSync(logFile, 'a')
  try {
    const child = await spawnStarted(nodeBin, [script, ...args], { detached: true, stdio: ['ignore', log, log] })
    child.unref()
    return child
  } finally {
    try {
      fs.closeSync(log)
    } catch {}
  }
}

// saveArtifact writes bytes under a collision-safe, never-clobbering name.
// The write itself is complete-or-throws (writeFileSync handles short
// writes); an exclusive-open collision retries with a fresh suffix rather
// than failing; symlinked destinations are refused rather than followed.
export function saveArtifact(dir, name, id, bytes) {
  const safeBase = String(name || '').replace(/[^A-Za-z0-9._-]/g, '_') || 'file'
  const ext = path.extname(safeBase)
  const stem = safeBase.slice(0, safeBase.length - ext.length)
  const idTag = String(id).replace(/[^A-Za-z0-9]/g, '').slice(0, 8)
  let suffix = `-${idTag}`
  for (let n = 0; ; n++) {
    const base = stem + suffix + ext
    const dest = path.join(dir, base)
    let fd
    try {
      fd = fs.openSync(dest, 'wx', 0o600)
    } catch (e) {
      if (e.code === 'EEXIST') {
        let st
        try {
          st = fs.lstatSync(dest)
        } catch {}
        if (st && st.isSymbolicLink()) {
          throw new Error(`refusing to write through symlink ${dest}`)
        }
        suffix = `-${idTag}-${n + 2}-${crypto.randomUUID().slice(0, 4)}`
        continue
      }
      throw e
    }
    try {
      fs.writeSync(fd, bytes)
    } finally {
      fs.closeSync(fd)
    }
    return dest
  }
}

// chatListingOutcome decides a chats listing's honesty before any
// empty-list shortcut: an error with zero rows is a failure, not "no chats".
export function chatListingOutcome(result) {
  const items = (result && result.items) || []
  const error = (result && (result.lastError || result.error)) || null
  return { items, error, empty: items.length === 0 }
}
