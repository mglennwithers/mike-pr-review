// prr fixture / score — ground truth for "how good is it at finding issues". Real PRs never tell you what a review
// missed; a fixture with seeded defects (and baits that only look like defects) does. Review the fixture with any
// profile, then score the run: recall, precision, and whether a miss was the lens's fault or the verifier's.
// A score is one sample of a process with large run-to-run variance: compare configurations over several runs each.
import fs from 'node:fs'
import path from 'node:path'
import { SKILL_DIR, UserError, fwd, isCalibrationRun, parseArgs, readJson, requireRun, run, writeJson } from '../lib/util.mjs'
import { prepare } from '../lib/report.mjs'
import { collectUsage, fmtCost, fmtTokens } from '../lib/usage.mjs'
import { appendEvent } from '../lib/metrics.mjs'

const fixtureDir = (name) => path.join(SKILL_DIR, 'evals', 'fixtures', name)
const listFixtures = () => { try { return fs.readdirSync(path.join(SKILL_DIR, 'evals', 'fixtures'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name) } catch { return [] } }

function loadFixture(name) {
  const dir = fixtureDir(name)
  if (!name || !fs.existsSync(path.join(dir, 'expected.json'))) throw new UserError(`Unknown fixture "${name || ''}". Available: ${listFixtures().join(', ') || '(none)'}`)
  return { dir, spec: readJson(path.join(dir, 'expected.json')) }
}

export function fixture(argv) {
  const args = parseArgs(argv)
  const name = args.name || args._[0]
  if (!name) return console.log(`Fixtures: ${listFixtures().join(', ') || '(none)'}\nUsage: prr fixture --name <fixture> --dir <empty target dir>`)
  const { dir, spec } = loadFixture(name)
  if (!args.dir) throw new UserError('Pass --dir <target directory> (it must not exist yet, or be empty).')
  const target = path.resolve(args.dir)
  if (fs.existsSync(target) && fs.readdirSync(target).length) throw new UserError(`${target} is not empty.`)
  fs.mkdirSync(target, { recursive: true })
  const env = { GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com', GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com' }
  const git = (...a) => run('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', '-c', `core.hooksPath=${path.join(target, '.git', 'no-hooks')}`, ...a], { cwd: target, env: { ...env, GIT_TERMINAL_PROMPT: '0' } })
  git('init', '-q', '-b', 'main')
  fs.cpSync(path.join(dir, 'base'), target, { recursive: true })
  git('add', '-A'); git('commit', '-q', '-m', 'base')
  git('checkout', '-q', '-b', spec.branch || 'feature/change')
  fs.cpSync(path.join(dir, 'change'), target, { recursive: true })
  git('add', '-A'); git('commit', '-q', '-m', spec.commit_message || 'change under review')
  if (fs.existsSync(path.join(dir, 'uncommitted'))) fs.cpSync(path.join(dir, 'uncommitted'), target, { recursive: true })
  // Marker lives inside .git so it is not part of the change; `collect` reads it and tags the run as a benchmark.
  fs.writeFileSync(path.join(target, '.git', 'prr-fixture'), name + '\n')
  console.log(`Fixture "${name}" created at ${fwd(target)} (branch ${spec.branch || 'feature/change'}; ${spec.expected.filter((e) => e.kind === 'bug').length} seeded defects, ${spec.expected.filter((e) => e.kind === 'bait').length} bait).\nNEXT: review it as local changes (collect --target local --cwd "${fwd(target)}"), finish with post --event NONE, then: prr score --run <RUN_DIR>`)
}

