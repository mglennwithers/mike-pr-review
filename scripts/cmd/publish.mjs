// prr render / post — show the traffic-light report, then (only after the user has chosen) post and record.
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { UserError, parseArgs, readJson, requireRun, truncate, writeJson, writeText } from '../lib/util.mjs'
import { applyInlineCap, githubComment, githubSummary, prepare, setScrub, terminalReport } from '../lib/report.mjs'
import { api, detectTransport } from '../lib/github.mjs'
import { saveState, stateKey, statePath } from '../lib/state.mjs'
import { collectUsage, usageFromWorkflowOutput, usageLine } from '../lib/usage.mjs'
import { appendEvent, readEvents, runRecord } from '../lib/metrics.mjs'

// Measure what the run has cost so far from Claude Code's own transcripts. Never allowed to fail a review.
function measure(runDir, ctx) {
  try {
    let usage = collectUsage({ runDir, createdAt: ctx.created_at })
    if (usage.source === 'none') {
      const hint = readJson(path.join(runDir, 'workflow-output.json'), null)
      usage = (hint && hint.file && usageFromWorkflowOutput(hint.file)) || usage
    }
    writeJson(path.join(runDir, 'usage.json'), usage)
    return usage
  } catch (e) { return { source: 'none', error: String(e && e.message) } }
}

export async function render(argv) {
  const args = parseArgs(argv)
  const runDir = requireRun(args)
  // `render --from <workflow output file>` ingests first: one orchestrator turn instead of two.
  if (args.from) (await import('./engine.mjs')).ingest(['--run', runDir, '--from', String(args.from)])
  if (!fs.existsSync(path.join(runDir, 'results.json'))) throw new UserError(`No results for this run yet: the review engine has not been run, or its output was never ingested.\nNEXT: run the engine (SKILL.md step 4), then \`prr render --run "${runDir.split(path.sep).join('/')}" --from <the engine's output file>\`.`, { code: 2 })
  const R = prepare(runDir)
  const report = terminalReport(R) + '\n' + usageLine(measure(runDir, R.ctx))
  writeText(path.join(runDir, 'report.md'), report + '\n')
  writeJson(path.join(runDir, 'review.json'), { light: R.light, recommend: R.recommend, because: R.because, legal: R.legal, blockers: R.blockers, stats: R.stats,
    post: R.buckets.post.map((f) => ({ id: f.id, fp: f.fp, severity: f.severity, path: f.path, line: f.line, title: f.title, confidence: f.confidence, inline: f.inline !== false })) })
  console.log(report)
  // Posting is bound to THIS report: `post` wants the token below, so a post cannot happen without the report having been
  // rendered in its current form (a speed bump for the orchestrator, e.g. after a context compaction — not proof of
  // consent; README.md shows the hook that makes the question unskippable).
  if (R.ctx.mode !== 'pr') console.log(`NEXT (local review, nothing can be posted): ask the user what they want done with the findings (SKILL.md step 6), then record the review with \`prr post --run "${R.ctx.run_dir}" --event NONE\` [--dismiss Fxx for findings they call wrong] and run \`prr cleanup --run "${R.ctx.run_dir}"\`.`)
  if (R.ctx.mode === 'pr' && R.legal.length) {
    const approval = { token: crypto.randomBytes(4).toString('hex'), basis: approvalBasis(R) }
    writeJson(path.join(runDir, 'approval.json'), approval)
    console.log(`TO POST: show this report, then ASK the user which action they want (SKILL.md step 6) — never infer it. Pass their choice to \`prr post\` with --approval ${approval.token}`)
  }
}

// What the user is approving: this head, these postable findings. If either changes, the old approval is void.
const approvalBasis = (R) => [R.ctx.pr && R.ctx.pr.head_sha, ...R.buckets.post.map((f) => f.fp).sort()].join(',')

