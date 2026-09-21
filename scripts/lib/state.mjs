// Review memory. Two layers so nothing is ever posted twice:
//   1. a local JSON file per PR (or per repo+branch in local mode) under ~/.claude/pr-review/state/
//   2. hidden HTML markers inside the comments we post, so state can be rebuilt on another machine or after the local
//      file is lost. The PR itself is the source of truth; the local file is a cache plus things GitHub can't hold
//      (dismissed and not-yet-posted findings).
import fs from 'node:fs'
import path from 'node:path'
import { HOME_DIR, readJson, withLock, writeJson, sha1, slug } from './util.mjs'
import { titleTokens, jaccard } from './core.mjs'

// Markers are trusted state, so they are only read where the scripts write them: a fingerprint at the END of a line, the
// review state at the END of the body. Text that merely quotes a marker mid-sentence (a finding about this very skill,
// a reply that cites one) is not a marker. Agent-written text is also sanitised before posting (report.mjs `clean`).
export const FP_MARK = /<!--\s*pr-review:fp=([0-9a-f]{8,40})\s*-->[ \t\r]*$/gm
export const STATE_MARK = /<!--\s*pr-review:state\s+(\{[^\n]*?\})\s*-->\s*$/

export const fpMarker = (fp) => `<!-- pr-review:fp=${fp} -->`
export const stateMarker = (obj) => `<!-- pr-review:state ${JSON.stringify(obj)} -->`

export function stateKey(ctx) {
  if (ctx.mode === 'pr') return `${ctx.repo.host}/${ctx.repo.owner}/${ctx.repo.name}#${ctx.pr.number}`
  // Benchmark fixtures are reviewed again and again on purpose; remembered findings from the last run would be
  // suppressed as duplicates and scored as misses. Each benchmark run gets a state of its own.
  if (ctx.fixture) return `local:${ctx.repo.root}:${ctx.local.branch || 'detached'}:bench-${path.posix.basename(ctx.run_dir)}`
  return `local:${ctx.repo.root}:${ctx.local.branch || 'detached'}`
}

export function statePath(key) {
  const safe = key.startsWith('local:') ? `local__${sha1(key).slice(0, 10)}__${slug(key.split(':').pop())}` : slug(key.replace('#', '-pr'), 120)
  return path.join(HOME_DIR, 'state', safe + '.json')
}

export function loadState(key) {
  const file = statePath(key)
  const s = readJson(file, null)
  if (s && s.v === 1) return s
  // A file that exists but cannot be used is NOT "nothing reviewed yet": the next save would overwrite what may be the
  // only record of dismissed and pending findings. Keep it aside and say so.
  const fresh = { v: 1, key, reviews: [], findings: {} }
  if (fs.existsSync(file)) {
    const aside = `${file}.unreadable-${Date.now()}`
    try { fs.renameSync(file, aside); fresh.recovered_from = aside } catch { /* leave it; saving will merge nothing */ }
  }
  return fresh
}

const STATUS_RANK = { pending: 1, addressed: 2, dismissed: 3, posted: 4 }

// Two review sessions on the same PR (two terminals, or a re-run started while the first still waits at the approval
// question) both load, change and save this file. `rev` detects that the file moved on since we loaded it; then what
// the other session recorded is folded in instead of overwritten — the stronger fact about a finding wins (a finding
// one session POSTED must never fall back to "pending", or it would be posted twice).
// The read-merge-write runs under a lock file: without it two saves that both READ before either WRITES would each see
// an unchanged `rev`, skip the merge, and the second write would silently discard the first.
export function saveState(state) {
  return withLock(statePath(state.key), () => saveStateLocked(state))
}

function saveStateLocked(state) {
  const disk = readJson(statePath(state.key), null)
  if (disk && disk.v === 1 && (disk.rev || 0) !== (state.rev || 0)) {
    const seen = new Set(state.reviews.map((r) => `${r.at}|${r.head}`))
    state.reviews = [...disk.reviews.filter((r) => !seen.has(`${r.at}|${r.head}`)), ...state.reviews].sort((a, b) => String(a.at).localeCompare(String(b.at)))
    for (const [fp, theirs] of Object.entries(disk.findings || {})) {
      const mine = state.findings[fp]
      if (!mine || (STATUS_RANK[theirs.status] || 0) > (STATUS_RANK[mine.status] || 0)) state.findings[fp] = theirs
    }
  }
  state.rev = Math.max(state.rev || 0, (disk && disk.rev) || 0) + 1
  writeJson(statePath(state.key), state)
}

export function fingerprint(f) {
  const anchor = String(f.anchor || '').replace(/\s+/g, ' ').trim()
  const basis = anchor.length >= 4 ? anchor : Array.from(titleTokens(f.title)).sort().join(' ')
  return sha1(`${f.path}\n${basis}`).slice(0, 12)
}

// A stored finding "covers" a new one when the fingerprint matches and they are plausibly the same concern.
export function priorMatch(state, f) {
  const prev = state.findings[f.fp]
  if (!prev) return null
  // Entries rebuilt from PR markers carry little text to compare, and the fingerprint (path + anchored code) is specific.
  const similar = prev.recovered || !prev.title || prev.category === f.category || jaccard(titleTokens(prev.title), titleTokens(f.title)) >= 0.2
  return similar ? prev : null
}

export function lastReview(state) {
  return state.reviews.length ? state.reviews[state.reviews.length - 1] : null
}

// Fold markers found in live PR comments into state (covers: new machine, lost state file, review posted by a teammate
// running the same skill under the same account).
export function mergeRemoteMarkers(state, comments, viewer) {
  let recovered = 0
  for (const c of comments) {
    if (!c.body) continue
    // Only comments authored by the reviewing account count; anything else could be a forged marker.
    if (!viewer || !c.user || String(c.user).toLowerCase() !== String(viewer).toLowerCase()) continue
    for (const m of c.body.matchAll(FP_MARK)) {
      const fp = m[1]
      if (!state.findings[fp]) {
        state.findings[fp] = { fp, path: c.path || '', line: c.line || null, title: c.kind === 'inline' ? markerTitle(c.body) : '', severity: /:red_circle:|🔴/.test(markerLine(c.body, fp)) ? 'red' : 'yellow',
          category: '', status: 'posted', comment_id: c.id, recovered: true }
        recovered++
      } else if (!state.findings[fp].comment_id && c.kind === 'inline') state.findings[fp].comment_id = c.id
    }
    const sm = c.body.match(STATE_MARK)
    if (sm) {
      try {
        const remote = JSON.parse(sm[1])
        if (remote.head && !state.reviews.some((r) => r.head === remote.head && r.posted)) {
          state.reviews.push({ at: c.created_at || null, head: remote.head, base: remote.base || null, event: remote.event || null,
            posted: true, posted_fps: remote.fps || [], recovered: true })
          recovered++
        }
      } catch { /* malformed marker: ignore */ }
    }
  }
  state.reviews.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')))
  return recovered
}

// The severity icon nearest above a given fp marker (a summary body holds several findings).
function markerLine(body, fp) {
  const before = String(body).split(`pr-review:fp=${fp}`)[0]
  const icons = before.match(/:red_circle:|:yellow_circle:|🔴|🟡/g)
  return icons ? icons[icons.length - 1] : ''
}
const markerTitle = (body) => { const l = firstLine(body); const i = l.indexOf(' — '); return i === -1 ? l : l.slice(i + 3) }

const firstLine = (body) => String(body).replace(/<!--.*?-->/gs, '').split('\n').map((l) => l.replace(/[*_`#>]/g, '').trim()).find(Boolean) || ''
