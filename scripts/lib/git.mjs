// Git plumbing + unified-diff parsing. All diffs are computed locally with git so PR mode and local mode share one
// code path and we never hit the GitHub API's diff-size limits.
import fs from 'node:fs'
import path from 'node:path'
import { HOME_DIR, run, UserError } from './util.mjs'

// Every git command this skill runs is shielded from the parts of the user's git configuration that would change what it
// prints or run somebody's code: diff prefixes and blank-line style (they shift or corrupt parsed line numbers), hooks
// (a post-checkout hook would run inside the review checkout even when code execution is off), commit signing (the
// snapshot commits are throwaway), Windows path limits — and nothing may stop to ask a question on a terminal.
const SHIELD = ['-c', 'core.quotepath=off', '-c', `core.hooksPath=${path.join(HOME_DIR, 'no-hooks')}`, '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false',
  '-c', 'diff.suppressBlankEmpty=false', '-c', 'commit.gpgsign=false', '-c', 'core.longpaths=true']
const QUIET = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
// The snapshot commits never leave the machine, so they must not depend on the user having a git identity configured.
const IDENT = { GIT_AUTHOR_NAME: 'pr-review', GIT_AUTHOR_EMAIL: 'pr-review@localhost', GIT_COMMITTER_NAME: 'pr-review', GIT_COMMITTER_EMAIL: 'pr-review@localhost' }
let EXTRA = []
// Extra `-c` settings for the rest of this process (collect uses it to lend gh's credentials to a cached clone, whose
// blobs are fetched lazily by later diff and checkout commands — not only by `fetch`).
export const withGitConfig = (args) => { EXTRA = Array.isArray(args) ? args : [] }

export const git = (cwd, args, opts = {}) => run('git', [...SHIELD, ...EXTRA, ...args], { cwd, ...opts, env: { ...QUIET, ...(opts.env || {}) } })
export const gitOut = (cwd, args, opts) => git(cwd, args, opts).stdout.trim()

export function repoRoot(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel'], { allowFail: true })
  if (r.ok) return path.resolve(r.stdout.trim())
  // Two failures that are NOT "this is no repository", and whose real cause the user needs to hear:
  if (r.code === -1 && fs.existsSync(cwd)) throw new UserError(`git could not be started (${r.stderr.trim().slice(0, 200)}). pr-review needs git 2.28 or newer on PATH.`)
  if (/dubious ownership|safe\.directory/i.test(r.stderr)) throw new UserError(`git refuses to work in ${cwd} because the directory belongs to another user ("dubious ownership"). If it is yours: git config --global --add safe.directory "${path.resolve(cwd).split(path.sep).join('/')}"`)
  return null
}

// Accepts https://host/owner/repo(.git), git@host:owner/repo(.git), ssh://git@host/owner/repo
export function parseRemoteUrl(url) {
  const m = String(url || '').trim().match(/^(?:https?:\/\/(?:[^@/]+@)?|ssh:\/\/(?:[^@/]+@)?|[^@/]+@)([^/:]+)[/:](.+?)\/([^/]+?)(?:\.git)?\/?$/)
  return m ? { host: m[1].toLowerCase(), owner: m[2], repo: m[3] } : null
}

// Reads the configured URL as written (not rewritten by url.<base>.insteadOf), since we want the repo's identity.
export function remoteInfo(cwd, name) {
  const r = git(cwd, ['config', '--get', `remote.${name}.url`], { allowFail: true })
  return r.ok ? parseRemoteUrl(r.stdout) : null
}
export const originInfo = (cwd) => remoteInfo(cwd, 'origin')

export function defaultBaseRef(cwd) {
  const head = git(cwd, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { allowFail: true })
  if (head.ok && head.stdout.trim()) return head.stdout.trim()
  for (const ref of ['origin/main', 'origin/master', 'origin/develop', 'main', 'master']) {
    if (git(cwd, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { allowFail: true }).ok) return ref
  }
  return null
}

