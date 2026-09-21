# Security

Report a vulnerability through GitHub private vulnerability reporting (the Security tab). Please do not open a public issue for anything
exploitable. There is no bounty; expect a reply when the maintainer next has time, not within a fixed window.

Supported version: the latest release (see `VERSION`). Nothing older is patched.

## What is in scope

This tool posts comments to GitHub in your name, reads a pull request's code, and may run that code. The interesting
bugs are the ones that cross those boundaries:

- posting, approving or requesting changes without the user choosing that action in this run;
- executing code from a change the trust rules say must only be read (a fork, a PR whose source repository is unknown,
  an author not on the trust list, a local branch carrying somebody else's commits);
- text inside a pull request steering the review or reaching GitHub under the user's name unsanitised, including
  anything that forges the hidden `pr-review:fp=` / `pr-review:state` markers the review memory is rebuilt from;
- an environment token or `gh` credential reaching a host other than `github.com`, `GH_HOST`, or the origin of the
  clone the user is in;
- reading or writing outside the state home (`PR_REVIEW_HOME`, else `<CLAUDE_CONFIG_DIR>/pr-review`, else
  `~/.claude/pr-review`) and the run's throwaway checkout.

`references/metrics.md` and the Safety section of `README.md` describe these guarantees and, importantly, which of them
are enforced in code and which are only instructions to a model. A gap between those two lists is worth reporting.

## What is not

- The seeded defects in `evals/fixtures/`. They are deliberately vulnerable code with no real credentials, built to be
  found by the review; see `evals/fixtures/README.md`.
- A review that misses a bug, or reports one that is not real. That is a quality problem — measure it with
  `prr score` and `prr calibrate` and open a normal issue.
- Anything requiring an attacker who already runs code as you on your machine.
