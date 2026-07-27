"""§4 - the boundary policy exclusion constraint.

    EXCLUDE USING gist (tenant_id WITH =, branch_id WITH =,
                        daterange(effective_from, effective_until, '[)') WITH &&)

NULL effective_until means an unbounded upper bound: daterange(from, NULL, '[)')
is [from,), which overlaps every later range. That is the point - an open ended
policy owns the rest of time until someone closes it.
"""

from __future__ import annotations

import threading
import uuid

import psycopg
import pytest

from app.db import set_request_context
from tests.conftest import (
    DAY_BOUNDARY,
    OPERATING_CLOSE,
    OPERATING_OPEN,
    seed_tenant,
    wait_until_lock_blocked,
)

def insert_policy(conn, tenant_id, branch_id, effective_from, effective_until):
    return conn.execute(
        """
        INSERT INTO app.boundary_policy (
            tenant_id, branch_id, effective_from, effective_until,
            day_boundary_time, operating_open, operating_close)
        VALUES (%s, %s, %s, %s, %s, %s, %s)
        RETURNING boundary_policy_id::text
        """,
        (
            tenant_id, branch_id, effective_from, effective_until,
            DAY_BOUNDARY, OPERATING_OPEN, OPERATING_CLOSE,
        ),
    ).fetchone()[0]


@pytest.fixture
def branch(super_conn):
    """A tenant whose seeded open ended policy has been removed.

    The seed always creates one policy from 2000-01-01 with no upper bound,
    which by design collides with everything. These tests need a clean slate.
    """
    fx = seed_tenant(super_conn, label=f"excl-{uuid.uuid4().hex[:8]}")
    super_conn.execute(
        "DELETE FROM app.boundary_policy WHERE tenant_id = %s", (fx.tenant_id,)
    )
    return fx


def test_plain_overlap_is_rejected(super_conn, branch):
    insert_policy(super_conn, branch.tenant_id, branch.branch_id, "2026-01-01", "2026-06-01")
    with pytest.raises(psycopg.errors.ExclusionViolation):
        insert_policy(
            super_conn, branch.tenant_id, branch.branch_id, "2026-05-01", "2026-09-01"
        )


def test_adjacent_intervals_are_allowed(super_conn, branch):
    """[)  bounds mean the end date is excluded, so touching ranges do not overlap."""
    insert_policy(super_conn, branch.tenant_id, branch.branch_id, "2026-01-01", "2026-06-01")
    insert_policy(super_conn, branch.tenant_id, branch.branch_id, "2026-06-01", "2026-09-01")
    count = super_conn.execute(
        "SELECT count(*) FROM app.boundary_policy WHERE branch_id = %s",
        (branch.branch_id,),
    ).fetchone()[0]
    assert count == 2


def test_open_ended_policy_blocks_everything_after_it(super_conn, branch):
    insert_policy(super_conn, branch.tenant_id, branch.branch_id, "2026-01-01", None)

    # overlapping
    with pytest.raises(psycopg.errors.ExclusionViolation):
        insert_policy(
            super_conn, branch.tenant_id, branch.branch_id, "2026-03-01", "2026-04-01"
        )
    # strictly later, but the open end still covers it
    with pytest.raises(psycopg.errors.ExclusionViolation):
        insert_policy(
            super_conn, branch.tenant_id, branch.branch_id, "2030-01-01", None
        )
    # strictly earlier and closed before it starts: fine
    insert_policy(super_conn, branch.tenant_id, branch.branch_id, "2025-01-01", "2026-01-01")


def test_two_open_ended_policies_collide(super_conn, branch):
    insert_policy(super_conn, branch.tenant_id, branch.branch_id, "2026-01-01", None)
    with pytest.raises(psycopg.errors.ExclusionViolation):
        insert_policy(super_conn, branch.tenant_id, branch.branch_id, "2026-01-01", None)


def test_other_branch_and_other_tenant_do_not_collide(super_conn, branch):
    other_branch = str(uuid.uuid4())
    super_conn.execute(
        "INSERT INTO app.branch (branch_id, tenant_id, code, tz)"
        " VALUES (%s, %s, %s, 'Asia/Riyadh')",
        (other_branch, branch.tenant_id, f"second-{uuid.uuid4().hex[:6]}"),
    )
    other_tenant = seed_tenant(super_conn, label=f"excl2-{uuid.uuid4().hex[:8]}")

    insert_policy(super_conn, branch.tenant_id, branch.branch_id, "2026-01-01", None)
    # same tenant, different branch
    insert_policy(super_conn, branch.tenant_id, other_branch, "2026-01-01", None)
    # different tenant entirely (its seeded policy already covers this range)
    assert super_conn.execute(
        "SELECT count(*) FROM app.boundary_policy WHERE tenant_id = %s",
        (other_tenant.tenant_id,),
    ).fetchone()[0] == 1