export const revParse = (cwd, ref) => {
  const r = git(cwd, ['rev-parse', '--verify', '--quiet', ref + '^{commit}'], { allowFail: true })
  return r.ok ? r.stdout.trim() : null
}
export const isAncestor = (cwd, a, b) => git(cwd, ['merge-base', '--is-ancestor', a, b], { allowFail: true }).ok
export const mergeBase = (cwd, a, b) => {
  const r = git(cwd, ['merge-base', a, b], { allowFail: true })
  return r.ok ? r.stdout.trim() : null
}
export const commitExists = (cwd, sha) => !!sha && git(cwd, ['cat-file', '-e', sha + '^{commit}'], { allowFail: true }).ok

export function commitsBetween(cwd, from, to) {
  const out = gitOut(cwd, ['log', '--no-merges', '--format=%H%x1f%an%x1f%s', `${from}..${to}`], { allowFail: true })
  return out ? out.split('\n').map((l) => { const [sha, author, subject] = l.split('\x1f'); return { sha, author, subject } }) : []
}

export const diffText = (cwd, from, to, paths = []) =>
  git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '-U5', from, to, '--', ...paths]).stdout

// Snapshot the working tree (tracked + untracked, respecting .gitignore) as a dangling commit WITHOUT touching the
// user's index, stash, or files. Uses a throwaway copy of the index so stat caches stay warm.
export function snapshotWorkingTree(root, tmpDir, { stagedOnly = false } = {}) {
  const head = revParse(root, 'HEAD')
  if (!head) throw new UserError('Repository has no commits yet; nothing to diff against.')
  if (stagedOnly) {
    const tree = gitOut(root, ['write-tree'])
    return { commit: gitOut(root, ['commit-tree', tree, '-p', head, '-m', 'pr-review staged snapshot'], { env: IDENT }), tree }
  }
  const gitDir = path.resolve(root, gitOut(root, ['rev-parse', '--git-dir']))
  const tmpIndex = path.join(tmpDir, 'snapshot.index')
  const realIndex = path.join(gitDir, 'index')
  // The copy can be as large as the repository's index and the run directory is kept "for reference": remove it on
  // every way out, also when git refuses a path half-way through.
  try {
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex)
    const env = { GIT_INDEX_FILE: tmpIndex }
    if (!fs.existsSync(tmpIndex)) git(root, ['read-tree', 'HEAD'], { env })
    git(root, ['add', '-A', '--', '.'], { env })
    const tree = gitOut(root, ['write-tree'], { env })
    const commit = gitOut(root, ['commit-tree', tree, '-p', head, '-m', 'pr-review working-tree snapshot'], { env: IDENT })
    return { commit, tree }
  } finally {
    fs.rmSync(tmpIndex, { force: true })
    fs.rmSync(tmpIndex + '.lock', { force: true })
  }
}

// No `git worktree prune` anywhere: in the user's own repository it would also drop THEIR worktrees whose directories
// happen to be unreachable right now (unmounted drive, network share). We only ever touch the worktree we created.
// Returns { lfs_skipped } — a Git LFS object that cannot be downloaded (no credentials for it, LFS server elsewhere) must
// not make the whole review impossible: the checkout is retried with LFS files left as pointer files.
export function addWorktree(repo, dir, sha) {
  const args = ['worktree', 'add', '--detach', '--force', '--force', dir, sha]
  const r = git(repo, args, { allowFail: true })
  if (r.ok) return { lfs_skipped: false }
  if (!/smudge filter lfs failed|git-lfs/i.test(r.stderr)) throw new UserError(`git worktree add failed: ${r.stderr.trim().slice(0, 1500)}`)
  fs.rmSync(dir, { recursive: true, force: true })
  git(repo, args, { env: { GIT_LFS_SKIP_SMUDGE: '1' } })
  return { lfs_skipped: true }
}

