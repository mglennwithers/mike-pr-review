// Shared helpers for the pr-review scripts. Node >= 18, no dependencies.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const SKILL_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
// Change-size tiers, smallest first. profiles.json keys its thresholds by these names (huge = everything above large).
export const TIERS = ['trivial', 'small', 'medium', 'large', 'huge']
// Resolved once: git commands run with other working directories, so a relative PR_REVIEW_HOME would point somewhere else for them.
// Precedence: PR_REVIEW_HOME, then <CLAUDE_CONFIG_DIR>/pr-review, then ~/.claude/pr-review.
export const HOME_DIR = process.env.PR_REVIEW_HOME ? path.resolve(process.env.PR_REVIEW_HOME) : path.join(process.env.CLAUDE_CONFIG_DIR ? path.resolve(process.env.CLAUDE_CONFIG_DIR) : path.join(os.homedir(), '.claude'), 'pr-review')

// Value-less flags of collect AND plan. `prr start` hands the same argument list to both, so each parser must know the
// other's booleans — otherwise "--no-tests 482" would read 482 as the value of --no-tests and review the wrong target.
export const FLAG_BOOLEANS = ['full', 'force', 'use_git_credential', 'no_worktree', 'no_tests', 'quiet', 'trust_code', 'no_critical_upgrade', 'confirmed']

export class UserError extends Error {
  constructor(message, { code = 1, data } = {}) {
    super(message)
    this.exitCode = code
    this.data = data
  }
}

// Run a program without a shell so arguments never need quoting (matters on Windows).
export function run(cmd, args, { cwd, input, env, allowFail = false, maxBuffer = 256 * 1024 * 1024 } = {}) {
  const r = spawnSync(cmd, args, {
    cwd, input, encoding: 'utf8', maxBuffer, windowsHide: true,
    env: env ? { ...process.env, ...env } : process.env,
  })
  if (r.error) {
    if (allowFail) return { ok: false, code: -1, stdout: '', stderr: String(r.error.message) }
    throw new UserError(`Failed to run ${cmd}: ${r.error.message}`)
  }
  const out = { ok: r.status === 0, code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' }
  if (!out.ok && !allowFail) {
    throw new UserError(`${cmd} ${args.join(' ')} failed (${r.status}): ${out.stderr.trim().slice(0, 2000)}`)
  }
  return out
}

export function hasCommand(cmd) {
  const r = spawnSync(cmd, ['--version'], { encoding: 'utf8', windowsHide: true })
  return !r.error && r.status === 0
}

export const sha1 = (s) => createHash('sha1').update(s).digest('hex')

export const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

export function readJson(file, fallback) {
  try {
    return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
  } catch (e) {
    if (fallback !== undefined) return fallback
    throw new UserError(`Cannot read JSON ${file}: ${e.message}`)
  }
}

// Written to a temp file and renamed into place: a reader (or a crash) never sees half a file. That matters most for the
// review memory, where an unreadable file would read as "nothing reviewed yet" and everything would be posted again.
export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n')
  try { fs.renameSync(tmp, file) } catch (e) {
    // Windows refuses the rename while another process holds the target open; fall back to a plain write.
    try { fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n') } finally { fs.rmSync(tmp, { force: true }) }
    if (!fs.existsSync(file)) throw e
  }
}

// Run fn() while holding `<file>.lock` (created with O_EXCL, so only one process can own it). Used for read-merge-write
// cycles on shared files. A lock left behind by a killed process is taken over after `staleMs`. If the lock cannot be
// had in `waitMs` we go ahead without it: a review must not hang on a lock file, and the caller's own merge still covers
// every case except two writers inside the same few milliseconds.
export function withLock(file, fn, { waitMs = 3000, staleMs = 15000 } = {}) {
  const lock = `${file}.lock`, guard = `${lock}.takeover`
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const nap = new Int32Array(new SharedArrayBuffer(4))
  // EEXIST = somebody holds it. Windows answers EPERM/EACCES/EBUSY for a lock that was just removed while another waiter
  // still had it open ("delete pending"): that is a moment to wait out, not "locking is impossible here".
  const RETRY = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY'])
  const isStale = (p) => { try { return Date.now() - fs.statSync(p).mtimeMs > staleMs } catch { return false } }
  let held = false
  for (const start = Date.now(); ;) {
    try { fs.closeSync(fs.openSync(lock, 'wx')); held = true; break } catch (e) {
      if (!RETRY.has(e.code)) break // cannot create lock files here at all: the write below will say why
      if (Date.now() - start > waitMs) break // every path comes through here, so nothing below can spin for ever
      if (isStale(lock)) {
        // Taking over a dead process's lock is itself a check-then-act: two waiters that both saw it stale would delete
        // each other's fresh lock. So the takeover has an O_EXCL guard of its own, and re-checks once it holds the guard.
        let mine = false
        try { fs.closeSync(fs.openSync(guard, 'wx')); mine = true } catch { if (isStale(guard)) { try { fs.rmSync(guard, { force: true }) } catch { /* wait */ } } }
        if (mine) {
          try { if (isStale(lock)) fs.rmSync(lock, { force: true }) } catch { /* cannot remove it: wait like for a held lock */ } finally { fs.rmSync(guard, { force: true }) }
        }
      }
      Atomics.wait(nap, 0, 0, 25)
    }
  }
  try { return fn() } finally { if (held) fs.rmSync(lock, { force: true }) }
}

// The answer key of a calibration run is kept out of the run directory on purpose: every agent is told the run
// directory's path, and a file in it saying which claims were invented would be the one thing that must not be readable.
export const calibrationKey = (runDir) => path.join(HOME_DIR, 'calibration', path.basename(String(runDir).replace(/[\\/]+$/, '')) + '.json')
export const isCalibrationRun = (runDir) => fs.existsSync(calibrationKey(runDir))

export function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

// Paths handed to agents use forward slashes: valid on Windows, and immune to backslash-escape mangling in prompts/JSON.
export const fwd = (p) => p.split(path.sep).join('/')

export function slug(s, max = 60) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, max) || 'x'
}

