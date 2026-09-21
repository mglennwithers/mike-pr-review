// prr calibrate — does verification DISCRIMINATE? The skill's promise is that only findings which survive an
// adversarial verifier are shown as postable, but on real lens output nothing separates a verifier that thinks from one
// that rubber-stamps: no claim there is known to be false. So hand the verifiers claims whose truth IS known and count
// what they do with them. Verification already reads its input from <RUN_DIR>/lens/<shard>.json, so a calibration run is
// an ordinary run whose lens output is an answer key with the answers withheld: merge, the verifier agents and aggregate
// run exactly as in a real review, and only the scoring at the end knows which claims were invented.
import fs from 'node:fs'
import path from 'node:path'
import { SKILL_DIR, UserError, calibrationKey, fwd, parseArgs, readJson, requireRun, writeJson } from '../lib/util.mjs'
import { prepare } from '../lib/report.mjs'
import { fixture } from './bench.mjs'
import collect from './collect.mjs'
import plan from './plan.mjs'
import { merge } from './engine.mjs'

// The only claim fields that may reach the file an agent reads. An allow-list, not "everything except truth and why":
// a field added to the schema later must not leak into a verifier's task by default — a verifier that can see which
// claims are false measures nothing.
const FINDING_FIELDS = ['path', 'line', 'end_line', 'anchor', 'severity', 'category', 'title', 'body', 'scenario', 'evidence', 'self_confidence', 'self_importance']
const norm = (s) => String(s || '').trim().toLowerCase()
const pct = (n, d) => (d ? `${Math.round((n / d) * 100)}%` : '—')
// `fixture` and `collect` print for a human driving them by hand; here that is noise in front of the VERIFY lines the
// orchestrator has to act on.
const hushed = async (fn) => { const log = console.log; console.log = () => {}; try { return await fn() } finally { console.log = log } }

