import { describe, expect, it } from 'vitest';
import {
  breakIsInsideShifts,
  intersectIntervals,
  materializeBranchHours,
  materializeProviderPresence,
  muscatDayOfWeek,
  versionCoversDate,
  weekSpansOf,
  type OverrideDay,
  type ProviderWeeklyWindow,
  type UtcInterval,
  type WeeklyWindow,
} from '../src/scheduling';
import { muscatDateTimeToUtc } from '../src/time';

// Calendar anchors used throughout: 2026-08-29 is a Saturday, so
// 2026-08-30 is the Sunday that starts the next week.
const SATURDAY = '2026-08-29';
const SUNDAY = '2026-08-30';
const MONDAY = '2026-08-31';

const at = (isoDate: string, hour: number, minute = 0): string =>
  muscatDateTimeToUtc(isoDate, hour, minute).toISOString();

const shape = (intervals: UtcInterval[]): string[] =>
  intervals.map((i) => `${i.startUtc.toISOString()}..${i.endUtc.toISOString()}`);

const window = (over: Partial<WeeklyWindow> = {}): WeeklyWindow => ({
  validFrom: '2026-01-01',
  validTo: null,
  dayOfWeek: 0,
  openMinute: 600,
  closeMinute: 1320,
  ...over,
});

describe('muscat weekday and version helpers', () => {
  it('numbers weekdays with Sunday = 0', () => {
    expect(muscatDayOfWeek(SUNDAY)).toBe(0);
    expect(muscatDayOfWeek(MONDAY)).toBe(1);
    expect(muscatDayOfWeek(SATURDAY)).toBe(6);
  });

  it('treats a dated version as half-open [from, to)', () => {
    const version = { validFrom: SUNDAY, validTo: MONDAY };
    expect(versionCoversDate(version, SATURDAY)).toBe(false);
    expect(versionCoversDate(version, SUNDAY)).toBe(true);
    expect(versionCoversDate(version, MONDAY)).toBe(false);
    expect(versionCoversDate({ validFrom: SUNDAY, validTo: null }, '2099-01-01')).toBe(true);
  });

  it('wraps a Saturday-night window to the start of the same week', () => {
    expect(weekSpansOf({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560 })).toEqual([
      { start: 10_020, end: 10_080 },
      { start: 0, end: 120 },
    ]);
    expect(weekSpansOf({ dayOfWeek: 0, openMinute: 600, closeMinute: 1320 })).toEqual([
      { start: 600, end: 1320 },
    ]);
  });
});

