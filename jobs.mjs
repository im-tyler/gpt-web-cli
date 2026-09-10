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
