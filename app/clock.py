"""Injectable clock (§3).

The boundary crossing test needs to move time across 06:00 deterministically,
so nothing in the request path is allowed to call ``datetime.now()`` directly.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Protocol


class Clock(Protocol):
    def now(self) -> datetime:
        """Current instant, always timezone aware, always UTC."""
        ...


class SystemClock:
    """Production clock."""

    def now(self) -> datetime:
        return datetime.now(timezone.utc)


class FixedClock:
    """Test clock. ``set`` and ``advance`` move it; it never moves on its own."""

    def __init__(self, at: datetime) -> None:
        self.set(at)

    def now(self) -> datetime:
        return self._at

    def set(self, at: datetime) -> None:
        if at.tzinfo is None:
            raise ValueError("FixedClock requires a timezone aware datetime")
        self._at = at.astimezone(timezone.utc)

    def advance(self, **delta: float) -> None:
        from datetime import timedelta

        self.set(self._at + timedelta(**delta))
