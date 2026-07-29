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
--   * a live claim stays ELIGIBLE and stays ATTACHED TO A BOOKING THAT STILL
--     HOLDS CAPACITY. Four surfaces, because eligibility can be broken from
--     four sides and closing three of them proves nothing:
--       - claim creation, reassignment and movement (allocate / reassign /
--         swap / the ON UPDATE CASCADE of a reschedule);
--       - mutation of the eligibility evidence itself (assignment and
--         qualification rows);
--       - mutation of the parent booking's own determinants (service_id, and
--         the status that decides whether a claim may stay live at all);
--       - the legacy 0005 -> 0006 preflight, which refuses to manufacture a
--         live claim that would be ineligible the moment it exists;
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

-- Eligibility is not only a precondition of allocating; it has to STAY true for
-- as long as the claim is live.
--
-- Locking the evidence rows during allocation stops a mutation from slipping
-- between the check and the write, but it does not stop the very same mutation
-- from committing a moment later and leaving a live claim by a provider who is
-- no longer assigned or no longer qualified. Closing that needs the mutation
-- itself to be re-examined against the state it produces.
--
-- Statement level with a transition table, deliberately: a multi-row UPDATE or
-- DELETE must be judged on the COMPLETE post-statement state, not row by row —
-- otherwise removing two overlapping assignments would pass twice, each row
-- excused by the other. Both the OLD and the NEW keys are considered, so moving
-- a row to a different employee is caught on both sides.
create function fr_assert_live_allocations_eligible(employee_ids uuid[]) returns void
  language plpgsql as $fn$
declare offender record;
begin
  if employee_ids is null or cardinality(employee_ids) = 0 then return; end if;
  select a.booking_id, a.employee_id, dates.d into offender
  from booking_provider_allocations a
  join bookings b on b.id = a.booking_id
  cross join lateral (
    select (lower(a.occupancy) at time zone 'Asia/Muscat')::date as d
    union
    select ((upper(a.occupancy) - interval '1 microsecond') at time zone 'Asia/Muscat')::date
  ) dates
  where a.released_at is null
    and a.employee_id = any(employee_ids)
    and (
      not exists (select 1 from provider_branch_assignments pa
                   where pa.employee_id = a.employee_id and pa.branch_id = a.branch_id
                     and pa.valid_dates @> dates.d)
      or
      not exists (select 1 from provider_service_qualifications q
                   where q.employee_id = a.employee_id and q.service_id = b.service_id
                     and q.valid_dates @> dates.d)
    )
  limit 1;
  if found then
    raise exception
      'this change would leave booking % with a live allocation by a provider who is not '
      'assigned/qualified on %; release the allocation first',
      offender.booking_id, offender.d;
  end if;
end $fn$;

-- Transition tables cannot serve more than one event, so UPDATE and DELETE get
-- one trigger each; both feed the same checker.
create function fr_eligibility_update_guard() returns trigger
  language plpgsql as $fn$
begin
  perform fr_assert_live_allocations_eligible(
    array(select employee_id from fr_old_rows
          union
          select employee_id from fr_new_rows));
  return null;
end $fn$;

create function fr_eligibility_delete_guard() returns trigger
  language plpgsql as $fn$
begin
  perform fr_assert_live_allocations_eligible(array(select employee_id from fr_old_rows));
  return null;
end $fn$;

create trigger fr_assignment_coverage_update_guard
  after update on provider_branch_assignments
  referencing old table as fr_old_rows new table as fr_new_rows
  for each statement execute function fr_eligibility_update_guard();
create trigger fr_assignment_coverage_delete_guard
  after delete on provider_branch_assignments
  referencing old table as fr_old_rows
  for each statement execute function fr_eligibility_delete_guard();

create trigger fr_qualification_coverage_update_guard
  after update on provider_service_qualifications
  referencing old table as fr_old_rows new table as fr_new_rows
  for each statement execute function fr_eligibility_update_guard();
