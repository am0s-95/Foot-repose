# Foot-repose

Idempotent write path over a business-day boundary, on PostgreSQL.

Records shift entries against an accounting day whose boundary is **06:00**,
while operating hours run **07:00 → 04:00** the next calendar day (decision
[D-05](DECISIONS.md)). Retries are safe, concurrent duplicates collapse to one
effect, and every invariant that matters is enforced by the database rather
than by convention.

## Layout

```
app/
  api.py         HTTP surface: server-minted request_id, correlation id validation
  service.py     the one transaction that does everything, or nothing
  rowclaim.py    INSERT ... ON CONFLICT DO NOTHING RETURNING, then a later SELECT
  boundary.py    business date derivation and policy resolution
  canonical.py   logical-field normalisation and the request fingerprint
  auth.py        the narrow auth adapter (no direct access to auth storage)
  clock.py       injectable clock, so boundary crossings are testable
  db.py          READ COMMITTED transactions with tenant/user context
  hooks.py       test-only barrier points, no-ops in production
db/migrations/   0001 roles  0002 auth  0003 tables  0004 grants + RLS
docs/GATES.md    the twelve gates and the race protocol
DECISIONS.md     what was decided and why
```

## Design in four lines

* **One transaction per request.** The shift entry, its audit row, its outbox
  row and its idempotency record commit together or not at all. There is no
  in-flight state, so there is nothing to recover (D-03).
* **Claim rows with `INSERT ... ON CONFLICT DO NOTHING RETURNING`**, and on
  conflict re-read in a *separate later statement* under READ COMMITTED. No
  no-op `DO UPDATE`, no `xmax` (D-01).
* **Fingerprint the logical fields, not the bytes.** JSON key order, whitespace
  and unicode composition are irrelevant; `expected_business_date` is not (D-02).
* **Constraints over checks.** One effective boundary policy is an
  `EXCLUDE USING gist`; tenant isolation is RLS; the soundness of the row claim
  is a revoked `DELETE` grant (D-04, D-07).

## API

`POST /v1/shift-entries`

| header | required | notes |
|---|---|---|
| `Authorization: Bearer <token>` | yes | resolved through the auth adapter |
| `Idempotency-Key` | yes | 8–200 chars of `[A-Za-z0-9._:-]` |
| `X-Client-Correlation-Id` | no | echoed and logged; never authorization, never idempotency |

```json
{
  "branch_code": "br-main",
  "staff_ref": "staff-9",
  "minutes": 45,
  "expected_business_date": "2026-03-14",
  "note": "evening shift"
}
```

Responses carry `X-Request-Id` (always server-generated, including on errors)
and, on a replay, `Idempotent-Replay: true`.

| status | code | when |
|---|---|---|
| 201 | — | recorded, or replayed from a stored record |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID` / `CLIENT_CORRELATION_ID_INVALID` / `INVALID_REQUEST` | validation |
| 401 | `UNAUTHENTICATED` | no usable session |
| 404 | `BRANCH_NOT_FOUND` | unknown branch in this tenant |
| 409 | `IDEMPOTENCY_KEY_REUSED` | same key, different logical fields |
| 409 | `BOUNDARY_POLICY_UNRESOLVED` | no policy in effect, or a boundary change on the day seam |
| 500 | `BOUNDARY_POLICY_INVARIANT_VIOLATED` | more than one policy in effect — the exclusion constraint is gone |

Both `BOUNDARY_POLICY_UNRESOLVED` and `BOUNDARY_POLICY_INVARIANT_VIOLATED` roll
the request back completely; nothing is committed.

## Roles

| role | holds |
|---|---|
| `migrator` | owns `app.*`, runs DDL |
| `auth_owner` | owns `auth.*` and the adapter functions |
| `app_runtime` | the only role the service connects as: no DDL, no `BYPASSRLS`, no `DELETE` on claimed tables, no `UPDATE` on idempotency records, no access to the `auth` schema at all |

## Running it

Requires PostgreSQL 16 (for `btree_gist` and `gen_random_uuid`) and Python 3.11.

```bash
python -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/python -m db.migrate --reset     # needs a superuser DSN
.venv/bin/python -m pytest                 # 110 tests
.venv/bin/uvicorn app.api:create_app --factory
```

Configuration is environment driven: `FOOT_REPOSE_RUNTIME_DSN`,
`FOOT_REPOSE_MIGRATION_DSN`.

## Tests

110 tests against a real PostgreSQL — the properties under test (`ON CONFLICT`
semantics under concurrency, exclusion constraints, RLS, revoked privileges)
exist only in the database, so a fake would assert nothing (D-08).

See [docs/GATES.md](docs/GATES.md) for the gate list and the deterministic
three-connection race protocol used by gates 8 and 10.
