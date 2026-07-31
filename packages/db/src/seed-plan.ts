import { addDaysToIsoDate } from '@foot-repose/domain';

/**
 * What the development seed produces, as a stated rule rather than as whatever
 * yesterday's run happened to yield.
 *
 * The seed builds three Muscat days around a reference date, and how many
 * bookings fit is a FUNCTION of that date's weekday. Nothing about that was
 * written down, so the tests asserted `> 100` and "Al Khuwair has something to
 * check in today" — both true on most days and both false on some. Measured on
 * the unmodified seed, one reference date at a time:
 *
 *   | reference weekday | bookings |
 *   | ----------------- | -------- |
 *   | Sunday–Wednesday  |      161 |
 *   | Thursday          |      121 |
 *   | Friday            |       95 |
 *   | Saturday          |      106 |
 *
 * That spread is not noise, and the fix is not a smaller threshold. It follows
 * from two deliberate facts in the seed:
 *
 *   * FRIDAY IS THE WEEKLY DAY OFF. Every roster omits Friday, so no provider is
 *     present at their home branch and a Friday reference date seeds ZERO
 *     bookings company-wide — not "fewer". A Friday appearing as the reference
 *     day, as yesterday, or as tomorrow removes that day's whole contribution.
 *   * ONE BRANCH IS CLOSED TOMORROW. The seed writes a closure override for the
 *     first branch (Al Khuwair) on the day after the reference date, so tomorrow
 *     contributes ten branches, not eleven.
 *
 * Encoding the rule here means a change in seed behaviour fails a test that says
 * what changed, instead of moving a number until it passes.
 */

/** Asia/Muscat weekday index used by the schema: 0 = Sunday … 6 = Saturday. */
export const MUSCAT_WEEKLY_DAY_OFF = 5; // Friday

/**
 * The provider rosters the seed writes, and the reason the day off is a fact
 * rather than a claim.
 *
 * These used to live inside `seed.ts`, which meant this module could assert
 * "Friday is the weekly day off" while an independent edit over there quietly
 * added it back. One definition, consumed by the production seed and by the
 * tests that reason about it.
 *
 * `days` are schema weekday indexes (0 = Sunday). Neither roster contains
 * MUSCAT_WEEKLY_DAY_OFF, and a test asserts that rather than trusting the
 * comment. (One deliberate exception exists in `seed.ts`: three "floater" staff
 * get a cross-branch shift on the day off. It never produces a booking, because
 * placement only considers staff whose HOME branch is the one being filled.)
 */
export const SEED_ROSTERS = [
  { days: [0, 1, 2, 3, 4], open: 600, close: 1080, breakOpen: 780, breakClose: 810 },
  { days: [6, 0, 1, 2, 3], open: 840, close: 1320, breakOpen: 1020, breakClose: 1050 },
] as const;

export const SEED_BRANCH_COUNT = 11;
export const SEED_EMPLOYEE_COUNT = 160;

/**
 * The statuses the seed attempts per branch, per day. Order is not significant;
 * the COUNT and the composition are, because they decide both the totals below
 * and which day has anything a manager can act on.
 */
export const SEED_DAY_PLAN = {
  yesterday: ['completed', 'completed', 'completed', 'no_show', 'cancelled'],
  today: ['completed', 'completed', 'in_service', 'checked_in', 'confirmed', 'confirmed'],
  tomorrow: ['confirmed', 'confirmed', 'confirmed', 'confirmed'],
} as const;

/** Index of the branch the seed closes on the day AFTER the reference date. */
export const SEED_CLOSED_TOMORROW_BRANCH_INDEX = 0;
/** ...which is this one. The Playwright manager belongs to it, which is exactly
 * why "just look at tomorrow" is not an escape from a bookingless Friday. */
export const SEED_CLOSED_TOMORROW_BRANCH_CODE = 'KHW';

function weekdayOf(isoDate: string): number {
  // Parsed as UTC midnight, which is what `getUTCDay` wants; the Muscat
  // calendar date is already the thing being named, so no offset is applied.
  return new Date(`${isoDate}T00:00:00Z`).getUTCDay();
}

export function isMuscatDayOff(isoDate: string): boolean {
  return weekdayOf(isoDate) === MUSCAT_WEEKLY_DAY_OFF;
}

export interface SeedBookingCounts {
  yesterday: number;
  today: number;
  tomorrow: number;
  total: number;
}

/**
 * How many bookings the seed will place for a given reference date — derived
 * from the rules above, never hard-coded per date.
 */