function selectItems(R, include, exclude) {
  let items = R.buckets.post
  // A minor finding is never posted by default but may be asked for by id — unless it skipped verification: nothing
  // unverified is ever posted, whatever the user types.
  // A finding we posted before, resolved on GitHub, confirmed again but judged older than this range: postable by id when
  // its confirming verifiers clear the posting bar (its stored confidence is capped for being pre-existing, so ask the votes).
  const clears = (f) => { const c = (f.votes || []).filter((v) => v.verdict === 'confirmed'); return f.severity !== 'drop' && c.length > 0 && c.reduce((s, v) => s + (Number(v.confidence) || 0), 0) / c.length >= R.plan.thresholds.post }
  const byId = [...R.buckets.post, ...R.buckets.minor.filter((f) => !f.skipped_verification), ...R.buckets.pre_existing.filter((f) => f.reintroduced && clears(f))]
  const inc = String(include || 'all').toLowerCase()
  if (inc === 'none') items = []
  else if (inc === 'red') items = items.filter((f) => f.severity === 'red')
  else if (inc !== 'all') { const ids = new Set(inc.toUpperCase().split(',').map((s) => s.trim())); items = byId.filter((f) => ids.has(f.id)) }
  const ex = new Set(String(exclude || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean))
  return items.filter((f) => !ex.has(f.id))
}

