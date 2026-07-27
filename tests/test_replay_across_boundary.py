"""§3 - replay across the 06:00 accounting boundary, on a controlled clock.

Two claims are under test, and they pull in opposite directions:

  * Crossing the boundary must NOT invalidate a replay. Same key, same logical
    values -> the stored response comes back, even though "today" has changed.
  * Recomputing expected_business_date after the crossing IS a different
    request. Same key, different logical values -> 409 IDEMPOTENCY_KEY_REUSED.

Both follow from fingerprinting the client's declared logical fields rather
than the server's current opinion of the date.
"""

from __future__ import annotations

import json
import uuid
from datetime import date, datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.boundary import business_date_for
from app.clock import FixedClock
from tests.conftest import (
    DAY_BOUNDARY,
    RUNTIME_DSN,
    riyadh_local_as_utc,
    seed_tenant,
)

BEFORE = riyadh_local_as_utc(2026, 3, 14, 20, 0)   # business date 2026-03-14
JUST_BEFORE = riyadh_local_as_utc(2026, 3, 15, 5, 59)  # still 2026-03-14
AFTER = riyadh_local_as_utc(2026, 3, 15, 9, 0)     # business date 2026-03-15


@pytest.fixture
def clock():
    return FixedClock(BEFORE)


@pytest.fixture
def client(clock):
    with TestClient(create_app(clock=clock, dsn=RUNTIME_DSN)) as c:
        yield c


def _post(client, token, key, body, correlation=None):
    headers = {"Authorization": f"Bearer {token}", "Idempotency-Key": key}
    if correlation:
        headers["X-Client-Correlation-Id"] = correlation
    return client.post("/v1/shift-entries", content=json.dumps(body), headers=headers)


def _counts(conn, tenant_id):
    audit = conn.execute(
        "SELECT count(*) FROM app.audit_event WHERE tenant_id = %s", (tenant_id,)
    ).fetchone()[0]
    outbox = conn.execute(
        "SELECT count(*) FROM app.outbox_message WHERE tenant_id = %s", (tenant_id,)
    ).fetchone()[0]
    entries = conn.execute(
        "SELECT count(*) FROM app.shift_entry WHERE tenant_id = %s", (tenant_id,)
    ).fetchone()[0]
    return audit, outbox, entries


# --- the boundary itself ---------------------------------------------------


def test_business_date_pivots_at_the_boundary():
    """D-05: 06:00 splits the accounting day; the 04:00 tail stays on D-1."""
    riyadh = timezone(timedelta(hours=3))

    def local(h, m, day=15):
        return datetime(2026, 3, day, h, m, tzinfo=riyadh)

    assert business_date_for(local(20, 0, day=14), DAY_BOUNDARY) == date(2026, 3, 14)
    assert business_date_for(local(3, 59), DAY_BOUNDARY) == date(2026, 3, 14)
    assert business_date_for(local(5, 59), DAY_BOUNDARY) == date(2026, 3, 14)
    assert business_date_for(local(6, 0), DAY_BOUNDARY) == date(2026, 3, 15)
    assert business_date_for(local(7, 0), DAY_BOUNDARY) == date(2026, 3, 15)


# --- replay ----------------------------------------------------------------


