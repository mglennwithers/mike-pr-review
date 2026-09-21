// Turns results.json into (a) the traffic-light report shown in the terminal and (b) the GitHub review payload.
// Everything here is deterministic so the orchestrator spends no tokens on formatting or on deciding what is postable.
import fs from 'node:fs'
import path from 'node:path'
import { readJson, truncate } from './util.mjs'
import { lensLights, overallLight } from './core.mjs'
import { fingerprint, fpMarker, loadState, priorMatch, stateKey, stateMarker } from './state.mjs'
import { LENS_TITLES } from './tasks.mjs'

const EMOJI = { red: '🔴', yellow: '🟡', green: '🟢', gray: '⚪' }
const GH = { red: ':red_circle:', yellow: ':yellow_circle:', green: ':green_circle:', gray: ':white_circle:' }
const SEV_LABEL = { red: 'Blocking', yellow: 'Should fix' }
const norm = (s) => String(s).replace(/\s+/g, ' ').trim()

function correctLine(f, workDir) {
  if (!f.anchor || !workDir) return
  const file = path.join(workDir, f.path)
  if (!fs.existsSync(file)) return
  let lines
  try { lines = fs.readFileSync(file, 'utf8').split(/\r?\n/) } catch { return }
  const want = norm(f.anchor)
  if (want.length < 3) return
  const matches = (n) => n >= 1 && n <= lines.length && norm(lines[n - 1]).includes(want)
  if (matches(f.line)) return
  for (let d = 1; d <= 20; d++) for (const n of [f.line - d, f.line + d]) {
    if (matches(n)) { const shift = n - f.line; f.line += shift; f.end_line += shift; f.line_corrected = true; return }
  }
}

function placeInline(f, commentable) {
  const ranges = commentable[f.path]
  if (!ranges) return { inline: false, why: 'file is not part of the PR diff' }
  const rangeOf = (n) => ranges.find(([a, b]) => n >= a && n <= b)
  let end = f.end_line, start = f.line, moved = false
  if (!rangeOf(end)) {
    const near = [0, 1, -1, 2, -2, 3, -3].map((d) => start + d).find((n) => rangeOf(n))
    if (near === undefined) return { inline: false, why: `line ${f.line} is outside the PR's diff hunks` }
    start = end = near; moved = true
  }
  const multi = start < end && rangeOf(start) === rangeOf(end)
  // `exact` = the comment covers precisely line..end_line. Only then may a one-click suggestion be attached: GitHub
  // applies a suggestion to the commented range, so on a moved or collapsed anchor it would replace the wrong code.
  return { inline: true, line: end, start_line: multi ? start : null, exact: !moved && (f.line === f.end_line || multi) }
}

