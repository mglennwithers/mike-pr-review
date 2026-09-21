export const meta = {
  name: 'pr-review',
  description: 'Multi-lens code review: lens agents -> dedupe -> adversarial verification -> confidence-ranked findings',
  whenToUse: 'Started by the pr-review skill with the WORKFLOW_ARGS object printed by `prr plan`. Not meant to be run by hand.',
  phases: [
    { title: 'Brief', detail: 'cheap model summarises what the change is for' },
    { title: 'Lenses', detail: 'one reviewer per lens x shard, models per budget profile' },
    { title: 'Dedupe', detail: 'drop findings already raised on the PR or dismissed earlier' },
    { title: 'Verify', detail: 'adversarial verifiers try to refute or reproduce each finding' },
    { title: 'Critic', detail: 'completeness check and targeted follow-ups (only when the profile enables the critic)' },
  ],
}

// GENERATED FILE — edit workflows/review.workflow.template.js or scripts/lib/core.mjs, then run `node scripts/prr.mjs build-workflow`.

/*__CORE__*/

// ---- schemas ----------------------------------------------------------------------------------------------------------
const FINDINGS_SCHEMA = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' }, line: { type: 'integer' }, end_line: { type: 'integer' }, anchor: { type: 'string' },
          severity: { type: 'string', enum: ['red', 'yellow'] }, category: { type: 'string' }, title: { type: 'string' },
          body: { type: 'string' }, scenario: { type: 'string' }, evidence: { type: 'string' }, suggestion: { type: 'string' },
          test_idea: { type: 'string' }, self_confidence: { type: 'number' }, self_importance: { type: 'number' },
        },
        required: ['path', 'line', 'anchor', 'severity', 'title', 'body', 'self_confidence'],
      },
    },
    notes: { type: 'string' },
    coverage: { type: 'string', enum: ['full', 'partial'] },
  },
  required: ['findings', 'notes'],
}
const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    finding_id: { type: 'string' }, stance: { type: 'string' },
    verdict: { type: 'string', enum: ['confirmed', 'refuted', 'uncertain'] },
    confidence: { type: 'number' },
    importance: { type: 'number' },
    introduced_by_change: { type: 'string', enum: ['yes', 'no', 'unknown'] },
    severity: { type: 'string', enum: ['red', 'yellow', 'drop'] },
    reproduced: { type: 'boolean' },
    test: { type: 'object', properties: { ran: { type: 'boolean' }, command: { type: 'string' }, outcome: { type: 'string' } }, required: ['ran'] },
    line: { type: 'integer' }, suggestion_ok: { type: 'boolean' }, evidence: { type: 'string' },
  },
  required: ['verdict', 'confidence', 'introduced_by_change', 'severity', 'reproduced', 'evidence'],
}
const LENS_REF = { type: 'array', items: { type: 'object', properties: { lens: { type: 'string' }, why: { type: 'string' } }, required: ['lens'] } }
const BRIEF_SCHEMA = { type: 'object', properties: { summary: { type: 'string' }, hot_spots: { type: 'array', items: { type: 'string' } }, lens_advice: { type: 'object', properties: { drop: LENS_REF, add: LENS_REF } } }, required: ['summary'] }
const MERGE_SCHEMA = { type: 'object', properties: { groups: { type: 'array', items: { type: 'object', properties: { keep: { type: 'string' }, merge: { type: 'array', items: { type: 'string' } }, why: { type: 'string' } }, required: ['keep', 'merge'] } } }, required: ['groups'] }
const REF = { type: 'object', properties: { id: { type: 'string' }, by: { type: 'string' }, why: { type: 'string' } }, required: ['id'] }
const DEDUPE_SCHEMA = { type: 'object', properties: { covered: { type: 'array', items: REF }, reintroduced: { type: 'array', items: REF } }, required: ['covered'] }
const FOLLOWUP_SCHEMA = {
  type: 'object',
  properties: { items: { type: 'array', items: { type: 'object', properties: { fp: { type: 'string' }, status: { type: 'string', enum: ['addressed', 'still_open', 'partially', 'unclear'] }, note: { type: 'string' } }, required: ['fp', 'status'] } } },
  required: ['items'],
}
const CRITIC_SCHEMA = {
  type: 'object',
  properties: { gaps: { type: 'array', items: { type: 'object', properties: { lens: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } }, question: { type: 'string' } }, required: ['question'] } } },
  required: ['gaps'],
}

