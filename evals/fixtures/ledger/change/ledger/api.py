"""Request handlers.

No framework: ``handle()`` takes a method, a path, a header mapping and a decoded
JSON body, and returns ``(status, payload)``. The socket layer that wraps this
lives in the deployment repo.

Authorisation lives here, in the handlers: the modules below assume their caller
has already been checked.
"""

from . import (accounts, auth, batch, limits, refunds, reports, scheduling,
               statements, transfers)


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
        amount_cents = body.get("amount_cents")
        limits.check_transfer(conn, principal, transfers.validate_amount(amount_cents))
        result = transfers.execute_transfer(
            conn,
            _int_arg(body.get("source_id"), "source_id"),
            _int_arg(body.get("dest_id"), "dest_id"),
            amount_cents,
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


def fees_report(conn, principal, query):
    auth.require_role(principal, "admin", "support", "auditor")
    query = query or {}
    start = str(query.get("start", ""))
    end = str(query.get("end", ""))
    if not start or not end:
        return _error(400, "start and end are required")
    return 200, {"start": start, "end": end, "by_category": reports.fees_by_category(conn, start, end)}


def whoami(conn, principal):
    return 200, auth.describe(principal)


def my_limits(conn, principal):
    return 200, limits.summary(conn, principal)


def create_batch(conn, principal, body):
    """Post a batch of transfers out of one account."""
    auth.require_writable(principal)
    auth.require_role(principal, *auth.BATCH_ROLES)
    result = batch.submit_batch(
        conn,
        principal,
        _int_arg(body.get("source_id"), "source_id"),
        body.get("legs"),
        memo=str(body.get("memo", "")),
    )
    return 201, result


def preview_batch(conn, principal, body):
    auth.require_role(principal, *auth.BATCH_ROLES)
    return 200, batch.preview_batch(
        conn, principal, _int_arg(body.get("source_id"), "source_id"), body.get("legs")
    )


def get_batch(conn, principal, job_id):
    return 200, batch.get_job(conn, job_id)


def create_schedule(conn, principal, body):
    auth.require_writable(principal)
    auth.require_role(principal, *auth.SCHEDULE_ROLES)
    schedule = scheduling.create_schedule(
        conn,
        principal,
        _int_arg(body.get("source_id"), "source_id"),
        _int_arg(body.get("dest_id"), "dest_id"),
        body.get("amount_cents"),
        memo=str(body.get("memo", "")),
        interval_days=_int_arg(body.get("interval_days", 0), "interval_days"),
    )
    return 201, schedule


def list_schedules(conn, principal, query):
    status = (query or {}).get("status")
    return 200, {"schedules": scheduling.list_schedules(conn, status)}


def update_schedule(conn, principal, schedule_id, body):
    auth.require_role(principal, *auth.SCHEDULE_ROLES)
    return 200, scheduling.set_schedule_status(conn, principal, schedule_id,
                                               str(body.get("status", "")))


def run_schedules(conn, principal, body):
    auth.require_writable(principal)
    auth.require_role(principal, *auth.SCHEDULE_ROLES)
    return 200, scheduling.run_due(conn, principal,
                                   limit=_int_arg(body.get("limit", 100), "limit"))


def create_refund(conn, principal, body):
    """Refund all or part of a posted transfer back to the account that paid."""
    audit = {
        "actor": principal.name,
        "actor_role": body.get("actor_role") or principal.role,
        "reason": str(body.get("reason", "")),
    }
    if not auth.has_role_name(audit["actor_role"], *auth.REFUND_ROLES):
        return _error(403, "refunds require the admin role")
    amount_cents = body.get("amount_cents")
    result = refunds.refund_transfer(
        conn,
        principal,
        _int_arg(body.get("transfer_id"), "transfer_id"),
        amount_cents=amount_cents,
        reason=audit["reason"],
    )
    return 201, result


def list_refunds(conn, principal, query):
    auth.require_role(principal, "admin", "support", "auditor")
    original_id = (query or {}).get("transfer_id")
    return 200, {"refunds": refunds.list_refunds(conn, original_id)}


def account_statement(conn, principal, account_id, query):
    """CSV statement for one account. Auditors may read statements."""
    query = query or {}
    start = str(query.get("start", ""))
    end = str(query.get("end", ""))
    if not start or not end:
        return _error(400, "start and end are required")
    accounts.get_account(conn, account_id)
    csv_text = statements.export_statement(
        conn, account_id, start, end, category=query.get("category")
    )
    totals = statements.statement_totals(conn, account_id, start, end)
    return 200, {"content_type": "text/csv", "body": csv_text, "totals": totals}


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
    except limits.LimitExceeded as exc:
        return _error(429, str(exc))
    except accounts.AccountNotFound as exc:
        return _error(404, str(exc))
    except transfers.InsufficientFunds as exc:
        return _error(409, str(exc))
    except (accounts.InvalidAccount, batch.InvalidBatch, refunds.InvalidRefund,
            scheduling.InvalidSchedule, statements.InvalidStatement,
            transfers.InvalidTransfer, ValueError) as exc:
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
        elif len(parts) == 3 and parts[2] == "statement" and method == "GET":
            return account_statement(conn, principal, _int_arg(parts[1], "account_id"), query)
    elif parts[:1] == ["transfers"]:
        if len(parts) == 1 and method == "POST":
            return create_transfer(conn, principal, body)
        if parts[1:] == ["batch"] and method == "POST":
            return create_batch(conn, principal, body)
        if parts[1:] == ["batch", "preview"] and method == "POST":
            return preview_batch(conn, principal, body)
    elif parts[:1] == ["batches"] and len(parts) == 2 and method == "GET":
        return get_batch(conn, principal, _int_arg(parts[1], "job_id"))
    elif parts[:1] == ["schedules"]:
        if len(parts) == 1:
            if method == "GET":
                return list_schedules(conn, principal, query)
            if method == "POST":
                return create_schedule(conn, principal, body)
        elif parts[1:] == ["run"] and method == "POST":
            return run_schedules(conn, principal, body)
        elif len(parts) == 2 and method == "POST":
            return update_schedule(conn, principal, _int_arg(parts[1], "schedule_id"), body)
    elif parts[:1] == ["refunds"]:
        if len(parts) == 1 and method == "POST":
            return create_refund(conn, principal, body)
        if len(parts) == 1 and method == "GET":
            return list_refunds(conn, principal, query)
    elif parts == ["limits", "me"] and method == "GET":
        return my_limits(conn, principal)
    elif parts == ["whoami"] and method == "GET":
        return whoami(conn, principal)
    elif parts[:2] == ["reports", "balances"] and method == "GET":
        return balances_report(conn, principal, query)
    elif parts[:2] == ["reports", "fees"] and method == "GET":
        return fees_report(conn, principal, query)
    return _error(404, "no such route")
