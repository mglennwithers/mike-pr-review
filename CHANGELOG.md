# Changelog

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
