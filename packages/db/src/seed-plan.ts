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
 * Confirmed (checked-in-able) bookings the seed places at ONE branch on the
 * reference day itself. Al Khuwair cannot fall back to tomorrow — the seed
 * closes it — so this is what the e2e test depends on.
 */
export const SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY = SEED_DAY_PLAN.today.filter(
  (status) => status === 'confirmed',
).length;
