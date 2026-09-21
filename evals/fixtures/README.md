# Benchmark fixtures

Synthetic repositories used to measure how much a review actually finds. **They are not real services, and the
defects in them are deliberate.** Each fixture has a `base/` tree (the state before the change), a `change/` tree
(the state under review) and `expected.json`, the answer key listing every seeded defect and every *bait* — a
plausible-looking construct that is not a bug, there to catch a reviewer that invents findings.

So the `change/` trees contain working SQL injection, authentication bypass, race conditions and swallowed errors
on purpose. Nothing in them is real: there are no real credentials (tokens are generated at run time or are obvious
placeholders such as `tok-admin`), no real hosts, and no connection to any live system. Automated scanners will
flag this directory, and they are right to — the code is written to be found.

Build one and review it:

    node scripts/prr.mjs fixture --name shop --dir <an empty directory>
    # review that directory with /pr-review local, then:
    node scripts/prr.mjs score --run <run dir>

`shop` is small JavaScript; `ledger` is a larger Python change touching authentication and money, and its tests
need a Python interpreter. See `references/metrics.md`.

**Do not put this warning inside `base/` or `change/`.** Those trees are what the review agents read: a comment
saying the file contains deliberate defects would prime them, and inserting lines would shift the line numbers
`expected.json` pins. This file sits above both trees and is never copied into a built fixture.
