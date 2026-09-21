"""Read-only aggregates over accounts and transfers."""

from . import db, money


def account_names(conn, account_ids) -> dict:
    """Batched id -> name lookup. One query, whatever the number of ids."""
    ids = sorted({int(account_id) for account_id in account_ids})
    if not ids:
        return {}
    rows = db.query_all(
        conn,
        f"SELECT id, name FROM accounts WHERE id IN ({db.placeholders(ids)})",
        tuple(ids),
    )
    return {row["id"]: row["name"] for row in rows}


def balance_sheet(conn) -> dict:
    """Totals per account status, plus the grand total."""
    rows = db.query_all(
        conn,
        "SELECT status, COUNT(*) AS accounts, COALESCE(SUM(balance_cents), 0) AS total"
        " FROM accounts GROUP BY status ORDER BY status",
    )
    by_status = {r["status"]: {"accounts": r["accounts"], "total_cents": r["total"]} for r in rows}
    grand_total = sum(entry["total_cents"] for entry in by_status.values())
    return {"by_status": by_status, "total_cents": grand_total,
            "total": money.format_cents(grand_total)}


def transfer_volume(conn, start: str, end: str) -> dict:
    """Count, volume and fees for transfers posted in ``[start, end)``."""
    row = db.query_one(
        conn,
        "SELECT COUNT(*) AS transfers, COALESCE(SUM(amount_cents), 0) AS volume,"
        " COALESCE(SUM(fee_cents), 0) AS fees FROM transfers"
        " WHERE status = 'posted' AND created_at >= ? AND created_at < ?",
        (start, end),
    )
    return {"transfers": row["transfers"], "volume_cents": row["volume"],
            "fee_cents": row["fees"]}


def recent_activity(conn, limit: int = 20):
    """Newest transfers with both account names resolved in a single batch."""
    rows = db.query_all(
        conn,
        "SELECT id, source_id, dest_id, amount_cents, fee_cents, memo, created_at"
        " FROM transfers ORDER BY id DESC LIMIT ?",
        (limit,),
    )
    names = account_names(conn, [r["source_id"] for r in rows] + [r["dest_id"] for r in rows])
    activity = []
    for row in rows:
        activity.append({
            "id": row["id"],
            "source": names.get(row["source_id"], "?"),
            "dest": names.get(row["dest_id"], "?"),
            "amount": money.format_cents(row["amount_cents"]),
            "memo": row["memo"],
            "created_at": row["created_at"],
        })
    return activity