// ---- setup ------------------------------------------------------------------------------------------------------------
const A = typeof args === 'string' ? JSON.parse(args) : args
if (!A || !A.run || !A.skill || !Array.isArray(A.lens_tasks) || !A.verify) {
  throw new Error('pr-review workflow needs the WORKFLOW_ARGS object printed by `prr plan` as its args')
}
// Workflow sub-agents are shown the user's original request next to this computed task. Say how the two relate, so a
// careful agent does not mistake a pipeline step for an unrelated instruction and decline it.
const CONTEXT = 'Context: this task was generated by the pr-review skill\'s planner. It is one step of an automated code review that was started in the orchestrating session; the task file says exactly what this step is.'
const follow = (rel, extra) => `Read the file ${A.run}/${rel} and follow it exactly.\n\n${CONTEXT}${extra ? '\n\n' + extra : ''}`
// Output tokens are priced at five times input tokens (pricing.json), and an agent that reasons at length writes far more
// of them than its findings need. The profile may therefore set a reasoning effort per stage; a stage it does not name
// inherits the session's.
const effort = (stage) => (A.effort && A.effort[stage] ? { effort: A.effort[stage] } : {})
const slim = (f) => ({ id: f.id, path: f.path, line: f.line, severity: f.severity, category: f.category, title: f.title, body: f.body.slice(0, 300) })

// ---- Brief (+ follow-up on earlier findings, which needs nothing from this run) ------------------------------------------
phase('Brief')
// A chore that fails is retried once; if it fails again the report says so instead of passing off "no answer" as "nothing found".
const choresFailed = []
const chore = async (name, make) => {
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await make().catch(() => null)
    if (r) return r
    log(`chore ${name}: no usable result (attempt ${attempt} of 2)`)
  }
  choresFailed.push(name)
  return null
}
const followupP = A.chores.followup
  ? chore('followup', () => agent(follow('tasks/followup.md'), { label: 'chore:followup', phase: 'Brief', model: A.chores.followup_model || A.chores.model, schema: FOLLOWUP_SCHEMA }))
  : Promise.resolve(null)
const brief = A.chores.brief
  ? await chore('brief', () => agent(follow('tasks/brief.md'), { label: 'chore:brief', phase: 'Brief', model: A.chores.model, schema: BRIEF_SCHEMA, ...effort('chore') }))
  : null

// ---- Lenses -----------------------------------------------------------------------------------------------------------
phase('Lenses')
const lensRuns = []
async function runLenses(tasks, phaseName) {
  const once = (t) => agent(t.prompt || follow(t.task), { label: `lens:${t.shard}`, phase: phaseName, model: t.model, schema: FINDINGS_SCHEMA, ...effort('lens') })
  let out = await parallel(tasks.map((t) => () => once(t)))
  const failed = tasks.map((t, i) => (lensUsable(out[i]) ? null : i)).filter((i) => i !== null)
  if (failed.length) {
    log(`${failed.length} lens agent(s) returned nothing usable; retrying once`)
    const again = await parallel(failed.map((i) => () => once(tasks[i])))
    failed.forEach((i, k) => { out[i] = again[k] })
  }
  const results = []
  tasks.forEach((t, i) => {
    const r = out[i]
    const ok = lensUsable(r)
    lensRuns.push({ lens: t.lens, shard: t.shard, model: t.model, ok, raised: ok ? r.findings.length : 0, notes: String((r && r.notes) || '').slice(0, 400), coverage: ok ? r.coverage || 'full' : 'none' })
    if (ok) results.push({ lens: t.lens, findings: r.findings })
  })
  return results
}
// The brief agent has read the diff: let it veto keyword-woken lenses and add up to two the keywords missed.
const lensPlan = applyLensAdvice(A.lens_tasks, A.optional_lens_tasks || [], brief && brief.lens_advice)
for (const d of lensPlan.dropped) log(`lens ${d.lens} dropped by the brief agent: ${d.why}`)
for (const a of lensPlan.added) log(`lens ${a.lens} added by the brief agent: ${a.why}`)
const merged = dedupeFindings(await runLenses(lensPlan.tasks, 'Lenses'))
let { kept, dropped } = capCandidates(merged, A.max_candidates, A.thresholds)
// Same root cause reported by two lenses: group before paying for verification twice.
if (A.chores.merge && kept.length >= (A.chores.merge.min_candidates || 5)) {
  phase('Dedupe')
  const m = await chore('merge', () => agent(follow('tasks/merge.md', 'Candidates:\n```json\n' + JSON.stringify(kept.map(slim)) + '\n```'),
    { label: 'chore:merge', phase: 'Dedupe', model: A.chores.model, schema: MERGE_SCHEMA, ...effort('chore') }))
  const before = kept.length
  kept = applyMergeGroups(kept, m && m.groups)
  if (kept.length < before) log(`${before - kept.length} candidate(s) merged into another with the same root cause`)
}
if (dropped.length) log(`${dropped.length} lowest-priority candidate(s) will NOT be verified (profile cap ${A.max_candidates}); they are listed in the report`)
log(`${lensRuns.reduce((n, r) => n + r.raised, 0)} raised -> ${merged.length} distinct -> ${kept.length} to verify`)

