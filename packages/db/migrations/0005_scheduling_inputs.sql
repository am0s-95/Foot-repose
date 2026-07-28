-- Scheduling inputs 1/3 (Slice 2A.2a): branch opening hours + provider
-- scheduling. Physical resources, allocations and booking policies belong to
-- later migrations and are deliberately absent here.
--
-- Locked rules this migration encodes:
--   * instants are stored in UTC; the operational calendar is Asia/Muscat
--     (a fixed UTC+4 offset, no DST);
--   * every range is half-open [from, to) — same CHECK shape as 0004. Note
--     the honest difference: daterange is a DISCRETE type, so PostgreSQL
--     canonicalises '[]' to '[)' itself and the inclusivity half of the
--     CHECK can never fail there; what it still catches is an empty range
--     or a version with no start. On the continuous tstzrange of T8 the
--     same CHECK is load-bearing;
--   * a weekly window may cross midnight (close_minute > 1440). The cyclic
--     week — including the Saturday -> Sunday wrap — is enforced by
--     PostgreSQL itself through a generated int4multirange and a GiST
--     exclusion constraint, not by application code;
--   * a Muscat-day override OWNS every minute of its day. Windows under a
--     closed day are structurally impossible, and override windows may never
--     cross midnight;
--   * history is immutable: past overrides cannot be created, changed or
--     deleted. Ending something = closing its range, never DELETE.
--
-- Two rules that are NOT database constraints, by decision, and live in the
-- domain materialisation layer with tests in both directions:
--   * version-boundary carry-in — each dated version owns the minutes of its
--     own dates, so a window crossing midnight is clipped at the boundary
--     when the next day belongs to a different version;
--   * an extra shift OVERRIDES the weekly template for the minutes it covers
--     (it does not add to it), which is what keeps one provider from
--     appearing available in two branches at the same instant.

-- Single source of "today" for every guard below. statement_timestamp() —
-- not now() — so a long transaction cannot keep writing into a stale day.
create function muscat_today() returns date
  language sql stable as
$$ select (statement_timestamp() at time zone 'Asia/Muscat')::date $$;

-- ---------------------------------------------------------------- T2
-- Branch weekly template, dated. day_of_week: 0 = Sunday .. 6 = Saturday.
-- Split shifts are simply several rows for the same day.
create table branch_weekly_windows (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id),
  valid_dates daterange not null
    constraint branch_weekly_windows_half_open check (
      not isempty(valid_dates)
      and lower(valid_dates) is not null
      and lower_inc(valid_dates)
      and not upper_inc(valid_dates)
    ),
  day_of_week smallint not null check (day_of_week between 0 and 6),
  open_minute smallint not null check (open_minute between 0 and 1439),
  -- > 1440 means the window crosses midnight into the next Muscat day.
  close_minute integer not null
    check (close_minute > open_minute and close_minute <= open_minute + 1440),
  -- Minutes of the week [0, 10080) occupied by this window. A window that
  -- runs past Saturday midnight wraps to the start of the same week, so the
  -- exclusion constraint below sees the Saturday -> Sunday collision.
  week_spans int4multirange generated always as (
    case
      when day_of_week * 1440 + close_minute <= 10080 then
        int4multirange(int4range(day_of_week * 1440 + open_minute,
                                 day_of_week * 1440 + close_minute))
      else
        int4multirange(int4range(day_of_week * 1440 + open_minute, 10080),
                       int4range(0, day_of_week * 1440 + close_minute - 10080))
    end
  ) stored,
  created_at timestamptz not null default now(),
  constraint branch_weekly_windows_no_overlap
    exclude using gist (
      branch_id with =,
      valid_dates with &&,
      week_spans with &&
    )
);

create index branch_weekly_windows_lookup_idx
  on branch_weekly_windows (branch_id, day_of_week);

-- ---------------------------------------------------------------- T3
-- One override header per branch per Muscat day. It owns the whole day:
-- when is_closed, the branch is shut for every minute of that day.
create table branch_hours_overrides (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id),
  muscat_date date not null,
  is_closed boolean not null,
  note text,
  created_at timestamptz not null default now(),
  constraint branch_hours_overrides_one_per_day unique (branch_id, muscat_date),
  -- referenced by the composite FK in T4; that is its only purpose
  constraint branch_hours_overrides_id_closed unique (id, is_closed)
);

-- ---------------------------------------------------------------- T4
-- Replacement windows for an open override day. header_is_closed is pinned
-- to false and joined into the FK, so a window under a CLOSED day cannot be
-- inserted at all — the database rejects it, no trigger involved.
create table branch_hours_override_windows (
  id uuid primary key default gen_random_uuid(),
  override_id uuid not null,
  header_is_closed boolean not null
    constraint branch_hours_override_windows_open_day check (header_is_closed = false),
  open_minute smallint not null check (open_minute between 0 and 1439),
  -- No midnight crossing: an override day owns its own minutes only.
  close_minute smallint not null
    check (close_minute > open_minute and close_minute <= 1440),
  created_at timestamptz not null default now(),
  constraint branch_hours_override_windows_header_fk
    foreign key (override_id, header_is_closed)
    references branch_hours_overrides (id, is_closed) on delete cascade,
  constraint branch_hours_override_windows_no_overlap
    exclude using gist (
      override_id with =,
      int4range(open_minute, close_minute) with &&
    )
);

