"""§5 - what happens when policy resolution cannot produce exactly one answer.

  * none in effect          -> 409 BOUNDARY_POLICY_UNRESOLVED
  * more than one in effect -> 500 BOUNDARY_POLICY_INVARIANT_VIOLATED

Both must roll the request back entirely. The assertion for that is not "the
handler returned an error" but "the database contains nothing".
"""

from __future__ import annotations

import json
import uuid

import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.clock import FixedClock
from tests.conftest import RUNTIME_DSN, riyadh_local_as_utc, seed_tenant

NOW = riyadh_local_as_utc(2026, 3, 14, 20, 0)

TABLES = (
    "app.operational_day",
    "app.idempotency_record",
    "app.shift_entry",
    "app.audit_event",
    "app.outbox_message",
)


@pytest.fixture
def client():
    with TestClient(create_app(clock=FixedClock(NOW), dsn=RUNTIME_DSN)) as c:
        yield c


def assert_nothing_committed(conn, tenant_id):
    for table in TABLES:
        count = conn.execute(
            f"SELECT count(*) FROM {table} WHERE tenant_id = %s", (tenant_id,)
        ).fetchone()[0]
        assert count == 0, f"{table} has {count} committed rows after a failed request"


def post(client, fx, body=None, key=None):
    body = body or {
        "branch_code": fx.branch_code,
        "staff_ref": "s1",
        "minutes": 30,
        "expected_business_date": "2026-03-14",
        "note": None,
    }
    return client.post(
        "/v1/shift-entries",
        content=json.dumps(body),
        headers={
            "Authorization": f"Bearer {fx.member_token}",
            "Idempotency-Key": key or f"res-{uuid.uuid4().hex}",
        },
    )


def test_no_effective_policy_is_409_and_writes_nothing(super_conn, client):
    fx = seed_tenant(super_conn, label=f"nopol-{uuid.uuid4().hex[:8]}")
    super_conn.execute(
        "DELETE FROM app.boundary_policy WHERE tenant_id = %s", (fx.tenant_id,)
    )

    response = post(client, fx)

    assert response.status_code == 409
    assert response.json()["code"] == "BOUNDARY_POLICY_UNRESOLVED"
    assert_nothing_committed(super_conn, fx.tenant_id)


def test_policy_effective_only_in_the_future_is_409(super_conn, client):
    fx = seed_tenant(super_conn, label=f"future-{uuid.uuid4().hex[:8]}")
    super_conn.execute(
        "UPDATE app.boundary_policy SET effective_from = '2030-01-01'"
        " WHERE tenant_id = %s",
        (fx.tenant_id,),
    )

    response = post(client, fx)

    assert response.status_code == 409
    assert response.json()["code"] == "BOUNDARY_POLICY_UNRESOLVED"
    assert_nothing_committed(super_conn, fx.tenant_id)


def test_boundary_change_on_the_seam_is_409(super_conn, client):
    """The two-pass resolution disagrees with itself, so it refuses to guess.

    Policy A covers up to 2026-03-15 with a midnight boundary; policy B takes
    over on 2026-03-15 with a 06:00 boundary. At 03:00 local on the 15th, B says
    the business date is the 14th and A says it is the 15th. Neither answer is
    more correct than the other, so the request is rejected rather than written
    under an arbitrary boundary.
    """
    fx = seed_tenant(super_conn, label=f"seam-{uuid.uuid4().hex[:8]}")
    super_conn.execute(
        "DELETE FROM app.boundary_policy WHERE tenant_id = %s", (fx.tenant_id,)
    )
    for eff_from, eff_until, boundary, open_, close in (
        ("2000-01-01", "2026-03-15", "00:00", "07:00", "23:00"),
        ("2026-03-15", None, "06:00", "07:00", "04:00"),
    ):
        super_conn.execute(
            "INSERT INTO app.boundary_policy (tenant_id, branch_id, effective_from,"
            " effective_until, day_boundary_time, operating_open, operating_close)"
            " VALUES (%s, %s, %s, %s, %s, %s, %s)",
            (fx.tenant_id, fx.branch_id, eff_from, eff_until, boundary, open_, close),
        )

    with TestClient(
        create_app(
            clock=FixedClock(riyadh_local_as_utc(2026, 3, 15, 3, 0)), dsn=RUNTIME_DSN
        )
    ) as seam_client:
        response = post(seam_client, fx)

    assert response.status_code == 409
    assert response.json()["code"] == "BOUNDARY_POLICY_UNRESOLVED"
    assert_nothing_committed(super_conn, fx.tenant_id)


def test_multiple_effective_policies_is_500_and_writes_nothing(super_conn, client):
    """Simulates the exclusion constraint having been lost.

    The constraint is dropped for the duration of the test so that the state it
    is supposed to prevent can actually be created, and restored afterwards.
    That state must be treated as a server fault, not resolved by picking one.
    """
    fx = seed_tenant(super_conn, label=f"dup-{uuid.uuid4().hex[:8]}")

    super_conn.execute(
        "ALTER TABLE app.boundary_policy DROP CONSTRAINT boundary_policy_no_overlap"
    )
    try:
        super_conn.execute(
            "INSERT INTO app.boundary_policy (tenant_id, branch_id, effective_from,"
            " day_boundary_time, operating_open, operating_close)"
            " VALUES (%s, %s, '2001-01-01', '06:00', '07:00', '04:00')",
            (fx.tenant_id, fx.branch_id),
        )

        response = post(client, fx)

        assert response.status_code == 500
        assert response.json()["code"] == "BOUNDARY_POLICY_INVARIANT_VIOLATED"
        assert_nothing_committed(super_conn, fx.tenant_id)
    finally:
        super_conn.execute(
            "DELETE FROM app.boundary_policy WHERE tenant_id = %s", (fx.tenant_id,)
        )
        super_conn.execute(
            """
            ALTER TABLE app.boundary_policy
              ADD CONSTRAINT boundary_policy_no_overlap EXCLUDE USING gist (
                tenant_id WITH =,
                branch_id WITH =,
                daterange(effective_from, effective_until, '[)') WITH &&
              )
            """
        )


def test_constraint_is_restored_after_the_invariant_test(super_conn):
    """Guards the teardown above: a silently missing constraint would make the
    whole §4 suite vacuous on a later run."""
    exists = super_conn.execute(
        "SELECT 1 FROM pg_constraint WHERE conname = 'boundary_policy_no_overlap'"
    ).fetchone()
    assert exists is not None
