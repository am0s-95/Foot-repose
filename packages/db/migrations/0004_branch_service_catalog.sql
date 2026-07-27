-- Versioned branch service catalog (Slice 2A.1).
--
-- * branches.customer_segment: nullable on purpose — classifying the real
--   branches is business data entered later, never guessed here.
-- * branch_service_offerings: one row per (branch, service, validity range).
--   valid_during is a half-open [from, to) tstzrange; a NULL upper bound
--   means "current". PostgreSQL itself rejects overlapping ranges for the
--   same branch+service via an exclusion constraint.
-- * Buffers (prep/cleaning margins) are stored per offering row — dated,
--   changeable data, not constants in code.
-- * bookings gain immutable snapshots of the service name/duration/buffers
--   taken at booking time, so later catalog changes never rewrite history.
--   Existing rows are backfilled from the current services table (small
--   table, single deploy step — acceptable to combine DDL + backfill here).

create extension if not exists btree_gist;

alter table branches
  add column customer_segment text
    check (customer_segment in ('men', 'women', 'mixed'));

create table branch_service_offerings (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id),
  service_id uuid not null references services (id),
  valid_during tstzrange not null check (not isempty(valid_during)),
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

alter table bookings
  add column service_name_snapshot text,
  add column duration_min_snapshot integer,
  add column buffer_before_min_snapshot integer not null default 0,
  add column buffer_after_min_snapshot integer not null default 0;

-- Preserve existing bookings: seed their snapshots from the current catalog.
update bookings b
set service_name_snapshot = s.name,
    duration_min_snapshot = s.duration_min
from services s
where s.id = b.service_id
  and b.service_name_snapshot is null;

alter table bookings
  alter column service_name_snapshot set not null,
  alter column duration_min_snapshot set not null;
