// Token usage, measured rather than estimated. Claude Code writes a transcript for every sub-agent (and for the main
// session) with the API's own `usage` block on each response: input, cache-write, cache-read and output tokens, plus the
// model that served it. We find the transcripts that belong to a review run (their prompts name the run directory),
// add them up per agent / stage / model, and price them with pricing.json.
//
// Everything here is best-effort and read-only: the transcript layout is a Claude Code implementation detail, so any
// failure degrades to "usage unknown" and never breaks a review.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { SKILL_DIR, readJson, stripBom } from './util.mjs'

const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude')

// ---- pricing --------------------------------------------------------------------------------------------------------

let PRICING = null
const pricing = () => (PRICING ||= readJson(path.join(SKILL_DIR, 'pricing.json'), { models: {}, families: [], cache_multipliers: { write_5m: 1.25, write_1h: 2, read: 0.1 } }))
// Every printed cost says which prices it was computed with: the date is `as_of` in pricing.json (left out if that is unset).
export const listPrices = () => { const d = String(pricing().as_of || '').trim(); return `API list prices${d ? ` as of ${d}` : ''}` }
export function priceFor(model) {
  pricing()
  const id = String(model || '').toLowerCase()
  const key = Object.keys(PRICING.models).filter((k) => id.startsWith(k)).sort((a, b) => b.length - a.length)[0]
  const p = key ? PRICING.models[key] : (PRICING.families || []).find((f) => new RegExp(f.pattern).test(id))
  if (!p) return null
  const m = PRICING.cache_multipliers
  return { input: p.input, output: p.output, write_5m: p.input * m.write_5m, write_1h: p.input * m.write_1h, cache_read: p.cache_read ?? p.input * m.read, exact: !!key }
}

export function costOf(u, model) {
  if (totalTokens(u) === 0) return 0 // nothing costs nothing, whatever the model
  const p = priceFor(model)
  if (!p) return null
  return (u.input * p.input + u.cache_write_5m * p.write_5m + u.cache_write_1h * p.write_1h + u.cache_read * p.cache_read + u.output * p.output) / 1e6
}

// Sum what can be priced; report the rest as tokens rather than letting one unknown model turn the whole figure into n/a.
function priceAll(byModel) {
  let cost = 0, unpriced = 0
  for (const [m, u] of Object.entries(byModel)) { const c = costOf(u, m); if (c === null) unpriced += totalTokens(u); else cost += c }
  return { cost, unpriced }
}

export const modelAlias = (model) => (/haiku/i.test(model) ? 'haiku' : /sonnet/i.test(model) ? 'sonnet' : /opus/i.test(model) ? 'opus' : /fable|mythos/i.test(model) ? 'fable' : String(model || 'unknown'))

const zero = () => ({ api_calls: 0, tool_calls: 0, input: 0, cache_write_5m: 0, cache_write_1h: 0, cache_read: 0, output: 0 })
const add = (a, b) => { for (const k of Object.keys(zero())) a[k] += b[k] || 0; return a }
export const totalTokens = (u) => u.input + u.cache_write_5m + u.cache_write_1h + u.cache_read + u.output

// ---- transcript parsing ---------------------------------------------------------------------------------------------

function parseLines(file) {
  const out = []
  for (const line of stripBom(fs.readFileSync(file, 'utf8')).split('\n')) {
    if (!line.trim()) continue
    try { out.push(JSON.parse(line)) } catch { /* partial trailing line while the session is live */ }
  }
  return out
}

const textOf = (msg) => {
  const c = msg && msg.content
  if (typeof c === 'string') return c
  return Array.isArray(c) ? c.map((b) => (b && typeof b.text === 'string' ? b.text : '')).join('\n') : ''
}

// One API response can be spread over several transcript lines (one per content block) that share a message id and
// repeat its usage, so usage is keyed by message id: last line wins, output tokens take the max.
function sumUsage(lines, keep) {
  const byId = new Map()
  let tools = 0, first = null, last = null
  for (const l of lines) {
    if (l.type !== 'assistant' || !l.message || !keep(l)) continue
    const ts = Date.parse(l.timestamp)
    if (!Number.isNaN(ts)) { first = first === null ? ts : Math.min(first, ts); last = last === null ? ts : Math.max(last, ts) }
    for (const b of Array.isArray(l.message.content) ? l.message.content : []) if (b && b.type === 'tool_use') tools++
    const u = l.message.usage
    // Claude Code writes placeholder assistant lines for API errors and interruptions (model "<synthetic>", all-zero
    // usage). They are not API responses: count nothing, and do not let an unpriceable "model" null the run's cost.
    if (!u || l.isApiErrorMessage || l.message.model === '<synthetic>') continue
    const id = l.message.id || l.uuid
    const prev = byId.get(id)
    const cc = u.cache_creation || {}
    const w1h = cc.ephemeral_1h_input_tokens || 0
    byId.set(id, { model: l.message.model || (prev && prev.model) || '', input: u.input_tokens || 0,
      cache_write_1h: w1h, cache_write_5m: Math.max(0, (u.cache_creation_input_tokens || 0) - w1h),
      cache_read: u.cache_read_input_tokens || 0, output: Math.max(u.output_tokens || 0, prev ? prev.output : 0) })
  }
  const byModel = {}
  for (const m of byId.values()) add((byModel[m.model] ||= zero()), { ...m, api_calls: 1 })
  return { byModel, tool_calls: tools, first, last }
}

