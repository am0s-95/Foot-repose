"""Runtime configuration."""

from __future__ import annotations

import os

#: The application connects only as app_runtime. Migrations use a different
#: DSN so that DDL privileges are never present in the request path.
RUNTIME_DSN = os.environ.get(
    "FOOT_REPOSE_RUNTIME_DSN",
    "host=127.0.0.1 port=5432 dbname=foot_repose user=app_runtime",
)

MIGRATION_DSN = os.environ.get(
    "FOOT_REPOSE_MIGRATION_DSN",
    "host=127.0.0.1 port=5432 dbname=foot_repose user=postgres",
)

#: §6 client_correlation_id validation. Opaque to us: we bound its length and
#: alphabet so it cannot be used as an injection or storage-amplification
#: vector, and otherwise never interpret it.
CLIENT_CORRELATION_ID_MAX_LEN = 128
CLIENT_CORRELATION_ID_PATTERN = r"\A[A-Za-z0-9._:-]{1,128}\Z"

#: Idempotency key validation.
IDEMPOTENCY_KEY_MAX_LEN = 200
IDEMPOTENCY_KEY_PATTERN = r"\A[A-Za-z0-9._:-]{8,200}\Z"
