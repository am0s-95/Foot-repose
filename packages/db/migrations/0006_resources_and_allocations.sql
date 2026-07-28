-- Scheduling inputs 2/3 (Slice 2A.2b): physical resources + booking allocation
-- integrity. Booking policies (lead time, horizon, cancellation windows) belong
-- to 2A.2c and are deliberately absent here, as are any endpoint, any UI, any
-- availability engine and any automatic provider/resource selection.
--
-- What PostgreSQL itself enforces here:
--   * one provider and one physical resource unit can never be claimed twice
--     over overlapping time — GiST EXCLUDE constraints, not check-then-insert;
--   * a claim's occupancy is DERIVED, never supplied: `occupancy` is a
--     GENERATED column over mirrored booking columns that a composite foreign
--     key pins to the booking itself. Direct SQL cannot state a different
--     window (428C9 on the generated column, 23503 on the mirrors), and moving
--     the booking in time either moves every claim atomically (ON UPDATE
--     CASCADE) or fails with 23P01;
--   * a resource always belongs to the booking's branch — two composite FKs
--     share one branch_id column, so a cross-branch claim cannot be inserted;
--   * a resource's classification at claim time can never be rewritten: the
--     claim carries resource_type_id and a three-column FK with ON UPDATE NO
--     ACTION, so reclassifying a resource that has history is refused. The
--     supported operation is retirement plus a new unit;
--   * a claim's occupancy spans at most 24 hours, so it touches at most two
--     CONSECUTIVE Muscat dates. That is what makes "assignment covers the first
--     and the last date" a complete coverage proof rather than a sample.
--
-- What triggers enforce (a constraint provably cannot — a constraint cannot
-- stop a child row from being DELETEd, and TRUNCATE does not fire DELETE
-- triggers at all):
--   * requirement snapshots are sealed: after sealing, no INSERT, UPDATE or
--     DELETE of children, and a child's whole primary key is frozen so a row
--     can never be relocated out of a sealed parent into an unsealed one;
--   * allocations are released, never deleted, and released_occupancy is
--     WRITTEN BY the guard from the row's own columns — a caller-supplied
--     range is ignored, not trusted;
--   * the four allocation/requirement tables refuse TRUNCATE unless the
--     session explicitly opts in.
--
-- Stated exactly, and repeated in the README: the trigger guards are a guard
-- against accidental destruction, NOT a security boundary. The role that owns
-- these tables can ALTER TABLE ... DISABLE TRIGGER or drop them. Real
-- enforcement needs an application role separate from the migration role,
-- which this codebase does not have today (one DATABASE_URL, one role).

-- ---------------------------------------------------------------- occupancy
-- `timestamptz + interval` is STABLE (its month/day parts are evaluated in the
-- session time zone), so it cannot appear in a generated column. make_interval
-- with only a minutes component produces a TIME-ONLY interval, and adding that
-- to a timestamptz is a pure absolute offset — genuinely immutable. Proven in
-- both directions by the tests: identical epoch under UTC, Asia/Muscat and a
-- DST-observing zone, and exactly 86400 seconds added across a DST boundary.
-- The domain applies the same rule in `occupancyOf`; a test asserts the two
-- agree.
create function fr_shift_minutes(t timestamptz, mins integer) returns timestamptz
  language sql immutable parallel safe strict as
$$ select t + make_interval(mins => mins) $$;

-- Bounded domain for the function above. NOT VALID on purpose: the preflight
-- below has to be able to REPORT bad data (count + sample ids) instead of the
-- migration dying on a raw "is violated by some row" with nothing actionable.
-- VALIDATE runs after the preflight has proven the table clean.
alter table bookings
  add constraint bookings_buffer_before_bounds
    check (buffer_before_min_snapshot between 0 and 1440) not valid,
  add constraint bookings_buffer_after_bounds
    check (buffer_after_min_snapshot between 0 and 1440) not valid;

-- FK targets. Both are over plain (non-generated) columns, which is what makes
-- ON UPDATE CASCADE fire reliably when a booking is rescheduled.
alter table bookings
  add constraint bookings_branch_service_key unique (id, branch_id, service_id),
  add constraint bookings_allocation_key unique
    (id, branch_id, starts_at, ends_at,
     buffer_before_min_snapshot, buffer_after_min_snapshot);

