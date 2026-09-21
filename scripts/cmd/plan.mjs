// prr plan — size the review. Turns (change tier × budget profile) into a concrete list of lens agents, models and
// verification depth, writes every sub-agent's task file, and prints the args blob for the Workflow engine.
import fs from 'node:fs'
import path from 'node:path'
import { FLAG_BOOLEANS, SKILL_DIR, TIERS, UserError, parseArgs, readJson, requireRun, writeJson, writeText } from '../lib/util.mjs'
import * as T from '../lib/tasks.mjs'
import { calibration, lensSizeFactor, verifySizeFactor } from '../lib/metrics.mjs'
import { fmtCost, fmtTokens } from '../lib/usage.mjs'

const MODEL_RANK = { haiku: 0, sonnet: 1, opus: 2 }
const OPTIONAL_LENSES = ['security', 'errors', 'tests', 'concurrency', 'api-compat', 'data-migrations', 'performance']
const CODE = new Set(['code', 'migration', 'other'])
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean)

export default function plan(argv) {
  const args = parseArgs(argv, { booleans: FLAG_BOOLEANS })
  const runDir = requireRun(args)
  const ctx = readJson(path.join(runDir, 'context.json'))
  const cfg = readJson(path.join(SKILL_DIR, 'profiles.json'))
  const profileName = args.profile || process.env.PR_REVIEW_PROFILE || cfg.default
  const profile = cfg.profiles[profileName]
  if (!profile) throw new UserError(`Unknown profile "${profileName}". Available: ${Object.keys(cfg.profiles).join(', ')}`)

  const { tier, reason } = pickTier(ctx, cfg.tiers, args.tier)
  const reviewable = ctx.files.filter((f) => f.patch)
  const hasCode = reviewable.some((f) => CODE.has(f.kind))

  // 1. Which lenses wake up
  // Most changes are small, and several focused lenses plus a brief would each re-read the same few lines: many times
  // the cost of one careful read. A small change that touches no critical area (auth, crypto, money, migrations, CI,
  // secrets) gets ONE combined pass; its findings are verified like any others. Critical areas and anything bigger keep
  // the focused lenses.
  const sc = profile.small_change
  const singlePass = !!sc && !args.lenses && tier === 'small' && ctx.stats.effective_lines <= sc.max_lines && !ctx.stats.critical.length
  let wanted = args.lenses ? list(args.lenses).map((key) => ({ key, why: 'requested', focus: null }))
    : singlePass ? [{ key: 'quick-scan', why: `small change (<= ${sc.max_lines} effective lines, no critical area): one combined pass`, focus: null }]
    : activate(ctx, tier, hasCode)
  for (const key of list(args.add_lenses)) {
    const existing = wanted.find((w) => w.key === key)
    if (existing) Object.assign(existing, { why: 'requested', focus: null, soft: false })
    else wanted.push({ key, why: 'requested', focus: null })
  }
  const skipSet = new Set(list(args.skip_lenses))
  const skipped = wanted.filter((w) => skipSet.has(w.key)).map((w) => ({ lens: w.key, reason: 'skipped on request' }))
  wanted = wanted.filter((w) => !skipSet.has(w.key))
  for (const w of wanted) if (!fs.existsSync(path.join(SKILL_DIR, 'lenses', `${w.key}.md`))) throw new UserError(`No such lens: ${w.key}`)
  const order = ['quick-scan', ...cfg.lens_priority]
  wanted.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  // A lens with nothing to read must not occupy a slot under the cap (a docs-only change could otherwise end up with no
  // reviewer at all), so drop those first.
  wanted = wanted.filter((w) => {
    if (filesForLens(w, reviewable).length) return true
    skipped.push({ lens: w.key, reason: 'no matching files' })
    return false
  })
  // Low-stakes lenses each re-read the whole change to produce mostly should-fix findings, and reading is most of what
  // an agent costs — so each one costs about as much as a core lens. A profile may fold them into ONE combined lens (one
  // read, one agent). Rules: only lenses that actually have files count; a lens the user asked for by name is never
  // folded away; a lens the user skipped stays skipped (the combined lens is told which groups are in scope); a single
  // candidate is not worth folding unless the user asked for the combined lens itself, in which case it absorbs whatever
  // would duplicate it.
  for (const [target, sources] of Object.entries(profile.merge_lenses || {})) {
    const hits = wanted.filter((w) => sources.includes(w.key) && w.why !== 'requested')
    const asked = wanted.find((w) => w.key === target)
    if (!hits.length || (!asked && hits.length < 2)) continue
    wanted = wanted.filter((w) => !hits.includes(w))
    const folded = { merged: hits.map((h) => h.key), parts: hits }
    if (asked) Object.assign(asked, folded)
    else wanted.push({ key: target, why: `one combined pass instead of ${folded.merged.join(' + ')} (each would re-read the whole change)`, focus: null, soft: false, ...folded })
    wanted.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key))
  }
  // The cap trims what the heuristics woke up; lenses the user (or orchestrator) asked for by name always run.
  const cap = profile.lens_cap[tier]
  let auto = 0
  wanted = wanted.filter((w) => {
    if (w.why === 'requested' || ++auto <= cap) return true
    skipped.push({ lens: w.key, reason: `over the ${profileName} profile's lens cap (${cap}) for a ${tier} change` })
    return false
  })

  // 2. Shards: how the files are split between agents of one lens
  let shardLines = profile.shard_lines, shards, lensTasks
  for (let attempt = 0; ; attempt++) {
    shards = {}
    lensTasks = []
    for (const w of wanted) {
      const files = filesForLens(w, reviewable)
      if (!files.length) continue
      const groups = binPack(files, shardLines)
      groups.forEach((g, i) => {
        const id = `${w.key}-${i + 1}`
        shards[id] = { id, lens: w.key, focus: !!w.focus, groups: w.merged || null, eff: g.reduce((n, f) => n + f.eff, 0), files: g }
        lensTasks.push({ lens: w.key, shard: id, model: modelFor(profile, w.key, tier, ctx, args), task: `tasks/lens-${id}.md`, eff: shards[id].eff, ...(w.soft ? { soft: true } : {}) })
      })
    }
    if (lensTasks.length <= profile.max_lens_agents || attempt >= 4) break
    shardLines *= 2 // too many agents for this budget: make shards coarser before dropping coverage
  }
  const coarsened = shardLines / profile.shard_lines
  // Same promise as the lens cap above: what was asked for by name always runs. Only heuristically woken lenses are
  // dropped for the agent budget, least important first; if that is not enough the plan simply exceeds the budget.
  while (lensTasks.length > profile.max_lens_agents) {
    const at = wanted.map((w) => w.why !== 'requested').lastIndexOf(true)
    if (at < 0) break
    const [victim] = wanted.splice(at, 1)
    skipped.push({ lens: victim.key, reason: `dropped to stay within ${profile.max_lens_agents} lens agents (${profileName} profile)` })
    lensTasks = lensTasks.filter((t) => t.lens !== victim.key)
  }
  const activeLenses = Array.from(new Set(lensTasks.map((t) => t.lens)))

  // Lenses the heuristics did NOT wake but the brief agent may ask for after reading the diff (at most two are added).
  // Their shards and task files are prepared now so either engine can start them without coming back to the planner.
  const briefOn = !singlePass && TIERS.indexOf(tier) >= TIERS.indexOf(profile.brief.min_tier) // a single reader needs no briefing
  const optionalTasks = []
  if (briefOn && !args.lenses && lensTasks.length) {
    for (const key of OPTIONAL_LENSES) {
      if (activeLenses.includes(key) || skipSet.has(key) || optionalTasks.length + lensTasks.length >= profile.max_lens_agents) continue
      const files = filesForLens({ key, focus: null }, reviewable)
      if (!files.length) continue
      const id = `${key}-1`
      shards[id] = { id, lens: key, focus: false, eff: files.reduce((n, f) => n + f.eff, 0), files }
      optionalTasks.push({ lens: key, shard: id, model: modelFor(profile, key, tier, ctx, args), task: `tasks/lens-${id}.md`, eff: shards[id].eff })
    }
  }

  // 3. Verification + chores
  // Code from a fork is never executed unless the user explicitly vouched for it (--trust-code).
  const verifyCfg = { ...profile.verify, ...((profile.verify.by_tier || {})[tier] || {}) } // verification depth follows the size of the change
  const runTests = args.no_tests || (!ctx.trust.run_code && !args.trust_code) ? 'no' : verifyCfg.run_tests
  const tierRank = TIERS.indexOf(tier)
  const prior = ctx.prior || { open_findings: [], dismissed: 0 }
  const planObj = {
    v: 1, profile: profileName, profile_label: profile.label, recommended_orchestrator: profile.orchestrator, tier, tier_reason: reason,
    // --verify-floor N: should-fix findings their own lens rates below N are listed as minor without verification. Off by
    // default, because a lens can under-rate a real defect and a finding that skips verification can never be posted; for
    // users who prefer the saving on changes they know to be low-risk.
    thresholds: { ...cfg.thresholds, ...(profile.thresholds || {}), ...(args.verify_floor !== undefined ? { verify_min_importance: Math.max(0, Number(args.verify_floor) || 0) } : {}) }, lenses: wanted.filter((w) => activeLenses.includes(w.key)).map((w) => ({ key: w.key, why: w.why, focus: !!w.focus, soft: !!w.soft })),
    skipped, lens_tasks: lensTasks, optional_lens_tasks: optionalTasks, max_candidates: profile.max_candidates,
    variant: args.no_critical_upgrade ? 'no-critical-upgrade' : null,
    sharding: { shard_lines: shardLines, coarsened, max_lens_agents: profile.max_lens_agents, largest_shard: Math.max(0, ...lensTasks.map((t) => t.eff)) },
    verify: { red: verifyCfg.red, yellow: verifyCfg.yellow, tiebreak: verifyCfg.tiebreak, run_tests: runTests, escalate: !!verifyCfg.escalate, yellow_low_stakes: verifyCfg.yellow_low_stakes || null },
    effort: profile.effort || null,
    chores: {
      model: profile.chore_model,
      brief: briefOn,
      // One cheap call that groups candidates sharing a root cause, so the same defect is not verified (and posted) twice.
      merge: profile.merge_duplicates ? { min_candidates: profile.merge_duplicates.min_candidates ?? 5 } : null,
      // Local reviews have nothing posted to collide with: only dismissed findings need recognising there. Open ones
      // must be verified afresh every time, or an unfixed finding would be filed under "already raised".
      dedupe: !!profile.semantic_dedupe && (ctx.existing_comments.others > 0 || (ctx.mode === 'pr' && prior.open_findings.length > 0) || prior.dismissed > 0),
      followup: !!profile.followup && ctx.mode === 'pr' && prior.open_findings.length > 0,
      // Closing an earlier BLOCKING finding flips the recommendation, so that call gets a verifier-grade model.
      followup_model: prior.open_findings.some((f) => f.severity === 'red') ? verifyCfg.red[0][1] : profile.chore_model,
    },
    critic: profile.critic && profile.critic.enabled && tierRank >= 1 ? { model: profile.critic.model, max_rounds: profile.critic.max_rounds } : null,
  }

  // 4. Task files
  for (const d of ['tasks', 'shards', 'lens', 'verdicts', 'candidates', 'scratch']) fs.mkdirSync(path.join(runDir, d), { recursive: true })
  for (const s of Object.values(shards)) {
    writeJson(path.join(runDir, 'shards', `${s.id}.json`), { id: s.id, lens: s.lens, files: s.files.map((f) => ({
      path: f.path, status: f.status, kind: f.kind, added: f.added, deleted: f.deleted, patch: `${ctx.run_dir}/${f.patch}`, changed_ranges: f.changed_ranges })) })
  }
  for (const t of [...lensTasks, ...optionalTasks]) writeText(path.join(runDir, t.task), T.lensTask(ctx, t.lens, shards[t.shard]))
  writeText(path.join(runDir, 'tasks', 'brief.md'), T.briefTask(ctx, planObj))
  writeText(path.join(runDir, 'tasks', 'merge.md'), T.mergeTask(ctx))
  writeText(path.join(runDir, 'tasks', 'dedupe.md'), T.dedupeTask(ctx))
  writeText(path.join(runDir, 'tasks', 'followup.md'), T.followupTask(ctx))
  writeText(path.join(runDir, 'tasks', 'critic.md'), T.criticTask(ctx))
  writeText(path.join(runDir, 'tasks', 'verify-common.md'), T.verifyCommon(ctx, planObj))

  planObj.estimate = estimate(planObj, ctx.stats.effective_lines)
  // Above these limits the review is real money: the engine arguments are withheld until the user has agreed (--confirmed).
  const limit = cfg.confirm_above || {}
  const why = [profileName === 'max' && 'the max profile', Number.isFinite(limit.cost) && planObj.estimate.cost > limit.cost && `estimated spend above $${limit.cost}`,
    Number.isFinite(limit.agents) && planObj.estimate.total > limit.agents && `more than ${limit.agents} sub-agents`].filter(Boolean)
  planObj.needs_confirmation = lensTasks.length && why.length ? why.join(', ') : null
  planObj.confirmed = !!args.confirmed
  planObj.workflow_args = {
    run: ctx.run_dir, skill: ctx.skill_dir, mode: ctx.mode, thresholds: planObj.thresholds, lens_tasks: lensTasks, optional_lens_tasks: optionalTasks,
    max_candidates: planObj.max_candidates, verify: planObj.verify, chores: planObj.chores, critic: planObj.critic, effort: planObj.effort,
  }
  writeJson(path.join(runDir, 'plan.json'), planObj)
  if (!args.quiet) printPlan(ctx, planObj)
  if (!lensTasks.length) process.exitCode = 7
  else if (planObj.needs_confirmation && !planObj.confirmed) process.exitCode = 9
}

