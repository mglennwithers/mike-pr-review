"""API tokens and role checks.

A caller presents ``Authorization: Bearer <token>``. The token record carries the
role; nothing a caller sends in a body is ever treated as identity.
"""

import secrets
from dataclasses import dataclass

from . import db

ROLES = ("admin", "support", "clerk", "auditor")
READ_ONLY_ROLES = ("auditor",)


class AuthError(Exception):
    """The caller could not be identified."""


class PermissionDenied(Exception):
    """The caller was identified but is not allowed to do this."""


@dataclass(frozen=True)
class Principal:
    token_id: int
    name: str
    role: str


def create_token(conn, name: str, role: str, token: str = None) -> str:
    if role not in ROLES:
        raise ValueError(f"unknown role {role!r}")
    token = token or secrets.token_hex(16)
    db.execute(
        conn,
        "INSERT INTO api_tokens (token, name, role, active, created_at) VALUES (?, ?, ?, 1, ?)",
        (token, name, role, db.now_iso()),
    )
    return token


def revoke_token(conn, token: str) -> None:
    db.execute(conn, "UPDATE api_tokens SET active = 0 WHERE token = ?", (token,))


def authenticate(conn, token: str):
    """Return the :class:`Principal` for an active token, or ``None``."""
    if not token:
        return None
    row = db.query_one(
        conn,
        "SELECT id, name, role FROM api_tokens WHERE token = ? AND active = 1",
        (token,),
    )
    if row is None:
        return None
    return Principal(token_id=row["id"], name=row["name"], role=row["role"])


def bearer_token(headers) -> str:
    """Pull the bearer token out of a header mapping, case-insensitively."""
    if not headers:
        return ""
    for key, value in headers.items():
        if key.lower() == "authorization":
            value = (value or "").strip()
            if value.lower().startswith("bearer "):
                return value[7:].strip()
            return ""
    return ""


def principal_from_headers(conn, headers):
    return authenticate(conn, bearer_token(headers))


def require_role(principal, *roles) -> None:
    """Raise :class:`PermissionDenied` unless the principal holds one of ``roles``."""
    if principal is None:
        raise AuthError("authentication required")
    if principal.role not in roles:
        raise PermissionDenied(f"role {principal.role!r} may not perform this action")


def require_writable(principal) -> None:
    """Read-only roles may not move money."""
    if principal is None:
        raise AuthError("authentication required")
    if principal.role in READ_ONLY_ROLES:
        raise PermissionDenied(f"role {principal.role!r} is read-only")
