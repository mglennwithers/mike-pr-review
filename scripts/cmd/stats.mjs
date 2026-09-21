// prr stats — what the reviews cost and how well they find things, from the local metrics log.
import { TIERS, UserError, parseArgs } from '../lib/util.mjs'
import { METRICS_FILE, readEvents } from '../lib/metrics.mjs'
import { fmtCost, fmtTokens, listPrices } from '../lib/usage.mjs'

const pct = (a, b) => (b ? `${Math.round((100 * a) / b)}%` : '—')
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null)
const median = (xs) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2 }

function since(arg) {
  if (!arg) return 0
  const m = String(arg).match(/^(\d+)\s*([dwm])$/i)
  if (m) return Date.now() - Number(m[1]) * { d: 1, w: 7, m: 30 }[m[2].toLowerCase()] * 86400e3
  const t = Date.parse(arg)
  if (Number.isNaN(t)) throw new UserError(`--since: use e.g. 30d, 8w, 6m or a date (got "${arg}")`)
  return t
}

export function aggregate(events, f = {}) {
  const from = since(f.since)
  const scopeNoDate = (e) => (!f.profile || e.profile === f.profile) && (!f.repo || e.repo === f.repo) && (!f.mode || e.mode === f.mode)
  const inScope = (e) => Date.parse(e.at) >= from && scopeNoDate(e)
  const byId = new Map()
  const wellFormed = (e) => e.type === 'run' && e.run_id && e.funnel && e.decisions && e.verification
  for (const e of events) if (wellFormed(e) && inScope(e)) byId.set(e.run_id, e) // a run recorded twice (posted later): last wins
  const allRuns = [...byId.values()]
  // A calibration run measures the verifiers with invented claims: its funnel and lens numbers are about the answer
  // key, not about anybody's code, so it never belongs in these statistics.
  const runs = allRuns.filter((r) => !r.calibration && (f.include_fixtures ? true : !r.fixture))
  const measured = runs.filter((r) => r.usage && r.usage.source === 'transcripts' && r.usage.cost != null)

  // cost by profile x tier
  const cells = {}
  for (const r of runs) {
    const c = (cells[`${r.profile}|${r.tier}`] ||= { profile: r.profile, tier: r.tier, runs: 0, cost: [], tokens: [], agents: [], minutes: [], verified: [], orch: [] })
    c.runs++; c.verified.push(r.funnel.verified)
    if (r.usage && r.usage.source === 'transcripts' && r.usage.cost != null) { c.cost.push(r.usage.cost); c.tokens.push(r.usage.tokens); c.agents.push(r.usage.agents); if (r.usage.wall_ms) c.minutes.push(r.usage.wall_ms / 60e3); if (r.usage.orchestrator && r.usage.orchestrator.cost != null) c.orch.push(r.usage.orchestrator.cost) }
  }
  const grid = Object.values(cells).sort((a, b) => a.profile.localeCompare(b.profile) || TIERS.indexOf(a.tier) - TIERS.indexOf(b.tier))
    .map((c) => ({ profile: c.profile, tier: c.tier, runs: c.runs, avg_agents: avg(c.agents), avg_tokens: avg(c.tokens), avg_cost: avg(c.cost), median_cost: median(c.cost), avg_orchestrator_cost: avg(c.orch), avg_minutes: avg(c.minutes), avg_verified: avg(c.verified) }))

  const sumGroup = (field) => { const g = {}; for (const r of measured) for (const [k, v] of Object.entries(r.usage[field] || {})) { const x = (g[k] ||= { agents: 0, tokens: 0, cost: 0 }); x.agents += v.agents; x.tokens += v.tokens; x.cost += v.cost || 0 } return g }
  const stage = sumGroup('by_stage'), model = sumGroup('by_model'), lensSpend = sumGroup('by_lens')
  const subCost = measured.reduce((s, r) => s + r.usage.cost, 0)
  const orchCost = measured.reduce((s, r) => s + ((r.usage.orchestrator && r.usage.orchestrator.cost) || 0), 0)

  const F = (k) => runs.reduce((s, r) => s + (r.funnel[k] || 0), 0), V = (k) => runs.reduce((s, r) => s + (r.verification[k] || 0), 0)
  const funnel = { raised: F('raised'), distinct: F('distinct'), verified: F('verified'), below_bar: F('below_bar'), refuted: F('refuted') + F('pre_existing'), unverified: F('unverified'), suppressed: F('suppressed'), dropped: F('dropped'),
    votes: V('votes'), vote_confirmed: V('confirmed'), vote_refuted: V('refuted'), tiebreaks: V('tiebreaks'), reproduced: V('reproduced'), incomplete_runs: runs.filter((r) => r.incomplete).length, clean_runs: runs.filter((r) => r.light === 'green').length }

  // outcomes: latest word per finding
  const outcomes = new Map()
  for (const e of events) if (e.type === 'outcome' && Date.parse(e.at) >= from) { const o = (outcomes.get(`${e.key}|${e.fp}`) || {}); o[e.source] = e; outcomes.set(`${e.key}|${e.fp}`, o) }
  // A finding posted six weeks ago and fixed last week belongs in a 30-day report: the OUTCOME date is filtered, the
  // posting run only has to match repo/profile/mode. Outcomes of findings that were never posted are not author signal.
  const posted = new Map()
  for (const e of events) if (e.type === 'run' && scopeNoDate(e) && !e.fixture) for (const x of e.findings || []) if (x.decision === 'posted') posted.set(`${e.key}|${x.fp}`, x)
  const human = { runs_pr: runs.filter((r) => r.mode === 'pr').length, agreed: runs.filter((r) => r.mode === 'pr' && r.agreed).length,
    posted: runs.reduce((s, r) => s + r.decisions.posted, 0), pending: runs.reduce((s, r) => s + r.decisions.pending, 0), dismissed: runs.reduce((s, r) => s + r.decisions.dismissed, 0),
    followed_up: 0, addressed: 0, still_open: 0, partially: 0, unclear: 0, resolved_threads: 0, liked: 0, disliked: 0, discussed: 0 }

  // lens scoreboard
  const lens = {}
  const L = (k) => (lens[k] ||= { runs: 0, failed: 0, raised: 0, verified: 0, minor: 0, not_verified: 0, below_bar: 0, refuted: 0, unverified: 0, posted: 0, dismissed: 0, addressed: 0, still_open: 0, disliked: 0, cost: 0, tokens: 0 })
  for (const r of runs) for (const [k, s] of Object.entries(r.lens_stats || {})) { const x = L(k); x.runs++; if (!s.ok) x.failed++; for (const m of ['raised', 'verified', 'minor', 'not_verified', 'below_bar', 'refuted', 'unverified', 'posted', 'dismissed']) x[m] += s[m] || 0 }
  for (const [k, v] of Object.entries(lensSpend)) if (!k.startsWith('(') && lens[k]) { lens[k].cost += v.cost; lens[k].tokens += v.tokens }
  for (const [id, o] of outcomes) {
    const x = posted.get(id)
    if (!x) continue
    const lenses = x.lenses || []
    if (o.followup) { human.followed_up++; human[o.followup.outcome] = (human[o.followup.outcome] || 0) + 1; for (const l of lenses) if (lens[l] && (o.followup.outcome === 'addressed' || o.followup.outcome === 'still_open')) lens[l][o.followup.outcome]++ }
    if (o.thread) { const fb = o.thread.feedback || {}; if (fb.resolved) human.resolved_threads++; if (fb.up > fb.down) human.liked++; if (fb.down > fb.up) { human.disliked++; for (const l of lenses) if (lens[l]) lens[l].disliked++ } if (fb.replies) human.discussed++ }
  }

  // benchmarks: latest per fixture x profile
  const bench = new Map()
  for (const e of events) if (e.type === 'benchmark' && Date.parse(e.at) >= from && (!f.profile || e.profile === f.profile)) bench.set(`${e.fixture}|${e.profile}|${e.variant || ''}`, e)

  const notes = []
  const cps = measured.length ? subCost / Math.max(1, measured.reduce((s, r) => s + r.funnel.verified, 0)) : null
  for (const [k, x] of Object.entries(lens)) {
    if (x.raised >= 8 && x.verified / x.raised < 0.4) notes.push(`The **${k}** lens is noisy: only ${pct(x.verified, x.raised)} of what it raised survived verification (${x.verified}/${x.raised}). Every refuted finding still costs a verifier run — tighten lenses/${k}.md (its "Confirm before you report" section) or skip it on low-risk changes.`)
    if (x.runs >= 6 && x.verified === 0 && k !== 'quick-scan') notes.push(`The **${k}** lens ran ${x.runs} times (${fmtCost(x.cost)}) without one verified finding. Either your code is clean there or the lens is not pulling its weight — check it against the benchmark fixture before dropping it.`)
    if (x.dismissed >= 3 && x.dismissed >= x.posted) notes.push(`You dismissed ${x.dismissed} verified findings from the **${k}** lens (posted ${x.posted}). Verification is passing things you do not want; consider raising thresholds.post in profiles.json or editing the lens's severity guide.`)
  }
  if (measured.length >= 3 && stage.verify && stage.verify.cost / subCost > 0.65) notes.push(`Verification is ${pct(stage.verify.cost, subCost)} of sub-agent spend. That is the price of precision; if it is too high, the lean profile spends less there (as shipped: one verifier per finding, on cheaper models).`)
  if (measured.length >= 3 && orchCost > subCost * 0.5) notes.push(`The orchestrator costs ${fmtCost(orchCost)} against ${fmtCost(subCost)} for all sub-agents. Each orchestrator turn re-reads the whole session, so start reviews in a fresh session rather than a long-running one.`)
  if (funnel.unverified) notes.push(`${funnel.unverified} finding(s) could not be verified because verifier agents failed — those runs were reported as incomplete.`)
  if (human.followed_up >= 5) notes.push(`Authors fixed ${pct(human.addressed, human.followed_up)} of posted findings that were later re-checked (${human.addressed}/${human.followed_up}) — the best available proxy for real-world precision.`)

  // Findings counted by type, by final severity and by what verification concluded about them. Runs recorded before
  // these fields existed simply do not contribute, so the report can say how many runs are behind the numbers.
  const typed = runs.filter((r) => r.findings_by)
  const sumMaps = (pick) => { const o = {}; for (const r of typed) for (const [k, v] of Object.entries(pick(r) || {})) o[k] = (o[k] || 0) + v; return o }
  const types = { runs: typed.length, total: typed.reduce((s, r) => s + (r.findings_by.total || 0), 0),
    by_category: sumMaps((r) => r.findings_by.by_category), by_severity: sumMaps((r) => r.findings_by.by_severity),
    by_status: sumMaps((r) => r.findings_by.by_status), by_decision: sumMaps((r) => r.findings_by.by_decision) }

  const cx = runs.filter((r) => r.complexity)
  const cAvg = (pick) => (cx.length ? Math.round(cx.reduce((s, r) => s + (pick(r.complexity) || 0), 0) / cx.length) : 0)
  const kindLines = {}, criticalAreas = {}
  for (const r of cx) {
    for (const [k, v] of Object.entries(r.complexity.by_kind || {})) kindLines[k] = (kindLines[k] || 0) + v
    for (const a of r.complexity.critical_areas || []) criticalAreas[a] = (criticalAreas[a] || 0) + 1
  }
  const complexity = { runs: cx.length, avg_effective_lines: cAvg((c) => c.effective_lines), avg_raw_lines: cAvg((c) => c.raw_lines), avg_files: cAvg((c) => c.files),
    avg_commits: cAvg((c) => c.commits), avg_risk_points: cAvg((c) => c.risk_points), avg_lens_agents: cAvg((c) => c.lens_agents), avg_largest_shard: cAvg((c) => c.largest_shard),
    effective_lines_by_kind: kindLines, critical_areas: criticalAreas }

  // Per author of a reviewed PR. Local only, like everything in this log.
  const authors = {}
  for (const r of runs) {
    const login = r.author && r.author.login
    if (!login) continue
    const a = (authors[login] ||= { reviews: 0, verified: 0, posted: 0, own_prs: 0, from_fork: 0, effective_lines: 0 })
    a.reviews++; a.verified += r.funnel.verified || 0; a.posted += (r.decisions && r.decisions.posted) || 0
    if (r.author.own_pr) a.own_prs++
    if (r.author.from_fork) a.from_fork++
    a.effective_lines += (r.complexity && r.complexity.effective_lines) || (r.size && r.size.effective) || 0
  }

  return { scope: { since: f.since || 'all time', profile: f.profile || null, repo: f.repo || null, mode: f.mode || null }, runs: runs.length, fixture_runs: allRuns.length - allRuns.filter((r) => !r.fixture).length, measured: measured.length,
    spend: { sub_agents: subCost, orchestrator: orchCost, tokens: measured.reduce((s, r) => s + r.usage.tokens, 0), cost_per_verified_finding: cps, median_run: median(measured.map((r) => r.usage.cost)) },
    grid, stage, model, funnel, types, complexity, authors, lens, human, benchmarks: [...bench.values()], notes }
}

