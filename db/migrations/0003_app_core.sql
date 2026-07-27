-- 0003_app_core.sql
--
-- Tenancy, the boundary policy (§4), the operational day and the idempotency
-- record (§1), plus the domain effect and its audit/outbox trail (§6).

SET ROLE migrator;

-- ---------------------------------------------------------------------------
-- Session context helpers used by every RLS policy.
-- Unset context yields NULL, every policy predicate yields NULL, no rows are
-- visible. Fail closed.
-- ---------------------------------------------------------------------------

CREATE FUNCTION app.current_tenant_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.current_tenant_id', true), '')::uuid $$;

CREATE FUNCTION app.current_user_id() RETURNS uuid
LANGUAGE sql STABLE
SET search_path = pg_catalog
AS $$ SELECT nullif(current_setting('app.current_user_id', true), '')::uuid $$;

-- ---------------------------------------------------------------------------
-- Tenancy
-- ---------------------------------------------------------------------------

CREATE TABLE app.tenant (
    tenant_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    code       text NOT NULL UNIQUE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.branch (
    branch_id  uuid NOT NULL DEFAULT gen_random_uuid(),
    tenant_id  uuid NOT NULL REFERENCES app.tenant,
    code       text NOT NULL,
    tz         text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (branch_id),
    -- composite target so children can carry tenant_id and stay provably
    -- inside one tenant without a second lookup
    UNIQUE (tenant_id, branch_id),
    UNIQUE (tenant_id, code)
);

CREATE TABLE app.app_user (
    user_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid NOT NULL REFERENCES app.tenant,
    display_name text NOT NULL,
    email        text NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, email)
);

-- The explicit membership/permission path referenced by §7. Reading another
-- user's row requires an admin membership in that user's tenant; there is no
-- ambient "read all users in my tenant" privilege.
CREATE TABLE app.membership (
    user_id   uuid NOT NULL REFERENCES app.app_user,
    tenant_id uuid NOT NULL REFERENCES app.tenant,
    role      text NOT NULL CHECK (role IN ('member', 'admin')),
    PRIMARY KEY (user_id, tenant_id)
);

-- ---------------------------------------------------------------------------
-- §4  Boundary policy
--
-- D-05 (see DECISIONS.md): operating hours 07:00 -> 04:00, accounting day
-- boundary 06:00. day_boundary_time is the accounting boundary; operating_open
-- / operating_close describe the trading window inside that accounting day.
--
-- effective_until IS NULL means "unbounded upper bound" - the policy is open
-- ended. daterange(effective_from, NULL, '[)') is [effective_from,) which is
-- exactly that, and && treats it correctly against every other range.
-- ---------------------------------------------------------------------------

CREATE TABLE app.boundary_policy (
    boundary_policy_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id          uuid NOT NULL,
    branch_id          uuid NOT NULL,
    effective_from     date NOT NULL,
    effective_until    date,
    day_boundary_time  time NOT NULL,
    operating_open     time NOT NULL,
    operating_close    time NOT NULL,
    created_at         timestamptz NOT NULL DEFAULT now(),

    FOREIGN KEY (tenant_id, branch_id)
        REFERENCES app.branch (tenant_id, branch_id),

    CONSTRAINT boundary_policy_period_valid CHECK (
        effective_until IS NULL
        OR effective_until > effective_from
    ),

    -- The operating window must fall inside a single accounting day: measured
    -- as offsets from the boundary, open must come strictly before close.
    -- D-05: boundary 06:00, open 07:00 -> +1h, close 04:00 -> +22h. Valid.
    CONSTRAINT boundary_policy_window_inside_accounting_day CHECK (
        MOD((EXTRACT(EPOCH FROM operating_open  - day_boundary_time))::bigint + 86400, 86400)
        < MOD((EXTRACT(EPOCH FROM operating_close - day_boundary_time))::bigint + 86400, 86400)
    ),

    CONSTRAINT boundary_policy_no_overlap EXCLUDE USING gist (
        tenant_id WITH =,
        branch_id WITH =,
        daterange(effective_from, effective_until, '[)') WITH &&
    )
);

