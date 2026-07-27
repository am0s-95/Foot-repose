"""Test fixtures.

The suite runs against a real PostgreSQL cluster - the properties under test
(ON CONFLICT semantics under concurrency, exclusion constraints, RLS, privilege
revocation) exist only in the database and cannot be faked.
"""

from __future__ import annotations

import hashlib
import os
import threading
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, time as dtime, timedelta, timezone

import psycopg
import pytest

from db import migrate

DB_NAME = os.environ.get("FOOT_REPOSE_TEST_DB", "foot_repose_test")
HOST = "host=127.0.0.1 port=5432"
ADMIN_DSN = f"{HOST} dbname=postgres user=postgres"
SUPER_DSN = f"{HOST} dbname={DB_NAME} user=postgres"
RUNTIME_DSN = f"{HOST} dbname={DB_NAME} user=app_runtime"

#: A fixed-offset zone keeps every boundary assertion independent of DST.
BRANCH_TZ = "Asia/Riyadh"  # UTC+03:00 year round

#: D-05: accounting day boundary 06:00, operating hours 07:00 -> 04:00.
DAY_BOUNDARY = dtime(6, 0)
OPERATING_OPEN = dtime(7, 0)
OPERATING_CLOSE = dtime(4, 0)


@pytest.fixture(scope="session", autouse=True)
def database():
    migrate.reset_database(ADMIN_DSN, DB_NAME)
    migrate.apply(SUPER_DSN)
    yield
    # The cluster is disposable; leaving the database in place makes failures
    # inspectable after the run.


@pytest.fixture
def super_conn():
    with psycopg.connect(SUPER_DSN, autocommit=True) as conn:
        yield conn


@pytest.fixture
def observer_conn():
    """A third connection, used only to observe lock waits during race tests."""
    with psycopg.connect(SUPER_DSN, autocommit=True) as conn:
        yield conn


def runtime_connection() -> psycopg.Connection:
    conn = psycopg.connect(RUNTIME_DSN)
    conn.isolation_level = psycopg.IsolationLevel.READ_COMMITTED
    return conn


@pytest.fixture
def runtime_conn():
    conn = runtime_connection()
    try:
        yield conn
    finally:
        conn.close()


# --- seeding ---------------------------------------------------------------


@dataclass(frozen=True)
class Fixture:
    tenant_id: str
    branch_id: str
    branch_code: str
    boundary_policy_id: str
    admin_user_id: str
    admin_token: str
    member_user_id: str
    member_token: str


def _sha256(value: str) -> bytes:
    return hashlib.sha256(value.encode()).digest()


