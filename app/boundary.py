"""Business date derivation and boundary policy resolution (§4, §5).

D-05: operating hours run 07:00 -> 04:00 the next calendar day, and the
accounting day boundary is 06:00. So the accounting day D spans
[06:00 on D, 06:00 on D+1) in the branch's local timezone, and the 00:00-04:00
tail of a shift still belongs to the previous business date.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.errors import (
    BoundaryPolicyInvariantViolated,
    BoundaryPolicyUnresolved,
    UnknownBranch,
)


@dataclass(frozen=True)
class BoundaryPolicy:
    boundary_policy_id: str
    day_boundary_time: time
    operating_open: time
    operating_close: time
    effective_from: date
    effective_until: date | None


@dataclass(frozen=True)
class Branch:
    branch_id: str
    code: str
    tz: str


@dataclass(frozen=True)
class ResolvedDay:
    branch: Branch
    policy: BoundaryPolicy
    business_date: date
    local_now: datetime


def business_date_for(local_now: datetime, day_boundary_time: time) -> date:
    """Accounting date of ``local_now`` under a boundary of ``day_boundary_time``.

    Subtracting the boundary offset maps [boundary, boundary+24h) onto a whole
    calendar day, so the date of the shifted instant is the business date.
    With a 06:00 boundary, 05:59 belongs to the previous date and 06:00 to the
    current one.
    """
    offset = timedelta(
        hours=day_boundary_time.hour,
        minutes=day_boundary_time.minute,
        seconds=day_boundary_time.second,
        microseconds=day_boundary_time.microsecond,
    )
    return (local_now - offset).date()


def load_branch(cur, tenant_id: str, branch_code: str) -> Branch:
    cur.execute(
        """
        SELECT branch_id::text, code, tz
          FROM app.branch
         WHERE tenant_id = %s AND code = %s
        """,
        (tenant_id, branch_code),
    )
    row = cur.fetchone()
    if row is None:
        raise UnknownBranch("no such branch in this tenant", branch_code=branch_code)
    return Branch(branch_id=row[0], code=row[1], tz=row[2])


def _policy_effective_on(cur, tenant_id: str, branch_id: str, on_date: date) -> BoundaryPolicy:
    """The single policy covering ``on_date``, or a §5 error.

    LIMIT 2 is deliberate: one row is the happy path, two rows is enough to
    prove the exclusion constraint has been violated, and there is no reason to
    fetch more than the proof requires.
    """
    cur.execute(
        """
        SELECT boundary_policy_id::text, day_boundary_time, operating_open,
               operating_close, effective_from, effective_until
          FROM app.boundary_policy
         WHERE tenant_id = %s
           AND branch_id = %s
           AND daterange(effective_from, effective_until, '[)') @> %s::date
         ORDER BY effective_from
         LIMIT 2
        """,
        (tenant_id, branch_id, on_date),
    )
    rows = cur.fetchall()

    if not rows:
        raise BoundaryPolicyUnresolved(
            "no boundary policy is in effect for this branch on this date",
            branch_id=branch_id,
            on_date=on_date.isoformat(),
        )
    if len(rows) > 1:
        # The EXCLUDE constraint in migration 0003 makes this impossible. If it
        # happens the constraint is gone, so we refuse the request rather than
        # picking a winner and writing under an arbitrary boundary.
        raise BoundaryPolicyInvariantViolated(
            "more than one boundary policy is in effect despite the exclusion constraint",
            branch_id=branch_id,
            on_date=on_date.isoformat(),
            matched=[r[0] for r in rows],
        )

    r = rows[0]
    return BoundaryPolicy(
        boundary_policy_id=r[0],
        day_boundary_time=r[1],
        operating_open=r[2],
        operating_close=r[3],
        effective_from=r[4],
        effective_until=r[5],
    )


def resolve_day(cur, *, tenant_id: str, branch_code: str, now_utc: datetime) -> ResolvedDay:
    """Resolve (branch, policy, business_date) for an instant.

    Chicken-and-egg: the business date needs the policy's boundary time, but the
    policy is selected by date. Resolved by fixed point over at most two passes.

    Pass 1 looks up the policy effective on the local *calendar* date and derives
    a business date from it. If they agree, that policy governs its own date and
    we are done. If the boundary pushed the business date back a day, pass 2
    re-resolves on that business date; if the second policy derives the same
    business date, it too governs its own date and we are done.

    Only a boundary change landing exactly on the seam can make both passes
    disagree, and there is no non-arbitrary answer in that case, so it is
    reported as unresolved rather than guessed at.
    """
    branch = load_branch(cur, tenant_id, branch_code)
    local_now = now_utc.astimezone(ZoneInfo(branch.tz))

    calendar_date = local_now.date()
    policy = _policy_effective_on(cur, tenant_id, branch.branch_id, calendar_date)
    bdate = business_date_for(local_now, policy.day_boundary_time)

    if bdate != calendar_date:
        policy = _policy_effective_on(cur, tenant_id, branch.branch_id, bdate)
        if business_date_for(local_now, policy.day_boundary_time) != bdate:
            raise BoundaryPolicyUnresolved(
                "boundary policy change lands on the day seam; the business date "
                "for this instant is ambiguous",
                branch_id=branch.branch_id,
                calendar_date=calendar_date.isoformat(),
                candidate_business_date=bdate.isoformat(),
            )

    return ResolvedDay(
        branch=branch, policy=policy, business_date=bdate, local_now=local_now
    )