-- Past days are history. Guards cover the header and its windows, and the
-- window guard checks the OLD and the NEW header separately so a row cannot
-- be moved out of (or into) a past day.
create function branch_hours_overrides_guard() returns trigger
  language plpgsql as $fn$
declare today date := muscat_today();
begin
  if tg_op = 'INSERT' then
    if new.muscat_date < today then
      raise exception 'cannot create an override for a past Muscat date (%)', new.muscat_date;
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.muscat_date < today then
      raise exception 'past overrides are immutable history (%)', old.muscat_date;
    end if;
    return old;
  end if;
  if old.muscat_date < today or new.muscat_date < today then
    raise exception 'past overrides are immutable history (% -> %)', old.muscat_date, new.muscat_date;
  end if;
  return new;
end $fn$;

create trigger branch_hours_overrides_guard
  before insert or update or delete on branch_hours_overrides
  for each row execute function branch_hours_overrides_guard();

create function branch_hours_override_windows_guard() returns trigger
  language plpgsql as $fn$
declare
  today date := muscat_today();
  old_header date;
  new_header date;
begin
  if tg_op in ('UPDATE', 'DELETE') then
    select muscat_date into old_header from branch_hours_overrides where id = old.override_id;
    if old_header < today then
      raise exception 'windows of past overrides are immutable history (%)', old_header;
    end if;
  end if;
  if tg_op in ('INSERT', 'UPDATE') then
    select muscat_date into new_header from branch_hours_overrides where id = new.override_id;
    if new_header < today then
      raise exception 'cannot attach a window to a past override (%)', new_header;
    end if;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $fn$;

create trigger branch_hours_override_windows_guard
  before insert or update or delete on branch_hours_override_windows
  for each row execute function branch_hours_override_windows_guard();

-- ---------------------------------------------------------------- T5
-- Operational branch assignment, dated. employee_branches stays what it is:
-- an access-control grant, not a schedule.
create table provider_branch_assignments (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id),
  branch_id uuid not null references branches (id),
  valid_dates daterange not null
    constraint provider_branch_assignments_half_open check (
      not isempty(valid_dates)
      and lower(valid_dates) is not null
      and lower_inc(valid_dates)
      and not upper_inc(valid_dates)
    ),
  created_at timestamptz not null default now(),
  constraint provider_branch_assignments_no_overlap
    exclude using gist (
      employee_id with =,
      branch_id with =,
      valid_dates with &&
    )
);

create index provider_branch_assignments_branch_idx
  on provider_branch_assignments (branch_id);

-- ---------------------------------------------------------------- T6
create table provider_service_qualifications (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id),
  service_id uuid not null references services (id),
  valid_dates daterange not null
    constraint provider_service_qualifications_half_open check (
      not isempty(valid_dates)
      and lower(valid_dates) is not null
      and lower_inc(valid_dates)
      and not upper_inc(valid_dates)
    ),
  created_at timestamptz not null default now(),
  constraint provider_service_qualifications_no_overlap
    exclude using gist (
      employee_id with =,
      service_id with =,
      valid_dates with &&
    )
);

create index provider_service_qualifications_service_idx
  on provider_service_qualifications (service_id);

-- ---------------------------------------------------------------- T7
-- Provider weekly template. Same cyclic-week machinery as T2.
-- branch_id is deliberately OUTSIDE the exclusion key: two shifts of one
-- provider may never overlap even when they are in different branches.
create table provider_weekly_windows (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id),
  branch_id uuid not null references branches (id),
  kind text not null check (kind in ('shift', 'break')),
  valid_dates daterange not null
    constraint provider_weekly_windows_half_open check (
      not isempty(valid_dates)
      and lower(valid_dates) is not null
      and lower_inc(valid_dates)
      and not upper_inc(valid_dates)
    ),
  day_of_week smallint not null check (day_of_week between 0 and 6),
  open_minute smallint not null check (open_minute between 0 and 1439),
  close_minute integer not null
    check (close_minute > open_minute and close_minute <= open_minute + 1440),
  week_spans int4multirange generated always as (
    case
      when day_of_week * 1440 + close_minute <= 10080 then
        int4multirange(int4range(day_of_week * 1440 + open_minute,
                                 day_of_week * 1440 + close_minute))
      else
        int4multirange(int4range(day_of_week * 1440 + open_minute, 10080),
                       int4range(0, day_of_week * 1440 + close_minute - 10080))
    end
  ) stored,
  created_at timestamptz not null default now(),
  constraint provider_weekly_windows_no_overlap
    exclude using gist (
      employee_id with =,
      kind with =,
      valid_dates with &&,
      week_spans with &&
    )
);

create index provider_weekly_windows_branch_idx
  on provider_weekly_windows (branch_id, day_of_week);

-- ---------------------------------------------------------------- T8
-- Concrete extra shifts, in UTC instants. Semantically an OVERRIDE of the
-- weekly template for the minutes it covers (see the domain layer), which is
-- why two extra shifts of one provider may never overlap.
create table provider_extra_shifts (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id),
  branch_id uuid not null references branches (id),
  during tstzrange not null
    constraint provider_extra_shifts_half_open check (
      not isempty(during)
      and lower(during) is not null
      and lower_inc(during)
      and upper(during) is not null
      and not upper_inc(during)
    ),
  note text,
  created_at timestamptz not null default now(),
  constraint provider_extra_shifts_no_overlap
    exclude using gist (
      employee_id with =,
      during with &&
    )
);

create index provider_extra_shifts_branch_idx
  on provider_extra_shifts (branch_id);
