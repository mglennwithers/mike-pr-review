# Changelog

## 0.2.0

Adds the logging of author/complexity/finding types, `prr calibrate`, and the `parity` fixture.

- `prr calibrate`: feeds the verifiers claims of known truth and reports how many invented ones they stopped and how
  many real ones they kept, so "only findings that survive verification are posted" can be measured rather than assumed.
- A third fixture, `parity`, whose seeded defects each need a second file to confirm.
- The skill reads replies to its own comments instead of only counting them: a rebuttal reaches the follow-up agent,
  the finding is marked *disputed* with the agent's assessment, and `prr reply` answers the thread once, gated by the
  same approval token as posting a review.
- Every review record also logs the PR author, the change's complexity, and findings counted per finding by category, final severity, verification status and your decision; `prr stats` reports all three.

## 0.1.0

Initial release.

- Multi-lens review of GitHub pull requests and local changes, adversarial verification, traffic-light report.
- Budget profiles (`lean`, `standard`, `deep`, `max`), change tiers, sharding, a single-pass path for small changes.
- Review memory (local state plus hidden markers in posted comments): incremental re-reviews, nothing posted twice.
- Gates: posting needs the approval token of a rendered report; expensive plans wait for `--confirmed`; code is only
  executed for the user's own work and for authors on their trust list.
- Two engines (Workflow tool, Agent tool) sharing one set of task files and one library.
- Measured usage and cost, `prr stats`, seeded-bug fixtures with `prr fixture` / `prr score`.
- `prr selftest` (offline, includes a fake GitHub server) and `prr mutate` (mutation check on a copy).
- Released under the MIT licence.
- Git commands are shielded from the user's git configuration (hooks, diff settings, signing, identity, prompts).
- Optional PreToolUse hook `scripts/hooks/ask-before-post.mjs`; `prr trust`, `prr version`; state home: `PR_REVIEW_HOME`, then `CLAUDE_CONFIG_DIR`, then `~/.claude`.
