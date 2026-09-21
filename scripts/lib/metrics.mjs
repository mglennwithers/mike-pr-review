// Local, append-only metrics log: ~/.claude/pr-review/metrics/events.jsonl
//   run        one per completed review (written by `prr post`, including --event NONE): size, plan, funnel, per-lens
//              results, per-finding decisions, measured token usage and cost
//   outcome    what later happened to a posted finding: the author fixed it, the thread was resolved, reactions, ...
//   benchmark  score of a review of a seeded-bug fixture (`prr score`): recall / precision against known answers
// Nothing leaves the machine. It holds repo names, file paths and finding titles, never code. PR_REVIEW_METRICS=off
// disables writing.
import fs from 'node:fs'
import path from 'node:path'
import { HOME_DIR } from './util.mjs'

export const METRICS_FILE = path.join(HOME_DIR, 'metrics', 'events.jsonl')
const enabled = () => !/^(off|0|false|no)$/i.test(process.env.PR_REVIEW_METRICS || '')

export function appendEvent(ev) {
  if (!enabled()) return false
  try {
    fs.mkdirSync(path.dirname(METRICS_FILE), { recursive: true })
    fs.appendFileSync(METRICS_FILE, JSON.stringify({ v: 1, at: new Date().toISOString(), ...ev }) + '\n')
    return true
  } catch { return false } // metrics must never break a review
}

export function readEvents() {
  let text
  try { text = fs.readFileSync(METRICS_FILE, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      const ev = JSON.parse(line)
      // Only well-formed records of this schema version: a torn, hand-edited or future-version line must never be able
      // to crash `plan` (which reads the log for its estimate) or `stats`.
      if (ev && typeof ev === 'object' && !Array.isArray(ev) && ev.v === 1 && typeof ev.type === 'string') out.push(ev)
    } catch { /* torn line */ }
  }
  return out
}

// What a sub-agent costs grows with what it has to read: a lens agent reads its whole shard, and a verifier works inside
// the whole change. Costs are therefore logged and estimated per "size unit": an agent on a tiny change is about one
// unit, and the two factors below scale that with the effective lines to read. The slopes are rough starting values (a
// lens agent doubles at 1,100 lines; a verifier grows more slowly and is capped at 3 units), not fitted constants.
export const lensSizeFactor = (eff) => 1 + Math.max(0, Number(eff) || 0) / 1100
export const verifySizeFactor = (totalEff) => Math.min(3, 1 + Math.max(0, Number(totalEff) || 0) / 5000)
const stageKind = (stage) => (stage === 'tiebreak' ? 'verify' : stage)

const slimUsage = (u, plan, ctx) => {
  if (!u || u.source !== 'transcripts') return { source: u ? u.source : 'none' }
  const shardEff = new Map(((plan && plan.lens_tasks) || []).map((t) => [t.shard, t.eff]))
  const totalEff = ctx && ctx.stats ? ctx.stats.effective_lines : 0
  const units = {}
  for (const a of u.agents || []) {
    const k = `${a.stage}|${a.alias}`
    units[k] = (units[k] || 0) + (a.stage === 'lens' ? lensSizeFactor(shardEff.get(a.shard) ?? totalEff) : stageKind(a.stage) === 'verify' ? verifySizeFactor(totalEff) : 1)
  }
  const slim = (g) => Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { agents: v.agents, tokens: v.total, cost: v.cost }]))
  const t = u.totals
  return { source: 'transcripts', agents: t.agents, tokens: t.tokens, fresh_input: t.input + t.cache_write_5m + t.cache_write_1h, cache_read: t.cache_read, output: t.output, cost: t.cost,
    wall_ms: t.agent_wall_ms, unpriced_tokens: t.unpriced_tokens || 0, orchestrator: u.orchestrator ? { tokens: u.orchestrator.total, cost: u.orchestrator.cost, turns: u.orchestrator.turns } : null,
    by_stage: slim(u.by_stage), by_model: slim(u.by_model), by_lens: slim(u.by_lens),
    by_stage_model: Object.fromEntries(Object.entries(slim(u.by_stage_model)).map(([k, v]) => [k, { ...v, units: Math.round((units[k] || v.agents) * 100) / 100 }])) }
}