def seed_tenant(
    conn,
    *,
    label: str | None = None,
    day_boundary: dtime = DAY_BOUNDARY,
    operating_open: dtime = OPERATING_OPEN,
    operating_close: dtime = OPERATING_CLOSE,
    effective_from="2000-01-01",
    effective_until=None,
    tz: str = BRANCH_TZ,
) -> Fixture:
    """Create an isolated tenant with one branch, two users and one policy.

    Every race cycle calls this so that no two cycles share a key or a row.
    """
    label = label or uuid.uuid4().hex[:12]
    tenant_id = str(uuid.uuid4())
    branch_id = str(uuid.uuid4())
    policy_id = str(uuid.uuid4())

    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO app.tenant (tenant_id, code) VALUES (%s, %s)",
            (tenant_id, f"tenant-{label}"),
        )
        cur.execute(
            "INSERT INTO app.branch (branch_id, tenant_id, code, tz)"
            " VALUES (%s, %s, %s, %s)",
            (branch_id, tenant_id, f"br-{label}", tz),
        )
        cur.execute(
            """
            INSERT INTO app.boundary_policy (
                boundary_policy_id, tenant_id, branch_id, effective_from,
                effective_until, day_boundary_time, operating_open, operating_close)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                policy_id, tenant_id, branch_id, effective_from, effective_until,
                day_boundary, operating_open, operating_close,
            ),
        )

        users = {}
        for role in ("admin", "member"):
            user_id = str(uuid.uuid4())
            token = f"tok-{label}-{role}-{uuid.uuid4().hex}"
            cur.execute(
                "INSERT INTO app.app_user (user_id, tenant_id, display_name, email)"
                " VALUES (%s, %s, %s, %s)",
                (user_id, tenant_id, f"{role} {label}", f"{role}-{label}@example.test"),
            )
            cur.execute(
                "INSERT INTO app.membership (user_id, tenant_id, role)"
                " VALUES (%s, %s, %s)",
                (user_id, tenant_id, role),
            )
            identity_id = str(uuid.uuid4())
            cur.execute(
                "INSERT INTO auth.auth_identity"
                " (auth_identity_id, user_id, tenant_id, credential_hash)"
                " VALUES (%s, %s, %s, %s)",
                (identity_id, user_id, tenant_id, _sha256(f"pw-{user_id}")),
            )
            cur.execute(
                "INSERT INTO auth.auth_session"
                " (auth_identity_id, token_hash, expires_at)"
                " VALUES (%s, %s, now() + interval '1 day')",
                (identity_id, _sha256(token)),
            )
            users[role] = (user_id, token)

    return Fixture(
        tenant_id=tenant_id,
        branch_id=branch_id,
        branch_code=f"br-{label}",
        boundary_policy_id=policy_id,
        admin_user_id=users["admin"][0],
        admin_token=users["admin"][1],
        member_user_id=users["member"][0],
        member_token=users["member"][1],
    )


@pytest.fixture
def tenant(super_conn) -> Fixture:
    return seed_tenant(super_conn)


# --- race helpers (§2) -----------------------------------------------------


class Barrier:
    """Test-only instrumentation for the claim path.

    ``before_claim`` fires on the request thread the instant before it issues
    the conflicting INSERT. The test waits for that signal, then proves the
    thread is genuinely stuck in the database rather than merely slow.
    """

    def __init__(self, label: str) -> None:
        self.label = label
        self.reached_claim = threading.Event()
        self.reached_conflict = threading.Event()

    def before_claim(self, label: str) -> None:
        if label == self.label:
            self.reached_claim.set()

    def after_conflict(self, label: str) -> None:
        if label == self.label:
            self.reached_conflict.set()

    def after_idempotency_insert(self) -> None:
        pass


def wait_until_lock_blocked(observer, pid: int, timeout: float = 10.0) -> dict:
    """Block until backend ``pid`` is waiting on a heavyweight lock.

    This is the deterministic half of the race test: instead of sleeping and
    assuming the other transaction has not finished, we read from the server
    that it is parked on a lock and cannot have finished.
    """
    deadline = time.monotonic() + timeout
    last = None
    while time.monotonic() < deadline:
        row = observer.execute(
            """
            SELECT state, wait_event_type, wait_event, query
              FROM pg_stat_activity
             WHERE pid = %s
            """,
            (pid,),
        ).fetchone()
        if row is not None:
            last = {
                "state": row[0],
                "wait_event_type": row[1],
                "wait_event": row[2],
                "query": row[3],
            }
            if last["state"] == "active" and last["wait_event_type"] == "Lock":
                return last
        time.sleep(0.01)
    raise AssertionError(
        f"backend {pid} never blocked on a lock within {timeout}s; last seen: {last}"
    )


def utc(y, m, d, hh=0, mm=0, ss=0) -> datetime:
    return datetime(y, m, d, hh, mm, ss, tzinfo=timezone.utc)


def riyadh_local_as_utc(y, m, d, hh=0, mm=0, ss=0) -> datetime:
    """An instant expressed as Asia/Riyadh wall clock, returned in UTC."""
    return datetime(y, m, d, hh, mm, ss, tzinfo=timezone(timedelta(hours=3))).astimezone(
        timezone.utc
    )