def test_replay_after_boundary_returns_stored_response(super_conn, client, clock):
    fx = seed_tenant(super_conn, label=f"replay-{uuid.uuid4().hex[:8]}")
    key = f"replay-{uuid.uuid4().hex}"

    body = {
        "branch_code": fx.branch_code,
        "staff_ref": "staff-9",
        "minutes": 45,
        "expected_business_date": "2026-03-14",
        "note": "  evening shift  ",
    }

    first = _post(client, fx.member_token, key, body)
    assert first.status_code == 201, first.text
    stored = first.json()
    assert stored["business_date"] == "2026-03-14"
    assert stored["note"] == "evening shift"  # normalised, not raw
    assert "Idempotent-Replay" not in first.headers
    first_request_id = first.headers["X-Request-Id"]

    assert _counts(super_conn, fx.tenant_id) == (1, 1, 1)

    # Cross 06:00. "Today" is now 2026-03-15 as far as the server is concerned.
    clock.set(AFTER)
    probe = _post(
        client,
        fx.member_token,
        f"probe-{uuid.uuid4().hex}",
        {**body, "expected_business_date": "2026-03-15", "staff_ref": "staff-probe"},
    )
    assert probe.status_code == 201
    assert probe.json()["business_date"] == "2026-03-15", "the clock really moved"

    # Same key, same logical values, deliberately different JSON: reordered
    # keys, extra whitespace, differently spelled note. Still a replay.
    reordered = {
        "note": "evening shift",
        "expected_business_date": "2026-03-14",
        "minutes": 45,
        "staff_ref": "  staff-9  ",
        "branch_code": fx.branch_code,
    }
    replay = _post(client, fx.member_token, key, reordered)
    assert replay.status_code == 201
    assert replay.json() == stored

    # §6: a replay gets a fresh request_id...
    assert replay.headers["X-Request-Id"] != first_request_id
    assert replay.headers["Idempotent-Replay"] == "true"
    # ...and writes nothing. The probe added one of each; the replay added none.
    assert _counts(super_conn, fx.tenant_id) == (2, 2, 2)


def test_recomputed_expected_business_date_is_key_reuse(super_conn, client, clock):
    fx = seed_tenant(super_conn, label=f"reuse-{uuid.uuid4().hex[:8]}")
    key = f"reuse-{uuid.uuid4().hex}"

    body = {
        "branch_code": fx.branch_code,
        "staff_ref": "staff-9",
        "minutes": 45,
        "expected_business_date": "2026-03-14",
        "note": None,
    }
    assert _post(client, fx.member_token, key, body).status_code == 201
    before = _counts(super_conn, fx.tenant_id)

    clock.set(AFTER)

    # The client recomputed the date after the crossing. Same key, different
    # meaning - that is reuse, not replay.
    retried = _post(
        client, fx.member_token, key, {**body, "expected_business_date": "2026-03-15"}
    )
    assert retried.status_code == 409
    assert retried.json()["code"] == "IDEMPOTENCY_KEY_REUSED"
    assert _counts(super_conn, fx.tenant_id) == before


def test_replay_just_before_the_boundary_is_still_the_previous_day(
    super_conn, client, clock
):
    fx = seed_tenant(super_conn, label=f"edge-{uuid.uuid4().hex[:8]}")
    key = f"edge-{uuid.uuid4().hex}"
    body = {
        "branch_code": fx.branch_code,
        "staff_ref": "closing",
        "minutes": 30,
        "expected_business_date": "2026-03-14",
        "note": None,
    }

    clock.set(JUST_BEFORE)  # 05:59 local on the 15th
    first = _post(client, fx.member_token, key, body)
    assert first.status_code == 201
    assert first.json()["business_date"] == "2026-03-14"

    clock.set(AFTER)
    replay = _post(client, fx.member_token, key, body)
    assert replay.status_code == 201
    assert replay.json() == first.json()
    assert replay.headers["Idempotent-Replay"] == "true"


def test_only_logical_fields_are_persisted(super_conn, client):
    """§3: the record keeps the logical fields, not the raw body."""
    fx = seed_tenant(super_conn, label=f"fields-{uuid.uuid4().hex[:8]}")
    key = f"fields-{uuid.uuid4().hex}"
    _post(
        client,
        fx.member_token,
        key,
        {
            "minutes": 15,
            "branch_code": fx.branch_code,
            "expected_business_date": "2026-03-14",
            "staff_ref": "s1",
            "note": None,
        },
    )
    stored = super_conn.execute(
        "SELECT fingerprint_fields FROM app.idempotency_record"
        " WHERE tenant_id = %s AND idempotency_key = %s",
        (fx.tenant_id, key),
    ).fetchone()[0]

    assert stored == {
        "branch_code": fx.branch_code,
        "staff_ref": "s1",
        "minutes": 15,
        "expected_business_date": "2026-03-14",
        "note": None,
    }