describe('branch hours materialisation', () => {
  it('returns each day of a full weekly cycle', () => {
    const weekly = Array.from({ length: 7 }, (_, dow) =>
      window({ dayOfWeek: dow, openMinute: 600 + dow * 10, closeMinute: 1320 }),
    );
    for (const [offset, date] of [SUNDAY, MONDAY, '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04', '2026-09-05'].entries()) {
      const hours = materializeBranchHours({ isoDate: date, weekly, overrides: [] });
      expect(shape(hours)).toEqual([`${at(date, 10, offset * 10)}..${at(date, 22)}`]);
    }
  });

  it('splits a midnight-crossing window across the two days it touches', () => {
    const weekly = [window({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560 })]; // Sat 23:00 -> 02:00
    expect(shape(materializeBranchHours({ isoDate: SATURDAY, weekly, overrides: [] }))).toEqual([
      `${at(SATURDAY, 23)}..${at(SUNDAY, 0)}`,
    ]);
    expect(shape(materializeBranchHours({ isoDate: SUNDAY, weekly, overrides: [] }))).toEqual([
      `${at(SUNDAY, 0)}..${at(SUNDAY, 2)}`,
    ]);
  });

  it('clips the carry-in at a version boundary — each version owns its own dates', () => {
    // The old version ends ON Sunday, so it owns Saturday's minutes only.
    const old = window({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560, validTo: SUNDAY });
    const next = window({ dayOfWeek: 0, openMinute: 30, closeMinute: 600, validFrom: SUNDAY });
    const weekly = [old, next];

    // Saturday still ends at midnight...
    expect(shape(materializeBranchHours({ isoDate: SATURDAY, weekly, overrides: [] }))).toEqual([
      `${at(SATURDAY, 23)}..${at(SUNDAY, 0)}`,
    ]);
    // ...and Sunday shows ONLY the new version: no 00:00-02:00 carry-in.
    expect(shape(materializeBranchHours({ isoDate: SUNDAY, weekly, overrides: [] }))).toEqual([
      `${at(SUNDAY, 0, 30)}..${at(SUNDAY, 10)}`,
    ]);
  });

  it('keeps the carry-in when one version owns both days', () => {
    const weekly = [window({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560, validTo: MONDAY })];
    expect(shape(materializeBranchHours({ isoDate: SUNDAY, weekly, overrides: [] }))).toEqual([
      `${at(SUNDAY, 0)}..${at(SUNDAY, 2)}`,
    ]);
  });

  it('a closed override owns every minute of its day, carry-in included', () => {
    const weekly = [
      window({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560 }),
      window({ dayOfWeek: 0 }),
    ];
    const overrides: OverrideDay[] = [{ muscatDate: SUNDAY, isClosed: true, windows: [] }];
    expect(materializeBranchHours({ isoDate: SUNDAY, weekly, overrides })).toEqual([]);
  });

  it('an open override replaces that day, and removes the day-after carry-in it would have made', () => {
    const weekly = [
      window({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560 }), // Sat 23:00 -> Sun 02:00
      window({ dayOfWeek: 0, openMinute: 600, closeMinute: 1320 }),
    ];
    const overrides: OverrideDay[] = [
      { muscatDate: SATURDAY, isClosed: false, windows: [{ openMinute: 960, closeMinute: 1200 }] },
    ];
    expect(shape(materializeBranchHours({ isoDate: SATURDAY, weekly, overrides }))).toEqual([
      `${at(SATURDAY, 16)}..${at(SATURDAY, 20)}`,
    ]);
    // Saturday's template is gone, so Sunday keeps only its own window.
    expect(shape(materializeBranchHours({ isoDate: SUNDAY, weekly, overrides }))).toEqual([
      `${at(SUNDAY, 10)}..${at(SUNDAY, 22)}`,
    ]);
  });

  it('merges split shifts and leaves genuine gaps intact', () => {
    const weekly = [
      window({ dayOfWeek: 0, openMinute: 600, closeMinute: 840 }),
      window({ dayOfWeek: 0, openMinute: 840, closeMinute: 1080 }),
      window({ dayOfWeek: 0, openMinute: 1140, closeMinute: 1320 }),
    ];
    expect(shape(materializeBranchHours({ isoDate: SUNDAY, weekly, overrides: [] }))).toEqual([
      `${at(SUNDAY, 10)}..${at(SUNDAY, 18)}`,
      `${at(SUNDAY, 19)}..${at(SUNDAY, 22)}`,
    ]);
  });
});