export default async function calibrate(argv) {
  const args = parseArgs(argv, { booleans: ['score', 'quiet', 'confirmed'] })
  if (args.score) return scoreCalibration(args)

  const name = args.fixture || 'shop'
  if (!args.dir) throw new UserError('Pass --dir <empty directory>: the fixture repo is built there and reviewed. To score a finished run instead: prr calibrate --score --run <RUN_DIR>')
  const claimsFile = args.claims ? path.resolve(args.claims) : path.join(SKILL_DIR, 'evals', 'calibration.json')
  if (!fs.existsSync(claimsFile)) throw new UserError(`No claim set at ${fwd(claimsFile)}. That file holds the claims of known truth this command feeds to the verifiers; point at another one with --claims <file>.`)
  const doc = readJson(claimsFile)
  const claims = (doc.claims || []).filter((c) => c && c.fixture === name)
  if (!claims.length) throw new UserError(`No claims for fixture "${name}" in ${fwd(claimsFile)} (it has claims for: ${Array.from(new Set((doc.claims || []).map((c) => c && c.fixture).filter(Boolean))).join(', ') || 'nothing'}).`)
  const bad = claims.find((c) => !c.id || !c.path || !c.title || !['true', 'false'].includes(String(c.truth)) || !Number.isInteger(c.line) || c.line < 1)
  if (bad) throw new UserError(`Claim ${JSON.stringify(bad.id || '')} in ${fwd(claimsFile)} needs id, path, title, a line number and truth "true" or "false".`)
  const byId = new Map()
  for (const c of claims) {
    if (byId.has(c.id)) throw new UserError(`Two claims in ${fwd(claimsFile)} share the id ${JSON.stringify(c.id)}; the whole report is keyed by it.`)
    byId.set(c.id, c)
  }
  // Scoring pairs claims to findings by path + title (merge reassigns the ids), so two claims that share both could
  // never be told apart afterwards — and dedupeFindings would fold them into one candidate anyway.
  const seen = new Map()
  for (const c of claims) {
    const k = `${c.path}\n${norm(c.title)}`
    if (seen.has(k)) throw new UserError(`Claims ${seen.get(k)} and ${c.id} share a path and title; scoring pairs claims to findings by those, so they must differ.`)
    seen.set(k, c.id)
  }

  const target = path.resolve(args.dir)
  // A stop anywhere below (the spend gate, most likely) leaves the built fixture behind; re-running the same command
  // must not need a fresh empty directory, so a repo this command already built there is reused as it is.
  const marker = path.join(target, '.git', 'prr-fixture')
  const built = fs.existsSync(marker) && fs.readFileSync(marker, 'utf8').trim() === name
  if (!built) await hushed(() => fixture(['--name', name, '--dir', target]))
  const { runDir } = await hushed(() => collect(['--target', 'local', '--cwd', target]))
  // One lens shard, so there is exactly one lens result file to write; the plan itself is noise here.
  plan(['--run', runDir, '--lenses', 'quick-scan', '--quiet', ...(args.profile ? ['--profile', args.profile] : []), ...(args.confirmed ? ['--confirmed'] : [])])
  const p = readJson(path.join(runDir, 'plan.json'))
  // Each claim must get its OWN verdict: the root-cause chore groups candidates that look related, and two claims it
  // folded together would share one verdict and stop being two measurements.
  if (p.chores && p.chores.merge) { p.chores = { ...p.chores, merge: false }; writeJson(path.join(runDir, 'plan.json'), p) }
  if (p.needs_confirmation && !p.confirmed) throw new UserError(`This calibration run is waiting for the user's OK (${p.needs_confirmation}): about ${p.estimate.total} sub-agent(s), estimated ${p.estimate.cost != null ? `$${p.estimate.cost.toFixed(2)}` : 'unknown'} at API list prices. Ask them, then run the same command again with --confirmed (the fixture in ${fwd(target)} is reused).`, { code: 9 })
  if (p.lens_tasks.length !== 1) throw new UserError(`Expected exactly one lens shard for the claims, got ${p.lens_tasks.length} (${p.lens_tasks.map((t) => t.shard).join(', ') || 'none'}).`)
  process.exitCode = 0 // plan reports "no lens" / "confirm first" through the exit code; both are handled above

  const ctx = readJson(path.join(runDir, 'context.json'))
  // A claim about a file that is not in the checkout would be refuted for the wrong reason and still score as a stop.
  const gone = claims.find((c) => !fs.existsSync(path.join(runDir, 'wt', c.path)))
  if (gone) throw new UserError(`Claim ${JSON.stringify(gone.id)} is about ${gone.path}, which the "${name}" fixture does not contain. A claim whose file is missing gets refuted for the wrong reason and would be scored as verification working.`)
  const shard = p.lens_tasks[0].shard
  writeJson(path.join(runDir, 'lens', `${shard}.json`), { coverage: 'full',
    notes: `Reviewed the change and reported ${claims.length} finding(s).`, // deliberately says nothing about this being a calibration: it is the run's own record, and nothing may hint at the answer key
    findings: claims.map((c) => Object.fromEntries(FINDING_FIELDS.filter((k) => c[k] !== undefined).map((k) => [k, c[k]]))) })
  writeJson(calibrationKey(runDir), { v: 1, fixture: name, shard, profile: p.profile, run_dir: ctx.run_dir,
    claims: claims.map((c) => ({ id: c.id, truth: String(c.truth), path: c.path, title: c.title })) })

  const nFalse = claims.filter((c) => String(c.truth) === 'false').length
  if (!args.quiet) console.log(`CALIBRATION "${name}": ${claims.length} claim(s) — ${nFalse} known false, ${claims.length - nFalse} known true — written as lens shard ${shard} (profile ${p.profile}, tier ${p.tier}).\nWhich is which is recorded in ${fwd(calibrationKey(runDir))} — outside the run directory, so no agent can stumble on it. Verify them exactly as in a real review: do not tell the verifiers what this run is.`)
  console.log(`RUN_DIR=${ctx.run_dir}`)
  merge(['--run', runDir])
  console.log(`THEN, once aggregate has written results.json: prr calibrate --score --run "${ctx.run_dir}"`)
}

