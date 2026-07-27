"""§6 - request_id and client_correlation_id.

request_id is minted by the server for every HTTP request. client_correlation_id
is the client's own tracing handle: optional, validated, echoed, and inert. It
must not reach authorization or idempotency.
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


@pytest.fixture
def client():
    with TestClient(create_app(clock=FixedClock(NOW), dsn=RUNTIME_DSN)) as c:
        yield c


def body_for(fx, **overrides):
    return {
        "branch_code": fx.branch_code,
        "staff_ref": "s1",
        "minutes": 30,
        "expected_business_date": "2026-03-14",
        "note": None,
        **overrides,
    }


def post(client, fx, key, body=None, headers=None):
    hdrs = {
        "Authorization": f"Bearer {fx.member_token}",
        "Idempotency-Key": key,
        **(headers or {}),
    }
    return client.post(
        "/v1/shift-entries", content=json.dumps(body or body_for(fx)), headers=hdrs
    )


def test_request_id_is_server_generated_and_unique(super_conn, client):
    fx = seed_tenant(super_conn, label=f"rid-{uuid.uuid4().hex[:8]}")

    first = post(client, fx, f"rid-{uuid.uuid4().hex}")
    second = post(client, fx, f"rid-{uuid.uuid4().hex}", body_for(fx, staff_ref="s2"))

    a = first.headers["X-Request-Id"]
    b = second.headers["X-Request-Id"]
    assert uuid.UUID(a) and uuid.UUID(b)
    assert a != b


def test_inbound_request_id_header_is_ignored(super_conn, client):
    """A client cannot choose, spoof or reuse a request_id."""
    fx = seed_tenant(super_conn, label=f"ridspoof-{uuid.uuid4().hex[:8]}")
    forged = "11111111-1111-1111-1111-111111111111"

    response = post(
        client, fx, f"spoof-{uuid.uuid4().hex}", headers={"X-Request-Id": forged}
    )

    assert response.status_code == 201
    assert response.headers["X-Request-Id"] != forged

    stored = super_conn.execute(
        "SELECT request_id::text FROM app.audit_event WHERE tenant_id = %s",
        (fx.tenant_id,),
    ).fetchone()[0]
    assert stored == response.headers["X-Request-Id"]
    assert stored != forged


def test_error_responses_also_carry_a_request_id(super_conn, client):
    fx = seed_tenant(super_conn, label=f"riderr-{uuid.uuid4().hex[:8]}")
    response = post(client, fx, "short")  # fails key validation
    assert response.status_code == 400
    assert response.json()["code"] == "IDEMPOTENCY_KEY_INVALID"
    assert uuid.UUID(response.headers["X-Request-Id"])
    assert response.json()["request_id"] == response.headers["X-Request-Id"]


# --- client_correlation_id -------------------------------------------------


def test_correlation_id_is_optional_and_echoed(super_conn, client):
    fx = seed_tenant(super_conn, label=f"corr-{uuid.uuid4().hex[:8]}")

    without = post(client, fx, f"c1-{uuid.uuid4().hex}")
    assert without.status_code == 201
    assert "X-Client-Correlation-Id" not in without.headers

    corr = "trace.abc-123:9"
    with_corr = post(
        client,
        fx,
        f"c2-{uuid.uuid4().hex}",
        body_for(fx, staff_ref="s2"),
        {"X-Client-Correlation-Id": corr},
    )
    assert with_corr.status_code == 201
    assert with_corr.headers["X-Client-Correlation-Id"] == corr


@pytest.mark.parametrize(
    "bad",
    [
        "",                    # empty
        "a" * 129,             # too long
        "has space",           # disallowed character
        "semi;colon",
        "new\nline",
    ],
)
def test_malformed_correlation_id_is_rejected(super_conn, client, bad):
    fx = seed_tenant(super_conn, label=f"corrbad-{uuid.uuid4().hex[:8]}")
    response = post(
        client,
        fx,
        f"c3-{uuid.uuid4().hex}",
        headers={"X-Client-Correlation-Id": bad},
    )
    assert response.status_code == 400
    assert response.json()["code"] == "CLIENT_CORRELATION_ID_INVALID"
    assert super_conn.execute(
        "SELECT count(*) FROM app.shift_entry WHERE tenant_id = %s", (fx.tenant_id,)
    ).fetchone()[0] == 0


def test_correlation_id_does_not_participate_in_idempotency(super_conn, client):
    """Two requests differing only by correlation id are the same request."""
    fx = seed_tenant(super_conn, label=f"corrid-{uuid.uuid4().hex[:8]}")
    key = f"c4-{uuid.uuid4().hex}"

    first = post(client, fx, key, headers={"X-Client-Correlation-Id": "trace-one"})
    assert first.status_code == 201

    second = post(client, fx, key, headers={"X-Client-Correlation-Id": "trace-two"})
    assert second.status_code == 201
    assert second.headers["Idempotent-Replay"] == "true"
    assert second.json() == first.json()
    assert second.headers["X-Client-Correlation-Id"] == "trace-two"

    stored_fields = super_conn.execute(
        "SELECT fingerprint_fields FROM app.idempotency_record"
        " WHERE tenant_id = %s AND idempotency_key = %s",
        (fx.tenant_id, key),
    ).fetchone()[0]
    assert "client_correlation_id" not in stored_fields


def test_correlation_id_does_not_grant_access(super_conn, client):
    """It is not an authorization input: a bad token stays a bad token."""
    fx = seed_tenant(super_conn, label=f"corrauth-{uuid.uuid4().hex[:8]}")
    response = client.post(
        "/v1/shift-entries",
        content=json.dumps(body_for(fx)),
        headers={
            "Authorization": "Bearer not-a-real-token",
            "Idempotency-Key": f"c5-{uuid.uuid4().hex}",
            "X-Client-Correlation-Id": "trace-privileged",
        },
    )
    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHENTICATED"


def test_replay_writes_no_new_audit_or_outbox(super_conn, client):
    """§6: a replay is observable in logs and headers, invisible in the trail."""
    fx = seed_tenant(super_conn, label=f"replaytrail-{uuid.uuid4().hex[:8]}")
    key = f"c6-{uuid.uuid4().hex}"

    first = post(client, fx, key)
    assert first.status_code == 201

    def counts():
        return super_conn.execute(
            "SELECT (SELECT count(*) FROM app.audit_event WHERE tenant_id = %(t)s),"
            "       (SELECT count(*) FROM app.outbox_message WHERE tenant_id = %(t)s)",
            {"t": fx.tenant_id},
        ).fetchone()

    before = counts()
    for _ in range(3):
        replay = post(client, fx, key)
        assert replay.status_code == 201
        assert replay.headers["Idempotent-Replay"] == "true"
        assert replay.headers["X-Request-Id"] != first.headers["X-Request-Id"]

    assert counts() == before
