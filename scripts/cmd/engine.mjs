// prr merge / aggregate / ingest — the glue between agent outputs and results.json.
//   ingest     Workflow engine: pull the workflow's return value out of its task output file.
//   merge      Agent-tool engine: validate lens outputs, dedupe, write verify tasks.
//   aggregate  Agent-tool engine: fold verifier verdicts into confidence-ranked results.
import fs from 'node:fs'
import path from 'node:path'
import { UserError, parseArgs, readJson, requireRun, stripBom, truncate, writeJson, writeText } from '../lib/util.mjs'
import { aggregateVerdicts, applyLensAdvice, applyMergeGroups, capCandidates, dedupeFindings, finalizeFinding, lensUsable, needsTiebreak, settledEarly, skipsVerification, stancesFor, unverifiedMinor, verifyWaves } from '../lib/core.mjs'
import { verifyTask } from '../lib/tasks.mjs'

const load = (runDir) => ({ ctx: readJson(path.join(runDir, 'context.json')), plan: readJson(path.join(runDir, 'plan.json')) })

// Agents are told to write bare JSON, but tolerate a fenced block or stray prose around it.
function readAgentJson(file) {
  if (!fs.existsSync(file)) return null
  const text = stripBom(fs.readFileSync(file, 'utf8')).trim()
  for (const candidate of [text, (text.match(/```(?:json)?\s*([\s\S]*?)```/) || [])[1], text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)]) {
    if (!candidate) continue
    try { return JSON.parse(candidate) } catch { /* try next */ }
  }
  return null
}

export function ingest(argv) {
  const args = parseArgs(argv)
  const runDir = requireRun(args)
  if (!args.from) throw new UserError('Missing --from <workflow task output file>')
  const raw = readAgentJson(path.resolve(args.from))
  if (!raw) throw new UserError(`Could not parse JSON from ${args.from}. Write the workflow's returned object to ${path.join(runDir, 'results.json')} yourself, then run render.`)
  const result = [raw.result, raw.output, raw].find((r) => r && typeof r === 'object' && Array.isArray(r.findings) && Array.isArray(r.lens_runs))
  if (!result) throw new UserError('That file does not contain a pr-review workflow result (no findings/lens_runs). If the workflow failed, read its logs; if it returned elsewhere, write the returned object to results.json manually.')
  result.engine = 'workflow'
  writeJson(path.join(runDir, 'results.json'), result)
  writeJson(path.join(runDir, 'workflow-output.json'), { file: path.resolve(args.from) }) // coarse usage fallback if transcripts are not found
  console.log(`Ingested workflow result: ${result.findings.length} verified finding(s), ${result.lens_runs.length} lens run(s). NEXT: prr render --run "${runDir.split(path.sep).join('/')}"`)
}

// Which lens agents to start: the plan's list, corrected by the brief agent's lens advice (brief.result.json), if any.
function effectiveLenses(runDir, plan) {
  const brief = readAgentJson(path.join(runDir, 'brief.result.json'))
  return applyLensAdvice(plan.lens_tasks, plan.optional_lens_tasks || [], brief && brief.lens_advice)
}

export function lenses(argv) {
  const args = parseArgs(argv)
  const runDir = requireRun(args)
  const { ctx, plan } = load(runDir)
  if (plan.needs_confirmation && !plan.confirmed) throw new UserError(`This plan is waiting for the user's OK (${plan.needs_confirmation}). Ask them, then run \`prr plan --run "${ctx.run_dir}" … --confirmed\`.`, { code: 9 })
  const eff = effectiveLenses(runDir, plan)
  const L = []
  for (const d of eff.dropped) L.push(`Dropped by the brief agent: ${d.lens} — ${d.why}`)
  for (const a of eff.added) L.push(`Added by the brief agent: ${a.lens} — ${a.why}`)
  L.push('Spawn these lens agents in parallel (one Agent call each, all in one message), prompt = "Read the file <task> and follow it exactly.":')
  for (const t of eff.tasks) L.push(`LENS ${t.shard} model=${t.model} task=${ctx.run_dir}/${t.task}`)
  L.push(`THEN: prr merge --run "${ctx.run_dir}"`)
  console.log(L.join('\n'))
}