create trigger fr_qualification_coverage_delete_guard
  after delete on provider_service_qualifications
  referencing old table as fr_old_rows
  for each statement execute function fr_eligibility_delete_guard();

-- The other direction of the same invariant: the CLAIM can move too.
--
-- Rescheduling a booking rewrites `starts_at`/`ends_at`, and the composite FK
-- cascades that into every live claim's mirrors, which regenerates `occupancy`.
-- Guarding only the eligibility tables would therefore leave an obvious hole: a
-- booking moved to a date outside the provider's assignment or qualification
-- commits happily (no time conflict) and leaves a live claim nobody is eligible
-- for. Rescheduling is a daily operation, so this is not a theoretical gap.
--
-- Row level, because each claim is judged on its own window, and AFTER so that
-- the generated `occupancy` is the FINAL one — the guard reads the NEW window,
-- never the old. Raising here aborts the whole statement, so the booking UPDATE
-- and every provider/resource cascade roll back together.
--
-- The covering rows are locked FOR SHARE, exactly as `allocateBooking` locks
-- them, so a concurrent eligibility change cannot slip past in either order.
create function fr_allocation_eligibility_guard() returns trigger
  language plpgsql as $fn$
declare
  service uuid;
  needed integer;
  assigned integer;
  qualified integer;
begin
  -- A released claim is history: it neither holds capacity nor needs current
  -- eligibility.
  if new.released_at is not null then return null; end if;

  -- Nothing that matters changed (a pure release-metadata or bookkeeping
  -- UPDATE): the window, the branch and the provider are all identical.
  if tg_op = 'UPDATE'
     and old.released_at is null
     and new.occupancy = old.occupancy
     and new.branch_id = old.branch_id
     and new.employee_id = old.employee_id then
    return null;
  end if;

  -- FIRST link of the documented lock order: the booking row, then the
  -- eligibility evidence rows below. FOR KEY SHARE is exactly the lock the
  -- composite foreign key already takes for this INSERT, so it adds no new lock
  -- class; taking it HERE, before the service is read, is what makes the read
  -- of `service_id` a locked read rather than a hopeful one. A concurrent
  -- service change holds FOR UPDATE on the same row (see
  -- fr_booking_determinant_guard), and the two conflict, so the guard can never
  -- validate a claim against a service that is already being replaced.
  select b.service_id into service
    from bookings b where b.id = new.booking_id for key share;

  select count(*) into needed from (
    select (lower(new.occupancy) at time zone 'Asia/Muscat')::date as d
    union
    select ((upper(new.occupancy) - interval '1 microsecond') at time zone 'Asia/Muscat')::date
  ) dates;

  select count(distinct s.d) into assigned from (
    select dd.d
    from (select (lower(new.occupancy) at time zone 'Asia/Muscat')::date as d
          union
          select ((upper(new.occupancy) - interval '1 microsecond') at time zone 'Asia/Muscat')::date) dd
    join provider_branch_assignments a
      on a.employee_id = new.employee_id and a.branch_id = new.branch_id
     and a.valid_dates @> dd.d
    for share of a
  ) s;

  select count(distinct s.d) into qualified from (
    select dd.d
    from (select (lower(new.occupancy) at time zone 'Asia/Muscat')::date as d
          union
          select ((upper(new.occupancy) - interval '1 microsecond') at time zone 'Asia/Muscat')::date) dd
    join provider_service_qualifications q
      on q.employee_id = new.employee_id and q.service_id = service
     and q.valid_dates @> dd.d
    for share of q
  ) s;

  if assigned <> needed then
    raise exception
      'provider % is not assigned to branch % for every Muscat date of booking %''s window %',
      new.employee_id, new.branch_id, new.booking_id, new.occupancy;
  end if;
  if qualified <> needed then
    raise exception
      'provider % is not qualified for the service of booking % for every Muscat date of window %',
      new.employee_id, new.booking_id, new.occupancy;
  end if;
  return null;
