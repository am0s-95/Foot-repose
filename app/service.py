"""Request handling for POST /v1/shift-entries.

The whole handler runs in one READ COMMITTED transaction. The effect, its audit
row, its outbox row and its idempotency record all commit together or not at
all. There is no intermediate committed state, and therefore (§8) no
IN_PROGRESS record that any other transaction could ever observe and no
recovery path that could assume one exists.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime
from typing import Any

from psycopg.types.json import Jsonb

from app.auth import Principal
from app.boundary import resolve_day
from app.canonical import canonical_shift_entry_fields, fingerprint
from app.errors import ApiError, IdempotencyKeyReused
from app.hooks import NULL_HOOKS, ClaimHooks
from app.rowclaim import assert_read_committed, claim_row

ENDPOINT = "POST /v1/shift-entries"


@dataclass(frozen=True)
class Outcome:
    status: int
    body: dict
    #: True when the response came from a stored idempotency record rather than
    #: from work done by this request.
    replayed: bool


class LostIdempotencyRace(ApiError):
    """Control flow, not a failure: another transaction committed this key first.

    Raised after our own effect has been written but before commit, so that
    unwinding the transaction discards that duplicate work. The API layer turns
    it back into the winner's stored response.
    """

    http_status = 200
    code = "IDEMPOTENT_REPLAY"

    def __init__(self, status: int, body: dict) -> None:
        super().__init__("idempotency key was claimed concurrently")
        self.status = status
        self.body = body


# --- idempotency record ----------------------------------------------------

_IDEMPOTENCY_SELECT = """
    SELECT request_fingerprint, response_status, response_body, business_date
      FROM app.idempotency_record
     WHERE tenant_id = %s AND endpoint = %s AND idempotency_key = %s
"""

_IDEMPOTENCY_INSERT = """
    INSERT INTO app.idempotency_record (
        tenant_id, endpoint, idempotency_key, request_fingerprint,
        fingerprint_fields, response_status, response_body, business_date,
        created_by_request_id)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (tenant_id, endpoint, idempotency_key) DO NOTHING
    RETURNING request_fingerprint, response_status, response_body, business_date
"""


def _replay_or_reuse(stored, request_fp: str, idempotency_key: str) -> Outcome:
    """Decide between replay and 409 for an existing record (§3)."""
    stored_fp, status, body, _bdate = stored
    if stored_fp != request_fp:
        raise IdempotencyKeyReused(
            "this idempotency key was already used with different request fields",
            idempotency_key=idempotency_key,
        )
    return Outcome(status=status, body=body, replayed=True)


def lookup_idempotency_record(cur, *, tenant_id: str, idempotency_key: str):
    cur.execute(_IDEMPOTENCY_SELECT, (tenant_id, ENDPOINT, idempotency_key))
    return cur.fetchone()


# --- operational day -------------------------------------------------------

_DAY_COLUMNS = """
    tenant_id::text, branch_id::text, business_date, boundary_policy_id::text,
    day_boundary_time, operating_open, operating_close, tz, opened_at
"""

_DAY_INSERT = f"""
    INSERT INTO app.operational_day (
        tenant_id, branch_id, business_date, boundary_policy_id,
        day_boundary_time, operating_open, operating_close, tz,
        opened_by_request_id)
    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
    ON CONFLICT (tenant_id, branch_id, business_date) DO NOTHING
    RETURNING {_DAY_COLUMNS}
"""

_DAY_SELECT = f"""
    SELECT {_DAY_COLUMNS}
      FROM app.operational_day
     WHERE tenant_id = %s AND branch_id = %s AND business_date = %s
