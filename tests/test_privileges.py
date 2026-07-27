"""§1/§7 - the privilege facts the algorithms depend on.

The row claim in ``app.rowclaim`` is only sound because the conflicting row
cannot be deleted between the INSERT and the follow-up SELECT. That is a grant,
not a convention, so it is asserted from the catalog.
"""

from __future__ import annotations

import psycopg
import pytest

from app.db import set_request_context
from app.rowclaim import CLAIMED_TABLES
from tests.conftest import seed_tenant


@pytest.mark.parametrize("table", CLAIMED_TABLES)
def test_runtime_role_cannot_delete_from_claimed_tables(super_conn, table):
    assert super_conn.execute(
        "SELECT has_table_privilege('app_runtime', %s, 'DELETE')", (table,)
    ).fetchone()[0] is False, (
        f"{table} is claimed with INSERT ... ON CONFLICT DO NOTHING; DELETE must "
        "stay revoked or the follow-up SELECT could miss the conflicting row"
    )


def test_idempotency_records_are_immutable_for_the_runtime_role(super_conn):
    """No UPDATE either: a record is written complete and never advanced (§8)."""
    assert super_conn.execute(
        "SELECT has_table_privilege('app_runtime', 'app.idempotency_record', 'UPDATE')"
    ).fetchone()[0] is False


def test_delete_is_actually_refused_at_runtime(runtime_conn, super_conn):
    fx = seed_tenant(super_conn, label="privdel")
    with runtime_conn.cursor() as cur:
        set_request_context(cur, tenant_id=fx.tenant_id, user_id=fx.admin_user_id)
        for table in CLAIMED_TABLES:
            with pytest.raises(psycopg.errors.InsufficientPrivilege):
                cur.execute(f"DELETE FROM {table}")
            runtime_conn.rollback()
            set_request_context(cur, tenant_id=fx.tenant_id, user_id=fx.admin_user_id)
    runtime_conn.rollback()


def test_runtime_role_is_not_privileged(super_conn):
    row = super_conn.execute(
        "SELECT rolsuper, rolbypassrls, rolcreatedb, rolcreaterole"
        " FROM pg_roles WHERE rolname = 'app_runtime'"
    ).fetchone()
    assert row == (False, False, False, False), (
        "app_runtime must not be able to bypass RLS or escalate"
    )


def test_row_level_security_is_enabled_on_every_tenant_scoped_table(super_conn):
    missing = super_conn.execute(
        """
        SELECT c.relname
          FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id'
         WHERE n.nspname = 'app'
           AND c.relkind = 'r'
           AND NOT c.relrowsecurity
        """
    ).fetchall()
    assert missing == [], f"tables with tenant_id but no RLS: {missing}"


def test_runtime_role_cannot_run_ddl(runtime_conn):
    with runtime_conn.cursor() as cur:
        with pytest.raises(psycopg.errors.InsufficientPrivilege):
            cur.execute("CREATE TABLE app.sneaky (x int)")
    runtime_conn.rollback()
