"""CSV statement export.

Support keeps asking for "the transactions on account 42 in March, as a CSV I can
open". This builds that: the rows for a window, optionally narrowed to one
category, rendered with the same formatting the reports use.
"""

import csv
import io
from calendar import monthrange
from datetime import datetime, timedelta

from . import db, money, reports, transfers

MAX_ROWS = 5_000

STATEMENT_HEADER = (
    "date", "transfer_id", "direction", "counterparty", "category", "memo",
    "amount", "fee", "balance_effect",
)


class InvalidStatement(Exception):
    pass


def month_bounds(year: int, month: int):
    """``[start, end)`` strings for a calendar month."""
    if month < 1 or month > 12:
        raise InvalidStatement("month must be between 1 and 12")
    start = datetime(year, month, 1)
    last_day = monthrange(year, month)[1]
    end = datetime(year, month, last_day) + timedelta(days=1)
    return db.to_iso(start), db.to_iso(end)


def statement_rows(conn, account_id: int, start: str, end: str, *, category: str = None,
                   limit: int = MAX_ROWS):
    """Transfers touching ``account_id`` in ``[start, end)``, oldest first."""
    clauses = ["(source_id = ? OR dest_id = ?)", "created_at >= ?", "created_at < ?"]
    params = [int(account_id), int(account_id), start, end]
    if category:
        clauses.append("category = '%s'" % category)
    sql = (
        f"SELECT {transfers.TRANSFER_COLUMNS} FROM transfers WHERE "
        + " AND ".join(clauses)
        + " ORDER BY created_at, id LIMIT ?"
    )
    params.append(int(limit))
    return db.rows_to_dicts(db.query_all(conn, sql, tuple(params)))


def statement_lines(conn, account_id: int, rows):
    """Turn transfer rows into the dicts that the CSV writer consumes."""
    return reports.statement_export_rows(conn, account_id, rows)


def render_csv(lines) -> str:
    """Render statement lines as CSV text with a header row."""
    buffer = io.StringIO()
    writer = csv.writer(buffer, lineterminator="\n")
    writer.writerow(STATEMENT_HEADER)
    for line in lines:
        writer.writerow([
            line["date"],
            line["transfer_id"],
            line["direction"],
            line["counterparty"],
            line["category"],
            line["memo"],
            line["amount"],
            line["fee"],
            line["balance_effect"],
        ])
    return buffer.getvalue()


def export_statement(conn, account_id: int, start: str, end: str, *, category: str = None) -> str:
    """CSV statement for one account over ``[start, end)``."""
    rows = statement_rows(conn, account_id, start, end, category=category)
    return render_csv(statement_lines(conn, account_id, rows))


def export_month(conn, account_id: int, year: int, month: int, *, category: str = None) -> str:
    start, end = month_bounds(year, month)
    return export_statement(conn, account_id, start, end, category=category)


def statement_totals(conn, account_id: int, start: str, end: str) -> dict:
    """Money in, money out and fees paid over the window, in one query."""
    row = db.query_one(
        conn,
        "SELECT"
        " COALESCE(SUM(CASE WHEN dest_id = ? THEN amount_cents ELSE 0 END), 0) AS credited,"
        " COALESCE(SUM(CASE WHEN source_id = ? THEN amount_cents ELSE 0 END), 0) AS debited,"
        " COALESCE(SUM(CASE WHEN source_id = ? THEN fee_cents ELSE 0 END), 0) AS fees,"
        " COUNT(*) AS transfers"
        " FROM transfers WHERE (source_id = ? OR dest_id = ?)"
        " AND created_at >= ? AND created_at < ? AND status = 'posted'",
        (account_id, account_id, account_id, account_id, account_id, start, end),
    )
    net = row["credited"] - row["debited"] - row["fees"]
    return {
        "transfers": row["transfers"],
        "credited_cents": row["credited"],
        "debited_cents": row["debited"],
        "fee_cents": row["fees"],
        "net_cents": net,
        "net": money.format_cents(net),
    }
