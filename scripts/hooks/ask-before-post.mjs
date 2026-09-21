#!/usr/bin/env node
// Optional Claude Code hook (PreToolUse, matcher "Bash"): makes the permission prompt appear for every `prr post` that
// would really publish a review, whatever the permission mode and whatever the model believes the user said earlier.
// SKILL.md tells the orchestrator to ask first; this hook is what makes that unskippable. Installation: README.md,
// "Hard enforcement". It never blocks anything else, and it fails open (no output) on input it does not understand.
import process from 'node:process'

let raw = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => { raw += d })
process.stdin.on('end', () => {
  let command = ''
  try { command = String((JSON.parse(raw).tool_input || {}).command || '') } catch { return }
  const decision = decide(command)
  if (decision) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: decision } }))
})

// Exported shape kept trivial so the selftest can drive it through stdin like Claude Code does.
function decide(command) {
  // `prr post`, however the CLI is spelled: prr.mjs" post, prr post, node …/prr.mjs post
  if (!/\bprr(\.mjs)?["']?\s+post\b/.test(command)) return null
  if (/--dry-run\b|--record-only\b/.test(command)) return null
  const event = (command.match(/--event[=\s]+["']?([A-Za-z_]+)/) || [])[1] || ''
  if (event.toUpperCase() === 'NONE') return null
  return `pr-review is about to publish a ${event.toUpperCase() || 'review'} on GitHub in your name. Allow only if you chose this action for this review.`
}
