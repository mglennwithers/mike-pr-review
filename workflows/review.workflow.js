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

// ---- inlined from scripts/lib/core.mjs ------------------------------------------------------------------------------
// Pure review logic shared by the Node scripts AND the Workflow engine.
//
// `prr build-workflow` inlines this file verbatim (minus `export`) into workflows/review.workflow.js, so keep it
// dependency-free: no module loading, no clock, no randomness (the workflow runtime forbids them), no I/O.

const SEVERITY_RANK = { red: 2, yellow: 1, drop: 0 }

const STOP = new Set(['the', 'a', 'an', 'is', 'are', 'in', 'on', 'of', 'to', 'for', 'and', 'or', 'not', 'when', 'with',
  'be', 'can', 'may', 'will', 'this', 'that', 'it', 'if', 'by', 'from', 'as', 'at', 'no', 'does', 'missing'])

function titleTokens(s) {
  return new Set(String(s || '').toLowerCase().replace(/[^a-z0-9_]+/g, ' ').split(' ')
    .filter((w) => w.length > 2 && !STOP.has(w)))
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0
  let inter = 0
  for (const x of a) if (b.has(x)) inter++
  return inter / (a.size + b.size - inter)
}

function normalizeFinding(f, lensKey) {
  const line = Math.max(1, Math.floor(Number(f.line) || 1))
  const end = Math.max(line, Math.floor(Number(f.end_line) || line))
  return {
    path: String(f.path || '').replace(/\\/g, '/').replace(/^\.\//, '').replace(/^[ab]\//, ''),
    line, end_line: end,
    anchor: String(f.anchor || '').trim(),
    severity: f.severity === 'red' ? 'red' : 'yellow',
    category: String(f.category || lensKey || 'general').toLowerCase(),
    title: String(f.title || '').trim(),
    body: String(f.body || '').trim(),
    scenario: String(f.scenario || '').trim(),
    evidence: String(f.evidence || '').trim(),
    suggestion: f.suggestion ? String(f.suggestion) : '',
    test_idea: f.test_idea ? String(f.test_idea) : '',
    self_confidence: Math.max(0, Math.min(100, Number(f.self_confidence) || 0)),
    // The lens's own view of how much the finding matters. Absent = unknown, which is treated as "matters" everywhere.
    self_importance: Number.isFinite(Number(f.self_importance)) && f.self_importance !== null && f.self_importance !== '' ? Math.max(0, Math.min(100, Number(f.self_importance))) : null,
    lenses: [lensKey],
  }
}

function sameIssue(a, b) {
  if (a.path !== b.path) return false
  const near = a.line <= b.end_line + 3 && b.line <= a.end_line + 3
  if (!near) return false
  // Nearby is not enough: one lens can raise two different bugs on adjacent lines. Merge only when they are anchored on
  // the same line, or when the titles say the same thing (lower bar when the category also agrees).
  const sameSpot = a.line === b.line || (!!a.anchor && a.anchor === b.anchor)
  const sim = jaccard(titleTokens(a.title), titleTokens(b.title))
  if (a.category === b.category) return sameSpot ? sim >= 0.1 : sim >= 0.25
  return sameSpot ? sim >= 0.2 : sim >= 0.35
}

const better = (a, b) =>
  (SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]) || (b.self_confidence - a.self_confidence)

