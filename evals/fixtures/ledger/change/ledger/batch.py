"""Batch transfers: many legs out of one source account, submitted together.

Payroll and supplier runs used to be posted one request at a time, which meant a
run of forty payments made forty round trips and forty fee quotes. A batch takes
the whole run in one request: the total is reserved from the source account once,
then each leg is credited to its destination.
"""

import logging

from . import accounts, db, limits, money, transfers

LOG = logging.getLogger(__name__)

MAX_LEGS = 50


class InvalidBatch(Exception):
    pass


def _validate_legs(legs):
    """Normalise the submitted legs, rejecting anything we cannot post."""
    if not isinstance(legs, (list, tuple)) or not legs:
        raise InvalidBatch("batch must contain at least one leg")
    if len(legs) > MAX_LEGS:
        raise InvalidBatch(f"batch may not contain more than {MAX_LEGS} legs")
    normalised = []
    for index, leg in enumerate(legs):
        if not isinstance(leg, dict):
            raise InvalidBatch(f"leg {index} is not an object")
        try:
            dest_id = int(leg["dest_id"])
        except (KeyError, TypeError, ValueError):
            raise InvalidBatch(f"leg {index} needs an integer dest_id")
        try:
            amount_cents = transfers.validate_amount(leg.get("amount_cents"))
        except (transfers.InvalidTransfer, ValueError) as exc:
            raise InvalidBatch(f"leg {index}: {exc}")
        normalised.append({
            "dest_id": dest_id,
            "amount_cents": amount_cents,
            "memo": str(leg.get("memo", "")),
        })
    return normalised


def _average_leg_cents(legs) -> int:
    """Mean leg size, for the summary we hand back to the caller."""
    return sum(leg["amount_cents"] for leg in legs) // len(legs)


def _leg_cost(leg) -> int:
    """What a leg takes out of the source account: the amount plus its fee."""
    return leg["amount_cents"] + transfers.quote_fee(leg["amount_cents"])


def preview_batch(conn, principal, source_id, legs) -> dict:
    """Cost of a batch without posting anything."""
    legs = _validate_legs(legs)
    total = sum(_leg_cost(leg) for leg in legs)
    source = accounts.get_account(conn, source_id)
    return {
        "legs": len(legs),
        "total_cents": total,
        "total": money.format_cents(total),
        "average_leg_cents": _average_leg_cents(legs),
        "fee_cents": sum(transfers.quote_fee(leg["amount_cents"]) for leg in legs),
        "affordable": source.balance_cents >= total,
    }


def _create_job(conn, source_id, legs, total_cents, actor) -> int:
    return db.execute(
        conn,
        "INSERT INTO batch_jobs (source_id, leg_count, total_cents, status, actor, created_at)"
        " VALUES (?, ?, ?, 'pending', ?, ?)",
        (source_id, len(legs), total_cents, actor, db.now_iso()),
    )


def _finish_job(conn, job_id: int, status: str) -> None:
    db.execute(
        conn,
        "UPDATE batch_jobs SET status = ?, finished_at = ? WHERE id = ?",
        (status, db.now_iso(), job_id),
    )


def _reserve_total(conn, source_id: int, total_cents: int) -> None:
    """Take the whole batch out of the source account before any leg is posted."""
    row = db.query_one(
        conn,
        "SELECT status, balance_cents FROM accounts WHERE id = ?",
        (source_id,),
    )
    if row is None:
        raise accounts.AccountNotFound(f"no account {source_id}")
    if row["status"] != "active":
        raise accounts.InvalidAccount(f"account {source_id} is {row['status']}")
    if row["balance_cents"] < total_cents:
        raise transfers.InsufficientFunds(
            f"account {source_id} has {row['balance_cents']} cents, needs {total_cents}"
        )
    db.execute(
        conn,
        "UPDATE accounts SET balance_cents = ? WHERE id = ?",
        (row["balance_cents"] - total_cents, source_id),
    )


def _post_leg(conn, principal, source_id: int, leg: dict) -> dict:
    """Credit one destination and record the transfer row for it."""
    fee = transfers.quote_fee(leg["amount_cents"])
    with db.transaction(conn):
        dest = accounts.get_account(conn, leg["dest_id"])
        accounts.assert_active(dest)
        accounts.adjust_balance(conn, dest.id, leg["amount_cents"])
        transfer_id = transfers.record_transfer(
            conn, source_id, dest.id, leg["amount_cents"], fee,
            memo=leg["memo"], category="batch", actor=principal.name,
        )
    return {
        "transfer_id": transfer_id,
        "dest_id": dest.id,
        "amount_cents": leg["amount_cents"],
        "fee_cents": fee,
        "status": "posted",
    }


def submit_batch(conn, principal, source_id, legs, *, memo="") -> dict:
    """Post a batch of transfers out of ``source_id``. The caller is already authorised."""
    legs = _validate_legs(legs)
    if any(leg["dest_id"] == source_id for leg in legs):
        raise InvalidBatch("a batch may not pay its own source account")
    limits.check_batch(conn, principal, [leg["amount_cents"] for leg in legs])

    total = sum(_leg_cost(leg) for leg in legs)
    job_id = _create_job(conn, source_id, legs, total, principal.name)
    _reserve_total(conn, source_id, total)

    posted = []
    for leg in legs:
        posted.append(_post_leg(conn, principal, source_id, leg))
    _finish_job(conn, job_id, "completed")
    LOG.info("batch %s posted %s legs for %s", job_id, len(posted), principal.name)

    return {
        "job_id": job_id,
        "source_id": source_id,
        "legs": posted,
        "total_cents": total,
        "memo": memo,
        "status": "completed",
    }


def get_job(conn, job_id: int) -> dict:
    row = db.query_one(
        conn,
        "SELECT id, source_id, leg_count, total_cents, status, actor, created_at, finished_at"
        " FROM batch_jobs WHERE id = ?",
        (job_id,),
    )
    if row is None:
        raise InvalidBatch(f"no batch job {job_id}")
    return dict(row)


def list_jobs(conn, limit: int = 20):
    return db.rows_to_dicts(db.query_all(
        conn,
        "SELECT id, source_id, leg_count, total_cents, status, actor, created_at, finished_at"
        " FROM batch_jobs ORDER BY id DESC LIMIT ?",
        (limit,),
    ))
