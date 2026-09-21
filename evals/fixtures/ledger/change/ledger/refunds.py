"""Admin refunds.

A refund reverses part or all of a posted transfer: the destination account pays
the money back to the source, and the source also gets back the share of the
original fee that belongs to the refunded amount. Refunds are recorded in their
own table so that a transfer can be refunded more than once, up to its total.
"""

import logging

from . import accounts, db, money, transfers

LOG = logging.getLogger(__name__)

REFUND_COLUMNS = (
    "id, original_id, transfer_id, amount_cents, fee_cents, reason, actor, created_at"
)


class RefundError(Exception):
    pass


class InvalidRefund(RefundError):
    pass


def refunded_cents(conn, original_id: int) -> int:
    """How much of a transfer has already been refunded."""
    row = db.query_one(
        conn,
        "SELECT COALESCE(SUM(amount_cents), 0) AS refunded FROM refunds WHERE original_id = ?",
        (original_id,),
    )
    return row["refunded"]


def refundable_cents(conn, original: dict) -> int:
    """How much of a transfer may still be refunded."""
    return max(0, original["amount_cents"] - refunded_cents(conn, original["id"]))


def refundable_fee_cents(original: dict, amount_cents: int) -> int:
    """The share of the original fee that comes back with a partial refund."""
    if original["amount_cents"] <= 0:
        return 0
    share = amount_cents / original["amount_cents"]
    return int(original["fee_cents"] * share)


def _load_refundable(conn, original_id: int) -> dict:
    original = transfers.get_transfer(conn, original_id)
    if original["status"] != "posted":
        raise InvalidRefund(f"transfer {original_id} is {original['status']}")
    if original["category"] == "refund":
        raise InvalidRefund("a refund may not itself be refunded")
    return original


def refund_transfer(conn, principal, original_id: int, amount_cents=None, reason="") -> dict:
    """Refund all or part of ``original_id`` back to the account that paid.

    Authorisation is the request layer's job, as everywhere else in this package.
    """
    original = _load_refundable(conn, original_id)
    remaining = refundable_cents(conn, original)
    if amount_cents is None:
        amount_cents = remaining
    else:
        amount_cents = money.parse_cents(amount_cents)
    if amount_cents <= 0:
        raise InvalidRefund("refund amount must be positive")
    if amount_cents > remaining:
        raise InvalidRefund(
            f"transfer {original_id} has only {remaining} cents left to refund"
        )
    fee_back = refundable_fee_cents(original, amount_cents)

    with db.transaction(conn):
        payer = accounts.get_account(conn, original["dest_id"])
        payee = accounts.get_account(conn, original["source_id"])
        accounts.assert_active(payer)
        accounts.assert_active(payee)
        if payer.balance_cents < amount_cents:
            raise transfers.InsufficientFunds(
                f"account {payer.id} has {payer.balance_cents} cents,"
                f" cannot refund {amount_cents}"
            )
        accounts.adjust_balance(conn, payer.id, -amount_cents)
        accounts.adjust_balance(conn, payee.id, amount_cents + fee_back)
        transfer_id = transfers.record_transfer(
            conn, payer.id, payee.id, amount_cents, 0,
            memo=f"refund of transfer {original_id}", category="refund",
            actor=principal.name,
        )
        refund_id = db.execute(
            conn,
            "INSERT INTO refunds (original_id, transfer_id, amount_cents, fee_cents,"
            " reason, actor, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
            (original_id, transfer_id, amount_cents, fee_back, reason, principal.name,
             db.now_iso()),
        )

    LOG.info("refund %s: %s cents of transfer %s by %s", refund_id, amount_cents,
             original_id, principal.name)
    return {
        "id": refund_id,
        "original_id": original_id,
        "transfer_id": transfer_id,
        "amount_cents": amount_cents,
        "fee_cents": fee_back,
        "remaining_cents": remaining - amount_cents,
        "reason": reason,
    }


def get_refund(conn, refund_id: int) -> dict:
    row = db.query_one(conn, f"SELECT {REFUND_COLUMNS} FROM refunds WHERE id = ?", (refund_id,))
    if row is None:
        raise InvalidRefund(f"no refund {refund_id}")
    return dict(row)


def list_refunds(conn, original_id: int = None, limit: int = 50):
    sql = f"SELECT {REFUND_COLUMNS} FROM refunds"
    params = []
    if original_id is not None:
        sql += " WHERE original_id = ?"
        params.append(int(original_id))
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    return db.rows_to_dicts(db.query_all(conn, sql, tuple(params)))