// Minimal flag parser: --key value, --key=value, --flag (boolean), positionals in _.
export function parseArgs(argv, { booleans = [] } = {}) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) { out._.push(a); continue }
    const eq = a.indexOf('=')
    const key = (eq === -1 ? a.slice(2) : a.slice(2, eq)).replace(/-/g, '_')
    if (eq !== -1) { out[key] = a.slice(eq + 1); continue }
    const next = argv[i + 1]
    if (booleans.includes(key) || next === undefined || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

export function requireRun(args) {
  const dir = args.run || process.env.PR_REVIEW_RUN
  if (!dir) throw new UserError('Missing --run <runDir>')
  const abs = path.resolve(dir)
  if (!fs.existsSync(path.join(abs, 'context.json'))) throw new UserError(`Not a run directory (no context.json): ${abs}`)
  return abs
}

export function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

export function truncate(s, n) {
  s = String(s ?? '')
  return s.length <= n ? s : s.slice(0, n - 1) + '…'
}

// Old run directories to delete: beyond the newest `keep` AND untouched for `minAgeHours`. Count alone is not enough — a
// review left waiting at the approval question (or still being verified) while twenty others are collected is not "old".
export function pruneOldRuns(keep = 20, minAgeHours = 48, now = Date.now()) {
  const runs = path.join(HOME_DIR, 'runs')
  if (!fs.existsSync(runs)) return []
  const dirs = fs.readdirSync(runs, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
  return dirs.slice(0, Math.max(0, dirs.length - keep)).map((d) => path.join(runs, d)).filter((dir) => {
    try { return now - lastTouched(dir) >= minAgeHours * 3600e3 } catch { return false }
  })
}

// Newest mtime among a run directory and its top-level entries (agents write result files into sub-directories, which
// bumps those directories' mtimes, not the run directory's own).
function lastTouched(dir) {
  let t = fs.statSync(dir).mtimeMs
  for (const e of fs.readdirSync(dir)) { try { t = Math.max(t, fs.statSync(path.join(dir, e)).mtimeMs) } catch { /* vanished */ } }
  return t
}