end $fn$;

create trigger fr_provider_allocation_eligibility_guard
  after insert or update on booking_provider_allocations
  for each row execute function fr_allocation_eligibility_guard();

-- The THIRD direction: the parent row's own determinants.
--
-- Two guards above cover the evidence moving and the claim moving. Neither sees
-- this one: `service_id` is NOT part of the composite foreign key the claims
-- carry, so changing it cascades nothing, fires no allocation trigger, and
-- leaves a live claim by a provider who may not be qualified for the service the
-- booking now names. A legacy 0005 -> 0006 booking makes it concrete — it has a
-- live claim and no requirement snapshot at all, so nothing else refuses.
--
-- The rule for slice 2A.2b: a booking that carries ANY scheduling footprint may
-- not change its service. Releasing the live claims first is deliberately NOT
-- enough. A released claim carries no service of its own — it records that an
-- employee held a window for a booking — so re-pointing the booking would make
-- every historical row read as if that service had been performed. Requirement
-- snapshots are the opposite case: they carry `service_id` explicitly and are
-- pinned by a composite foreign key, so PostgreSQL already refuses (23503)
-- there; the guard reaches the case first and says why in one sentence instead.
--
-- What this deliberately does NOT do is implement service replacement. That
-- operation would have to re-snapshot name/duration/price, re-capture
-- requirements from the new offering and re-allocate, and it is not in this
-- slice. Until it exists, a different service means a different booking.
--
-- Concurrency. `perform ... for update` on the booking row is THE canonical
-- serialisation point of this slice, and it is the same row `allocateBooking`
-- locks first. Two orders, both proven by execution (not asserted):
--   * claim created first — the service UPDATE cannot even reach its own guard
--     body until that transaction ends, then counts the committed claim and
--     refuses;
--   * service changed first — a claim being created blocks on the same row and
--     its eligibility guard then reads the NEW service.
-- Measured on 16.13, the guard body never once ran before the wait, with or
-- without this explicit lock: PostgreSQL takes an exclusive row lock of its own
-- before firing a BEFORE ROW UPDATE trigger. The lock stays because the
-- ordering must be stated by this code rather than inherited from an
-- implementation detail — and because it costs nothing, since it is the very
-- lock the UPDATE is about to take.
--
-- One honest liveness note: a single statement updating the service of SEVERAL
-- bookings locks them in the plan's row order. Order such a statement by id to
-- stay inside the global lock order; getting it wrong risks 40P01, never a
-- double claim.
create function fr_booking_determinant_guard() returns trigger
  language plpgsql as $fn$
declare
  live_provider integer;
  released_provider integer;
  live_resource integer;
  released_resource integer;
  requirement_sets integer;