// Merge findings that different lenses raised about the same spot, so each issue is verified (and posted) once.
function dedupeFindings(lensResults) {
  const all = []
  for (const r of lensResults) {
    if (!r || !Array.isArray(r.findings)) continue
    for (const f of r.findings) {
      const n = normalizeFinding(f, r.lens)
      if (n.path && n.title) all.push(n)
    }
  }
  all.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line) || better(a, b))
  const merged = []
  for (const f of all) {
    const hit = merged.find((m) => sameIssue(m, f))
    if (!hit) { merged.push({ ...f, also_noted: [] }); continue }
    const [keep, other] = better(hit, f) <= 0 ? [hit, f] : [f, hit]
    const lenses = Array.from(new Set([...hit.lenses, ...f.lenses]))
    const also = [...(hit.also_noted || [])]
    if (other.title && other.title !== keep.title) also.push(`${other.lenses[0]}: ${other.title}`)
    // Two lenses, two opinions on importance: the higher one wins (a nit to one lens may be a real problem to another).
    const imp = [hit.self_importance, f.self_importance].every((x) => x === null) ? null : Math.max(hit.self_importance ?? 100, f.self_importance ?? 100)
    Object.assign(hit, keep, { lenses, also_noted: also, self_importance: imp })
  }
  merged.sort((a, b) => better(a, b) || (a.path < b.path ? -1 : 1) || a.line - b.line)
  merged.forEach((f, i) => { f.id = 'F' + String(i + 1).padStart(2, '0') })
  return merged
}

// A lens result we can build on. "Partial coverage and nothing found" is how an agent that balked, got lost or ran out
// of room looks from the outside — it is not a clean bill of health, so engines retry it once and then count the lens
// as not having run.
// So is "nothing found, nothing said": the contract makes a lens say what it examined, so zero findings with notes too
// short to say that (a one-word stub, for instance) show no sign that anything was read and never count as a clean pass.
function lensUsable(r) {
  if (!r || !Array.isArray(r.findings)) return false
  if (r.findings.length > 0) return true
  return r.coverage !== 'partial' && String(r.notes || '').trim().length >= 40
}

// Lens selection is regex heuristics, and keywords misfire: a file that merely *mentions* "Promise.all" or "ALTER TABLE"
// in a string wakes a lens with nothing to find. The brief agent has read the diff, so it may veto lenses the planner
// marked `soft` (woken by a keyword only) and ask for up to `maxAdd` lenses from the planner's prepared `optional` list.
// It can never drop a core lens, a lens the user asked for, or every lens — the diff it reads is untrusted input.
function applyLensAdvice(lensTasks, optionalTasks, advice, maxAdd = 2) {
  const reason = (list) => new Map((Array.isArray(list) ? list : []).filter((x) => x && typeof x.lens === 'string').map((x) => [x.lens, String(x.why || '').slice(0, 200)]))
  const drop = reason(advice && advice.drop), add = reason(advice && advice.add)
  const soft = new Set(lensTasks.filter((t) => t.soft).map((t) => t.lens))
  let tasks = lensTasks.filter((t) => !(soft.has(t.lens) && drop.has(t.lens)))
  if (!tasks.length) tasks = lensTasks
  const kept = new Set(tasks.map((t) => t.lens))
  const optional = new Set((optionalTasks || []).map((t) => t.lens))
  const added = Array.from(add.keys()).filter((l) => optional.has(l) && !kept.has(l)).slice(0, maxAdd)
  return {
    tasks: [...tasks, ...(optionalTasks || []).filter((t) => added.includes(t.lens))],
    dropped: Array.from(soft).filter((l) => drop.has(l) && !kept.has(l)).map((l) => ({ lens: l, why: drop.get(l) })),
    added: added.map((l) => ({ lens: l, why: add.get(l) })),
  }
}

// Different lenses often report one root cause from two angles ("generated file missing" / "docs point at a file that
// needs a build step"). Title similarity cannot see that, and every duplicate costs a full verification and another
// comment for the author. A cheap model groups them; here the groups are applied. The absorbed finding stays visible
// under "merged with", and a group is ignored unless every id in it exists — a confused grouping must not lose findings.
function applyMergeGroups(list, groups) {
  const byId = new Map(list.map((f) => [f.id, f]))
  const gone = new Set()
  for (const g of Array.isArray(groups) ? groups : []) {
    const keep = g && byId.get(g.keep)
    const others = ((g && g.merge) || []).filter((id) => id !== (g && g.keep))
    if (!keep || !others.length || gone.has(keep.id) || others.some((id) => !byId.has(id) || gone.has(id))) continue
    for (const id of others) {
      const o = byId.get(id)
      gone.add(id)
      keep.lenses = Array.from(new Set([...(keep.lenses || []), ...(o.lenses || [])]))
      keep.also_noted = [...(keep.also_noted || []), `${(o.lenses || [o.category]).join('+')}: ${o.title} (${o.path}:${o.line})`, ...(o.also_noted || [])]
      if ((SEVERITY_RANK[o.severity] ?? 0) > (SEVERITY_RANK[keep.severity] ?? 0)) keep.severity = o.severity
      // The group matters as much as its most important member: a real finding folded into a twin its lens called a nit
      // must still be verified. Unknown (null) counts as "matters".
      keep.self_importance = [keep.self_importance, o.self_importance].some((x) => x === null || x === undefined) ? null : Math.max(keep.self_importance, o.self_importance)
    }
  }
  return list.filter((f) => !gone.has(f.id))
}

