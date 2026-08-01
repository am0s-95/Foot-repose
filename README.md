# Foot Repose

Booking and branch-operations platform for Foot Repose — a foot spa company
with **11 branches and ~160 employees** in Muscat, Oman. Times are
**Asia/Muscat** (fixed UTC+4), money is **OMR stored as integer baisa**
(1 OMR = 1000 baisa).

Built as a **modular monolith**: one shared backend, three independent
frontends, shared packages. Business rules and permissions live on the
server only — frontends render what the API allows.

## Layout

```
apps/
  api/        Shared backend (Next.js route handlers) — auth, bookings, audit
  branch/     Branch App — staff login + live bookings board   (port 3001)
  admin/      Admin App — head-office console (scaffold)       (port 3002)
  customer/   Customer App — public site, live branch directory (port 3003)
packages/
  domain/     Pure business rules: booking state machine, role/branch
              permissions, Muscat time math, OMR money. No runtime deps.
  db/         SQL migrations + runner, repositories, fictional seed
  contracts/  Zod request/response schemas + typed fetch client
```

Dependency rule: `apps → contracts/domain`, `api → domain + db + contracts`.
Frontends never import `db` and never re-implement permissions — booking
cards render the server-computed `allowedActions` per actor.

## Getting started

Requirements: Node ≥ 20.9, PostgreSQL 16 (or `docker compose up -d`).

```bash
npm install

# database (defaults match compose.yaml; override via env or root .env)
cp .env.example .env                      # then edit values
npm run db:migrate
SEED_CONFIRM=wipe npm run db:seed         # fictional data; TRUNCATEs everything.
# Seeds around today by default. Tests pass SEED_REFERENCE_DATE=YYYY-MM-DD so
# the dataset is a function of a stated day, not of the day they happen to run.
# Three interlocks: refuses NODE_ENV=production, refuses databases not named
# *_dev/_development/_local/_test, and refuses to run without SEED_CONFIRM=wipe.

# api needs its own env file
printf 'DATABASE_URL=...\nAUTH_SECRET=...\n' > apps/api/.env.local

npm run dev:api        # http://localhost:3000
npm run dev:branch     # http://localhost:3001
npm run dev:admin      # http://localhost:3002
npm run dev:customer   # http://localhost:3003
```

Seed logins (password for all: `FootRepose!Dev1` — dev only):

| Role           | Email                            |
| -------------- | -------------------------------- |
| Super admin    | `hq.admin@footrepose.example`    |
| Branch manager | `manager.khw@footrepose.example` |
| Staff          | `staff01.khw@footrepose.example` |

All seeded people are fictional. Never put real customer or employee data
in seeds or fixtures.

### What the seed produces, and why it varies

The seed builds three Muscat days around a **reference date** —
`SEED_REFERENCE_DATE`, defaulting to today. How many bookings fit is a function
of that date's weekday, and the totals are exact:

| reference weekday | bookings |
| ----------------- | -------- |
| Sunday–Wednesday  |      161 |
| Thursday          |      121 |
| Friday            |       95 |
| Saturday          |      106 |

Two deliberate facts explain the whole spread, and `packages/db/src/seed-plan.ts`
encodes them so a test can derive the number instead of guessing a threshold:

- **Friday is the weekly day off.** Every roster omits it, so no provider is
  present at their home branch and a Friday reference date seeds **zero**
  bookings company-wide — not "fewer". A Friday appearing as the reference day,
  as yesterday, or as tomorrow removes that day's entire contribution.
- **Al Khuwair is closed tomorrow.** The seed writes a closure override for the
  first branch on the day after the reference date, so tomorrow contributes ten
  branches rather than eleven.

Live-database tests never pin a date: they derive one from `futureWeekAnchor()`,
the first Sunday at least two days ahead, and take a full Sunday-to-Saturday
week from it. A pinned date is seedable when it is written and forbidden once
the calendar passes it, so it would turn CI red on its own — the same
expiring-test defect in slower motion. Pure date-contract tests still use fixed
historical, month-boundary and leap dates, because they write no rows.

