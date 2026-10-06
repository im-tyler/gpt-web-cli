import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

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

test('parseSliderDesc reads the described stop text', async () => {
  const runner = await loadRunner()
  const p = runner.parseSliderDesc
  assert.deepEqual(p('Pro, 5 of 5. Use Left and Right arrow keys to adjust power'), { name: 'Pro', n: 5, total: 5 })
  assert.deepEqual(p('Extra High, 4 of 5.'), { name: 'Extra High', n: 4, total: 5 })
  assert.deepEqual(p('Instant, 1 of 5.'), { name: 'Instant', n: 1, total: 5 })
  assert.equal(p('Use Left and Right arrow keys to adjust power'), null)
  assert.equal(p(''), null)
  assert.equal(p(null), null)
  assert.equal(p('Broken, 7 of 5.'), null, 'position beyond total refuses')
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

test('unhandled rejection fails the registered turn instead of dying silently', async () => {
  freshHome()
  const jobsMod = await import(`./jobs.mjs?h=${crypto.randomUUID()}`)
  const job = jobsMod.turns.createLocked({ id: 't1', prompt: 'p', files: [], history: [] })
  const home = process.env.CHATGPT_WEB_HOME

  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', `
      const runner = await import(${JSON.stringify(new URL('./runner.mjs', import.meta.url).href)})
      runner.registerActiveTurn('t1', ${JSON.stringify(job.turnId)})
      Promise.reject(new Error('boom-from-test'))
      await new Promise((r) => setTimeout(r, 1500))
    `],
    { env: { ...process.env, CHATGPT_WEB_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let stderr = ''
  child.stderr.on('data', (d) => { stderr += d })
  const code = await new Promise((resolve) => child.on('close', resolve))

  assert.notEqual(code, 0, 'the worker exits non-zero')
  assert.match(stderr, /unhandled rejection: boom-from-test/)
  const after = jobsMod.readJob('t1')
  assert.equal(after.status, 'error')
  assert.match(after.error, /unhandled rejection: boom-from-test/)
})

test('unhandled rejection without an active turn does not crash the command', async () => {
  freshHome()
  const home = process.env.CHATGPT_WEB_HOME
  const child = spawn(
    process.execPath,
    ['--input-type=module', '-e', `
      await import(${JSON.stringify(new URL('./runner.mjs', import.meta.url).href)})
      Promise.reject(new Error('quiet-boom'))
      await new Promise((r) => setTimeout(r, 800))
      console.log('still alive')
    `],
    { env: { ...process.env, CHATGPT_WEB_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] }
  )
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  const code = await new Promise((resolve) => child.on('close', resolve))
  assert.match(out, /still alive/)
  assert.notEqual(code, 0)
})
