// prr build-workflow — the Workflow runtime cannot import modules, so the shared logic in lib/core.mjs is inlined into
// the workflow script. One source of truth, two engines. `--check` verifies the generated file is current.
import fs from 'node:fs'
import path from 'node:path'
import { SKILL_DIR, UserError, parseArgs } from '../lib/util.mjs'

export function generate() {
  const template = fs.readFileSync(path.join(SKILL_DIR, 'workflows', 'review.workflow.template.js'), 'utf8')
  const core = fs.readFileSync(path.join(SKILL_DIR, 'scripts', 'lib', 'core.mjs'), 'utf8')
    .replace(/^export\s+(?=(const|let|function|async function|class)\b)/gm, '')
  if (/\bimport\s|\bDate\.now\(|Math\.random\(|new Date\(\s*\)/.test(core)) throw new UserError('lib/core.mjs must stay free of imports and non-deterministic calls (the Workflow runtime forbids them).')
  if (!template.includes('/*__CORE__*/')) throw new UserError('Template is missing the /*__CORE__*/ marker.')
  return template.replace('/*__CORE__*/', `// ---- inlined from scripts/lib/core.mjs ${'-'.repeat(78)}\n${core.trim()}\n// ---- end of inlined core ${'-'.repeat(92)}`)
}

export default function buildWorkflow(argv) {
  const args = parseArgs(argv, { booleans: ['check'] })
  const out = path.join(SKILL_DIR, 'workflows', 'review.workflow.js')
  const next = generate()
  if (args.check) {
    const cur = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : ''
    if (cur !== next) throw new UserError('workflows/review.workflow.js is stale. Run: node scripts/prr.mjs build-workflow')
    return console.log('workflow script is up to date')
  }
  fs.writeFileSync(out, next)
  console.log(`wrote ${out} (${next.length} bytes)`)
}