**A reference date before yesterday cannot be seeded at all.** Migration 0005
refuses a branch-hours override for a past Muscat date ("past days are
history"), and the seed writes one for `reference + 1`. So a live-database audit
can only cover today − 1 forward, whatever day it runs. Full multi-month
coverage therefore lives in `packages/db/tests/seed-plan.test.ts`, which is pure
and exhaustive over 62 consecutive dates; `packages/db/src/seed-audit.ts` runs
the same assertions against real rows, over a FUTURE range so all 62 are
seedable, against a database it REFUSES to share — `SEED_AUDIT_DATABASE_URL`
must be set and must differ from `DATABASE_URL` and `TEST_DATABASE_URL`, checked
before anything is wiped. It audits every provider allocation including released
ones (cancelled and no-show bookings release their claims, and the old
`released_at IS NULL` filter silently skipped them), and records real per-branch
counts. It reports four separate eligibility counters — outside branch
availability, outside provider presence, no branch assignment, no service
qualification — computed with the application's own `materializeBranchHours` /
`materializeProviderPresence`, not a weekday-only SQL approximation.

This used to be undocumented, and the tests asserted `bookings > 100` and "Al
Khuwair has something to check in today". Both are true most of the week and
false on the day off, so the suite went red on a Friday with nothing changed.
The invariants now assert the derived count, a seven-day matrix exercises every
weekday on demand, and Playwright's `globalSetup` seeds an explicitly actionable
reference date and the spec navigates to it through the real next-day button.

## Vertical slice 1 (this repo state)

Branch App end-to-end: employee login (HttpOnly JWT cookie) → allowed
branches → today's bookings (search by customer name/phone, filter by
status, browse days) → transitions
`Confirmed → Checked in → In service → Completed` plus manager-only
`Cancel` / `No show`.

Server-enforced guarantees:

- **State machine** — invalid jumps and repeats are rejected (409).
- **Concurrency** — transitions are a compare-and-swap inside a
  transaction; the second of two simultaneous attempts gets 409.
- **Permissions** — role + branch assignment are checked in the API on
  every read and write; hiding buttons is UX, not security. Bookings of a
  deactivated branch cannot be transitioned.
- **Audit** — every login attempt (including throttled ones), logout and
  booking transition writes an `audit_logs` row (actor, entity, from/to
  status, ip), atomically with the change it records.

Day navigation on the board is a small state machine
(`apps/branch/src/lib/board-navigation.ts`), and the reason is a measured defect:
the controls used to compute the next day from the last **loaded** response, so
clicks issued while a board was still loading all started from the same day.
Eleven "next" clicks moved the label zero days. Intent and response are now
separate — a step folds on the previous **intent**, so N clicks are exactly N
days across month, year and leap boundaries — and every request carries a
monotonic generation, so only the newest may commit bookings, the date label, the
loading state or an error. An older success, an older failure and a former
branch's response are dropped on arrival. Cards are withheld whenever the
committed response's day or branch is not the one on the label, so the board
never shows one day's bookings under another day's date. The controls stay live
while a request is in flight; serialising them would hide the problem rather than
fix it.

Workforce authentication (employee realm — kept strictly separate from the
future customer realm):

- Sessions are **server-revocable**: the JWT cookie references a
  `sessions` row; logout revokes it, so a kept/stolen token dies
  immediately. Cookie: `fr_wf_session`, HttpOnly, SameSite=Lax.
- Login is **rate limited per normalized email**, in a fixed 15-minute window
  stored in PostgreSQL — shared across API instances, survives cold starts, and
  counts concurrent attempts atomically (audited 429s). The identifier is the
  address `loginRequestSchema` already trimmed and lower-cased, so case and
  whitespace variants share one counter. It was previously keyed on
  `email + X-Forwarded-For`, which meant rotating that caller-supplied header
  handed out a fresh counter per attempt — ten guesses per window became
  unlimited guesses against one employee.
- **No client IP is treated as authoritative.** `X-Forwarded-For` is written by
  whoever sends the request, so `trustedClientIp` returns `null` and neither
  sessions nor `audit_logs` record a forwarded value as if it were verified.
  Setting `TRUSTED_PROXY_HOPS=N` opts in once the network genuinely enforces
  that boundary. The right-most N entries are the **trusted suffix** — each was
  appended by one of our own hops — and the authoritative address is the
  **first** of those N (index `length − N`; with N = 1 that is the last entry).
  **Every** entry of that suffix must be a valid IPv4/IPv6 address, not just the
  one returned, and the chain is never compacted: dropping an empty element
  would slide an untrusted value into the trusted slot, so `198.51.100.9,
  203.0.113.7,` with N = 2 yields `null` rather than the left-hand value. It
  fails closed when the chain is shorter than declared. Application parsing
  cannot prove the boundary — only the deployment can, by making the origin
  unreachable except through those hops. When an authoritative address
  does exist, a second per-address bucket is counted alongside the mandatory
  per-email one. Stated plainly: per-email throttling stops an attacker grinding
  **one** account; it does not stop an attempt spread across many accounts, and
  without an authoritative source address nothing here does.
