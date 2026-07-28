/**
 * Materialisation of scheduling INPUTS into concrete UTC windows.
 *
 * Everything here is pure: the caller loads rows, these functions turn them
 * into instants. Two semantic rules that PostgreSQL cannot express live here,
 * and both are covered by tests in both directions:
 *
 *   1. Version-boundary carry-in. Each dated version owns the minutes of its
 *      OWN dates. A window that crosses midnight therefore reaches into the
 *      next day only when that next day still belongs to the same version;
 *      at a version boundary the carry-in is clipped.
 *
 *   2. An extra shift OVERRIDES the weekly template for the minutes it
 *      covers — it does not add to it. That is what stops one provider from
 *      appearing available in two branches at the same instant while keeping
 *      total coverage gap-free.
 *
 * A Muscat-day override owns every minute of its day: a closed day cuts even
 * a carry-in that would have arrived from the previous day, and an open
 * override replaces that day's template entirely.
 */
import { addDaysToIsoDate, isIsoDate, muscatDayUtcRange } from './time';

const MINUTE_MS = 60_000;
export const MINUTES_PER_DAY = 1440;
export const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** Half-open UTC interval [startUtc, endUtc). */
export interface UtcInterval {
  startUtc: Date;
  endUtc: Date;
}

/** Half-open interval of Muscat dates [validFrom, validTo). */
export interface DatedVersion {
  validFrom: string;
  /** null = open-ended */
  validTo: string | null;
}

export interface WeeklyWindow extends DatedVersion {
  /** 0 = Sunday .. 6 = Saturday */
  dayOfWeek: number;
  openMinute: number;
  /** may exceed 1440: the window crosses midnight into the next day */
  closeMinute: number;
}

export interface OverrideDay {
  muscatDate: string;
  isClosed: boolean;
  /** replacement windows; never cross midnight */
  windows: { openMinute: number; closeMinute: number }[];
}

export interface ProviderWeeklyWindow extends WeeklyWindow {
  branchId: string;
  kind: 'shift' | 'break';
}

export interface ProviderExtraShift {
  branchId: string;
  startUtc: Date;
  endUtc: Date;
}

/** A window of provider presence, attributed to exactly one branch. */
export interface ProviderPresence extends UtcInterval {
  branchId: string;
}

// ---------------------------------------------------------------- intervals
// Internal algebra on half-open [start, end) ranges of numbers (epoch ms, or
// minutes of the week). Every operation returns a sorted, disjoint list.

interface Span {
  start: number;
  end: number;
}

function normalise(spans: Span[]): Span[] {
  const sorted = spans.filter((s) => s.end > s.start).sort((a, b) => a.start - b.start);
  const merged: Span[] = [];
  for (const span of sorted) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      if (span.end > last.end) last.end = span.end;
    } else {
      merged.push({ ...span });
    }
  }
  return merged;
}

function subtract(from: Span[], cut: Span[]): Span[] {
  const holes = normalise(cut);
  let result = normalise(from);
  for (const hole of holes) {
    const next: Span[] = [];
    for (const span of result) {
      if (hole.end <= span.start || hole.start >= span.end) {
        next.push(span);
        continue;
      }
      if (hole.start > span.start) next.push({ start: span.start, end: hole.start });
      if (hole.end < span.end) next.push({ start: hole.end, end: span.end });
    }
    result = next;
  }
  return result;
}

function covers(outer: Span[], inner: Span[]): boolean {
  return subtract(inner, outer).length === 0;
}

// ---------------------------------------------------------------- helpers

/** Day of week of a Muscat calendar date: 0 = Sunday .. 6 = Saturday. */
export function muscatDayOfWeek(isoDate: string): number {
  if (!isIsoDate(isoDate)) throw new RangeError(`invalid ISO date: ${isoDate}`);
  const [y, mo, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!)).getUTCDay();
}

/** Does a dated version cover this Muscat date? Half-open [from, to). */
export function versionCoversDate(version: DatedVersion, isoDate: string): boolean {
  return version.validFrom <= isoDate && (version.validTo === null || isoDate < version.validTo);
}

/**
 * Minutes of the week [0, 10080) occupied by a weekly window — the same
 * decomposition the database computes for `week_spans`, including the
 * Saturday -> Sunday wrap. Exported so break-inside-shift validation can run
 * on the exact geometry the exclusion constraints use.
 */
export function weekSpansOf(window: Pick<WeeklyWindow, 'dayOfWeek' | 'openMinute' | 'closeMinute'>): {
  start: number;
  end: number;
}[] {
  const start = window.dayOfWeek * MINUTES_PER_DAY + window.openMinute;
  const end = window.dayOfWeek * MINUTES_PER_DAY + window.closeMinute;
  if (end <= MINUTES_PER_WEEK) return [{ start, end }];
  return [
    { start, end: MINUTES_PER_WEEK },
    { start: 0, end: end - MINUTES_PER_WEEK },
  ];
}

/**
 * Is every minute of `breakWindow` inside the union of `shifts`?
 * Fail-safe by design: a stray break only ever REMOVES availability, so this
 * is validated in the write path rather than enforced as a constraint.
 */
export function breakIsInsideShifts(
  breakWindow: Pick<WeeklyWindow, 'dayOfWeek' | 'openMinute' | 'closeMinute'>,
  shifts: Pick<WeeklyWindow, 'dayOfWeek' | 'openMinute' | 'closeMinute'>[],
): boolean {
  return covers(shifts.flatMap(weekSpansOf), weekSpansOf(breakWindow));
}

function dayStartMs(isoDate: string): number {
  return muscatDayUtcRange(isoDate).startUtc.getTime();
}