function scoreCalibration(args) {
  const runDir = requireRun(args)
  const key = readJson(calibrationKey(runDir), null)
  if (!key || !Array.isArray(key.claims)) throw new UserError(`${fwd(runDir)} is not a calibration run (no answer key at ${fwd(calibrationKey(runDir))}). Start one with: prr calibrate --dir <empty dir>`)
  if (!fs.existsSync(path.join(runDir, 'results.json'))) throw new UserError(`No results.json in ${fwd(runDir)} yet — the verifier agents and \`prr aggregate --run "${fwd(runDir)}"\` come first.`)
  const R = prepare(runDir)
  const findings = R.results.findings || []
  // "Postable" means what it means in the report, so the measurement is of the bar the user actually sees.
  const place = new Map()
  for (const [label, list] of [['postable', R.buckets.post], ['minor', R.buckets.minor], ['below the bar', R.buckets.watch],
    ['refuted', R.buckets.refuted], ['pre-existing', R.buckets.pre_existing], ['unverifiable', R.buckets.unverified], ['suppressed', R.buckets.suppressed]]) {
    for (const f of list) if (f.id && !place.has(f.id)) place.set(f.id, label)
  }
  const missingWhy = (c) => {
    const same = (x) => x && x.path === c.path && norm(x.title) === norm(c.title)
    if ((R.results.dropped || []).some(same)) return 'dropped by the candidate cap'
    if ((R.results.covered || []).some(same)) return 'skipped as already covered'
    return 'no finding carries this path and title'
  }
  const rows = key.claims.map((c) => {
    const exact = findings.find((f) => f.path === c.path && norm(f.title) === norm(c.title))
    // dedupeFindings (or the root-cause chore) may have folded a claim into another candidate: the absorbed title is
    // kept under also_noted, and the two then share one verdict.
    // also_noted entries read "<lens>: <title>" or "<lenses>: <title> (<path>:<line>)": compare the title itself, or a
    // claim whose title is a substring of another's would be paired to the wrong finding.
    const absorbedTitle = (s) => norm(String(s).replace(/^[^:]*:\s*/, '').replace(/\s*\([^()]*:\d+\)$/, ''))
    const absorbed = exact ? null : findings.find((f) => (f.also_noted || []).some((s) => absorbedTitle(s) === norm(c.title)))
    const f = exact || absorbed
    if (!f) return { ...c, outcome: 'missing', note: missingWhy(c) }
    const where = place.get(f.id) || 'not reported'
    const postable = where === 'postable'
    return { ...c, finding_id: f.id, merged_into: absorbed ? f.id : null, outcome: where, postable, skipped_verification: !!f.skipped_verification, pre_existing: !!f.pre_existing,
      status: f.status || '—', band: f.band || '—', confidence: f.confidence ?? '—',
      verdict: postable ? (c.truth === 'false' ? 'BAD — an invented finding would be posted' : 'good — kept') : c.truth === 'false' ? 'good — stopped' : 'over-skeptical — a real finding was dropped' }
  })

  // Only claims a verifier actually judged belong in either rate. Without this, a run whose verifier agents all died
  // scores "100% stopped" — the exact flattery this command exists to detect.
  const UNJUDGED = new Set(['missing', 'unverifiable', 'not reported'])
  const judged = (r) => !UNJUDGED.has(r.outcome) && !r.skipped_verification
  const paired = rows.filter(judged)
  const unjudged = rows.filter((r) => !judged(r) && r.outcome !== 'missing')
  const falses = paired.filter((r) => r.truth === 'false'), trues = paired.filter((r) => r.truth === 'true')
  const stamped = falses.filter((r) => r.postable), kept = trues.filter((r) => r.postable)
  const missing = rows.filter((r) => r.outcome === 'missing')
  const merged = rows.filter((r) => r.merged_into)
  const summary = { type: 'calibration', fixture: key.fixture, profile: key.profile || R.plan.profile, run_id: path.basename(runDir),
    false_claims: falses.length, false_stopped: falses.length - stamped.length, false_postable: stamped.map((r) => r.id),
    true_claims: trues.length, true_kept: kept.length, true_lost: trues.filter((r) => !r.postable).map((r) => r.id), missing: missing.map((r) => r.id), unjudged: unjudged.map((r) => r.id) }
  writeJson(path.join(runDir, 'calibration-score.json'), { ...summary, rows }) // written after the review is over; no agent runs again in this run

  const L = [`# Verification calibration — fixture "${key.fixture}" · profile ${summary.profile} · run ${summary.run_id}`, '',
    '| Claim | Truth | Where it ended | Verification | Band | Confidence | Reading |', '|---|---|---|---|---|---|---|']
  for (const r of rows) L.push(r.outcome === 'missing' ? `| ${r.id} | ${r.truth} | missing (${r.note}) | — | — | — | counted against neither rate |`
    : `| ${r.id} | ${r.truth} | ${r.outcome}${r.merged_into ? ` (merged into ${r.merged_into})` : ''} | ${r.status} | ${r.band} | ${r.confidence} | ${r.verdict} |`)
  L.push('', `**False claims stopped ${summary.false_stopped}/${falses.length} (${pct(summary.false_stopped, falses.length)})** — refuted, below the posting bar or otherwise not offered for posting · **true claims kept ${kept.length}/${trues.length} (${pct(kept.length, trues.length)})**${missing.length ? ` · ${missing.length} missing (no finding to pair with)` : ''}${unjudged.length ? ` · ${unjudged.length} never judged by a verifier` : ''}${missing.length || unjudged.length ? ' — counted against neither rate' : ''}`)
  if (unjudged.length) L.push(`${unjudged.length} claim(s) reached no verifier verdict (${unjudged.map((r) => `${r.id}: ${r.outcome}`).join(', ')}): nothing judged them, so they say nothing either way. A run where this is common has measured little.`)
  if (merged.length) L.push(`${merged.length} claim(s) were folded into another candidate before verification (${merged.map((r) => `${r.id} → ${r.merged_into}`).join(', ')}): those share ONE verdict, so they are not two independent measurements.`)
  // A false claim its verifier CONFIRMED but the importance floor kept out of the postable list is a rubber stamp all
  // the same — the stopped rate would otherwise credit verification for what the bar did.
  // "Confirmed but older than this change" IS a discriminating judgement, so it is not a soft rubber stamp.
  const softStamp = falses.filter((r) => !r.postable && r.status === 'confirmed' && !r.pre_existing)
  if (softStamp.length) L.push(`${softStamp.length} of the stopped false claim(s) were confirmed by their verifier and only held back by the bar (${softStamp.map((r) => r.id).join(', ')}): the thresholds saved those, not the verifier.`)
  if (stamped.length) L.push('', `FAILED: ${stamped.length} known-false claim(s) ended postable: ${stamped.map((r) => r.id + (r.merged_into ? ` (folded into ${r.merged_into} before verification, so no verifier judged it on its own)` : '')).join(', ')}. A verifier that confirms an invented finding is not filtering anything — read its verdict in ${fwd(runDir)}/verdicts/ before trusting "only findings that survive verification are posted".`)
  else if (falses.length) L.push('', 'Every known-false claim was stopped by verification.')
  if (trues.length - kept.length) L.push(`${trues.length - kept.length} known-true claim(s) were thrown away (${summary.true_lost.join(', ')}): over-skepticism costs recall as surely as rubber-stamping costs precision.`)
  L.push('', `Written to ${fwd(runDir)}/calibration-score.json. One run is one sample of a stochastic process: repeat a configuration several times before concluding anything about it.`)
  console.log(L.join('\n'))
  if (stamped.length) process.exitCode = 1
}