-- ---------------------------------------------------------------- catalog
alter table branch_service_offerings
  -- NULL = requirements were never configured for this offering. That is NOT
  -- the same as "this offering needs no resources", which is a sealed capture
  -- with zero rows. Every offering that exists today becomes NULL, which is
  -- the honest description of its state.
  add column resource_requirements_captured_at timestamptz,
  add constraint branch_service_offerings_branch_service_key
    unique (id, branch_id, service_id);

create table resource_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code = lower(code)),
  name text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- One row per PHYSICAL unit. Individually allocatable even when two units are
-- interchangeable: only a per-unit row lets PostgreSQL police double booking
-- with an exclusion constraint. A capacity counter would need
-- SELECT-count-then-INSERT under a lock, which is exactly what this slice
-- refuses to do.
create table branch_resources (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id),
  resource_type_id uuid not null references resource_types (id),
  -- `code` is the operational identifier, `label` is display text. Neither is
  -- the identity: `id` is. Uniqueness is scoped to ACTIVE units so a retired
  -- unit's code and label can both be reused by its replacement.
  code text not null,
  label text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint branch_resources_id_branch unique (id, branch_id),
  constraint branch_resources_id_branch_type unique (id, branch_id, resource_type_id)
);

create unique index branch_resources_active_code_idx
  on branch_resources (branch_id, code) where is_active;
create index branch_resources_branch_type_idx
  on branch_resources (branch_id, resource_type_id);

-- What an offering needs. Attached to the dated per-branch offering (like
-- price/duration/buffers in 0004), never to the global `services` row.
create table branch_service_offering_resources (
  offering_id uuid not null references branch_service_offerings (id),
  resource_type_id uuid not null references resource_types (id),
  required_qty smallint not null default 1 check (required_qty >= 1),
  created_at timestamptz not null default now(),
  primary key (offering_id, resource_type_id)
);

-- ------------------------------------------------- booking requirement snapshot
-- The booking's OWN copy. Allocation reads this and never the live catalog:
-- splitting a future offering version must not retroactively change what an
-- existing booking requires.
create table booking_resource_requirement_sets (
  booking_id uuid primary key references bookings (id),
  -- Mirrors, pinned by the two composite FKs below: they prove the source
  -- offering is for the booking's OWN branch and OWN service.
  branch_id uuid not null,
  service_id uuid not null,
  source_offering_id uuid not null,
  captured_at timestamptz not null default statement_timestamp(),
  -- NULL = under construction. Allocation accepts sealed sets only.
  sealed_at timestamptz,
  constraint booking_requirement_sets_booking_fk
    foreign key (booking_id, branch_id, service_id)
    references bookings (id, branch_id, service_id),
  constraint booking_requirement_sets_offering_fk
    foreign key (source_offering_id, branch_id, service_id)
    references branch_service_offerings (id, branch_id, service_id)
);

create table booking_resource_requirements (
  booking_id uuid not null references booking_resource_requirement_sets (booking_id),
  resource_type_id uuid not null references resource_types (id),
  required_qty smallint not null check (required_qty >= 1),
  primary key (booking_id, resource_type_id)
);

-- ---------------------------------------------------------------- allocations
create table booking_provider_allocations (
  id uuid primary key default gen_random_uuid(),
  -- Deterministic LOGICAL ordering of the writes made to one booking, which
  -- are serialised by that booking's row lock. NOT wall-clock chronology and
  -- not an ordering across bookings: values are consumed before commit and the
  -- sequence may contain gaps. now() cannot do this job at all — it is
  -- transaction-stable, so two allocations written in one transaction share it.
  allocation_seq bigint generated always as identity,
  booking_id uuid not null,
  branch_id uuid not null,
  employee_id uuid not null references employees (id),
  b_starts_at timestamptz not null,
  b_ends_at timestamptz not null,
  b_buf_before integer not null,
  b_buf_after integer not null,
  occupancy tstzrange generated always as (
    tstzrange(fr_shift_minutes(b_starts_at, -b_buf_before),
              fr_shift_minutes(b_ends_at, b_buf_after), '[)')
  ) stored,
  allocated_at timestamptz not null default statement_timestamp(),
  released_at timestamptz,
  released_occupancy tstzrange,
  release_reason text,
  constraint provider_allocation_seq_key unique (allocation_seq),
  constraint provider_allocation_release_shape check (
    (released_at is null) = (release_reason is null)
    and (released_at is null) = (released_occupancy is null)
  ),
  -- At most two consecutive Muscat dates. See the header.
  constraint provider_allocation_max_24h check (
    upper(occupancy) - lower(occupancy) <= interval '24 hours'
  ),
  constraint provider_allocation_booking_fk
    foreign key (booking_id, branch_id, b_starts_at, b_ends_at, b_buf_before, b_buf_after)
    references bookings (id, branch_id, starts_at, ends_at,
                         buffer_before_min_snapshot, buffer_after_min_snapshot)
    on update cascade on delete no action,
  constraint provider_no_double_booking
    exclude using gist (employee_id with =, occupancy with &&)
    where (released_at is null)
);

