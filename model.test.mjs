import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Every test gets its own HOME so the real ~/.chatgpt-web is untouched.
function freshHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-model-test-'))
  process.env.CHATGPT_WEB_HOME = home
  process.env.CHATGPT_WEB_MIN_GAP = '0'
  return home
}

async function loadRunner() {
  return import(`./runner.mjs?h=${crypto.randomUUID()}`)
}

const STOPS = [
  { n: 1, total: 5, name: 'Instant', effective: 'Instant' },
  { n: 2, total: 5, name: 'Medium', effective: 'Medium' },
  { n: 3, total: 5, name: 'High', effective: 'High' },
  { n: 4, total: 5, name: 'Extra High', effective: 'Extra High' },
  { n: 5, total: 5, name: 'Pro', effective: '6 Pro' },
]
const MODELS = ['Latest', 'GPT-5.6 Sol', 'GPT-5.5 Leaving on October 14']

const run = (file, argv, env = {}) =>
  new Promise((resolve) => {
    const child = spawn(process.execPath, [file, ...argv], {
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('close', (code) => resolve({ code, out, err }))
  })

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(HERE, 'runner-entry.mjs')

test('parseSliderDescription reads the described stop text, strictly', async () => {
  const { parseSliderDescription: p } = await import('./audit-core.mjs')
  assert.deepEqual(p('Pro, 5 of 5. Use Left and Right arrow keys to adjust power'), { name: 'Pro', n: 5, total: 5 })
  assert.deepEqual(p('Extra High, 4 of 5.'), { name: 'Extra High', n: 4, total: 5 })
  assert.deepEqual(p('Instant, 1 of 5.'), { name: 'Instant', n: 1, total: 5 })
  assert.equal(p('Use Left and Right arrow keys to adjust power'), null)
  assert.equal(p(''), null)
  assert.equal(p(null), null)
  assert.equal(p('Broken, 7 of 5.'), null, 'position beyond total refuses')
  assert.equal(p('Huge, 3 of 9999.'), null, 'unreasonable total refuses')
  assert.equal(p('Zero, 0 of 5.'), null, 'position 0 refuses')
})

test('sliderEqual compares the full readable state, not just the number', async () => {
  const { sliderEqual } = await import('./audit-core.mjs')
  const base = { name: 'Pro', n: 5, total: 5, effective: '6 Pro' }
  assert.ok(sliderEqual(base, { ...base }))
  assert.ok(sliderEqual(null, null), 'absent is a stable observation')
  assert.ok(!sliderEqual(base, null))
  assert.ok(!sliderEqual(base, { ...base, n: 4 }), 'different position differs')
  assert.ok(
    !sliderEqual(base, { ...base, effective: '6.5 Pro' }),
    'same number with an unsettled effective label differs'
  )
  assert.ok(!sliderEqual(base, { ...base, name: 'PRO' }))
})

test('pickPickerMatch: slider stops match by name and effective label', async () => {
  const runner = await loadRunner()
  const m = runner.pickPickerMatch
  const sixPro = m(MODELS, STOPS, '6 pro')
  assert.equal(sixPro.kind, 'slider')
  assert.equal(sixPro.n, 5)
  assert.equal(sixPro.label, 'Pro')
  assert.equal(sixPro.effective, '6 Pro')

  // "pro" hits the stop through both its name and effective label — one entry.
  const pro = m(MODELS, STOPS, 'pro')
  assert.equal(pro.kind, 'slider')
  assert.equal(pro.n, 5)

  assert.equal(m(MODELS, STOPS, 'instant').n, 1)
  assert.equal(m(MODELS, STOPS, 'extra high').n, 4)
})

test('pickPickerMatch: named models keep substring semantics', async () => {
  const runner = await loadRunner()
  const m = runner.pickPickerMatch
  const sol = m(MODELS, STOPS, 'sol')
  assert.equal(sol.kind, 'model')
  assert.equal(sol.label, 'GPT-5.6 Sol')
  assert.equal(m(MODELS, STOPS, 'latest').label, 'Latest')
  assert.equal(m(MODELS, [], '5.5').label, 'GPT-5.5 Leaving on October 14')
})

test('pickPickerMatch: ambiguity refuses, no match refuses', async () => {
  const runner = await loadRunner()
  const m = runner.pickPickerMatch
  assert.match(m(MODELS, STOPS, 'high').error, /matches 2 options: High \(3 of 5\) \| Extra High \(4 of 5\)/)
  // "gpt" matches both named GPT models and nothing else.
  assert.match(m(MODELS, STOPS, 'gpt').error, /matches 2 options/)
  assert.match(m(MODELS, STOPS, 'nope').error, /no model or power stop matches/)
  assert.match(m(MODELS, STOPS, '').error, /empty/)
})

// P02: importing the runner is inert — no process handlers, no dispatch.
test('importing the runner installs no process handlers and runs no command', async () => {
  freshHome()
  const before = process.listenerCount('unhandledRejection') + process.listenerCount('uncaughtException')
  const runner = await loadRunner()
  assert.equal(typeof runner.validateRunnerConfig, 'function')
  assert.equal(typeof runner.abortRunner, 'function')
  assert.equal(typeof runner.registerActiveTurn, 'undefined', 'the old import-time net is gone')
  const after = process.listenerCount('unhandledRejection') + process.listenerCount('uncaughtException')
  assert.equal(after, before)
})

// P02: invalid environment values throw from validateRunnerConfig instead
// of exiting at import time.
test('validateRunnerConfig throws on invalid env values', async () => {
  freshHome()
  process.env.CHATGPT_WEB_TIMEOUT = 'bogus'
  try {
    const runner = await loadRunner()
    assert.throws(() => runner.validateRunnerConfig(), /CHATGPT_WEB_TIMEOUT/)
  } finally {
    delete process.env.CHATGPT_WEB_TIMEOUT
  }
})

// P02: the worker entry refuses invalid invocations and exits non-zero.
test('runner-entry refuses invalid worker invocations', async () => {
  freshHome()
  const bad = await run(ENTRY, ['nonsense'])
  assert.notEqual(bad.code, 0)
  assert.match(bad.err, /invalid job ID|invalid worker invocation/)
  const badMode = await run(ENTRY, ['frobnicate', 'somejob-1', crypto.randomUUID()])
  assert.notEqual(badMode.code, 0)
  assert.match(badMode.err, /invalid worker invocation/)
})

// P02: a valid-looking invocation against an unknown job claims nothing,
// reports the inadmissible turn and exits non-zero.
test('runner-entry reports inadmissible turns and exits non-zero', async () => {
  freshHome()
  const res = await run(ENTRY, ['job', 'nosuchjob-1', crypto.randomUUID()])
  assert.notEqual(res.code, 0)
  assert.match(res.err, /not admissible/)
})

// P02: fatal handlers live in the ENTRY — a rejection aborts, files the
// active turn's error, and exits non-zero.
test('fatal handlers file the active turn error and exit non-zero', async () => {
  freshHome()
  const home = process.env.CHATGPT_WEB_HOME
  const jobsUrl = new URL('./jobs.mjs', import.meta.url).href
  const ioUrl = new URL('./audit-io.mjs', import.meta.url).href
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', `
      const { turns } = await import(${JSON.stringify(jobsUrl)})
      const { installFatalHandlers } = await import(${JSON.stringify(ioUrl)})
      const job = turns.createLocked({ id: 't1', prompt: 'p', files: [], history: [] })
      await turns.claim('t1', job.turnId, process.pid)
      installFatalHandlers({
        getActive: () => ({ id: 't1', tid: job.turnId }),
        stop: () => {},
        fail: async (turn, error) => {
          await turns.update(turn.id, turn.tid, (j) => { j.status = 'error'; j.error = error.message })
        },
      })
      Promise.reject(new Error('boom-entry'))
      await new Promise((r) => setTimeout(r, 4000))
      console.log('should not reach a clean end')
    `],
    { env: { ...process.env, CHATGPT_WEB_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.notEqual(code, 0, 'the fenced worker exits non-zero')
  assert.match(stderr, /unhandled rejection: boom-entry/)
  const jobs = await import(`./jobs.mjs?h=${crypto.randomUUID()}`)
  const after = jobs.readJob('t1')
  assert.equal(after.status, 'error')
  assert.match(after.error, /unhandled rejection: boom-entry/)
})
