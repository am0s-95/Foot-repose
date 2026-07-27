"""§1 end to end - what a full request does when it loses the idempotency race.

Gate 8 covers the claim primitive. This covers the consequence: a request that
has already resolved the day, written the shift entry, the audit row and the
outbox row, and only then discovers the key is taken, must throw all of that
away and serve the winner's stored response instead.

Same barrier discipline as the gate tests: the losing request is observed
blocked in the database before the winner is allowed to commit.
"""

from __future__ import annotations

import json
import threading
import time
import uuid

import pytest
from fastapi.testclient import TestClient
from psycopg.types.json import Jsonb

from app.api import create_app
from app.canonical import canonical_shift_entry_fields, fingerprint
from app.clock import FixedClock
from app.db import set_request_context
from app.service import ENDPOINT
from tests.conftest import (
    Barrier,
    RUNTIME_DSN,
    riyadh_local_as_utc,
    runtime_connection,
    seed_tenant,
)

NOW = riyadh_local_as_utc(2026, 3, 14, 20, 0)
LABEL = "app.idempotency_record"


def body_for(fx):
    return {
        "branch_code": fx.branch_code,
        "staff_ref": "s1",
        "minutes": 30,
        "expected_business_date": "2026-03-14",
        "note": None,
    }


def _run_losing_request(super_conn, observer_conn, *, winner_fingerprint_matches: bool):
    """Drive one request into losing the race against a pre-committed winner."""
    fx = seed_tenant(super_conn, label=f"conc-{uuid.uuid4().hex[:8]}")
    key = f"conc-{uuid.uuid4().hex}"
    body = body_for(fx)

    request_fp = fingerprint(canonical_shift_entry_fields(body))
    winner_fp = request_fp if winner_fingerprint_matches else f"different-{request_fp}"
    winner_body = {"status": "recorded", "owner": "T1", "shift_entry_id": str(uuid.uuid4())}

    barrier = Barrier(LABEL)
    t1 = runtime_connection()
    box: dict = {}

    def send():
        with TestClient(
            create_app(clock=FixedClock(NOW), hooks=barrier, dsn=RUNTIME_DSN)
        ) as client:
            box["response"] = client.post(
                "/v1/shift-entries",
                content=json.dumps(body),
                headers={
                    "Authorization": f"Bearer {fx.member_token}",
                    "Idempotency-Key": key,
                },
            )

    try:
        # T1: claim the key, hold the transaction open.
        with t1.cursor() as cur:
            set_request_context(cur, tenant_id=fx.tenant_id, user_id=fx.member_user_id)
            cur.execute(
                """
                INSERT INTO app.idempotency_record (
                    tenant_id, endpoint, idempotency_key, request_fingerprint,
                    fingerprint_fields, response_status, response_body,
                    business_date, created_by_request_id)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, gen_random_uuid())
                """,
                (
                    fx.tenant_id, ENDPOINT, key, winner_fp, Jsonb({"who": "T1"}),
                    201, Jsonb(winner_body), "2026-03-14",
                ),
            )

        thread = threading.Thread(target=send, daemon=True)
        thread.start()

        assert barrier.reached_claim.wait(15), "the request never reached the claim"

        # It got all the way through its own writes and is now stuck on the key.
        blocked_query = _blocked_backend(observer_conn)
        assert thread.is_alive()
        assert "response" not in box

        t1.commit()
        thread.join(30)
        assert not thread.is_alive(), "the request never completed"
    finally:
        t1.close()

    assert "idempotency_record" in blocked_query
    return fx, key, box["response"], winner_body


def _blocked_backend(observer, timeout=20.0):
    """The backend running the losing request, once it is parked on a lock.

    The barrier tells us the request is *about* to issue the INSERT, so this has
    to keep looking until the statement is actually in flight and blocked -
    reading pg_stat_activity once would sample too early.
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        row = observer.execute(
            """
            SELECT pid, query
              FROM pg_stat_activity
             WHERE datname = current_database()
               AND state = 'active'
               AND wait_event_type = 'Lock'
               AND query ILIKE '%%idempotency_record%%'
               AND pid <> pg_backend_pid()
            """
        ).fetchone()
        if row is not None:
            return row[1]
        time.sleep(0.01)
    raise AssertionError(
        f"no backend blocked on the idempotency insert within {timeout}s"
    )


@pytest.mark.race
def test_losing_request_discards_its_work_and_replays_the_winner(
    super_conn, observer_conn
):
    fx, key, response, winner_body = _run_losing_request(
        super_conn, observer_conn, winner_fingerprint_matches=True
    )

    assert response.status_code == 201
    assert response.json() == winner_body, "the winner's stored response must be served"
    assert response.headers["Idempotent-Replay"] == "true"

    # Everything the loser wrote is gone.
    for table in ("app.shift_entry", "app.audit_event", "app.outbox_message"):
        count = super_conn.execute(
            f"SELECT count(*) FROM {table} WHERE tenant_id = %s", (fx.tenant_id,)
        ).fetchone()[0]
        assert count == 0, f"{table} kept the losing request's duplicate work"

    records = super_conn.execute(
        "SELECT count(*) FROM app.idempotency_record WHERE tenant_id = %s AND"
        " idempotency_key = %s",
        (fx.tenant_id, key),
    ).fetchone()[0]
    assert records == 1


@pytest.mark.race
def test_losing_request_with_different_fields_is_key_reuse(super_conn, observer_conn):
    fx, _key, response, _winner_body = _run_losing_request(
        super_conn, observer_conn, winner_fingerprint_matches=False
    )

    assert response.status_code == 409
    assert response.json()["code"] == "IDEMPOTENCY_KEY_REUSED"

    for table in ("app.shift_entry", "app.audit_event", "app.outbox_message"):
        count = super_conn.execute(
            f"SELECT count(*) FROM {table} WHERE tenant_id = %s", (fx.tenant_id,)
        ).fetchone()[0]
        assert count == 0, f"{table} kept work from a rejected request"
