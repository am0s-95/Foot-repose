-- Server-side employee sessions (workforce realm). A session row is the
-- source of truth: revoking it invalidates the JWT that references it.

create table sessions (
  id uuid primary key default gen_random_uuid(),
  employee_id uuid not null references employees (id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  ip text
);

create index sessions_employee_idx on sessions (employee_id, created_at);
