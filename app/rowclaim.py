"""The insert-or-select row claim (§1).

    INSERT ... ON CONFLICT DO NOTHING RETURNING ...
    -- if that returned no row:
    SELECT ...          <- a separate, later SQL statement

Why this shape and not the alternatives:

* ``ON CONFLICT DO UPDATE SET col = col`` (the "no-op update" trick) is not used.
  It takes a row lock and writes a new tuple version on every conflicting
  request, turning pure replays into write amplification and bloat, and it
  turns concurrent replays of the same key into a serialised update queue.

* ``xmax = 0`` is not used to tell insert from conflict. It is an
  implementation detail of the heap, it is not part of any documented contract,
  and it reads as 0 for reasons unrelated to this statement.

Instead: the RETURNING clause is authoritative. A row means we inserted it. No
row means somebody else holds the key. In that case the conflicting transaction
may still have been in flight when our INSERT ran - the INSERT blocked on its
uncommitted tuple and was released when it committed - so we re-read in a
*separate statement*. Under READ COMMITTED each statement takes a fresh
snapshot, so that SELECT sees the winner's committed row. Under REPEATABLE READ
it would not, which is why the isolation level is asserted rather than assumed.

The follow-up SELECT cannot come back empty: DELETE is revoked from app_runtime
on every table claimed this way (migration 0004), so no application transaction
can remove the conflicting row between the two statements. An empty result
therefore means that grant has regressed, and is reported as an invariant
breach rather than retried.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Sequence

from app.errors import IsolationLevelInvariantViolated, RowClaimInvariantViolated
from app.hooks import NULL_HOOKS, ClaimHooks

#: Tables claimed with this algorithm. Each one must have DELETE revoked from
#: app_runtime; ``tests/test_privileges.py`` enforces that from the catalog.
CLAIMED_TABLES = ("app.idempotency_record", "app.operational_day")


@dataclass(frozen=True)
class ClaimResult:
    row: Any
    #: True when this transaction inserted the row, False when it lost the race
    #: and read back the winner's committed row.
    inserted: bool


def assert_read_committed(cur) -> None:
    cur.execute("SHOW transaction_isolation")
    level = cur.fetchone()[0]
    if level != "read committed":
        raise IsolationLevelInvariantViolated(
            "row claim requires READ COMMITTED", observed=level
        )


def claim_row(
    cur,
    *,
    label: str,
    insert_sql: str,
    insert_params: Sequence[Any],
    select_sql: str,
    select_params: Sequence[Any],
    hooks: ClaimHooks = NULL_HOOKS,
) -> ClaimResult:
    """Insert the row, or read back whichever row won the race."""
    hooks.before_claim(label)

    cur.execute(insert_sql, insert_params)
    row = cur.fetchone()
    if row is not None:
        return ClaimResult(row=row, inserted=True)

    hooks.after_conflict(label)

    # Separate statement, hence a fresh READ COMMITTED snapshot.
    cur.execute(select_sql, select_params)
    row = cur.fetchone()
    if row is None:
        raise RowClaimInvariantViolated(
            "conflicting row disappeared between INSERT and SELECT; "
            "DELETE must be revoked from app_runtime on this table",
            table=label,
        )
    return ClaimResult(row=row, inserted=False)
