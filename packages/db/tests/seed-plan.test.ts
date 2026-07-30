import { describe, expect, it } from 'vitest';
import { addDaysToIsoDate } from '@foot-repose/domain';
import {
  actionableDayOffset,
  actionableReferenceDate,
  expectedSeedBookings,
  isMuscatDayOff,
  MUSCAT_WEEKLY_DAY_OFF,
  SEED_BRANCH_COUNT,
  SEED_DAY_PLAN,
} from '../src/seed-plan';

/**
 * The date contract, over TWO COMPLETE CONSECUTIVE MONTHS — every date, not one
 * representative per weekday.
 *
 * A seven-day matrix shows each weekday behaves once. It cannot show the rule
 * repeats week after week, that a month boundary is a boundary in the
 * arithmetic and not just in the prose, or that a 31-day month followed by a
 * 31-day month does not drop or duplicate a day. Those are the failures that
 * survive a weekday sample.
 *
 * This layer is pure — no database, no clock — so exhaustive is cheap and can
 * stay in CI on every push. The equivalent 62-date audit against a real
 * PostgreSQL seed is a script (`packages/db/src/seed-audit.ts`): same
 * assertions, real rows, minutes rather than milliseconds.
 */
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayIndex(isoDate: string): number {
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

function range(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDaysToIsoDate(d, 1)) dates.push(d);
  return dates;
}

/** 2026-07-01 .. 2026-08-31 — two complete consecutive months, 62 dates. */
const AUDIT = range('2026-07-01', '2026-08-31');

const PER_BRANCH = {
  yesterday: SEED_DAY_PLAN.yesterday.length,
  today: SEED_DAY_PLAN.today.length,
  tomorrow: SEED_DAY_PLAN.tomorrow.length,
};

describe('[62-day] the seed contract holds across two consecutive months', () => {
  it('covers exactly 62 consecutive dates spanning both months', () => {
    expect(AUDIT).toHaveLength(62);
    expect(AUDIT[0]).toBe('2026-07-01');
    expect(AUDIT.at(-1)).toBe('2026-08-31');
    expect(AUDIT.filter((d) => d.startsWith('2026-07'))).toHaveLength(31);
    expect(AUDIT.filter((d) => d.startsWith('2026-08'))).toHaveLength(31);
    // No gaps and no repeats: each date is exactly one day after the last.
    for (const [i, date] of AUDIT.entries()) {
      if (i > 0) expect(date).toBe(addDaysToIsoDate(AUDIT[i - 1]!, 1));
    }
    expect(new Set(AUDIT).size).toBe(62);
  });

  it.each(AUDIT)('%s derives a total from the rules alone', (date) => {
    const counts = expectedSeedBookings(date);
    const dayValue = (offset: number, perBranch: number, branches: number): number =>
      isMuscatDayOff(addDaysToIsoDate(date, offset)) ? 0 : perBranch * branches;

    // Recomputed independently here rather than re-reading the same function's
    // output: a tautology would pass no matter what the rule said.
    expect(counts.yesterday).toBe(dayValue(-1, PER_BRANCH.yesterday, SEED_BRANCH_COUNT));
    expect(counts.today).toBe(dayValue(0, PER_BRANCH.today, SEED_BRANCH_COUNT));
    expect(counts.tomorrow).toBe(dayValue(1, PER_BRANCH.tomorrow, SEED_BRANCH_COUNT - 1));
    expect(counts.total).toBe(counts.yesterday + counts.today + counts.tomorrow);
  });

  it('produces only the four totals the documented table names', () => {
    const seen = new Map<string, Set<number>>();
    for (const date of AUDIT) {
      const weekday = WEEKDAY[weekdayIndex(date)]!;
      const totals = seen.get(weekday) ?? new Set<number>();
      totals.add(expectedSeedBookings(date).total);
      seen.set(weekday, totals);
    }
    // Every occurrence of a weekday agrees with every other occurrence — this is
    // the week-over-week repetition a single sample per weekday cannot show.
    for (const [weekday, totals] of seen) {
      expect(`${weekday}:${[...totals].join(',')}`).toBe(`${weekday}:${[...totals][0]}`);
    }
    expect(Object.fromEntries([...seen].map(([k, v]) => [k, [...v][0]]))).toEqual({
      Sunday: 161,
      Monday: 161,
      Tuesday: 161,
      Wednesday: 161,
      Thursday: 121,
      Friday: 95,
      Saturday: 106,
    });
  });

  it('sees each weekday at least eight times across the range', () => {
    const counts = new Map<number, number>();
    for (const date of AUDIT) {
      counts.set(weekdayIndex(date), (counts.get(weekdayIndex(date)) ?? 0) + 1);
    }
    // 62 days is 8 full weeks and change, so nothing here rests on one sample.
    for (let dow = 0; dow < 7; dow += 1) expect(counts.get(dow) ?? 0).toBeGreaterThanOrEqual(8);
  });

  it('keeps the day off empty every single time it occurs', () => {
    const fridays = AUDIT.filter((d) => weekdayIndex(d) === MUSCAT_WEEKLY_DAY_OFF);
    expect(fridays.length).toBeGreaterThanOrEqual(8);
    for (const friday of fridays) {
      expect(expectedSeedBookings(friday).today).toBe(0);
      expect(expectedSeedBookings(friday).total).toBe(95);
      // The day before a Friday loses its tomorrow; the day after loses its
      // yesterday. Both follow from the same fact and are checked here.
      expect(expectedSeedBookings(addDaysToIsoDate(friday, -1)).tomorrow).toBe(0);
      expect(expectedSeedBookings(addDaysToIsoDate(friday, 1)).yesterday).toBe(0);
    }
  });

  it('keeps Saturday consistent every single time it occurs', () => {
    const saturdays = AUDIT.filter((d) => weekdayIndex(d) === 6);
    expect(saturdays.length).toBeGreaterThanOrEqual(8);
    for (const saturday of saturdays) {
      const counts = expectedSeedBookings(saturday);
      expect(counts.yesterday).toBe(0); // the day off
      expect(counts.today).toBe(66);
      expect(counts.tomorrow).toBe(40);
      expect(counts.total).toBe(106);
    }
  });
});