export function score(argv) {
  const args = parseArgs(argv)
  const runDir = requireRun(args)
  // Prepared claims, not a review: scoring them against the answer key would record a recall figure nobody earned.
  if (isCalibrationRun(runDir)) throw new UserError(`${fwd(runDir)} is a calibration run: its findings were written by \`prr calibrate\`, not by a lens, so scoring them against the answer key would record a recall figure nobody earned.\nNEXT: prr calibrate --score --run "${fwd(runDir)}"`)
  // Same refusal as `render`: a run that was planned but never put through the engine has nothing to score, and a
  // bare ENOENT for results.json tells the user nothing about what to do next.
  if (!fs.existsSync(path.join(runDir, 'results.json'))) throw new UserError(`No results for this run yet, so there is nothing to score: the review engine has not been run, or its output was never ingested.
NEXT: run the engine, then \`prr render --run "${fwd(runDir)}" --from <the engine's output file>\`, and score it after that.`, { code: 2 })
  const R = prepare(runDir)
  const name = args.fixture || R.ctx.fixture
  if (!name) throw new UserError('This run was not made on a fixture repo (no .git/prr-fixture marker). Pass --fixture <name> to score it anyway.')
  const { spec } = loadFixture(name)
  const tol = spec.tolerance ?? 3
  // `match_in: "title"` narrows the text test to the title — useful for baits, whose neighbours' bodies often mention the
  // same identifiers without being the same claim. `tolerance` can be overridden per entry.
  const hits = (e, f) => { const t = e.tolerance ?? tol
    return f.path === e.path && f.line <= e.lines[1] + t && (f.end_line || f.line) >= e.lines[0] - t && (!e.match || new RegExp(e.match, 'i').test(e.match_in === 'title' ? f.title : `${f.title}\n${f.body || ''}`)) }
  const verified = R.buckets.post.filter((f) => !f.carried)
  const elsewhere = [['verified, but ranked minor (not offered for posting)', (R.buckets.minor || []).filter((f) => !f.skipped_verification)], ['raised, but rated a nit by its own lens and never verified', (R.buckets.minor || []).filter((f) => f.skipped_verification)], ['below the confidence bar', R.buckets.watch], ['refuted by verification', [...R.buckets.refuted, ...R.buckets.pre_existing]], ['verifier failed', R.buckets.unverified]]
  // One finding is credited to ONE answer-key entry (the closest by line; a seeded bug before a bait on a tie), so a
  // single broad finding cannot inflate recall. An entry may keep several findings — duplicates are legitimate.
  const gap = (e, f) => Math.max(0, e.lines[0] - (f.end_line || f.line), f.line - e.lines[1])
  const owner = new Map()
  for (const f of verified) {
    const best = spec.expected.filter((e) => hits(e, f)).sort((a, b) => gap(a, f) - gap(b, f) || (a.kind === 'bug' ? -1 : 1))[0]
    if (best) owner.set(f.id, best.id)
  }
  const used = new Set()
  const rows = spec.expected.map((e) => {
    const found = verified.filter((f) => owner.get(f.id) === e.id)
    found.forEach((f) => used.add(f.id))
    let fate = found.length ? 'verified' : 'never raised'
    if (!found.length) for (const [label, list] of elsewhere) if (list.some((f) => hits(e, f))) { fate = `raised, then ${label}`; break }
    return { ...e, found: found.map((f) => f.id), fate }
  })
  const bugs = rows.filter((r) => r.kind === 'bug'), baits = rows.filter((r) => r.kind === 'bait')
  const foundBugs = bugs.filter((r) => r.found.length), baitHits = baits.filter((r) => r.found.length)
  const extra = verified.filter((f) => !used.has(f.id))
  let usage = null
  try { usage = collectUsage({ runDir, createdAt: R.ctx.created_at }) } catch { /* optional */ }
  const cost = usage && usage.source === 'transcripts' ? usage.totals.cost : null
  const result = { type: 'benchmark', fixture: name, run_id: path.basename(R.ctx.run_dir), profile: R.plan.profile, variant: R.plan.variant || null, tier: R.plan.tier, engine: R.results.engine || 'unknown',
    expected: bugs.length, found: foundBugs.length, recall: bugs.length ? foundBugs.length / bugs.length : null, bait_hits: baitHits.length, false_positives: baitHits.length, extra: extra.length,
    missed: bugs.filter((r) => !r.found.length).map((r) => `${r.id} (${r.fate})`), severity_matches: foundBugs.filter((r) => r.found.some((id) => (verified.find((f) => f.id === id) || {}).severity === r.severity)).length,
    tokens: usage && usage.totals ? usage.totals.tokens ?? null : null, cost, agents: usage && usage.totals ? usage.totals.agents : null }
  writeJson(path.join(runDir, 'score.json'), { ...result, rows, extra: extra.map((f) => ({ id: f.id, path: f.path, line: f.line, title: f.title })) })
  appendEvent(result)

  const L = [`# Benchmark "${name}" — profile ${R.plan.profile}, tier ${R.plan.tier}`, '',
    `**Recall ${foundBugs.length}/${bugs.length}** · bait hits (false positives) ${baitHits.length}/${baits.length} · ${extra.length} unmatched verified finding(s) to judge by hand · severity right on ${result.severity_matches}/${foundBugs.length}${cost != null ? ` · ${result.agents} agents, ${fmtTokens(result.tokens)} tokens ≈ ${fmtCost(cost)} → ${fmtCost(cost / Math.max(1, foundBugs.length))} per seeded bug found` : ''}`, '',
    '| Seeded item | Kind | Where | Result |', '|---|---|---|---|']
  for (const r of rows) L.push(`| ${r.id} | ${r.kind}${r.lens ? ` (${r.lens})` : ''} | \`${r.path}:${r.lines[0]}-${r.lines[1]}\` | ${r.kind === 'bug' ? (r.found.length ? `✅ ${r.found.join(', ')}` : `❌ ${r.fate}`) : r.found.length ? `⚠ reported as ${r.found.join(', ')} — false positive` : `✅ not reported${r.fate !== 'never raised' ? ` (${r.fate})` : ''}`} |`)
  if (extra.length) L.push('', 'Verified findings that match nothing in the answer key (judge these yourself — they may be real):', ...extra.map((f) => `- ${f.id} \`${f.path}:${f.line}\` ${f.title}`))
  L.push('', '"never raised" = a lens missed it (improve the lens or use a deeper profile); "raised, then refuted / below the bar" = verification threw away a real bug (look at that verifier\'s evidence in results.json).', 'Recorded in the metrics log; `prr stats` shows the latest score per fixture, profile and variant. One run is one sample: run-to-run variance is large, so score several runs of each configuration before comparing them.')
  console.log(L.join('\n'))
}
