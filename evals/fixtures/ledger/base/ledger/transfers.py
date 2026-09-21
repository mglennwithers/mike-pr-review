"""Money movement between two accounts."""

from . import accounts, db, money

FEE_BASIS_POINTS = 25


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


def execute_transfer(conn, source_id, dest_id, amount_cents, *, memo="",
                     category="general", actor=None) -> dict:
    """Debit ``amount + fee`` from source, credit ``amount`` to destination.

    The balance check and both updates run in one transaction: either the whole
    transfer posts or nothing does.
    """
    amount_cents = validate_amount(amount_cents)
    if source_id == dest_id:
        raise InvalidTransfer("source and destination must differ")
    fee = quote_fee(amount_cents)

    with db.transaction(conn):
        source = accounts.get_account(conn, source_id)
        dest = accounts.get_account(conn, dest_id)
        accounts.assert_active(source)
        accounts.assert_active(dest)
        if source.balance_cents < amount_cents + fee:
            raise InsufficientFunds(
                f"account {source.id} has {source.balance_cents} cents,"
                f" needs {amount_cents + fee}"
            )
        accounts.adjust_balance(conn, source.id, -(amount_cents + fee))
        accounts.adjust_balance(conn, dest.id, amount_cents)
        transfer_id = db.execute(
            conn,
            "INSERT INTO transfers (source_id, dest_id, amount_cents, fee_cents, memo,"
            " category, status, actor, created_at)"
            " VALUES (?, ?, ?, ?, ?, ?, 'posted', ?, ?)",
            (source.id, dest.id, amount_cents, fee, memo, category, actor, db.now_iso()),
        )

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
        "SELECT id, source_id, dest_id, amount_cents, fee_cents, memo, category,"
        " status, actor, created_at FROM transfers WHERE id = ?",
        (transfer_id,),
    )
    if row is None:
        raise InvalidTransfer(f"no transfer {transfer_id}")
    return dict(row)


def list_transfers(conn, account_id: int, limit: int = 50):
    """Most recent transfers touching ``account_id``, newest first."""
    rows = db.query_all(
        conn,
        "SELECT id, source_id, dest_id, amount_cents, fee_cents, memo, category,"
        " status, actor, created_at FROM transfers"
        " WHERE source_id = ? OR dest_id = ?"
        " ORDER BY created_at DESC, id DESC LIMIT ?",
        (account_id, account_id, limit),
    )
    return [dict(row) for row in rows]


def signed_amount_for(transfer: dict, account_id: int) -> int:
    """What the transfer did to ``account_id``'s balance, in cents."""
    if transfer["source_id"] == account_id:
        return -(transfer["amount_cents"] + transfer["fee_cents"])
    if transfer["dest_id"] == account_id:
        return transfer["amount_cents"]
    return 0