- Password verification runs **off the request thread**, in a small pool of
  worker threads. `bcrypt.compareSync` blocked the event loop for the whole key
  expansion, and an unauthenticated caller chooses how often that happens;
  bcryptjs's promise API is not a fix either, because it chains
  `process.nextTick` (measured: 1 timer tick per 89 ms, versus 0 for the sync
  call). Verification is admitted through an explicit gate of 4 with **no
  queue**; over it the attempt is refused with the same 429 body as throttling,
  so the response reveals neither the account nor the load. Only `audit_logs`
  distinguishes the two. The evidence that the loop is free is a deterministic
  ordering result — a timer armed in the same synchronous block as
  `verifyPassword` runs *before* it resolves — not a batch timing, because with
  the gate in place a batch of 8 admits 4 and refuses 4 and so is not the same
  work as 8 unthrottled verifications.
- The API builds as a **standalone artifact** (`output: 'standalone'`), and
  `bcryptjs` is listed in `serverExternalPackages` so the dependency tracer
  copies it in. Without that it copied **zero** of its files — the worker's
  `require` lives in a string the bundler cannot see — and a deployed server
  answered a correct password with `500` and `Cannot find module 'bcryptjs'`
  while `next start` inside a checkout stayed green. A test builds that
  artifact, runs it from a directory outside the repository where no ancestor
  `node_modules` can cover a gap, and logs in for real.
- The branch app's API destination is chosen at **run time, per request**, by a
  gateway route (`apps/branch/src/app/api/[...path]`) rather than by a
  build-time `rewrites()`. `rewrites()` is evaluated during `next build`, so the
  destination was written into `.next/routes-manifest.json` and frozen: measured
  on pre-fix `main`, an artifact built with `API_URL=…:4101` and then started
  with `API_URL=…:4102` sent every `/api/*` request to 4101 while 4102 received
  **zero**, with the artifact bytes unchanged — one build could not be promoted
  between environments, so what shipped was never what was tested. The browser
  side is unchanged: still relative `/api/*` on the app's own origin, still one
  HttpOnly SameSite cookie, still no CORS and no `NEXT_PUBLIC_API_URL`. The
  gateway forwards method, path, raw query (repeated parameters intact), body,
  `Cookie` and correlation headers; returns the upstream status, body and each
  `Set-Cookie` separately (a merged one would break logout); drops hop-by-hop
  headers, `Host` and stale `Content-Length`; and does not retry, because a
  repeated POST is a second booking transition. The request body is **streamed**
  rather than buffered — an unauthenticated caller must not be able to park an
  arbitrary payload in the branch process before the API, which holds the body
  limits, sees a byte — so outbound framing is chunked and no `Content-Length` is
  declared. Every response leaves as `cache-control: private, no-store`: that is
  a ceiling on the upstream's discretion, not a default, because an upstream
  `public, max-age=60` would otherwise let a shared cache re-serve one employee's
  data to another. A response that fails **while its body is being read** —
  connection reset mid-body, fewer bytes than the declared length, a malformed
  compressed body — is the same 502 as a refused connection, because `fetch`
  resolves as soon as the headers arrive and an unguarded read there became an
  unstructured HTML 500. `API_URL` is **required** and
  must be a bare origin — missing or malformed answers `503`, an unreachable
  upstream `502`, both as the API's structured JSON error with
  `cache-control: private, no-store` and no URL, DNS error or stack in the body.
  A hung upstream **is** now addressed — see the outbound deadline below; that
  closes this hop only, and is not a claim about F10 elsewhere in the system.
  The evidence builds the artifact **once with a poison
  destination**, runs it from outside the repository against two different
  upstreams, and hashes the tree around the runs. The customer app is a
  different case, and is tested as such rather than assumed: its `API_URL` read
  is in a `force-dynamic` Server Component, so it is already a runtime read —
  its silent `http://localhost:3000` fallback remains, deliberately untouched.
- The branch gateway holds an **outbound deadline** (`API_UPSTREAM_TIMEOUT_MS`,
  default `15000`, accepted `100`–`120000`), read at run time per request like
  the destination. Without it the gateway could wait forever, and measured on
  the pre-fix standalone artifact it did — in **three** distinct places, each
  reproduced against a real upstream over real sockets: an upstream that accepts
  the request and never sends response headers (the wait is inside `fetch()`);
  one that sends valid headers and then stalls mid-body (`fetch()` has already
  resolved, so the wait is inside `response.arrayBuffer()`); and a streamed
  request body sent to an upstream that stops consuming it. All three left the
  branch request pending with no response byte produced. One `AbortController`
  carries the deadline across all three phases, because a per-phase timeout
  leaves their sum unbounded — and it is an **abort**, not a `Promise.race`,
  because racing only stops this handler waiting while the upstream request
  stays open, still holding a socket. The timer is released only after the body
  has been read, not when the headers arrived. An expired request answers `504`
  with `API request timed out`; that stays distinct from the `502` of an
  unreachable or broken upstream, because 504 means the gateway decided to stop
  waiting and points the operator at this variable rather than at the API. An
  upstream's **own** 504 is relayed untouched and never synthesised here.
  Nothing is retried on expiry. A malformed value fails closed with the same
  `503` as a malformed `API_URL` — digits only, so `1e3`, `0x1F4`, `2000ms`,
  `-1` and `1.5` are refused rather than coerced, since a deployment that asked
  for `2000` and silently got `15000` is indistinguishable from one that asked
  for nothing. The evidence runs the **same artifact** at two different
  deadlines and hashes the tree around both runs.