-- One live provider per booking. Lifting this later is NOT just dropping an
-- index: contracts, the booking DTO and the branch UI all model a single
-- optional provider today.
create unique index provider_allocation_one_live_idx
  on booking_provider_allocations (booking_id) where released_at is null;
create index provider_allocation_latest_idx
  on booking_provider_allocations (booking_id, allocation_seq desc);
create index provider_allocation_branch_occupancy_idx
  on booking_provider_allocations using gist (branch_id, occupancy);

create table booking_resource_allocations (
  id uuid primary key default gen_random_uuid(),
  allocation_seq bigint generated always as identity,
  booking_id uuid not null,
  branch_id uuid not null,
  resource_id uuid not null,
  -- Carried so a later reclassification of the unit cannot rewrite what this
  -- claim meant. The three-column FK below makes that structural.
  resource_type_id uuid not null,
  b_starts_at timestamptz not null,
  b_ends_at timestamptz not null,
  b_buf_before integer not null,
  b_buf_after integer not null,
  occupancy tstzrange generated always as (
    tstzrange(fr_shift_minutes(b_starts_at, -b_buf_before),
              fr_shift_minutes(b_ends_at, b_buf_after), '[)')
  ) stored,
  allocated_at timestamptz not null default statement_timestamp(),
  released_at timestamptz,
  released_occupancy tstzrange,
  release_reason text,
  constraint resource_allocation_seq_key unique (allocation_seq),
  constraint resource_allocation_release_shape check (
    (released_at is null) = (release_reason is null)
    and (released_at is null) = (released_occupancy is null)
  ),
  constraint resource_allocation_max_24h check (
    upper(occupancy) - lower(occupancy) <= interval '24 hours'
  ),
  constraint resource_allocation_booking_fk
    foreign key (booking_id, branch_id, b_starts_at, b_ends_at, b_buf_before, b_buf_after)
    references bookings (id, branch_id, starts_at, ends_at,
                         buffer_before_min_snapshot, buffer_after_min_snapshot)
    on update cascade on delete no action,
  -- branch_id is shared with the booking FK above, so a unit from another
  -- branch simply is not present in branch_resources under this branch_id.
  constraint resource_allocation_resource_fk
    foreign key (resource_id, branch_id, resource_type_id)
    references branch_resources (id, branch_id, resource_type_id)
    on update no action on delete no action,
  constraint resource_no_double_booking
    exclude using gist (resource_id with =, occupancy with &&)
    where (released_at is null)
);

create unique index resource_allocation_one_live_idx
  on booking_resource_allocations (booking_id, resource_id) where released_at is null;
create index resource_allocation_latest_idx
  on booking_resource_allocations (booking_id, allocation_seq desc);
create index resource_allocation_branch_occupancy_idx
  on booking_resource_allocations using gist (branch_id, occupancy);

-- ---------------------------------------------------------------- guards
-- Sealing lifecycle for the booking's requirement snapshot.
--
-- The lock is taken INSIDE the guard, so every path — repository, psql, a
-- future admin tool — serialises on the parent row. Without it there is a real
-- race: a transaction reads sealed_at IS NULL from its snapshot, another seals
-- and commits, and the first still inserts a child. The FK's own KEY SHARE
-- lock does not help, because sealing is a NO KEY UPDATE and the two do not
-- conflict.
--
-- The whole primary key is frozen. Checking only NEW.booking_id would let
-- `UPDATE ... SET booking_id = <unsealed>` walk a child out of a sealed set;
-- both parents are therefore locked, in deterministic id order.
create function fr_booking_requirements_guard() returns trigger
  language plpgsql as $fn$
