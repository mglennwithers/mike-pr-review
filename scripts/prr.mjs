#!/usr/bin/env node
// pr-review helper CLI. Every deterministic step of a review lives here so the orchestrating model only makes judgement
// calls. Usage: node prr.mjs <command> [--flags]
import fs from 'node:fs'
import path from 'node:path'
import { HOME_DIR, SKILL_DIR, UserError, parseArgs, readJson, requireRun, writeJson } from './lib/util.mjs'

const HELP = `pr-review helper
  start     <collect flags> <plan flags>                                            collect, then plan (one call instead of two)
  collect   --target <PR#|URL|owner/repo#N|current-pr|local> [--scope all|uncommitted|staged|branch] [--base <ref>] [--full] [--force] [--cwd <dir>]
            [--pr-json <file> --comments-json <file>] [--use-git-credential] [--allow-host <host>] [--no-worktree]   gather diff, metadata, state → run dir
  plan      --run <dir> [--profile lean|standard|deep|max] [--tier <t>] [--lenses a,b] [--add-lenses a] [--skip-lenses a] [--no-tests] [--trust-code] [--no-critical-upgrade] [--verify-floor N]
            [--confirmed] [--quiet]                                                 --confirmed: the user agreed to a plan that printed CONFIRM_SPEND (exit 9)
  ingest    --run <dir> --from <workflow output file>                              Workflow engine → results.json
  lenses    --run <dir>                                                            Agent engine: lens agents to start (plan + the brief agent's lens advice)
  merge     --run <dir>                                                            Agent engine: lens outputs → candidates + verify tasks
  aggregate --run <dir> [--skip-tiebreak] [--skip-escalation]                      Agent engine: verdicts → results.json
  render    --run <dir> [--from <workflow output file>]                            (ingest, then) traffic-light report + recommendation
  post      --run <dir> --event APPROVE|COMMENT|REQUEST_CHANGES|NONE [--include all|red|none|F01,F02] [--exclude F03] [--dismiss F04]
            [--body "<extra text>"] [--approval <token printed by render>] [--dry-run] [--record-only] [--use-git-credential]
  cleanup   --run <dir>                                                            remove the run's worktree
  state     show|reset|dismiss|undismiss --run <dir> | --key <state key> [--fp <fingerprint>]
  usage     --run <dir> [--json]                                                   measured tokens and cost of a run, per sub-agent
  stats     [--since 30d] [--profile p] [--repo o/r] [--mode pr|local] [--include-fixtures] [--json]   cost and effectiveness across all recorded reviews
  fixture   --name <fixture> --dir <empty dir>                                     create a seeded-bug benchmark repo
  score     --run <dir> [--fixture name]                                           recall / precision of a run against the fixture's answer key
  calibrate --dir <empty dir> [--fixture shop] [--profile p] [--claims <file>] [--quiet]   does verification discriminate? claims of known truth through the real verifiers
            --score --run <dir>                                                    score one: exits 1 if a known-false claim ended postable
  profiles                                                                         list budget profiles
  build-workflow [--check]                                                         regenerate workflows/review.workflow.js from its template + lib/core.mjs (--check: only verify it is current)
  selftest  [--show]                                                               run the offline self-test (--show prints the sample report)
  version                                                                          print the skill's version (the VERSION file)
  trust     list | add <login> [--repo owner/name] | remove <login> [--repo owner/name]   whose same-repo PR branches may have their tests run (default: only your own)
  mutate    [--only <regex>] [--jobs N] [--timeout <seconds>] [--list] [--check] [--keep]   undo each behaviour in evals/mutants.json on a COPY; the selftest must fail`

