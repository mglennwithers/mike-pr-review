"""Shared fixtures for the test suite."""

from datetime import datetime, timedelta, timezone

from ledger import accounts, auth, db

WINDOW_START = "2000-01-01 00:00:00"
WINDOW_END = "2100-01-01 00:00:00"


def make_db():
    conn = db.connect(":memory:")
    db.init_schema(conn)
    return conn


def make_accounts(conn, opening=100_000):
    alice = accounts.create_account(conn, "Alice", "alice", opening)
    bob = accounts.create_account(conn, "Bob", "bob", opening)
    return alice, bob


def make_tokens(conn):
    return {
        role: auth.create_token(conn, role.title(), role, token=f"tok-{role}")
        for role in auth.ROLES
    }


def headers(token):
    return {"Authorization": f"Bearer {token}"}


def principal(conn, role):
    """The principal behind the canned token for ``role``."""
    return auth.authenticate(conn, f"tok-{role}")


def days_from_now(days):
    return datetime.now(timezone.utc).replace(tzinfo=None) + timedelta(days=days)
