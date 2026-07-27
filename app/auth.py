"""Auth adapter (§7).

app_runtime has no read privilege on auth_identity or auth_session and no USAGE
on the auth schema at all. The only way it can learn anything about a session is
by calling ``auth_api.resolve_session`` with a token hash it was already given,
and the most that can come back is (user_id, tenant_id).

Consequences worth stating plainly:
  * there is no query shape that enumerates sessions or identities;
  * a wrong token is indistinguishable from an unknown one - both yield no row;
  * the bearer token never reaches the database, only its sha256.
"""

from __future__ import annotations

import hashlib
from dataclasses import dataclass

from app.errors import Unauthenticated


@dataclass(frozen=True)
class Principal:
    user_id: str
    tenant_id: str


def token_sha256(token: str) -> bytes:
    return hashlib.sha256(token.encode("utf-8")).digest()


def resolve_session(cur, bearer_token: str) -> Principal:
    if not bearer_token:
        raise Unauthenticated("missing bearer token")

    cur.execute(
        "SELECT user_id::text, tenant_id::text FROM auth_api.resolve_session(%s)",
        (token_sha256(bearer_token),),
    )
    row = cur.fetchone()
    if row is None:
        # Deliberately the same error for expired, revoked, disabled and
        # never-existed. The caller learns only "not usable".
        raise Unauthenticated("session is not valid")
    return Principal(user_id=row[0], tenant_id=row[1])
