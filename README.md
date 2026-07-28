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

Workforce authentication (employee realm — kept strictly separate from the
future customer realm):

- Sessions are **server-revocable**: the JWT cookie references a
  `sessions` row; logout revokes it, so a kept/stolen token dies
  immediately. Cookie: `fr_wf_session`, HttpOnly, SameSite=Lax.
- Login is **rate limited** per email+ip: fixed 15-minute window stored in
  PostgreSQL — shared across API instances, survives cold starts, and
  counts concurrent attempts atomically (audited 429s).
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

Eligibility is enforced from **three** ends, because both the evidence and the
claim can move. A statement-level guard rejects an `UPDATE`/`DELETE` of the
eligibility tables that would leave a live claim uncovered; a row-level guard
rejects any live claim — newly inserted, or moved by the reschedule cascade —
whose NEW window falls outside the provider's assignment or qualification; and
the `0005 → 0006` preflight aborts rather than backfilling a live claim that
legacy data cannot justify.

Eligibility is enforced from both ends. Allocation reads the covering
assignment and qualification rows `FOR SHARE` — the rows it returns *are* the
evidence, so a concurrent change cannot slip between the check and the write.
And because a lock only protects the moment of allocation, a statement-level
guard re-examines any `UPDATE`/`DELETE` of `provider_branch_assignments` or
`provider_service_qualifications` against the state it produces: if it would
leave a live claim by a provider who is no longer assigned or qualified, it is
rejected. Transition tables are used deliberately, so a multi-row statement is
judged on the complete post-statement state rather than row by row, and both the
old and the new keys are considered.

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
allocation operation takes the same global lock order (bookings, then employees,
then units, each by ascending id) so a swap cannot deadlock, and swaps carry the
caller's expected allocation sequences **keyed by booking** — a flat list would
release a third booking's claim and would miss an unlisted live one. Two
concurrent swaps produce one winner and one `stale` rejection.

Honest limits recorded in code and tests: temporal effectiveness of the source
offering is proved **at capture time only** — a later reschedule does not
re-prove it, and slice 2B must revalidate or deliberately keep the original
capture as provenance. `allocation_seq` is a deterministic *logical* ordering of
the writes to one booking under its row lock, not wall-clock chronology and not
an ordering across bookings.

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