// Build the `run` record from the prepared review (report.mjs prepare()), what the user chose, and measured usage.
export function runRecord(R, { event, postedFps, dismissedFps, usage, prior }) {
  const { ctx, plan, results, buckets } = R
  const decisionOf = new Map()
  for (const [bucket, label] of [['minor', 'minor'], ['watch', 'below_bar'], ['refuted', 'refuted'], ['unverified', 'unverified'], ['pre_existing', 'pre_existing'], ['suppressed', 'suppressed']]) for (const f of buckets[bucket]) if (f.fp) decisionOf.set(f.fp, label)
  for (const f of buckets.post) decisionOf.set(f.fp, postedFps.has(f.fp) ? 'posted' : 'pending')
  for (const fp of dismissedFps) decisionOf.set(fp, 'dismissed')
  // Verification status (bucket) and the user's decision are separate facts: a dismissed below-the-bar finding was never
  // "verified", and precision must not be flattered by it.
  const all = ['post', 'minor', 'watch', 'refuted', 'unverified', 'pre_existing', 'suppressed'].flatMap((b) => buckets[b].filter((f) => f.fp).map((f) => ({ ...f, bucket: b })))
  let findings = all.map((f) => ({ id: f.id, fp: f.fp, bucket: f.bucket, path: f.path, title: String(f.title || '').slice(0, 140), lenses: f.lenses || [f.category], category: f.category, severity: f.severity,
    raised_as: f.original_severity || f.severity, status: f.status || null, confidence: f.confidence ?? null, importance: f.importance ?? null, band: f.band || null, reproduced: !!f.reproduced, votes: (f.votes || []).length,
    carried: !!f.carried, skipped_verification: !!f.skipped_verification, decision: decisionOf.get(f.fp) || 'unknown' }))
  // `post` can run again on the same run (post later what was held back). By then the state file says "already posted /
  // dismissed", so those findings show up as suppressed duplicates of themselves. Restore what the earlier record of
  // THIS run knew, and let new decisions win.
  if (prior && prior.size) {
    const seen = new Set()
    findings = findings.map((f) => { seen.add(f.fp); const p = prior.get(f.fp); return p && f.bucket === 'suppressed' ? { ...p, decision: postedFps.has(f.fp) ? 'posted' : dismissedFps.has(f.fp) ? 'dismissed' : p.decision } : f })
    for (const [fp, p] of prior) if (!seen.has(fp)) findings.push(p)
  }

  const lensStats = {}
  for (const r of results.lens_runs) { const s = (lensStats[r.lens] ||= { ok: true, raised: 0, verified: 0, below_bar: 0, refuted: 0, unverified: 0, posted: 0, dismissed: 0 }); s.raised += r.raised || 0; s.ok = s.ok && !!r.ok }
  for (const f of findings) for (const l of f.lenses) {
    const s = (lensStats[l] ||= { ok: true, raised: 0, verified: 0, below_bar: 0, refuted: 0, unverified: 0, posted: 0, dismissed: 0 })
    // a minor finding was verified too — it counts for the lens's precision, but is tracked so a lens that mostly finds nits shows up
    if ((f.bucket === 'post' || (f.bucket === 'minor' && !f.skipped_verification)) && !f.carried) s.verified++
    if (f.bucket === 'minor' && !f.skipped_verification) s.minor = (s.minor || 0) + 1
    // Never sent to a verifier (self-rated nit): neither survived nor failed, so it must not count against precision.
    if (f.skipped_verification) s.not_verified = (s.not_verified || 0) + 1
    if (f.bucket === 'watch') s.below_bar++
    if (f.bucket === 'refuted' || f.bucket === 'pre_existing') s.refuted++
    if (f.bucket === 'unverified') s.unverified++
    if (f.decision === 'posted') s.posted++
    if (f.decision === 'dismissed') s.dismissed++
  }
  const nb = (bucket, also = () => true) => findings.filter((f) => f.bucket === bucket && also(f)).length
  const votes = results.findings.flatMap((f) => f.votes || [])
  const chosen = event === 'NONE' ? 'NONE' : event
  return {
    type: 'run', run_id: path.basename(ctx.run_dir), key: ctx.mode === 'pr' ? `${ctx.repo.host}/${ctx.repo.owner}/${ctx.repo.name}#${ctx.pr.number}` : `local:${ctx.repo.name}:${ctx.local.branch}`,
    mode: ctx.mode, repo: ctx.repo.owner ? `${ctx.repo.owner}/${ctx.repo.name}` : ctx.repo.name, profile: plan.profile, tier: plan.tier, engine: results.engine || 'unknown',
    incremental: !!ctx.range.incremental, rebased: !!ctx.range.rebased, fixture: ctx.fixture || null,
    size: { files: ctx.stats.files, reviewable: ctx.stats.reviewable_files, added: ctx.stats.added, deleted: ctx.stats.deleted, effective: ctx.stats.effective_lines, risk_points: ctx.stats.risk_points },
    signals: ctx.signals.map((s) => s.name), lenses_planned: Array.from(new Set(plan.lens_tasks.map((t) => t.lens))), lenses_skipped: plan.skipped.map((s) => s.lens),
    funnel: { raised: R.stats.raised, distinct: R.stats.candidates, verified: nb('post', (f) => !f.carried), minor: nb('minor', (f) => !f.skipped_verification), not_verified_nits: nb('minor', (f) => f.skipped_verification), below_bar: nb('watch'), refuted: nb('refuted'), pre_existing: nb('pre_existing'), unverified: nb('unverified'),
      suppressed: nb('suppressed') + buckets.suppressed.filter((f) => !f.fp).length, dropped: (results.dropped || []).length, carried: nb('post', (f) => f.carried) },
    verification: { votes: votes.length, confirmed: votes.filter((v) => v.verdict === 'confirmed').length, refuted: votes.filter((v) => v.verdict === 'refuted').length,
      tiebreaks: votes.filter((v) => v.stance === 'tiebreak').length, reproduced: results.findings.filter((f) => f.reproduced).length, tests_run: results.findings.reduce((n, f) => n + (f.tests || []).length, 0) },
    light: R.light, incomplete: R.holes.length > 0, recommended: R.recommend, chosen, agreed: R.recommend === chosen,
    decisions: { posted: findings.filter((f) => f.decision === 'posted').length, pending: findings.filter((f) => f.decision === 'pending').length, dismissed: findings.filter((f) => f.decision === 'dismissed').length },
    lens_stats: lensStats, findings, usage: slimUsage(usage, plan, ctx),
  }
}