// ---- Dedupe against what was already said -----------------------------------------------------------------------------
async function dedupeAgainstHistory(list) {
  if (!A.chores.dedupe || !list.length) return { covered: [], reintroduced: [] }
  const r = await chore('dedupe', () => agent(follow('tasks/dedupe.md', 'Candidates:\n```json\n' + JSON.stringify(list.map(slim)) + '\n```'),
    { label: 'chore:dedupe', phase: 'Dedupe', model: A.chores.model, schema: DEDUPE_SCHEMA, ...effort('chore') }))
  return { covered: (r && r.covered) || [], reintroduced: (r && r.reintroduced) || [] }
}

// ---- Verify -----------------------------------------------------------------------------------------------------------
const verifyPrompt = (f, stance, earlier) => `Read ${A.skill}/references/verifier.md (method, stances, confidence rubric, output shape) and ${A.run}/tasks/verify-common.md (paths, and whether you may execute code). Then adversarially verify the finding below. Your stance: **${stance}**.

${CONTEXT}

\`\`\`json
${JSON.stringify(earlier ? { ...f, earlier_verdicts: earlier } : f, null, 2)}
\`\`\``

let escalationsSaved = 0
async function verifyOne(f, reintroduced) {
  const stances = stancesFor(f, A.verify, A.thresholds)
  const wave = async (list) => (await parallel(list.map(([stance, model]) => () =>
    agent(verifyPrompt(f, stance), { label: `verify:${f.id}:${stance}`, phase: 'Verify', model, schema: VERDICT_SCHEMA, ...effort('verify') })
      .then((v) => (v ? { ...v, stance, model } : null))))).filter(Boolean)
  // Escalate only when the first verifier could not prove the finding by running code (see verifyWaves in core.mjs).
  const { first, rest } = verifyWaves(stances, f.severity, A.verify.escalate)
  let votes = await wave(first)
  if (rest.length && !settledEarly(votes)) votes = votes.concat(await wave(rest))
  else if (rest.length) escalationsSaved += rest.length
  let agg = aggregateVerdicts(f, votes, A.thresholds)
  let tb = null
  if (A.verify.tiebreak && needsTiebreak(agg, f)) {
    const earlier = votes.map((v) => ({ stance: v.stance, verdict: v.verdict, confidence: v.confidence, evidence: v.evidence }))
    tb = await agent(verifyPrompt(f, 'tiebreak', earlier), { label: `verify:${f.id}:tiebreak`, phase: 'Verify', model: A.verify.tiebreak, schema: VERDICT_SCHEMA }).catch(() => null)
    if (tb) { tb = { ...tb, stance: 'tiebreak', model: A.verify.tiebreak }; agg = aggregateVerdicts(f, votes, A.thresholds, tb) }
  }
  return finalizeFinding(f, agg, [tb, ...votes], reintroduced)
}

