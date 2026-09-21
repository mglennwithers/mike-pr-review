"""Request handlers.

No framework: ``handle()`` takes a method, a path, a header mapping and a decoded
JSON body, and returns ``(status, payload)``. The socket layer that wraps this
lives in the deployment repo.
"""

from . import accounts, auth, reports, transfers


def _error(status: int, message: str):
    return status, {"error": message}


def _account_json(account) -> dict:
    return {"id": account.id, "name": account.name, "owner": account.owner,
            "status": account.status, "balance_cents": account.balance_cents}


def _int_arg(value, field: str) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be an integer")


def create_account(conn, principal, body):
    auth.require_role(principal, "admin", "support", "clerk")
    try:
        account = accounts.create_account(
            conn,
            body.get("name", ""),
            body.get("owner", principal.name),
            _int_arg(body.get("opening_balance_cents", 0), "opening_balance_cents"),
        )
    except (accounts.InvalidAccount, ValueError) as exc:
        return _error(400, str(exc))
    return 201, _account_json(account)


def get_account(conn, principal, account_id):
    try:
        account = accounts.get_account(conn, account_id)
    except accounts.AccountNotFound as exc:
        return _error(404, str(exc))
    return 200, _account_json(account)


def list_accounts(conn, principal, query):
    owner = query.get("owner") if query else None
    return 200, {"accounts": [_account_json(a) for a in accounts.list_accounts(conn, owner)]}


def set_account_status(conn, principal, account_id, body):
    auth.require_role(principal, "admin")
    try:
        account = accounts.set_status(conn, account_id, body.get("status", ""))
    except accounts.AccountNotFound as exc:
        return _error(404, str(exc))
    except accounts.InvalidAccount as exc:
        return _error(400, str(exc))
    return 200, _account_json(account)


def create_transfer(conn, principal, body):
    auth.require_writable(principal)
    try:
        result = transfers.execute_transfer(
            conn,
            _int_arg(body.get("source_id"), "source_id"),
            _int_arg(body.get("dest_id"), "dest_id"),
            body.get("amount_cents"),
            memo=str(body.get("memo", "")),
            category=str(body.get("category", "general")),
            actor=principal.name,
        )
    except accounts.AccountNotFound as exc:
        return _error(404, str(exc))
    except transfers.InsufficientFunds as exc:
        return _error(409, str(exc))
    except (transfers.InvalidTransfer, accounts.InvalidAccount, ValueError) as exc:
        return _error(400, str(exc))
    return 201, result


def account_transfers(conn, principal, account_id, query):
    limit = _int_arg((query or {}).get("limit", 50), "limit")
    return 200, {"transfers": transfers.list_transfers(conn, account_id, min(limit, 200))}


def balances_report(conn, principal, query):
    auth.require_role(principal, "admin", "support", "auditor")
    return 200, reports.balance_sheet(conn)


def handle(conn, method: str, path: str, headers=None, body=None, query=None):
    """Route one request. Always returns ``(status, payload)``."""
    body = body or {}
    parts = [segment for segment in path.strip("/").split("/") if segment]
    principal = auth.principal_from_headers(conn, headers)
    if principal is None:
        return _error(401, "authentication required")

    try:
        return _dispatch(conn, principal, method.upper(), parts, body, query)
    except auth.PermissionDenied as exc:
        return _error(403, str(exc))
    except auth.AuthError as exc:
        return _error(401, str(exc))
    except ValueError as exc:
        return _error(400, str(exc))


def _dispatch(conn, principal, method, parts, body, query):
    if parts[:1] == ["accounts"]:
        if len(parts) == 1:
            if method == "GET":
                return list_accounts(conn, principal, query)
            if method == "POST":
                return create_account(conn, principal, body)
        elif len(parts) == 2:
            if method == "GET":
                return get_account(conn, principal, _int_arg(parts[1], "account_id"))
        elif len(parts) == 3 and parts[2] == "status" and method == "POST":
            return set_account_status(conn, principal, _int_arg(parts[1], "account_id"), body)
        elif len(parts) == 3 and parts[2] == "transfers" and method == "GET":
            return account_transfers(conn, principal, _int_arg(parts[1], "account_id"), query)
    elif parts[:1] == ["transfers"] and len(parts) == 1 and method == "POST":
        return create_transfer(conn, principal, body)
    elif parts[:2] == ["reports", "balances"] and method == "GET":
        return balances_report(conn, principal, query)
    return _error(404, "no such route")
