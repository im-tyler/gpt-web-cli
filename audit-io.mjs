// audit-io: every helper that touches the filesystem, the process, or a
// Playwright page. Keep audit-core.mjs pure; keep this module free of
// import-time side effects (no handler installation, no validation exits —
// that is the worker entry's job).
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

// Bounded transfers: intercepted bodies and browser-mediated downloads cap
// at this size rather than allocating whatever arrives.
export const ARTIFACT_MAX_BYTES = 128 * 1024 * 1024

// writeOutput awaits the stream's acceptance of the bytes: a detected
// broken pipe surfaces as a rejection instead of a silent drop.
export function writeOutput(stream, text) {
  return new Promise((resolve, reject) => {
    stream.write(text, (err) => (err ? reject(err) : resolve()))
  })
}

export function validateUploads(paths) {
  const list = Array.isArray(paths) ? paths : [paths]
  const checked = []
  for (const p of list) {
    if (typeof p !== 'string' || !p.trim()) throw new Error('invalid upload path')
    const abs = path.resolve(p)
    let st
    try {
      st = fs.statSync(abs)
    } catch {
      throw new Error('no such file: ' + p)
    }
    if (!st.isFile()) throw new Error('not a regular file: ' + p)
    if (st.size > ARTIFACT_MAX_BYTES) {
      throw new Error(`file exceeds the transfer cap (${st.size} > ${ARTIFACT_MAX_BYTES} bytes): ` + p)
    }
    checked.push(abs)
  }
  return checked
}

// writeJSONAtomic: private temp file, full data + metadata durability
// attempt, atomic rename, and temp cleanup on every failure path. Unsupported
// directory fsync is tolerated (not a universal power-loss guarantee).
export function writeJSONAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = file + '.' + process.pid + '.' + crypto.randomUUID() + '.tmp'
  let fd = null
  try {
    fd = fs.openSync(tmp, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify(value, null, 2))
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = null
    fs.renameSync(tmp, file)
    try {
      const dir = fs.openSync(path.dirname(file), 'r')
      try {
        fs.fsyncSync(dir)
      } finally {
        fs.closeSync(dir)
      }
    } catch {
      // directory fsync is unsupported on some platforms — tolerated
    }
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd)
      } catch {}
    }
    try {
      fs.unlinkSync(tmp)
    } catch {
      // the rename consumed it on success; nothing to clean otherwise
    }
  }
}

// readJSONStrict returns `missing` only for a genuinely absent file. A
// corrupt or unreadable record throws: treating it as absent used to reset
// caps and hide jobs.
export function readJSONStrict(file, { missing = null, validate } = {}) {
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch (e) {
    if (e.code === 'ENOENT') return missing
    throw new Error(`cannot read ${path.basename(file)}: ${e.message}`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    throw new Error(
      `${path.basename(file)} is corrupt (${e.message}) — fix or remove it; refusing to treat it as absent`
    )
  }
  if (typeof validate === 'function') {
    const problem = validate(parsed)
    if (problem) throw new Error(`${path.basename(file)} failed validation: ${problem}`)
  }
  return parsed
}

// Private-by-default append for logs that carry prompts and replies.
export function openPrivateLog(file) {
  const fd = fs.openSync(file, 'a')
  try {
    fs.fchmodSync(fd, 0o600)
  } catch {}
  return fd
}

// getBackendJSON performs an authenticated GET against a backend-api path
// from the page's origin (session cookies + bearer token apply). Read-only;
// timeout-bounded; never throws for HTTP status — callers decide retryability
// via response.status. The bearer is cached in the page for its TTL: the
// wait loops poll this helper continuously, and re-fetching
// /api/auth/session on every tick doubled the request cadence (a metronomic
// tell, and extra 429 pressure). A 401 invalidates the cache and retries
// once with a fresh session read.
//
// Auth-gone is CLASSIFIED, not swallowed (B5): a session endpoint that
// answers non-2xx, or answers without an accessToken, is a logged-out page
// — the result carries its status (401 for a token-less 200) and auth: true
// so callers fail fast with login guidance instead of retrying a dead
// session to the deadline as generic status 0.
export async function getBackendJSON(page, urlPath, timeoutMs = 15000) {
  const result = await page
    .evaluate(async ({ urlPath, timeoutMs }) => {
      const authFailure = (status) => ({ error: 'not logged in (session auth failed ' + status + ')', auth: true, status })
      const readToken = async () => {
        const cached = window.__cgwBearer
        if (cached && cached.token && (!cached.exp || cached.exp > Date.now() + 60000)) return { token: cached.token }
        const sr = await fetch('/api/auth/session', {
          credentials: 'include',
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!sr.ok) return authFailure(sr.status || 401)
        const s = await sr.json().catch(() => null)
        const token = s && s.accessToken
        if (!token) return authFailure(401)
        let exp = 0
        try {
          const seg = String(token).split('.')[1] || ''
          const b64 = seg.replace(/-/g, '+').replace(/_/g, '/')
          const payload = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)))
          exp = (Number(payload.exp) || 0) * 1000
        } catch {}
        window.__cgwBearer = { token, exp }
        return { token }
      }
      const call = (token) =>
        fetch(urlPath, {
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
          credentials: 'include',
          signal: AbortSignal.timeout(timeoutMs),
        })
      let tok = await readToken()
      if (tok.auth) return tok
      let r = await call(tok.token)
      if (r.status === 401) {
        window.__cgwBearer = null
        tok = await readToken()
        if (tok.auth) return tok
        r = await call(tok.token)
      }
      if (!r.ok) return { status: r.status, error: 'http ' + r.status }
      return { status: r.status, data: await r.json() }
    }, { urlPath, timeoutMs: Math.max(1, timeoutMs) })
    .catch((e) => ({ error: e.message }))
  if (!result || result.error) {
    return {
      ok: false,
      status: (result && typeof result.status === 'number' && result.status) || 0,
      data: null,
      error: (result && result.error) || 'page evaluation failed',
      auth: !!(result && result.auth),
    }
  }
  return { ok: true, status: result.status, data: result.data, error: null, auth: false }
}