function pickTier(ctx, tiers, forced) {
  if (forced) {
    if (!TIERS.includes(forced)) throw new UserError(`Unknown tier "${forced}" (${TIERS.join(' | ')})`)
    return { tier: forced, reason: 'forced with --tier' }
  }
  const s = ctx.stats
  let i = TIERS.findIndex((t) => {
    const lim = tiers[t]
    return lim.max_lines !== undefined && s.effective_lines <= lim.max_lines && (lim.max_files === undefined || s.reviewable_files <= lim.max_files)
  })
  if (i === -1) i = TIERS.length - 1
  let reason = `~${s.effective_lines} effective lines across ${s.reviewable_files} reviewable files`
  if (s.risk_points >= tiers.risk_bump && i < TIERS.indexOf('large')) { i++; reason += `; raised one tier for risk (${s.risk_points} points)` }
  if (s.critical.length && i === 0) { i = 1; reason += `; touches critical area (${s.critical.join(', ')}) so not treated as trivial` }
  // Small is not the same as harmless: a few lines that build SQL from input, run a shell, or alter a schema deserve
  // real lenses, not the single combined pass reserved for trivial changes.
  const risky = ctx.signals.filter((x) => x.points >= 2).map((x) => x.name)
  if (risky.length && i === 0) { i = 1; reason += `; risk signal (${risky.join(', ')}) so not treated as trivial` }
  return { tier: TIERS[i], reason }
}

