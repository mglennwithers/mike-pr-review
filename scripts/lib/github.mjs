// GitHub transport. Preference order: gh CLI -> token in env -> (opt-in) git credential helper -> anonymous (public
// repos, read-only). When none can do the job the caller falls back to the MCP path described in
// references/github-transport.md.
import { run, hasCommand, UserError } from './util.mjs'

// Self-test hook: PR_REVIEW_API_BASE points the token transport at a fake GitHub (scripts/cmd/fake-github.mjs). Only plain
// loopback URLs are honoured, so the environment can never steer a real token to another machine.
function loopbackBase() {
  try {
    const u = new URL(process.env.PR_REVIEW_API_BASE || '')
    return u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname) ? u.origin : null
  } catch { return null }
}
export const apiBase = (host) => loopbackBase() || (!host || host === 'github.com' ? 'https://api.github.com' : `https://${host}/api/v3`)
const graphqlUrl = (host) => (loopbackBase() ? `${loopbackBase()}/graphql` : !host || host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`)

function tokenFromGitCredential(host) {
  const r = run('git', ['credential', 'fill'], {
    input: `protocol=https\nhost=${host || 'github.com'}\n\n`, allowFail: true, env: { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
  })
  if (!r.ok) return null
  const m = r.stdout.match(/^password=(.+)$/m)
  return m ? m[1].trim() : null
}

export function detectTransport(host = 'github.com', { useGitCredential = false } = {}) {
  if (process.env.PR_REVIEW_TRANSPORT !== 'token' && hasCommand('gh')) {
    // `gh auth token` only reads gh's own store (no network call, unlike `gh auth status`); an expired login surfaces on
    // the first real API call, with gh's own message. Older gh builds without the sub-command fall back to `status`.
    let st = run('gh', ['auth', 'token', '--hostname', host], { allowFail: true })
    if (!st.ok && /unknown command|unknown flag/i.test(st.stderr)) st = run('gh', ['auth', 'status', '--hostname', host], { allowFail: true })
    if (st.ok) return { kind: 'gh', host, canWrite: true }
  }
  // A PR URL (or a repo's origin) chooses the host, and that is attacker-influenced text. An environment token is only
  // ever sent to github.com — or to the one enterprise host the user named in GH_HOST (GH_ENTERPRISE_TOKEN, as gh does).
  const isDotCom = host === 'github.com'
  const token = isDotCom ? (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN)
    : (String(process.env.GH_HOST || '').toLowerCase() === host ? (process.env.GH_ENTERPRISE_TOKEN || process.env.GITHUB_ENTERPRISE_TOKEN) : null)
  if (token) return { kind: 'token', host, token, canWrite: true }
  if (useGitCredential || process.env.PR_REVIEW_USE_GIT_CREDENTIAL === '1') {
    const t = tokenFromGitCredential(host)
    if (t) return { kind: 'token', host, token: t, canWrite: true, source: 'git-credential' }
  }
  return { kind: 'anonymous', host, canWrite: false }
}

export class ApiError extends Error {
  constructor(status, message, body) { super(message); this.status = status; this.body = body }
}

async function fetchApi(t, method, url, { body, accept } = {}) {
  const headers = { Accept: accept || 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'claude-pr-review-skill' }
  if (t.token) headers.Authorization = `Bearer ${t.token}`
  if (body !== undefined) headers['Content-Type'] = 'application/json'
  let res
  try { res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) }) } catch (e) {
    // Node's fetch ignores HTTPS_PROXY (Node 24+ honours it with NODE_USE_ENV_PROXY=1); gh and git do honour it.
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy
    throw new Error(`${method} ${url} failed: ${e && e.message}${proxy ? ' — a proxy is configured in the environment, which this transport does not use; install and log in to the GitHub CLI (gh), which does' : ''}`)
  }
  const text = await res.text()
  let data = text
  try { data = text ? JSON.parse(text) : null } catch { /* non-JSON (diff media types) */ }
  if (!res.ok) {
    const msg = (data && data.message) || text.slice(0, 300)
    const detail = data && data.errors ? ' ' + JSON.stringify(data.errors).slice(0, 600) : ''
    throw new ApiError(res.status, `GitHub ${method} ${url} -> ${res.status}: ${msg}${detail}`, data)
  }
  return data
}

function ghApi(t, method, apiPath, { body, accept } = {}) {
  const args = ['api', '--hostname', t.host, '-X', method, apiPath, '-H', `Accept: ${accept || 'application/vnd.github+json'}`]
  if (body !== undefined) args.push('--input', '-')
  const r = run('gh', args, { input: body === undefined ? undefined : JSON.stringify(body), allowFail: true })
  let data = r.stdout
  try { data = r.stdout ? JSON.parse(r.stdout) : null } catch { /* keep text */ }
  if (!r.ok) {
    const status = Number((r.stderr.match(/HTTP (\d{3})/) || [])[1]) || 0
    const msg = (data && data.message) || r.stderr.trim().slice(0, 300)
    const detail = data && data.errors ? ' ' + JSON.stringify(data.errors).slice(0, 600) : ''
    throw new ApiError(status, `gh api ${method} ${apiPath} -> ${status || 'error'}: ${msg}${detail}`, data)
  }
  return data
}

// apiPath is relative, e.g. "repos/o/r/pulls/1"
export async function api(t, method, apiPath, opts = {}) {
  if (method !== 'GET' && !t.canWrite) throw new UserError('No authenticated GitHub transport available for writes.', { code: 4 })
  return t.kind === 'gh' ? ghApi(t, method, apiPath, opts) : fetchApi(t, method, `${apiBase(t.host)}/${apiPath}`, opts)
}

export async function apiAll(t, apiPath, { max = 2000 } = {}) {
  const out = []
  for (let page = 1; out.length < max; page++) {
    const sep = apiPath.includes('?') ? '&' : '?'
    const batch = await api(t, 'GET', `${apiPath}${sep}per_page=100&page=${page}`)
    if (!Array.isArray(batch) || !batch.length) break
    out.push(...batch)
    if (batch.length < 100) break
  }
  return out
}

// Returns the `data` object, or null for an anonymous transport (GraphQL always needs auth). THROWS when an authenticated
// query fails — the caller decides what that means; "failed" must never look like "empty".
export async function graphql(t, query, variables) {
  if (t.kind === 'anonymous') return null
  let res
  if (t.kind === 'gh') {
    const r = run('gh', ['api', 'graphql', '--hostname', t.host, '--input', '-'], { input: JSON.stringify({ query, variables }), allowFail: true })
    if (!r.ok) throw new Error(`GraphQL query failed: ${String(r.stderr || r.stdout || 'gh exited with an error').trim().slice(0, 200)}`)
    try { res = JSON.parse(r.stdout) } catch { throw new Error('GraphQL query returned something that is not JSON') }
  } else res = await fetchApi(t, 'POST', graphqlUrl(t.host), { body: { query, variables } })
  if (!res || !res.data) throw new Error(`GraphQL query returned no data${res && res.errors && res.errors[0] ? `: ${String(res.errors[0].message).slice(0, 200)}` : ''}`)
  return res.data
}

export async function viewerLogin(t) {
  if (t.kind === 'anonymous') return null
  try { return (await api(t, 'GET', 'user')).login } catch { return null }
}

// { states: map of review-comment databaseId -> { resolved, outdated }, error: null | why the map is incomplete }.
// Follow-ups, dedupe and "reintroduced" detection all depend on it, so a failure is handed to the caller to announce.
export async function reviewThreadStates(t, owner, repo, number) {
  const q = `query($o:String!,$r:String!,$n:Int!,$c:String){repository(owner:$o,name:$r){pullRequest(number:$n){
    reviewThreads(first:100,after:$c){pageInfo{hasNextPage endCursor} nodes{isResolved isOutdated comments(first:50){nodes{fullDatabaseId}}}}}}}`
  const states = {}
  let cursor = null
  for (let i = 0; i < 10; i++) {
    let d
    try { d = await graphql(t, q, { o: owner, r: repo, n: number, c: cursor }) } catch (e) { return { states, error: String(e && e.message) } }
    if (d === null) return { states, error: null } // anonymous: thread states are simply not available
    const threads = d.repository && d.repository.pullRequest && d.repository.pullRequest.reviewThreads
    if (!threads) return { states, error: 'the response did not contain the pull request\'s review threads' }
    for (const th of threads.nodes) for (const c of th.comments.nodes) states[String(c.fullDatabaseId)] = { resolved: th.isResolved, outdated: th.isOutdated }
    if (!threads.pageInfo.hasNextPage) break
    cursor = threads.pageInfo.endCursor
  }
  return { states, error: null }
}

export function parsePrTarget(target) {
  const s = String(target || '').trim()
  let m = s.match(/^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (m) return { host: m[1].toLowerCase(), owner: m[2], repo: m[3], number: +m[4] }
  m = s.match(/^([\w.-]+)\/([\w.-]+)#(\d+)$/)
  if (m) return { owner: m[1], repo: m[2], number: +m[3] }
  m = s.match(/^(?:#|pr[\s:#-]*)?(\d+)$/i)
  if (m) return { number: +m[1] }
  return null
}
