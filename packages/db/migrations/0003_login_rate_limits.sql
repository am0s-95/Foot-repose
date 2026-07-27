-- Shared login rate limiting (fixed window per key). A single atomic upsert
-- counts each attempt, so counting stays correct across API instances,
-- cold starts and concurrent requests.

create table login_rate_limits (
  key text not null,
  window_start timestamptz not null,
  attempts integer not null default 0,
  primary key (key, window_start)
);

create index login_rate_limits_window_idx on login_rate_limits (window_start);