// The cap limits what is sent to VERIFICATION (that is where the money goes). Findings that will not be verified anyway
// (self-rated nits) therefore never take a slot from one that would be.
function capCandidates(list, max, thresholds) {
  if (!max) return { kept: list, dropped: [] }
  const costly = list.filter((f) => !skipsVerification(f, thresholds))
  if (costly.length <= max) return { kept: list, dropped: [] }
  const over = new Set(costly.slice(max))
  return { kept: list.filter((f) => !over.has(f)), dropped: list.filter((f) => over.has(f)) }
}

// Confidence answers "is this true?". Importance answers the other question a reviewer asks: "does it matter?" — an
// unused helper can be 95% certain and still not worth an inline comment. Verifiers score it 0-100 (rubric in
// references/verifier.md); the judges' median counts. Without a score, fall back on what kind of finding it is.
const LOW_STAKES = new Set(['maintainability', 'docs-comments', 'conventions', 'tests', 'types'])
function importanceOf(finding, severity, judges) {
  const scores = (judges || []).map((v) => Number(v && v.importance)).filter((n) => Number.isFinite(n) && n >= 0 && n <= 100).sort((a, b) => a - b)
  let imp = scores.length ? scores[Math.floor((scores.length - 1) / 2)] : severity === 'red' ? 80 : LOW_STAKES.has(finding.category) ? 35 : 55
  if (severity === 'red') imp = Math.max(imp, 60) // a confirmed blocker is never a nit; if it were, the verifier should have downgraded it
  return Math.round(imp)
}

// Verification is the most expensive thing done per finding, so it is spent where it can change an outcome.
// - A should-fix finding its own lens calls a nit (self_importance under the floor) would land in "minor — not offered
//   for posting" even if verified. It is listed there unverified instead. Blockers are always verified, and so is any
//   finding whose importance the lens did not state.
// - Low-stakes should-fix findings (housekeeping categories) go to the profile's cheaper verifier when it names one:
//   a false positive there costs the author a shrug, not a wrong "request changes".
const LOW_STAKES_CATEGORIES = ['maintainability', 'docs-comments', 'conventions', 'tests', 'types', 'hygiene']
const LOW_STAKES_LENSES = ['maintainability', 'docs-comments', 'conventions', 'tests', 'types', 'hygiene']
function skipsVerification(f, thresholds) {
  const floor = thresholds && (thresholds.verify_min_importance ?? thresholds.min_importance)
  return f.severity === 'yellow' && Number.isFinite(floor) && f.self_importance !== null && f.self_importance !== undefined && f.self_importance < floor
}
function stancesFor(f, verify, thresholds) {
  if (f.severity === 'red') return verify.red
  // Both the label and the source must be housekeeping: a finding the security or correctness lens also raised (merged in
  // by dedupe), or one the single-pass lens raised, keeps the full-strength verifier whatever its category says.
  const lenses = f.lenses && f.lenses.length ? f.lenses : [f.category]
  if (verify.yellow_low_stakes && LOW_STAKES_CATEGORIES.includes(f.category) && lenses.every((l) => LOW_STAKES_LENSES.includes(l))) return verify.yellow_low_stakes
  // A should-fix finding its own lens rates as housekeeping gets the cheaper verifier too — a cheaper verifier, not none:
  // a lens can under-rate a real defect (a test that cannot fail, say), and a finding that skips verification is never posted.
  const cheapBelow = thresholds && thresholds.cheap_verify_below
  if (verify.yellow_low_stakes && Number.isFinite(cheapBelow) && f.self_importance !== null && f.self_importance !== undefined && f.self_importance < cheapBelow) return verify.yellow_low_stakes
  return verify.yellow
}
// What a finding that skipped verification looks like downstream: visibly unverified, never postable, never a "hole".
function unverifiedMinor(f) {
  return { ...f, original_severity: f.severity, status: 'not_verified', confidence: 0, band: 'minor', reproduced: false, pre_existing: false, votes: [],
    verification: '', tests: [], suggestion_ok: false, importance: f.self_importance, skipped_verification: true, reintroduced: false }
}

