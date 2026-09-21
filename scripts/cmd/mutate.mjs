// prr mutate — does the selftest notice when a fix is undone?
// Each mutant in evals/mutants.json is one small, deliberate breakage ({ file, from, to }). For every mutant the skill is
// COPIED to a temp directory, the breakage is applied to the copy, and the copy's selftest must FAIL ("killed"). A mutant
// that survives is a behaviour no test protects. The live skill is never touched: a crash or Ctrl-C cannot leave a
// breakage behind in the code that reviews pull requests.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SKILL_DIR, UserError, parseArgs, readJson } from '../lib/util.mjs'

const MUTANTS = path.join(SKILL_DIR, 'evals', 'mutants.json')
// A mutant in one of these is compiled into the generated workflow, so the copy is rebuilt before its selftest runs —
// otherwise the "workflow is stale" check would kill every such mutant for the wrong reason.
const NEEDS_BUILD = /(^|\/)(core\.mjs|review\.workflow\.template\.js)$/

export function loadMutants() {
  const list = (readJson(MUTANTS, { mutants: [] }).mutants || []).filter((m) => m && m.name && m.file && typeof m.from === 'string' && typeof m.to === 'string')
  if (!list.length) throw new UserError(`No mutants found in ${MUTANTS}.`)
  return list
}

// A mutant whose `from` text is gone (or is no longer unique) has silently stopped testing anything.
export function checkMutants(list = loadMutants(), root = SKILL_DIR) {
  const problems = []
  for (const m of list) {
    const file = path.join(root, m.file)
    if (!fs.existsSync(file)) { problems.push(`${m.name}: ${m.file} does not exist`); continue }
    const n = fs.readFileSync(file, 'utf8').split(m.from).length - 1
    if (n !== 1) problems.push(`${m.name}: the text to replace occurs ${n} times in ${m.file} (must be exactly once)`)
    if (m.from === m.to) problems.push(`${m.name}: "from" and "to" are the same`)
  }
  return problems
}

const exec = (cwd, args, timeoutMs) => new Promise((resolve) => {
  const child = spawn(process.execPath, [path.join(cwd, 'scripts', 'prr.mjs'), ...args], { cwd, env: { ...process.env, PRR_MUTATING: '1' } })
  let out = ''
  const timer = setTimeout(() => { out += '\n(timed out)'; child.kill() }, timeoutMs)
  child.stdout.on('data', (d) => { out += d }); child.stderr.on('data', (d) => { out += d })
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, out }) })
  child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out: String(e && e.message) }) })
})

export default async function mutate(argv) {
  const args = parseArgs(argv, { booleans: ['list', 'check', 'keep'] })
  let list = loadMutants()
  if (args.only) { const re = new RegExp(String(args.only), 'i'); list = list.filter((m) => re.test(m.name) || re.test(m.file)) }
  if (args.list) { for (const m of list) console.log(`${m.file.padEnd(44)} ${m.name}`); return }
  const problems = checkMutants(list)
  if (args.check) {
    if (problems.length) { console.log(problems.join('\n')); process.exitCode = 1 } else console.log(`${list.length} mutant(s): every one still applies to exactly one place.`)
    return
  }
  if (problems.length) throw new UserError(`Fix evals/mutants.json first:\n${problems.join('\n')}`)
  if (!list.length) throw new UserError('No mutant matches --only.')

  const jobs = Math.max(1, Math.min(list.length, Number(args.jobs) || Math.min(4, Math.max(1, Math.floor(os.cpus().length / 2)))))
  const timeoutMs = (Number(args.timeout) || 300) * 1000
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prr-mutate-'))
  const copies = Array.from({ length: jobs }, (_, i) => path.join(tmp, `w${i + 1}`))
  try {
    for (const c of copies) fs.cpSync(SKILL_DIR, c, { recursive: true, filter: (src) => path.basename(src) !== '.git' })
    console.log(`${list.length} mutant(s), ${jobs} at a time, on copies under ${tmp}`)
    const base = await exec(copies[0], ['selftest'], timeoutMs)
    if (base.code !== 0) throw new UserError(`The selftest fails BEFORE any mutation — nothing to learn until it is green:\n${base.out.split('\n').slice(-8).join('\n')}`)

    const results = []
    let next = 0
    await Promise.all(copies.map(async (cwd) => {
      while (next < list.length) {
        const m = list[next++]
        const file = path.join(cwd, m.file), orig = fs.readFileSync(file, 'utf8')
        fs.writeFileSync(file, orig.replace(m.from, () => m.to))
        const rebuild = NEEDS_BUILD.test(m.file)
        try {
          if (rebuild) await exec(cwd, ['build-workflow'], timeoutMs)
          const r = await exec(cwd, ['selftest'], timeoutMs)
          const why = r.out.split('\n').find((l) => /AssertionError|SyntaxError|Error:|timed out/.test(l)) || ''
          results.push({ name: m.name, killed: r.code !== 0, why: why.trim().slice(0, 160) })
        } finally {
          fs.writeFileSync(file, orig)
          if (rebuild) await exec(cwd, ['build-workflow'], timeoutMs)
        }
        const last = results[results.length - 1]
        console.log(`${last.killed ? 'killed  ' : 'SURVIVED'} ${last.name}${last.killed && last.why ? `  <- ${last.why}` : ''}`)
      }
    }))
    const survived = results.filter((r) => !r.killed)
    console.log(`\n${results.length - survived.length} killed, ${survived.length} survived.${survived.length ? ` No test notices: ${survived.map((r) => r.name).join('; ')}` : ''}`)
    if (survived.length) process.exitCode = 1
  } finally {
    if (args.keep) console.log(`Copies kept in ${tmp}`)
    else fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 })
  }
}