function activate(ctx, tier, hasCode) {
  const sig = Object.fromEntries(ctx.signals.map((s) => [s.name, s]))
  const has = (...names) => names.some((n) => sig[n])
  const focus = (...names) => Array.from(new Set(names.flatMap((n) => (sig[n] ? sig[n].files : []))))
  const rank = TIERS.indexOf(tier)
  const kinds = new Set(ctx.files.filter((f) => f.patch).map((f) => f.kind))
  const out = []
  // soft: woken by a keyword match alone. Keywords misfire (a regex or a string that merely mentions "ALTER TABLE"), so
  // the brief agent, which has read the diff, may veto these — never the core lenses.
  const add = (key, why, focusFiles = null, soft = false) => out.push({ key, why, focus: focusFiles && focusFiles.length ? focusFiles : null, soft })

  const docsOnly = ctx.files.filter((f) => f.patch).every((f) => f.kind === 'docs')
  if (tier === 'trivial' && !docsOnly) add('quick-scan', 'trivial change: one combined pass')
  else if (hasCode) add('correctness', 'code changed')

  const secSignals = ['auth', 'crypto', 'money', 'injection', 'sql', 'secrets', 'ci']
  if (has(...secSignals)) add('security', `signals: ${secSignals.filter((n) => sig[n]).join(', ')}`, rank >= 2 ? null : focus(...secSignals))
  else if (hasCode && rank >= 2) add('security', 'medium+ code change')
  if (hasCode && rank >= 2) add('errors', 'medium+ code change')
  else if (has('error_handling') && rank >= 1) add('errors', 'error-handling code touched', focus('error_handling'), true)
  if (rank >= 1 && (kinds.has('test') || has('tests_removed') || hasCode)) add('tests', kinds.has('test') ? 'tests changed' : 'code changed; check it is tested')
  if (rank >= 3 && hasCode) add('performance', 'large code change')
  else if (has('perf', 'sql') && rank >= 2) add('performance', 'performance-sensitive patterns', focus('perf', 'sql'), true)
  // Money moved through a database is where check-then-act races live (balance read, then debit). That is domain knowledge,
  // not a keyword guess, so the concurrency lens is woken here as a core lens (not `soft`): whether such a race gets
  // looked for must not depend on the brief agent happening to ask for the lens.
  if ((has('money') && has('sql', 'transactions') && rank >= 1) || (has('transactions') && rank >= 2)) add('concurrency', 'money or transactional state changed through a database: check-then-act races')
  else if (has('concurrency') && rank >= 1) add('concurrency', 'concurrency primitives touched', focus('concurrency'), true)
  if (has('public_api') && rank >= 1) add('api-compat', 'public surface touched', focus('public_api'), true)
  // (Money + SQL without any schema change does not wake this lens: that case is a race question, not a migration
  // question, and under a small lens cap it would crowd out the concurrency lens that covers it.)
  if (has('migration', 'schema')) add('data-migrations', 'schema/migration/data changes', focus('migration', 'schema', 'sql'), !has('migration')) // a real migration file is not a keyword guess
  if (has('types') && rank >= 2) add('types', 'new or changed type declarations', focus('types'), true)
  if (hasCode && rank >= 2) add('maintainability', 'medium+ code change')
  if (kinds.has('docs') || rank >= 2) add('docs-comments', kinds.has('docs') ? 'docs changed' : 'check comments match code')
  if (ctx.conventions.length && hasCode && rank >= 1) add('conventions', `convention docs present (${ctx.conventions.map((c) => c.path).slice(0, 3).join(', ')})`)
  if (has('deps')) add('dependencies', 'dependency manifests changed')
  if (has('ci', 'infra') || (kinds.has('config') && rank >= 1)) add('infra-config', 'CI/infra/config changed', null, !has('ci', 'infra'))
  if (!out.length) add('quick-scan', 'nothing specific triggered: one combined pass')
  return out
}

