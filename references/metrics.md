# Metrics: what reviews cost and how well they find things

Everything is recorded automatically by the scripts; the orchestrator's only jobs are to relay the `Usage:` line, and to run `stats` / a benchmark when the user asks how the skill is doing. All data stays on the user's machine in `<state home>/metrics/events.jsonl` — the state home is `PR_REVIEW_HOME` if set, else `<CLAUDE_CONFIG_DIR>/pr-review`, else `~/.claude/pr-review`. The log holds repo names, file paths and finding titles, never code. `PR_REVIEW_METRICS=off` disables recording.

No benchmark numbers are claimed for this skill. What a profile, lens or model is worth on the user's code is something to measure, with the tools below, over several runs.

## Token usage and cost — measured, not estimated

Claude Code writes a transcript for every sub-agent with the API's own usage numbers on each response. `prr render`, `prr post` and `prr usage --run <RUN_DIR> [--json]` find the transcripts whose opening prompt names the run directory and add them up per agent, stage (lens, verify, tiebreak, the chores, critic, the MCP transport helper), lens and model, split into **fresh input, cache writes, cache reads and output**, then price them with `pricing.json`.

How to read the numbers:
- Token totals look huge because every tool turn re-reads the agent's context from cache. Cache reads usually make up most of the tokens and are priced at a tenth of input (`pricing.json` → `cache_multipliers.read`), so judge by **cost**, not raw tokens.
- Cost is an **API list-price equivalent** computed from `pricing.json`. On a subscription plan nothing is billed per token; use it as a yardstick between profiles, lenses and runs. The prices are a snapshot: the `Usage:` line and `prr stats` name their date (`as_of` in `pricing.json`). When they are out of date, the user checks the provider's pricing page and edits the file; runs already in the log keep the cost computed when they were recorded. Tokens on a model the file does not know are reported as unpriced (`+ … tokens on a model missing from pricing.json`) — tell the user to add that model.
- The orchestrator's own turns are reported separately, attributed by turn: a main-session turn counts when it names the run directory (every `prr` call after `collect` does, and workflow notifications echo it) or carries this skill's tag; unrelated turns in the same session are left out. Every orchestrator turn re-reads the whole session, so a review started in a long-running session costs far more than one started fresh — say so if the orchestrator figure rivals the sub-agent figure.
- Transcripts are looked for under `<CLAUDE_CONFIG_DIR or ~/.claude>/projects/<project>/<session>/subagents/`. That layout is a Claude Code implementation detail. When nothing is found there (a Claude Code version that stores them differently, another config directory), the line reads `Usage (coarse): …` — the Workflow harness's context-size counter, not billed tokens, never priced — or `Usage: not measurable`. The review itself is unaffected; the plan's estimate then stays on its built-in values.

`prr plan` prints an **Estimated spend** line before anything runs. Agent counts are exact for lenses and chores and a guess for verification (it depends on how many findings the lenses raise). Each agent is priced as *cost per size unit × size factor*:
- The **per-unit cost** of a kind of agent (stage × model) is the user's own logged average once the log holds three or more agents of that kind; until then it is a built-in rough starting value (a dollar figure fixed in `scripts/lib/metrics.mjs`; it does not follow edits to `pricing.json`). The line says which of the two is in use. Only this part recalibrates.
- The **size factors** are fixed formulas, not learned: a lens agent counts `1 + <effective lines in its shard> / 1100` units, a verifier `1 + <effective lines in the whole change> / 5000` units (at most 3).
- Orchestrator turns are not included. Once three measured reviews are logged, the plan adds a line with the median orchestrator cost of the most recent ones (up to ten).

Treat the estimate as an order of magnitude and quote the line when telling the user what will run. It is also what the spend gate compares with `confirm_above` in `profiles.json` (`CONFIRM_SPEND`, exit 9).

## Effectiveness

Recorded for every finished review (`prr post`, including `--event NONE`):
- **Funnel** — raised by lenses → distinct → verified (≥ posting bar) / verified but *minor* (true, under the importance floor, not offered for posting) / *not-verified nits* (only with `plan --verify-floor` or a `verify_min_importance` above 0: should-fix findings their own lens rated under the floor — listed for the user, never sent to a verifier, left out of lens precision) / below the bar / refuted / pre-existing / unverifiable / suppressed as duplicates. Every finding is logged with its importance as well as its confidence.
- **Per-lens results** — raised, verified, minor, refuted, posted, dismissed, cost. A lens whose verified findings are mostly minor is accurate but not earning its cost. *Precision* of a lens = verified ÷ raised: how much of what it says survives an adversary.
- **Verification** — votes, confirmed vs refuted, findings proven by actually running code, tiebreaks. These count VOTES: three verifiers on one finding are three votes.
- **Findings by type** (`findings_by`) — the same findings counted once each: by category (correctness, security, tests …), by the severity they ENDED with after verification, by bucket, by what verification concluded (`confirmed`, `contested`, `uncertain`, `refuted`, `pre_existing`, `unverified` when its verifiers died, `not_verified_nit` when its own lens rated it too minor to verify) and by your decision. Use these, not the vote counts, to answer "how many findings were confirmed".
- **Who wrote the change** (`author`) — for a PR: the author login, whether it is the user own PR, a draft, from a fork, and whether its code was allowed to run. For a local review: the branch, how many other people have commits on it, and no login.
- **Complexity** (`complexity`) — tier, effective and raw lines, files and reviewable files, effective lines per file kind, risk points, which critical areas were touched, commits, how many lens agents ran, the largest shard, and what the GitHub API itself reported for the PR size.
- **The user's decisions** — posted, held back ("not now"), dismissed as wrong, and whether they followed the recommended action.