async function main() {
  if (Number(process.versions.node.split('.')[0]) < 18) { console.error(`pr-review needs Node 18 or newer (found ${process.version}).`); process.exit(1) }
  const [cmd, ...rest] = process.argv.slice(2)
  switch (cmd) {
    case 'collect': return (await import('./cmd/collect.mjs')).default(rest)
    // collect + plan in one call. Every orchestrator turn re-reads the whole conversation, so one turn fewer is real
    // money in a long session. Both commands ignore each other's flags; plan is skipped when there is nothing new.
    case 'start': {
      const c = await (await import('./cmd/collect.mjs')).default(rest)
      if (c.nothingNew) return
      console.log('')
      return (await import('./cmd/plan.mjs')).default([...rest, '--run', c.runDir])
    }
    case 'plan': return (await import('./cmd/plan.mjs')).default(rest)
    case 'ingest': return (await import('./cmd/engine.mjs')).ingest(rest)
    case 'lenses': return (await import('./cmd/engine.mjs')).lenses(rest)
    case 'merge': return (await import('./cmd/engine.mjs')).merge(rest)
    case 'aggregate': return (await import('./cmd/engine.mjs')).aggregate(rest)
    case 'render': return (await import('./cmd/publish.mjs')).render(rest)
    case 'post': return (await import('./cmd/publish.mjs')).post(rest)
    case 'cleanup': {
      const runDir = requireRun(parseArgs(rest))
      const wt = (await import('./cmd/collect.mjs')).cleanupRun(runDir)
      return console.log(`Removed worktree ${wt} (run files kept for reference).`)
    }
    case 'state': return stateCmd(rest)
    case 'stats': return (await import('./cmd/stats.mjs')).default(rest)
    case 'fixture': return (await import('./cmd/bench.mjs')).fixture(rest)
    case 'score': return (await import('./cmd/bench.mjs')).score(rest)
    case 'calibrate': return (await import('./cmd/calibrate.mjs')).default(rest)
    case 'usage': {
      const U = await import('./lib/usage.mjs')
      const a = parseArgs(rest, { booleans: ['json'] })
      const runDir = requireRun(a)
      const u = U.collectUsage({ runDir, createdAt: readJson(path.join(runDir, 'context.json')).created_at })
      if (a.json) return console.log(JSON.stringify(u, null, 2))
      console.log(U.usageLine(u))
      for (const x of u.agents || []) console.log(`  ${(x.stage + (x.lens ? ':' + x.lens : '') + (x.finding ? ':' + x.finding + ':' + x.stance : '')).padEnd(28)} ${x.alias.padEnd(7)} ${String(x.api_calls).padStart(3)} calls  ${U.fmtTokens(x.total).padStart(7)}  out ${U.fmtTokens(x.output).padStart(5)}  ${U.fmtCost(x.cost).padStart(6)}  ${x.duration_ms ? Math.round(x.duration_ms / 1000) + 's' : ''}`)
      return
    }
    case 'profiles': {
      const cfg = readJson(path.join(SKILL_DIR, 'profiles.json'))
      for (const [name, p] of Object.entries(cfg.profiles)) console.log(`${name === cfg.default ? '*' : ' '} ${name.padEnd(9)} ${p.label}\n            ${p.when}`)
      return
    }
    case 'build-workflow': return (await import('./cmd/build-workflow.mjs')).default(rest)
    case 'selftest': return (await import('./cmd/selftest.mjs')).default(rest)
    case 'mutate': return (await import('./cmd/mutate.mjs')).default(rest)
    case 'version': case '--version': return console.log(fs.readFileSync(path.join(SKILL_DIR, 'VERSION'), 'utf8').trim())
    case 'trust': {
      const a = parseArgs(rest), [action, login] = a._ || []
      const file = path.join(HOME_DIR, 'config.json'), cfg = readJson(file, {}) || {}
      const t = (cfg.trusted_authors = cfg.trusted_authors || {}), key = a.repo ? String(a.repo) : '*'
      if (action === 'list' || !action) return console.log(Object.keys(t).length ? Object.entries(t).map(([k, v]) => `${k === '*' ? 'any repository' : k}: ${v.join(', ') || '(nobody)'}`).join('\n') : 'Nobody is trusted: tests run only for your own PRs and your own local work.')
      if (!login || !['add', 'remove'].includes(action)) throw new UserError('Usage: prr trust list | add <login> [--repo owner/name] | remove <login> [--repo owner/name]')
      const set = new Set(t[key] || [])
      if (action === 'add') set.add(login); else set.delete(login)
      t[key] = Array.from(set).sort()
      if (!t[key].length) delete t[key]
      writeJson(file, cfg)
      return console.log(action === 'add' ? `Verifiers may now run the code of @${login}'s same-repo PR branches${a.repo ? ` in ${a.repo}` : ' in any repository'}. Fork PRs still need --trust-code.` : `@${login} removed.`)
    }
    default: console.log(HELP); if (cmd && cmd !== 'help' && cmd !== '--help') process.exitCode = 1
  }
}

async function stateCmd(argv) {
  const S = await import('./lib/state.mjs')
  const args = parseArgs(argv)
  const action = args._[0] || 'show'
  let key = args.key
  if (!key && args.run) key = S.stateKey(readJson(path.join(requireRun(args), 'context.json')))
  if (!key) {
    const dir = path.join(HOME_DIR, 'state')
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []
    return console.log(files.length ? files.map((f) => readJson(path.join(dir, f)).key).join('\n') : 'No review state recorded yet.')
  }
  const state = S.loadState(key)
  if (action === 'show') return console.log(JSON.stringify({ key: state.key, reviews: state.reviews, findings: Object.values(state.findings).map(({ data, ...f }) => f) }, null, 2))
  if (action === 'reset') { fs.rmSync(S.statePath(key), { force: true }); return console.log(`Forgot all review state for ${key}. (Markers already posted on a PR will be re-learned on the next run.)`) }
  if (action === 'dismiss' || action === 'undismiss') {
    const f = state.findings[args.fp]
    if (!f) throw new UserError(`No finding with fingerprint ${args.fp} in ${key}`)
    f.status = action === 'dismiss' ? 'dismissed' : 'pending'
    S.saveState(state)
    return console.log(`${args.fp} → ${f.status}`)
  }
  throw new UserError(`Unknown state action "${action}"`)
}

main().catch((e) => {
  if (e instanceof UserError) { console.error(`ERROR: ${e.message}`); process.exitCode = e.exitCode || 1 }
  else { console.error(e && e.stack ? e.stack : String(e)); process.exitCode = 1 }
})