const toIntervals = (spans: Span[]): UtcInterval[] =>
  spans.map((s) => ({ startUtc: new Date(s.start), endUtc: new Date(s.end) }));

/**
 * Template minutes landing on `isoDate`, as epoch-ms spans: windows that
 * start on the day itself, plus the carry-in from the previous day when — and
 * only when — the previous day's version also covers `isoDate`.
 */
function templateSpansForDate(isoDate: string, windows: WeeklyWindow[]): Span[] {
  const startMs = dayStartMs(isoDate);
  const previous = addDaysToIsoDate(isoDate, -1);
  const previousStartMs = dayStartMs(previous);
  const dow = muscatDayOfWeek(isoDate);
  const previousDow = muscatDayOfWeek(previous);
  const spans: Span[] = [];

  for (const window of windows) {
    if (window.dayOfWeek === dow && versionCoversDate(window, isoDate)) {
      const close = Math.min(window.closeMinute, MINUTES_PER_DAY);
      spans.push({ start: startMs + window.openMinute * MINUTE_MS, end: startMs + close * MINUTE_MS });
    }
    if (
      window.dayOfWeek === previousDow &&
      window.closeMinute > MINUTES_PER_DAY &&
      versionCoversDate(window, previous) &&
      // version-boundary rule: the carry-in only reaches a day the SAME
      // version owns
      versionCoversDate(window, isoDate)
    ) {
      spans.push({
        start: previousStartMs + MINUTES_PER_DAY * MINUTE_MS,
        end: previousStartMs + window.closeMinute * MINUTE_MS,
      });
    }
  }
  return normalise(spans);
}

export interface BranchHoursInput {
  isoDate: string;
  weekly: WeeklyWindow[];
  overrides: OverrideDay[];
}

/**
 * Opening hours of one branch on one Muscat day, as UTC intervals.
 * An override on the day replaces the template completely; an override on the
 * PREVIOUS day removes that day's template and therefore its carry-in too.
 */
export function materializeBranchHours(input: BranchHoursInput): UtcInterval[] {
  const { isoDate, weekly, overrides } = input;
  const override = overrides.find((o) => o.muscatDate === isoDate);
  if (override) {
    if (override.isClosed) return [];
    const startMs = dayStartMs(isoDate);
    return toIntervals(
      normalise(
        override.windows.map((w) => ({
          start: startMs + w.openMinute * MINUTE_MS,
          end: startMs + w.closeMinute * MINUTE_MS,
        })),
      ),
    );
  }

  const previous = addDaysToIsoDate(isoDate, -1);
  const previousOverridden = overrides.some((o) => o.muscatDate === previous);
  const windows = previousOverridden
    ? // the previous day's template is replaced, so it contributes no carry-in
      weekly.filter((w) => w.dayOfWeek === muscatDayOfWeek(isoDate))
    : weekly;
  return toIntervals(templateSpansForDate(isoDate, windows));
}

export interface ProviderScheduleInput {
  isoDate: string;
  weekly: ProviderWeeklyWindow[];
  extraShifts: ProviderExtraShift[];
}

/**
 * Where one provider is present on one Muscat day, per branch.
 *
 * presence = (weekly shifts − weekly breaks − minutes covered by extra
 * shifts) ∪ extra shifts. Because an extra shift replaces the template for
 * its minutes, a provider can never come out present in two branches at the
 * same instant, and no minute of coverage is lost at the seams.
 */
export function materializeProviderPresence(input: ProviderScheduleInput): ProviderPresence[] {
  const { isoDate, weekly, extraShifts } = input;
  const extraSpans = normalise(
    extraShifts.map((e) => ({ start: e.startUtc.getTime(), end: e.endUtc.getTime() })),
  );
  const breakSpans = templateSpansForDate(
    isoDate,
    weekly.filter((w) => w.kind === 'break'),
  );

  const branches = [...new Set(weekly.filter((w) => w.kind === 'shift').map((w) => w.branchId))];
  const presence: ProviderPresence[] = [];
  for (const branchId of branches) {
    const shifts = templateSpansForDate(
      isoDate,
      weekly.filter((w) => w.kind === 'shift' && w.branchId === branchId),
    );
    for (const span of subtract(subtract(shifts, breakSpans), extraSpans)) {
      presence.push({ branchId, startUtc: new Date(span.start), endUtc: new Date(span.end) });
    }
  }

  const dayStart = dayStartMs(isoDate);
  const dayEnd = dayStart + MINUTES_PER_DAY * MINUTE_MS;
  for (const extra of extraShifts) {
    const start = Math.max(extra.startUtc.getTime(), dayStart);
    const end = Math.min(extra.endUtc.getTime(), dayEnd);
    if (end > start) {
      presence.push({ branchId: extra.branchId, startUtc: new Date(start), endUtc: new Date(end) });
    }
  }

  return presence.sort(
    (a, b) => a.startUtc.getTime() - b.startUtc.getTime() || a.branchId.localeCompare(b.branchId),
  );
}

/**
 * Intersection of branch opening hours and provider presence in that branch —
 * the bookable input windows a later slice will place appointments into.
 */
export function intersectIntervals(a: UtcInterval[], b: UtcInterval[]): UtcInterval[] {
  const left = normalise(a.map((i) => ({ start: i.startUtc.getTime(), end: i.endUtc.getTime() })));
  const right = normalise(b.map((i) => ({ start: i.startUtc.getTime(), end: i.endUtc.getTime() })));
  const out: Span[] = [];
  for (const x of left) {
    for (const y of right) {
      const start = Math.max(x.start, y.start);
      const end = Math.min(x.end, y.end);
      if (end > start) out.push({ start, end });
    }
  }
  return toIntervals(normalise(out));
}
