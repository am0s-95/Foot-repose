-- 0004_grants_rls.sql
--
-- Privilege surface for app_runtime, and row level security for tenant
-- isolation. Deny first, then grant the minimum each table actually needs.

SET ROLE migrator;

REVOKE ALL ON ALL TABLES    IN SCHEMA app FROM PUBLIC, app_runtime;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA app FROM PUBLIC, app_runtime;

GRANT EXECUTE ON FUNCTION app.current_tenant_id() TO app_runtime;
GRANT EXECUTE ON FUNCTION app.current_user_id()   TO app_runtime;

-- The membership check used by the app_user and membership policies below.
--
-- It has to be SECURITY DEFINER: a policy on app.membership that queries
-- app.membership re-enters its own policy and PostgreSQL rejects it with
-- "infinite recursion detected in policy". Running as the table owner steps
-- outside RLS and breaks the cycle.
--
-- It is not an enumeration vector: the caller must name a tenant, gets back a
-- single boolean about *itself*, and cannot use it to list anything.
CREATE FUNCTION app.is_tenant_admin(p_tenant_id uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = pg_catalog, app
AS $$
    SELECT EXISTS (
        SELECT 1 FROM app.membership m
         WHERE m.user_id   = app.current_user_id()
           AND m.tenant_id = p_tenant_id
           AND m.role      = 'admin'
    )
$$;

REVOKE ALL ON FUNCTION app.is_tenant_admin(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.is_tenant_admin(uuid) TO app_runtime;

-- Reference data: read only.
GRANT SELECT ON app.tenant          TO app_runtime;
GRANT SELECT ON app.branch          TO app_runtime;
GRANT SELECT ON app.membership      TO app_runtime;
GRANT SELECT ON app.boundary_policy TO app_runtime;

-- §7: app_user is readable only through the RLS policy below (own row, or an
-- admin membership in the row's tenant). No INSERT/UPDATE/DELETE at runtime.
GRANT SELECT ON app.app_user TO app_runtime;

-- ---------------------------------------------------------------------------
-- §1  No DELETE on idempotency_record or operational_day.
--
-- This is what makes the insert-then-select claim algorithm sound: once
-- ON CONFLICT DO NOTHING reports a conflict, the conflicting row is committed
-- (or will be) and cannot be removed by the application before the following
-- SELECT statement observes it. The "row vanished" branch is therefore
-- unreachable rather than merely unlikely, and is asserted as an invariant
-- breach in app/rowclaim.py.
--
-- idempotency_record additionally gets no UPDATE: a record is written once,
-- complete, and never mutated (§8 - no IN_PROGRESS state to advance).
-- ---------------------------------------------------------------------------
GRANT SELECT, INSERT         ON app.idempotency_record TO app_runtime;
GRANT SELECT, INSERT, UPDATE ON app.operational_day    TO app_runtime;

GRANT SELECT, INSERT ON app.shift_entry    TO app_runtime;
GRANT SELECT, INSERT ON app.audit_event    TO app_runtime;
GRANT SELECT, INSERT ON app.outbox_message TO app_runtime;
GRANT UPDATE (published_at) ON app.outbox_message TO app_runtime;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

ALTER TABLE app.tenant            ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.branch            ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.app_user          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.membership        ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.boundary_policy   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.operational_day   ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.idempotency_record ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.shift_entry       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.audit_event       ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.outbox_message    ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_self ON app.tenant FOR SELECT TO app_runtime
    USING (tenant_id = app.current_tenant_id());

CREATE POLICY branch_tenant ON app.branch FOR SELECT TO app_runtime
    USING (tenant_id = app.current_tenant_id());

CREATE POLICY boundary_policy_tenant ON app.boundary_policy FOR SELECT TO app_runtime
    USING (tenant_id = app.current_tenant_id());

-- §7: own row, or an explicit admin membership in that row's tenant. Note the
-- tenant predicate is *not* sufficient on its own - a plain member of tenant A
-- cannot enumerate tenant A's users.
CREATE POLICY app_user_self_or_admin ON app.app_user FOR SELECT TO app_runtime
    USING (
        user_id = app.current_user_id()
        OR app.is_tenant_admin(tenant_id)
    );

CREATE POLICY membership_self_or_admin ON app.membership FOR SELECT TO app_runtime
    USING (
        user_id = app.current_user_id()
        OR app.is_tenant_admin(tenant_id)
    );

-- Business tables: straight tenant scoping, on both read and write.
CREATE POLICY operational_day_tenant ON app.operational_day FOR ALL TO app_runtime
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY idempotency_record_tenant ON app.idempotency_record FOR ALL TO app_runtime
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY shift_entry_tenant ON app.shift_entry FOR ALL TO app_runtime
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY audit_event_tenant ON app.audit_event FOR ALL TO app_runtime
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

CREATE POLICY outbox_message_tenant ON app.outbox_message FOR ALL TO app_runtime
    USING (tenant_id = app.current_tenant_id())
    WITH CHECK (tenant_id = app.current_tenant_id());

RESET ROLE;