-- ---------------------------------------------------------------------------
-- §1  operational_day
--
-- Written with INSERT ... ON CONFLICT DO NOTHING RETURNING, then read back by
-- a separate later SELECT statement when no row came back. See app/rowclaim.py.
-- The policy fields are copied in so a day is immutably stamped with the rules
-- it was opened under, even if the policy is later superseded.
-- ---------------------------------------------------------------------------

CREATE TABLE app.operational_day (
    tenant_id          uuid NOT NULL,
    branch_id          uuid NOT NULL,
    business_date      date NOT NULL,
    boundary_policy_id uuid NOT NULL REFERENCES app.boundary_policy,
    day_boundary_time  time NOT NULL,
    operating_open     time NOT NULL,
    operating_close    time NOT NULL,
    tz                 text NOT NULL,
    opened_at          timestamptz NOT NULL DEFAULT now(),
    opened_by_request_id uuid NOT NULL,
    closed_at          timestamptz,

    PRIMARY KEY (tenant_id, branch_id, business_date),
    FOREIGN KEY (tenant_id, branch_id)
        REFERENCES app.branch (tenant_id, branch_id)
);

-- ---------------------------------------------------------------------------
-- §1/§3  idempotency_record
--
-- There is no status column, by design (§8): a record only ever exists in the
-- COMPLETED sense. It is inserted in the same transaction as the effect it
-- describes, so it becomes visible exactly when that effect does. An
-- IN_PROGRESS row can never be observed by another transaction, and no
-- recovery path may assume one exists.
--
-- fingerprint_fields stores the normalised *logical* fields (§3) - not the raw
-- body, not the client's JSON key order. request_fingerprint is the sha256 of
-- their canonical serialisation and is what replay comparison uses.
-- ---------------------------------------------------------------------------

CREATE TABLE app.idempotency_record (
    tenant_id           uuid NOT NULL REFERENCES app.tenant,
    endpoint            text NOT NULL,
    idempotency_key     text NOT NULL,
    request_fingerprint text NOT NULL,
    fingerprint_fields  jsonb NOT NULL,
    response_status     smallint NOT NULL,
    response_body       jsonb NOT NULL,
    business_date       date NOT NULL,
    created_at          timestamptz NOT NULL DEFAULT now(),
    created_by_request_id uuid NOT NULL,

    PRIMARY KEY (tenant_id, endpoint, idempotency_key)
);

-- ---------------------------------------------------------------------------
-- Domain effect + trail
-- ---------------------------------------------------------------------------

CREATE TABLE app.shift_entry (
    shift_entry_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL,
    branch_id      uuid NOT NULL,
    business_date  date NOT NULL,
    staff_ref      text NOT NULL,
    minutes        integer NOT NULL CHECK (minutes > 0),
    note           text,
    recorded_at    timestamptz NOT NULL DEFAULT now(),
    created_by_request_id uuid NOT NULL,

    -- an entry cannot exist without the operational day it belongs to
    FOREIGN KEY (tenant_id, branch_id, business_date)
        REFERENCES app.operational_day (tenant_id, branch_id, business_date)
);

CREATE INDEX shift_entry_day_idx
    ON app.shift_entry (tenant_id, branch_id, business_date);

CREATE TABLE app.audit_event (
    audit_event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id      uuid NOT NULL REFERENCES app.tenant,
    request_id     uuid NOT NULL,
    event_type     text NOT NULL,
    subject_id     uuid,
    business_date  date,
    payload        jsonb NOT NULL,
    occurred_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE app.outbox_message (
    outbox_message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id         uuid NOT NULL REFERENCES app.tenant,
    request_id        uuid NOT NULL,
    topic             text NOT NULL,
    payload           jsonb NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    published_at      timestamptz
);

RESET ROLE;