export async function post(argv) {
  const args = parseArgs(argv, { booleans: ['dry_run', 'record_only', 'use_git_credential'] })
  const runDir = requireRun(args)
  const R = prepare(runDir)
  const { ctx, state } = R
  setScrub(ctx)
  const event = String(args.event || '').toUpperCase()
  if (!['APPROVE', 'COMMENT', 'REQUEST_CHANGES', 'NONE'].includes(event)) throw new UserError('Pass --event APPROVE | COMMENT | REQUEST_CHANGES | NONE (NONE records the review without posting).')
  const asked = String(args.include || '').toUpperCase().split(',').map((s) => s.trim())
  const unpostable = R.buckets.minor.filter((f) => f.skipped_verification && asked.includes(f.id)).map((f) => f.id)
  if (unpostable.length && event !== 'NONE') throw new UserError(`${unpostable.join(', ')} was never verified (its own lens rated it a nit), and unverified findings are never posted. Re-run with a deeper profile if it deserves a verdict.`)
  const items = event === 'NONE' ? [] : applyInlineCap(selectItems(R, args.include, args.exclude), R.plan.thresholds.max_inline_yellow)
  const chosen = new Set(items.map((f) => f.fp))
  const left = R.buckets.post.filter((f) => !chosen.has(f.fp))
  // Validate --dismiss up front: nothing may throw between a successful post and recording it.
  const toDismiss = String(args.dismiss || '').toUpperCase().split(',').map((s) => s.trim()).filter(Boolean).map((id) => {
    const f = [...R.buckets.post, ...R.buckets.minor, ...R.buckets.watch, ...R.buckets.unverified].find((x) => x.id === id)
    if (!f) throw new UserError(`--dismiss ${id}: no such finding in this run.`)
    if (chosen.has(f.fp)) throw new UserError(`${id} is both selected for posting and dismissed; pick one.`)
    return f
  })

  let reviewId = null, commentIds = {}, posted = false, demoted = false
  if (event !== 'NONE') {
    if (ctx.mode !== 'pr') throw new UserError('Local reviews have nothing to post to. Use --event NONE to record the review.')
    if (!R.legal.includes(event)) throw new UserError(`${event} is not possible here: ${R.blockers.join('; ') || 'not a legal event'}. Legal: ${R.legal.join(', ') || 'none'}.`)
    if (!args.record_only && event !== 'APPROVE' && !items.length && !args.body) throw new UserError(`${event} with no findings selected would post an empty review. Choose APPROVE, NONE, or include findings.`)
    const inline = items.filter((f) => f.inline !== false)
    const payload = {
      commit_id: ctx.pr.head_sha, event,
      body: githubSummary(R, event, items, { notes: !(event === 'APPROVE' && !items.length) }) ,
      comments: inline.map((f) => ({ path: f.path, line: f.line, side: 'RIGHT', ...(f.start_line ? { start_line: f.start_line, start_side: 'RIGHT' } : {}), body: githubComment(f) })),
    }
    if (args.body) payload.body = String(args.body) + '\n\n' + payload.body
    writeJson(path.join(runDir, 'review-payload.json'), payload)
    if (!args.dry_run && !args.record_only) {
      const approval = readJson(path.join(runDir, 'approval.json'), null)
      if (!approval || !args.approval || String(args.approval) !== approval.token) throw new UserError(`Posting needs --approval <token>: the token \`prr render\` prints under the report. It ties the post to a report that was actually rendered (and shown to the user). Render, ask the user which action they want, then post with the token.`, { code: 10 })
      if (approval.basis !== approvalBasis(R)) throw new UserError('The findings or the PR head changed since the report was rendered, so that approval no longer covers what would be posted. Run `prr render` again, show the user the new report, and ask again.', { code: 10 })
    }
    if (args.dry_run) { console.log(`DRY RUN — payload written to ${ctx.run_dir}/review-payload.json (${payload.comments.length} inline comment(s), body ${payload.body.length} chars). Nothing posted, nothing recorded.`); return }

    if (!args.record_only) {
      const t = detectTransport(ctx.repo.host, { useGitCredential: !!args.use_git_credential || !!ctx.use_git_credential })
      if (!t.canWrite) throw new UserError(`No authenticated GitHub transport (gh CLI or GH_TOKEN). The ready-to-post payload is at ${ctx.run_dir}/review-payload.json.\nNEXT: follow "MCP posting path" in references/github-transport.md, then run this command again with --record-only so the review is remembered.`, { code: 4 })
      const base = `repos/${ctx.repo.owner}/${ctx.repo.name}/pulls/${ctx.pr.number}`
      const live = await api(t, 'GET', base)
      if (live.state !== 'open') throw new UserError(`PR is now ${live.merged ? 'merged' : live.state}; not posting.`, { code: 5 })
      if (live.head.sha !== ctx.pr.head_sha) throw new UserError(`HEAD_MOVED: the PR head is now ${live.head.sha.slice(0, 8)} but this review covered ${ctx.pr.head_sha.slice(0, 8)}. Nothing was posted. Record this run with --event NONE, then re-run the review: it will be incremental and carry these findings forward.`, { code: 5 })
      let res
      try { res = await api(t, 'POST', `${base}/reviews`, { body: payload }) } catch (e) {
        // One unresolvable anchor rejects the whole review. Retry once with every finding folded into the summary.
        if (e.status !== 422 || !payload.comments.length || !/line|diff|position|path/i.test(e.message)) throw e
        demoted = true
        const flat = items.map((f) => ({ ...f, inline: false }))
        res = await api(t, 'POST', `${base}/reviews`, { body: { ...payload, comments: [], body: githubSummary(R, event, flat) } })
      }
      reviewId = res.id; posted = true
      try {
        for (const c of await api(t, 'GET', `${base}/reviews/${reviewId}/comments?per_page=100`)) {
          const m = (c.body || '').match(/pr-review:fp=([0-9a-f]+)/)
          if (m) commentIds[m[1]] = c.id
        }
      } catch { /* ids are a nicety */ }
    } else posted = true
  }

  // ---- record ----
  const now = new Date().toISOString()
  // Enough of each finding is kept for a later follow-up agent to judge "was this fixed?" without guessing from a title.
  const remember = (f, extra) => ({ fp: f.fp, path: f.path, line: f.line, anchor: f.anchor || '', title: f.title, summary: truncate(f.body, 400), scenario: truncate(f.scenario, 300),
    severity: f.severity, category: f.category, confidence: f.confidence, first_seen: state.findings[f.fp]?.first_seen || ctx.range.to, ...extra })
  for (const f of items) state.findings[f.fp] = remember(f, { status: posted ? 'posted' : 'pending', posted_at: posted ? now : null, comment_id: commentIds[f.fp] || null, data: posted ? undefined : strip(f) })
  // Left out of this post = "not now": stays pending and is offered again next time. Only --dismiss silences a finding
  // for good, so a finding is never lost just because the user posted a subset.
  for (const f of left) state.findings[f.fp] = remember(f, { status: 'pending', data: strip(f) })
  for (const f of toDismiss) state.findings[f.fp] = remember(f, { status: 'dismissed', data: undefined })
  for (const p of R.priorOpen) if (p.follow && p.follow.status === 'addressed' && state.findings[p.fp]) state.findings[p.fp].status = 'addressed'
  state.reviews.push({ at: now, head: ctx.mode === 'pr' ? ctx.pr.head_sha : ctx.local.head_sha, tree: ctx.range.tree || null, base: ctx.range.full_from, range: { from: ctx.range.from, to: ctx.range.to },
    run_dir: ctx.run_dir, profile: R.plan.profile, tier: R.plan.tier, light: R.light, event: event === 'NONE' ? null : event, posted, review_id: reviewId, posted_fps: posted ? items.map((f) => f.fp) : [] })
  try { saveState(state) } catch (e) {
    if (!posted || args.record_only) throw e
    // The review IS on GitHub. Dying here with a stack trace invites the one thing that must not happen: running `post`
    // again, which would put every comment on the PR a second time. Say what happened and how to record it safely.
    throw new UserError(`POSTED_NOT_RECORDED: the ${event} review${reviewId ? ` (id ${reviewId})` : ''} was posted to ${ctx.pr.url}, but recording it failed: ${e && e.message}\n` +
      `Do NOT run post again — that would post every comment a second time.\n` +
      `NEXT: fix the cause (is ${path.dirname(statePath(state.key))} writable? is the disk full?), then record without posting:\n` +
      `  prr post --run "${ctx.run_dir}" --event ${event}${args.include ? ` --include ${args.include}` : ''}${args.exclude ? ` --exclude ${args.exclude}` : ''}${args.dismiss ? ` --dismiss ${args.dismiss}` : ''} --record-only\n` +
      `(Even without that, the next review of this PR recovers the posted findings from the markers inside the comments.)`, { code: 8 })
  }

  // ---- metrics (local log; see lib/metrics.mjs). Wrapped so that bookkeeping can never undo a successful post. ----
  let usage = null
  try {
    usage = measure(runDir, ctx)
    const key = stateKey(ctx)
    const earlier = readEvents().filter((e) => e.type === 'run' && e.run_id === path.basename(ctx.run_dir)).pop()
    appendEvent(runRecord(R, { event, postedFps: new Set(posted ? items.map((f) => f.fp) : []), dismissedFps: new Set(toDismiss.map((f) => f.fp)), usage,
      prior: new Map(((earlier && earlier.findings) || []).filter((f) => f && f.fp).map((f) => [f.fp, f])) }))
    // What became of findings from earlier reviews of this PR — the closest thing to ground truth we get for free.
    for (const p of R.priorOpen) if (p.follow) appendEvent({ type: 'outcome', source: 'followup', key, fp: p.fp, severity: p.severity, category: p.category || '', was: p.status, outcome: p.follow.status, run_id: path.basename(ctx.run_dir) })
    for (const f of toDismiss) appendEvent({ type: 'outcome', source: 'user', key, fp: f.fp, severity: f.severity, category: f.category, lenses: f.lenses || [], outcome: 'dismissed', run_id: path.basename(ctx.run_dir) })
  } catch { /* ignore */ }

  const bits = [posted ? `Posted ${event} review${reviewId ? ` (id ${reviewId})` : ''}: ${items.filter((f) => f.inline !== false && !demoted).length} inline comment(s) + summary${demoted ? ' — GitHub rejected an inline anchor, so all findings were placed in the summary instead' : ''}.` : 'Nothing posted.',
    `Recorded review of ${ctx.range.to.slice(0, 8)}; ${Object.values(state.findings).filter((f) => f.status === 'pending').length} pending, ${Object.values(state.findings).filter((f) => f.status === 'dismissed').length} dismissed finding(s) remembered.`]
  if (posted && ctx.pr) bits.push(ctx.pr.url)
  if (usage) bits.push(usageLine(usage))
  console.log(bits.join('\n'))
}

const strip = (f) => { const { votes, tests, carried, inline, why, start_line, ...keep } = f; return keep }