export function prepare(runDir) {
  const ctx = readJson(path.join(runDir, 'context.json'))
  const plan = readJson(path.join(runDir, 'plan.json'))
  const results = readJson(path.join(runDir, 'results.json'))
  const commentable = readJson(path.join(runDir, 'commentable.json'), {})
  const state = loadState(stateKey(ctx))
  const followup = new Map((results.followup || []).map((i) => [i.fp, i]))

  // "Reintroduced" normally comes from the dedupe chore, but that is a model call that can fail or not be planned.
  // GitHub already tells us the one fact that matters: our comment's thread was resolved. A finding verified again
  // under a resolved thread is back (or was never fixed), so it must not be filed under "already posted".
  // (Every thread of ours carrying the fingerprint must be resolved — once it is re-posted there is an open one again.)
  const threads = new Map()
  for (const c of readJson(path.join(runDir, 'existing-comments.json'), [])) if (c.is_ours) for (const fp of c.fps || []) threads.set(fp, (threads.get(fp) ?? true) && !!c.resolved)
  const resolvedFps = new Set(Array.from(threads).filter(([, allResolved]) => allResolved).map(([fp]) => fp))

  const buckets = { post: [], minor: [], watch: [], pre_existing: [], refuted: [], suppressed: [], unverified: [] }
  const shadowedPending = new Set() // earlier VERIFIED findings that came back this time as an unverified nit
  // Confidence is "is it true"; importance is "does it matter". A should-fix finding below the importance floor is a nit:
  // the user sees it, the author is not bothered with it (unless the user posts it by id). Blockers are never filtered.
  const minImportance = plan.thresholds.min_importance ?? 0
  for (const f of results.findings) {
    correctLine(f, ctx.work_dir)
    f.fp = fingerprint(f)
    const prev = priorMatch(state, f)
    // (A finding judged pre-existing has its confidence capped, so its band is never 'high': confirmed is what counts there.)
    if (prev && prev.status === 'posted' && resolvedFps.has(f.fp) && f.status === 'confirmed' && (f.band === 'high' || f.pre_existing)) f.reintroduced = true
    // Same finding, verified in an earlier review, but this time its lens called it a nit so nobody verified it. The earlier
    // verdict stands: a pending one is carried forward below; a posted-and-resolved one that is back is flagged, not hidden.
    if (f.skipped_verification && prev && prev.status === 'pending' && prev.data) { shadowedPending.add(f.fp); continue }
    if (f.skipped_verification && prev && prev.status === 'posted' && resolvedFps.has(f.fp)) { buckets.minor.push({ ...f, back_after_resolve: true }); continue }
    if (prev && prev.status === 'posted' && !f.reintroduced) { buckets.suppressed.push({ ...f, why: 'already posted in an earlier review' }); continue }
    if (prev && prev.status === 'dismissed') { buckets.suppressed.push({ ...f, why: 'you dismissed this finding earlier' }); continue }
    // Rated a nit by its own lens, so never sent to a verifier: shown under "minor", never postable, not a hole in the review.
    if (f.skipped_verification) { buckets.minor.push(f); continue }
    // A finding whose verifiers all died is NOT refuted — it is unknown, and must never read as a clean bill of health.
    if (f.status === 'unverified' || !(f.votes || []).length) { buckets.unverified.push(f); continue }
    // "Pre-existing" on a finding WE posted earlier and whose thread was resolved means: still in the code, older than the
    // commits reviewed this time. It keeps its flag (and an inline anchor) so the user sees that and can re-post it by id.
    if (f.pre_existing && f.status === 'confirmed') { buckets.pre_existing.push(f.reintroduced && ctx.mode === 'pr' ? { ...f, ...placeInline(f, commentable) } : f); continue }
    if (f.severity === 'drop' || f.band === 'low') { buckets.refuted.push(f); continue }
    if (f.band === 'medium') { buckets.watch.push(f); continue }
    const placed = ctx.mode === 'pr' ? { ...f, ...placeInline(f, commentable) } : f
    if (f.severity === 'yellow' && !f.reintroduced && (f.importance ?? 100) < minImportance) { buckets.minor.push(placed); continue }
    buckets.post.push(placed)
  }
  // Local mode: a candidate the dedupe chore matched to a PENDING earlier finding was raised again by the lenses, i.e. it
  // is still in the code and was only ever shown, never posted or fixed. Hiding it as "already raised" would turn an
  // unfixed blocker green on the second review, so it comes back below as a carried finding instead.
  const pendingFps = new Set(Object.values(state.findings).filter((p) => p.status === 'pending' && p.data).map((p) => p.fp))
  const reRaised = new Set()
  for (const c of results.covered || []) {
    if (ctx.mode !== 'pr' && pendingFps.has(String(c.by || ''))) { reRaised.add(String(c.by)); continue }
    buckets.suppressed.push({ ...c, why: `already raised (${c.why || c.by || 'existing comment'})` })
  }

  // PR mode: findings approved by verification in an earlier run but never posted ride along until posted, dismissed or
  // fixed (an incremental review would not look at that code again). Local reviews always cover the whole change, so a
  // finding the lenses no longer raise has simply been fixed — carrying it would nag about solved problems forever.
  const seen = new Set(results.findings.filter((f) => !f.skipped_verification).map((f) => f.fp))
  for (const p of Object.values(state.findings)) {
    if (ctx.mode !== 'pr' && !reRaised.has(p.fp) && !shadowedPending.has(p.fp)) continue
    if (p.status !== 'pending' || !p.data || seen.has(p.fp)) continue
    const fu = followup.get(p.fp)
    if (fu && fu.status === 'addressed') continue
    const f = { ...p.data, carried: true, id: `C${String(buckets.post.filter((x) => x.carried).length + 1).padStart(2, '0')}` }
    correctLine(f, ctx.work_dir)
    buckets.post.push(ctx.mode === 'pr' ? { ...f, ...placeInline(f, commentable) } : f)
  }
  // Blockers first, then by how much the finding matters, then by how sure we are.
  const sevOrder = (a, b) => (a.severity === b.severity ? (b.importance ?? 0) - (a.importance ?? 0) || b.confidence - a.confidence : a.severity === 'red' ? -1 : 1)
  buckets.post.sort(sevOrder); buckets.watch.sort(sevOrder); buckets.minor.sort(sevOrder)
  const foldedIds = new Set(ctx.mode === 'pr' ? applyInlineCap(buckets.post, plan.thresholds.max_inline_yellow).filter((f) => f.folded).map((f) => f.id) : [])

  const byLens = new Map()
  for (const r of results.lens_runs) {
    const cur = byLens.get(r.lens) || { lens: r.lens, model: r.model, ok: true, raised: 0, notes: [], coverage: 'full', any: false }
    cur.ok = cur.ok && r.ok; cur.any = cur.any || r.ok; cur.raised += r.raised || 0
    if (r.notes) cur.notes.push(r.notes)
    if (r.coverage && r.coverage !== 'full') cur.coverage = 'partial'
    byLens.set(r.lens, cur)
  }
  const lensRuns = Array.from(byLens.values()).map((r) => ({ ...r, ok: r.any, coverage: r.ok ? r.coverage : r.any ? 'partial' : 'none', notes: r.notes.join(' ') }))
  const lights = lensLights(lensRuns, buckets.post)
  // Completeness: a review with holes in it may still report what it found, but must never vouch for the change.
  const holes = []
  const lensChanges = { dropped: (results.lens_changes && results.lens_changes.dropped) || [], added: (results.lens_changes && results.lens_changes.added) || [] }
  const vetoed = new Set(lensChanges.dropped.map((d) => d.lens))
  const planned = new Set([...(plan.lens_tasks || []).map((t) => t.lens).filter((l) => !vetoed.has(l)), ...lensChanges.added.map((a) => a.lens)])
  const ranOk = new Set(lensRuns.filter((r) => r.ok).map((r) => r.lens))
  if (!ranOk.size) holes.push('no review lens produced a result')
  else for (const l of planned) if (!ranOk.has(l)) holes.push(`the ${l} lens did not run`)
  for (const r of lensRuns) if (r.ok && r.coverage === 'partial' && planned.has(r.lens)) holes.push(`the ${r.lens} lens only partly ran`)
  if (buckets.unverified.length) holes.push(`${buckets.unverified.length} finding(s) could not be verified (${buckets.unverified.filter((f) => f.severity === 'red').length} raised as blocking)`)
  let light = overallLight(buckets.post)
  if (light === 'green' && holes.length) light = 'gray'
  // Chores that failed do not make the review incomplete, but the user should know what was not checked.
  const notices = []
  if ((results.chores_failed || []).includes('dedupe')) notices.push('The duplicate check against existing PR comments did not run (its agent failed twice). Findings were matched to earlier reviews by fingerprint only, so one that repeats a point somebody else already made may be listed — skim the existing comments before posting.')
  if ((results.chores_failed || []).includes('merge')) notices.push('The pass that merges findings with the same root cause did not run (its agent failed twice); two findings below may describe one defect.')
  if ((results.chores_failed || []).includes('brief')) notices.push('The brief agent did not run (it failed twice): lenses worked without a summary of what the change is for, and nobody checked whether the keyword-woken lenses fit the change.')
  if ((results.chores_failed || []).includes('critic')) notices.push('The completeness critic did not run (its agent failed twice, or the stage was skipped). This profile pays for that second look at what the lenses may have missed; without it the review is no more thorough than a standard one.')
  if ((results.chores_failed || []).includes('critic-later')) notices.push('The completeness critic ran, but a later round of it did not (its agent failed twice): the gaps it found first were followed up and are in this report; the further look was not taken.')
  if ((results.chores_failed || []).includes('followup')) notices.push('The follow-up on earlier findings did not run (its agent failed); "Since the last review" shows them as not re-checked.')

  const priorOpen = (ctx.prior.open_findings || []).map((p) => ({ ...p, follow: followup.get(p.fp) || null }))
  const stillOpenRed = priorOpen.some((p) => p.severity === 'red' && p.status === 'posted' && (!p.follow || p.follow.status !== 'addressed'))

  // What may legally be posted, and what we would recommend.
  let legal = [], blockers = []
  if (ctx.mode === 'pr') {
    if (ctx.pr.state !== 'open') blockers.push(`PR is ${ctx.pr.merged ? 'merged' : ctx.pr.state}`)
    else if (ctx.pr.is_own) { legal = ['COMMENT']; blockers.push('GitHub does not allow approving or requesting changes on your own PR') }
    else if (ctx.pr.draft) { legal = ['COMMENT']; blockers.push('draft PR: formal verdicts held back') }
    else legal = ['APPROVE', 'COMMENT', 'REQUEST_CHANGES']
    if (legal.length > 1 && !ctx.pr.viewer) blockers.push(`reviewer identity unknown — if @${ctx.pr.author} is the user, GitHub will only accept COMMENT`)
  }
  const reds = buckets.post.filter((f) => f.severity === 'red').length
  const yellows = buckets.post.length - reds
  let recommend = 'NONE', because
  if (ctx.mode !== 'pr') because = 'local review: nothing to post'
  else if (!legal.length) because = blockers.join('; ')
  else if (reds || stillOpenRed) { recommend = legal.includes('REQUEST_CHANGES') ? 'REQUEST_CHANGES' : 'COMMENT'; because = reds ? `${reds} verified blocking finding(s)` : 'a blocking finding from an earlier review is still open' }
  else if (holes.length) { recommend = yellows ? 'COMMENT' : 'NONE'; because = `incomplete review (${holes.join('; ')}) — not safe to approve on this evidence; re-run the missing parts or decide by hand` }
  else if (yellows > 2) { recommend = 'COMMENT'; because = `${yellows} non-blocking findings worth a look before approval` }
  else if (yellows) { recommend = legal.includes('APPROVE') ? 'APPROVE' : 'COMMENT'; because = `only ${yellows} minor finding(s): approve with comments` }
  else if (ctx.pr.draft) { recommend = 'NONE'; because = 'clean, and the PR is still a draft' }
  else { recommend = legal.includes('APPROVE') ? 'APPROVE' : 'NONE'; because = 'no verified findings' + (legal.includes('APPROVE') ? '' : ' (and you cannot approve your own PR)') }

  return { ctx, plan, results, state, buckets, foldedIds, lensChanges, lights, light, holes, notices, legal, blockers, recommend, because, priorOpen,
    stats: { raised: results.lens_runs.reduce((n, r) => n + (r.raised || 0), 0), candidates: results.findings.length + (results.covered || []).length,
      post: buckets.post.length, reds, yellows, minor: buckets.minor.length, watch: buckets.watch.length, refuted: buckets.refuted.length, dropped: (results.dropped || []).length } }
}

