"""sqlite3 plumbing: connections, schema, and a transaction context manager."""

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone

SCHEMA = (
    "CREATE TABLE IF NOT EXISTS accounts ("
    " id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, owner TEXT NOT NULL,"
    " status TEXT NOT NULL DEFAULT 'active', balance_cents INTEGER NOT NULL DEFAULT 0,"
    " created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS transfers ("
    " id INTEGER PRIMARY KEY AUTOINCREMENT,"
    " source_id INTEGER NOT NULL REFERENCES accounts(id),"
    " dest_id INTEGER NOT NULL REFERENCES accounts(id),"
    " amount_cents INTEGER NOT NULL, fee_cents INTEGER NOT NULL DEFAULT 0,"
    " memo TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT 'general',"
    " status TEXT NOT NULL DEFAULT 'posted', actor TEXT, created_at TEXT NOT NULL)",
    "CREATE TABLE IF NOT EXISTS api_tokens ("
    " id INTEGER PRIMARY KEY AUTOINCREMENT, token TEXT NOT NULL UNIQUE, name TEXT NOT NULL,"
    " role TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL)",
    "CREATE INDEX IF NOT EXISTS idx_transfers_source ON transfers(source_id, created_at)",
    "CREATE INDEX IF NOT EXISTS idx_transfers_dest ON transfers(dest_id, created_at)",
)


def now_iso() -> str:
    """UTC timestamp, second resolution, sortable as a string."""
    return datetime.now(timezone.utc).replace(microsecond=0, tzinfo=None).isoformat(sep=" ")


def connect(path: str = ":memory:") -> sqlite3.Connection:
    conn = sqlite3.connect(path)
    conn.row_factory = sqlite3.Row
    # Autocommit mode: transactions are opened explicitly by `transaction()` so
    # that a block of writes is one unit and nothing half-applies.
    conn.isolation_level = None
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_schema(conn: sqlite3.Connection) -> None:
    for statement in SCHEMA:
        conn.execute(statement)


@contextmanager
def transaction(conn: sqlite3.Connection):
    """Run a block in a single immediate transaction, rolling back on any error."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield conn
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def query_all(conn, sql: str, params=()):
    return conn.execute(sql, params).fetchall()


def query_one(conn, sql: str, params=()):
    return conn.execute(sql, params).fetchone()


def execute(conn, sql: str, params=()) -> int:
    """Run a write and return ``lastrowid``."""
    return conn.execute(sql, params).lastrowid


def placeholders(values) -> str:
    """``IN (?, ?, ?)`` list for a batched lookup."""
    return ", ".join("?" for _ in values)
