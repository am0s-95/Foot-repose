"""HTTP surface.

§6 in one place:
  * ``request_id`` is minted server side for every HTTP request, always. There
    is no header that lets a client supply or influence it.
  * ``client_correlation_id`` is optional, validated for length and shape, kept
    strictly separate, echoed back for the client's own tracing, and used for
    nothing else. It is not an authorization input and it is not part of the
    idempotency key or fingerprint.
  * A replay therefore carries a *new* request_id in its log line and its
    ``X-Request-Id`` header, while creating no new audit or outbox row.
"""

from __future__ import annotations

import json
import logging
import re
import uuid

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from starlette.concurrency import run_in_threadpool

from app import db
from app.auth import resolve_session
from app.clock import Clock, SystemClock
from app.config import (
    CLIENT_CORRELATION_ID_PATTERN,
    IDEMPOTENCY_KEY_PATTERN,
)
from app.errors import (
    ApiError,
    InvalidClientCorrelationId,
    InvalidIdempotencyKey,
    InvalidRequest,
    MissingIdempotencyKey,
)
from app.hooks import NULL_HOOKS, ClaimHooks
from app.service import LostIdempotencyRace, Outcome, create_shift_entry

log = logging.getLogger("foot_repose")

_CORRELATION_RE = re.compile(CLIENT_CORRELATION_ID_PATTERN)
_IDEMPOTENCY_RE = re.compile(IDEMPOTENCY_KEY_PATTERN)


def validate_client_correlation_id(raw: str | None) -> str | None:
    """§6: optional, bounded, opaque. Never authorization, never idempotency."""
    if raw is None:
        return None
    if not _CORRELATION_RE.match(raw):
        raise InvalidClientCorrelationId(
            "client correlation id must be 1-128 characters of [A-Za-z0-9._:-]"
        )
    return raw


def validate_idempotency_key(raw: str | None) -> str:
    if raw is None:
        raise MissingIdempotencyKey("Idempotency-Key header is required")
    if not _IDEMPOTENCY_RE.match(raw):
        raise InvalidIdempotencyKey(
            "idempotency key must be 8-200 characters of [A-Za-z0-9._:-]"
        )
    return raw


def create_app(
    *,
    clock: Clock | None = None,
    hooks: ClaimHooks | None = None,
    dsn: str | None = None,
) -> FastAPI:
    request_clock: Clock = clock or SystemClock()
    claim_hooks: ClaimHooks = hooks or NULL_HOOKS
    api = FastAPI(title="foot-repose")

    @api.middleware("http")
    async def request_id_middleware(request: Request, call_next):
        # Minted here and nowhere else. Not read from any inbound header.
        request_id = str(uuid.uuid4())
        request.state.request_id = request_id
        response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        return response

    @api.post("/v1/shift-entries")
    async def post_shift_entry(request: Request):
        request_id = request.state.request_id
        correlation_id = None
        try:
            correlation_id = validate_client_correlation_id(
                request.headers.get("X-Client-Correlation-Id")
            )
            idempotency_key = validate_idempotency_key(
                request.headers.get("Idempotency-Key")
            )
            raw = await request.body()
            try:
                payload = json.loads(raw or b"{}")
            except json.JSONDecodeError as exc:
                raise InvalidRequest("body must be valid JSON") from exc

            bearer = _bearer_token(request)
            # _handle is blocking (psycopg is synchronous), so it must not run
            # on the event loop.
            outcome = await run_in_threadpool(
                _handle,
                dsn=dsn,
                bearer=bearer,
                idempotency_key=idempotency_key,
                payload=payload,
                now_utc=request_clock.now(),
                request_id=request_id,
                hooks=claim_hooks,
            )
        except ApiError as exc:
            log.warning(
                "request failed",
                extra={
                    "request_id": request_id,
                    "client_correlation_id": correlation_id,
                    "code": exc.code,
                },
            )
            return _respond(
                exc.http_status, exc.to_body(request_id), request_id, correlation_id
            )

        log.info(
            "request completed",
            extra={
                "request_id": request_id,
                "client_correlation_id": correlation_id,
                "replayed": outcome.replayed,
            },
        )
        headers_extra = {"Idempotent-Replay": "true"} if outcome.replayed else {}
        return _respond(
            outcome.status, outcome.body, request_id, correlation_id, headers_extra
        )

    return api


def _bearer_token(request: Request) -> str:
    header = request.headers.get("Authorization", "")
    scheme, _, token = header.partition(" ")
    return token.strip() if scheme.lower() == "bearer" else ""


def _respond(status, body, request_id, correlation_id, extra=None) -> JSONResponse:
    headers = {"X-Request-Id": request_id}
    if correlation_id is not None:
        headers["X-Client-Correlation-Id"] = correlation_id
    headers.update(extra or {})
    return JSONResponse(status_code=status, content=body, headers=headers)


def _handle(*, dsn, bearer, idempotency_key, payload, now_utc, request_id, hooks) -> Outcome:
    """One request, one connection, one transaction."""
    with db.connect(dsn) as conn:
        # Session resolution happens before the tenant context exists, since the
        # session is what tells us which tenant we are in.
        with conn.transaction():
            with conn.cursor() as cur:
                principal = resolve_session(cur, bearer)

        try:
            with db.runtime_transaction(
                conn, tenant_id=principal.tenant_id, user_id=principal.user_id
            ) as cur:
                return create_shift_entry(
                    cur,
                    principal=principal,
                    idempotency_key=idempotency_key,
                    payload=payload,
                    now_utc=now_utc,
                    request_id=request_id,
                    hooks=hooks,
                )
        except LostIdempotencyRace as race:
            # The transaction has already been rolled back by the context
            # manager, so our duplicate effect is gone. Serve the winner's
            # stored response.
            return Outcome(status=race.status, body=race.body, replayed=True)
