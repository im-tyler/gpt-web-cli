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

// B6: exit-130 must not race a just-verified send — a generation already
// marked done (terminal) is never overwritten by the interruption filing
// (the turn store's terminal immutability), so the fence's update is a
// documented no-op instead of a resurrection.
test('a done dot-send generation is not overwritten by an interruption-style filing (B6)', async () => {
  const cli = await import('./cli.mjs')
  const jobs = await import('./jobs.mjs')
  const { dotSendInterruption } = await import('./audit-core.mjs')
  await cli.cmdDotMessage('done before the signal lands', { runDotSend: async () => {} })
  const job = jobByPrompt(jobs, 'done before the signal lands')
  assert.equal(job.status, 'done')
  assert.equal(job.submissionState, 'sent')
  // The fence's file() body: classify by the CURRENT record, then update.
  const updated = await jobs.turns.update(job.id, job.turnId, (j) => {
    j.status = 'error'
    j.error = dotSendInterruption('sent')
  })
  assert.equal(updated, null, 'the store refused to mutate a terminal generation')
  const after = jobs.readJob(job.id)
  assert.equal(after.status, 'done', 'the record still says done')
  assert.equal(after.error, null)
})
