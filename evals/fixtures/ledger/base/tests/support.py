"""Shared fixtures for the test suite."""

from ledger import accounts, auth, db


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
