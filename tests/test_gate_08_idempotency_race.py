"""Gate 8 - concurrent claim of app.idempotency_record (§1, §2).

Two independent connections contend for one (tenant, endpoint, idempotency_key).
The loser must observe: INSERT ... ON CONFLICT DO NOTHING returns no row, and
the separate follow-up SELECT returns the winner's committed row.
"""

from __future__ import annotations

import json
import uuid

import pytest
from psycopg.types.json import Jsonb

from app.rowclaim import claim_row
from app.service import (
    ENDPOINT,
    _IDEMPOTENCY_INSERT,
    _IDEMPOTENCY_SELECT,
)
from tests.conftest import seed_tenant
from tests.racelib import run_claim_race

LABEL = "app.idempotency_record"


def _cycle(super_conn, observer, cycle: int):
    """One fully isolated race cycle: fresh tenant, fresh key, fresh payload."""
    fx = seed_tenant(super_conn, label=f"g08-{cycle}-{uuid.uuid4().hex[:8]}")

    key = f"gate08-{cycle}-{uuid.uuid4().hex}"
    winner_request_id = str(uuid.uuid4())
    loser_request_id = str(uuid.uuid4())
    business_date = "2026-03-14"

    winner_fields = {"cycle": cycle, "who": "T1"}
    winner_body = {"status": "recorded", "cycle": cycle, "owner": "T1"}
    winner_fp = f"fp-winner-{cycle}"

    loser_fields = {"cycle": cycle, "who": "T2"}
    loser_body = {"status": "recorded", "cycle": cycle, "owner": "T2"}

    def t1_insert(cur):
        cur.execute(
            """
            INSERT INTO app.idempotency_record (
                tenant_id, endpoint, idempotency_key, request_fingerprint,
                fingerprint_fields, response_status, response_body,
                business_date, created_by_request_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                fx.tenant_id, ENDPOINT, key, winner_fp, Jsonb(winner_fields),
                201, Jsonb(winner_body), business_date, winner_request_id,
            ),
        )

    def t2_claim(cur, barrier):
        return claim_row(
            cur,
            label=LABEL,
            insert_sql=_IDEMPOTENCY_INSERT,
            insert_params=(
                fx.tenant_id, ENDPOINT, key, f"fp-loser-{cycle}",
                Jsonb(loser_fields), 201, Jsonb(loser_body), business_date,
                loser_request_id,
            ),
            select_sql=_IDEMPOTENCY_SELECT,
            select_params=(fx.tenant_id, ENDPOINT, key),
            hooks=barrier,
        )

    outcome = run_claim_race(
        observer,
        label=LABEL,
        tenant_id=fx.tenant_id,
        user_id=fx.admin_user_id,
        t1_insert=t1_insert,
        t2_claim=t2_claim,
    )

    # The INSERT reported a conflict, so the conflict branch was taken...
    assert outcome.barrier_saw_conflict is True
    # ...and it was a lock wait on a row/index, not a timeout or a deadlock.
    assert outcome.lock_wait["wait_event_type"] == "Lock"

    # The follow-up SELECT returned T1's committed row, not T2's discarded one.
    stored_fp, status, body, bdate = outcome.claim.row
    assert stored_fp == winner_fp
    assert status == 201
    assert body == winner_body
    assert bdate.isoformat() == business_date

    # Exactly one record exists for the key, and it is T1's.
    row = super_conn.execute(
        """
        SELECT created_by_request_id::text, request_fingerprint, count(*) OVER ()
          FROM app.idempotency_record
         WHERE tenant_id = %s AND endpoint = %s AND idempotency_key = %s
        """,
        (fx.tenant_id, ENDPOINT, key),
    ).fetchall()
    assert len(row) == 1
    assert row[0][0] == winner_request_id
    assert row[0][1] == winner_fp
    assert json.loads(json.dumps(winner_body)) == body


@pytest.mark.race
def test_gate_08_concurrent_idempotency_claim(super_conn, observer_conn):
    _cycle(super_conn, observer_conn, cycle=-1)


@pytest.mark.race
@pytest.mark.parametrize("cycle", range(20))
def test_gate_08_concurrent_idempotency_claim_repeated(super_conn, observer_conn, cycle):
    """§2: 20 further cycles, each with isolated keys and data, zero failures."""
    _cycle(super_conn, observer_conn, cycle=cycle)
