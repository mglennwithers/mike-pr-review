// prr reply — answer a human who replied to one of our review comments. Reviews that never answer a rebuttal train
// people to ignore them: the finding comes back next run, unchanged, as if nobody had spoken. The follow-up agent has
// already read the reply and written its assessment; this posts ONE reply into that thread, with the same discipline as
// posting a review — the user chooses the text and nothing goes out without the approval token `render` printed.
import path from 'node:path'
import { UserError, fwd, parseArgs, readJson, requireRun, truncate, writeJson } from '../lib/util.mjs'
import { prepare, scrubText } from '../lib/report.mjs'
import { api, detectTransport } from '../lib/github.mjs'
import { saveState } from '../lib/state.mjs'

// One reply per thread per run: the state remembers which threads we have answered, so a re-run cannot say it twice.
export default async function reply(argv) {
  const args = parseArgs(argv, { booleans: ['dry_run', 'list', 'force', 'use_git_credential'] })
  const runDir = requireRun(args)
  const R = prepare(runDir)
  const { ctx, state } = R
  if (ctx.mode !== 'pr') throw new UserError('Replies belong to a pull request thread; a local review has none.')

  // Only findings a human actually answered can be replied to, and only where we know which comment to answer.
  const answerable = R.priorOpen.filter((p) => (p.replies || []).length && p.comment_id)
  if (args.list || !args.fp) {
    if (!answerable.length) return console.log('Nobody has replied to a comment from this review yet.')
    const L = ['Threads somebody replied to (answer one with: prr reply --run <dir> --fp <fp> --body "<text>" --approval <token>):', '']
    for (const p of answerable) {
      const last = p.replies[p.replies.length - 1]
      const answered = (state.findings[p.fp] || {}).replied_at
      L.push(`${p.fp}  ${p.path}:${p.line}  ${truncate(p.title, 70)}`)
      L.push(`   @${last.user}: ${truncate(String(last.body).replace(/\s+/g, ' '), 200)}`)
      if (p.follow && p.follow.status === 'disputed') L.push(`   follow-up: ${truncate(p.follow.note || '', 220)}`)
      L.push(answered ? `   already answered by this reviewer at ${answered}` : '   not answered yet')
    }
    return console.log(L.join('\n'))
  }

  const target = answerable.find((p) => p.fp === args.fp) || R.priorOpen.find((p) => p.fp === args.fp)
  if (!target) throw new UserError(`No earlier finding with fingerprint ${args.fp} in this run. List what can be answered: prr reply --run "${fwd(runDir)}" --list`)
  if (!target.comment_id) throw new UserError(`${args.fp} has no recorded comment id, so there is no thread to answer. It was probably folded into the summary rather than posted inline.`)
  if (!(target.replies || []).length) throw new UserError(`Nobody has replied to ${args.fp}; there is nothing to answer. A new point belongs in the next review, not in an old thread.`)
  const body = String(args.body || '').trim()
  if (!body) throw new UserError('Pass --body "<text>": the reply is yours to write. The follow-up agent\'s assessment is a starting point, not something to send unread (see it with --list).')

  const already = (state.findings[target.fp] || {}).replied_at
  if (already && !args.force) throw new UserError(`This reviewer already answered ${args.fp} at ${already}. Answering twice in one thread is how a review turns into an argument; pass --force if the thread really has moved on.`)

  // Agent-written text may have gone into the body, so it is scrubbed exactly like a posted finding.
  const text = scrubText(ctx, body)
  const payload = { body: text, in_reply_to: target.comment_id }
  writeJson(path.join(runDir, 'reply-payload.json'), { fp: target.fp, ...payload })
  if (args.dry_run) return console.log(`DRY RUN — reply to comment ${target.comment_id} (${target.path}:${target.line}) written to ${ctx.run_dir}/reply-payload.json. Nothing posted.\n\n${text}`)

  const approval = readJson(path.join(runDir, 'approval.json'), null)
  if (!approval || !args.approval || String(args.approval) !== approval.token) {
    throw new UserError(`Replying needs --approval <token>, the token \`prr render\` prints under the report: a reply is published in the user's name exactly as a review comment is. Render the report, show the user the reply you propose, and send it only after they choose to.`, { code: 10 })
  }
  const t = detectTransport(ctx.repo.host, { useGitCredential: !!args.use_git_credential || !!ctx.use_git_credential })
  if (!t.canWrite) throw new UserError(`No authenticated GitHub transport (gh CLI or GH_TOKEN); the reply is ready at ${ctx.run_dir}/reply-payload.json.`, { code: 4 })
  const base = `repos/${ctx.repo.owner}/${ctx.repo.name}/pulls/${ctx.pr.number}`
  const live = await api(t, 'GET', base)
  if (live.state !== 'open') throw new UserError(`PR is now ${live.merged ? 'merged' : live.state}; not replying.`, { code: 5 })
  const res = await api(t, 'POST', `${base}/comments/${target.comment_id}/replies`, { body: { body: text } })

  const f = state.findings[target.fp]
  if (f) {
    f.replied_at = new Date().toISOString()
    f.reply_comment_id = res.id || null
    try { saveState(state) } catch (e) {
      throw new UserError(`POSTED_NOT_RECORDED: the reply is on ${ctx.pr.url} (comment ${res.id}), but recording it failed: ${e && e.message}\nDo NOT run reply again — the thread would get the same answer twice.`, { code: 8 })
    }
  }
  console.log(`Replied in ${target.path}:${target.line} (comment ${res.id}): ${truncate(text.replace(/\s+/g, ' '), 120)}\n${ctx.pr.url}`)
  if (f) console.log(`Recorded, so a re-review will not answer this thread again. If the reply conceded the point, drop the finding too: prr state dismiss --run "${fwd(runDir)}" --fp ${target.fp}`)
}