"""


def claim_operational_day(
    cur,
    *,
    tenant_id: str,
    branch_id: str,
    business_date: date,
    policy,
    tz: str,
    request_id: str,
    hooks: ClaimHooks = NULL_HOOKS,
):
    """Open the day, or attach to the one another request already opened (§1)."""
    return claim_row(
        cur,
        label="app.operational_day",
        insert_sql=_DAY_INSERT,
        insert_params=(
            tenant_id,
            branch_id,
            business_date,
            policy.boundary_policy_id,
            policy.day_boundary_time,
            policy.operating_open,
            policy.operating_close,
            tz,
            request_id,
        ),
        select_sql=_DAY_SELECT,
        select_params=(tenant_id, branch_id, business_date),
        hooks=hooks,
    )


# --- handler ---------------------------------------------------------------


def create_shift_entry(
    cur,
    *,
    principal: Principal,
    idempotency_key: str,
    payload: dict,
    now_utc: datetime,
    request_id: str,
    hooks: ClaimHooks = NULL_HOOKS,
) -> Outcome:
    assert_read_committed(cur)

    fields = canonical_shift_entry_fields(payload)
    request_fp = fingerprint(fields)

    # Fast path: a key we have already completed. No work, no writes.
    stored = lookup_idempotency_record(
        cur, tenant_id=principal.tenant_id, idempotency_key=idempotency_key
    )
    if stored is not None:
        return _replay_or_reuse(stored, request_fp, idempotency_key)

    day = resolve_day(
        cur,
        tenant_id=principal.tenant_id,
        branch_code=fields["branch_code"],
        now_utc=now_utc,
    )

    claim_operational_day(
        cur,
        tenant_id=principal.tenant_id,
        branch_id=day.branch.branch_id,
        business_date=day.business_date,
        policy=day.policy,
        tz=day.branch.tz,
        request_id=request_id,
        hooks=hooks,
    )

    cur.execute(
        """
        INSERT INTO app.shift_entry (
            tenant_id, branch_id, business_date, staff_ref, minutes, note,
            created_by_request_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING shift_entry_id::text, recorded_at
        """,
        (
            principal.tenant_id,
            day.branch.branch_id,
            day.business_date,
            fields["staff_ref"],
            fields["minutes"],
            fields["note"],
            request_id,
        ),
    )
    shift_entry_id, _recorded_at = cur.fetchone()

    # The response body is what a replay will hand back verbatim, so it must not
    # contain anything request-scoped. request_id travels in the header and the
    # log line instead (§6).
    body: dict[str, Any] = {
        "shift_entry_id": shift_entry_id,
        "branch_code": day.branch.code,
        "business_date": day.business_date.isoformat(),
        "staff_ref": fields["staff_ref"],
        "minutes": fields["minutes"],
        "note": fields["note"],
        "status": "recorded",
    }

    # §6: audit and outbox are written exactly once, by the request that does
    # the work. A replay reaches neither of these statements.
    cur.execute(
        """
        INSERT INTO app.audit_event (
            tenant_id, request_id, event_type, subject_id, business_date, payload)
        VALUES (%s, %s, 'shift_entry.recorded', %s, %s, %s)
        """,
        (
            principal.tenant_id,
            request_id,
            shift_entry_id,
            day.business_date,
            Jsonb({"fields": fields, "actor_user_id": principal.user_id}),
        ),
    )
    cur.execute(
        """
        INSERT INTO app.outbox_message (tenant_id, request_id, topic, payload)
        VALUES (%s, %s, 'shift_entry.recorded', %s)
        """,
        (principal.tenant_id, request_id, Jsonb(body)),
    )

    claim = claim_row(
        cur,
        label="app.idempotency_record",
        insert_sql=_IDEMPOTENCY_INSERT,
        insert_params=(
            principal.tenant_id,
            ENDPOINT,
            idempotency_key,
            request_fp,
            Jsonb(fields),
            201,
            Jsonb(body),
            day.business_date,
            request_id,
        ),
        select_sql=_IDEMPOTENCY_SELECT,
        select_params=(principal.tenant_id, ENDPOINT, idempotency_key),
        hooks=hooks,
    )

    if not claim.inserted:
        # Somebody else committed this key while we were working. Our effect is
        # a duplicate; raising discards it along with its audit and outbox rows.
        outcome = _replay_or_reuse(claim.row, request_fp, idempotency_key)
        raise LostIdempotencyRace(outcome.status, outcome.body)

    hooks.after_idempotency_insert()
    return Outcome(status=201, body=body, replayed=False)
