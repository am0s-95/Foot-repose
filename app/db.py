"""Database access for the runtime role.

Everything in the request path goes through :func:`runtime_transaction`, which
pins READ COMMITTED (required by the row claim in ``app.rowclaim``) and installs
the session context the RLS policies read.
"""

from __future__ import annotations

from contextlib import contextmanager

import psycopg

from app.config import RUNTIME_DSN


def connect(dsn: str | None = None, *, autocommit: bool = False) -> psycopg.Connection:
    conn = psycopg.connect(dsn or RUNTIME_DSN, autocommit=autocommit)
    # READ COMMITTED is the correctness requirement, not a default we tolerate:
    # the claim algorithm depends on each statement taking a fresh snapshot.
    conn.isolation_level = psycopg.IsolationLevel.READ_COMMITTED
    return conn


def set_request_context(cur, *, tenant_id: str | None, user_id: str | None) -> None:
    """Install the tenant/user context that RLS policies read.

    ``set_config(..., is_local => true)`` scopes it to the current transaction,
    so a pooled connection can never leak one request's tenant into the next.
    """
    cur.execute(
        "SELECT set_config('app.current_tenant_id', %s, true),"
        "       set_config('app.current_user_id', %s, true)",
        (tenant_id or "", user_id or ""),
    )


@contextmanager
def runtime_transaction(conn: psycopg.Connection, *, tenant_id: str | None = None,
                        user_id: str | None = None):
    """One request, one transaction.

    Any exception unwinds the whole transaction, which is what makes §5's "full
    rollback, no committed writes" and §8's "no IN_PROGRESS survives" hold
    without any compensating logic.
    """
    with conn.transaction():
        with conn.cursor() as cur:
            set_request_context(cur, tenant_id=tenant_id, user_id=user_id)
            yield cur
