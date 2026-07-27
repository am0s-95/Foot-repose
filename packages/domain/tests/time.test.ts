import { describe, expect, it } from 'vitest';
import {
  formatMuscatTime,
  isIsoDate,
  muscatDateTimeToUtc,
  muscatDayUtcRange,
  todayInMuscat,
} from '../src/index';

describe('muscatDayUtcRange', () => {
  it('converts a Muscat calendar day to a UTC half-open range', () => {
    const { startUtc, endUtc } = muscatDayUtcRange('2026-07-27');
    expect(startUtc.toISOString()).toBe('2026-07-26T20:00:00.000Z');
    expect(endUtc.toISOString()).toBe('2026-07-27T20:00:00.000Z');
  });

  it('rejects malformed and impossible dates', () => {
    expect(() => muscatDayUtcRange('2026-7-1')).toThrow(RangeError);
    expect(() => muscatDayUtcRange('2026-02-30')).toThrow(RangeError);
    expect(() => muscatDayUtcRange('not-a-date')).toThrow(RangeError);
  });
});

describe('isIsoDate', () => {
  it('accepts valid dates and rejects invalid ones', () => {
    expect(isIsoDate('2026-01-31')).toBe(true);
    expect(isIsoDate('2026-13-01')).toBe(false);
    expect(isIsoDate('2026-04-31')).toBe(false);
    expect(isIsoDate('26-04-01')).toBe(false);
  });
});

describe('todayInMuscat', () => {
  it('rolls over to the next day at 20:00 UTC (midnight in Muscat)', () => {
    expect(todayInMuscat(new Date('2026-07-27T19:59:59Z'))).toBe('2026-07-27');
    expect(todayInMuscat(new Date('2026-07-27T20:00:00Z'))).toBe('2026-07-28');
    expect(todayInMuscat(new Date('2026-07-27T03:00:00Z'))).toBe('2026-07-27');
  });
});

describe('formatMuscatTime / muscatDateTimeToUtc', () => {
  it('round-trips wall-clock times', () => {
    const instant = muscatDateTimeToUtc('2026-07-27', 14, 30);
    expect(instant.toISOString()).toBe('2026-07-27T10:30:00.000Z');
    expect(formatMuscatTime(instant)).toBe('14:30');
  });

  it('formats midnight and end-of-day correctly', () => {
    expect(formatMuscatTime(muscatDateTimeToUtc('2026-07-27', 0, 0))).toBe('00:00');
    expect(formatMuscatTime(muscatDateTimeToUtc('2026-07-27', 23, 59))).toBe('23:59');
  });
});