export function merge(argv) {
  const args = parseArgs(argv)
  const runDir = requireRun(args)
  const { ctx, plan } = load(runDir)

  const lensRuns = [], lensResults = [], problems = []
  const lensPlan = effectiveLenses(runDir, plan)
  writeJson(path.join(runDir, 'lens-changes.json'), { dropped: lensPlan.dropped, added: lensPlan.added })
  const tasks = [...lensPlan.tasks]
  for (const f of fs.readdirSync(path.join(runDir, 'lens')).filter((n) => /^gap-\d+\.json$/.test(n))) tasks.push({ lens: 'critic-gap', shard: f.replace('.json', ''), model: plan.critic ? plan.critic.model : '', file: f })
  for (const t of tasks) {
    const file = path.join(runDir, 'lens', t.file || `${t.shard}.json`)
    const data = readAgentJson(file)
    const ok = lensUsable(data)
    if (!ok) problems.push(`${t.shard}: ${!fs.existsSync(file) ? 'no output file' : data && Array.isArray(data.findings) ? `the agent reported partial coverage and no findings ("${truncate(data.notes || '', 120)}") — it probably balked or got lost` : 'output is not valid JSON with a findings array'} (${file})`)
    lensRuns.push({ lens: t.lens, shard: t.shard, model: t.model, ok, raised: ok ? data.findings.length : 0, notes: truncate((data && data.notes) || '', 400), coverage: ok ? data.coverage || 'full' : 'none' })
    if (ok) lensResults.push({ lens: t.lens, findings: data.findings })
  }
  const merged = dedupeFindings(lensResults)
  // merge can run more than once (after the dedupe chore, after critic gap-fills): keep ids stable so verdict files
  // written for an earlier pass still belong to the same finding.
  const previous = readJson(path.join(runDir, 'candidates.json'), [])
  if (previous.length) {
    const key = (f) => `${f.path}\n${f.line}\n${f.title}`
    const old = new Map(previous.map((f) => [key(f), f.id]))
    let next = Math.max(0, ...previous.map((f) => Number(String(f.id).replace(/\D/g, '')) || 0))
    for (const f of merged) f.id = old.get(key(f)) || 'F' + String(++next).padStart(2, '0')
  }
  let { kept, dropped } = capCandidates(merged, plan.max_candidates, plan.thresholds)
  // Same root cause from two lenses: one cheap agent groups them before verification is paid for twice.
  const wantMerge = plan.chores.merge && kept.length >= (plan.chores.merge.min_candidates || 5)
  const mergeFile = path.join(runDir, 'merge.json')
  if (wantMerge && fs.existsSync(mergeFile)) {
    const m = readAgentJson(mergeFile)
    const before = kept.length
    if (m) kept = applyMergeGroups(kept, m.groups)
    if (kept.length < before) console.log(`Merged ${before - kept.length} candidate(s) into another with the same root cause.`)
  }
  writeJson(path.join(runDir, 'lens-runs.json'), lensRuns)
  writeJson(path.join(runDir, 'candidates.json'), kept)
  writeJson(path.join(runDir, 'dropped.json'), dropped.map((f) => ({ title: f.title, path: f.path, line: f.line, severity: f.severity, reason: `over max_candidates (${plan.max_candidates})` })))

  const L = [`Lens outputs: ${lensRuns.filter((r) => r.ok).length}/${lensRuns.length} ok · raised ${lensRuns.reduce((n, r) => n + r.raised, 0)} → ${merged.length} after merge → ${kept.length} candidates${dropped.length ? ` (${dropped.length} lowest-priority dropped by the profile cap — reported, not hidden)` : ''}`]
  for (const p of problems) L.push(`PROBLEM: ${p} — re-run that lens agent once; if it fails again continue without it (it will show as ⚪ did-not-run).`)

  const needMerge = wantMerge && !fs.existsSync(mergeFile)
  const needDedupe = plan.chores.dedupe && kept.length && !fs.existsSync(path.join(runDir, 'dedupe.json'))
  if (needMerge || needDedupe) {
    L.push(`NEXT: spawn ${needMerge && needDedupe ? 'these TWO agents in parallel' : 'ONE agent'} on ${plan.chores.model}, then run merge again:`)
    if (needMerge) L.push(`  "Read and follow ${ctx.run_dir}/tasks/merge.md. Candidates are in ${ctx.run_dir}/candidates.json."`)
    if (needDedupe) L.push(`  "Read and follow ${ctx.run_dir}/tasks/dedupe.md. Candidates are in ${ctx.run_dir}/candidates.json."`)
    console.log(L.join('\n'))
    return
  }
  const ddRead = readAgentJson(path.join(runDir, 'dedupe.json'))
  if (plan.chores.dedupe && kept.length && !ddRead) L.push(`PROBLEM: ${ctx.run_dir}/dedupe.json is not valid JSON — delete it and re-run the dedupe agent once (merge will ask again); if it fails again, continue: the report will say the duplicate check did not run.`)
  const dd = ddRead || { covered: [], reintroduced: [] }
  const covered = new Set((dd.covered || []).map((c) => c.id))
  const toVerify = kept.filter((f) => !covered.has(f.id))
  if (covered.size) L.push(`Already covered by existing comments / earlier reviews: ${Array.from(covered).join(', ')} (skipping verification)`)

  const verifyLines = []
  const nits = toVerify.filter((f) => skipsVerification(f, plan.thresholds))
  if (nits.length) L.push(`Not verified: ${nits.map((f) => f.id).join(', ')} — should-fix findings their own lens rates a nit; they will be listed as minor.`)
  for (const f of toVerify.filter((x) => !skipsVerification(x, plan.thresholds))) {
    // Escalating verification: blockers get their first stance now; `aggregate` asks for the rest only if it is needed.
    for (const [stance, model] of verifyWaves(stancesFor(f, plan.verify, plan.thresholds), f.severity, plan.verify.escalate).first) {
      if (fs.existsSync(path.join(runDir, 'verdicts', `${f.id}-${stance}.json`))) continue // verified in an earlier pass
      const rel = `tasks/verify-${f.id}-${stance}.md`
      writeText(path.join(runDir, rel), verifyTask(ctx, f, stance, `${ctx.run_dir}/verdicts/${f.id}-${stance}.json`))
      verifyLines.push(`VERIFY ${f.id} ${f.severity} model=${model} task=${ctx.run_dir}/${rel}`)
    }
  }
  L.push(verifyLines.length ? 'NEXT: spawn these verifier agents in parallel (one Agent call each, all in one message), prompt = "Read the file <task> and follow it exactly.":' : 'Nothing (new) to verify.')
  L.push(...verifyLines, `THEN: prr aggregate --run "${ctx.run_dir}"`)
  console.log(L.join('\n'))
}