// Escalating verification. A blocker the first verifier has reproduced by running code is settled: further opinions on
// it add cost, not information. So run the FIRST stance alone (profiles that escalate put `reproduce` first for
// blockers) and spend the others only when it could not prove the finding by running code.
// A blocker confirmed on reading alone, doubted or refuted still gets every stance — one opinion must never sink or post one.
function verifyWaves(stances, severity, escalate) {
  const list = stances || []
  if (!escalate || severity !== 'red' || list.length < 2) return { first: list, rest: [] }
  return { first: list.slice(0, 1), rest: list.slice(1) }
}
function settledEarly(votes) {
  const v = (votes || []).filter(Boolean)
  return v.length > 0 && v.every((x) => x.verdict === 'confirmed' && x.reproduced === true)
}

// Fold the verifier votes for one finding into a single confidence that it is real, introduced by this change, and
// worth a human's attention. `confidence` on every vote means P(finding is real), whatever the verifier's stance.
function aggregateVerdicts(finding, verdicts, thresholds, tiebreak) {
  const t = thresholds || { post: 80, show: 50 }
  const valid = (verdicts || []).filter(Boolean)
  const out = {
    status: 'unverified', confidence: 0, band: 'low', reproduced: false, pre_existing: false,
    severity: finding.severity, votes: valid.map((v) => ({
      stance: v.stance, verdict: v.verdict, confidence: v.confidence, reproduced: !!v.reproduced,
      model: v.model || '',
    })),
    verification: '', tests: [], suggestion_ok: false,
  }
  if (!valid.length) return out

  const confirmed = valid.filter((v) => v.verdict === 'confirmed')
  const refuted = valid.filter((v) => v.verdict === 'refuted')
  const mean = valid.reduce((s, v) => s + (Number(v.confidence) || 0), 0) / valid.length
  out.reproduced = confirmed.some((v) => v.reproduced)
  out.suggestion_ok = confirmed.some((v) => v.suggestion_ok === true) && !valid.some((v) => v.suggestion_ok === false)
  out.suggestion_rejected = valid.some((v) => v.suggestion_ok === false) // a fix somebody checked and found wrong is never posted
  out.tests = valid.filter((v) => v.test && v.test.ran).map((v) => ({
    command: v.test.command || '', outcome: v.test.outcome || '', stance: v.stance,
  }))

  let conf = mean
  if (confirmed.length && refuted.length) { out.status = 'contested'; conf = Math.min(conf, 70) }
  else if (refuted.length && refuted.length >= valid.length / 2) { out.status = 'refuted'; conf = Math.min(conf, 30) }
  else if (confirmed.length) { out.status = 'confirmed'; if (out.reproduced) conf = Math.max(conf, 90) }
  else { out.status = 'uncertain'; conf = Math.min(conf, 65) }

  if (tiebreak) {
    out.votes.push({ stance: 'tiebreak', verdict: tiebreak.verdict, confidence: tiebreak.confidence,
      reproduced: !!tiebreak.reproduced, model: tiebreak.model || '' })
    out.status = tiebreak.verdict === 'confirmed' ? 'confirmed' : tiebreak.verdict === 'refuted' ? 'refuted' : 'uncertain'
    conf = Number(tiebreak.confidence) || 0
    if (out.status === 'refuted') conf = Math.min(conf, 30)
    if (out.status === 'uncertain') conf = Math.min(conf, 65)
    if (tiebreak.reproduced && out.status === 'confirmed') { out.reproduced = true; conf = Math.max(conf, 90) }
  }

  // The tiebreak is final on this question too: a verifier it overruled must not bury the finding as "pre-existing".
  const judges = tiebreak ? [tiebreak] : valid
  if (judges.some((v) => v.introduced_by_change === false || v.introduced_by_change === 'no')) { out.pre_existing = true; conf = Math.min(conf, 40) }

  // Severity: be conservative. Any confirming judge who downgrades wins; a finding every confirmer would drop is dropped.
  const sevVotes = (tiebreak ? [tiebreak] : confirmed.length ? confirmed : valid).map((v) => v.severity).filter(Boolean)
  if (sevVotes.length) {
    // Never above what the lens claimed: a yellow finding only got yellow-grade verification, so it cannot become red.
    const min = sevVotes.reduce((m, s) => Math.min(m, SEVERITY_RANK[s] ?? 1), SEVERITY_RANK[finding.severity] ?? 2)
    out.severity = min === 2 ? 'red' : min === 1 ? 'yellow' : 'drop'
    if (out.severity === 'drop') conf = Math.min(conf, 30)
  }

  out.importance = importanceOf(finding, out.severity, tiebreak ? [tiebreak] : confirmed.length ? confirmed : valid)
  out.confidence = Math.round(Math.max(0, Math.min(100, conf)))
  out.band = out.confidence >= t.post ? 'high' : out.confidence >= t.show ? 'medium' : 'low'
  const best = (tiebreak && tiebreak.evidence) ? tiebreak
    : [...valid].sort((a, b) => (b.reproduced ? 1 : 0) - (a.reproduced ? 1 : 0) || String(b.evidence || '').length - String(a.evidence || '').length)[0]
  out.verification = String((best && best.evidence) || '').trim()
  return out
}