- The same abort has a **second owner: the caller**. A deadline-only version of
  this shipped first and was incomplete — the timer was the only thing that
  could abort the upstream, so an employee closing a tab left the upload, the
  headers wait or the body read running against the API for the rest of the
  deadline, fifteen seconds per abandoned request by default. The incoming
  `req.signal` now aborts the same controller, and a request that arrives
  already cancelled starts no upstream request at all — which matters most for
  a non-GET, where forwarding one would perform a booking transition on behalf
  of a caller that had gone. Both causes are recorded, because
  `AbortSignal.aborted` says only THAT something aborted, never by whom: the
  first cause wins and is never relabelled, so a timer firing just after a
  disconnect cannot report it as an API timeout, and a disconnect just after
  the deadline cannot retract a 504 the caller is owed. A cancelled caller gets
  no invented status and no upstream-failure log line — there is nobody left to
  answer, and logging it would fill the operator's log with errors every time
  someone closes a tab. Every controller, flag and listener is per request, and
  the listener is removed with the timer on every exit path. Measured against
  the deadline-only commit: cancelling before response headers, and cancelling
  during a stalled body, both left the upstream connection open until the
  deadline expired; cancelling mid-upload already tore it down, incidentally,
  because the incoming body stream *is* the outgoing one.
- The branch gateway is a new hop in front of the API, so the **F1** boundary is
  re-proven through it: `x-forwarded-for`, `forwarded`, `x-real-ip`,
  `cf-connecting-ip`, `true-client-ip`, `x-client-ip`, `x-forwarded-host`,
  `x-forwarded-proto`, `x-forwarded-port` and `x-forwarded-prefix` are stripped
  and none is appended, because this gateway is not trusted infrastructure and
  must not manufacture the trust `TRUSTED_PROXY_HOPS` exists to gate. The
  `x-forwarded-host`/`-proto`/`-port` trio matters even though the API reads
  none of them: Next's own server synthesises them from the caller's `Host`, so
  they arrive looking authoritative in front of whatever middleware is added
  next — which is the exact shape of the bug F1 closed. A real login
  through the real gateway to the real API, carrying all six spoofed, still
  leaves `sessions.ip` and `audit_logs.ip` null.
- State-changing routes enforce an **Origin allowlist** (`ALLOWED_ORIGINS`).
- Actor-scoped responses ship `cache-control: private, no-store`.
- `AUTH_SECRET` must be ≥ 32 chars; the `change-me` placeholder is
  rejected at startup.

Architecture boundaries are enforced twice: eslint `no-restricted-imports`
and the path-aware scanner behind `tools/boundaries.test.ts` both fail when
a frontend imports database/server modules (bare specifiers or relative
paths into `apps/api`/`packages/db`), when `domain` gains any dependency
(imports or its package.json), or when `contracts` touches the database.

## Scheduling inputs (slice 2A.2a)

Migration `0005` adds the *inputs* a scheduling engine will later read.
There is no engine, no availability endpoint and no UI yet — on purpose.

- `branch_weekly_windows` / `provider_weekly_windows` — dated weekly
  templates. A window may cross midnight; the cyclic week (including the
  Saturday → Sunday wrap) is policed by PostgreSQL through a generated
  `int4multirange` and a GiST exclusion constraint. `branch_id` is
  deliberately **outside** the provider key, so one provider's shifts can
  never overlap even across two branches.
- `branch_hours_overrides` (+ `branch_hours_override_windows`) — a
  Muscat-day override owns every minute of its day. A window under a closed
  day is impossible by composite foreign key, override windows never cross
  midnight, and past days are immutable history.
- `provider_branch_assignments`, `provider_service_qualifications`,
  `provider_extra_shifts` — dated operational assignment, dated
  qualification, and concrete extra shifts in UTC instants.

Two rules the database cannot express live in `@foot-repose/domain`
(`materializeBranchHours`, `materializeProviderPresence`) and are tested in
both directions:

