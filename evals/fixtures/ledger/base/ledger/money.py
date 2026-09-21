"""Integer-cents arithmetic.

Everything monetary in this package is a whole number of cents. These helpers
exist so that no caller has to hand-roll a division and quietly pick up a float.
"""

CENTS_PER_UNIT = 100


def round_half_up(numerator: int, denominator: int) -> int:
    """Integer division of ``numerator / denominator`` rounded half away from zero."""
    if denominator == 0:
        raise ZeroDivisionError("denominator must be non-zero")
    if denominator < 0:
        numerator, denominator = -numerator, -denominator
    if numerator >= 0:
        return (2 * numerator + denominator) // (2 * denominator)
    return -((-2 * numerator + denominator) // (2 * denominator))


def pro_rata_cents(total_cents: int, part: int, whole: int) -> int:
    """The share of ``total_cents`` that belongs to ``part`` out of ``whole``."""
    if whole <= 0:
        raise ValueError("whole must be positive")
    if part < 0 or part > whole:
        raise ValueError("part must be between 0 and whole")
    return round_half_up(total_cents * part, whole)


def fee_cents(amount_cents: int, basis_points: int) -> int:
    """Fee for ``amount_cents`` at ``basis_points``, rounded half up."""
    if amount_cents == 0:
        return 0
    return max(1, round_half_up(amount_cents * basis_points, 10_000))


def format_cents(cents: int) -> str:
    """Render cents the way statements and reports show them: ``-12.05``."""
    sign = "-" if cents < 0 else ""
    cents = abs(int(cents))
    return f"{sign}{cents // CENTS_PER_UNIT}.{cents % CENTS_PER_UNIT:02d}"


def parse_cents(value) -> int:
    """Accept only a genuine integer count of cents."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("amount must be an integer number of cents")
    return value