// evaluateBounded races a page.evaluate against a wall-clock bound:
// evaluate has no default timeout of its own, so an in-page hang (wedged
// transport, swallowed service-worker interception) suspends the caller
// forever — and when the caller holds a store flock, that wedges every
// other CLI process. The losing evaluation settles on its own (its fetches
// carry abort signals); its eventual rejection is absorbed so it can never
// surface later as an unhandled one.
//
// B1: for MUTATION evaluations (the delete PATCH loop) a fired bound must
// not detach a still-running loop — the caller would report failure and
// release its store lock while the page keeps mutating. Pass `cancel`
// (sets the in-page stop flag) and `settleMs`: when the bound fires, the
// cancel is signalled best-effort (itself bounded at 2s) and the
// evaluation then gets settleMs to return its real per-item outcome. Only
// an evaluation that ignores both the flag and the settle window rejects.
export async function evaluateBounded(page, fn, arg, timeoutMs = 30000, label = 'page evaluation', { cancel = null, settleMs = 0 } = {}) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new Error('invalid evaluation timeout')
  const evaluation = page.evaluate(fn, arg)
  evaluation.catch(() => {})
  const bounded = async (ms, message) => {
    let timer = null
    try {
      return await Promise.race([
        evaluation,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            const e = new Error(message)
            e.boundedTimeout = true
            reject(e)
          }, ms)
        }),
      ])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }
  try {
    return await bounded(timeoutMs, `${label} timed out after ${timeoutMs}ms`)
  } catch (e) {
    if (!e.boundedTimeout || typeof cancel !== 'function') throw e
    let cancelTimer = null
    try {
      await Promise.race([
        Promise.resolve(cancel()),
        new Promise((_, reject) => {
          cancelTimer = setTimeout(() => reject(new Error('cancel signalling timed out')), 2000)
        }),
      ])
    } catch {
      // best-effort: a wedged transport cannot hang the cancel; the loop's
      // own per-fetch aborts still bound it
    } finally {
      if (cancelTimer !== null) clearTimeout(cancelTimer)
    }
    if (Number.isSafeInteger(settleMs) && settleMs > 0) {
      return await bounded(settleMs, `${label} timed out after ${timeoutMs}ms (cancel signalled; the page did not settle within ${settleMs}ms)`)
    }
    throw e
  }
}

// installInterruptionFence gives a FOREGROUND operation (the CLI's dot
// send) the fencing workers get from runner-entry: an interrupt or fatal
// process error mid-run files an honest terminal record instead of dying
// silently for the reaper to misdiagnose as "runner died (pid N)" — which
// invites a blind retry after a dispatch that may already have landed.
// `file(detail)` persists the error record; `cleanup()` (B6) releases
// resources the normal path would have released — e.g. closing the page
// the interrupted operation is inside `withPage` with, so the exit cannot
// leak a stray daemon tab per interrupted send. Both are watchdog-bounded
// and the process exits non-zero afterwards. close() removes the handlers
// on a normal finish. interrupt() is the handler body and `exit` the exit
// function — both injectable for tests.
export function installInterruptionFence({ file, cleanup = null, exitCode = 130, exit = process.exit } = {}) {
  if (typeof file !== 'function') throw new TypeError('installInterruptionFence needs a file function')
  if (cleanup !== null && typeof cleanup !== 'function') throw new TypeError('installInterruptionFence cleanup must be a function')
  if (typeof exit !== 'function') throw new TypeError('installInterruptionFence exit must be a function')
  let closed = false
  let filing = false
  const interrupted = async (why) => {
    if (closed || filing) return
    filing = true
    process.exitCode = exitCode
    const watchdog = setTimeout(() => exit(exitCode), 8000)
    if (watchdog.unref) watchdog.unref()
    try {
      // Stop the in-page work FIRST (B6): no further browser mutation can
      // race the filing, and the tab is closed before the exit instead of
      // leaking on the shared daemon.
      if (typeof cleanup === 'function') {
        try {
          await cleanup()
        } catch {}
      }
      const detail = why ? String(why).slice(0, 160) : ''
      await file(detail)
    } catch {}
    exit(exitCode)
  }
  const onSignal = (signal) => interrupted(signal)
  const onFatal = (reason) => interrupted('fatal: ' + String((reason && reason.message) || reason))
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  process.on('SIGHUP', onSignal)
  process.on('unhandledRejection', onFatal)
  process.on('uncaughtException', onFatal)
  return {
    interrupt: interrupted,
    close() {
      closed = true
      process.off('SIGINT', onSignal)
      process.off('SIGTERM', onSignal)
      process.off('SIGHUP', onSignal)
      process.off('unhandledRejection', onFatal)
      process.off('uncaughtException', onFatal)
    },
  }
}