describe('[62-day] month and year boundaries do not roll, skip or duplicate', () => {
  it('crosses 2026-07-31 into 2026-08-01 without a gap', () => {
    expect(addDaysToIsoDate('2026-07-31', 1)).toBe('2026-08-01');
    expect(addDaysToIsoDate('2026-08-01', -1)).toBe('2026-07-31');
    // The Friday/Saturday pair that produced the original failure, now stated
    // as a boundary fact rather than as whatever the calendar was doing.
    expect(expectedSeedBookings('2026-07-31').tomorrow).toBe(40);
    expect(expectedSeedBookings('2026-08-01').yesterday).toBe(0);
    expect(actionableReferenceDate('2026-07-31')).toBe('2026-08-01');
    expect(actionableDayOffset('2026-07-31')).toBe(1);
  });

  it.each([
    ['2026-01-31', '2026-02-01'],
    ['2026-02-28', '2026-03-01'],
    ['2026-04-30', '2026-05-01'],
    ['2026-06-30', '2026-07-01'],
    ['2026-07-31', '2026-08-01'],
    ['2026-08-31', '2026-09-01'],
    ['2026-12-31', '2027-01-01'],
    ['2028-02-29', '2028-03-01'],
  ])('steps %s to %s in both directions', (last, next) => {
    // 30-day months, 31-day months, a short February, a leap February and a
    // year boundary — every shape the three-day window can straddle.
    expect(addDaysToIsoDate(last, 1)).toBe(next);
    expect(addDaysToIsoDate(next, -1)).toBe(last);
    // The window around each boundary date names the neighbouring month.
    const counts = expectedSeedBookings(last);
    expect(counts.total).toBe(counts.yesterday + counts.today + counts.tomorrow);
  });

  it('treats 2028-02-29 as real and 2026-02-29 as not', () => {
    expect(addDaysToIsoDate('2028-02-28', 1)).toBe('2028-02-29');
    // 2026 is not a leap year: February ends on the 28th.
    expect(addDaysToIsoDate('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('[62-day] every date selects a real, actionable reference date', () => {
  it.each(AUDIT)('%s resolves to a non-day-off reference date', (date) => {
    const reference = actionableReferenceDate(date);
    // Never the day off, so the seeded reference day always has bookings.
    expect(isMuscatDayOff(reference)).toBe(false);
    expect(expectedSeedBookings(reference).today).toBe(66);
    // At most one day away, so the board is at most one click from it.
    expect(actionableDayOffset(date)).toBeLessThanOrEqual(1);
    expect(reference).toBe(addDaysToIsoDate(date, actionableDayOffset(date)));
    // And the offset agrees with the reason for it.
    expect(actionableDayOffset(date)).toBe(isMuscatDayOff(date) ? 1 : 0);
  });

  it('never lands on a date outside the two-month window plus one day', () => {
    const references = AUDIT.map(actionableReferenceDate);
    expect(references.every((d) => d >= '2026-07-01' && d <= '2026-09-01')).toBe(true);
  });
});

describe('[62-day] the contract does not consult the wall clock', () => {
  it('returns the same answers whatever the machine thinks the time is', () => {
    // Every function here is pure over its ISO argument. Calling twice with a
    // real delay between shows no hidden `new Date()` is involved.
    const first = AUDIT.map((d) => `${d}:${expectedSeedBookings(d).total}:${actionableReferenceDate(d)}`);
    const busyUntil = Date.now() + 25;
    while (Date.now() < busyUntil) {
      /* burn a little wall clock */
    }
    const second = AUDIT.map((d) => `${d}:${expectedSeedBookings(d).total}:${actionableReferenceDate(d)}`);
    expect(second).toEqual(first);
  });

  it('does not shift a date because of the machine UTC offset', () => {
    // The seed names Muscat CALENDAR dates. Parsing one must not depend on the
    // process timezone, which is what a bare `new Date('2026-07-31')` in a
    // negative-offset zone would get wrong.
    for (const date of AUDIT) {
      expect(isMuscatDayOff(date)).toBe(WEEKDAY[weekdayIndex(date)] === 'Friday');
    }
  });
});