function filesForLens(w, reviewable) {
  const byKind = (...k) => reviewable.filter((f) => k.includes(f.kind))
  switch (w.key) {
    case 'quick-scan': return reviewable // the one combined pass: docs and config included
    case 'dependencies': return byKind('deps')
    case 'infra-config': return byKind('ci', 'infra', 'config')
    case 'conventions': case 'maintainability': case 'types': case 'concurrency': case 'performance':
      return w.focus ? reviewable.filter((f) => w.focus.includes(f.path)) : reviewable.filter((f) => CODE.has(f.kind) || f.kind === 'test')
    case 'tests': return reviewable.filter((f) => CODE.has(f.kind) || f.kind === 'test')
    case 'docs-comments': return reviewable.filter((f) => f.kind === 'docs' || CODE.has(f.kind))
    case 'hygiene': // the union of what its parts would have read (each part keeps its own focus); everything when asked for outright
      return w.parts ? reviewable.filter((f) => w.parts.some((p) => filesForLens(p, reviewable).includes(f))) : reviewable.filter((f) => f.kind === 'docs' || f.kind === 'test' || CODE.has(f.kind))
    default:
      return w.focus ? reviewable.filter((f) => w.focus.includes(f.path)) : reviewable.filter((f) => !['docs'].includes(f.kind))
  }
}