declare sealed timestamptz;
begin
  if tg_op = 'UPDATE'
     and (new.booking_id <> old.booking_id
          or new.resource_type_id <> old.resource_type_id) then
    raise exception
      'a requirement row cannot be relocated; correct it while unsealed with DELETE + INSERT';
  end if;
  for sealed in
    select s.sealed_at from booking_resource_requirement_sets s
     where s.booking_id in (coalesce(new.booking_id, old.booking_id),
                            coalesce(old.booking_id, new.booking_id))
     order by s.booking_id
     for update
  loop
    if sealed is not null then
      raise exception 'requirement set is sealed: requirements are immutable history';
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $fn$;

create trigger fr_booking_requirements_guard
  before insert or update or delete on booking_resource_requirements
  for each row execute function fr_booking_requirements_guard();

create function fr_booking_requirement_sets_guard() returns trigger
  language plpgsql as $fn$
begin
  if tg_op = 'INSERT' then
    if new.sealed_at is not null then
      raise exception 'a requirement set cannot be created already sealed';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    raise exception 'requirement sets are history and cannot be deleted';
  end if;
  if old.sealed_at is not null then
    raise exception 'a sealed requirement set is immutable';
  end if;
  if new.booking_id <> old.booking_id
     or new.branch_id <> old.branch_id
     or new.service_id <> old.service_id
     or new.source_offering_id <> old.source_offering_id then
    raise exception 'requirement set provenance is immutable';
  end if;
  return new;
end $fn$;

create trigger fr_booking_requirement_sets_guard
  before insert or update or delete on booking_resource_requirement_sets
  for each row execute function fr_booking_requirement_sets_guard();

-- The same lifecycle on the catalog side: once an offering's requirements are
-- captured they are frozen, and a row can never be relocated between offerings.
create function fr_offering_resources_guard() returns trigger
  language plpgsql as $fn$
declare captured timestamptz;
begin
  if tg_op = 'UPDATE'
     and (new.offering_id <> old.offering_id
          or new.resource_type_id <> old.resource_type_id) then
    raise exception
      'an offering requirement row cannot be relocated; correct it before capture with DELETE + INSERT';
  end if;
  for captured in
    select o.resource_requirements_captured_at from branch_service_offerings o
     where o.id in (coalesce(new.offering_id, old.offering_id),
                    coalesce(old.offering_id, new.offering_id))
     order by o.id
     for update
  loop
    if captured is not null then
      raise exception 'offering requirements are captured and immutable';
    end if;
  end loop;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $fn$;

create trigger fr_offering_resources_guard
  before insert or update or delete on branch_service_offering_resources
  for each row execute function fr_offering_resources_guard();

create function fr_offering_capture_guard() returns trigger
  language plpgsql as $fn$
begin
  if old.resource_requirements_captured_at is not null
     and new.resource_requirements_captured_at is distinct from
         old.resource_requirements_captured_at then
    raise exception 'offering requirement capture cannot be undone';
  end if;
  return new;
end $fn$;

create trigger fr_offering_capture_guard
  before update on branch_service_offerings
  for each row execute function fr_offering_capture_guard();

-- Allocation history guard, scoped precisely.
--
-- It must NOT block the ON UPDATE CASCADE that a reschedule performs on the
-- mirrored booking columns — that cascade is how claims stay honest — so only
-- identity and the release fields are frozen.
--
-- released_occupancy is WRITTEN HERE, never trusted from the caller. The two
-- paths differ and both matter:
--   * live -> released is an UPDATE, so OLD.occupancy exists and is used;
--   * a row inserted already released (backfill) has NO usable NEW.occupancy —
--     generated columns are computed AFTER before-triggers run — so the value
--     is derived from the row's own b_* columns with the same expression the
--     generated column uses.
create function fr_allocation_history_guard() returns trigger
  language plpgsql as $fn$