- **Version-boundary carry-in** — each dated version owns the minutes of
  its own dates, so a midnight-crossing window is clipped at a version
  boundary instead of leaking into the next version's day.
- **An extra shift overrides the weekly template** for the minutes it
  covers rather than adding to it. That is what keeps one provider from
  appearing available in two branches at the same instant while leaving no
  gap in total coverage.

A break must be covered by that provider's shifts **in the same branch**,
occurrence by occurrence. Coverage is decided on the windows the schedule
really produces — with the same function materialisation uses — not on abstract
week geometry: overlapping date ranges are not coverage, two adjacent shift
versions may cover a break jointly, and an occurrence that runs past midnight
belongs to the day it **started** on, so the version that must be in force is
the one covering that anchor day (for every weekday transition, not only
Saturday→Sunday). A Saturday 23:00→Sunday 02:00 shift whose version begins on
the Sunday produces no Sunday-morning occurrence at all, and cannot justify a
break there. That containment crosses rows of a single table over two
dimensions, so it is validated in the write path
(`insertProviderWeeklyWindow`) and re-proved over the seed by anti-join. It is a repository guarantee, not a
constraint: this slice exposes no update or delete path for weekly windows, but
direct SQL shortening a shift would strand a break and nothing in the database
stops that. The failure direction is safe — a stranded break only ever removes
availability.

Writes that touch several rows run as one unit of work on one connection
(`withUnitOfWork`), so `saveBranchHoursOverride` is atomic even when handed a
pool: it creates the day's header if missing, locks it `FOR UPDATE` (two
concurrent writers therefore serialise and one caller's complete set wins), then
deletes the old windows *before* flipping the header — the order the composite
foreign key demands, with no constraint weakened or deferred.

## Physical resources and booking allocation (slice 2A.2b)

Migration `0006` adds the *inventory* and the *claims*. Still no availability
engine, no endpoint and no UI — and no automatic choice of provider or unit.