// Keep files from the same directory together so a shard is a coherent slice of the change.
function binPack(files, maxEff) {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path))
  const total = sorted.reduce((n, f) => n + f.eff, 0)
  if (total <= maxEff * 1.3) return [sorted]
  const bins = [[]]
  let size = 0
  for (const f of sorted) {
    if (size && size + f.eff > maxEff) { bins.push([]); size = 0 }
    bins[bins.length - 1].push(f); size += f.eff
  }
  return bins
}

// --no-critical-upgrade keeps the core lenses on the profile's ordinary model: for comparison runs of your own that ask
// whether the stronger model earns its price on a given change (the plan records it as variant "no-critical-upgrade",
// and `prr stats` lists benchmark scores per variant).
function modelFor(profile, lens, tier, ctx, args = {}) {
  const lm = profile.lens_model
  let model = (lm.overrides && lm.overrides[lens]) || (lm.by_tier && lm.by_tier[tier]) || lm.default
  const up = args.no_critical_upgrade ? null : profile.critical_upgrade
  const tierOk = !up || !up.min_tier || TIERS.indexOf(tier) >= TIERS.indexOf(up.min_tier)
  if (up && tierOk && ctx.stats.critical.length && (up.lenses.includes(lens) || lens === 'quick-scan') && MODEL_RANK[up.model] > MODEL_RANK[model]) model = up.model
  return model
}