begin
  if tg_op = 'DELETE' then
    raise exception 'allocations are history: release them, never DELETE';
  end if;

  if tg_op = 'INSERT' then
    if new.released_at is not null then
      if new.release_reason is null then
        raise exception 'a released allocation must carry a release_reason';
      end if;
      new.released_occupancy := tstzrange(
        fr_shift_minutes(new.b_starts_at, -new.b_buf_before),
        fr_shift_minutes(new.b_ends_at, new.b_buf_after), '[)');
    end if;
    return new;
  end if;

  if new.booking_id <> old.booking_id or new.allocation_seq <> old.allocation_seq then
    raise exception 'allocation identity is immutable';
  end if;

  if old.released_at is not null then
    if new.released_at is distinct from old.released_at
       or new.released_occupancy is distinct from old.released_occupancy
       or new.release_reason is distinct from old.release_reason then
      raise exception 'release fields are immutable once released';
    end if;
    return new;
  end if;

  if new.released_at is not null then
    if new.release_reason is null then
      raise exception 'a released allocation must carry a release_reason';
    end if;
    new.released_occupancy := old.occupancy;
  end if;
  return new;
end $fn$;

create function fr_provider_allocation_guard() returns trigger
  language plpgsql as $fn$
begin
  if tg_op <> 'DELETE' and tg_op <> 'INSERT'
     and new.employee_id <> old.employee_id then
    raise exception 'allocation identity is immutable';
  end if;
  return new;
end $fn$;

create function fr_resource_allocation_guard() returns trigger
  language plpgsql as $fn$
begin
  if tg_op <> 'DELETE' and tg_op <> 'INSERT'
     and (new.resource_id <> old.resource_id
          or new.resource_type_id <> old.resource_type_id) then
    raise exception 'allocation identity is immutable';
  end if;
  return new;
end $fn$;

create trigger fr_provider_allocation_identity_guard
  before update on booking_provider_allocations
  for each row execute function fr_provider_allocation_guard();
create trigger fr_provider_allocation_history_guard
  before insert or update or delete on booking_provider_allocations
  for each row execute function fr_allocation_history_guard();

create trigger fr_resource_allocation_identity_guard
  before update on booking_resource_allocations
  for each row execute function fr_resource_allocation_guard();
create trigger fr_resource_allocation_history_guard
  before insert or update or delete on booking_resource_allocations
  for each row execute function fr_allocation_history_guard();

-- TRUNCATE does not fire DELETE triggers, so the guard above is blind to it —
-- and the development seed truncates through the same DATABASE_URL. A
-- statement-level BEFORE TRUNCATE trigger closes that, including for tables
-- pulled in by CASCADE, and it runs before ANY table is emptied.
--
-- Protection covers EXACTLY these four tables. audit_logs, bookings, the
-- catalog tables and every migration-0005 scheduling table are deliberately
-- NOT protected and keep their current behaviour.
create function fr_history_truncate_guard() returns trigger
  language plpgsql as $fn$
begin
  if coalesce(current_setting('foot_repose.allow_history_wipe', true), 'off') <> 'on' then
    raise exception
      'TRUNCATE refused on %: allocation and requirement history is protected. '
      'Set foot_repose.allow_history_wipe to opt in (development seed only).',
      tg_table_name;
  end if;
  return null;
end $fn$;

create trigger fr_truncate_guard before truncate on booking_provider_allocations
  for each statement execute function fr_history_truncate_guard();
create trigger fr_truncate_guard before truncate on booking_resource_allocations
  for each statement execute function fr_history_truncate_guard();
create trigger fr_truncate_guard before truncate on booking_resource_requirement_sets
  for each statement execute function fr_history_truncate_guard();
create trigger fr_truncate_guard before truncate on booking_resource_requirements
  for each statement execute function fr_history_truncate_guard();

-- ---------------------------------------------------------------- preflight
-- Runs BEFORE any row is written and before the buffer bounds are validated,
-- so a database that cannot be migrated says so with a count and sample ids
-- rather than a bare constraint violation. The migration runner wraps this
-- file in one transaction, so raising here leaves no table, no trigger and no
-- schema_migrations row behind.
do $preflight$
declare
  bad_buffers integer;
  bad_buffer_ids text;
  long_occupancy integer;
  long_ids text;
  overlap_count integer;
  overlap_pairs text;