// Merge a finding with its aggregated verdict. Verifiers may correct a line number that was a few lines off.
function finalizeFinding(f, agg, verdicts, reintroduced) {
  const line = (verdicts || []).filter(Boolean).map((v) => Number(v.line)).find((n) => Number.isInteger(n) && n > 0 && Math.abs(n - f.line) <= 40)
  const shift = line ? line - f.line : 0
  return { ...f, line: f.line + shift, end_line: f.end_line + shift, original_severity: f.severity, ...agg, reintroduced: !!reintroduced }
}

function needsTiebreak(agg, finding) {
  return agg.status === 'contested' && finding.severity === 'red'
}

// Traffic light per lens: a lens only turns red/yellow for findings that survived verification with high confidence.
function lensLights(lensRuns, findings) {
  return lensRuns.map((run) => {
    const mine = findings.filter((f) => f.band === 'high' && !f.pre_existing && f.severity !== 'drop' && (f.lenses || [f.category]).includes(run.lens))
    const red = mine.filter((f) => f.severity === 'red').length
    const yellow = mine.filter((f) => f.severity === 'yellow').length
    const light = !run.ok ? 'gray' : red ? 'red' : yellow ? 'yellow' : run.coverage === 'partial' ? 'gray' : 'green' // never green on partial coverage
    return { lens: run.lens, model: run.model || '', ok: !!run.ok, light, red, yellow,
      raised: run.raised || 0, notes: run.notes || '', coverage: run.coverage || (run.ok ? 'full' : 'none') }
  })
}

function overallLight(findings) {
  const post = findings.filter((f) => f.band === 'high' && !f.pre_existing && f.severity !== 'drop')
  if (post.some((f) => f.severity === 'red')) return 'red'
  if (post.some((f) => f.severity === 'yellow')) return 'yellow'
  return 'green'
}
// ---- end of inlined core --------------------------------------------------------------------------------------------

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
