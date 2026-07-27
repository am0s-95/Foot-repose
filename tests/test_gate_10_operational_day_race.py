"""Gate 10 - concurrent claim of app.operational_day (§1, §2).

Same contract as gate 8, on the other claimed table: the first request through
opens the day, every concurrent request attaches to that same day rather than
opening a second one or failing.
"""

from __future__ import annotations

import uuid
from datetime import date

import pytest

from app.boundary import BoundaryPolicy
from app.service import claim_operational_day
from tests.conftest import (
    BRANCH_TZ,
    DAY_BOUNDARY,
    OPERATING_CLOSE,
    OPERATING_OPEN,
    seed_tenant,
)
from tests.racelib import run_claim_race

LABEL = "app.operational_day"


def _cycle(super_conn, observer, cycle: int):
    fx = seed_tenant(super_conn, label=f"g10-{cycle}-{uuid.uuid4().hex[:8]}")

    # A distinct business date per cycle, so cycles cannot collide even if they
    # were to share a branch.
    business_date = date(2026, 1, 1).replace(day=1 + (cycle % 27))
    winner_request_id = str(uuid.uuid4())
    loser_request_id = str(uuid.uuid4())

    policy = BoundaryPolicy(
        boundary_policy_id=fx.boundary_policy_id,
        day_boundary_time=DAY_BOUNDARY,
        operating_open=OPERATING_OPEN,
        operating_close=OPERATING_CLOSE,
        effective_from=date(2000, 1, 1),
        effective_until=None,
    )

    def t1_insert(cur):
        cur.execute(
            """
            INSERT INTO app.operational_day (
                tenant_id, branch_id, business_date, boundary_policy_id,
                day_boundary_time, operating_open, operating_close, tz,
                opened_by_request_id)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                fx.tenant_id, fx.branch_id, business_date, fx.boundary_policy_id,
                DAY_BOUNDARY, OPERATING_OPEN, OPERATING_CLOSE, BRANCH_TZ,
                winner_request_id,
            ),
        )

    def t2_claim(cur, barrier):
        return claim_operational_day(
            cur,
            tenant_id=fx.tenant_id,
            branch_id=fx.branch_id,
            business_date=business_date,
            policy=policy,
            tz=BRANCH_TZ,
            request_id=loser_request_id,
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

    assert outcome.barrier_saw_conflict is True
    assert outcome.lock_wait["wait_event_type"] == "Lock"

    tenant_id, branch_id, bdate, policy_id, *_rest = outcome.claim.row
    assert tenant_id == fx.tenant_id
    assert branch_id == fx.branch_id
    assert bdate == business_date
    assert policy_id == fx.boundary_policy_id

    # One day row, opened by T1. T2 attached to it instead of creating a second.
    rows = super_conn.execute(
        """
        SELECT opened_by_request_id::text
          FROM app.operational_day
         WHERE tenant_id = %s AND branch_id = %s AND business_date = %s
        """,
        (fx.tenant_id, fx.branch_id, business_date),
    ).fetchall()
    assert len(rows) == 1
    assert rows[0][0] == winner_request_id


@pytest.mark.race
def test_gate_10_concurrent_operational_day_claim(super_conn, observer_conn):
    _cycle(super_conn, observer_conn, cycle=-1)


@pytest.mark.race
@pytest.mark.parametrize("cycle", range(20))
def test_gate_10_concurrent_operational_day_claim_repeated(
    super_conn, observer_conn, cycle
):
    """§2: 20 further cycles, each with isolated keys and data, zero failures."""
    _cycle(super_conn, observer_conn, cycle=cycle)
