import { describe, expect, it } from 'vitest';
import { addDaysToIsoDate } from '@foot-repose/domain';
import {
  futureMonthBoundary,
  futureWeekAnchor,
  isMuscatDayOff,
  weekFrom,
} from '../src/seed-plan';

/**
 * The e2e date contract, including the clock boundary that used to break it.
 *
 * These are pure so they can simulate a Muscat midnight rather than wait for
 * one. The rule under test: a Playwright run resolves its dates ONCE, they are
 * all in the future, and the day advancing mid-run cannot invalidate any of
 * them.
 */

/** Migration 0005: seedable only while reference+1 is today or later. */
const seedable = (reference: string, today: string): boolean =>
  reference >= addDaysToIsoDate(today, -1);

describe('[midnight] the previous offset-based design breaks when the day advances', () => {
  it.each(['2026-07-31', '2026-08-01', '2026-11-30', '2026-12-31', '2028-02-28'])(
    'from %s, a frozen TODAY with a -1 offset becomes unseedable after midnight',
    (setupDay) => {
      // What the old spec did: freeze TODAY at module load, then pick from
      // [-1, +1, +2] and later assert the board still reads TODAY.
      const frozenToday = setupDay;
      const negativeOffsetTarget = addDaysToIsoDate(frozenToday, -1);

      // While the day holds, that target is (just barely) acceptable.
      expect(seedable(negativeOffsetTarget, frozenToday)).toBe(true);

      // The run crosses Muscat midnight. The board now reports D+1...
      const boardDayAfterMidnight = addDaysToIsoDate(frozenToday, 1);
      // ...so the old `expect(boardDate).toBe(TODAY)` assertion fails...
      expect(boardDayAfterMidnight).not.toBe(frozenToday);
      // ...and the -1 reference is now two days old, which the database
      // refuses outright. Neither failure is an application defect.
      expect(seedable(negativeOffsetTarget, boardDayAfterMidnight)).toBe(false);
    },
  );

  it.each(['2026-07-31', '2026-08-01', '2026-11-30', '2026-12-31', '2028-02-28'])(
    'from %s, every persisted target survives the day advancing',
    (setupDay) => {
      const week = weekFrom(futureWeekAnchor(setupDay));
      const boundary = futureMonthBoundary(setupDay);
      const targets = [
        week[0]!,
        week[4]!,
        week[5]!,
        week[6]!,
        boundary.monthEnd,
        boundary.nextMonthStart,
        boundary.actionableTarget,
      ];

      // Resolved before midnight, still seedable after it — and after a second
      // midnight too, since every target is at least two days out.
      for (const laterToday of [setupDay, addDaysToIsoDate(setupDay, 1)]) {
        for (const target of targets) {
          expect(seedable(target, laterToday)).toBe(true);
          // Navigation is always forwards: never a negative step.
          expect(target >= laterToday).toBe(true);
        }
      }
    },
  );
});

describe('[coverage] the e2e targets are the same weekdays on every run', () => {
  const SIMULATED_TODAYS = [
    '2026-07-26', // Sunday
    '2026-07-27',
    '2026-07-28',
    '2026-07-29',
    '2026-07-30',
    '2026-07-31', // the day off
    '2026-08-01', // Saturday
    '2026-12-29',
    '2027-02-25',
    '2028-02-28',
  ];

  it.each(SIMULATED_TODAYS)('from %s the run still targets Thursday and Saturday', (today) => {
    // The old design generated cases from offsets, so a Monday run exercised
    // Sunday and Tuesday and a Friday run exercised Thursday and Saturday.
    // "The suite covers Thursday" was a statement about one run.
    const week = weekFrom(futureWeekAnchor(today));
    expect(new Date(`${week[4]!}T00:00:00Z`).getUTCDay()).toBe(4); // Thursday
    expect(new Date(`${week[6]!}T00:00:00Z`).getUTCDay()).toBe(6); // Saturday
    expect(isMuscatDayOff(week[5]!)).toBe(true);
    expect(isMuscatDayOff(week[4]!)).toBe(false);
    expect(isMuscatDayOff(week[6]!)).toBe(false);
  });

  it.each(SIMULATED_TODAYS)('from %s the run still targets a real month boundary', (today) => {
    const { monthEnd, nextMonthStart, actionableTarget } = futureMonthBoundary(today);
    // A genuine boundary: the day after the month end is the 1st.
    expect(addDaysToIsoDate(monthEnd, 1)).toBe(nextMonthStart);
    expect(nextMonthStart.slice(8)).toBe('01');
    expect(monthEnd.slice(0, 7)).not.toBe(nextMonthStart.slice(0, 7));
    // The side chosen for the check-in always has bookings.
    expect(isMuscatDayOff(actionableTarget)).toBe(false);
    expect([monthEnd, nextMonthStart]).toContain(actionableTarget);
    // ...and it is still in the future.
    expect(actionableTarget >= addDaysToIsoDate(today, 2)).toBe(true);
  });

  it('moves the boundary target off the month end exactly when that end is the day off', () => {
    // Not vacuous: across a wide span both cases occur.
    const cases = [];
    for (let offset = 0; offset < 400; offset += 1) {
      const today = addDaysToIsoDate('2026-07-01', offset);
      const { monthEnd, actionableTarget } = futureMonthBoundary(today);
      cases.push(isMuscatDayOff(monthEnd) ? 'moved' : 'kept');
      expect(actionableTarget).toBe(
        isMuscatDayOff(monthEnd) ? addDaysToIsoDate(monthEnd, 1) : monthEnd,
      );
    }
    expect(new Set(cases)).toEqual(new Set(['moved', 'kept']));
  });
});
