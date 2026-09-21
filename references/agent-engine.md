# Agent-tool engine (when the Workflow tool is unavailable)

Same pipeline as the workflow — lenses → dedupe → adversarial verification → aggregate — but you drive the fan-out with the Agent tool and the scripts do all the bookkeeping. Agents exchange results through files in the run directory, so nothing large passes through your context.

Start only from a plan that printed `WORKFLOW_ARGS=`. A plan that ended with `CONFIRM_SPEND` (exit 9) has not been agreed to by the user: spawn nothing, not even the brief agent, until they have agreed and `prr plan … --confirmed` has been run (SKILL.md step 3).

Conventions for every Agent call here:
- `subagent_type`: `general-purpose`.
- `model`: exactly the model the plan names for that task (`haiku` / `sonnet` / `opus`). This is the whole point of the budget profiles; do not let tasks inherit your model.
- `prompt`: just `Read the file <task path> and follow it exactly.` The task file contains everything else. Do not shorten or reword the path: measured usage is attributed to the run through it.
- Launch all agents of a stage **in one message** so they run concurrently, with `run_in_background: false` (you need the stage to finish before the next script runs). Each agent replies with a single line like `done`; their real output is on disk.

## Stage 1 — brief and follow-up (cheap, optional)

Look at the `Chores (...)` line printed by `prr plan`.
- If it lists `brief`: spawn one agent on the chore model with `<RUN_DIR>/tasks/brief.md` and wait for it — lenses read its output, and its `lens_advice` decides which lens agents start (next stage). If it leaves no `<RUN_DIR>/brief.result.json`, spawn it once more; if that fails too, carry on — `aggregate` records that the brief did not run and the report says so. A small change reviewed by a single `quick-scan` pass has no brief.
- If it lists `followup`: spawn one agent with `<RUN_DIR>/tasks/followup.md`, on the follow-up model shown on that line (it is a verifier-grade model when an earlier *blocking* finding is open, because closing one changes the recommendation). It is independent; launch it together with the lens agents in stage 2. If it leaves no usable `<RUN_DIR>/followup.json`, spawn it once more; `aggregate` records a missing follow-up the same way.

## Stage 2 — lenses

```
prr lenses --run <RUN_DIR>
```
prints one `LENS <shard> model=<m> task=<path>` line per lens agent to start: the plan's list, minus keyword-woken lenses the brief agent vetoed after reading the diff, plus at most two standby lenses it asked for (the script enforces the limits — core lenses can never be dropped). Spawn one agent per line. Do not start lens agents from `plan.json` directly: `merge` expects exactly the set `lenses` printed.

**Exit 9** — the plan needs the user's confirmation and does not have it; `lenses` prints nothing to spawn. Do not work around it. Tell the user the estimate, ask, and only after they agree in this conversation re-run the same `prr plan` command with `--confirmed`, then `prr lenses` again.

## Stage 3 — merge (and history dedupe)

```
prr merge --run <RUN_DIR>
```
Validates the lens outputs, merges duplicates raised by different lenses, applies the profile's candidate cap, and prints what to do next:
- `PROBLEM:` lines — a lens produced no usable output. Re-run that one agent once; if it fails again, continue (the report will show the lens as ⚪ did-not-run).
- `NEXT: spawn …` followed by one or two quoted prompts — chores on the chore model: `merge.md` groups candidates that share a root cause (only once the run has as many candidates as the profile's `merge_duplicates.min_candidates`), `dedupe.md` checks them against what is already on the PR or was dismissed. Spawn what is listed (both in one message when there are two), then run `prr merge` again. If merge then prints `PROBLEM: …dedupe.json is not valid JSON`, delete the file and re-run that agent once; if it fails again, carry on — `aggregate` records the chore as failed and the report tells the user the duplicate check did not run. Never write an empty `dedupe.json` yourself to get past this step: that turns "not checked" into "nothing found".
- `VERIFY <id> <severity> model=<m> task=<path>` lines — the verification fan-out. Use exactly the model each line names: housekeeping findings go to a cheaper verifier on purpose. A `Not verified: …` line (only when a verification floor is on: `plan --verify-floor`, or `verify_min_importance` above 0 in `profiles.json`) lists should-fix findings their own lens rated below the floor; they need no agent and will be listed as minor.

## Stage 4 — adversarial verification

Spawn one agent per `VERIFY` line, with that line's model and task path, all in one message. When the profile escalates (the plan's `Verify:` line reads "… first, then … unless proven by running code"), a blocking (red) finding gets only the first stance now and `aggregate` asks for the others if they are needed; should-fix findings get the stances the profile lists. Verifiers may run tests inside the throwaway worktree when the plan says `run tests: yes` or `cheap`.

## Stage 5 — aggregate

```
prr aggregate --run <RUN_DIR>
```
Folds the votes into one confidence (is it true?) and one importance (does it matter?) per finding. It may print more `VERIFY` lines first, and you run `aggregate` again after each round:
- "need the remaining stances" — the first verifier did not prove a blocker by running code, so the other stances are needed after all. Spawn them. `--skip-escalation` exists, but a blocker resting on one opinion is exactly what this stage is for.
- `VERIFY … tiebreak` lines — verifiers disagreed about a blocking finding: spawn those agents on the model the line names and run `aggregate` again. `--skip-tiebreak` proceeds without (contested findings then stay below the posting bar).

`aggregate` also writes down what did not happen: a planned brief, follow-up, dedupe or critic whose output file is missing or unreadable, and a `merge.json` that is not valid JSON, are recorded in `results.json` (`chores_failed`) and the report tells the user. Never create or fill in such a file yourself.

## Stage 6 — completeness critic (only when the plan says `completeness critic`)

Spawn one agent on the critic model: `Read the file <RUN_DIR>/tasks/critic.md and follow it exactly. Candidate findings are in <RUN_DIR>/candidates.json.` It writes `<RUN_DIR>/critic.json` with up to five gaps (an empty list is a valid answer; if the file is missing or not JSON, spawn the critic once more, and if that fails too, carry on — the report will say the critic did not run). This engine runs one critic round; the `×N` on the plan line applies to the Workflow engine. For each gap, spawn a critic-model agent with this prompt:

> Targeted follow-up for the review run `<RUN_DIR>`. A completeness critic flagged a possible gap in an automated code review. Investigate exactly this and nothing else. Question: `<question>`. Files: `<paths>`. Read `<skill dir>/lenses/_contract.md` for the rules and output shape (and `<skill dir>/lenses/<lens>.md` if it exists). Paths to the code and diffs are in the "Facts" section of `<RUN_DIR>/tasks/verify-common.md`. Write your JSON result to `<RUN_DIR>/lens/gap-<n>.json` and reply `done`.

(`<n>` is a number: `gap-1.json`, `gap-2.json`, …; `<skill dir>` is the `skill_dir` in `<RUN_DIR>/context.json`.)

Then run `prr merge` again (it picks up `gap-*.json`, and only prints `VERIFY` lines whose verdict files do not exist yet — verify those), then `prr aggregate`. **Always run `prr aggregate` once more after this stage, even when the critic found no gaps**: until `critic.json` exists, `aggregate` records the critic as not run, and the report tells the user so.

Continue with step 5 of SKILL.md (`prr render`).
