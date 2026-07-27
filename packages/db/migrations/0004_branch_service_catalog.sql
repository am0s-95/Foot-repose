-- Versioned branch service catalog (Slice 2A.1).
--
-- * branches.customer_segment: nullable on purpose — classifying the real
--   branches is business data entered later, never guessed here.
-- * branch_service_offerings: one row per (branch, service, validity range).
--   PostgreSQL enforces BOTH invariants itself:
--     - valid_during must be exactly half-open [from, to): finite inclusive
--       lower bound, exclusive (possibly unbounded) upper bound, non-empty;
--     - ranges for the same branch+service may never overlap (btree_gist
--       exclusion constraint).
-- * Buffers (prep/cleaning margins) are stored per offering row — dated,
--   changeable data, not constants in code.
-- * bookings gain immutable snapshots (service name, duration, buffers)
--   taken at booking time, so later catalog changes never rewrite history.
--   Snapshot columns carry NO defaults: every new booking must state its
--   snapshots explicitly.

create extension if not exists btree_gist;

alter table branches
  add column customer_segment text
    check (customer_segment in ('men', 'women', 'mixed'));

create table branch_service_offerings (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id),
  service_id uuid not null references services (id),
  valid_during tstzrange not null
    constraint branch_service_offerings_half_open check (
      not isempty(valid_during)
      and lower(valid_during) is not null
      and lower_inc(valid_during)
      and not upper_inc(valid_during)
    ),
  price_baisa integer not null check (price_baisa >= 0),
  duration_min integer not null check (duration_min > 0),
  buffer_before_min integer not null default 0 check (buffer_before_min >= 0),
  buffer_after_min integer not null default 0 check (buffer_after_min >= 0),
  is_bookable_online boolean not null default true,
  created_at timestamptz not null default now(),
  constraint branch_service_offerings_no_overlap
    exclude using gist (
      branch_id with =,
      service_id with =,
      valid_during with &&
    )
);

create index branch_service_offerings_lookup_idx
  on branch_service_offerings (branch_id, service_id);

-- Snapshot columns start nullable so the backfill below can fill EVERY
-- existing row explicitly; they are locked NOT NULL (with no defaults)
-- immediately afterwards.
alter table bookings
  add column service_name_snapshot text,
  add column duration_min_snapshot integer,
  add column buffer_before_min_snapshot integer,
  add column buffer_after_min_snapshot integer;

-- Approved transition policy for bookings that predate the catalog:
--   * name       — copied from the current service row (no older source exists);
--   * duration   — derived from the booking's OWN scheduled window
--                  (ends_at - starts_at), not from the mutable services table;
--   * buffers    — fixed at 0 before / 10 after (the operating margin in
--                  force when this migration shipped).
update bookings b
set service_name_snapshot = s.name,
    duration_min_snapshot = greatest(1, (extract(epoch from (b.ends_at - b.starts_at)) / 60)::integer),
    buffer_before_min_snapshot = 0,
    buffer_after_min_snapshot = 10
from services s
where s.id = b.service_id
  and b.service_name_snapshot is null;

alter table bookings
  alter column service_name_snapshot set not null,
  alter column duration_min_snapshot set not null,
  alter column buffer_before_min_snapshot set not null,
  alter column buffer_after_min_snapshot set not null,
  add constraint bookings_duration_snapshot_positive
    check (duration_min_snapshot > 0),
  add constraint bookings_buffer_snapshots_nonnegative
    check (buffer_before_min_snapshot >= 0 and buffer_after_min_snapshot >= 0);
