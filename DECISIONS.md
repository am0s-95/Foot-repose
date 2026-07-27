# Decisions

Decisions that constrain the code. Each one records what was decided, why, and
what would have to change to revisit it.

---

## D-05 — Operating hours and the accounting day boundary — **RESOLVED**

**Decision.** Operating hours run **07:00 → 04:00** the following calendar day.
The **accounting day boundary is 06:00**.

Accounting day `D` therefore spans `[06:00 on D, 06:00 on D+1)` in the branch's
local timezone. The operating window sits inside it at `+1h .. +22h` from the
boundary, which leaves a two-hour settlement gap (04:00–06:00) before the day
rolls.

**Consequences.**

* A shift recorded at 03:00 belongs to the **previous** business date. This is
  the whole point of a boundary later than midnight: the tail of a night shift
  must not land on the next day's books.
* `business_date = (local_timestamp - 06:00)::date`. Implemented once, in
  `app.boundary.business_date_for`, and used everywhere.
* The window/boundary relationship is enforced in the schema, not in code:
  `boundary_policy_window_inside_accounting_day` rejects any policy whose
  operating window straddles its own boundary.
* Both values live on `app.boundary_policy` per tenant/branch and are copied
  onto each `app.operational_day` row when the day is opened, so a day stays
  stamped with the rules it was opened under even after the policy changes.

**Revisiting it** means a new `boundary_policy` row with a later
`effective_from`, not an edit. The exclusion constraint makes the new row and
the old one non-overlapping by construction (see D-04).

---

## D-01 — Idempotency claim: insert-then-select, not upsert

**Decision.** Rows in `app.idempotency_record` and `app.operational_day` are
claimed with

```sql
INSERT ... ON CONFLICT DO NOTHING RETURNING ...
-- if no row came back, a separate later statement:
SELECT ...
```

inside a **READ COMMITTED** transaction.

**Rejected alternatives.**

* `ON CONFLICT DO UPDATE SET col = col` — the no-op update. It writes a new
  tuple version and takes a row lock on every conflicting request, so pure
  replays cause write amplification and bloat, and concurrent replays of one key
  serialise into an update queue. It buys only the convenience of always getting
  a `RETURNING` row.
* `xmax = 0` to distinguish insert from conflict. Undocumented heap internals,
  and it reads 0 in situations unrelated to the statement that produced it.

**What makes the follow-up SELECT sound.** Two things, and both are enforced
rather than assumed:

1. **READ COMMITTED.** Each statement takes a fresh snapshot, so the SELECT sees
   the row the winner committed while our INSERT was blocked on it. Under
   REPEATABLE READ the SELECT would reuse the transaction's original snapshot,
   find nothing, and the algorithm would be quietly wrong. Asserted at runtime
   by `app.rowclaim.assert_read_committed`.
2. **`DELETE` is revoked from `app_runtime`** on both claimed tables
   (migration `0004`). No application transaction can remove the conflicting row
   between the two statements, so "conflict reported but SELECT found nothing"
   is unreachable rather than merely improbable. It is reported as
   `ROW_CLAIM_INVARIANT_VIOLATED` if it ever happens, and the grant itself is
   asserted from the catalog in `tests/test_privileges.py`.

**Cost accepted.** The idempotency claim is the *last* statement in the handler,
so a request that loses the race has already done its work and must throw it
away. That is one wasted unit of work per same-key collision, which only happens
during a genuine retry storm. The alternative — claiming first and filling in
the response later — would need `UPDATE` on the record and reintroduce a mutable
in-flight state, which D-03 rules out.

---

## D-02 — Idempotency is fingerprinted over logical fields

**Decision.** `request_fingerprint` is `sha256` over the canonical serialisation
of the request's **normalised logical fields**, never over the raw body.
`fingerprint_fields` stores those normalised fields so a mismatch can be
explained without retaining client bytes.

Normalisation (`app.canonical`): NFC unicode, trimmed strings, integers as
integers (`bool` rejected), dates as ISO-8601, keys sorted, unknown keys
rejected rather than ignored.

**Consequences.**

* Reordered JSON keys, differing whitespace and differing unicode composition
  all replay against each other.
* `expected_business_date` is a logical field. A client that **recomputes** it
  after crossing 06:00 and retries with the same key is making a different
  request, and gets `409 IDEMPOTENCY_KEY_REUSED` — it is not a replay. A client
  that retries with the values it originally sent gets its stored response back,
  regardless of how much time has passed or how many boundaries were crossed.
* Rejecting unknown keys is deliberate: silently dropping a field the client
  believed was meaningful would let two different requests share a fingerprint.

---

## D-03 — No `IN_PROGRESS` state

**Decision.** `app.idempotency_record` has no lifecycle column. A record is
inserted **complete**, in the same transaction as the effect it describes.

**Consequences.**

* An `IN_PROGRESS` record can never become committed-visible, because there is
  no such record. Either the effect and its record both commit, or neither does.
* **No recovery logic may assume a stale in-flight record exists.** There is
  nothing to sweep, expire or reconcile. A request that dies mid-flight leaves
  the key completely unused, so the client's retry does the work rather than
  replaying a phantom.
* `UPDATE` is revoked from `app_runtime` on the table, so the state cannot be
  reintroduced by accident at runtime.
