#!/usr/bin/env node
// Worker entry point: the ONLY place process-fatal handlers are installed.
// Importing runner.mjs must stay side-effect free — the CLI imports it for
// login/chats/model/status/dot paths. This wrapper validates its own argv,
// fences fatals (abort first, then file the failure into the active turn,
// with a forced-exit watchdog that never touches the Chrome daemon), holds
// a per-turn lifetime worker lock, and records launch failures honestly.
import { turns, withLock } from './jobs.mjs'
import { jobId } from './core-fixes.mjs'
import { installFatalHandlers } from './audit-io.mjs'

const [mode, rawId, tid] = process.argv.slice(2)
let runner = null
let active = null
installFatalHandlers({
  getActive: () => active,
  stop: (error) => runner?.abortRunner(error),
  fail: async (turn, error) => {
    console.error(error.message)
    if (turn) {
      await turns.update(turn.id, turn.tid, (j) => {
        j.status = 'error'
        j.error = error.message
      })
    }
  },
})
try {
  const id = jobId(rawId)
  if (!['job', 'resume'].includes(mode) || typeof tid !== 'string' || !/^[0-9a-f-]{36}$/i.test(tid)) {
    throw new Error('invalid worker invocation')
  }
  active = { id, tid }
  runner = await import('./runner.mjs')
  runner.validateRunnerConfig()
  await withLock('worker-' + tid, async () => {
    if (mode === 'job') await runner.runTurn(id, tid)
    else await runner.runResume(id, tid)
  })
} catch (e) {
  console.error(e.message)
  process.exitCode = 1
  if (active) {
    await turns
      .update(active.id, active.tid, (j) => {
        j.status = 'error'
        j.error = e.message
      })
      .catch((reportError) => console.error('could not record worker failure: ' + reportError.message))
  }
} finally {
  active = null
}