// ---- calibration: what does one sub-agent of a given kind cost in this user's own runs? --------------------------------

// Cost of ONE SIZE UNIT (see lensSizeFactor / verifySizeFactor: an agent on a tiny change is ~1 unit). These built-in
// numbers are rough starting values at the list prices in pricing.json — not a statement about anybody's code base, and
// they do not follow later edits to pricing.json. calibration() replaces each kind with the average from the user's own
// metrics log once that log holds 3 or more measured agents of the kind. Keys are `<stage>|<model alias>`. The opus lens
// value assumes more tokens per agent as well as the higher price per token.
const DEFAULT_AGENT_COST = { 'lens|sonnet': { tokens: 680e3, cost: 0.39 }, 'lens|haiku': { tokens: 350e3, cost: 0.12 }, 'lens|opus': { tokens: 1300e3, cost: 1.7 },
  'verify|sonnet': { tokens: 650e3, cost: 0.3 }, 'verify|haiku': { tokens: 450e3, cost: 0.1 }, 'verify|opus': { tokens: 650e3, cost: 0.75 },
  'chore|haiku': { tokens: 120e3, cost: 0.07 }, 'chore|sonnet': { tokens: 300e3, cost: 0.2 }, 'chore|opus': { tokens: 300e3, cost: 0.5 } }
const CHORES = new Set(['brief', 'dedupe', 'followup', 'chore', 'critic', 'critic-gap', 'transport'])

// A record without size units (written by another tool, or edited by hand): estimate them from the size of the change. Lens agents of one lens split the
// change between them, so an average shard is about (effective lines x lenses / lens agents).
function legacyUnits(stage, agents, ev) {
  const eff = (ev.size && ev.size.effective) || 0
  if (stage === 'verify') return agents * verifySizeFactor(eff)
  if (stage !== 'lens') return agents
  const lensAgents = (ev.usage.by_stage && ev.usage.by_stage.lens && ev.usage.by_stage.lens.agents) || agents
  const lenses = (ev.lenses_planned || []).length || 1
  return agents * lensSizeFactor(Math.min(eff, (eff * lenses) / Math.max(1, lensAgents)))
}

export function calibration() {
  const acc = {}
  const orchByRun = new Map() // a run is re-recorded when `post` runs again: keep its last figure only
  let runs = 0
  try {
  for (const ev of readEvents()) {
    if (ev.type !== 'run' || !ev.usage || ev.usage.source !== 'transcripts') continue
    runs++
    if (ev.usage.orchestrator && typeof ev.usage.orchestrator.cost === 'number') { orchByRun.delete(ev.run_id); orchByRun.set(ev.run_id, ev.usage.orchestrator.cost) }
    for (const [k, v] of Object.entries(ev.usage.by_stage_model || {})) {
      const [stage, alias] = k.split('|')
      const key = `${stage === 'tiebreak' ? 'verify' : CHORES.has(stage) ? 'chore' : stage}|${alias}`
      const a = (acc[key] ||= { agents: 0, units: 0, tokens: 0, cost: 0 })
      if (!v || typeof v.cost !== 'number' || !v.agents) continue
      a.agents += v.agents; a.units += typeof v.units === 'number' && v.units > 0 ? v.units : legacyUnits(key.split('|')[0], v.agents, ev); a.tokens += v.tokens || 0; a.cost += v.cost
    }
  }
  } catch { /* an odd log must never stop `plan`: fall back to the built-in starting values */ }
  const table = { ...DEFAULT_AGENT_COST }
  let measuredKinds = 0
  for (const [k, a] of Object.entries(acc)) if (a.agents >= 3 && a.units > 0) { table[k] = { tokens: a.tokens / a.units, cost: a.cost / a.units, measured: a.agents }; measuredKinds++ }
  // perUnit: multiply by the agent's size factor to get what that agent is expected to cost.
  const orch = Array.from(orchByRun.values()).slice(-10).sort((a, b) => a - b) // the ten most recent reviews
  const orchestrator = { n: orch.length, median: orch.length ? orch[Math.floor((orch.length - 1) / 2)] : null }
  return { runs, measuredKinds, table, orchestrator, perUnit: (stage, alias) => table[`${stage}|${alias}`] || table[`${stage}|sonnet`] || { tokens: 500e3, cost: 0.3 } }
}
