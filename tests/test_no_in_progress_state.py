"""§8 - IN_PROGRESS is never committed-visible, and nothing recovers from it.

The design has no in-flight idempotency state at all. A record is inserted,
complete, in the same transaction as the effect it describes. Either both
commit or neither does.

Two things follow, and both are tested here:
  * there is no schema slot an IN_PROGRESS marker could live in;
  * a fault after the insert but before the commit leaves nothing behind, so no
    recovery path could find a stale record even if one were written for it.
"""

from __future__ import annotations

import ast
import json
import pathlib
import re
import uuid

import pytest
from fastapi.testclient import TestClient

from app.api import create_app
from app.clock import FixedClock
from app.hooks import ClaimHooks
from tests.conftest import RUNTIME_DSN, riyadh_local_as_utc, seed_tenant

NOW = riyadh_local_as_utc(2026, 3, 14, 20, 0)
REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent

TABLES = (
    "app.idempotency_record",
    "app.operational_day",
    "app.shift_entry",
    "app.audit_event",
    "app.outbox_message",
)


class InjectedFault(RuntimeError):
    pass


class FaultAfterIdempotencyInsert(ClaimHooks):
    """Fails with the idempotency record written but not yet committed."""

    def __init__(self) -> None:
        self.fired = False

    def after_idempotency_insert(self) -> None:
        self.fired = True
        raise InjectedFault("injected fault between write and commit")


def post(client, fx, key):
    return client.post(
        "/v1/shift-entries",
        content=json.dumps(
            {
                "branch_code": fx.branch_code,
                "staff_ref": "s1",
                "minutes": 30,
                "expected_business_date": "2026-03-14",
                "note": None,
            }
        ),
        headers={
            "Authorization": f"Bearer {fx.member_token}",
            "Idempotency-Key": key,
        },
    )


# --- schema ----------------------------------------------------------------


def test_idempotency_record_has_no_state_column(super_conn):
    columns = {
        r[0]
        for r in super_conn.execute(
            "SELECT column_name FROM information_schema.columns"
            " WHERE table_schema = 'app' AND table_name = 'idempotency_record'"
        ).fetchall()
    }
    assert not (columns & {"status", "state", "phase", "stage"}), (
        f"idempotency_record has a lifecycle column: {columns}"
    )


def test_no_enum_type_declares_in_progress(super_conn):
    labels = super_conn.execute(
        "SELECT count(*) FROM pg_enum WHERE upper(enumlabel) = 'IN_PROGRESS'"
    ).fetchone()[0]
    assert labels == 0


def _docstring_nodes(tree: ast.AST) -> set[int]:
    holders = (ast.Module, ast.ClassDef, ast.FunctionDef, ast.AsyncFunctionDef)
    ids = set()
    for node in ast.walk(tree):
        if isinstance(node, holders) and node.body:
            first = node.body[0]
            if (
                isinstance(first, ast.Expr)
                and isinstance(first.value, ast.Constant)
                and isinstance(first.value.value, str)
            ):
                ids.add(id(first.value))
    return ids


def _python_code_mentions(path: pathlib.Path) -> list[str]:
    """Occurrences of IN_PROGRESS in executable Python, ignoring prose."""
    tree = ast.parse(path.read_text())
    docstrings = _docstring_nodes(tree)
    hits = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            if id(node) not in docstrings and "IN_PROGRESS" in node.value:
                hits.append(node.lineno)
        elif isinstance(node, ast.Name) and "IN_PROGRESS" in node.id:
            hits.append(node.lineno)
        elif isinstance(node, ast.Attribute) and "IN_PROGRESS" in node.attr:
            hits.append(node.lineno)
    return [f"{path.name}:{line}" for line in hits]


def _sql_code_mentions(path: pathlib.Path) -> list[str]:
    """Same, for SQL: strip -- and /* */ comments, then look at what is left."""
    text = re.sub(r"/\*.*?\*/", "", path.read_text(), flags=re.S)
    text = re.sub(r"--[^\n]*", "", text)
    return [
        f"{path.name}:{i}"
        for i, line in enumerate(text.splitlines(), 1)
        if "IN_PROGRESS" in line
    ]


