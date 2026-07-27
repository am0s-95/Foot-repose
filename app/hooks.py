"""Test-only barrier hook points (§2).

The production object is a no-op. Tests substitute an implementation that
signals when the request thread has reached the moment just before it issues
the conflicting INSERT, so the race test can assert on a *known* state instead
of sleeping and hoping.

These are the only test seams in the request path, and neither one can change
behaviour: both return None and neither is consulted for control flow.
"""

from __future__ import annotations


class ClaimHooks:
    def before_claim(self, label: str) -> None:
        """Reached immediately before the INSERT ... ON CONFLICT statement."""

    def after_conflict(self, label: str) -> None:
        """Reached after the INSERT reported a conflict, before the SELECT."""

    def after_idempotency_insert(self) -> None:
        """Reached with the idempotency record written but not yet committed.

        The fault injection point for §8: raising here proves that nothing -
        least of all a half-written idempotency record - survives the rollback.
        """


NULL_HOOKS = ClaimHooks()
