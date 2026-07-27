-- 0002_auth.sql
--
-- Auth storage plus the narrow adapter surface app_runtime is allowed to call.
--
-- §7 of the spec: app_runtime must not hold table-wide read on auth_identity or
-- auth_session. Instead it gets EXECUTE on exactly two SECURITY DEFINER
-- functions that each return the minimum viable projection, keyed by a secret
-- the caller must already possess. Neither function accepts a predicate that
-- would let a caller walk the table, and neither returns more than one row.

SET ROLE auth_owner;

CREATE TABLE auth.auth_identity (
    auth_identity_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id          uuid NOT NULL,
    tenant_id        uuid NOT NULL,
    -- sha256 of the identity's login secret; never the secret itself
    credential_hash  bytea NOT NULL,
    disabled_at      timestamptz,
    created_at       timestamptz NOT NULL DEFAULT now(),
    UNIQUE (user_id)
);

CREATE TABLE auth.auth_session (
    auth_session_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    auth_identity_id uuid NOT NULL REFERENCES auth.auth_identity,
    -- sha256 of the bearer token; the token itself is never stored
    token_hash      bytea NOT NULL UNIQUE,
    issued_at       timestamptz NOT NULL DEFAULT now(),
    expires_at      timestamptz NOT NULL,
    revoked_at      timestamptz,
    CONSTRAINT auth_session_expiry_after_issue CHECK (expires_at > issued_at)
);

CREATE INDEX auth_session_identity_idx ON auth.auth_session (auth_identity_id);

-- The whole adapter surface. Returns (user_id, tenant_id) and nothing else:
-- no session id, no identity id, no timestamps, no existence oracle beyond
-- "this exact token hash is live right now".
CREATE FUNCTION auth_api.resolve_session(p_token_sha256 bytea)
RETURNS TABLE (user_id uuid, tenant_id uuid)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, auth
AS $$
    SELECT i.user_id, i.tenant_id
      FROM auth.auth_session s
      JOIN auth.auth_identity i ON i.auth_identity_id = s.auth_identity_id
     WHERE s.token_hash = p_token_sha256
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND i.disabled_at IS NULL
     LIMIT 1;
$$;

RESET ROLE;

-- Deny by default, then grant only EXECUTE to the runtime role.
REVOKE ALL ON ALL TABLES IN SCHEMA auth FROM PUBLIC, app_runtime;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA auth_api FROM PUBLIC;

GRANT EXECUTE ON FUNCTION auth_api.resolve_session(bytea) TO app_runtime;

-- Session issuance and revocation are deliberately absent from this surface.
-- They belong to the auth owner, outside anything app_runtime can reach, so a
-- compromised runtime role cannot mint or extend a session.
