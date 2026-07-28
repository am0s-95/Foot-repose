import { describe, expect, it } from 'vitest';
import {
  breakIsCoveredByShifts,
  intersectIntervals,
  materializeBranchHours,
  materializeProviderPresence,
  muscatDayOfWeek,
  versionCoversDate,
  weekSpansOf,
  type CoverageWindow,
  type OverrideDay,
  type ProviderWeeklyWindow,
  type UtcInterval,
  type WeeklyWindow,
} from '../src/scheduling';
import { addDaysToIsoDate, muscatDateTimeToUtc } from '../src/time';

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

describe('break coverage over time AND dates', () => {
  const BRANCH_A = 'aaaaaaaa-0000-0000-0000-000000000001';
  const BRANCH_B = 'bbbbbbbb-0000-0000-0000-000000000002';
  const shiftAt = (over: Partial<CoverageWindow> = {}): CoverageWindow => ({
    validFrom: '2030-01-01',
    validTo: null,
    dayOfWeek: 0,
    openMinute: 600,
    closeMinute: 1080,
    branchId: BRANCH_A,
    ...over,
  });
  const breakAt = (over: Partial<CoverageWindow> = {}): CoverageWindow =>
    shiftAt({ openMinute: 780, closeMinute: 810, ...over });

  it('accepts a break inside a shift and rejects one outside its minutes', () => {
    expect(breakIsCoveredByShifts(breakAt(), [shiftAt()])).toBe(true);
    expect(breakIsCoveredByShifts(breakAt({ openMinute: 1050, closeMinute: 1140 }), [shiftAt()])).toBe(false);
    expect(breakIsCoveredByShifts(breakAt({ dayOfWeek: 1 }), [shiftAt()])).toBe(false);
    expect(breakIsCoveredByShifts(breakAt(), [])).toBe(false);
  });

  it('rejects a break that outlives the shift that would justify it', () => {
    // Overlapping date ranges are NOT coverage: this shift stops in February.
    const shift = shiftAt({ validFrom: '2030-01-01', validTo: '2030-03-01' });
    expect(breakIsCoveredByShifts(breakAt({ validFrom: '2030-01-01', validTo: null }), [shift])).toBe(false);
    expect(breakIsCoveredByShifts(breakAt({ validFrom: '2030-01-01', validTo: '2030-03-01' }), [shift])).toBe(true);
    // ...and one that starts before the shift does is refused from the front.
    expect(breakIsCoveredByShifts(breakAt({ validFrom: '2029-12-01', validTo: '2030-02-01' }), [shift])).toBe(false);
  });

  it('rejects a one-day hole that falls on a day the break actually occurs', () => {
    // 2030-02-03 is a Sunday, and the break occurs on Sundays — so a version
    // gap on exactly that day leaves a real occurrence uncovered.
    const first = shiftAt({ validFrom: '2030-01-01', validTo: '2030-02-03' });
    const second = shiftAt({ validFrom: '2030-02-04', validTo: '2030-03-01' });
    expect(muscatDayOfWeek('2030-02-03')).toBe(0);
    expect(
      breakIsCoveredByShifts(breakAt({ validFrom: '2030-01-01', validTo: '2030-03-01' }), [first, second]),
    ).toBe(false);
  });

  it('accepts a hole on a weekday the break never occurs on', () => {
    // 2030-02-01 is a Friday. The break only ever happens on Sundays, so this
    // gap leaves no occurrence uncovered — coverage is about occurrences, not
    // about calendar arithmetic on the version ranges.
    expect(muscatDayOfWeek('2030-02-01')).toBe(5);
    const first = shiftAt({ validFrom: '2030-01-01', validTo: '2030-02-01' });
    const second = shiftAt({ validFrom: '2030-02-02', validTo: '2030-03-01' });
    expect(
      breakIsCoveredByShifts(breakAt({ validFrom: '2030-01-01', validTo: '2030-03-01' }), [first, second]),
    ).toBe(true);
  });

  it('accepts two adjacent shift versions that jointly span the break', () => {
    const first = shiftAt({ validFrom: '2030-01-01', validTo: '2030-02-01' });
    const second = shiftAt({ validFrom: '2030-02-01', validTo: '2030-03-01' });
    expect(
      breakIsCoveredByShifts(breakAt({ validFrom: '2030-01-01', validTo: '2030-03-01' }), [first, second]),
    ).toBe(true);
  });

  it('accepts two shifts that jointly cover the minutes of the break', () => {
    const morning = shiftAt({ openMinute: 600, closeMinute: 795 });
    const afternoon = shiftAt({ openMinute: 795, closeMinute: 1080 });
    expect(breakIsCoveredByShifts(breakAt(), [morning, afternoon])).toBe(true);
    const gapped = shiftAt({ openMinute: 800, closeMinute: 1080 }); // 795..800 uncovered
    expect(breakIsCoveredByShifts(breakAt(), [morning, gapped])).toBe(false);
  });

  it('does not let a shift in another branch justify this branch\'s break', () => {
    const elsewhere = shiftAt({ branchId: BRANCH_B });
    expect(breakIsCoveredByShifts(breakAt({ branchId: BRANCH_A }), [elsewhere])).toBe(false);
    expect(breakIsCoveredByShifts(breakAt({ branchId: BRANCH_B }), [elsewhere])).toBe(true);
  });

  it('follows a shift that wraps past Saturday midnight', () => {
    const nightShift = shiftAt({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560 }); // Sat 23:00 -> 02:00
    expect(breakIsCoveredByShifts(breakAt({ dayOfWeek: 0, openMinute: 30, closeMinute: 60 }), [nightShift])).toBe(true);
    expect(breakIsCoveredByShifts(breakAt({ dayOfWeek: 0, openMinute: 90, closeMinute: 150 }), [nightShift])).toBe(false);
  });

  it('applies the date rule to a wrapping shift as well', () => {
    const nightShift = shiftAt({
      dayOfWeek: 6,
      openMinute: 1380,
      closeMinute: 1560,
      validFrom: '2030-01-01',
      validTo: '2030-03-01',
    });
    const wrapBreak = breakAt({ dayOfWeek: 0, openMinute: 30, closeMinute: 60 });
    // Last Sunday inside the shift version is 2030-02-24; the next one,
    // 2030-03-03, is past its end.
    expect(muscatDayOfWeek('2030-03-03')).toBe(0);
    expect(breakIsCoveredByShifts({ ...wrapBreak, validTo: '2030-03-01' }, [nightShift])).toBe(true);
    expect(breakIsCoveredByShifts({ ...wrapBreak, validTo: '2030-03-04' }, [nightShift])).toBe(false);
  });

  // ---------------------------------------------------------------- midnight
  // An occurrence that runs past midnight is ANCHORED on the day it started.
  // The version that has to be in force is the one covering that anchor day —
  // not merely the day the minutes land on.
  describe('a version boundary in the middle of the night', () => {
    // 2030-01-06 is a Sunday; 2030-01-05 the Saturday before it.
    const SUN = '2030-01-06';
    const SAT = '2030-01-05';
    const nightShift = (validFrom: string, validTo: string | null = null): CoverageWindow =>
      shiftAt({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560, validFrom, validTo });
    const morningBreak = breakAt({
      dayOfWeek: 0,
      openMinute: 30,
      closeMinute: 60,
      validFrom: SUN,
      validTo: null,
    });

    it('rejects a break justified only by an occurrence its version was too young to produce', () => {
      // Template says Saturday 23:00 -> Sunday 02:00, but the version only
      // begins on the Sunday: no Saturday anchor, so no Sunday-morning
      // occurrence exists at all.
      expect(breakIsCoveredByShifts(morningBreak, [nightShift(SUN)])).toBe(false);
      // Proof that the rejection matches reality, from the materialiser:
      expect(
        materializeProviderPresence({
          isoDate: SUN,
          weekly: [{ ...nightShift(SUN), branchId: BRANCH_A, kind: 'shift' as const }],
          extraShifts: [],
        }),
      ).toEqual([]);
    });

    it('accepts the same break once the version covers the anchor day', () => {
      expect(breakIsCoveredByShifts(morningBreak, [nightShift(SAT)])).toBe(true);
      expect(breakIsCoveredByShifts(morningBreak, [nightShift('2030-01-04')])).toBe(true);
      expect(
        shape(
          materializeProviderPresence({
            isoDate: SUN,
            weekly: [{ ...nightShift(SAT), branchId: BRANCH_A, kind: 'shift' as const }],
            extraShifts: [],
          }),
        ),
      ).toEqual([`${at(SUN, 0)}..${at(SUN, 2)}`]);
    });

    it('needs the version to still be in force on the day the minutes land, too', () => {
      // One single occurrence to reason about: the break lives on 2030-01-06.
      const oneSunday = { ...morningBreak, validTo: '2030-01-07' };
      // Anchored on Saturday 2030-01-05 but ending exactly on the Sunday: the
      // occurrence would spill into a day this version no longer owns, so the
      // materialiser produces nothing and the break is refused.
      expect(breakIsCoveredByShifts(oneSunday, [nightShift(SAT, SUN)])).toBe(false);
      expect(breakIsCoveredByShifts(oneSunday, [nightShift(SAT, '2030-01-07')])).toBe(true);
      // An open-ended break, by contrast, still needs every LATER Sunday
      // covered — a version that stops on 2030-01-07 cannot do that.
      expect(breakIsCoveredByShifts(morningBreak, [nightShift(SAT, '2030-01-07')])).toBe(false);
    });

    it('holds for every weekday transition, not just Saturday to Sunday', () => {
      const results = Array.from({ length: 7 }, (_, anchorDow) => {
        const landingDow = (anchorDow + 1) % 7;
        const landingDate = addDaysToIsoDate(SUN, landingDow); // 2030-01-06 is dow 0
        const anchorDate = addDaysToIsoDate(landingDate, -1);
        expect([muscatDayOfWeek(anchorDate), muscatDayOfWeek(landingDate)]).toEqual([
          anchorDow,
          landingDow,
        ]);
        const night = (validFrom: string): CoverageWindow =>
          shiftAt({ dayOfWeek: anchorDow, openMinute: 1380, closeMinute: 1560, validFrom });
        const brk = breakAt({
          dayOfWeek: landingDow,
          openMinute: 30,
          closeMinute: 60,
          validFrom: landingDate,
          validTo: null,
        });
        return (
          `${anchorDow}->${landingDow}` +
          ` version-from-landing-day=${breakIsCoveredByShifts(brk, [night(landingDate)])}` +
          ` version-from-anchor-day=${breakIsCoveredByShifts(brk, [night(anchorDate)])}`
        );
      });
      expect(results).toEqual([
        '0->1 version-from-landing-day=false version-from-anchor-day=true',
        '1->2 version-from-landing-day=false version-from-anchor-day=true',
        '2->3 version-from-landing-day=false version-from-anchor-day=true',
        '3->4 version-from-landing-day=false version-from-anchor-day=true',
        '4->5 version-from-landing-day=false version-from-anchor-day=true',
        '5->6 version-from-landing-day=false version-from-anchor-day=true',
        '6->0 version-from-landing-day=false version-from-anchor-day=true',
      ]);
    });

    it('handles a break that itself crosses midnight', () => {
      const wrapBreak = breakAt({
        dayOfWeek: 6,
        openMinute: 1410,
        closeMinute: 1500, // Sat 23:30 -> Sun 01:00
        validFrom: SAT,
        validTo: null,
      });
      // A shift anchored on the same Saturday, wide enough for both halves.
      expect(
        breakIsCoveredByShifts(wrapBreak, [
          shiftAt({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560, validFrom: SAT }),
        ]),
      ).toBe(true);
      // Same shift, but its version starts on the Sunday: neither half exists.
      expect(
        breakIsCoveredByShifts(wrapBreak, [
          shiftAt({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560, validFrom: SUN }),
        ]),
      ).toBe(false);
    });

    it('lets two shifts cover an after-midnight break jointly, and catches the gap', () => {
      const brk = breakAt({
        dayOfWeek: 0,
        openMinute: 60,
        closeMinute: 150, // Sunday 01:00 -> 02:30
        validFrom: SUN,
        validTo: null,
      });
      const night = shiftAt({ dayOfWeek: 6, openMinute: 1380, closeMinute: 1560, validFrom: SAT }); // Sun 00:00-02:00
      const morning = shiftAt({ dayOfWeek: 0, openMinute: 120, closeMinute: 300, validFrom: SUN }); // Sun 02:00-05:00
      expect(breakIsCoveredByShifts(brk, [night, morning])).toBe(true);
      const gapped = shiftAt({ dayOfWeek: 0, openMinute: 130, closeMinute: 300, validFrom: SUN });
      expect(breakIsCoveredByShifts(brk, [night, gapped])).toBe(false);
    });
  });
});
