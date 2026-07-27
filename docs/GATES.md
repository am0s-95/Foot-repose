# Gates

A *gate* is a property that must hold before this service can be trusted in
production. Each one names the invariant, where it is enforced, and the test
that would fail if it regressed.

Gates 8 and 10 are the concurrency gates: both run the deterministic
two-connection race described below, and both are exercised for **20 further
isolated cycles** on top of their base case.

| # | Gate | Enforced in | Test |
|---|---|---|---|
| 1 | Row claim is insert-then-select, never a no-op upsert or `xmax` | `app/rowclaim.py` | `test_gate_08_*`, `test_gate_10_*` |
| 2 | `DELETE` revoked from `app_runtime` on claimed tables | `db/migrations/0004` | `test_privileges.py` |
| 3 | Idempotency fingerprint is over logical fields, not raw body | `app/canonical.py` | `test_replay_across_boundary.py` |
| 4 | Crossing 06:00 does not invalidate a replay | `app/service.py` | `test_replay_after_boundary_returns_stored_response` |
| 5 | Recomputed `expected_business_date` is key reuse, not replay | `app/canonical.py` | `test_recomputed_expected_business_date_is_key_reuse` |
| 6 | At most one effective boundary policy | `db/migrations/0003` (EXCLUDE) | `test_boundary_policy_exclusion.py` |
| 7 | Unresolved / multiple policy both roll back fully | `app/boundary.py`, `app/db.py` | `test_boundary_policy_resolution.py` |
| **8** | **Concurrent claim of `idempotency_record`** | `app/rowclaim.py` | `test_gate_08_idempotency_race.py` |
| 9 | `request_id` is server-minted; correlation id is inert | `app/api.py` | `test_request_identity.py` |
| **10** | **Concurrent claim of `operational_day`** | `app/rowclaim.py` | `test_gate_10_operational_day_race.py` |
| 11 | No `IN_PROGRESS` state, and none survives a fault | `db/migrations/0003`, `app/service.py` | `test_no_in_progress_state.py` |
| 12 | `app_runtime` cannot enumerate identities, sessions or users | `db/migrations/0002`, `0004` | `test_auth_isolation.py` |

---

## The race protocol (gates 8 and 10)

Three connections. Nothing sleeps for a fixed duration and then assumes an
outcome — every wait is a wait *for an observed server-side state*, with a
timeout that fails the test rather than passing it.

```
T1 (connection 1)          T2 (connection 2)            Observer (connection 3)
──────────────────         ──────────────────           ──────────────────────
BEGIN
INSERT <row>
  (no COMMIT)
                           BEGIN
                           ── barrier: before_claim ──▶  (test is signalled)
                           INSERT ... ON CONFLICT
                             DO NOTHING RETURNING
                           ▓ blocked on T1's tuple ▓
                                                        poll pg_stat_activity
                                                        until wait_event_type
                                                        = 'Lock'
                                                        ── proof T2 has not
                                                           completed ──▶
COMMIT  ◀── barrier released
                           INSERT returns NO ROW
                           ── barrier: after_conflict ──▶
                           SELECT  (separate statement,
                             fresh READ COMMITTED
                             snapshot)
                           ── finds T1's committed row ──▶
                           COMMIT
```

**Asserted afterwards**

* `claim.inserted is False` — the `INSERT` genuinely returned no row.
* the `after_conflict` hook fired — the conflict branch was actually taken.
* the follow-up `SELECT` returned **T1's** committed values, not T2's discarded
  ones.
* exactly one row exists for the key, and its `*_by_request_id` is T1's.

**The barrier** is `app/hooks.py`. Both hook methods return `None` and neither
is consulted for control flow, so the instrumentation cannot change behaviour;
production passes `NULL_HOOKS`.

**Isolation per cycle.** Every cycle calls `seed_tenant`, which creates a fresh
tenant, branch, policy and users, and every cycle uses a freshly generated
idempotency key and (for gate 10) its own business date. No cycle can observe
another cycle's rows, so a pass is not an artefact of ordering.

**Why READ COMMITTED.** The follow-up `SELECT` must take a *new* snapshot to see
what T1 committed while T2 was blocked. Under REPEATABLE READ it would reuse the
transaction's original snapshot, find nothing, and the algorithm would be
silently wrong. `app/rowclaim.py` asserts the level at runtime rather than
trusting configuration.

---

## Running them

```bash
python -m db.migrate --reset          # requires a superuser DSN
python -m pytest                      # whole suite
python -m pytest -m race              # just the concurrency gates
python -m pytest tests/test_gate_08_idempotency_race.py tests/test_gate_10_operational_day_race.py
```

The two gate files together contribute 42 test cases: one base case and 20
repeat cycles each.
