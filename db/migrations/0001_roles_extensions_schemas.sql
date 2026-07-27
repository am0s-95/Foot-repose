-- 0001_roles_extensions_schemas.sql
--
-- Roles, schemas and extensions.
--
-- Three roles with distinct blast radius:
--   migrator     - owns app.* objects, runs DDL (the migration connection)
--   auth_owner   - owns auth.* tables and the SECURITY DEFINER adapter functions
--   app_runtime  - the only role the application process ever connects as
--
-- app_runtime is deliberately NOT the owner of anything, so row level security
-- always applies to it (owners bypass RLS unless FORCE is set), and it can be
-- stripped of individual privileges without affecting DDL.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- Needed by the boundary_policy exclusion constraint: btree_gist supplies the
-- gist operator classes for the scalar `uuid WITH =` parts of the constraint.
-- The daterange `&&` part is served by the built-in range gist opclass.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'migrator') THEN
        CREATE ROLE migrator LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'auth_owner') THEN
        CREATE ROLE auth_owner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
        CREATE ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
    END IF;
END
$$;

-- No ambient CREATE rights anywhere; SECURITY DEFINER functions below pin
-- search_path to schemas that untrusted roles cannot write into.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

CREATE SCHEMA IF NOT EXISTS app     AUTHORIZATION migrator;
CREATE SCHEMA IF NOT EXISTS auth    AUTHORIZATION auth_owner;
CREATE SCHEMA IF NOT EXISTS auth_api AUTHORIZATION auth_owner;

GRANT USAGE ON SCHEMA app      TO app_runtime;
GRANT USAGE ON SCHEMA auth_api TO app_runtime;

-- Gate 7 (§7): app_runtime never gets to look inside the auth schema at all.
-- Without USAGE on the schema, no table-level grant can accidentally re-open it.
REVOKE ALL ON SCHEMA auth FROM app_runtime, PUBLIC;