// boundedBrowserDownload fetches a descriptor URL inside the page with an
// exact-origin allowlist, no redirects, a hard byte cap enforced on the
// stream, and a compact base64 transfer (the old path shipped a per-byte
// numeric array through the CDP boundary).
export async function boundedBrowserDownload(page, href, { maxBytes = ARTIFACT_MAX_BYTES, allowedOrigins = ['https://chatgpt.com'] } = {}) {
  let target
  try {
    target = new URL(href)
  } catch {
    throw new Error('invalid artifact URL')
  }
  if (
    target.protocol !== 'https:' ||
    target.username ||
    target.password ||
    !allowedOrigins.includes(target.origin)
  ) {
    throw new Error('artifact URL is not on an allowed origin: ' + target.origin)
  }
  const result = await page
    .evaluate(async ({ href, maxBytes }) => {
      try {
        const response = await fetch(href, { credentials: 'same-origin', signal: AbortSignal.timeout(60000) })
        if (response.redirected) return { error: 'artifact URL redirected (unsupported)' }
        if (!response.ok) return { error: 'download http ' + response.status }
        const declared = Number(response.headers.get('content-length')) || 0
        if (declared > maxBytes) return { error: 'artifact exceeds size cap (' + declared + ' bytes)' }
        const chunks = []
        let total = 0
        if (response.body && typeof response.body.getReader === 'function') {
          const reader = response.body.getReader()
          for (;;) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > maxBytes) {
              try {
                await reader.cancel()
              } catch {}
              return { error: 'artifact exceeded size cap during transfer (' + total + ' bytes)' }
            }
            chunks.push(value)
          }
        } else {
          const buf = await response.arrayBuffer()
          if (buf.byteLength > maxBytes) return { error: 'artifact exceeds size cap' }
          chunks.push(new Uint8Array(buf))
          total = buf.byteLength
        }
        let binary = ''
        for (const chunk of chunks) {
          for (let i = 0; i < chunk.length; i += 0x8000) {
            binary += String.fromCharCode.apply(null, chunk.subarray(i, Math.min(i + 0x8000, chunk.length)))
          }
        }
        return { b64: btoa(binary), total }
      } catch (e) {
        return { error: String((e && e.message) || e) }
      }
    }, { href: target.href, maxBytes })
    .catch((e) => ({ error: e.message }))
  if (!result || result.error) throw new Error('artifact download failed: ' + ((result && result.error) || 'page evaluation failed'))
  const bytes = Buffer.from(result.b64, 'base64')
  if (result.total !== undefined && bytes.length !== result.total) {
    throw new Error('artifact transfer truncated')
  }
  return bytes
}

// installFatalHandlers fences the worker: a fatal process error (unhandled
// rejection, uncaught exception) aborts the runner first — so no later
// browser mutation can happen — files the failure into the active turn,
// reports it, and keeps a forced-exit watchdog so a hung cleanup cannot
// leave a zombie worker. It never touches the long-lived Chrome daemon.
export function installFatalHandlers({ getActive, stop, fail }) {
  let handling = false
  const handle = (kind) => async (reason) => {
    if (handling) return
    handling = true
    const message = kind + ': ' + String((reason && reason.message) || reason)
    try {
      console.error(message)
    } catch {}
    process.exitCode = 1
    const turn = typeof getActive === 'function' ? getActive() : null
    // Watchdog first: even a stuck stop()/fail() path must not leave the
    // worker alive in an unknown state.
    const watchdog = setTimeout(() => process.exit(1), 8000)
    if (watchdog.unref) watchdog.unref()
    try {
      if (typeof stop === 'function') {
        await stop(reason instanceof Error ? reason : new Error(String(reason)))
      }
    } catch {}
    if (turn && typeof fail === 'function') {
      try {
        await fail(turn, new Error(message))
      } catch (e) {
        try {
          console.error('could not record worker failure: ' + e.message)
        } catch {}
      }
    }
    clearTimeout(watchdog)
    // Give the natural abort-propagation path a moment to unwind and flush
    // output; then force the exit.
    const exit = setTimeout(() => process.exit(1), 1500)
    if (exit.unref) exit.unref()
  }
  process.on('unhandledRejection', handle('unhandled rejection'))
  process.on('uncaughtException', handle('uncaught exception'))
}
