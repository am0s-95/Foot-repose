"""Deterministic two-connection race harness (§2).

The shape of every race test in this suite:

  1. T1 (its own connection) inserts the row and holds its transaction open.
  2. T2 (its own connection) reaches the test-only barrier immediately before
     issuing the conflicting INSERT, and is then observed - from a third
     connection, via pg_stat_activity - to be parked on a heavyweight lock. It
     therefore provably has not completed.
  3. The barrier is released by committing T1.
  4. T2 finishes. Its INSERT ... ON CONFLICT DO NOTHING must have returned no
     row, and the separate follow-up SELECT must have found T1's committed row.

Nothing here sleeps for a fixed duration and then assumes an outcome: every
wait is a wait *for an observed server-side state*, with a timeout that fails
the test rather than passing it.
"""

from __future__ import annotations

import threading
from dataclasses import dataclass
from typing import Any, Callable

from app.db import set_request_context
from app.rowclaim import ClaimResult
from tests.conftest import Barrier, runtime_connection, wait_until_lock_blocked


@dataclass
class RaceOutcome:
    claim: ClaimResult
    lock_wait: dict
    barrier_saw_conflict: bool


def run_claim_race(
    observer,
    *,
    label: str,
    tenant_id: str,
    user_id: str,
    t1_insert: Callable[[Any], None],
    t2_claim: Callable[[Any, Barrier], ClaimResult],
    join_timeout: float = 20.0,
) -> RaceOutcome:
    t1 = runtime_connection()
    t2 = runtime_connection()
    barrier = Barrier(label)
    box: dict[str, Any] = {}

    def worker() -> None:
        try:
            with t2.cursor() as cur:
                set_request_context(cur, tenant_id=tenant_id, user_id=user_id)
                box["claim"] = t2_claim(cur, barrier)
            t2.commit()
        except BaseException as exc:  # noqa: BLE001 - re-raised on the main thread
            box["error"] = exc
            t2.rollback()

    try:
        # --- T1: insert, hold the transaction open -------------------------
        with t1.cursor() as cur:
            set_request_context(cur, tenant_id=tenant_id, user_id=user_id)
            t1_insert(cur)
        assert t1.info.transaction_status != 0, "T1 must still be in a transaction"

        # --- T2: start the conflicting insert ------------------------------
        thread = threading.Thread(target=worker, name="race-T2", daemon=True)
        thread.start()

        assert barrier.reached_claim.wait(10), "T2 never reached the claim barrier"

        # Proof that T2 has not completed: the server says it is blocked.
        lock_wait = wait_until_lock_blocked(observer, t2.info.backend_pid)
        assert thread.is_alive(), "T2 finished before the barrier was released"
        assert "claim" not in box, "T2 produced a result before T1 committed"
        assert "error" not in box, f"T2 failed early: {box.get('error')!r}"

        # --- release the barrier -------------------------------------------
        t1.commit()

        thread.join(join_timeout)
        assert not thread.is_alive(), "T2 did not finish after the barrier released"
        if "error" in box:
            raise AssertionError(f"T2 failed: {box['error']!r}") from box["error"]

        claim: ClaimResult = box["claim"]
        assert claim.inserted is False, (
            "T2's INSERT ... ON CONFLICT DO NOTHING must have returned no row"
        )
        return RaceOutcome(
            claim=claim,
            lock_wait=lock_wait,
            barrier_saw_conflict=barrier.reached_conflict.is_set(),
        )
    finally:
        t1.close()
        t2.close()
