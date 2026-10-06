// A5: dot sends run in the CLI's own foreground across a real click →
// verification window. These tests pin the honest failure filing: after
// dispatch, every failure (a throw, and by the fence an interrupt) records
// an inspect-before-retry diagnosis — never the reaper's "runner died",
// which invites a duplicate send. cmdDotMessage takes an injected sender,
// so no browser is touched.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// One HOME for this file's process, bound before the first cli.mjs/jobs.mjs
// import (node --test runs each file in its own process).
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-cli-test-'))
process.env.CHATGPT_WEB_HOME = HOME
process.env.CHATGPT_WEB_MIN_GAP = '0'

const jobByPrompt = (jobs, prompt) => jobs.listJobs().find((j) => j.prompt === prompt)

test('cmdDotMessage files an inspect-first error when dispatch passed but verification failed (A5)', async () => {
  const cli = await import('./cli.mjs')
  const jobs = await import('./jobs.mjs')
  await assert.rejects(
    cli.cmdDotMessage('hello after dispatch', {
      runDotSend: async (text, reservation) => {
        // Mid-window: the guarded click happened, acceptance polling died.
        await jobs.turns.update(reservation.jobId, reservation.turnId, (j) => {
          j.submissionState = 'dispatched'
        })
        throw new Error('page closed during acceptance polling')
      },
    }),
    /page closed/
  )
  const job = jobByPrompt(jobs, 'hello after dispatch')
  assert.ok(job, 'the dot-send generation was recorded')
  assert.equal(job.kind, 'dot-send')
  assert.equal(job.status, 'error')
  assert.match(job.error, /page closed during acceptance polling/)
  assert.match(job.error, /may have been sent; inspect the dot thread before retrying/)
  assert.doesNotMatch(job.error, /runner died/)
})

test('cmdDotMessage pre-dispatch failures do not claim the message was sent (A5)', async () => {
  const cli = await import('./cli.mjs')
  const jobs = await import('./jobs.mjs')
  await assert.rejects(
    cli.cmdDotMessage('hello before dispatch', {
      runDotSend: async () => {
        throw new Error('dot room has no composer')
      },
    }),
    /no composer/
  )
  const job = jobByPrompt(jobs, 'hello before dispatch')
  assert.equal(job.status, 'error')
  assert.match(job.error, /dot room has no composer/)
  assert.doesNotMatch(job.error, /may have been sent/)
})

test('cmdDotMessage success marks the generation done=sent (A5)', async () => {
  const cli = await import('./cli.mjs')
  const jobs = await import('./jobs.mjs')
  await cli.cmdDotMessage('hello happy path', {
    runDotSend: async () => {},
  })
  const job = jobByPrompt(jobs, 'hello happy path')
  assert.equal(job.status, 'done')
  assert.equal(job.submissionState, 'sent')
})
