"""Money movement between two accounts."""

from . import accounts, db, money

FEE_BASIS_POINTS = 25

#: Categories that the scheduled / batch runners stamp on the rows they post, so
#: that statements and reports can tell them apart from an operator's transfer.
AUTOMATED_CATEGORIES = ("scheduled", "batch", "refund")

TRANSFER_COLUMNS = (
    "id, source_id, dest_id, amount_cents, fee_cents, memo, category, status, actor, created_at"
)


class TransferError(Exception):
    pass


class InvalidTransfer(TransferError):
    pass


class InsufficientFunds(TransferError):
    pass


def quote_fee(amount_cents: int) -> int:
    """Fee the source account pays on top of ``amount_cents``."""
    return money.fee_cents(amount_cents, FEE_BASIS_POINTS)


def validate_amount(amount_cents) -> int:
    amount_cents = money.parse_cents(amount_cents)
    if amount_cents <= 0:
        raise InvalidTransfer("amount must be positive")
    return amount_cents


def record_transfer(conn, source_id, dest_id, amount_cents, fee_cents, *, memo="",
                    category="general", actor=None, status="posted") -> int:
    """Insert a transfer row. The caller owns the transaction and the balances."""
    return db.execute(
        conn,
        "INSERT INTO transfers (source_id, dest_id, amount_cents, fee_cents, memo,"
        " category, status, actor, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (source_id, dest_id, amount_cents, fee_cents, memo, category, status, actor,
         db.now_iso()),
    )


def execute_transfer(conn, source_id, dest_id, amount_cents, *, memo="",
                     category="general", actor=None, fee_cents=None) -> dict:
    """Debit ``amount + fee`` from source, credit ``amount`` to destination.

    The balance check and both updates run in one transaction: either the whole
    transfer posts or nothing does. ``fee_cents`` overrides the standard fee, which
    the scheduled and batch runners use when the fee was quoted up front.
    """
    amount_cents = validate_amount(amount_cents)
    if source_id == dest_id:
        raise InvalidTransfer("source and destination must differ")
    fee = quote_fee(amount_cents) if fee_cents is None else money.parse_cents(fee_cents)
    if fee < 0:
        raise InvalidTransfer("fee may not be negative")

    with db.transaction(conn):
        source = accounts.get_account(conn, source_id)
        dest = accounts.get_account(conn, dest_id)
        accounts.assert_active(source)
        if source.balance_cents < amount_cents + fee:
            raise InsufficientFunds(
                f"account {source.id} has {source.balance_cents} cents,"
                f" needs {amount_cents + fee}"
            )
        accounts.adjust_balance(conn, source.id, -(amount_cents + fee))
        accounts.adjust_balance(conn, dest.id, amount_cents)
        transfer_id = record_transfer(conn, source.id, dest.id, amount_cents, fee,
                                      memo=memo, category=category, actor=actor)

    return {
        "id": transfer_id,
        "source_id": source_id,
        "dest_id": dest_id,
        "amount_cents": amount_cents,
        "fee_cents": fee,
        "status": "posted",
    }


def get_transfer(conn, transfer_id: int):
    row = db.query_one(
        conn,
        f"SELECT {TRANSFER_COLUMNS} FROM transfers WHERE id = ?",
        (transfer_id,),
    )
    if row is None:
        raise InvalidTransfer(f"no transfer {transfer_id}")
    return dict(row)


def list_transfers(conn, account_id: int, limit: int = 50):
    """Most recent transfers touching ``account_id``, newest first."""
    rows = db.query_all(
        conn,
        f"SELECT {TRANSFER_COLUMNS} FROM transfers"
        " WHERE source_id = ? OR dest_id = ?"
        " ORDER BY created_at DESC, id DESC LIMIT ?",
        (account_id, account_id, limit),
    )
    return [dict(row) for row in rows]


def list_transfers_between(conn, account_id: int, start: str, end: str):
    """Transfers touching ``account_id`` in ``[start, end)``, oldest first."""
    rows = db.query_all(
        conn,
        f"SELECT {TRANSFER_COLUMNS} FROM transfers"
        " WHERE (source_id = ? OR dest_id = ?) AND created_at >= ? AND created_at < ?"
        " ORDER BY created_at, id",
        (account_id, account_id, start, end),
    )
    return [dict(row) for row in rows]


def total_moved_by(conn, actor: str, start: str, end: str) -> int:
    """Sum of posted amounts an actor moved in ``[start, end)``."""
    row = db.query_one(
        conn,
        "SELECT COALESCE(SUM(amount_cents), 0) AS moved FROM transfers"
        " WHERE actor = ? AND status = 'posted' AND created_at >= ? AND created_at < ?",
        (actor, start, end),
    )
    return row["moved"]


def signed_amount_for(transfer: dict, account_id: int) -> int:
    """What the transfer did to ``account_id``'s balance, in cents."""
    if transfer["source_id"] == account_id:
        return -(transfer["amount_cents"] + transfer["fee_cents"])
    if transfer["dest_id"] == account_id:
        return transfer["amount_cents"]
    return 0
