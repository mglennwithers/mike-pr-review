# pr-review

A Claude Code skill that reviews a GitHub pull request, or your local changes, through a set of specialised review lenses run as sub-agents.
Every finding is then attacked by separate verifier agents (which run tests where that is allowed), and only findings that survive are shown as postable, in a traffic-light report.
Nothing is posted to GitHub until you have seen the report and chosen an action — a rule the orchestrating model follows, and one you can enforce in code with the optional hook (see [Safety](#safety)). Reviews are remembered, so a re-review covers only new commits and never repeats a comment.

Verifiers may **run the code under review** — only your own work and authors you have explicitly trusted — as you, with your network access and credentials within reach, and there is no sandbox. Read [Safety](#safety) before your first review of somebody else's pull request.

Invoke it with `/pr-review [target] [options]`, or ask Claude to review a PR or your changes.

```
/pr-review 482                      review PR #482 of the repository you are in (incremental if reviewed before)
/pr-review https://github.com/o/r/pull/7 --profile deep
/pr-review                          review local work: branch commits + uncommitted + untracked files
/pr-review local --scope staged     only what is staged
/pr-review local --profile lean     cheapest useful review of local work
/pr-review 482 --full               ignore the review history and look at the whole PR again
```

Targets: a PR number, `#123`, a PR URL, `owner/repo#123`, `current-pr` (the open PR of the current branch), or `local` with `--scope all|uncommitted|staged|branch` and an optional `--base <ref>`.

## Requirements

| What | Notes |
|---|---|
| Node.js 18 or newer on `PATH` | The CLI (`scripts/prr.mjs`) has no dependencies; there is nothing to `npm install`. It refuses to start on older Node versions. |
| git 2.28 or newer on `PATH` | All diffs are computed locally with git. |
| GitHub access (PR mode only) | The GitHub CLI `gh`, installed and logged in (`gh auth login`), is optional but recommended: it handles SSO, GitHub Enterprise, private repositories and proxies. Alternatives: a token in `GH_TOKEN` or `GITHUB_TOKEN`; without either, public repositories can still be read anonymously, but nothing can be posted. Local reviews need no GitHub access at all. |
| Claude Code with skills, the Agent tool and `AskUserQuestion` | The skill text refers to its CLI as `${CLAUDE_SKILL_DIR}/scripts/prr.mjs`, which Claude Code substitutes when it loads the skill. On a version that does not, `SKILL.md` tells the orchestrator to use the skill's base directory as Claude Code reports it; if commands still fail with a literal `${CLAUDE_SKILL_DIR}` in them, update Claude Code. |
| The Workflow tool (preferred, optional) | When it is available the fan-out runs as a background workflow (`workflows/review.workflow.js`) at no orchestrator token cost. Without it, the skill drives the same pipeline through Agent-tool calls (`references/agent-engine.md`). |
| Model aliases `haiku`, `sonnet`, `opus` | `profiles.json` names sub-agent models by these aliases and they must resolve in your Claude Code setup. The planner's model ranking and its estimate know only these three names. The `lean` profile uses no Opus sub-agent. |
| python3 | Only for the `ledger` benchmark fixture, whose tests the verifiers may run. Nothing else uses Python. |

**The orchestrator model.** The `SKILL.md` frontmatter pins `model: opus` for the orchestrating session. If you have no Opus access, or do not want to pay for it, change that line to `model: inherit` (the skill then runs on whatever model your session uses) and use `--profile lean`, which is the profile tuned for a Sonnet orchestrator. `prr plan` prints which orchestrator a profile is tuned for. It also prints a warning when `CLAUDE_CODE_SUBAGENT_MODEL` is set, because that variable may override the per-agent models the profiles rely on.

## Install

Clone or copy this repository into one of:

- `~/.claude/skills/pr-review` (on Windows: `%USERPROFILE%\.claude\skills\pr-review`): available in every project;
- `<project>/.claude/skills/pr-review`: available in that project only. Review data still goes to the state home (see [Configuration](#configuration)), not into the project.

macOS, Linux, Git Bash:
```
git clone <repository URL> ~/.claude/skills/pr-review
node ~/.claude/skills/pr-review/scripts/prr.mjs selftest
```
Windows PowerShell (`~` is not expanded for native commands there):
```
git clone <repository URL> $env:USERPROFILE\.claude\skills\pr-review
node $env:USERPROFILE\.claude\skills\pr-review\scripts\prr.mjs selftest
```

Keep the folder name `pr-review`, the same as `name:` in `SKILL.md`: `/pr-review` is the slash command, and the usage measurement looks for that skill name in Claude Code's transcripts. The scripts find their own location, so the skill works from any directory.

The selftest is offline (no model, no network; posting is exercised against a fake GitHub server on 127.0.0.1) and uses only temporary directories. It prints one `ok N - …` line per group and ends with `All N self-test groups passed.` If it fails on your machine, fix that before running a review. Start a new Claude Code session if `/pr-review` is not offered afterwards.

`node scripts/prr.mjs version` prints the installed version (file `VERSION`; changes are listed in `CHANGELOG.md`).

## Permissions

What the skill needs from Claude Code's permission system:

- **Bash:** the orchestrator runs `node "<skill dir>/scripts/prr.mjs" <command> …` for every step.
- **Read:** sub-agents read the skill directory (`lenses/*.md`, `references/*.md`) and the run directory `<state home>/runs/<run>/` (task files, patches, and `wt/`, the checkout of the code under review).
- **Write:** sub-agents write their results into the run directory (`brief.md`, `scratch/`, temporary `prr_tmp_*` test files inside `wt/`, and — with the Agent-tool engine — the result files `brief.result.json`, `merge.json`, `dedupe.json`, `followup.json`, `critic.json`, `lens/*.json` and `verdicts/*.json`).
- **Bash, in sub-agents:** `git -C "<run>/wt" show <base>:<path>` to read old file versions, and, when running code is allowed, test commands of the project under review. The latter cannot be listed in advance.

The state home is `~/.claude/pr-review` unless you moved it (see [Configuration](#configuration)).

A starting point for `~/.claude/settings.json` (or a project's `.claude/settings.json`). Replace the placeholders with absolute paths, using forward slashes:

```json
{
  "permissions": {
    "allow": [
      "Bash(node \"/ABSOLUTE/PATH/TO/.claude/skills/pr-review/scripts/prr.mjs\":*)",
      "Read(~/.claude/skills/pr-review/**)",
      "Read(~/.claude/pr-review/**)",
      "Edit(~/.claude/pr-review/runs/**)"
    ],
    "additionalDirectories": [
      "/ABSOLUTE/PATH/TO/.claude/skills/pr-review",
      "/ABSOLUTE/PATH/TO/.claude/pr-review"
    ]
  }
}
```

Treat this as a sketch and check the rule syntax against the permission documentation of your Claude Code version: how Bash rules match a quoted command, how absolute and `~` paths are written in `Read`/`Edit` rules and in `additionalDirectories`, and whether `Edit` rules cover the Write tool are the details to verify. The reliable way to get the Bash rule right is to run the first review, and when Claude Code asks about the `node …/prr.mjs` command, allow it permanently from the prompt.

The snippet above is the intended minimum; it has not been verified under a locked-down permission setup, so treat the first review on one as a test and expect to adjust it. In particular, sub-agents started in the background may not be able to show a permission prompt; if lens or verifier agents fail on a locked-down setup, the report says ⚪ INCOMPLETE rather than green, and missing permissions are the first thing to check. `--no-tests` removes the need for verifiers to run project commands.

## First review

1. **Selftest.** `node scripts/prr.mjs selftest` (see [Install](#install)).
2. **A sandbox review that cannot post anything.** Build the small seeded-bug repository and review it as local work:
   ```
   node scripts/prr.mjs fixture --name shop --dir <an empty temporary directory>
   ```
   Open Claude Code in that directory and run `/pr-review local --profile lean`. In local mode there is no GitHub target, so nothing can be posted. You will see the plan with its estimate, the traffic-light report, a `Usage:` line with the measured token use, and a question about what to do next. Afterwards `node scripts/prr.mjs score --run <run dir>` compares the result with the fixture's answer key.
3. **A real PR, looking before spending.** From a clone of the repository under review (so `--cwd .` points at it, while the script itself lives in the skill directory):
   ```
   node ~/.claude/skills/pr-review/scripts/prr.mjs start --target <PR number or URL> --cwd .
   ```
   `start` collects the diff and prints the plan: tier, lenses, models, estimated sub-agents and estimated spend. It starts no model and costs no tokens. When you run the review through `/pr-review`, the same plan is shown before the engine starts.
4. **Seeing exactly what would be posted.** After a review, `node scripts/prr.mjs post --run <run dir> --event COMMENT --dry-run` writes the exact GitHub payload to `<run dir>/review-payload.json` and posts nothing. You can also ask Claude for a dry run at the approval question.

`node scripts/prr.mjs cleanup --run <run dir>` removes a run's checkout; old runs are tidied automatically (see [What it stores and sends](#what-it-stores-and-sends)).

## What it costs and how to keep it cheap

A review is many model calls: one lens agent per lens and shard, one or more verifier agents per finding, a few cheap chore agents, and the orchestrator's own turns. How much that is depends on the size of the change, the profile and how many findings need verifying. No typical figures are given here; the tool tells you, before and after:

- **Before:** `prr start` / `prr plan` print the number of sub-agents per model and an `Estimated spend` line with two figures: if findings need verifying, and if the change turns out clean. The estimate uses built-in per-agent starting averages until your own metrics log holds three or more agents of a kind (stage and model); from then on it uses your averages, scaled by how much each agent has to read.
- **After:** the report ends with a `Usage:` line measured from Claude Code's sub-agent transcripts; `prr usage --run <dir>` lists every agent; `prr stats` rolls up all recorded reviews.

All dollar figures are API list-price equivalents of measured tokens, computed with `pricing.json` (check its `as_of` date against the provider's current price list and edit it when prices change). On a subscription plan nothing is billed per token: what a review consumes there is your plan's usage allowance, and the dollar figure is only a yardstick for comparing profiles, lenses and runs.

Ways to spend less:

- **Profile.** `--profile lean` is the cheapest useful review; `standard` is the default; `deep` and `max` cost considerably more by design. `PR_REVIEW_PROFILE=lean` in your environment makes `lean` your default. See [Budget profiles](#budget-profiles).
- **Tier.** The planner sizes the review to the change: fewer lenses and cheaper models on small changes, sharding on big ones. `--tier` forces a tier.
- **The small-change single pass.** In `lean` and `standard`, a small change (at most `small_change.max_lines` effective lines, default 100) that touches no critical area is reviewed by one combined `quick-scan` agent instead of several lenses. Its findings are verified like any others.
- **Fewer lenses.** `--lenses a,b` runs exactly those; `--skip-lenses a` drops one. On a big change this does not always lower the agent count: lenses freed from the budget allow finer shards. The plan's `Shards:` line says when that applies; a leaner profile is the dependable saving.
- **`--verify-floor N`.** Should-fix findings that their own lens rates below N are listed as minor without being verified (and can then never be posted). Off by default because it trades recall for cost.
- **The spend gate.** When the estimate exceeds `confirm_above` in `profiles.json` (default: `{ "cost": 15, "agents": 40 }`, i.e. 15 USD at list prices or 40 sub-agents), or the profile is `max`, `prr plan` prints `CONFIRM_SPEND`, withholds the engine arguments and exits 9 until it is run again with `--confirmed`. The skill asks you first. Lower the two numbers to be asked earlier; remove a key to switch that limit off.
- **Orchestrator turns are extra.** The estimate covers sub-agents only. Every orchestrator turn re-reads the whole conversation, so a review started from a long-running session costs more than the same review in a fresh one, and on a small review the orchestrator can cost more than all sub-agents together. Start reviews in a fresh session. Once three reviews with a measured orchestrator share are logged, the plan prints what orchestrator turns have been costing you. The skill combines steps (`prr start`, `prr render --from`) to keep the number of turns down.
- **When code cannot be run** (fork PRs, `--no-tests`), a blocking finding cannot be settled by reproducing it, so in the profiles with escalating verification (`standard`, `deep`) the remaining verifier stances always run. `--no-tests` is a safety switch, not a saving.

**Explicit invocation only.** The skill's description makes Claude start it on requests such as "review this" or "take a look at my changes". If you want it to run only when you type `/pr-review`, add this line to the `SKILL.md` frontmatter:

```yaml
disable-model-invocation: true
```

## How it works

```
collect ──► plan ──► lenses ──► dedupe ──► adversarial verify ──► render ──► ASK ──► post + record
 script     script   sub-agents  script+     sub-agents            script    you     script
                     (Sonnet/    Haiku       (refute / reproduce /
                      Haiku)                  impact, tiebreak)
```

| Piece | Where | Cost |
|---|---|---|
| Git diffs, incremental range, snapshot worktree, risk signals, sizing, sharding, task files, dedupe maths, confidence aggregation, line-anchor repair, report and GitHub payload, posting, state | `scripts/` (Node, no dependencies) | zero tokens |
| Reading the code through one concern each: 14 focused lenses, a combined `hygiene` lens and the single-pass `quick-scan` lens in `lenses/` | sub-agents on the profile's lens model | Sonnet / Haiku (Opus in `deep` and `max`) |
| Trying to refute or reproduce every finding (`references/verifier.md`), running tests in a throwaway worktree when the code is trusted | sub-agents on the profile's verify models | Sonnet / Haiku, Opus tiebreak |
| Intent brief, grouping findings with one root cause, "was this already said?" dedupe, follow-up on earlier findings | chore sub-agents | Haiku |
| Plan sanity check, sanity check of blocking findings, recommendation, talking to you | the orchestrator (`model:` in the `SKILL.md` frontmatter) | your session, a few turns |

Two interchangeable engines run the fan-out: the **Workflow tool** (`workflows/review.workflow.js`: deterministic, schema-validated, runs in the background; preferred) or plain **Agent-tool** calls (`references/agent-engine.md`). Both hand sub-agents the same generated task files and use the same logic from `scripts/lib/core.mjs`, which `prr build-workflow` inlines into the workflow script (the selftest fails if the generated file is stale).

Sub-agents get a path to a task file, never the instructions themselves, and exchange results through files in the run directory, so little passes through the orchestrator's context. A lens or chore agent that returns nothing usable is retried once.

**Before verification**, candidates from different lenses that point at the same spot are merged by the script; from `merge_duplicates.min_candidates` candidates up, a chore agent also groups candidates that share a root cause. The brief agent, the first reader of the actual diff, may drop lenses that only a keyword woke and add up to two standby lenses. It can never drop a core lens, a lens you asked for, or all of them, and whatever it changed is printed in the report.

## Budget profiles

Defined in `profiles.json`; `node scripts/prr.mjs profiles` lists them. Edit the file to tune them.

| Profile | Tuned for orchestrator | Lenses | Verification | Extras |
|---|---|---|---|---|
| `lean` | Sonnet | Haiku for trivial and small changes (security, correctness and the single pass move to Sonnet when a critical area is touched), Sonnet above; the docs, dependency, conventions and infra-config lenses always on Haiku; at most 5 lenses, 6 lens agents | one vote per finding (Sonnet for 🔴, Haiku for 🟡, Sonnet for 🟡 on large changes); only quick test runs; no tiebreak | brief from medium changes up, duplicate merge, history dedupe, follow-up |
| **`standard`** (default) | Opus | Sonnet throughout, Haiku for trivial changes and for the docs and dependency lenses; up to 16 lens agents | 🔴: `reproduce` first, then `refute` (plus `impact` on large and huge changes) unless the failure was proven by running code; 🟡: `refute` on Sonnet, on Haiku for housekeeping findings and findings their lens rates as minor; one vote per finding on trivial changes; Opus tiebreak when verifiers disagree on a 🔴 | as `lean`, brief from small changes up |
| `deep` | Opus | Sonnet, with Opus for security, correctness, concurrency and data-migrations when a critical area is touched; up to 32 lens agents | 🔴: three stances including an Opus `impact` verifier (escalating); 🟡: two stances; Opus tiebreak | as `standard`, brief always; completeness critic on Sonnet, one round (not on trivial changes) |
| `max` | Opus | Opus on the core lenses; up to 48 lens agents | every stance always runs, on Opus for 🔴 | as `deep`, with the critic on Opus for up to two rounds; always needs `--confirmed` |

In `lean` and `standard` the four housekeeping lenses (maintainability, types, docs-comments, conventions) run as one combined `hygiene` lens when two or more of them would run.

**Tiers.** `prr collect` computes *effective lines*: (added + 0.3 × deleted) weighted by file kind (lockfiles, vendored, generated and binary files 0; docs 0.25; tests 0.5; unrecognised files 0.5; config 0.6; code 1; dependency manifests 1; infra 1.25; migrations and CI 1.5). Default tier bounds in `profiles.json`: trivial ≤ 25 lines in ≤ 3 files, small ≤ 150, medium ≤ 600, large ≤ 2000, huge above. Risk signals (regex heuristics over paths and added lines: auth, crypto, money, injection, SQL, migrations, schema, CI, secrets, and others in `scripts/lib/classify.mjs`) add points; `tiers.risk_bump` points (default 4) raise the tier one step, up to large, and a change that touches a critical area (auth, crypto, money, migrations, CI, secrets) or carries any signal worth two or more points is never treated as trivial. The tier decides how many lenses wake up and how the diff is sharded; the profile decides models and verification depth.

**Escalating verification** (`verify.escalate`): a blocking finding is first given to the `reproduce` verifier alone. If that verifier confirms it and proves the failure by running code, the finding is settled; otherwise the remaining stances run, and a disagreement goes to the tiebreak model. `max` always runs every stance.

## Confidence, importance and the traffic light

Every verifier returns a confidence that the finding is real, introduced by this change and worth the author's time, scored on the rubric in `references/verifier.md`. The votes are folded deterministically (`aggregateVerdicts` in `scripts/lib/core.mjs`): a finding confirmed and reproduced by running code is lifted to at least 90; confirmed-and-refuted votes cap it at 70 until a tiebreak rules; a finding judged pre-existing is capped at 40; a verifier may downgrade the severity but never raise it above what the lens claimed.

- Confidence ≥ `thresholds.post` (default 80) is **postable**.
- `thresholds.show` (50) up to the posting bar is shown to you under "below the confidence bar" and never posted.
- The rest is listed as refuted. A finding whose verifiers all failed is listed as *could not be verified*, never as refuted.

Confidence says a finding is *true*. Verifiers also score **importance** (does it matter?) on a second rubric. A verified should-fix finding under `thresholds.min_importance` (30) is listed as *minor* and not offered for posting; you can still post it by id (`--include F07`). Only the `thresholds.max_inline_yellow` (6) most important should-fix findings become inline comments; the rest are one line each in the summary comment. Blocking findings are never filtered or folded.

🔴 blocking · 🟡 should fix · 🟢 the lens ran and nothing survived verification · ⚪ the lens did not run, or only partly. Nothing is dropped silently: skipped lenses, candidates over the profile's cap, partial coverage and failed chores are all printed. A review with holes in it (a lens or verifier that failed) carries an "Incomplete review" warning, is headed ⚪ INCOMPLETE where it would otherwise be green, and never recommends approval.

The report ends with `RECOMMENDED_ACTION=` and `LEGAL_EVENTS=`. On your own PR and on drafts only `COMMENT` is legal.

## Memory

Review state lives in `<state home>/state/` (one JSON file per PR, or per repository and branch for local reviews) **and** in hidden HTML markers inside the posted comments (`<!-- pr-review:fp=… -->` per finding, `<!-- pr-review:state {...} -->` at the end of the summary), so it survives a lost file or a different machine.

- Each run records the reviewed head commit. The next run reviews only `last..head`, filtered to the PR's own lines if the base branch was merged in. After a force-push it falls back to a full review and relies on fingerprints. If nothing changed, `collect` says `NOTHING_NEW` and exits 2.
- A finding's fingerprint is a hash of its path and the text of the line it is anchored to, so it is stable across line shifts and rebases. Posted: never posted again. Dismissed by you (`--dismiss`): never raised again. Verified but not posted (you chose "Don't post", left it out, or the PR head moved): stays *pending* and is carried into the next PR review until it is posted, dismissed or fixed. Local reviews always cover the whole change, so they carry nothing, except a pending finding the lenses raise again, which is shown as carried over instead of being hidden as a duplicate of itself.
- Markers are believed only on comments written by the reviewing account. If that identity is unknown (anonymous transport) they are ignored, so nobody can plant "already reviewed" markers to hide commits.
- In PR mode a chore agent compares new candidates with everybody's existing PR comments, so the review does not repeat what a person or another bot already said.
- Earlier findings are re-checked on each incremental review and reported as addressed, partly addressed, still open or unclear. A finding that verifies again although every review thread the skill opened about it was resolved is flagged **REINTRODUCED** and offered for posting again. The duplicate-check chore may flag this; independently of any model, the script flags it whenever every thread the skill opened for that fingerprint is resolved on GitHub and the finding verified again. When thread states cannot be read, the report says so.
- A finding that is real but older than the commits under review is listed as *pre-existing* and not offered for posting. If it is one that was posted earlier and whose thread was resolved, it can be posted again by id, provided its confirming verifiers clear the posting bar.
- If the brief, the duplicate check, the root-cause merge, the follow-up agent or the completeness critic fails after its retry, the report says so instead of reading "nothing found".
- The state file is written atomically under a lock file (`<file>.lock`; a lock left by a killed process is taken over after 15 seconds). When two sessions save the same PR's state, the later save merges the earlier one and the stronger fact wins (posted > dismissed > addressed > pending), so a posted finding cannot fall back to pending and be posted twice. A state file that cannot be read is set aside as `*.unreadable-<timestamp>` with a warning, never silently replaced.
- If the review reaches GitHub but the state cannot be saved, `post` exits 8 (`POSTED_NOT_RECORDED`) and prints the exact `--record-only` command to run once the cause is fixed. Do not run `post` again in that situation.
- `prr state show|reset|dismiss|undismiss` inspects or edits the memory (`--run <dir>` or `--key <key>`, `--fp <fingerprint>`); without arguments it lists the known keys.

Every finished review is also appended to a local metrics log; see `references/metrics.md` and [Benchmarks](#benchmarks). Usage is measured, not estimated: the scripts read the usage blocks in Claude Code's sub-agent transcripts. The transcript layout is a Claude Code implementation detail; where it cannot be read, the `Usage:` line falls back to a coarse counter from the workflow output, or to "not measurable", and the review itself is unaffected.

## Safety

What the scripts enforce:

- **Approval token.** In PR mode `prr render` prints a random token tied to this run's reviewed head and its set of postable findings. `prr post` refuses to publish without `--approval <token>`, and the token stops matching when that set changes (exit 10); a PR head that moved on GitHub since `collect` is caught separately by the live check before posting (exit 5). `--event NONE` (record without posting), `--dry-run` and `--record-only` need no token. The token guarantees that a post follows a report that was actually rendered in its current form. It does not prove that you were asked; see [Hard enforcement](#hard-enforcement).
- **Spend gate.** Above the `confirm_above` limits, or with the `max` profile, `prr plan` prints `CONFIRM_SPEND` instead of the engine arguments and exits 9 until it is re-run with `--confirmed`; `prr lenses` (Agent-tool engine) refuses the same way.
- **Code execution is limited to code you can be assumed to trust.** Verifiers may run code only for: your own PR (its author is the authenticated account), a same-repository PR whose author is on your trust list, and your own local work. `prr trust add <login> [--repo owner/name]`, `prr trust remove …` and `prr trust list` manage the list (stored in `<state home>/config.json`; by default nobody is on it). Other people's fork PRs (also when their author is on the list), other people's PRs whose source repository is unknown, same-repository branches of authors not on the list, and PRs on a host accepted through `--allow-host` are read but not run. A **local branch that contains commits by other people** is not run either: for the scopes that include commits, the commit author e-mails are compared with the identity git would commit with, and any other address switches execution off (uncommitted and staged work counts as yours). That check catches the ordinary case of a checked-out colleague's branch; an author e-mail is whatever the committer typed, so it is not protection against a forged identity. `--trust-code` on `plan` overrides all of this for one review, `--no-tests` switches execution off; the `collect` summary always states `Code execution: allowed / NOT allowed` and why.
- **Your working copy is not touched** (unless you pass `collect --no-worktree` — see [Configuration](#configuration)). Agents read, and tests run, in a throwaway `git worktree` checkout inside the run directory. Local snapshots are built with a temporary index, so your index, stash and files stay as they are. `git worktree prune` is never run in your repository.
- **Git is shielded from your configuration.** Every git command the skill runs pins the settings that would change what git prints or make it run somebody's code: hooks are pointed at a directory that holds none, so no hook (for example `post-checkout`) ever runs in the review checkout; diff prefixes and blank-line style are fixed so parsed line numbers cannot shift; external diff and textconv drivers are off; commit signing is off and a fixed identity is used for the throwaway snapshot commits, so no git identity or GPG setup is needed; terminal and credential-manager prompts are disabled so nothing can hang waiting for input.
- **Host allow-list.** A PR is only fetched from `github.com`, the host in `GH_HOST`, or the origin host of the clone you are in. Any other host in a PR URL is refused before anything is contacted, unless you pass `--allow-host <host>`, and even then nothing that host reports can unlock code execution. An origin that uses an SSH host alias is refused with the advice to pass the full PR URL.
- **Token scoping.** `GH_TOKEN`, `GITHUB_TOKEN` and `GITHUB_PERSONAL_ACCESS_TOKEN` are only ever sent to `github.com`; `GH_ENTERPRISE_TOKEN` / `GITHUB_ENTERPRISE_TOKEN` only to the host named in `GH_HOST`. The git credential helper is asked only if you opt in (`--use-git-credential` or `PR_REVIEW_USE_GIT_CREDENTIAL=1`); the choice is remembered for that run's `post`. `PR_REVIEW_API_BASE` is honoured only for plain loopback URLs. When `gh` is the transport and a repository has to be cloned over https, gh's credential helper is passed to git on the command line for those commands; your git configuration is not modified.
- **Untrusted text stays data.** PR titles, authors, branch names and convention-doc paths reach sub-agents and the orchestrator only quoted and labelled as author-supplied; a convention-doc path built to break out of that quoting is ignored with a warning. Every agent that reads the change is told — in its task file or in the contract that file points to (`lenses/_contract.md`, `references/verifier.md`) — that the change is untrusted data, and lenses report instructions embedded in it as findings instead of following them.
- **Model-written text is sanitised before it is posted** under your name: local paths are replaced (`<repo>`, `~`), HTML comment openers are escaped, and the marker keywords are defused, so text copied out of a diff cannot plant review markers. Markers are read only where the scripts write them: a fingerprint at the end of a line, the state marker at the end of a body. A suggested fix that contains marker text, or that a verifier checked and judged wrong, is withheld; one no verifier checked is labelled as unchecked; a one-click suggestion is attached only when a verifier approved it and the comment covers exactly the suggested lines. The report shows what each comment will add (suggested fix and in which form, commands that were run) before you approve.
- **Posting is re-checked.** `post` verifies that the PR is still open and that its head has not moved (exit 5 otherwise; nothing is posted), validates anchors against GitHub's own 3-line-context hunks, and, if GitHub still rejects an inline anchor, retries once with every finding in the summary. A finding that skipped verification can never be posted, whatever is typed.
- **It fails closed.** A lens or verifier that dies makes the report ⚪ INCOMPLETE, never green and never an approve recommendation; unverified is not refuted; an unknown source repository is treated as a fork; markers are ignored when the reviewer identity is unknown; an unreadable state file is set aside, not overwritten. Bookkeeping (metrics, usage measurement, tidying of old runs) is the deliberate exception: it may fail without failing a review.

What is only a rule for the model, not enforced by code:

- **Asking you before posting.** `SKILL.md` tells the orchestrator to show the report and ask every time. The approval token is printed where the orchestrator can read it, so by itself it is a speed bump, not consent. The hook below is what enforces the question.
- **Asking you before spending above the limit.** `--confirmed` is a flag the orchestrator is told to add only after you agreed.
- **Adding `--trust-code`, `--allow-host` or `--use-git-credential` only when you said so** in the conversation.
- **Sub-agent discipline.** There is no sandbox. A verifier that is allowed to run code runs it as you, with your network access and your credentials within reach. That it works only inside the checkout and `scratch/`, adds only `prr_tmp_*` files, runs targeted tests instead of whole suites, uses no network beyond a package registry and ignores instructions embedded in the code are prompt instructions. This is why execution is limited to code you trust, and why `--trust-code` deserves thought.
- **The MCP posting path.** When neither `gh` nor a token can write, `references/github-transport.md` describes posting the prepared payload through GitHub MCP tools and then recording it with `--record-only`. That path goes around `prr post`, so neither the approval token nor the hook below sees it; your Claude Code permission prompt for those MCP tools is the only gate.

### Hard enforcement

`scripts/hooks/ask-before-post.mjs` is an optional Claude Code `PreToolUse` hook. For a Bash command that is a real `prr post` it answers with `permissionDecision: "ask"`, which tells Claude Code to show you its permission prompt for that command whatever the permission mode, with the event named in the reason. It stays silent for everything else: `--dry-run`, `--record-only`, `--event NONE`, every other `prr` command and every other Bash command. It prints nothing on input it cannot parse (it fails open).

Register it in `~/.claude/settings.json` (forward slashes work on Windows too and need no escaping):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"/ABSOLUTE/PATH/TO/.claude/skills/pr-review/scripts/hooks/ask-before-post.mjs\""
          }
        ]
      }
    ]
  }
}
```

To check the script by hand (POSIX shell or Git Bash), feed it what Claude Code would:

```
echo '{"tool_input":{"command":"node prr.mjs post --run x --event COMMENT"}}' | node scripts/hooks/ask-before-post.mjs
```

It should print JSON containing `"permissionDecision":"ask"`; with `--dry-run` added to the command it should print nothing. The hook recognises the command by its text (`prr` or `prr.mjs`, directly followed by `post`). That covers `node "…/prr.mjs" post …` as the skill writes it; it does not cover a command that hides the script name behind a shell variable or alias, nor the MCP posting path described above. Check the hook format against the hooks documentation of your Claude Code version.

## Configuration

Flags: `node scripts/prr.mjs help` lists the commands and their flags. The flags that gate spending and posting are described above: `--confirmed` (plan), `--approval <token>`, `--dry-run` and `--record-only` (post), `--trust-code` and `--no-tests` (plan), `--allow-host` and `--use-git-credential` (collect). Two flags exist for tests and unusual environments: `collect --no-worktree` skips the throwaway checkout, so agents read (and, if allowed, run tests in) the repository as it is checked out — the promise that your working copy is never touched no longer holds; `plan --quiet` writes `plan.json` and the task files without printing the plan.

Environment variables read by the scripts:

| Variable | Default | Effect |
|---|---|---|
| `PR_REVIEW_HOME` | unset | The state home: where runs, review memory, metrics, cached clones and `config.json` live. A relative path is resolved against the current directory. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code's configuration directory. Used twice: the state home defaults to `<CLAUDE_CONFIG_DIR>/pr-review`, and usage measurement reads transcripts under `<CLAUDE_CONFIG_DIR>/projects`. |
| `PR_REVIEW_PROFILE` | unset (`default` in `profiles.json`, shipped as `standard`) | Your default budget profile. `--profile` wins over it. |
| `PR_REVIEW_METRICS` | on | `off`, `0`, `false` or `no` stops writing to the metrics log. What is already in the log is still read; with an empty log, estimates stay on the built-in starting averages and `prr stats` has nothing to show. |
| `PR_REVIEW_RUN` | unset | Run directory used when a command is given no `--run`. |
| `PR_REVIEW_USE_GIT_CREDENTIAL` | unset | `1` is the same as `--use-git-credential`: if neither `gh` nor an environment token is available, ask git's credential helper for a token for the PR's host. |
| `GH_TOKEN`, `GITHUB_TOKEN`, `GITHUB_PERSONAL_ACCESS_TOKEN` | unset | Token transport for `github.com` (first one set wins, in this order). Never sent to any other host. |
| `GH_HOST` | unset | Your GitHub Enterprise host. Adds it to the hosts a PR may be fetched from, and is the only host that receives the enterprise token. |
| `GH_ENTERPRISE_TOKEN`, `GITHUB_ENTERPRISE_TOKEN` | unset | Token transport for the host named in `GH_HOST`. |
| `CLAUDE_CODE_SUBAGENT_MODEL` | unset | Not used by the scripts; `prr plan` prints a warning when it is set, because it may override the per-agent models of the profile. |
| `HTTPS_PROXY`, `HTTP_PROXY` (also lower case) | unset | Not used; only read to add a hint to the error message when a token-transport request fails (see [Platform notes](#platform-notes)). |
| `PR_REVIEW_TRANSPORT` | unset | Test and troubleshooting hook. `token` skips the `gh` CLI even when it is installed. |
| `PR_REVIEW_API_BASE` | unset | Test hook. Points the token transport at a fake GitHub API. Honoured only for `http://127.0.0.1…` and `http://localhost…`; anything else is ignored. |

**State home precedence:** `PR_REVIEW_HOME`, then `<CLAUDE_CONFIG_DIR>/pr-review`, then `~/.claude/pr-review`. If it cannot be created, `collect` stops with a message telling you to set `PR_REVIEW_HOME` to a writable directory.

**Transport order:** `gh` CLI (if logged in for the host), then an environment token, then (opt-in) the git credential helper, then anonymous read-only access. See `references/github-transport.md`.

**Files you can edit:** `profiles.json` (profiles, tier bounds, thresholds, `confirm_above`, `lens_priority`), `pricing.json` (list prices used to turn tokens into a cost figure), the `model:` line in `SKILL.md`, the lens prompts in `lenses/` and `references/verifier.md`.

Exit codes of `prr`:

| Code | Meaning |
|---|---|
| 0 | success |
| 1 | error (message on stderr), unknown command, Node older than 18, a surviving mutant or a mutant that no longer applies |
| 2 | nothing new since the last review, or nothing to review |
| 3 | PR metadata could not be read (no usable transport, private repository) |
| 4 | no authenticated transport for writing; the payload is ready in the run directory |
| 5 | the PR is no longer open, or its head moved (`HEAD_MOVED`); nothing was posted |
| 6 | `current-pr`: no open PR for this branch |
| 7 | no lens would run (nothing reviewable matched) |
| 8 | `POSTED_NOT_RECORDED`: the review is on GitHub but the state could not be saved |
| 9 | `CONFIRM_SPEND`: the plan waits for `--confirmed` |
| 10 | approval token missing, wrong, or no longer covering what would be posted |

## What it stores and sends

Under the state home:

| Path | Contents |
|---|---|
| `state/` | Review memory: per PR (or local repository and branch) the reviewed commits and the posted, pending, dismissed and addressed findings, with titles, paths and short summaries. Lock files and set-aside unreadable files live next to them. |
| `runs/<timestamp>-<target>/` | Everything about one review: `context.json`, the diffs and per-file patches, task files, agent outputs, `results.json`, `report.md`, `review-payload.json`, `approval.json`, `usage.json`, and `wt/`, a full checkout of the code under review. `collect` removes runs beyond the newest 20 that have also been untouched for 48 hours, so a review waiting at the approval question is not deleted. `prr cleanup --run <dir>` removes a run's `wt/` right away. |
| `metrics/events.jsonl` | Append-only log: one record per finished review (size and complexity, plan, funnel, findings counted by category / severity / verification status / your decision, per-lens results, the PR author login, measured token use and cost), outcome records (what happened to posted findings) and benchmark scores. It holds repository names, file paths and finding titles, never code. `PR_REVIEW_METRICS=off` disables it. |
| `repos/<host>/<owner>/<repo>/` (each part lower-cased, other characters replaced by `-`) | Blobless cached clones, made when you review a PR by URL from outside a clone of that repository. |
| `config.json` | The trusted-authors list written by `prr trust`. |

In your own clones:

- PR mode fetches the PR head and its base branch into `refs/pr-review/pr-<N>/head` and `…/base` (with `--no-tags`). These refs stay until you delete them.
- The run's `wt/` checkout is registered as a git worktree of your clone until it is cleaned up.
- A local review (except `--scope branch`) creates one dangling snapshot commit of your working tree or index. It is referenced by nothing once the worktree is gone, and git's garbage collection removes it in time.
- Your branches, index, stash, working files and git configuration are not modified.

What is read: to measure usage, the scripts read Claude Code's local transcripts under `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/` (the sub-agent transcripts, and the main session transcript for the orchestrator's share). Read-only. They look for transcripts whose opening prompt names the run directory and keep token counts, model names, agent labels and timings, which go into `usage.json` and the metrics log.

What leaves your machine:

- Requests to the GitHub API of the PR's host (through `gh` or directly), and git fetches or clones from that host or your configured remote. Nothing else: no telemetry, no update check, no other service.
- What you approve for posting: one GitHub review with its comments, which carry the hidden markers and a footer saying it was an automated review run by your account with Claude Code.
- The review itself runs as Claude Code sub-agents, so the code under review reaches your model provider exactly as in any other Claude Code session. A verifier that is allowed to run code may also reach a package registry.

## Uninstall

1. Delete the skill directory (`~/.claude/skills/pr-review` or the project copy).
2. Delete the state home (`~/.claude/pr-review`, or wherever `PR_REVIEW_HOME` / `CLAUDE_CONFIG_DIR` put it). This removes the review memory, runs, metrics, cached clones and the trust list.
3. In each clone you reviewed PRs from, remove the fetched refs and any stale worktree registration (POSIX shell or Git Bash):
   ```
   git for-each-ref --format='%(refname)' refs/pr-review | xargs -r -n 1 git update-ref -d
   git worktree prune
   ```
   `git worktree prune` also drops the registration of any other worktree whose directory is missing at that moment (an unmounted drive, for example); skip it if that could apply to you.
4. Remove the `permissions` entries and the `PreToolUse` hook you added to your Claude Code settings.

Markers inside comments already posted on GitHub are inert HTML comments; they stay with those comments.

## Platform notes

- The CI workflow (`.github/workflows/selftest.yml`) runs `build-workflow --check`, the selftest and `mutate --check` on Linux, macOS and Windows with Node 18, 20 and 22. Look at the CI result of the commit you install, and run the selftest yourself, rather than taking portability on trust.
- The selftest includes a run under a deliberately awkward git configuration: no identity, forced commit signing with a missing GPG program, prefix-less and blank-suppressed diffs, a `post-checkout` hook, and spaces in every path.
- **Proxies.** Behind an HTTP proxy use the `gh` transport. The token and anonymous transports use Node's built-in `fetch`, which ignores `HTTPS_PROXY` (Node 24 and newer honour it when `NODE_USE_ENV_PROXY=1` is set); `gh` and git honour the proxy variables. Token-transport requests time out after 30 seconds.
- **Git LFS.** If an LFS object cannot be downloaded while the review checkout is created, the checkout is retried with LFS files left as pointer files and the report carries a warning. Tests that need those files will fail for that reason.
- **Shallow clones.** A PR review from a shallow clone stops with the advice to run `git fetch --unshallow` when the merge base is missing.
- **"Dubious ownership".** If git refuses to work in a directory owned by another user, the error repeats git's own `safe.directory` hint instead of claiming there is no repository.
- **SSH host aliases.** With an origin such as `git@work:owner/repo.git`, a bare PR number cannot tell which GitHub host is meant; pass the full PR URL.
- **Windows.** Long paths are enabled for the skill's own git commands. `cleanup` cannot remove a checkout while a terminal or editor is open inside it; it says so. Commands the scripts print for re-use quote the run directory, so a profile folder with a space in its name works.
- **git versions.** git 2.28 is the minimum (`git init -b`). The selftest isolates itself from your git configuration with `GIT_CONFIG_GLOBAL`, which git honours from 2.32; on older versions a global setting such as forced commit signing can make the selftest fail without anything being wrong with the skill.

## Benchmarks

No recall, precision or cost figures are claimed for this skill. Results vary with the code, the models behind the aliases, the profile and from run to run. What ships is the means to measure it yourself:

1. `node scripts/prr.mjs fixture` lists the fixtures; `fixture --name <name> --dir <empty dir>` builds a small git repository whose feature branch contains seeded defects plus *baits* (code that only looks like a bug). `shop` is JavaScript: 5 defects and 1 bait in a small change, which exercises the single-pass path. `ledger` is Python: 8 defects and 2 baits in a large change touching auth and money, which exercises sharding, model upgrades, escalating verification and the duplicate merge, and costs accordingly. The answer key is `evals/fixtures/<name>/expected.json`; keep it away from the reviewing session.
2. Review the fixture like any local change (`/pr-review local --profile <p>` in that directory). The run must end with `prr post --run <run dir> --event NONE`, which records it; the skill does that when you answer its closing question. Fixture runs never share review memory with each other, so the same directory can be reviewed repeatedly.
3. `node scripts/prr.mjs score --run <run dir>` prints recall over the seeded defects, bait hits (false positives), verified findings that match nothing in the key (judge those by hand; they may be real), whether the severity was right, and measured cost per seeded defect found. For every miss it says whether the lens never raised it or verification threw it away. The result is also written to `<run dir>/score.json` and the metrics log.
4. `node scripts/prr.mjs calibrate --dir <empty dir>` asks a different question: does verification *discriminate*? It feeds the verifiers claims of known truth (`evals/calibration.json`, most of them invented but plausible) and `calibrate --score --run <run dir>` reports how many false claims were stopped and how many true ones survived — the two ways verification can fail. The answer key never reaches an agent. See `references/metrics.md`.
5. `node scripts/prr.mjs stats [--since 30d] [--profile p] [--repo o/r] [--mode pr|local] [--json]` rolls up all recorded reviews: cost by profile and tier, spend by stage and model, the finding funnel, findings counted by category / final severity / verification status / your decision, the complexity of the changes reviewed, the authors whose pull requests were reviewed, a per-lens scoreboard (how much of what a lens raises survives verification, cost per verified finding), your decisions, what authors did with posted findings, a benchmark table, and observations such as a noisy or idle lens. Fixture runs are kept out of the review totals unless you pass `--include-fixtures`.

How to read the results:

- **Run-to-run variance is large.** The models are stochastic; a single run is an anecdote. Run each configuration several times before comparing two profiles, two prompts or two models, and compare distributions, not single scores. The benchmark table in `prr stats` shows only the most recent score per fixture, profile and variant, so keep each `prr score` output (or `score.json`) when you repeat runs.
- **The shipped fixtures are a regression check, not a measure of recall on your code.** They are small, and their answer keys sit in the same repository as the lens prompts, so prompts can end up fitted to them. To learn how the skill does on your code base, add a fixture cut from it: `evals/fixtures/<name>/base/` (the repository before), `change/` (files copied over it for the change under review), optionally `uncommitted/`, and `expected.json` with `branch`, `commit_message`, `tolerance` (lines) and `expected[]` entries of `{ id, kind: "bug" | "bait", path, lines: [from, to], match, match_in, severity, lens }`, following `shop`. A useful fixture has several seeded defects of mixed severity in different lenses, at least one bait, and enough innocent code around them.
- `plan --no-critical-upgrade` keeps the core lenses on a profile's ordinary model, for comparing a run with and without the stronger model on profiles that have a `critical_upgrade` (`lean`, `deep`, `max`). The variant is recorded, so `prr stats` keeps the two apart.
- On real PRs there is no answer key. The closest signals are in `prr stats`: how many findings you dismissed as wrong, and how many posted findings authors fixed by the next review.

## Contributing

- **Run `node scripts/prr.mjs selftest` before every commit.** It is offline and uses no model. `selftest --show` also prints the sample report it renders.
- **Never edit `workflows/review.workflow.js`.** It is generated. Shared review logic lives in `scripts/lib/core.mjs` (keep it free of imports, clocks and randomness: the Workflow runtime forbids them) and the orchestration in `workflows/review.workflow.template.js`. After editing either, run `node scripts/prr.mjs build-workflow`; `build-workflow --check`, the selftest and CI fail on a stale file.
- **Add a mutant with every bug fix.** `evals/mutants.json` lists small deliberate breakages (`{ name, file, from, to }`; `from` must occur exactly once in `file`). `node scripts/prr.mjs mutate` copies the skill to temporary directories (one per parallel job), runs an unmutated baseline first, then applies one breakage at a time to a copy, requires that copy's selftest to fail, and restores the file before the next mutant; a mutant that survives is a behaviour no test protects. The live skill is never touched. `--only <regex>`, `--jobs N`, `--timeout <seconds>` (per selftest run, default 300), `--keep`, `--list`; `mutate --check` only verifies that every mutant still applies, and the selftest and CI run that check.
- **Adding a lens:**
  1. `lenses/<key>.md` with the same headings as the existing lenses (Mission, Where to look first, What to hunt for, Confirm before you report, False positives specific to this lens, Severity guide, Cheapest proof); `lenses/_contract.md` holds the rules and output shape shared by all lenses.
  2. the key in `lens_priority` in `profiles.json` (order decides which lenses survive a profile's lens cap);
  3. a title in `LENS_TITLES` in `scripts/lib/tasks.mjs`;
  4. an activation rule in `activate()` in `scripts/cmd/plan.mjs`, and, if the lens should read anything other than all non-docs files, a case in `filesForLens()` there; add it to `OPTIONAL_LENSES` if the brief agent may request it;
  5. the risk signals that wake it in `SIGNALS` in `scripts/lib/classify.mjs`;
  6. if it is a housekeeping lens whose findings may go to the cheaper verifier, the low-stakes lists in `scripts/lib/core.mjs` (then rebuild the workflow);
  7. a selftest case for its activation and, ideally, a fixture entry that the new lens should find.
- **Changing prompts, models or thresholds** is a behaviour change the selftest cannot judge. Measure it as described under [Benchmarks](#benchmarks), several runs per configuration.
- **`evals/evals.json`** is a set of five behaviour scenarios (a user prompt and the behaviour expected of the skill: asks before posting, stays incremental, keeps a trivial change cheap, does not execute fork code, finds the seeded defects of the `shop` fixture) in the format used by skill-creator style evaluation. They are run with a model in the loop, not by the selftest or CI, and the PR scenarios contain placeholders to fill in.
- `.gitattributes` normalises line endings to LF and marks the generated workflow; the repository has no dependencies and `node_modules/` is ignored.
- Record user-visible changes in `CHANGELOG.md` and bump `VERSION`.

## License

MIT — see [LICENSE](LICENSE). The seeded-bug fixtures under `evals/fixtures/` are covered by it too; they are synthetic and deliberately defective, as `evals/fixtures/README.md` explains.