export default function stats(argv) {
  const args = parseArgs(argv, { booleans: ['json', 'include_fixtures'] })
  const events = readEvents()
  const A = aggregate(events, args)
  if (args.json) return console.log(JSON.stringify(A, null, 2))
  if (!events.length) return console.log(`No metrics recorded yet (${METRICS_FILE}). A record is written each time a review finishes with \`prr post\` (including --event NONE).`)
  const L = [], n1 = (x) => (x == null ? '—' : x.toFixed(1)), row = (...c) => L.push(`| ${c.join(' | ')} |`)
  L.push(`# pr-review stats — ${A.scope.since}${A.scope.profile ? ` · profile ${A.scope.profile}` : ''}${A.scope.repo ? ` · ${A.scope.repo}` : ''}`, '',
    `**${A.runs} review(s)** (${A.measured} with measured usage${A.fixture_runs ? (args.include_fixtures ? `; includes ${A.fixture_runs} benchmark run(s)` : `; ${A.fixture_runs} benchmark run(s) kept separate`) : ''}) · sub-agents ${fmtTokens(A.spend.tokens)} tokens ≈ **${fmtCost(A.spend.sub_agents)}** · orchestrator ≈ ${fmtCost(A.spend.orchestrator)} · median review ${fmtCost(A.spend.median_run)} · **${fmtCost(A.spend.cost_per_verified_finding)} per verified finding**`,
    `_Costs are measured tokens at ${listPrices()} (pricing.json; each run keeps the cost computed when it was recorded). On a subscription plan nothing is billed per token: read them as a yardstick. Cache reads dominate token counts but are cheap._`)
  if (A.grid.length) {
    L.push('', '## Cost by profile and change size', '', '| Profile | Tier | Runs | Agents | Tokens | Sub-agent cost (avg / median) | Orchestrator | Minutes | Verified findings |', '|---|---|---|---|---|---|---|---|---|')
    for (const g of A.grid) row(g.profile, g.tier, g.runs, n1(g.avg_agents), fmtTokens(g.avg_tokens && Math.round(g.avg_tokens)), `${fmtCost(g.avg_cost)} / ${fmtCost(g.median_cost)}`, fmtCost(g.avg_orchestrator_cost), n1(g.avg_minutes), n1(g.avg_verified))
  }
  if (Object.keys(A.stage).length) {
    L.push('', '## Where the spend goes', '', '| Stage | Agents | Tokens | Cost | Share |', '|---|---|---|---|---|')
    for (const [k, v] of Object.entries(A.stage).sort((a, b) => b[1].cost - a[1].cost)) row(k, v.agents, fmtTokens(v.tokens), fmtCost(v.cost), pct(v.cost, A.spend.sub_agents))
    L.push('', '| Model | Agents | Tokens | Cost | Share |', '|---|---|---|---|---|')
    for (const [k, v] of Object.entries(A.model).sort((a, b) => b[1].cost - a[1].cost)) row(k, v.agents, fmtTokens(v.tokens), fmtCost(v.cost), pct(v.cost, A.spend.sub_agents))
  }
  const f = A.funnel
  L.push('', '## Finding funnel', '', `${f.raised} raised by lenses → ${f.distinct} distinct → **${f.verified} verified** (${pct(f.verified, f.distinct)}) · ${f.below_bar} below the bar · ${f.refuted} refuted or pre-existing · ${f.unverified} unverifiable · ${f.suppressed} duplicates suppressed${f.dropped ? ` · ${f.dropped} dropped by candidate caps` : ''}`,
    `Verifier votes: ${f.votes} (${pct(f.vote_confirmed, f.votes)} confirmed, ${pct(f.vote_refuted, f.votes)} refuted) · ${f.reproduced} finding(s) proven by running code · ${f.tiebreaks} tiebreak(s) · ${f.clean_runs} clean review(s) · ${f.incomplete_runs} incomplete`)
  if (A.types.runs) {
    const share = (obj, title, note) => {
      const entries = Object.entries(obj).sort((a, b) => b[1] - a[1])
      if (!entries.length) return
      const total = entries.reduce((n, [, v]) => n + v, 0)
      L.push('', `### ${title}`, ...(note ? [`_${note}_`] : []), '', '| | Findings | Share |', '|---|---|---|')
      for (const [k, v] of entries) row(k, v, pct(v, total))
    }
    L.push('', `## Findings by type`, '', `${A.types.total} finding(s) across ${A.types.runs} run(s) that recorded this breakdown${A.types.runs < A.runs ? ` (of ${A.runs}; older runs predate it)` : ''}.`)
    share(A.types.by_category, 'By category')
    share(A.types.by_severity, 'By severity after verification', 'what the finding ended as — a verifier may downgrade what its lens claimed')
    share(A.types.by_status, 'By verification status', 'one row per finding, unlike the vote counts above: three verifiers on one finding are one finding here')
    share(A.types.by_decision, 'By what you decided')
  }
  if (A.complexity.runs) {
    const c = A.complexity
    L.push('', '## Change complexity', '', `Average of ${c.runs} run(s): **${c.avg_effective_lines} effective lines** (${c.avg_raw_lines} raw) in ${c.avg_files} file(s) over ${c.avg_commits} commit(s) · ${c.avg_risk_points} risk point(s) · ${c.avg_lens_agents} lens agent(s), largest shard ${c.avg_largest_shard} lines.`)
    const kinds = Object.entries(c.effective_lines_by_kind).sort((a, b) => b[1] - a[1])
    if (kinds.length) L.push('', `Effective lines by file kind: ${kinds.map(([k, v]) => `${k} ${v}`).join(' · ')}.`)
    const areas = Object.entries(c.critical_areas).sort((a, b) => b[1] - a[1])
    if (areas.length) L.push(`Critical areas touched: ${areas.map(([k, v]) => `${k} (${v} run(s))`).join(' · ')}.`)
  }
  const authorRows = Object.entries(A.authors).sort((a, b) => b[1].reviews - a[1].reviews)
  if (authorRows.length) {
    L.push('', '## Authors reviewed', '', '| Author | Reviews | Effective lines | Verified findings | Posted | Own PRs | From a fork |', '|---|---|---|---|---|---|---|')
    for (const [login, a] of authorRows) row(`@${login}`, a.reviews, a.effective_lines, a.verified, a.posted, a.own_prs, a.from_fork)
  }
  if (Object.keys(A.lens).length) {
    L.push('', '## Lens scoreboard', '', '| Lens | Runs | Raised | Verified | Precision | Refuted | Posted | You dismissed | Author fixed | Cost | Cost / verified |', '|---|---|---|---|---|---|---|---|---|---|---|')
    for (const [k, x] of Object.entries(A.lens).sort((a, b) => b[1].verified - a[1].verified || b[1].raised - a[1].raised)) row(k, `${x.runs}${x.failed ? ` (${x.failed} failed)` : ''}`, x.raised, x.minor ? `${x.verified} (${x.minor} minor)` : x.verified, pct(x.verified, x.raised - x.not_verified), x.refuted, x.posted, x.dismissed, x.addressed + x.still_open ? `${x.addressed}/${x.addressed + x.still_open}` : '—', fmtCost(x.cost), x.verified ? fmtCost(x.cost / x.verified) : '—')
    L.push('', '_Precision = share of a lens\'s raised findings that survived adversarial verification at the posting bar. A finding raised by two lenses counts for both. Findings a lens rated a nit are never sent to a verifier and are left out of precision. "minor" = verified but under the importance floor: true, and not worth posting — a lens that mostly produces those is accurate without earning its cost._')
  }
  const h = A.human
  L.push('', '## Human signal', '', `Your decisions: ${h.posted} posted · ${h.pending} held back ("not now") · ${h.dismissed} dismissed as wrong · you followed the recommended action in ${pct(h.agreed, h.runs_pr)} of PR reviews (${h.agreed}/${h.runs_pr})`,
    h.followed_up || h.resolved_threads || h.liked || h.disliked ? `Authors: ${h.addressed} fixed · ${h.partially || 0} partly · ${h.still_open} still open · ${h.unclear || 0} unclear (of ${h.followed_up} re-checked) · ${h.resolved_threads} thread(s) resolved · 👍 ${h.liked} · 👎 ${h.disliked} · ${h.discussed} discussed` : '_No author outcomes yet — they are collected when a PR is re-reviewed after new commits._')
  if (A.benchmarks.length) {
    L.push('', '## Benchmarks (seeded-bug fixtures)', '', '| Fixture | Profile | When | Recall | Bait hits (false positives) | Unmatched findings (judge by hand) | Cost | Missed |', '|---|---|---|---|---|---|---|---|')
    for (const b of A.benchmarks) row(b.fixture, b.variant ? `${b.profile} (${b.variant})` : b.profile, String(b.at).slice(0, 10), `${b.found}/${b.expected} (${pct(b.found, b.expected)})`, b.bait_hits, b.extra ?? '—', fmtCost(b.cost), (b.missed || []).join(', ') || '—')
  }
  if (A.notes.length) L.push('', '## Observations', '', ...A.notes.map((n) => `- ${n}`))
  console.log(L.join('\n'))
}