describe('provider presence materialisation', () => {
  const BRANCH_A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const BRANCH_B = 'bbbbbbbb-0000-0000-0000-000000000002';
  const shift = (over: Partial<ProviderWeeklyWindow>): ProviderWeeklyWindow => ({
    ...window(),
    branchId: BRANCH_A,
    kind: 'shift',
    dayOfWeek: 0,
    openMinute: 600,
    closeMinute: 840,
    ...over,
  });

  it('an extra shift OVERRIDES the weekly roster instead of adding to it', () => {
    // Weekly: branch A 10:00-14:00. Extra: branch B 11:00-13:00.
    const weekly = [shift({ openMinute: 600, closeMinute: 840 })];
    const extraShifts = [
      {
        branchId: BRANCH_B,
        startUtc: muscatDateTimeToUtc(SUNDAY, 11),
        endUtc: muscatDateTimeToUtc(SUNDAY, 13),
      },
    ];
    const presence = materializeProviderPresence({ isoDate: SUNDAY, weekly, extraShifts });
    expect(
      presence.map((p) => `${p.branchId === BRANCH_A ? 'A' : 'B'} ${p.startUtc.toISOString()}..${p.endUtc.toISOString()}`),
    ).toEqual([
      `A ${at(SUNDAY, 10)}..${at(SUNDAY, 11)}`,
      `B ${at(SUNDAY, 11)}..${at(SUNDAY, 13)}`,
      `A ${at(SUNDAY, 13)}..${at(SUNDAY, 14)}`,
    ]);

    // The point of the rule: never present in two branches at once, and no
    // minute of the original 4-hour coverage is lost.
    const inA = presence.filter((p) => p.branchId === BRANCH_A);
    const inB = presence.filter((p) => p.branchId === BRANCH_B);
    expect(intersectIntervals(inA, inB)).toEqual([]);
    const minutes = presence.reduce(
      (sum, p) => sum + (p.endUtc.getTime() - p.startUtc.getTime()) / 60_000,
      0,
    );
    expect(minutes).toBe(240);
  });

  it('without the override rule the same inputs would double-book the provider', () => {
    // Proof of the counterfactual: plain union of the two inputs overlaps.
    const weeklyOnly: UtcInterval[] = [
      { startUtc: muscatDateTimeToUtc(SUNDAY, 10), endUtc: muscatDateTimeToUtc(SUNDAY, 14) },
    ];
    const extraOnly: UtcInterval[] = [
      { startUtc: muscatDateTimeToUtc(SUNDAY, 11), endUtc: muscatDateTimeToUtc(SUNDAY, 13) },
    ];
    expect(shape(intersectIntervals(weeklyOnly, extraOnly))).toEqual([
      `${at(SUNDAY, 11)}..${at(SUNDAY, 13)}`,
    ]);
  });

  it('subtracts breaks from the weekly roster', () => {
    const weekly = [
      shift({ openMinute: 600, closeMinute: 1080 }),
      shift({ kind: 'break', openMinute: 780, closeMinute: 810 }),
    ];
    const presence = materializeProviderPresence({ isoDate: SUNDAY, weekly, extraShifts: [] });
    expect(shape(presence)).toEqual([
      `${at(SUNDAY, 10)}..${at(SUNDAY, 13)}`,
      `${at(SUNDAY, 13, 30)}..${at(SUNDAY, 18)}`,
    ]);
  });

  it('carries a night shift into the next day and clips it at a version boundary', () => {
    const sameVersion = [shift({ dayOfWeek: 6, openMinute: 1320, closeMinute: 1560 })];
    expect(shape(materializeProviderPresence({ isoDate: SUNDAY, weekly: sameVersion, extraShifts: [] }))).toEqual([
      `${at(SUNDAY, 0)}..${at(SUNDAY, 2)}`,
    ]);
    const endsAtSunday = [
      shift({ dayOfWeek: 6, openMinute: 1320, closeMinute: 1560, validTo: SUNDAY }),
    ];
    expect(materializeProviderPresence({ isoDate: SUNDAY, weekly: endsAtSunday, extraShifts: [] })).toEqual([]);
  });

  it('clips an extra shift to the Muscat day being asked about', () => {
    const extraShifts = [
      {
        branchId: BRANCH_B,
        startUtc: muscatDateTimeToUtc(SATURDAY, 22),
        endUtc: muscatDateTimeToUtc(SUNDAY, 2),
      },
    ];
    expect(shape(materializeProviderPresence({ isoDate: SUNDAY, weekly: [], extraShifts }))).toEqual([
      `${at(SUNDAY, 0)}..${at(SUNDAY, 2)}`,
    ]);
  });
});

describe('break containment', () => {
  const shiftWindow = { dayOfWeek: 0, openMinute: 600, closeMinute: 1080 };

  it('accepts a break inside a shift and rejects one outside it', () => {
    expect(breakIsInsideShifts({ dayOfWeek: 0, openMinute: 780, closeMinute: 810 }, [shiftWindow])).toBe(true);
    expect(breakIsInsideShifts({ dayOfWeek: 0, openMinute: 1050, closeMinute: 1140 }, [shiftWindow])).toBe(false);
    expect(breakIsInsideShifts({ dayOfWeek: 1, openMinute: 780, closeMinute: 810 }, [shiftWindow])).toBe(false);
    expect(breakIsInsideShifts({ dayOfWeek: 0, openMinute: 780, closeMinute: 810 }, [])).toBe(false);
  });

  it('follows a shift that wraps past Saturday midnight', () => {
    const nightShift = { dayOfWeek: 6, openMinute: 1380, closeMinute: 1560 }; // Sat 23:00 -> 02:00
    expect(breakIsInsideShifts({ dayOfWeek: 0, openMinute: 30, closeMinute: 60 }, [nightShift])).toBe(true);
    expect(breakIsInsideShifts({ dayOfWeek: 0, openMinute: 90, closeMinute: 150 }, [nightShift])).toBe(false);
  });
});