// Agent counts are exact for lenses and chores and a guess for verification (it depends on how many findings the lenses
// raise). Tokens and cost come per size unit from calibration() in lib/metrics.mjs: the average from the user's own
// metrics log for every agent kind with 3+ measured agents there, built-in rough starting values (at the list prices in
// pricing.json) for the rest. Each agent's figure is then scaled by how much it has to read (lensSizeFactor /
// verifySizeFactor), because a flat per-agent price under-estimates large changes. The shares assumed below (35% of
// candidates are blockers, 40% of blockers escalate, ...) are guesses that only shape the estimate, never the review.
function estimate(p, totalEff) {
  const by = { haiku: 0, sonnet: 0, opus: 0 }
  const cal = calibration()
  let tokens = 0, cost = 0
  const count = (stage, model, n = 1, factor = 1) => { by[model] = (by[model] || 0) + n; const per = cal.perUnit(stage, model); tokens += per.tokens * n * factor; cost += per.cost * n * factor }
  // Nothing runs when no lens runs (the engine is never started): no agents, no cost — not "1 agent for $0".
  if (!p.lens_tasks.length) return { agents: by, total: 0, tokens: 0, cost: 0, note: 'no lens will run' }
  for (const t of p.lens_tasks) count('lens', t.model, 1, lensSizeFactor(t.eff))
  for (const k of ['brief', 'merge', 'dedupe']) if (p.chores[k]) count('chore', p.chores.model)
  if (p.chores.followup) count('chore', p.chores.followup_model)
  const afterLenses = { tokens, cost }
  const guessCandidates = Math.min(p.max_candidates, Math.max(2, Math.round(p.lens_tasks.length * 1.3)))
  const red = Math.ceil(guessCandidates * 0.35), yellow = guessCandidates - red
  // With escalation only the first stance always runs; assume the others are needed for ~40% of blockers (a guess).
  // Reading-only verification — forks, --no-tests — can never prove a finding by running code, so it always escalates.
  const later = p.verify.escalate && p.verify.run_tests !== 'no' ? 0.4 : 1
  p.verify.red.forEach(([, m], i) => count('verify', m, i === 0 ? red : Math.round(red * later * 10) / 10, verifySizeFactor(totalEff)))
  // Should-fix findings: some are rated a nit by their lens and never verified (assume 15%); where the profile names a
  // cheaper verifier for low-stakes categories, assume half of the rest go there.
  const verifiedYellow = yellow * ((p.thresholds.verify_min_importance ?? p.thresholds.min_importance) > 0 ? 0.8 : 1)
  const lowShare = p.verify.yellow_low_stakes ? 0.5 : 0
  for (const [, m] of p.verify.yellow) count('verify', m, Math.round(verifiedYellow * (1 - lowShare) * 10) / 10, verifySizeFactor(totalEff))
  for (const [, m] of p.verify.yellow_low_stakes || []) count('verify', m, Math.round(verifiedYellow * lowShare * 10) / 10, verifySizeFactor(totalEff))
  if (p.critic) count('chore', p.critic.model, 1 + 2)
  for (const k of Object.keys(by)) by[k] = Math.round(by[k]) // expected values can be fractional; show whole agents
  return { agents: by, total: by.haiku + by.sonnet + by.opus, tokens: Math.round(tokens), cost: Math.round(cost * 100) / 100, floor: { tokens: Math.round(afterLenses.tokens), cost: Math.round(afterLenses.cost * 100) / 100 },
    orchestrator: cal.orchestrator, calibrated_on_runs: cal.runs, measured_kinds: cal.measuredKinds, note: `verification estimated for ~${guessCandidates} candidate findings` }
}

