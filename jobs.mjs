import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

export const HOME = process.env.CHATGPT_WEB_HOME || path.join(os.homedir(), '.chatgpt-web')
export const JOBS_DIR = path.join(HOME, 'jobs')
export const PROFILE_DIR = path.join(HOME, 'profile')
export const LOG_FILE = path.join(HOME, 'runner.log')

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function ensureDirs() {
  fs.mkdirSync(JOBS_DIR, { recursive: true })
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
}

export function newId() {
  return Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex')
}

export function jobPath(id) {
  return path.join(JOBS_DIR, id + '.json')
}

export function readJob(id) {
  try {
    return JSON.parse(fs.readFileSync(jobPath(id), 'utf8'))
  } catch {
    return null
  }
}

export function writeJob(job) {
  job.updatedAt = new Date().toISOString()
  const p = jobPath(job.id)
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(job, null, 2))
  fs.renameSync(tmp, p)
}

export function listJobs() {
  ensureDirs()
  return fs
    .readdirSync(JOBS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(JOBS_DIR, f), 'utf8'))
      } catch {
        return null
      }
    })
    .filter(Boolean)
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1))
}

export function pidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

export function runningJob() {
  return listJobs().find((j) => j.status === 'running' && pidAlive(j.pid)) || null
}

export function reapStale() {
  for (const j of listJobs()) {
    if (j.status === 'running' && !pidAlive(j.pid)) {
      j.status = 'error'
      j.error = j.pid ? `runner died (pid ${j.pid})` : 'runner never started'
      writeJob(j)
    }
  }
}

export const STATE_FILE = path.join(HOME, 'state.json')

export function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return { lastTurnEnd: 0, newChats: [], turns: {} }
  }
}

export function writeState(s) {
  fs.mkdirSync(HOME, { recursive: true })
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, STATE_FILE)
}

export function dayKey(d = new Date()) {
  return d.toISOString().slice(0, 10)
}

export function limits() {
  return {
    maxNewChatsHour: parseInt(process.env.CHATGPT_WEB_MAX_NEW_CHATS || '6', 10),
    maxTurnsDay: parseInt(process.env.CHATGPT_WEB_MAX_TURNS_DAY || '100', 10),
    minGapMs: parseInt(process.env.CHATGPT_WEB_MIN_GAP || '8', 10) * 1000,
  }
}

export function checkLimits(s, isNewChat) {
  const L = limits()
  const today = (s.turns || {})[dayKey()] || 0
  if (today >= L.maxTurnsDay) {
    return `daily turn cap reached (${today}/${L.maxTurnsDay}) — raise CHATGPT_WEB_MAX_TURNS_DAY or wait`
  }
  if (isNewChat) {
    const recent = (s.newChats || []).filter((t) => Date.now() - t < 3600000)
    if (recent.length >= L.maxNewChatsHour) {
      return `new-chat cap reached (${recent.length}/${L.maxNewChatsHour} per hour) — use send on an existing job or wait`
    }
  }
  return null
}

export function recordTurn(s, isNewChat) {
  const k = dayKey()
  s.turns = s.turns || {}
  s.turns[k] = (s.turns[k] || 0) + 1
  for (const old of Object.keys(s.turns)) if (old !== k && Object.keys(s.turns).length > 7) delete s.turns[old]
  if (isNewChat) {
    s.newChats = [...(s.newChats || []).filter((t) => Date.now() - t < 3600000), Date.now()]
  }
  writeState(s)
}