begin
  -- STATUS. Taking this lock is not decoration, and FOR KEY SHARE on the claim
  -- side is not enough on its own to serialise against it. `status` belongs to
  -- no unique key, so an UPDATE that only changes it is a NO KEY update, and
  -- PostgreSQL defines FOR NO KEY UPDATE and FOR KEY SHARE as COMPATIBLE. The
  -- two therefore never blocked, which was demonstrated rather than reasoned
  -- about: eight runs on 16.13, `pg_blocking_pids` empty in every one, and four
  -- of the eight committed a cancelled booking holding a live claim.
  --
  -- FOR UPDATE conflicts with FOR KEY SHARE, so this makes the booking row a
  -- genuine serialisation point for BOTH orders:
  --   * status first — the claim's own guard blocks here, and once this
  --     transaction commits it reads the NEW non-holding status and refuses;
  --   * claim first — this UPDATE blocks before its guard body runs, and the
  --     deferred final-state check below then sees the committed claim and
  --     refuses.
  -- Only a transition INTO a non-holding status needs it: nothing about moving
  -- between holding statuses can strand capacity.
  if new.status is distinct from old.status
     and new.status in ('cancelled', 'no_show') then
    perform 1 from bookings b where b.id = old.id for update;
  end if;

  -- SERVICE. Semantic distinctness: assigning the same service (or the same
  -- NULL-free value twice) is a no-op and is never refused.
  if new.service_id is not distinct from old.service_id then
    return new;
  end if;

  perform 1 from bookings b where b.id = old.id for update;

  select count(*) filter (where released_at is null),
         count(*) filter (where released_at is not null)
    into live_provider, released_provider
    from booking_provider_allocations where booking_id = old.id;

  select count(*) filter (where released_at is null),
         count(*) filter (where released_at is not null)
    into live_resource, released_resource
    from booking_resource_allocations where booking_id = old.id;

  select count(*) into requirement_sets
    from booking_resource_requirement_sets where booking_id = old.id;

  if live_provider + released_provider + live_resource + released_resource
     + requirement_sets = 0 then
    return new;
  end if;

  raise exception
    'booking % cannot change service: it carries a scheduling footprint '
    '(live provider claims %, live resource claims %, released claims %, '
    'requirement snapshots %). Releasing the live claims is not enough — a '
    'released claim names no service of its own and would be re-read against '
    'the new one. Slice 2A.2b has no service-replacement operation: book the '
    'new service as a new booking.',
    old.id, live_provider, live_resource,
    released_provider + released_resource, requirement_sets;
end $fn$;

create trigger fr_booking_determinant_guard
  before update on bookings
  for each row execute function fr_booking_determinant_guard();

-- The final-state half of the `status` rule.
--
-- A status that no longer holds capacity must free it. That link was a
-- repository guarantee only, so `UPDATE bookings SET status = 'cancelled'`
-- through any other path left a provider and a room blocked for a booking
-- nobody will attend. DEFERRED on purpose: the controlled path sets the status
-- and then releases inside ONE transaction, and both orders must be allowed
-- within it — what must never survive is a COMMIT with the two out of step.
--
-- Deferral is also exactly why this check cannot stand alone. It runs at COMMIT
-- and sees only committed rows, so a claim still open in another transaction is
-- invisible to it; the FOR UPDATE taken above is what stops that transaction
-- from existing concurrently in the first place. The lock decides, this
-- confirms.
create function fr_booking_status_footprint_guard() returns trigger
  language plpgsql as $fn$
declare live integer;
begin
  if new.status not in ('cancelled', 'no_show') then return null; end if;
  select (select count(*) from booking_provider_allocations
           where booking_id = new.id and released_at is null)
       + (select count(*) from booking_resource_allocations
           where booking_id = new.id and released_at is null)
    into live;
  if live > 0 then
    raise exception
      'booking % is % but still holds % live claim(s); release them in the same '
      'transaction that changes the status',
      new.id, new.status, live;
  end if;
  return null;
end $fn$;

create constraint trigger fr_booking_status_footprint_guard
  after update on bookings
  deferrable initially deferred
  for each row execute function fr_booking_status_footprint_guard();

-- ...and the same rule seen from the claim side, so a live claim cannot be
-- attached to a booking that already stopped holding capacity. Both allocation
-- tables, because a room is held exactly as literally as a provider is.
--
-- FOR KEY SHARE here is the lock the composite foreign key already takes, and
-- it conflicts with the FOR UPDATE the status and service paths take — that
-- conflict, not the read itself, is what makes this guard's answer current
-- rather than stale.
create function fr_claim_booking_state_guard() returns trigger
  language plpgsql as $fn$
declare booking_status text;
begin
  if new.released_at is not null then return null; end if;
  select b.status into booking_status
    from bookings b where b.id = new.booking_id for key share;
  if booking_status in ('cancelled', 'no_show') then
    raise exception
      'booking % is % and cannot hold a live allocation', new.booking_id, booking_status;
  end if;
  return null;
end $fn$;

