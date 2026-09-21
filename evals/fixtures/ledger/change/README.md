# ledger

Internal wallet / payments service. Accounts hold a balance, transfers move money
between them, and a thin request layer exposes the whole thing over HTTP to other
internal services. No external dependencies: Python 3.10 standard library only,
`sqlite3` for storage, `unittest` for tests.

```
python3 -m unittest discover -s tests   # `python` on Windows
```

## Money

* Every monetary value is a **whole number of cents**, stored in an `INTEGER`
  column and passed around as a Python `int`. Amounts never go through a float —
  `ledger.money` exists so that nobody has to write the arithmetic by hand.
* Proportional splits (fees, pro-rated refunds, per-account shares) use
  `money.pro_rata_cents`, which does the division in integers and **rounds half
  up**. Truncating is not acceptable: over a month of settlements the missing
  cents show up as a reconciliation break.
* The transfer fee is 25 basis points of the amount, rounded half up, with a
  minimum of 1 cent on any non-zero transfer.

## Transfers

* A transfer debits `amount + fee` from the source account and credits `amount`
  to the destination account. The fee is revenue; it is not credited anywhere.
* **Both the source and the destination account must be `active`.** A transfer
  into a `frozen` or `closed` account is rejected, exactly like a transfer out of
  one — money must never land somewhere it cannot leave again.
* A transfer is rejected unless the source balance covers the amount *and* the
  fee. Balances never go negative.
* The balance check and both balance updates happen inside **one** transaction.
  If any step fails the whole thing is rolled back and the caller gets an error —
  the API never reports success for a transfer that did not fully post.

## Accounts

* `status` is one of `active`, `frozen`, `closed`. Only `active` accounts take
  part in transfers; the others can still be read and reported on.
* Balances are only ever changed with a relative `balance = balance + ?` update
  inside a transaction, never by reading a balance and writing back a computed
  total.

## Auth

* Callers authenticate with an API token: `Authorization: Bearer <token>`.
  Tokens live in `api_tokens` and can be deactivated.
* The caller's **role comes from the token record**. Request bodies never carry
  authorisation data — a body field is input, not identity.
* Roles are `admin`, `support`, `clerk` and `auditor`. Anything that changes
  money beyond an ordinary transfer (closing accounts, adjustments, refunds) is
  `admin`-only. `auditor` is read-only.
* Handlers in `ledger.api` are where authorisation happens. The modules under
  them (`batch`, `scheduling`, `refunds`, …) assume the caller was already
  checked, so every new handler has to do the check itself.

## Limits

Each role has a daily ceiling on the money it may move and a ceiling on any one
transfer (`ledger.limits`). The daily figure counts the `amount_cents` of posted
transfers stamped with the operator's name; fees are house revenue and are not
counted against an operator.

* The day is a **UTC calendar day**, not a rolling 24 hours.
* The daily ceiling is **exclusive**: a transfer is refused when it would bring
  the day's total *to or above* the role's limit. Treasury asked for it this way
  so that an operator who has exactly hit their limit is already locked out and
  has to get a second pair of eyes, rather than being allowed one last transfer
  that lands exactly on the number.
* A batch counts as a single day's movement: the sum of its legs is checked
  against the same ceiling before any leg is posted.
* Over-limit requests come back as `429`.

## Scheduled transfers

`ledger.scheduling` stores standing instructions in `scheduled_transfers`. A cron
job calls `POST /schedules/run` every few minutes; it posts everything whose
`next_run_at` has arrived, then advances repeating schedules by `interval_days`
and retires one-offs.

* Creating, pausing and running schedules is `admin` or `support`.
* A run reports, per schedule, what happened to it. A schedule that could not be
  posted has not run: it must not be reported as executed and must not have its
  `next_run_at` moved on.

## Batch transfers

`POST /transfers/batch` takes up to 50 legs out of one source account.
`ledger.batch` reserves the total (amounts plus fees) from the source once, then
credits each destination. The reservation is the point where the source can go
short, so it has to be done the same way a single transfer does it: check and
update the balance inside one transaction, so two batches submitted at the same
time cannot both pass the check.

## Refunds

`POST /refunds` reverses part or all of a posted transfer and is **`admin`
only** — support and clerks raise a ticket instead.

* The destination account pays the money back to the source. The source also
  gets back the share of the original fee that belongs to the refunded amount,
  pro-rated with `money.pro_rata_cents`.
* A transfer can be refunded more than once, up to its original amount; refunds
  are recorded in `refunds` and the reversal posts as a `refund`-category
  transfer.
* A refund may not itself be refunded.

## Statements

`GET /accounts/<id>/statement?start=…&end=…` renders a CSV statement of the
account's transfers over a window, optionally narrowed to one `category`.
`ledger.statements` builds the rows, `ledger.reports` turns them into statement
lines, and `csv` writes them out.

## Conventions

* All SQL is parameterised. Values from a request never get formatted into a
  query string, not even integers that "obviously" came from a route segment.
* Reports and exports read what they need in **one** query (or one batched
  `IN (...)` lookup); no queries inside a per-row loop.
* Handlers return `(status, payload)` and never raise to the caller.
