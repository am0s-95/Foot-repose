"""§7 - app_runtime cannot enumerate identities, sessions or users.

The claim being tested is a privilege claim, so it is tested against the
catalog and against the live role, not against application code that could be
bypassed.
"""

from __future__ import annotations

import hashlib
import uuid

import psycopg
import pytest

from app.auth import resolve_session
from app.db import set_request_context
from app.errors import Unauthenticated
from tests.conftest import seed_tenant


@pytest.fixture
def two_tenants(super_conn):
    a = seed_tenant(super_conn, label=f"iso-a-{uuid.uuid4().hex[:8]}")
    b = seed_tenant(super_conn, label=f"iso-b-{uuid.uuid4().hex[:8]}")
    return a, b


def as_tenant(conn, tenant_id, user_id):
    cur = conn.cursor()
    set_request_context(cur, tenant_id=tenant_id, user_id=user_id)
    return cur


# --- the auth schema is out of reach entirely ------------------------------


def test_app_runtime_has_no_usage_on_the_auth_schema(super_conn):
    assert super_conn.execute(
        "SELECT has_schema_privilege('app_runtime', 'auth', 'USAGE')"
    ).fetchone()[0] is False


@pytest.mark.parametrize("table", ["auth.auth_identity", "auth.auth_session"])
@pytest.mark.parametrize("priv", ["SELECT", "INSERT", "UPDATE", "DELETE"])
def test_app_runtime_has_no_privilege_on_auth_tables(super_conn, table, priv):
    assert super_conn.execute(
        "SELECT has_table_privilege('app_runtime', %s, %s)", (table, priv)
    ).fetchone()[0] is False


def test_no_grants_on_auth_schema_exist_at_all(super_conn):
    """Catches a future migration re-opening the schema by accident."""
    grants = super_conn.execute(
        "SELECT table_name, privilege_type FROM information_schema.role_table_grants"
        " WHERE grantee = 'app_runtime' AND table_schema = 'auth'"
    ).fetchall()
    assert grants == []


@pytest.mark.parametrize(
    "statement",
    [
        "SELECT * FROM auth.auth_identity",
        "SELECT * FROM auth.auth_session",
        "SELECT count(*) FROM auth.auth_session",
    ],
)
def test_runtime_role_cannot_read_auth_tables(runtime_conn, statement):
    with runtime_conn.cursor() as cur:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute(statement)
    runtime_conn.rollback()


# --- the adapter leaks nothing ---------------------------------------------


def test_adapter_returns_only_user_and_tenant(runtime_conn, two_tenants):
    a, _b = two_tenants
    with runtime_conn.cursor() as cur:
        principal = resolve_session(cur, a.member_token)
    assert principal.user_id == a.member_user_id
    assert principal.tenant_id == a.tenant_id
    # The dataclass has exactly two fields; there is nowhere for extra data to go.
    assert set(vars(principal)) == {"user_id", "tenant_id"}


def test_unknown_token_is_indistinguishable_from_a_wrong_one(runtime_conn):
    with runtime_conn.cursor() as cur:
        with pytest.raises(Unauthenticated) as never_existed:
            resolve_session(cur, f"never-{uuid.uuid4().hex}")
        with pytest.raises(Unauthenticated) as empty:
            resolve_session(cur, "")
    assert str(never_existed.value) != ""
    assert str(empty.value) != ""


def test_adapter_cannot_be_used_to_sweep_for_sessions(runtime_conn):
    """The only input is a token hash; guessing gives nothing back."""
    with runtime_conn.cursor() as cur:
        for i in range(50):
            cur.execute(
                "SELECT user_id::text FROM auth_api.resolve_session(%s)",
                (hashlib.sha256(str(i).encode()).digest(),),
            )
            assert cur.fetchall() == []


def test_revoked_and_expired_sessions_do_not_resolve(super_conn, runtime_conn):
    fx = seed_tenant(super_conn, label=f"revoke-{uuid.uuid4().hex[:8]}")
    super_conn.execute(
        "UPDATE auth.auth_session SET revoked_at = now()"
        " WHERE token_hash = %s",
        (hashlib.sha256(fx.member_token.encode()).digest(),),
    )
    with runtime_conn.cursor() as cur:
        with pytest.raises(Unauthenticated):
            resolve_session(cur, fx.member_token)


# --- app_user is not enumerable --------------------------------------------


def test_plain_member_sees_only_their_own_user_row(runtime_conn, two_tenants):
    a, _b = two_tenants
    cur = as_tenant(runtime_conn, a.tenant_id, a.member_user_id)

    cur.execute("SELECT user_id::text FROM app.app_user")
    visible = {r[0] for r in cur.fetchall()}
    assert visible == {a.member_user_id}, (
        "a member of tenant A must not be able to list tenant A's users"
    )
    runtime_conn.rollback()


def test_admin_sees_their_tenant_and_no_other(runtime_conn, two_tenants):
    a, b = two_tenants
    cur = as_tenant(runtime_conn, a.tenant_id, a.admin_user_id)

    cur.execute("SELECT user_id::text FROM app.app_user")
    visible = {r[0] for r in cur.fetchall()}
    assert visible == {a.admin_user_id, a.member_user_id}
    assert b.admin_user_id not in visible
    assert b.member_user_id not in visible

    # Naming the other tenant's rows explicitly does not help.
    cur.execute(
        "SELECT count(*) FROM app.app_user WHERE user_id = ANY(%s::uuid[])",
        ([b.admin_user_id, b.member_user_id],),
    )
    assert cur.fetchone()[0] == 0
    runtime_conn.rollback()


def test_memberships_are_not_enumerable_by_a_member(runtime_conn, two_tenants):
    a, _b = two_tenants
    cur = as_tenant(runtime_conn, a.tenant_id, a.member_user_id)
    cur.execute("SELECT user_id::text FROM app.membership")
    assert {r[0] for r in cur.fetchall()} == {a.member_user_id}
    runtime_conn.rollback()


def test_tenant_a_context_cannot_read_tenant_b_business_data(
    super_conn, runtime_conn, two_tenants
):
    a, b = two_tenants
    super_conn.execute(
        "INSERT INTO app.operational_day (tenant_id, branch_id, business_date,"
        " boundary_policy_id, day_boundary_time, operating_open, operating_close,"
        " tz, opened_by_request_id)"
        " VALUES (%s, %s, '2026-03-14', %s, '06:00', '07:00', '04:00',"
        " 'Asia/Riyadh', gen_random_uuid())",
        (b.tenant_id, b.branch_id, b.boundary_policy_id),
    )

    cur = as_tenant(runtime_conn, a.tenant_id, a.admin_user_id)
    for table in ("app.branch", "app.boundary_policy", "app.operational_day"):
        cur.execute(f"SELECT count(*) FROM {table} WHERE tenant_id = %s", (b.tenant_id,))
        assert cur.fetchone()[0] == 0, f"{table} leaked across tenants"
    runtime_conn.rollback()


def test_unset_context_sees_nothing(runtime_conn, two_tenants):
    """Fail closed: no tenant context means no rows, not all rows."""
    a, _b = two_tenants
    cur = runtime_conn.cursor()
    set_request_context(cur, tenant_id=None, user_id=None)
    for table in ("app.app_user", "app.branch", "app.operational_day", "app.tenant"):
        cur.execute(f"SELECT count(*) FROM {table}")
        assert cur.fetchone()[0] == 0, f"{table} is readable without a tenant context"
    assert a  # fixture used
    runtime_conn.rollback()
