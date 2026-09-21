"""Scheduled transfers.

A schedule is a standing instruction: move ``amount_cents`` from one account to
another at ``next_run_at``, then either repeat every ``interval_days`` or retire.
A cron job calls :func:`run_due` every few minutes.
"""

import logging
from datetime import datetime, timedelta, timezone

from . import db, limits, transfers

LOG = logging.getLogger(__name__)

SCHEDULE_COLUMNS = (
    "id, source_id, dest_id, amount_cents, memo, interval_days, next_run_at,"
    " last_run_at, status, created_by, created_at"
)
MAX_INTERVAL_DAYS = 365


class InvalidSchedule(Exception):
    pass


def _now(moment: datetime = None) -> datetime:
    moment = moment or datetime.now(timezone.utc)
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
    return moment.replace(microsecond=0)


def create_schedule(conn, principal, source_id, dest_id, amount_cents, *, memo="",
                    interval_days=0, first_run_at=None) -> dict:
    """Create a standing instruction. The first run may be now or in the future."""
    amount_cents = transfers.validate_amount(amount_cents)
    if source_id == dest_id:
        raise InvalidSchedule("source and destination must differ")
    if not isinstance(interval_days, int) or interval_days < 0:
        raise InvalidSchedule("interval_days must be a non-negative integer")
    if interval_days > MAX_INTERVAL_DAYS:
        raise InvalidSchedule(f"interval_days may not exceed {MAX_INTERVAL_DAYS}")
    limits.check_transfer(conn, principal, amount_cents)

    run_at = db.to_iso(_now(first_run_at))
    schedule_id = db.execute(
        conn,
        "INSERT INTO scheduled_transfers (source_id, dest_id, amount_cents, memo,"
        " interval_days, next_run_at, status, created_by, created_at)"
        " VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)",
        (source_id, dest_id, amount_cents, memo, interval_days, run_at,
         principal.name, db.now_iso()),
    )
    return get_schedule(conn, schedule_id)


def get_schedule(conn, schedule_id: int) -> dict:
    row = db.query_one(
        conn,
        f"SELECT {SCHEDULE_COLUMNS} FROM scheduled_transfers WHERE id = ?",
        (schedule_id,),
    )
    if row is None:
        raise InvalidSchedule(f"no schedule {schedule_id}")
    return dict(row)


def list_schedules(conn, status: str = None, limit: int = 100):
    sql = f"SELECT {SCHEDULE_COLUMNS} FROM scheduled_transfers"
    params = []
    if status is not None:
        sql += " WHERE status = ?"
        params.append(status)
    sql += " ORDER BY next_run_at, id LIMIT ?"
    params.append(limit)
    return db.rows_to_dicts(db.query_all(conn, sql, tuple(params)))


def set_schedule_status(conn, principal, schedule_id: int, status: str) -> dict:
    """Pause, resume or cancel a schedule."""
    if status not in ("active", "paused", "cancelled"):
        raise InvalidSchedule(f"unknown status {status!r}")
    get_schedule(conn, schedule_id)
    db.execute(
        conn,
        "UPDATE scheduled_transfers SET status = ? WHERE id = ?",
        (status, schedule_id),
    )
    LOG.info("schedule %s set to %s by %s", schedule_id, status, principal.name)
    return get_schedule(conn, schedule_id)


def due_schedules(conn, moment: datetime = None, limit: int = 100):
    """Active schedules whose ``next_run_at`` has arrived, oldest first."""
    return db.rows_to_dicts(db.query_all(
        conn,
        f"SELECT {SCHEDULE_COLUMNS} FROM scheduled_transfers"
        " WHERE status = 'active' AND next_run_at <= ?"
        " ORDER BY next_run_at, id LIMIT ?",
        (db.to_iso(_now(moment)), limit),
    ))


def _advance(conn, schedule: dict, moment: datetime) -> None:
    """Move a schedule on to its next run, or retire a one-off."""
    ran_at = db.to_iso(moment)
    if schedule["interval_days"] <= 0:
        db.execute(
            conn,
            "UPDATE scheduled_transfers SET status = 'completed', last_run_at = ? WHERE id = ?",
            (ran_at, schedule["id"]),
        )
        return
    next_run = moment + timedelta(days=schedule["interval_days"])
    db.execute(
        conn,
        "UPDATE scheduled_transfers SET next_run_at = ?, last_run_at = ? WHERE id = ?",
        (db.to_iso(next_run), ran_at, schedule["id"]),
    )


def _execute_one(conn, principal, schedule: dict, moment: datetime) -> dict:
    """Post one due schedule and move it forward."""
    transfer_id = None
    try:
        posted = transfers.execute_transfer(
            conn,
            schedule["source_id"],
            schedule["dest_id"],
            schedule["amount_cents"],
            memo=schedule["memo"],
            category="scheduled",
            actor=principal.name,
        )
        transfer_id = posted["id"]
    except Exception as exc:
        LOG.warning("schedule %s could not be posted: %s", schedule["id"], exc)
    _advance(conn, schedule, moment)
    return {
        "schedule_id": schedule["id"],
        "transfer_id": transfer_id,
        "amount_cents": schedule["amount_cents"],
        "status": "executed",
    }


def run_due(conn, principal, moment: datetime = None, limit: int = 100) -> dict:
    """Run every schedule that is due. Called by the scheduler cron job."""
    moment = _now(moment)
    due = due_schedules(conn, moment, limit)
    results = [_execute_one(conn, principal, schedule, moment) for schedule in due]
    LOG.info("ran %s due schedules for %s", len(results), principal.name)
    return {
        "ran": len(results),
        "at": db.to_iso(moment),
        "results": results,
    }