function printPlan(ctx, p) {
  const L = []
  L.push(`PLAN profile=${p.profile} (${p.profile_label}) · tier=${p.tier} — ${p.tier_reason}`)
  const byLens = {}
  for (const t of p.lens_tasks) (byLens[t.lens] ||= { model: t.model, n: 0 }).n++
  L.push('Lenses: ' + p.lenses.map((l) => `${l.key}[${byLens[l.key].model}${byLens[l.key].n > 1 ? ` ×${byLens[l.key].n}` : ''}]`).join(', '))
  for (const l of p.lenses) L.push(`  - ${l.key}: ${l.why}${l.focus ? ' (focused on triggering files)' : ''}${l.soft ? ' [keyword-woken: the brief agent may drop it]' : ''}`)
  if (p.optional_lens_tasks.length) L.push(`On standby (the brief agent may add up to 2): ${Array.from(new Set(p.optional_lens_tasks.map((t) => t.lens))).join(', ')}`)
  if (p.skipped.length) L.push('Skipped: ' + p.skipped.map((s) => `${s.lens} (${s.reason})`).join('; '))
  // Agent count is not simply "lenses": each lens is split into shards, and shards get coarser only when the profile's
  // agent budget would be exceeded. Say so, because dropping a lens can free budget for finer shards and RAISE the count.
  const lensCount = Object.keys(byLens).length
  if (p.lens_tasks.length > lensCount || p.sharding.coarsened > 1 || p.lens_tasks.length > p.sharding.max_lens_agents) L.push(`Shards: ${p.lens_tasks.length} lens agents for ${lensCount} lenses, each reading up to ~${p.sharding.largest_shard} effective lines${p.lens_tasks.length > p.sharding.max_lens_agents ? ` (OVER the profile's budget of ${p.sharding.max_lens_agents} lens agents even with shards ${p.sharding.coarsened}x coarser: lenses asked for by name always run — name fewer, or pick a bigger profile)` : p.sharding.coarsened > 1 ? ` (shards made ${p.sharding.coarsened}x coarser to stay within the profile's ${p.sharding.max_lens_agents} lens agents; fewer lenses = finer shards, not necessarily fewer agents)` : ` (budget: ${p.sharding.max_lens_agents} lens agents; adding lenses may coarsen shards, removing them never makes shards finer than ${p.sharding.shard_lines} lines)`}`)
  const v = (pairs) => pairs.map(([s, m]) => `${s}:${m}`).join(' + ')
  L.push(`Verify: red → ${p.verify.escalate && p.verify.red.length > 1 ? `${v(p.verify.red.slice(0, 1))} first, then ${v(p.verify.red.slice(1))} unless proven by running code` : v(p.verify.red)} · yellow → ${v(p.verify.yellow)}${p.verify.yellow_low_stakes ? ` (housekeeping and self-rated minor findings: ${v(p.verify.yellow_low_stakes)}${p.thresholds.verify_min_importance > 0 ? `; self-rated under ${p.thresholds.verify_min_importance}: listed unverified` : ''})` : ''} · tiebreak: ${p.verify.tiebreak || 'none'} · run tests: ${p.verify.run_tests}`)
  L.push(`Chores (${p.chores.model}): ${['brief', 'merge', 'dedupe', 'followup'].filter((k) => p.chores[k]).map((k) => (k === 'followup' ? `followup[${p.chores.followup_model}]` : k)).join(', ') || 'none'}${p.critic ? ` · completeness critic: ${p.critic.model} ×${p.critic.max_rounds}` : ''}`)
  L.push(`Estimate: ~${p.estimate.total} sub-agents (haiku ${p.estimate.agents.haiku} / sonnet ${p.estimate.agents.sonnet} / opus ${p.estimate.agents.opus}); ${p.estimate.note}`)
  if (p.estimate.floor) L.push(`Estimated spend: ~${fmtTokens(p.estimate.tokens)} tokens ≈ ${fmtCost(p.estimate.cost)} at API list prices if findings need verifying; ~${fmtTokens(p.estimate.floor.tokens)} ≈ ${fmtCost(p.estimate.floor.cost)} if the change is clean (mostly cheap cache reads; scaled by how much each agent has to read; ${p.estimate.measured_kinds ? `per-agent costs averaged from your own ${p.estimate.calibrated_on_runs} logged run(s) for agent kinds with 3+ measured agents, built-in rough averages for the rest` : 'built-in rough averages until your own runs are logged'}; orchestrator turns not included)`)
  // The estimate above covers sub-agents only. The orchestrator re-reads the whole conversation on every turn, so in a
  // long session its share can exceed everything else on a small review — say so before the user starts a big one here.
  if (p.estimate.orchestrator && p.estimate.orchestrator.n >= 3) L.push(`Orchestrator turns are extra: ≈ ${fmtCost(p.estimate.orchestrator.median)} per review in your recent sessions (every orchestrator turn re-reads the conversation the review was started from, so this grows with its length; a fresh session keeps it low).`)
  if (!p.lens_tasks.length) L.push('WARNING: NO LENS WILL RUN — nothing in this change matched a reviewable file for any lens. Do not start the engine; tell the user, or re-plan with --lenses <key>.')
  L.push(`Orchestrator: this profile is tuned for a ${p.recommended_orchestrator} orchestrator (the skill frontmatter decides what actually runs).`)
  if (process.env.CLAUDE_CODE_SUBAGENT_MODEL) L.push(`WARNING: CLAUDE_CODE_SUBAGENT_MODEL=${process.env.CLAUDE_CODE_SUBAGENT_MODEL} is set; it may override the per-agent models this plan relies on.`)
  if (p.needs_confirmation && !p.confirmed) {
    L.push(`CONFIRM_SPEND: ${p.needs_confirmation}. Tell the user the estimate above and ASK before starting; when they agree, run this plan command again with --confirmed (it then prints the engine arguments). A cheaper option to offer: a leaner --profile, or fewer lenses.`)
  } else L.push(`WORKFLOW_SCRIPT=${ctx.skill_dir}/workflows/review.workflow.js`, `WORKFLOW_ARGS=${JSON.stringify(p.workflow_args)}`)
  console.log(L.join('\n'))
}
