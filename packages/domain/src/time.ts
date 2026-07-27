/**
 * Oman does not observe daylight saving time; Asia/Muscat is a fixed UTC+4
 * offset. Using the fixed offset keeps day-boundary math deterministic and
 * dependency-free.
 */
export const MUSCAT_TIME_ZONE = 'Asia/Muscat';
export const MUSCAT_UTC_OFFSET_MINUTES = 4 * 60;

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;

export function isIsoDate(value: string): boolean {
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const [, y, mo, d] = match;
  const date = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  return (
    date.getUTCFullYear() === Number(y) &&
    date.getUTCMonth() === Number(mo) - 1 &&
    date.getUTCDate() === Number(d)
  );
}

/** UTC half-open range [startUtc, endUtc) covering one Muscat calendar day. */
export function muscatDayUtcRange(isoDate: string): { startUtc: Date; endUtc: Date } {
  if (!isIsoDate(isoDate)) throw new RangeError(`invalid ISO date: ${isoDate}`);
  const [y, mo, d] = isoDate.split('-').map(Number);
  const startMs = Date.UTC(y!, mo! - 1, d!) - MUSCAT_UTC_OFFSET_MINUTES * MINUTE_MS;
  return { startUtc: new Date(startMs), endUtc: new Date(startMs + DAY_MS) };
}

/** Current calendar date (YYYY-MM-DD) as seen on a wall clock in Muscat. */
export function todayInMuscat(now: Date = new Date()): string {
  const shifted = new Date(now.getTime() + MUSCAT_UTC_OFFSET_MINUTES * MINUTE_MS);
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${mo}-${d}`;
}

/** "HH:mm" wall-clock time in Muscat for a given instant. */
export function formatMuscatTime(instant: Date): string {
  const shifted = new Date(instant.getTime() + MUSCAT_UTC_OFFSET_MINUTES * MINUTE_MS);
  const h = String(shifted.getUTCHours()).padStart(2, '0');
  const m = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/** Instant corresponding to a Muscat wall-clock time on a given day. */
export function muscatDateTimeToUtc(isoDate: string, hour: number, minute = 0): Date {
  const { startUtc } = muscatDayUtcRange(isoDate);
  return new Date(startUtc.getTime() + (hour * 60 + minute) * MINUTE_MS);
}
