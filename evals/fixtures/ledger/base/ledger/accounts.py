"""Account records and balance mutation."""

from dataclasses import dataclass

from . import db

STATUSES = ("active", "frozen", "closed")


class AccountNotFound(Exception):
    pass


class InvalidAccount(Exception):
    pass


@dataclass(frozen=True)
class Account:
    id: int
    name: str
    owner: str
    status: str
    balance_cents: int

    @property
    def is_active(self) -> bool:
        return self.status == "active"


def _row_to_account(row) -> Account:
    return Account(
        id=row["id"],
        name=row["name"],
        owner=row["owner"],
        status=row["status"],
        balance_cents=row["balance_cents"],
    )


def create_account(conn, name: str, owner: str, opening_balance_cents: int = 0) -> Account:
    if not name or not name.strip():
        raise InvalidAccount("name is required")
    if opening_balance_cents < 0:
        raise InvalidAccount("opening balance may not be negative")
    account_id = db.execute(
        conn,
        "INSERT INTO accounts (name, owner, status, balance_cents, created_at)"
        " VALUES (?, ?, 'active', ?, ?)",
        (name.strip(), owner, opening_balance_cents, db.now_iso()),
    )
    return get_account(conn, account_id)


def get_account(conn, account_id: int) -> Account:
    row = db.query_one(
        conn,
        "SELECT id, name, owner, status, balance_cents FROM accounts WHERE id = ?",
        (account_id,),
    )
    if row is None:
        raise AccountNotFound(f"no account {account_id}")
    return _row_to_account(row)


def list_accounts(conn, owner: str = None):
    sql = "SELECT id, name, owner, status, balance_cents FROM accounts"
    params = ()
    if owner is not None:
        sql += " WHERE owner = ?"
        params = (owner,)
    return [_row_to_account(row) for row in db.query_all(conn, sql + " ORDER BY id", params)]


def set_status(conn, account_id: int, status: str) -> Account:
    if status not in STATUSES:
        raise InvalidAccount(f"unknown status {status!r}")
    get_account(conn, account_id)
    db.execute(conn, "UPDATE accounts SET status = ? WHERE id = ?", (status, account_id))
    return get_account(conn, account_id)


def adjust_balance(conn, account_id: int, delta_cents: int) -> None:
    """Relative balance update. Always called from inside a transaction."""
    cursor = conn.execute(
        "UPDATE accounts SET balance_cents = balance_cents + ? WHERE id = ?",
        (delta_cents, account_id),
    )
    if cursor.rowcount != 1:
        raise AccountNotFound(f"no account {account_id}")


def assert_active(account: Account) -> None:
    if not account.is_active:
        raise InvalidAccount(f"account {account.id} is {account.status}")