export function removeWorktree(repo, dir) {
  const r = git(repo, ['worktree', 'remove', '--force', dir], { allowFail: true })
  if (r.ok || !fs.existsSync(dir)) return
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch (e) { // stale registration expires via git gc
    // Windows will not delete a directory some process is sitting in — typically a shell that cd'ed into the checkout.
    throw new UserError(`Could not remove the review checkout ${dir} (${e && e.code || e.message}). A terminal or editor is probably still open inside it; leave that directory and run cleanup again.`)
  }
}

export const diffTextU3 = (cwd, from, to) =>
  git(cwd, ['diff', '--no-color', '--no-ext-diff', '--no-textconv', '--find-renames', '-U3', from, to]).stdout

// ---- unified diff parsing -------------------------------------------------------------------------------------------

const unquote = (p) => (p.startsWith('"') ? JSON.parse(p) : p)

// Returns [{ path, old_path, status, binary, added, deleted, hunks:[{old_start,old_lines,new_start,new_lines,lines}],
//            added_lines:[n], right_lines:[n] (added + context = commentable on RIGHT), patch }]
export function parseDiff(text) {
  const files = []
  let cur = null, hunk = null, oldNo = 0, newNo = 0
  const lines = text.split('\n')
  const finish = () => { if (cur) { cur.patch = cur._buf.join('\n') + '\n'; delete cur._buf; files.push(cur) } }
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      finish()
      const m = line.match(/^diff --git (?:"a\/(.+?)"|a\/(.+?)) (?:"b\/(.+?)"|b\/(.+))$/)
      const p = m ? (m[3] || m[4]) : ''
      cur = { path: p, old_path: m ? (m[1] || m[2]) : p, status: 'modified', binary: false, added: 0, deleted: 0,
        hunks: [], added_lines: [], right_lines: [], _buf: [line] }
      hunk = null
      continue
    }
    if (!cur) continue
    cur._buf.push(line)
    if (!hunk || !/^[ +\-\\]/.test(line)) {
      if (line.startsWith('new file mode')) cur.status = 'added'
      else if (line.startsWith('deleted file mode')) cur.status = 'deleted'
      else if (line.startsWith('rename from ')) { cur.status = 'renamed'; cur.old_path = unquote(line.slice(12)) }
      else if (line.startsWith('rename to ')) cur.path = unquote(line.slice(10))
      else if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) cur.binary = true
      // git appends a TAB after paths that contain spaces on ---/+++ lines
      else if (line.startsWith('+++ ') && !line.startsWith('+++ /dev/null')) cur.path = unquote(line.slice(4).replace(/\t+$/, '')).replace(/^b\//, '')
      const h = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (h) {
        hunk = { old_start: +h[1], old_lines: h[2] === undefined ? 1 : +h[2], new_start: +h[3],
          new_lines: h[4] === undefined ? 1 : +h[4], lines: [] }
        cur.hunks.push(hunk); oldNo = hunk.old_start; newNo = hunk.new_start
      }
      continue
    }
    const c = line[0]
    if (c === '+') { cur.added++; cur.added_lines.push(newNo); cur.right_lines.push(newNo); hunk.lines.push({ t: '+', n: newNo, s: line.slice(1) }); newNo++ }
    else if (c === '-') { cur.deleted++; hunk.lines.push({ t: '-', o: oldNo, s: line.slice(1) }); oldNo++ }
    else if (c === ' ') { cur.right_lines.push(newNo); hunk.lines.push({ t: ' ', n: newNo, s: line.slice(1) }); oldNo++; newNo++ }
  }
  finish()
  return files
}

// Rebuild a file's patch from a subset of its hunks.
export function patchFromHunks(file, hunks) {
  const header = file.patch.split('\n')
  const firstHunk = header.findIndex((l) => l.startsWith('@@ '))
  const head = firstHunk === -1 ? header : header.slice(0, firstHunk)
  const body = hunks.map((h) => [`@@ -${h.old_start},${h.old_lines} +${h.new_start},${h.new_lines} @@`,
    ...h.lines.map((l) => l.t + l.s)].join('\n'))
  return head.join('\n') + '\n' + body.join('\n') + '\n'
}