def test_period_check_rejects_non_increasing_bounds(super_conn, branch):
    with pytest.raises(psycopg.errors.CheckViolation):
        insert_policy(
            super_conn, branch.tenant_id, branch.branch_id, "2026-06-01", "2026-06-01"
        )
    with pytest.raises(psycopg.errors.CheckViolation):
        insert_policy(
            super_conn, branch.tenant_id, branch.branch_id, "2026-06-01", "2026-01-01"
        )


def test_operating_window_must_fit_inside_the_accounting_day(super_conn, branch):
    """D-05's window is legal; one that wraps past the boundary is not."""
    # 07:00 -> 04:00 against a 06:00 boundary: +1h .. +22h. Accepted.
    super_conn.execute(
        """
        INSERT INTO app.boundary_policy (
            tenant_id, branch_id, effective_from, day_boundary_time,
            operating_open, operating_close)
        VALUES (%s, %s, '2026-01-01', '06:00', '07:00', '04:00')
        """,
        (branch.tenant_id, branch.branch_id),
    )
    # 05:00 -> 07:00 against a 06:00 boundary: +23h .. +1h. Wraps the boundary.
    with pytest.raises(psycopg.errors.CheckViolation):
        super_conn.execute(
            """
            INSERT INTO app.boundary_policy (
                tenant_id, branch_id, effective_from, effective_until,
                day_boundary_time, operating_open, operating_close)
            VALUES (%s, %s, '2020-01-01', '2021-01-01', '06:00', '05:00', '07:00')
            """,
            (branch.tenant_id, branch.branch_id),
        )


@pytest.mark.race
def test_concurrent_overlap_is_rejected(super_conn, observer_conn, branch):
    """Two transactions, overlapping ranges, neither committed yet.

    The exclusion constraint makes the second one wait on the first, exactly as
    a unique index would, and then fail when the first commits. Same barrier
    discipline as gates 8 and 10: T2 is observed blocked before T1 commits.
    """
    insert_policy(super_conn, branch.tenant_id, branch.branch_id, "2020-01-01", "2025-01-01")

    t1 = psycopg.connect(super_conn.info.dsn)
    t2 = psycopg.connect(super_conn.info.dsn)
    box: dict = {}

    def worker():
        try:
            insert_policy(t2, branch.tenant_id, branch.branch_id, "2026-05-01", "2026-09-01")
            t2.commit()
            box["result"] = "inserted"
        except BaseException as exc:  # noqa: BLE001
            box["error"] = exc
            t2.rollback()

    try:
        insert_policy(t1, branch.tenant_id, branch.branch_id, "2026-01-01", "2026-06-01")

        thread = threading.Thread(target=worker, daemon=True)
        thread.start()

        wait_until_lock_blocked(observer_conn, t2.info.backend_pid)
        assert thread.is_alive()
        assert not box, "T2 completed before T1 committed"

        t1.commit()
        thread.join(20)

        assert not thread.is_alive()
        assert isinstance(box.get("error"), psycopg.errors.ExclusionViolation), box
    finally:
        t1.close()
        t2.close()

    surviving = super_conn.execute(
        "SELECT effective_from, effective_until FROM app.boundary_policy"
        " WHERE branch_id = %s ORDER BY effective_from",
        (branch.branch_id,),
    ).fetchall()
    assert len(surviving) == 2, surviving


def test_runtime_role_cannot_write_policies(runtime_conn, branch):
    """Policies are reference data; app_runtime reads them and nothing more."""
    with runtime_conn.cursor() as cur:
        set_request_context(cur, tenant_id=branch.tenant_id, user_id=branch.admin_user_id)
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute(
                "INSERT INTO app.boundary_policy (tenant_id, branch_id, effective_from,"
                " day_boundary_time, operating_open, operating_close)"
                " VALUES (%s, %s, '2027-01-01', '06:00', '07:00', '04:00')",
                (branch.tenant_id, branch.branch_id),
            )
    runtime_conn.rollback()