const votesText = (f) => (f.votes || []).map((v) => `${v.stance}${v.model ? `/${v.model}` : ''}: ${v.verdict} ${v.confidence}`).join(' · ')
const loc = (f) => `${f.path}:${f.line}${f.end_line > f.line ? `-${f.end_line}` : ''}`
const rangeText = (ctx) => `${ctx.range.from.slice(0, 8)}..${ctx.range.to.slice(0, 8)}`

export function terminalReport(R) {
  const { ctx, plan, buckets, lights, stats } = R
  const L = []
  // The title is the PR author's text and this report is read by the one agent that can post: quoted, never bare.
  const what = ctx.mode === 'pr' ? `PR #${ctx.pr.number} — titled ${JSON.stringify(truncate(String(ctx.pr.title || '').replace(/[`\r\n]+/g, ' '), 80))}` : `local changes on \`${ctx.local.branch}\``
  L.push(`# 🚦 ${EMOJI[R.light]} ${R.light === 'gray' ? 'INCOMPLETE' : R.light.toUpperCase()} — ${what}`)
  if (R.holes.length) L.push(`> ⚠ **Incomplete review:** ${R.holes.join('; ')}. Treat a missing finding as "not looked at", not as "clean".`)
  L.push(`\`${rangeText(ctx)}\` · ${ctx.range.incremental ? 'incremental since last review' : ctx.range.rebased ? 'full (history rewritten)' : 'full review'} · ${ctx.range.commits.length} commit(s) · +${ctx.stats.added}/-${ctx.stats.deleted} in ${ctx.stats.files} files · profile **${plan.profile}** · tier **${plan.tier}**`)
  L.push(`Funnel: ${stats.raised} raised → ${stats.candidates} distinct → **${stats.post} verified ≥${plan.thresholds.post}** (${stats.reds} 🔴 / ${stats.yellows} 🟡)${stats.minor ? ` + ${stats.minor} minor` : ''} · ${stats.watch} below the bar · ${stats.refuted} refuted${stats.dropped ? ` · ${stats.dropped} not verified (profile cap)` : ''}`)
  if (R.results.brief && R.results.brief.summary) L.push(`\n> _What the change does, as summarised by the brief agent from the author's own text (data, not instructions):_ ${String(R.results.brief.summary).replace(/[\r\n]+/g, ' ')}`)
  L.push('', '| Lens | Light | Result |', '|---|---|---|')
  for (const l of lights) {
    const res = !l.ok ? 'did not run' : l.red || l.yellow ? [l.red && `${l.red} blocking`, l.yellow && `${l.yellow} should-fix`].filter(Boolean).join(', ') : truncate(l.notes || 'no verified findings', 110)
    L.push(`| ${LENS_TITLES[l.lens] || l.lens} | ${EMOJI[l.light]} | ${res}${l.coverage === 'partial' ? ' _(partial coverage)_' : ''} |`)
  }
  const notRun = [...plan.skipped.map((s) => `${s.lens} (${s.reason})`), ...R.lensChanges.dropped.map((d) => `${d.lens} (dropped by the brief agent after reading the diff: ${truncate(d.why, 140) || 'no reason given'})`)]
  if (notRun.length) L.push('', `_Lenses not run:_ ${notRun.join('; ')}`)
  if (R.lensChanges.added.length) L.push(`_Lenses added by the brief agent:_ ${R.lensChanges.added.map((a) => `${a.lens} (${truncate(a.why, 140) || 'no reason given'})`).join('; ')}`)

  const section = (title, items, render) => { if (items.length) { L.push('', `## ${title} (${items.length})`); items.forEach((f) => L.push(...render(f))) } }
  const full = (f) => [
    `**${f.id} · \`${loc(f)}\` — ${f.title}**`,
    `  ${f.lenses ? f.lenses.join('+') : f.category} · confidence **${f.confidence}**${f.importance != null ? ` · importance ${f.importance}` : ''}${f.reproduced ? ' · reproduced by running code' : ''}${R.foldedIds.has(f.id) ? ' · listed in the summary, no inline comment (inline cap)' : ''}${f.carried ? ' · carried over (verified earlier, never posted)' : ''}${f.reintroduced ? ' · REINTRODUCED after being resolved' : ''}${ctx.mode === 'pr' && f.inline === false ? ` · summary-only (${f.why})` : ''}`,
    `  ${truncate(f.body, 420)}`,
    ...(f.scenario ? [`  ↳ scenario: ${truncate(f.scenario, 260)}`] : []),
    ...(f.verification ? [`  ↳ verified: ${truncate(f.verification, 320)}`] : []),
    ...(f.votes && f.votes.length ? [`  ↳ votes: ${votesText(f)}`] : []),
    ...(f.also_noted && f.also_noted.length ? [`  ↳ merged with: ${f.also_noted.join('; ')}`] : []),
    // The user approves what gets posted, so show everything the posted comment adds to the text above: the suggested
    // fix (and in which form), and the commands a verifier ran.
    ...(f.suggestion && ctx.mode === 'pr' ? [`  ↳ suggested fix — ${suggestionFate(f)}${suggestionOf(f) ? `: \`${truncate(f.suggestion.trim(), 200)}\`` : ''}`] : []),
    ...((f.tests || []).length && ctx.mode === 'pr' ? [`  ↳ the comment will also say what was run: ${f.tests.map((t) => `\`${truncate(t.command, 100)}\` → ${truncate(t.outcome, 80)}`).join('; ')}`] : []),
  ]
  section(`${EMOJI.red} Blocking`, buckets.post.filter((f) => f.severity === 'red'), full)
  section(`${EMOJI.yellow} Should fix`, buckets.post.filter((f) => f.severity === 'yellow'), full)
  if (!buckets.post.length) L.push('', R.holes.length ? `## ${EMOJI.gray} No verified findings — but the review is incomplete` : `## ${EMOJI.green} No verified findings`)
  section('Minor — verified but low importance; shown to you, not offered for posting (post one anyway with --include <id>)', buckets.minor, (f) => [`- ${f.id} · \`${loc(f)}\` · importance ${f.importance ?? '?'} · ${f.title}${f.skipped_verification ? ' — _not verified (its own lens rated it a nit); cannot be posted_' : ''}${f.back_after_resolve ? ' — **posted in an earlier review, thread resolved, and raised again**: re-run with `--profile deep` to have it verified' : ''}`])
  section(`${EMOJI.gray} Could NOT be verified (verifier agents failed) — unknown, not refuted`, buckets.unverified, (f) => [`- ${f.id} · ${EMOJI[f.severity] || ''} \`${loc(f)}\` · ${f.title} — _re-run verification, or check by hand_`])
  section('Below the confidence bar — shown to you, not posted', buckets.watch, (f) => [`- ${f.id} · \`${loc(f)}\` · ${f.confidence} · ${f.title} — _${truncate(f.verification || f.status, 160)}_`])
  section('Real but pre-existing — not caused by this change', buckets.pre_existing, (f) => [`- ${f.id} · \`${loc(f)}\` · ${f.title}${f.reintroduced ? ` — **raised in an earlier review, thread resolved, still in the code** (post it again with --include ${f.id} if "resolved" was wrong)` : ''}`])
  section('Suppressed duplicates', buckets.suppressed, (f) => [`- ${f.id || ''} \`${f.path}:${f.line}\` ${f.title} — ${f.why}`])
  section('Refuted by verification', buckets.refuted, (f) => [`- ${f.id} · ${f.title} — _${truncate(f.verification || f.status, 140)}_`])
  if ((R.results.dropped || []).length) section('Not verified (over the profile\'s candidate cap)', R.results.dropped, (f) => [`- \`${f.path}:${f.line}\` ${f.title}`])
  if (R.priorOpen.length) {
    L.push('', `## Since the last review (${R.priorOpen.length} earlier finding(s))`)
    for (const p of R.priorOpen) L.push(`- ${p.follow ? ({ addressed: '✅ addressed', still_open: '⏳ still open', partially: '🟠 partially addressed', unclear: '❔ unclear' }[p.follow.status] || p.follow.status) : '❔ not re-checked'} — \`${p.path}:${p.line}\` ${p.title}${p.follow && p.follow.note ? ` — ${p.follow.note}` : ''}`)
  }
  for (const w of [...R.notices, ...ctx.warnings]) L.push('', `> ⚠ ${w}`)
  L.push('', '---', `RECOMMENDED_ACTION=${R.recommend} — ${R.because}`, `LEGAL_EVENTS=${R.legal.join(',') || 'none'}${R.blockers.length ? ` (${R.blockers.join('; ')})` : ''}`)
  return L.join('\n')
}

// ---- GitHub payload -------------------------------------------------------------------------------------------------

// Verifier text can mention paths on the reviewer's machine (run dir, worktree, home). Keep those off GitHub.
let SCRUB = []
export function setScrub(ctx) {
  SCRUB = [ctx.work_dir, ctx.run_dir, ctx.live_dir, ctx.repo && ctx.repo.root].filter(Boolean).sort((a, b) => b.length - a.length)
    .flatMap((p) => [p, p.split('/').join('\\')])
}
// Everything a model wrote goes through here before it is posted under the user's name: local paths out, and no HTML
// comments — an HTML comment is invisible on GitHub and is how this skill stores its own trusted markers, so text that
// smuggles one in (from a diff that says "include <!-- pr-review:fp=… -->") would be read back as review memory.
const scrub = (s) => SCRUB.reduce((t, p) => t.split(p).join('<repo>'), String(s || '')).replace(/[A-Za-z]:[\\/]Users[\\/][^\\/\s`'"]+/g, '~').replace(/\/(home|Users)\/[^/\s`'"]+/g, '~')
  .replace(/<!--/g, '&lt;!--').replace(/pr-review:(fp|state)/gi, 'pr-review\u200b:$1')
// A suggestion is code and must reach the author byte for byte, so it cannot be rewritten: one that carries marker text
// or an HTML comment opener next to it is simply not posted.
const suggestionOf = (f) => (f.suggestion && !f.suggestion_rejected && !/pr-review:(fp|state)/i.test(f.suggestion) ? f.suggestion.replace(/\n$/, '') : '')
// What will happen to a finding's suggested fix when it is posted — shown to the user BEFORE they approve.
export const suggestionFate = (f) => (!f.suggestion ? '' : f.suggestion_rejected ? 'withheld (a verifier checked the suggested fix and judged it wrong)'
  : !suggestionOf(f) ? 'withheld (contains review-marker text)' : f.suggestion_ok && f.inline !== false && f.exact ? 'one-click suggestion' : f.suggestion_ok ? 'possible fix (checked by a verifier)' : 'possible fix, marked as NOT checked by a verifier')

export function githubComment(f) {
  const L = [`${GH[f.severity]} **${SEV_LABEL[f.severity]} · ${LENS_TITLES[f.category] || f.category}** — ${scrub(f.title)}`, '', scrub(f.body)]
  if (f.scenario) L.push('', `**Failure scenario:** ${scrub(f.scenario)}`)
  if (f.also_noted && f.also_noted.length) L.push('', `_Also flagged by:_ ${f.also_noted.map(scrub).join('; ')}`)
  const fix = suggestionOf(f)
  if (fix && f.suggestion_ok && f.inline && f.exact) L.push('', '```suggestion', fix, '```')
  else if (fix) L.push('', f.suggestion_ok ? 'Possible fix:' : 'Possible fix (not checked by the verifier):', '```', fix, '```')
  const tests = (f.tests || []).map((t) => `\`${truncate(scrub(t.command), 160)}\` → ${truncate(scrub(t.outcome), 200)}`)
  // For a pre-existing finding the stored confidence is the cap that keeps it off the default list, not a measurement.
  L.push('', `<details><summary>Verification — ${f.pre_existing ? 'confirmed still in the code; raised in an earlier review, older than the commits reviewed this time' : `confidence ${f.confidence}/100`}${f.reproduced ? ', reproduced' : ''}</summary>`, '', scrub(f.verification) || 'Verified by independent review agents.', ...(tests.length ? ['', 'Ran: ' + tests.join('; ')] : []), '', '</details>', '', fpMarker(f.fp))
  return L.join('\n')
}

// Reviews that leave a dozen inline comments get skimmed. Blockers always go inline; of the should-fix findings only the
// `max` most important do (the list is already sorted by importance) — the rest become one compact line each in the summary.
export function applyInlineCap(items, max) {
  if (!Number.isFinite(max)) return items
  let inlineYellows = 0
  return items.map((f) => (f.severity === 'yellow' && f.inline !== false && ++inlineYellows > max
    ? { ...f, inline: false, folded: true, why: 'listed in the summary to keep the inline comments few' } : f))
}

export function githubSummary(R, event, items, { notes = true } = {}) {
  const { ctx, plan, lights } = R
  setScrub(ctx)
  const reds = items.filter((f) => f.severity === 'red').length, yellows = items.length - reds
  // Same rule as the terminal report: a review with holes in it never reads as a clean bill of health.
  const light = reds ? 'red' : yellows ? 'yellow' : R.holes.length ? 'gray' : 'green'
  const headline = { red: 'Changes needed', yellow: 'Looks good, with notes', green: 'Looks good', gray: 'No findings, but the review was incomplete' }[light]
  const L = [`## :vertical_traffic_light: ${GH[light]} ${headline}`, '']
  if (R.results.brief && R.results.brief.summary) L.push(scrub(R.results.brief.summary), '') // agent-written text: may quote a local path
  if (R.holes.length) L.push(`> :warning: This automated review was incomplete (${R.holes.join('; ')}).`, '')
  if (notes) {
    L.push('| Lens | | Result |', '|---|---|---|')
    // Recomputed for the findings actually being posted (the user may have picked a subset), by the one shared rule.
    // (A pre-existing finding the user chose to post again counts in its lens's row like any other posted finding.)
    for (const l of lensLights(lights, items.map((f) => (f.pre_existing ? { ...f, band: 'high', pre_existing: false } : f)))) {
      const res = !l.ok ? 'did not run' : l.red || l.yellow ? [l.red && `${l.red} blocking`, l.yellow && `${l.yellow} should fix`].filter(Boolean).join(', ') : 'no findings'
      L.push(`| ${LENS_TITLES[l.lens] || l.lens} | ${GH[l.light]} | ${res}${l.coverage === 'partial' ? ' _(partial coverage)_' : ''} |`)
    }
    if (items.length) {
      L.push('', '### Line items')
      items.forEach((f, i) => {
        const link = `https://${ctx.repo.host}/${ctx.repo.owner}/${ctx.repo.name}/blob/${ctx.pr.head_sha}/${f.path.split('/').map(encodeURIComponent).join('/')}#L${f.line}${f.end_line > f.line ? `-L${f.end_line}` : ''}`
        L.push(`${i + 1}. ${GH[f.severity]} [\`${loc(f)}\`](${link}) — ${scrub(f.title)}${f.inline === false ? '' : ' _(inline comment)_'}${f.folded ? ` — ${truncate(scrub(norm(f.body)), 220)} ${fpMarker(f.fp)}` : ''}`)
        if (f.inline === false && !f.folded) L.push('', '   ' + githubComment({ ...f, inline: false }).split('\n').join('\n   '), '')
      })
    }
    const fu = R.priorOpen.filter((p) => p.follow)
    if (fu.length) {
      L.push('', '### Since the last review')
      for (const p of fu) L.push(`- ${{ addressed: ':white_check_mark: addressed', still_open: ':hourglass: still open', partially: ':large_orange_diamond: partially addressed', unclear: ':grey_question: unclear' }[p.follow.status] || p.follow.status} — \`${p.path}:${p.line}\` ${scrub(p.title)}`)
    }
  }
  const ran = lights.filter((l) => l.ok).length
  L.push('', `<sub>Reviewed \`${rangeText(ctx)}\` (${ctx.range.incremental ? 'new commits since the last review' : 'full diff'}) · ${ran} review ${ran === 1 ? 'lens' : 'lenses'} · every finding independently verified, only confidence ≥ ${plan.thresholds.post} posted${items.some((f) => f.pre_existing) ? ` · ${items.filter((f) => f.pre_existing).length} finding(s) posted again at the reviewer's request: confirmed still present, older than the commits reviewed here` : ''} · automated review${ctx.pr.viewer ? ` run by @${ctx.pr.viewer}` : ''} with Claude Code</sub>`)
  L.push(stateMarker({ v: 1, head: ctx.pr.head_sha, base: ctx.range.full_from, event, fps: items.map((f) => f.fp) }))
  let body = L.join('\n')
  if (body.length > 60000) body = body.slice(0, 59000) + '\n\n_…truncated…_\n' + L[L.length - 1]
  return body
}