- `resource_types` / `branch_resources` — physical units, individually
  allocatable even when two are interchangeable. `id` is the identity, `code`
  is the operational identifier (unique among **active** units, so a retired
  unit's code and label can be reused), `label` is display text.
- `branch_service_offering_resources` — what an offering needs, attached to the
  dated per-branch offering exactly like price/duration/buffers in `0004`.
- `booking_resource_requirement_sets` (+ `booking_resource_requirements`) — the
  booking's **own sealed snapshot**. Allocation reads this and never the live
  catalog, so splitting a future offering version cannot retroactively change
  what an existing booking requires. Three states are distinct and none of them
  is "zero": no header = a pre-0006 booking (refused, never read as "needs
  nothing"), unsealed = half built (refused), sealed = authoritative and may
  legitimately have zero rows.
- `booking_provider_allocations` / `booking_resource_allocations` — the claims.
  `bookings.assigned_employee_id` is **gone**: the allocation table is the one
  source of truth, and the DTO shows the latest historical allocation, so a
  cancelled booking still names the provider it was assigned to.

What PostgreSQL enforces itself:

- **No double claim** — GiST `EXCLUDE` on `(employee_id, occupancy)` and
  `(resource_id, occupancy)`, restricted to live rows. Two concurrent requests
  from two processes are decided by the constraint, never by a check-then-insert.
- **The claim window cannot be misstated** — `occupancy` is a generated column
  over mirrored booking columns that a composite FK pins to the booking. Direct
  SQL gets `428C9`/`23503`; rescheduling the booking either moves every claim
  atomically (`ON UPDATE CASCADE`) or fails with `23P01`. Occupancy is
  `[starts_at - buffer_before, ends_at + buffer_after)`, so two bookings that
  merely touch are still a conflict, and it is capped at 24 hours — which is what
  makes "assignment covers the first and last Muscat date" a complete coverage
  proof rather than a sample.
- **Branch and classification** — a unit from another branch is impossible (one
  shared `branch_id` in two composite FKs), and reclassifying a unit that has
  allocation history is refused (`ON UPDATE NO ACTION` on a three-column FK).
  Retire and create a replacement instead.
- **Provenance** — composite FKs prove the source offering is for the booking's
  own branch and own service.

What triggers enforce, because a constraint provably cannot: a constraint cannot
stop a child row being `DELETE`d, and `TRUNCATE` does not fire `DELETE` triggers
at all. So guards freeze sealed requirement snapshots (including the whole
primary key, so a row can never be relocated out of a sealed parent), refuse
`DELETE` on allocations, and **write `released_occupancy` themselves** rather
than trusting a caller.

**These guards are a guard against accidental destruction, not a security
boundary.** The role that owns the tables can `ALTER TABLE ... DISABLE TRIGGER`
or drop them. `TRUNCATE` protection covers **exactly** four tables —
`booking_provider_allocations`, `booking_resource_allocations`,
`booking_resource_requirement_sets`, `booking_resource_requirements`.
`audit_logs`, `bookings`, the catalog tables and every migration-`0005`
scheduling table are **not** protected and keep their current behaviour. Real
enforcement needs an application role separate from the migration role, which
this codebase does not have today.

### Where eligibility is actually enforced

A live claim must be *eligible*, and it must stay eligible. That can be broken
from four different sides, so all four are named here rather than counted:

- **Claim creation, reassignment and movement.** Allocation reads the covering
  assignment and qualification rows `FOR SHARE` — the rows it returns *are* the
  evidence, so a concurrent change cannot slip between the check and the write.
  A row-level guard then re-judges any live claim — newly inserted, reassigned,
  or moved by the reschedule cascade — against its **new** window, so a booking
  moved to a date outside the provider's assignment or qualification is refused.
- **Mutation of the evidence itself.** A statement-level guard re-examines any
  `UPDATE`/`DELETE` of `provider_branch_assignments` or
  `provider_service_qualifications` against the state it produces, and rejects
  it if a live claim would be left uncovered. Transition tables are used
  deliberately, so a multi-row statement is judged on the complete
  post-statement state rather than row by row, and both the old and the new keys
  are considered.
- **Mutation of the parent booking's own determinants.** `service_id` is not
  part of the composite key the claims carry, so changing it cascades nothing
  and fires no allocation trigger. A booking that carries any scheduling
  footprint therefore may not change its service at all — and releasing the live
  claims first is deliberately not enough, because a released claim names no
  service of its own and would be re-read against the new one. `status` is the
  same question: a deferred guard refuses to **commit** a booking that stopped
  holding capacity while it still holds live claims, and the claim side refuses
  to attach a live claim to such a booking.
- **The legacy `0005 → 0006` preflight**, which aborts with an exact count and a
  bounded sample rather than backfilling a live claim that legacy data cannot
  justify. It invents no eligibility row, releases nothing and rewrites nothing.

### Which rows actually serialise which pairs

There is **no single shared lock** across all four surfaces, and claiming one
would be the easiest way to hide a race. Each contending pair serialises on the
rows that pair genuinely has in common:

| Contending pair | Serialising rows | Locks held |
|---|---|---|
| Service or status mutation ↔ claim creation | the **booking** row | `FOR UPDATE` (mutation, in `fr_booking_determinant_guard`) vs `FOR KEY SHARE` (claim guards) |
| Claim creation / movement ↔ eligibility-evidence `UPDATE`/`DELETE` | the **assignment / qualification** rows | `FOR SHARE` (claim path) vs the mutation's own row locks |
| Repository allocate / reassign / swap ↔ each other | the **booking** row first, then identities | `FOR UPDATE` on bookings by id, then employees by id, then units by id |
| Legacy `0005 → 0006` preflight | — | not a concurrent runtime surface: it runs once, inside the migration transaction, before any of these tables carry rows |

The repository path is deliberately **stronger** than the database boundary. Any
caller going through `allocateBooking` / `reassignProvider` / `swapProviders`
takes `FOR UPDATE` on the booking row before touching identities or evidence.
`FOR KEY SHARE` is the *minimum* the in-database guards impose on direct SQL that
bypasses the repository — enough to conflict with a concurrent service or status
change, and no more.

`FOR UPDATE` conflicts with `FOR KEY SHARE`, which is what makes the first row of
that table hold. The explicit `FOR UPDATE` on the status path is load-bearing and
was **not** optional: `status` belongs to no unique key, so an `UPDATE` touching
only it is a *no-key* update, and PostgreSQL defines `FOR NO KEY UPDATE` and
`FOR KEY SHARE` as compatible — without the lock the two never blocked at all,
and a `cancelled` booking could commit while still holding a live claim. The
deferred final-state check cannot cover that on its own, because it runs at
`COMMIT` and cannot see another transaction's uncommitted claim.

Every one of these orders is tested with `pg_blocking_pids` barriers rather than
sleeps, and the barrier's **return value is asserted** to contain the other
transaction's backend pid — an empty array on timeout means the two never
contended.

Transaction outcomes in those tests are read from the **command tag**, never from
"`COMMIT` did not throw". PostgreSQL treats `COMMIT` on an already-aborted
transaction as a rollback and returns the `ROLLBACK` tag, so the losing side of a
race would otherwise be recorded as committed. The harness distinguishes a real
commit, an explicit rollback, and a `COMMIT` rejected by the deferred guard.

Removing the status lock again was measured in two parts rather than reasoned
about, because "the other assertions would have passed" is not something an
early-exiting test can tell you:

- **with the barrier assertion enabled** — all eight races stop there, since it
  is the first assertion evaluated;
- **with only that assertion disabled** — the four *status-first* races still
  fail, on the claim statement succeeding instead of raising `P0001` and on the
  invalid final state that follows; the four *claim-first* races pass, purely
  because the claim's `COMMIT` happened to land first.

Repository guarantees (not constraints), each re-proved over the seed by
anti-join, each with a safe failure direction:

- active branch and active employee, checked under lock at allocation time;
- requirement satisfaction — an exact multiset, which is a set property no row
  constraint can state;
- release on a status that stops holding capacity, as one atomic operation with
  the status change (`applyBookingTransition`; the plain compare-and-swap is not
  exported, so no caller can flip a status without releasing).

Swaps are **one** operation, not two reassignments: two independent calls each
release their own side and then collide with the other's committed claim. Every
allocation operation takes the same global lock order — bookings, then employees,
then units, each `FOR UPDATE` by ascending id, and only then the branch row
`FOR SHARE` — so a swap cannot deadlock, and swaps carry the
caller's expected allocation sequences **keyed by booking** — a flat list would
release a third booking's claim and would miss an unlisted live one. Two
concurrent swaps produce one winner and one `stale` rejection.

An **expected** conflict is an answer, not a crash. Four exact constraint names —
`provider_no_double_booking`, `provider_allocation_one_live_idx`,
`resource_no_double_booking`, `resource_allocation_one_live_idx` — are translated
at the claim-insert boundary into `AllocationError` with code `provider_conflict`
or `resource_conflict` and a fixed message carrying no SQL, table, constraint or
id; the original `DatabaseError` survives as the error **cause** for the server
log. The mapping is keyed on the constraint **name**, never on the SQLSTATE: the
same `23P01` is also raised when a reschedule cascade is refused, and the same
`23505` by a duplicate catalog code, and neither is a claim conflict. Everything
else — `23503` mirror failures, `23514` window checks, `P0001` eligibility
triggers, `40P01`, `40001`, and anything unclassified — is rethrown untouched.
PostgreSQL still decides; nothing is pre-checked and nothing is retried, and a
classified conflict still rolls its whole transaction back.

Honest limits recorded in code and tests: temporal effectiveness of the source
offering is proved **at capture time only** — a later reschedule does not
re-prove it, and slice 2B must revalidate or deliberately keep the original
capture as provenance. `allocation_seq` is a deterministic *logical* ordering of
the writes to one booking under its row lock, not wall-clock chronology and not
an ordering across bookings. A **resource** claim carries no service-specific
eligibility of its own — what ties units to a service is the sealed requirement
snapshot, and a booking that has one cannot change service at all. There is no
service-replacement operation in this slice: changing the service of a booking
that has ever held a provider or a unit would have to re-snapshot name, duration
and price, re-capture requirements from the new offering and re-allocate, so
until that exists a different service means a different booking.

**Which offering version applies is decided inside PostgreSQL**, on the booking
row. `captureBookingRequirements` joins `bookings` to `branch_service_offerings`
on `o.valid_during @> b.starts_at` and passes only the booking id, because range
membership at a boundary is exact arithmetic and a JavaScript `Date` cannot carry
the operand. It used to bind the JavaScript-observed start, and that was measured
to be wrong, not merely risky: with a version boundary anywhere inside the
booking's own millisecond, capture **succeeded** and copied the PREVIOUS
version's price, duration, both buffers and resource requirements, and derived
`ends_at` from the wrong duration — silently. With a gap before the new version
it did the opposite and refused a booking that plainly had one. The booking stays
locked `FOR UPDATE` first and the chosen offering stays `FOR SHARE`, so a
concurrent repricing still cannot move under the snapshot.

One precision limit remains **recorded and deliberately unfixed**: the JavaScript
eligibility precheck derives the Muscat dates a claim occupies with
`endUtc - 1 millisecond`, while the PostgreSQL guard uses
`upper(occupancy) - interval '1 microsecond'`. For an occupancy ending in the
first 999 microseconds after Muscat midnight the two disagree about the last
date, and PostgreSQL — being the stricter of the two — can refuse a claim the
precheck allowed. The failure direction is safe: the database is the final
integrity boundary and no invalid claim is ever written. What reaches the caller
in that case is a `P0001` trigger error with no stable constraint identifier, so
it is **not** classified; its message is never parsed.

### Test-database safety

`npm test` must never be able to destroy a database it did not create. It once
could: a test opened a hardcoded `127.0.0.1:5432/postgres` connection —
ignoring `TEST_DATABASE_URL` — and ran `DROP DATABASE IF EXISTS foot_repose_prod`
before its first assertion, so a real database of that name on the local cluster
was deleted, OID and all.

Tests that need a second database now go through
`apps/api/tests/scratch-database.ts`: every URL is derived from the configured
`DATABASE_URL`, the admin connection must itself be a `_test` database (checked
live with `current_database()`), names are random and never fixed,
`CREATE DATABASE` carries no `IF NOT EXISTS` so a collision fails instead of
consuming a database, and `DROP DATABASE` carries no `IF EXISTS` and runs only
for a database the helper proved it created. The worst case if a run is killed
is one orphaned, uniquely named scratch database.

The `checks` CI job deliberately publishes PostgreSQL on host port **55432**, so
any future code that assumes `5432` fails the job instead of finding somebody
else's cluster.

### Test-process ownership

A test that starts a server owns it until it is **proven** gone. Measured on
main `2773b7c`, `apps/customer/tests/api-destination.test.ts` did neither:
`spawn('npx', ['next', 'start', ...])` produced a three-link chain — the npm
launcher, a shell, and the real `next-server` — and cleanup was a bare
`kill('SIGKILL')` on the launcher. The suite exited 0 while port 3291 kept
serving; GitHub's runner then logged `Terminate orphan process` for the two
survivors, which is a cleanup contract being false rather than a runner quirk.

Two rules follow, and the tests enforce them:

- **The retained handle must be the process.** Resolve the CLI and run it with
  `process.execPath`. No `npx`, and nothing spawned through a shell — either one
  puts a launcher between the handle and the thing that holds the port.
- **A signal is not an exit.** `stop()` sends SIGTERM, waits for the real `exit`
  event, escalates once to SIGKILL after a bounded grace period, waits again,
  and throws if the process is still alive. Cleanup failures are loud; the
  original silent one is what let the leak survive.

Resources are recorded the moment they exist, so a setup that fails half way
still releases what it created and then rethrows the *original* failure. The
release is idempotent, because `afterAll` runs even when `beforeAll` threw —
measured on this Vitest version, not assumed — and both paths call it. Nothing
is ever terminated by name: no pattern-based process killing, so a test can
never reach a server it did not start.

## Checks

```bash
npm run lint         # eslint (flat config, typescript-eslint + react-hooks + boundaries)
npm run typecheck    # tsc strict per workspace (apps run `next typegen` first)
npm run test         # boundaries + domain/db unit tests + API integration tests
npm run build        # production build of all four apps
npm run test:e2e     # Playwright: login → board → check-in → audit (needs migrate+seed)
```

API tests run against a real PostgreSQL schema: they **drop and recreate**
the database in `TEST_DATABASE_URL`. Two independent guards protect real
data: the fixtures check the URL, and the reset helpers themselves ask the
live connection (`SELECT current_database()`) and refuse unless the actual
database name ends exactly in `_test`.
GitHub Actions (`.github/workflows/ci.yml`) runs all of the above against
PostgreSQL 16 on every pull request.

## Conventions

- Money: integer baisa + `formatOmr()`. Never float.
- Time: store `timestamptz` (UTC); "a day" means the Muscat calendar day —
  `muscatDayUtcRange()` is the only place that math lives.
- Migrations: plain SQL in `packages/db/migrations`, forward-only,
  advisory-locked runner (`npm run db:migrate`). Rollback = new forward
  migration. Works against any PostgreSQL, including Supabase.
- Statuses/roles are `text` + CHECK constraints, evolved by migration.
- Secrets: env vars only (`.env*` are gitignored); see `.env.example`.

## Next slices

2. Customer online booking (availability, create/reschedule/cancel).
3. Admin console: branches, employees & roles, services & pricing.
4. Reporting + audit trail UI; notifications (SMS/WhatsApp); i18n (ar).

## Locked requirements for future slices (NOT implemented yet)

None of the following exists in this codebase today. They are locked as
prerequisites and must not be faked or shortcut:

- **Transactional outbox + background worker** — required before the
  system sends anything external (SMS/WhatsApp/email). No direct sends
  from request handlers.
- **Double-entry ledger** — required before ANY payment feature. No
  payment capture and **no refunds before the ledger exists**; refunds are
  ledger entries, not row updates.
- **Object storage** — required before any file/photo attachments
  (documents, receipts). No files in the database or on app disks.
- **Offline strategy for the Branch App** — required before branch
  operations may depend on it during connectivity loss.
- **Customer realm auth** — separate cookie, principal table and session
  store from the workforce realm; never shared.
