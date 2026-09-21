"""Per-role transfer limits.

Each role has a ceiling on how much money it may move in a UTC calendar day, and
a ceiling on any single transfer. The daily figure counts the ``amount_cents`` of
posted transfers stamped with the caller's name as ``actor`` — fees are the
house's revenue and are deliberately not counted against an operator.
"""

from datetime import datetime, timedelta, timezone

from . import db, transfers

#: Money (in cents) a role may move per UTC day. Reaching the figure stops you;
#: see the "Limits" section of the README for why the ceiling is exclusive.
ROLE_DAILY_LIMIT_CENTS = {
    "admin": 10_000_000,
    "support": 2_000_000,
    "clerk": 500_000,
    "auditor": 0,
}
DEFAULT_DAILY_LIMIT_CENTS = 100_000

#: Largest single transfer, per role. Anything bigger needs a second operator.
ROLE_TRANSFER_CEILING_CENTS = {
    "admin": 5_000_000,
    "support": 1_000_000,
    "clerk": 250_000,
    "auditor": 0,
}
DEFAULT_TRANSFER_CEILING_CENTS = 50_000


class LimitExceeded(Exception):
    """A transfer would take the actor past one of their ceilings."""

    def __init__(self, message: str, *, used_cents: int = 0, limit_cents: int = 0):
        super().__init__(message)
        self.used_cents = used_cents
        self.limit_cents = limit_cents


def daily_limit_for(role: str) -> int:
    return ROLE_DAILY_LIMIT_CENTS.get(role, DEFAULT_DAILY_LIMIT_CENTS)


def transfer_ceiling_for(role: str) -> int:
    return ROLE_TRANSFER_CEILING_CENTS.get(role, DEFAULT_TRANSFER_CEILING_CENTS)


def day_bounds(moment: datetime = None):
    """The UTC calendar day containing ``moment``, as ``[start, end)`` strings."""
    moment = moment or datetime.now(timezone.utc)
    if moment.tzinfo is not None:
        moment = moment.astimezone(timezone.utc).replace(tzinfo=None)
    start = moment.replace(hour=0, minute=0, second=0, microsecond=0)
    return db.to_iso(start), db.to_iso(start + timedelta(days=1))


def moved_today(conn, actor: str, moment: datetime = None) -> int:
    """Cents this actor has already moved in the current UTC day."""
    start, end = day_bounds(moment)
    return transfers.total_moved_by(conn, actor, start, end)


def remaining_today(conn, principal, moment: datetime = None) -> int:
    """How much more this caller may move today, floored at zero."""
    used = moved_today(conn, principal.name, moment)
    return max(0, daily_limit_for(principal.role) - used)


def check_transfer(conn, principal, amount_cents: int, moment: datetime = None) -> None:
    """Raise :class:`LimitExceeded` if this transfer is outside the caller's limits."""
    ceiling = transfer_ceiling_for(principal.role)
    if amount_cents > ceiling:
        raise LimitExceeded(
            f"role {principal.role!r} may not move more than {ceiling} cents at once",
            used_cents=0,
            limit_cents=ceiling,
        )
    limit = daily_limit_for(principal.role)
    used = moved_today(conn, principal.name, moment)
    if used + amount_cents >= limit:
        raise LimitExceeded(
            f"role {principal.role!r} has moved {used} of {limit} cents today",
            used_cents=used,
            limit_cents=limit,
        )


def check_batch(conn, principal, amounts, moment: datetime = None) -> None:
    """Apply the same limits to a batch, counting the legs as one day's movement."""
    for amount_cents in amounts:
        ceiling = transfer_ceiling_for(principal.role)
        if amount_cents > ceiling:
            raise LimitExceeded(
                f"role {principal.role!r} may not move more than {ceiling} cents at once",
                used_cents=0,
                limit_cents=ceiling,
            )
    total = sum(amounts)
    limit = daily_limit_for(principal.role)
    used = moved_today(conn, principal.name, moment)
    if used + total >= limit:
        raise LimitExceeded(
            f"batch of {total} cents would take {principal.name} past the daily limit",
            used_cents=used,
            limit_cents=limit,
        )


def summary(conn, principal, moment: datetime = None) -> dict:
    """Payload for ``GET /limits/me``."""
    used = moved_today(conn, principal.name, moment)
    limit = daily_limit_for(principal.role)
    return {
        "role": principal.role,
        "daily_limit_cents": limit,
        "used_cents": used,
        "remaining_cents": max(0, limit - used),
        "per_transfer_ceiling_cents": transfer_ceiling_for(principal.role),
    }
