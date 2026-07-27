-- Initial schema for Foot Repose v2.
-- Irreversible: creates the base schema. Rollback = drop the database.
-- Statuses and roles are text + CHECK constraints (cheaper to evolve than enums).

create table branches (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  name text not null,
  area text not null,
  phone text not null,
  timezone text not null default 'Asia/Muscat',
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table employees (
  id uuid primary key default gen_random_uuid(),
  email text not null unique check (email = lower(email)),
  password_hash text not null,
  full_name text not null,
  phone text,
  role text not null check (role in ('super_admin', 'branch_manager', 'staff')),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table employee_branches (
  employee_id uuid not null references employees (id) on delete cascade,
  branch_id uuid not null references branches (id) on delete cascade,
  primary key (employee_id, branch_id)
);

create index employee_branches_branch_idx on employee_branches (branch_id);

create table services (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  duration_min integer not null check (duration_min > 0),
  price_baisa integer not null check (price_baisa >= 0),
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table customers (
  id uuid primary key default gen_random_uuid(),
  full_name text not null,
  phone text not null,
  email text,
  notes text,
  created_at timestamptz not null default now()
);

create index customers_phone_idx on customers (phone);

create table bookings (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references branches (id),
  customer_id uuid not null references customers (id),
  service_id uuid not null references services (id),
  assigned_employee_id uuid references employees (id),
  status text not null default 'confirmed' check (
    status in ('confirmed', 'checked_in', 'in_service', 'completed', 'cancelled', 'no_show')
  ),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  price_baisa integer not null check (price_baisa >= 0),
  currency text not null default 'OMR' check (currency = 'OMR'),
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at)
);

-- The branch board constantly reads "bookings of branch X between T1 and T2".
create index bookings_branch_starts_idx on bookings (branch_id, starts_at);
create index bookings_customer_idx on bookings (customer_id);

create table audit_logs (
  id bigint generated always as identity primary key,
  actor_employee_id uuid references employees (id),
  action text not null,
  entity_type text not null,
  entity_id text,
  branch_id uuid references branches (id),
  from_status text,
  to_status text,
  metadata jsonb not null default '{}'::jsonb,
  ip text,
  created_at timestamptz not null default now()
);

create index audit_logs_entity_idx on audit_logs (entity_type, entity_id);
create index audit_logs_actor_idx on audit_logs (actor_employee_id, created_at);