// What was this agent doing? Read it off the prompt: both engines hand agents a task file inside the run directory.
function classify(prompt, label) {
  let m
  if ((m = prompt.match(/tasks\/lens-([a-z-]+?)-(\d+)\.md/))) return { stage: 'lens', lens: m[1], shard: `${m[1]}-${m[2]}` }
  if ((m = prompt.match(/tasks\/verify-([A-Z]\d+)-([a-z]+)\.md/))) return { stage: m[2] === 'tiebreak' ? 'tiebreak' : 'verify', finding: m[1], stance: m[2] }
  if (/adversarially verify the finding below/i.test(prompt)) {
    const stance = (prompt.match(/Your stance: \*\*([a-z]+)\*\*/) || [])[1] || ''
    return { stage: stance === 'tiebreak' ? 'tiebreak' : 'verify', finding: (prompt.match(/"id":\s*"([A-Z]\d+)"/) || [])[1] || '', stance }
  }
  if (/tasks\/brief\.md/.test(prompt)) return { stage: 'brief' }
  if (/tasks\/dedupe\.md/.test(prompt)) return { stage: 'dedupe' }
  if (/tasks\/followup\.md/.test(prompt)) return { stage: 'followup' }
  if (/tasks\/critic\.md/.test(prompt)) return { stage: 'critic' }
  if (/completeness critic flagged/i.test(prompt)) return { stage: 'critic-gap' }
  if (/GitHub MCP tools/i.test(prompt)) return { stage: 'transport' }
  if ((m = String(label || '').match(/^(lens|verify|chore|critic):/))) return { stage: m[1] === 'chore' ? 'chore' : m[1] }
  return { stage: 'other' }
}

function* walk(dir, depth = 0) {
  let entries
  try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) { if (depth < 4) yield* walk(p, depth + 1) } else if (/^agent-.*\.jsonl$/.test(e.name)) yield p
  }
}

// Does the text name THIS run? Run directories started in the same second are told apart by a "-2", "-3" suffix, so a
// plain substring test would credit run "…-local-2" to run "…-local" as well.
function namesRun(text, runName) {
  for (let i = text.indexOf(runName); i !== -1; i = text.indexOf(runName, i + 1)) if (!/[\w-]/.test(text[i + runName.length] || '')) return true
  return false
}

// Find every sub-agent transcript whose opening prompt mentions this run directory.
function findAgentTranscripts(runKey, sinceMs) {
  const projects = path.join(claudeDir(), 'projects')
  const hits = []
  let projectDirs
  try { projectDirs = fs.readdirSync(projects, { withFileTypes: true }).filter((d) => d.isDirectory()) } catch { return hits }
  // One listing per project tells us which sessions were alive during this run: a session that spawned our agents also
  // appended to its own transcript (<session>.jsonl) while doing so. Only those sessions' subagent trees are walked, so
  // the cost follows recent activity, not the lifetime number of sessions. Directory mtimes are no use for this: nested
  // workflow transcripts do not bump them. A session with no main transcript anywhere is walked, to stay on the safe
  // side. (A session can be mirrored under two projects when the cwd changed; either copy being fresh counts.)
  const listing = new Map(), fresh = new Set(), hasMain = new Set()
  for (const proj of projectDirs) {
    let entries
    try { entries = fs.readdirSync(path.join(projects, proj.name), { withFileTypes: true }) } catch { continue }
    listing.set(proj.name, entries.filter((d) => d.isDirectory()))
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue
      const id = e.name.slice(0, -6)
      hasMain.add(id)
      try { if (fs.statSync(path.join(projects, proj.name, e.name)).mtimeMs >= sinceMs) fresh.add(id) } catch { /* unreadable: treat as stale */ }
    }
  }
  for (const proj of projectDirs) {
    for (const s of listing.get(proj.name) || []) {
      if (hasMain.has(s.name) && !fresh.has(s.name)) continue
      const sub = path.join(projects, proj.name, s.name, 'subagents')
      for (const file of walk(sub)) {
        try {
          const fst = fs.statSync(file)
          if (fst.mtimeMs < sinceMs) continue
          const fd = fs.openSync(file, 'r')
          const buf = Buffer.alloc(96 * 1024)
          let n = 0
          try { n = fs.readSync(fd, buf, 0, buf.length, 0) } finally { fs.closeSync(fd) }
          if (buf.toString('utf8', 0, n).includes(runKey)) hits.push({ file, session: s.name, project: path.join(projects, proj.name), size: fst.size, mtimeMs: fst.mtimeMs })
        } catch { /* unreadable: skip */ }
      }
    }
  }
  return hits
}