def test_no_source_file_implements_in_progress_recovery():
    """Guards the decision against being quietly reintroduced later.

    Prose about the decision is fine and expected; an identifier or string
    literal is not, because that is what a recovery path would need.
    """
    offenders = []
    for path in sorted((REPO_ROOT / "app").rglob("*.py")):
        offenders += _python_code_mentions(path)
    for path in sorted((REPO_ROOT / "db").rglob("*.sql")):
        offenders += _sql_code_mentions(path)
    assert offenders == [], f"IN_PROGRESS appears in executable code: {offenders}"


# --- fault injection -------------------------------------------------------


def test_fault_after_insert_leaves_nothing_committed(super_conn):
    fx = seed_tenant(super_conn, label=f"fault-{uuid.uuid4().hex[:8]}")
    hooks = FaultAfterIdempotencyInsert()
    key = f"fault-{uuid.uuid4().hex}"

    with TestClient(
        create_app(clock=FixedClock(NOW), hooks=hooks, dsn=RUNTIME_DSN)
    ) as client:
        with pytest.raises(InjectedFault):
            post(client, fx, key)

    assert hooks.fired, "the fault never fired; the test proved nothing"

    for table in TABLES:
        count = super_conn.execute(
            f"SELECT count(*) FROM {table} WHERE tenant_id = %s", (fx.tenant_id,)
        ).fetchone()[0]
        assert count == 0, f"{table} kept {count} rows after the rollback"


def test_the_key_is_still_usable_after_the_fault(super_conn):
    """No poisoned key: because nothing was committed, a retry is a fresh start.

    This is the property a recovery path would otherwise have to provide.
    """
    fx = seed_tenant(super_conn, label=f"retry-{uuid.uuid4().hex[:8]}")
    key = f"retry-{uuid.uuid4().hex}"

    with TestClient(
        create_app(
            clock=FixedClock(NOW), hooks=FaultAfterIdempotencyInsert(), dsn=RUNTIME_DSN
        )
    ) as failing:
        with pytest.raises(InjectedFault):
            post(failing, fx, key)

    with TestClient(create_app(clock=FixedClock(NOW), dsn=RUNTIME_DSN)) as healthy:
        retried = post(healthy, fx, key)

    assert retried.status_code == 201
    assert "Idempotent-Replay" not in retried.headers, (
        "the retry must do the work, not replay a record that should not exist"
    )
    assert super_conn.execute(
        "SELECT count(*) FROM app.shift_entry WHERE tenant_id = %s", (fx.tenant_id,)
    ).fetchone()[0] == 1


def test_a_concurrent_reader_never_observes_an_uncommitted_record(super_conn):
    """The record's visibility is exactly the effect's visibility.

    A second connection polls throughout the faulting request and must never see
    an idempotency record, since the only one written is rolled back.
    """
    import threading
    import time

    fx = seed_tenant(super_conn, label=f"visib-{uuid.uuid4().hex[:8]}")
    key = f"visib-{uuid.uuid4().hex}"
    sightings = []
    stop = threading.Event()

    def poll():
        while not stop.is_set():
            sightings.append(
                super_conn.execute(
                    "SELECT count(*) FROM app.idempotency_record WHERE tenant_id = %s",
                    (fx.tenant_id,),
                ).fetchone()[0]
            )
            time.sleep(0.001)

    watcher = threading.Thread(target=poll, daemon=True)
    watcher.start()
    try:
        with TestClient(
            create_app(
                clock=FixedClock(NOW),
                hooks=FaultAfterIdempotencyInsert(),
                dsn=RUNTIME_DSN,
            )
        ) as client:
            with pytest.raises(InjectedFault):
                post(client, fx, key)
    finally:
        stop.set()
        watcher.join(5)

    assert sightings, "the watcher never ran"
    assert set(sightings) == {0}, f"an uncommitted record became visible: {sightings}"