export function expectedSeedBookings(referenceDate: string): SeedBookingCounts {
  const day = (offset: number, perBranch: number, branches: number): number =>
    isMuscatDayOff(addDaysToIsoDate(referenceDate, offset)) ? 0 : perBranch * branches;

  const yesterday = day(-1, SEED_DAY_PLAN.yesterday.length, SEED_BRANCH_COUNT);
  const today = day(0, SEED_DAY_PLAN.today.length, SEED_BRANCH_COUNT);
  // One branch is closed on the day after the reference date.
  const tomorrow = day(1, SEED_DAY_PLAN.tomorrow.length, SEED_BRANCH_COUNT - 1);

  return { yesterday, today, tomorrow, total: yesterday + today + tomorrow };
}

/**
 * The reference date to seed when a test needs a day it can ACT on.
 *
 * The board opens on the API's own today, so the seeded reference date has to
 * stay within a day of it or the test would be clicking through a calendar. A
 * Friday reference date seeds nothing at all, so it steps to Saturday; every
 * other day is already actionable and is used as-is.
 */
export function actionableReferenceDate(today: string): string {
  return isMuscatDayOff(today) ? addDaysToIsoDate(today, 1) : today;
}

/**
 * How many days forward the board must be moved from `today` to reach the day
 * the seed made actionable — 0 on an ordinary day, 1 when today is the day off.
 */
export function actionableDayOffset(today: string): number {
  return isMuscatDayOff(today) ? 1 : 0;
}

/**
 * A reference date a LIVE database will still accept, safely in the future.
 *
 * This exists because the first fix for the calendar problem contained the
 * calendar problem. The permanent PostgreSQL tests pinned real dates —
 * 2026-07-30, 2026-08-05 and so on — which were seedable the day they were
 * written and become forbidden as the Muscat calendar advances past them:
 * migration 0005 refuses a branch-hours override for a past date, and the seed
 * writes one for `reference + 1`. Those tests would have gone red on their own,
 * with no code change, which is exactly the defect this branch exists to remove.
 *
 * So live-database tests anchor forward instead. `leadDays` defaults to 2, not
 * 1, so a run that crosses Muscat midnight between computing the anchor and
 * seeding still lands on a future date.
 *
 * Returns the first SUNDAY at least `leadDays` days from `today`, so
 * `weekFrom()` yields an aligned Sunday-through-Saturday week — every weekday,
 * exactly once, always seedable.
 */
export function futureWeekAnchor(today: string, leadDays = 2): string {
  let candidate = addDaysToIsoDate(today, leadDays);
  while (new Date(`${candidate}T00:00:00Z`).getUTCDay() !== 0) {
    candidate = addDaysToIsoDate(candidate, 1);
  }
  return candidate;
}

/** The seven dates of the week beginning at `anchor`: Sunday … Saturday. */
export function weekFrom(anchor: string): string[] {
  return Array.from({ length: 7 }, (_, offset) => addDaysToIsoDate(anchor, offset));
}

/**
 * The first month-end at least `leadDays` away — a seedable date whose seed
 * window straddles a month boundary, without naming a month that will expire.
 */
export function futureMonthEnd(today: string, leadDays = 2): string {
  const earliest = addDaysToIsoDate(today, leadDays);
  const probe = new Date(`${earliest}T00:00:00Z`);
  // Day 0 of the next month is the last day of this one.
  let end = new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + 1, 0));
  if (end.toISOString().slice(0, 10) < earliest) {
    end = new Date(Date.UTC(probe.getUTCFullYear(), probe.getUTCMonth() + 2, 0));
  }
  return end.toISOString().slice(0, 10);
}

export interface MonthBoundaryTargets {
  /** The last day of a future month. */
  monthEnd: string;
  /** The first day of the month after it. */
  nextMonthStart: string;
  /**
   * The side of the boundary that actually has bookings to act on. A month end
   * that falls on the day off has none, so the target moves to the first of the
   * next month — either way the seed window spans both months.
   */
  actionableTarget: string;
}

/**
 * A future month boundary, and the side of it a test can act on.
 *
 * Derived, never named: a written-down month boundary stops being seedable once
 * the calendar passes it, which is the expiring-test defect all over again.
 */
export function futureMonthBoundary(today: string, leadDays = 2): MonthBoundaryTargets {
  const monthEnd = futureMonthEnd(today, leadDays);
  const nextMonthStart = addDaysToIsoDate(monthEnd, 1);
  return {
    monthEnd,
    nextMonthStart,
    actionableTarget: isMuscatDayOff(monthEnd) ? nextMonthStart : monthEnd,
  };
}

/**
 * Confirmed (checked-in-able) bookings the seed places at ONE branch on the
 * reference day itself. Al Khuwair cannot fall back to tomorrow — the seed
 * closes it — so this is what the e2e test depends on.
 */
export const SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY = SEED_DAY_PLAN.today.filter(
  (status) => status === 'confirmed',
).length;