export function collectUsage({ runDir, createdAt, now = Date.now() }) {
  const runKey = `runs/${path.basename(runDir)}`
  const sinceMs = (Date.parse(createdAt) || now) - 120e3
  const agents = []
  const sessions = new Map()
  // A session can be mirrored under two project directories (the cwd changed mid-session): keep one copy per agent,
  // the most complete one.
  const unique = new Map()
  for (const h of findAgentTranscripts(runKey, sinceMs)) {
    const k = `${h.session}/${path.basename(h.file)}`, cur = unique.get(k)
    if (!cur || h.size > cur.size || (h.size === cur.size && h.mtimeMs > cur.mtimeMs)) unique.set(k, h)
  }
  for (const hit of unique.values()) {
    const lines = parseLines(hit.file)
    // The run directory must be named at the START of one of the opening prompts — that is where both engines put the
    // task reference. An agent that merely quotes a run path deep inside a long prompt is not part
    // of the run.
    const opening = lines.filter((l) => l.type === 'user').slice(0, 3).map((l) => textOf(l.message))
    if (!opening.some((t) => namesRun(t.slice(0, 700), runKey))) continue
    const prompt = opening.join('\n') // membership is decided on the heads; details (finding id, stance) may sit further down
    const meta = readJson(hit.file.replace(/\.jsonl$/, '.meta.json'), {})
    const { byModel, tool_calls, first, last } = sumUsage(lines, () => true)
    const models = Object.keys(byModel)
    if (!models.length) continue
    const model = models.sort((a, b) => totalTokens(byModel[b]) - totalTokens(byModel[a]))[0]
    const u = models.reduce((acc, m) => add(acc, byModel[m]), zero())
    const { cost, unpriced } = priceAll(byModel)
    agents.push({ id: path.basename(hit.file, '.jsonl').replace(/^agent-/, ''), label: meta.description || '', ...classify(prompt, meta.description), model, alias: modelAlias(model),
      ...u, tool_calls, total: totalTokens(u), cost, unpriced_tokens: unpriced, duration_ms: first !== null ? last - first : null, started_at: first })
    sessions.set(hit.session, hit.project)
  }
  agents.sort((a, b) => (a.started_at || 0) - (b.started_at || 0))

  // Orchestrator: the main session's own turns spent on this run. Note that every orchestrator turn re-reads the
  // session's whole context, so a review run from a long-lived session costs far more than one started fresh.
  let orchestrator = null
  for (const [session, project] of sessions) {
    const main = path.join(project, `${session}.jsonl`)
    if (!fs.existsSync(main)) continue
    // Attribute by TURN. A turn starts at a user line that is not just tool results (a real prompt, or a background-task
    // notification). It belongs to this run if Claude Code tagged it with this skill, or if anything in it names the run
    // directory — every prr call after `collect` passes --run <dir>, and workflow notifications echo the args. Turns of
    // unrelated work in the same session are left out. (Claude Code's skill tag alone is not enough: it only marks the
    // turn in which the skill was loaded, and drops after the first background notification.)
    const runId = path.basename(runDir)
    const turns = []
    for (const l of parseLines(main)) {
      if (l.isSidechain) continue
      const ts = Date.parse(l.timestamp)
      if (!(ts >= sinceMs && ts <= now)) continue
      const content = l.message && l.message.content
      const onlyToolResults = Array.isArray(content) && content.length > 0 && content.every((b) => b && b.type === 'tool_result')
      if (l.type === 'user' && !onlyToolResults) turns.push({ lines: [], ours: false })
      if (!turns.length) turns.push({ lines: [], ours: false })
      const turn = turns[turns.length - 1]
      turn.lines.push(l)
      if (turn.ours) continue
      if (l.type === 'assistant' && /(^|:)pr-review$/.test(String(l.attributionSkill || ''))) turn.ours = true
      else if ((l.type === 'assistant' || l.type === 'user') && namesRun(JSON.stringify(content || ''), runId)) turn.ours = true
    }
    const mine = turns.filter((t) => t.ours).flatMap((t) => t.lines)
    const { byModel, tool_calls } = sumUsage(mine, () => true)
    if (Object.keys(byModel).length) {
      orchestrator ||= { stage: 'orchestrator', attribution: 'turns that name this run or carry the skill tag', turns: 0, models: {}, ...zero(), total: 0, cost: 0, unpriced_tokens: 0, tool_calls: 0 }
      for (const [m, u] of Object.entries(byModel)) { add(orchestrator, u); orchestrator.models[m] = (orchestrator.models[m] || 0) + totalTokens(u) }
      const priced = priceAll(byModel)
      orchestrator.cost += priced.cost; orchestrator.unpriced_tokens += priced.unpriced
      orchestrator.turns += turns.filter((t) => t.ours).length; orchestrator.tool_calls += tool_calls; orchestrator.total = totalTokens(orchestrator)
    }
  }

  const group = (keyOf) => {
    const g = {}
    for (const a of agents) {
      const k = keyOf(a), cur = (g[k] ||= { agents: 0, ...zero(), total: 0, cost: 0 })
      cur.agents++; add(cur, a); cur.total += a.total; cur.cost += a.cost || 0
    }
    return g
  }
  const sub = agents.reduce((acc, a) => add(acc, a), zero())
  const subCost = agents.reduce((c, a) => c + (a.cost || 0), 0)
  const unpricedTokens = agents.reduce((n, a) => n + (a.unpriced_tokens || 0), 0)
  const starts = agents.map((a) => a.started_at).filter(Boolean), ends = agents.map((a) => (a.started_at || 0) + (a.duration_ms || 0))
  return {
    v: 1, collected_at: new Date(now).toISOString(), source: agents.length ? 'transcripts' : 'none', run_key: runKey, agents,
    by_stage: group((a) => a.stage), by_model: group((a) => a.alias), by_stage_model: group((a) => `${a.stage}|${a.alias}`), by_lens: group((a) => (a.stage === 'lens' ? a.lens : `(${a.stage})`)),
    orchestrator,
    totals: { agents: agents.length, ...sub, tokens: totalTokens(sub), cost: subCost, unpriced_tokens: unpricedTokens, agent_wall_ms: starts.length ? Math.max(...ends) - Math.min(...starts) : null,
      with_orchestrator: orchestrator ? { tokens: totalTokens(sub) + orchestrator.total, cost: subCost + orchestrator.cost } : null },
  }
}

