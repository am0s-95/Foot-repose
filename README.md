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
# *_dev/_development/_local, and refuses to run without SEED_CONFIRM=wipe.

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

## Checks

```bash
npm run lint         # eslint (flat config, typescript-eslint + react-hooks + boundaries)
npm run typecheck    # tsc strict per workspace (apps run `next typegen` first)
npm run test         # boundaries + domain/db unit tests + API integration tests
npm run build        # production build of all four apps
npm run test:e2e     # Playwright: login → board → check-in → audit (needs migrate+seed)
```

API tests run against a real PostgreSQL schema: they **drop and recreate**
the database in `TEST_DATABASE_URL` (must end in `_test`; guard enforced).
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
