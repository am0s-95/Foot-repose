"""Error taxonomy.

Every error here is raised from inside the request transaction. The transaction
is opened with a context manager in ``app.service``, so raising unwinds it and
no write is ever committed - which is what §5 requires for both
BOUNDARY_POLICY_UNRESOLVED and BOUNDARY_POLICY_INVARIANT_VIOLATED.
"""

from __future__ import annotations


class ApiError(Exception):
    """An error with a stable wire code and HTTP status."""

    http_status: int = 500
    code: str = "INTERNAL_ERROR"

    def __init__(self, message: str, **details: object) -> None:
        super().__init__(message)
        self.message = message
        self.details = details

    def to_body(self, request_id: str) -> dict:
        body: dict = {"code": self.code, "message": self.message, "request_id": request_id}
        if self.details:
            body["details"] = self.details
        return body


# --- §5 boundary policy resolution ----------------------------------------


class BoundaryPolicyUnresolved(ApiError):
    """No policy is in effect for the branch on the date being resolved."""

    http_status = 409
    code = "BOUNDARY_POLICY_UNRESOLVED"


class BoundaryPolicyInvariantViolated(ApiError):
    """More than one policy matched despite the exclusion constraint.

    Reaching this means the constraint was dropped, disabled or bypassed. It is
    a server fault, not a client one, hence 500.
    """

    http_status = 500
    code = "BOUNDARY_POLICY_INVARIANT_VIOLATED"


# --- §3 idempotency --------------------------------------------------------


class IdempotencyKeyReused(ApiError):
    """The key exists but the request's logical fields differ from the stored ones."""

    http_status = 409
    code = "IDEMPOTENCY_KEY_REUSED"


class MissingIdempotencyKey(ApiError):
    http_status = 400
    code = "IDEMPOTENCY_KEY_REQUIRED"


class InvalidIdempotencyKey(ApiError):
    http_status = 400
    code = "IDEMPOTENCY_KEY_INVALID"


# --- §6 correlation --------------------------------------------------------


class InvalidClientCorrelationId(ApiError):
    http_status = 400
    code = "CLIENT_CORRELATION_ID_INVALID"


# --- misc ------------------------------------------------------------------


class Unauthenticated(ApiError):
    http_status = 401
    code = "UNAUTHENTICATED"


class InvalidRequest(ApiError):
    http_status = 400
    code = "INVALID_REQUEST"


class UnknownBranch(ApiError):
    http_status = 404
    code = "BRANCH_NOT_FOUND"


class RowClaimInvariantViolated(ApiError):
    """ON CONFLICT reported a conflict but the follow-up SELECT found nothing.

    Unreachable while DELETE stays revoked from app_runtime on the claimed
    tables (§1, migration 0004). If it is ever raised, that grant has regressed.
    """

    http_status = 500
    code = "ROW_CLAIM_INVARIANT_VIOLATED"


class IsolationLevelInvariantViolated(ApiError):
    """The claim algorithm requires READ COMMITTED and got something else.

    Under REPEATABLE READ the follow-up SELECT would reuse the transaction's
    original snapshot and could not see the row committed by the winner, so the
    algorithm would be silently wrong rather than loudly broken.
    """

    http_status = 500
    code = "ISOLATION_LEVEL_INVARIANT_VIOLATED"