export function aggregate(argv) {
  const args = parseArgs(argv)
  const runDir = requireRun(args)
  const { ctx, plan } = load(runDir)
  const candidates = readJson(path.join(runDir, 'candidates.json'), null)
  if (!candidates) throw new UserError('No candidates.json — run `prr merge` first.')
  const dd = readAgentJson(path.join(runDir, 'dedupe.json')) || { covered: [], reintroduced: [] }
  const coveredBy = new Map((dd.covered || []).map((c) => [c.id, c]))
  const reintro = new Map((dd.reintroduced || []).map((c) => [c.id, c]))

  const findings = [], covered = [], pendingTiebreaks = [], pendingEscalations = []
  for (const f of candidates) {
    if (coveredBy.has(f.id)) { covered.push({ id: f.id, title: f.title, path: f.path, line: f.line, by: coveredBy.get(f.id).by, why: coveredBy.get(f.id).why }); continue }
    if (skipsVerification(f, plan.thresholds)) { findings.push(unverifiedMinor(f)); continue }
    const stances = stancesFor(f, plan.verify, plan.thresholds)
    const readVote = ([stance, model]) => {
      const v = readAgentJson(path.join(runDir, 'verdicts', `${f.id}-${stance}.json`))
      return v ? { ...v, stance, model } : null
    }
    // The first verifier could not prove the blocker by running code: the remaining stances are needed after all.
    const { first, rest } = verifyWaves(stances, f.severity, plan.verify.escalate)
    const escalate = rest.length > 0 && !settledEarly(first.map(readVote))
    if (escalate && !args.skip_escalation) {
      for (const [stance, model] of rest) {
        if (fs.existsSync(path.join(runDir, 'verdicts', `${f.id}-${stance}.json`))) continue
        const rel = `tasks/verify-${f.id}-${stance}.md`
        writeText(path.join(runDir, rel), verifyTask(ctx, f, stance, `${ctx.run_dir}/verdicts/${f.id}-${stance}.json`))
        pendingEscalations.push(`VERIFY ${f.id} ${f.severity} model=${model} task=${ctx.run_dir}/${rel}`)
      }
    }
    const verdicts = (escalate ? stances : first).map(readVote)
    let tb = readAgentJson(path.join(runDir, 'verdicts', `${f.id}-tiebreak.json`))
    if (tb) tb = { ...tb, stance: 'tiebreak', model: plan.verify.tiebreak }
    const agg = aggregateVerdicts(f, verdicts, plan.thresholds, tb)
    if (!tb && plan.verify.tiebreak && needsTiebreak(aggregateVerdicts(f, verdicts, plan.thresholds), f)) {
      const rel = `tasks/verify-${f.id}-tiebreak.md`
      const withVotes = { ...f, earlier_verdicts: verdicts.filter(Boolean).map((v) => ({ stance: v.stance, verdict: v.verdict, confidence: v.confidence, evidence: v.evidence })) }
      writeText(path.join(runDir, rel), verifyTask(ctx, withVotes, 'tiebreak', `${ctx.run_dir}/verdicts/${f.id}-tiebreak.json`))
      pendingTiebreaks.push(`VERIFY ${f.id} red model=${plan.verify.tiebreak} task=${ctx.run_dir}/${rel}`)
    }
    findings.push(finalizeFinding(f, agg, [tb, ...verdicts], reintro.has(f.id)))
  }
  if (pendingEscalations.length) {
    console.log(['Blocking finding(s) the first verifier could not prove by running code need the remaining stances. NEXT: spawn in parallel, prompt = "Read the file <task> and follow it exactly.":', ...pendingEscalations, `THEN: prr aggregate --run "${ctx.run_dir}"   (add --skip-escalation to proceed on the first verdict alone — not recommended for blockers)`].join('\n'))
    return
  }
  if (pendingTiebreaks.length && !args.skip_tiebreak) {
    console.log(['Contested blocking finding(s) need a tiebreak. NEXT: spawn in parallel, prompt = "Read and follow <task>":', ...pendingTiebreaks, `THEN: prr aggregate --run "${ctx.run_dir}"   (add --skip-tiebreak to proceed without)`].join('\n'))
    return
  }

  const lensRuns = readJson(path.join(runDir, 'lens-runs.json'), [])
  const followup = readAgentJson(path.join(runDir, 'followup.json'))
  const brief = readAgentJson(path.join(runDir, 'brief.result.json'))
  // A planned chore whose output is missing or unreadable is reported, not passed off as "nothing found".
  const choresFailed = []
  if (plan.chores.dedupe && candidates.length && !readAgentJson(path.join(runDir, 'dedupe.json'))) choresFailed.push('dedupe')
  if (plan.chores.followup && !(followup && Array.isArray(followup.items))) choresFailed.push('followup')
  if (fs.existsSync(path.join(runDir, 'merge.json')) && !readAgentJson(path.join(runDir, 'merge.json'))) choresFailed.push('merge')
  if (plan.chores.brief && !brief) choresFailed.push('brief')
  // The critic runs after the first aggregate (stage 6) and aggregate runs again after it; until its file exists the
  // truthful statement about this review is "no critic has looked at it".
  const criticMissing = !!plan.critic && !readAgentJson(path.join(runDir, 'critic.json'))
  if (criticMissing) choresFailed.push('critic')
  const results = { v: 1, engine: 'agents', lens_runs: lensRuns, findings, covered, dropped: readJson(path.join(runDir, 'dropped.json'), []),
    followup: followup && Array.isArray(followup.items) ? followup.items : [], chores_failed: choresFailed, lens_changes: readJson(path.join(runDir, 'lens-changes.json'), { dropped: [], added: [] }), brief: brief || null }
  writeJson(path.join(runDir, 'results.json'), results)
  const n = (band) => findings.filter((f) => f.band === band).length
  console.log(`Aggregated ${findings.length} finding(s): high=${n('high')} medium=${n('medium')} low=${n('low')} · covered=${covered.length}. NEXT: prr render --run "${ctx.run_dir}"`)
}