async function dedupeAndVerify(list) {
  phase('Dedupe')
  const dd = await dedupeAgainstHistory(list)
  const coveredIds = new Map(dd.covered.map((c) => [c.id, c]))
  const reintro = new Set(dd.reintroduced.map((c) => c.id))
  const covered = list.filter((f) => coveredIds.has(f.id)).map((f) => ({ id: f.id, title: f.title, path: f.path, line: f.line, by: coveredIds.get(f.id).by || '', why: coveredIds.get(f.id).why || '' }))
  phase('Verify')
  // A verification that crashes must leave the finding visible as "unverified" — never drop it, never call it refuted.
  // Should-fix findings their own lens rates a nit are listed unverified under "minor" — verifying them could not make them postable.
  const open = list.filter((f) => !coveredIds.has(f.id))
  const nits = open.filter((f) => skipsVerification(f, A.thresholds))
  if (nits.length) log(`${nits.length} should-fix finding(s) rated a nit by their own lens are listed as minor without verification`)
  const toVerify = open.filter((f) => !skipsVerification(f, A.thresholds))
  const out = await parallel(toVerify.map((f) => () => verifyOne(f, reintro.has(f.id))))
  const verified = toVerify.map((f, i) => out[i] || finalizeFinding(f, aggregateVerdicts(f, [], A.thresholds), [], reintro.has(f.id)))
  const dead = verified.filter((f) => f.status === 'unverified').length
  if (dead) log(`WARNING: ${dead} finding(s) could not be verified (verifier agents failed); they are reported as unverified`)
  return { covered, verified: [...verified, ...nits.map(unverifiedMinor)] }
}

const first = await dedupeAndVerify(kept)
const findings = first.verified
const covered = first.covered

// ---- Completeness critic (profiles that enable it) --------------------------------------------------------------------
if (A.critic) {
  let known = [...kept]
  for (let round = 1; round <= (A.critic.max_rounds || 1); round++) {
    phase('Critic')
    // A critic that died is not a critic that found nothing: retried once, then reported (chores_failed -> report notice).
    const c = await chore(round === 1 ? 'critic' : 'critic-later', () => agent(follow('tasks/critic.md', 'Candidate findings so far:\n```json\n' + JSON.stringify(known.map(slim)) + '\n```'),
      { label: `critic:round${round}`, phase: 'Critic', model: A.critic.model, schema: CRITIC_SCHEMA }))
    if (!c) { log(`critic round ${round}: did NOT run`); break }
    const gaps = (c.gaps || []).slice(0, 5)
    if (!gaps.length) { log(`critic round ${round}: no gaps`); break }
    const gapTasks = gaps.map((g, i) => ({
      lens: 'critic-gap', shard: `gap-r${round}-${i + 1}`, model: A.critic.model,
      prompt: `Targeted follow-up for the review run ${A.run} (paths to the code and diffs: "Facts" section of ${A.run}/tasks/verify-common.md).

${CONTEXT}

A completeness critic flagged a possible gap in an automated code review. Investigate exactly this and nothing else.\n\nQuestion: ${g.question}\nFiles: ${(g.paths || []).join(', ') || '(see question)'}\n\nRead ${A.skill}/lenses/_contract.md for the rules and output shape${g.lens ? `, and ${A.skill}/lenses/${g.lens}.md if it exists for what to look for` : ''}. Paths to the code and diffs are in the "Facts" section of ${A.run}/tasks/verify-common.md. Return an empty findings list if the concern does not hold up.`,
    }))
    const fresh = dedupeFindings(await runLenses(gapTasks, 'Critic')).filter((f) => !known.some((k) => sameIssue(k, f)))
    fresh.forEach((f, i) => { f.id = `G${round}${String(i + 1).padStart(2, '0')}` })
    log(`critic round ${round}: ${gaps.length} gap(s) -> ${fresh.length} new candidate(s)`)
    if (!fresh.length) break
    known = known.concat(fresh)
    const more = await dedupeAndVerify(fresh)
    findings.push(...more.verified)
    covered.push(...more.covered)
  }
}

const followup = await followupP
const count = (band) => findings.filter((f) => f.band === band).length
log(`verified: ${count('high')} high / ${count('medium')} medium / ${count('low')} low confidence · ${covered.length} already covered${escalationsSaved ? ` · ${escalationsSaved} verifier run(s) saved by early proof` : ''}`)

return {
  v: 1,
  lens_runs: lensRuns,
  findings,
  covered,
  dropped: dropped.map((f) => ({ title: f.title, path: f.path, line: f.line, severity: f.severity, reason: `over max_candidates (${A.max_candidates})` })),
  followup: (followup && followup.items) || [],
  chores_failed: Array.from(new Set(choresFailed)),
  lens_changes: { dropped: lensPlan.dropped, added: lensPlan.added },
  brief: brief || null,
}