// Coarse fallback from a Workflow task-output file when transcripts cannot be found. The harness's per-agent `tokens`
// figure is roughly final context size (not billed volume), so it is labelled as such and never priced.
export function usageFromWorkflowOutput(file) {
  const raw = readJson(file, null)
  const prog = raw && Array.isArray(raw.workflowProgress) ? raw.workflowProgress.filter((p) => p.type === 'workflow_agent') : []
  if (!prog.length) return null
  return { v: 1, source: 'workflow-progress', coarse: true, note: 'context-size counter from the workflow harness; not billed tokens, not priced',
    agents: prog.map((p) => ({ id: p.agentId, label: p.label, ...classify(p.promptPreview || '', p.label), model: p.model, alias: modelAlias(p.model), context_tokens: p.tokens, tool_calls: p.toolCalls, duration_ms: p.durationMs })),
    totals: { agents: prog.length, context_tokens: raw.totalTokens ?? null, tool_calls: raw.totalToolCalls ?? null } }
}

export const fmtTokens = (n) => (n == null ? '?' : n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : String(n))
export const fmtCost = (c) => (c == null ? 'n/a' : c >= 10 ? `$${c.toFixed(0)}` : `$${c.toFixed(2)}`)

export function usageLine(u) {
  if (!u || u.source === 'none') return 'Usage: not measurable (no sub-agent transcripts found for this run)'
  if (u.coarse) return `Usage (coarse): ${u.totals.agents} agents · ~${fmtTokens(u.totals.context_tokens)} context tokens (harness counter; not billed volume)`
  const t = u.totals, o = u.orchestrator
  const models = Object.entries(u.by_model).sort((a, b) => (b[1].cost || 0) - (a[1].cost || 0)).map(([m, v]) => `${m} ${fmtCost(v.cost)}`).join(', ')
  return `Usage: ${t.agents} sub-agents · ${fmtTokens(t.tokens)} tokens (fresh in ${fmtTokens(t.input + t.cache_write_5m + t.cache_write_1h)} · cache reads ${fmtTokens(t.cache_read)} · out ${fmtTokens(t.output)}) · ≈ ${fmtCost(t.cost)} at ${listPrices()} (${models})${t.unpriced_tokens ? ` + ${fmtTokens(t.unpriced_tokens)} tokens on a model missing from pricing.json` : ''}${o ? ` · orchestrator so far ≈ ${fmtCost(o.cost)} over ${o.turns} turn(s)` : ''}`
}