begin
  -- The count is over EVERY violating row; only the SAMPLE is capped. Counting
  -- after a LIMIT would report "20" for a database with hundreds of problems
  -- and understate the work an operator has to do.
  select count(*) into bad_buffers
  from bookings
   where buffer_before_min_snapshot not between 0 and 1440
      or buffer_after_min_snapshot not between 0 and 1440;
  select string_agg(id::text, ', ' order by id) into bad_buffer_ids
  from (select id from bookings
         where buffer_before_min_snapshot not between 0 and 1440
            or buffer_after_min_snapshot not between 0 and 1440
         order by id limit 20) s;
  if bad_buffers > 0 then
    raise exception
      'migration 0006 preflight: % booking(s) carry buffer snapshots outside [0, 1440]; sample: %',
      bad_buffers, bad_buffer_ids;
  end if;

  select count(*) into long_occupancy
  from bookings
   where (ends_at + make_interval(mins => buffer_after_min_snapshot))
       - (starts_at - make_interval(mins => buffer_before_min_snapshot))
         > interval '24 hours';
  select string_agg(id::text, ', ' order by id) into long_ids
  from (select id from bookings
         where (ends_at + make_interval(mins => buffer_after_min_snapshot))
             - (starts_at - make_interval(mins => buffer_before_min_snapshot))
               > interval '24 hours'
         order by id limit 20) s;
  if long_occupancy > 0 then
    raise exception
      'migration 0006 preflight: % booking(s) have a derived occupancy longer than 24 hours; sample: %',
      long_occupancy, long_ids;
  end if;

  create temporary table fr_0006_claim on commit drop as
  select id, assigned_employee_id as employee_id,
         tstzrange(starts_at - make_interval(mins => buffer_before_min_snapshot),
                   ends_at + make_interval(mins => buffer_after_min_snapshot),
                   '[)') as occupancy
    from bookings
   where assigned_employee_id is not null
     and status in ('confirmed', 'checked_in', 'in_service', 'completed');

  select count(*) into overlap_count
  from fr_0006_claim a join fr_0006_claim b
    on a.employee_id = b.employee_id and a.id < b.id and a.occupancy && b.occupancy;

  select string_agg(pair, '; ' order by pair) into overlap_pairs
  from (select a.id::text || ' / ' || b.id::text as pair
        from fr_0006_claim a join fr_0006_claim b
          on a.employee_id = b.employee_id and a.id < b.id and a.occupancy && b.occupancy
        order by 1 limit 20) s;

  if overlap_count > 0 then
    raise exception
      'migration 0006 preflight: % pre-existing provider double-booking(s) found; '
      'these must be resolved by hand — 0006 will not release, drop or rewrite either side. Pairs: %',
      overlap_count, overlap_pairs;
  end if;
end $preflight$;

alter table bookings validate constraint bookings_buffer_before_bounds;
alter table bookings validate constraint bookings_buffer_after_bounds;

-- ---------------------------------------------------------------- backfill
-- assigned_employee_id is a stored fact, so moving it is a transfer, not a
-- guess. What is NOT inferred: no provider is invented where the column is
-- NULL, and NO physical resource and NO requirement set is created for any
-- pre-0006 booking — there is no inventory to draw on and inventing one is
-- forbidden. Eligibility (branch assignment, qualification) is NOT applied
-- retroactively: 0006 does not invalidate history, it only refuses to build a
-- structure that contradicts itself.
--
-- Bookings whose status does not hold a claim are carried over as ALREADY
-- RELEASED rows rather than dropped, so "who was assigned" survives the column
-- being dropped. released_occupancy is filled by the guard, not by this
-- statement.
insert into booking_provider_allocations
  (booking_id, branch_id, employee_id, b_starts_at, b_ends_at, b_buf_before, b_buf_after,
   released_at, release_reason)
select b.id, b.branch_id, b.assigned_employee_id, b.starts_at, b.ends_at,
       b.buffer_before_min_snapshot, b.buffer_after_min_snapshot,
       case when b.status in ('cancelled', 'no_show') then statement_timestamp() end,
       case when b.status in ('cancelled', 'no_show') then 'backfill_non_holding_status' end
from bookings b
where b.assigned_employee_id is not null
order by b.starts_at, b.id;

-- One source of truth from here on. Keeping the column would create exactly
-- the divergence this slice exists to prevent.
alter table bookings drop column assigned_employee_id;