* Enforced by `tests/test_no_in_progress_state.py`: no lifecycle column, no
  enum label, no occurrence of the identifier in executable code (prose about
  the decision is fine), plus fault injection between the write and the commit
  and a concurrent reader that must never observe the uncommitted row.

**Cost accepted.** Two concurrent requests with the same key both do the work;
one of them throws it away (D-01). A claim-first design would avoid that at the
price of exactly the in-flight state this decision removes.

---

## D-04 — One effective boundary policy, enforced by the database

**Decision.** Overlap is prevented by an exclusion constraint, not by
application checks:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

CHECK (effective_until IS NULL OR effective_until > effective_from)

EXCLUDE USING gist (
  tenant_id WITH =,
  branch_id WITH =,
  daterange(effective_from, effective_until, '[)') WITH &&
)
```

* `effective_until IS NULL` means an **unbounded upper bound**:
  `daterange(from, NULL, '[)')` is `[from,)`, which overlaps everything after
  `from`. An open-ended policy owns the rest of time until someone closes it.
* `[)` bounds make adjacent periods legal: `[Jan, Jun)` and `[Jun, Sep)` do not
  overlap, so a clean handover needs no gap.
* `branch_id` is `NOT NULL`. A nullable branch would silently escape the
  `WITH =` comparison (`NULL = NULL` is not true), leaving a hole in the
  constraint. Tenant-wide defaults, if ever wanted, must be modelled explicitly
  rather than as a NULL branch.

**Resolution failures** (`app.boundary`, §5):

| situation | response | rationale |
|---|---|---|
| no policy in effect | `409 BOUNDARY_POLICY_UNRESOLVED` | the caller's branch is not configured for this date; nothing the server can fix |
| more than one in effect | `500 BOUNDARY_POLICY_INVARIANT_VIOLATED` | the constraint above is gone; a server fault, and picking a winner would write under an arbitrary boundary |

Both roll the whole request back. Nothing is committed.

**The seam case.** The business date needs a policy, and the policy is selected
by date. Resolved by a two-pass fixed point: resolve on the local calendar date,
derive a business date, and if it differs, re-resolve on that business date and
require agreement. Only a boundary change landing exactly on the seam can make
both passes disagree, and there is no non-arbitrary answer then, so it is
reported as `BOUNDARY_POLICY_UNRESOLVED` rather than guessed at.

---

## D-06 — `request_id` is server-minted; `client_correlation_id` is inert

**Decision.** Every HTTP request gets a `request_id` generated by the server
(`app.api.request_id_middleware`). No inbound header can supply or influence it.
`client_correlation_id` is optional, validated for length and alphabet, echoed
back, recorded in logs, and used for nothing else.

**Consequences.**

* `client_correlation_id` is **not** an authorization input and **not** part of
  the idempotency key or the fingerprint. Two requests differing only by
  correlation id are the same request.
* A replay carries a **new** `request_id` in its log line and its
  `X-Request-Id` header — the replay really is a distinct HTTP request and the
  trace should say so — while writing **no** new audit or outbox row. The
  response body deliberately contains no request-scoped field, so a stored
  response can be served verbatim.

---

## D-07 — `app_runtime` cannot reach auth storage

**Decision.** The application role has **no `USAGE` on the `auth` schema at
all**, and therefore no table-level read on `auth_identity` or `auth_session`.
Its entire view of authentication is one `SECURITY DEFINER` function,
`auth_api.resolve_session(bytea) -> (user_id, tenant_id)`.

**Consequences.**

* There is no query shape that enumerates identities or sessions. The only input
  is a token hash the caller must already possess, at most one row comes back,
  and it carries nothing beyond the user and tenant.
* Expired, revoked, disabled and never-existed are one indistinguishable
  outcome.
* Bearer tokens never reach the database; only their `sha256` does.
* Session issuance and revocation are **absent** from the surface. They belong
  to `auth_owner`, out of `app_runtime`'s reach, so a compromised runtime role
  cannot mint or extend a session.
* `app.app_user` is reachable only through RLS: your own row, or an explicit
  **admin** membership in that row's tenant. A plain member of tenant A cannot
  list tenant A's users. The membership check is `app.is_tenant_admin`, itself
  `SECURITY DEFINER` — a policy on `app.membership` that queries
  `app.membership` re-enters its own policy and PostgreSQL rejects it outright.
* Unset tenant context yields **no rows**, not all rows. Every policy predicate
  goes `NULL` and filters everything out.

**Status: satisfied, not deferred.** This was the one item flagged as a
`PRODUCTION_BLOCKER` if it could not be met. It is met, and asserted from the
catalog and against the live role in `tests/test_auth_isolation.py` and
`tests/test_privileges.py`, so a future migration that reopens the schema fails
the suite rather than shipping.

---

## D-08 — Tests run against a real PostgreSQL

**Decision.** No database fakes. The properties under test — `ON CONFLICT`
semantics under concurrency, exclusion constraints, RLS, revoked privileges —
exist only in PostgreSQL and a fake would assert nothing.

Race tests use three connections: two contenders and an observer that reads
`pg_stat_activity`. Nothing sleeps for a fixed period and then assumes an
outcome; every wait is a wait *for an observed server-side state*, with a
timeout that fails the test rather than passing it. See `docs/GATES.md`.
