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
// via response.status.
export async function getBackendJSON(page, urlPath, timeoutMs = 15000) {
  const result = await page
    .evaluate(async ({ urlPath, timeoutMs }) => {
      try {
        const s = await (await fetch('/api/auth/session', { credentials: 'include' })).json()
        const token = s && s.accessToken
        if (!token) return { error: 'no access token' }
        const r = await fetch(urlPath, {
          headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
          credentials: 'include',
          signal: AbortSignal.timeout(timeoutMs),
        })
        if (!r.ok) return { status: r.status, error: 'http ' + r.status }
        return { status: r.status, data: await r.json() }
      } catch (e) {
        return { error: String((e && e.message) || e) }
      }
    }, { urlPath, timeoutMs: Math.max(1, timeoutMs) })
    .catch((e) => ({ error: e.message }))
  if (!result || result.error) {
    return {
      ok: false,
      status: (result && result.status) || 0,
      data: null,
      error: (result && result.error) || 'page evaluation failed',
    }
  }
  return { ok: true, status: result.status, data: result.data, error: null }
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
