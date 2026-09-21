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
  money beyond an ordinary transfer (closing accounts, adjustments) is
  `admin`-only. `auditor` is read-only.

## Conventions

* All SQL is parameterised. Values from a request never get formatted into a
  query string, not even integers that "obviously" came from a route segment.
* Reports and exports read what they need in **one** query (or one batched
  `IN (...)` lookup); no queries inside a per-row loop.
* Handlers return `(status, payload)` and never raise to the caller.
