import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-wait-json-'))
process.env.CHATGPT_WEB_HOME = home
const { turns } = await import('./jobs.mjs')

function wait(id, args = []) {
  return spawnSync(process.execPath, ['cli.mjs', 'wait', id, ...args, '--json'], {
    cwd: import.meta.dirname,
    env: { ...process.env, CHATGPT_WEB_HOME: home },
    encoding: 'utf8',
    timeout: 10000,
  })
}

async function job(id, status) {
  const j = turns.createLocked({ id, prompt: 'question', files: [], history: [] })
  await turns.claim(id, j.turnId, process.pid)
  if (status !== 'running') await turns.update(id, j.turnId, x => {
    x.status = status
    if (status === 'error') x.error = 'acceptance unknown; inspect before retry'
    if (status === 'done') { x.reply = 'the answer'; x.acceptedUserId = 'u1' }
  })
  return j
}

test('wait JSON preserves the completed result and exit 0', async () => {
  const j = await job('complete', 'done')
  const r = wait(j.id)
  assert.equal(r.status, 0)
  assert.equal(r.stderr, '')
  const result = JSON.parse(r.stdout)
  assert.equal(result.reply, 'the answer')
  assert.equal(result.turnId, j.turnId)
  assert.equal(result.acceptedUserId, 'u1')
})

test('wait JSON files a worker error as one JSON result and exit 1', async () => {
  const j = await job('failed', 'error')
  const r = wait(j.id)
  assert.equal(r.status, 1)
  assert.equal(r.stderr, '')
  assert.deepEqual(JSON.parse(r.stdout), {
    id: j.id, turnId: j.turnId, status: 'error', code: 'WAIT_FAILED',
    error: 'acceptance unknown; inspect before retry',
  })
})

test('wait JSON reports a missing job without plain text', () => {
  const r = wait('missing')
  assert.equal(r.status, 1)
  assert.equal(r.stderr, '')
  assert.equal(JSON.parse(r.stdout).error, 'no such job: missing')
})

test('wait JSON refuses a superseded generation without returning its reply', async () => {
  const j = await job('superseded', 'done')
  const r = wait(j.id, ['--turn', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'])
  assert.equal(r.status, 1)
  assert.equal(r.stderr, '')
  const result = JSON.parse(r.stdout)
  assert.equal(result.turnId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
  assert.equal(result.status, 'error')
  assert.match(result.error, /superseded/)
  assert.equal(result.reply, undefined)
})

test('wait JSON timeout leaves the running worker untouched', async () => {
  const j = await job('timeout', 'running')
  const r = wait(j.id, ['1'])
  assert.equal(r.status, 1)
  assert.equal(r.stderr, '')
  assert.match(JSON.parse(r.stdout).error, /worker was not cancelled/)
  const { readJob } = await import('./jobs.mjs')
  assert.equal(readJob(j.id).status, 'running')
})

test.after(() => fs.rmSync(home, { recursive: true, force: true }))