Recorded later, as ground truth trickles in:
- **Author outcomes** — on each re-review of a PR, earlier findings are re-checked (fixed / partly / still open / unclear) and the threads are read for resolution, 👍/👎 and replies. "Authors fixed X% of re-checked findings" is the best real-world precision signal available. (The MCP metadata path may include `up`/`down` reaction counts per inline comment; they default to 0.)
- **Dismissals** — every `--dismiss` is a labelled false positive against the lenses that raised it.

What real PRs can never show is **recall** — what the review missed. That is what the benchmark is for.

## `prr stats`

```
prr stats [--since 30d|8w|6m|<YYYY-MM-DD>] [--profile <name>] [--repo owner/name] [--mode pr|local] [--include-fixtures] [--json]
```
Prints: cost by profile × change size, where the spend goes (stage, model), the finding funnel, findings by category / final severity / verification status / decision, change complexity, the authors whose PRs were reviewed, the lens scoreboard (precision, author-fix rate, cost per verified finding), human signal, benchmark results (the latest per fixture × profile × variant), and plain-language observations (a noisy lens, a lens that never finds anything, verification or orchestrator share too high). Show the tables as printed and add your own reading of them. Benchmark runs are kept out of the production numbers unless `--include-fixtures` is given. With few runs in a cell, say so: the averages mean little.

## Benchmark: seeded bugs with an answer key

Use when the user asks how good the skill is, wants to compare profiles, or has edited a lens, the verifier, thresholds or models and wants to know whether it got better.

1. `prr fixture --name <fixture> --dir <empty temp dir>` — builds a small git repo whose feature branch contains seeded defects across several lenses plus *bait* that only looks like a bug. (`prr fixture` without `--name` lists fixtures; `evals/fixtures/<name>/expected.json` is the answer key — do not read it before or during the review, and never mention it to sub-agents.)
2. Review it exactly like a user's local change: `collect --target local --cwd <that dir>` → `plan --profile <p>` → engine → `render`. There is nothing to post, so skip the step-6 question and finish with `post --event NONE` so the run is recorded. The spend gate (`CONFIRM_SPEND`) applies as in any review.
3. `prr score --run <RUN_DIR>` — recall over seeded bugs, bait hits (false positives), unmatched verified findings to judge by hand, and cost per bug found. Each finding is credited to at most one answer-key entry. For every miss it says whether the **lens never raised it** (improve that lens, or the profile capped it out) or it was **raised and then thrown away by verification** (read that verifier's evidence in `results.json`). `--fixture <name>` scores a run that was not made on a fixture repo.
4. To ask whether a stronger model earns its price, use a fixture that touches a critical area (`ledger`) and a profile whose `critical_upgrade` is set (`lean`, `deep` and `max` as shipped — on a large change only `deep` and `max` differ, because `lean` already runs Sonnet there; with `critical_upgrade: null`, as in `standard`, the flag changes nothing and both runs would be identical). Run it with and without `plan --no-critical-upgrade` and compare recall and cost per bug found. The run is logged with its variant so `prr stats` keeps the two apart.
5. Repeat with another profile to compare (the same fixture directory can be reused: benchmark runs never share review memory, so nothing is suppressed as "already raised"); `prr stats` shows them side by side.

**Run every configuration several times before drawing a conclusion.** Models are stochastic and run-to-run variance is large: the same profile on the same fixture can find a bug in one run and miss it in the next. Treat a single missed bug as a hint and a repeated one as a fact, and compare configurations only on repeated runs. `prr stats` shows only the latest score per fixture × profile × variant; every score is in the log as a `benchmark` event (and in `<RUN_DIR>/score.json`), so report the spread across runs, not one number. A fixture that lenses or prompts were tuned against overstates recall on other code — after such tuning, check on a fixture that was not used for it.

Fixtures shipped: `shop` (JavaScript, a small change, 5 defects + 1 bait — exercises the single-pass small-change path; its tests run with `node --test`) and `ledger` (Python, standard library only, a large change touching auth and money, 8 defects + 2 baits — exercises sharding, the critical-area model upgrade, escalating verification and the duplicate merge; verifiers need a Python interpreter to run its tests).

To add a fixture, create `evals/fixtures/<name>/{base/,change/,expected.json}` following `shop` (an optional `uncommitted/` directory is copied on top without being committed). `base/` is committed on `main`, `change/` on a feature branch. A good fixture has 4-8 seeded defects of mixed severity in different lenses, at least one bait, and enough innocent code around them that they are not the only thing to look at. Code from the user's own domain makes the most telling fixture.