create trigger fr_provider_claim_booking_state_guard
  after insert or update on booking_provider_allocations
  for each row execute function fr_claim_booking_state_guard();
create trigger fr_resource_claim_booking_state_guard
  after insert or update on booking_resource_allocations
  for each row execute function fr_claim_booking_state_guard();

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
  uncovered_count integer;
  uncovered_ids text;
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

  -- The backfill turns assigned_employee_id into a LIVE claim, and a live claim
  -- must be eligible — the same rule the runtime guard enforces from here on.
  -- Eligibility rows are NOT invented, claims are NOT released and history is
  -- NOT rewritten: a database that cannot satisfy the rule is reported and the
  -- migration aborts so an operator can decide.
  select count(*) into uncovered_count
  from bookings b
  cross join lateral (
    select ((b.starts_at - make_interval(mins => b.buffer_before_min_snapshot))
             at time zone 'Asia/Muscat')::date as d
    union
    select ((b.ends_at + make_interval(mins => b.buffer_after_min_snapshot)
             - interval '1 microsecond') at time zone 'Asia/Muscat')::date
  ) dates
  where b.assigned_employee_id is not null
    and b.status in ('confirmed', 'checked_in', 'in_service', 'completed')
    and (not exists (select 1 from provider_branch_assignments a
                      where a.employee_id = b.assigned_employee_id
                        and a.branch_id = b.branch_id and a.valid_dates @> dates.d)
      or not exists (select 1 from provider_service_qualifications q
                      where q.employee_id = b.assigned_employee_id
                        and q.service_id = b.service_id and q.valid_dates @> dates.d));

  select string_agg(id::text, ', ' order by id) into uncovered_ids
  from (
    select distinct b.id
    from bookings b
    cross join lateral (
      select ((b.starts_at - make_interval(mins => b.buffer_before_min_snapshot))
               at time zone 'Asia/Muscat')::date as d
      union
      select ((b.ends_at + make_interval(mins => b.buffer_after_min_snapshot)
               - interval '1 microsecond') at time zone 'Asia/Muscat')::date
    ) dates
    where b.assigned_employee_id is not null
      and b.status in ('confirmed', 'checked_in', 'in_service', 'completed')
      and (not exists (select 1 from provider_branch_assignments a
                        where a.employee_id = b.assigned_employee_id
                          and a.branch_id = b.branch_id and a.valid_dates @> dates.d)
        or not exists (select 1 from provider_service_qualifications q
                        where q.employee_id = b.assigned_employee_id
                          and q.service_id = b.service_id and q.valid_dates @> dates.d))
    order by b.id limit 20
  ) s;

  if uncovered_count > 0 then
    raise exception
      'migration 0006 preflight: % booking/date pair(s) would become a live allocation whose '
      'provider has no branch assignment or service qualification on that Muscat date. '
      '0006 does not invent eligibility, release claims or rewrite history — add the missing '
      'provider_branch_assignments / provider_service_qualifications rows, or clear the '
      'assignment on those bookings, then re-run. Sample bookings: %',
      uncovered_count, uncovered_ids;
  end if;
end $preflight$;

alter table bookings validate constraint bookings_buffer_before_bounds;
alter table bookings validate constraint bookings_buffer_after_bounds;

-- ---------------------------------------------------------------- backfill
-- assigned_employee_id is a stored fact, so moving it is a transfer, not a
-- guess. What is NOT inferred: no provider is invented where the column is
-- NULL, and NO physical resource and NO requirement set is created for any
-- pre-0006 booking — there is no inventory to draw on and inventing one is
-- forbidden. Eligibility is not rewritten either, in EITHER direction: 0006
-- invents no assignment and no qualification row, and it releases nothing. What
-- it does do is refuse to run at all when a booking would become a live claim
-- without coverage — the preflight above has already proven every row it is
-- about to write satisfies the same rule the runtime guards enforce from here
-- on, so this statement cannot create a claim the database would reject a
-- second later.
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
