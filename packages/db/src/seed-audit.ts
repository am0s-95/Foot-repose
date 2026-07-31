/**
 * One-time audit: seed EVERY date in a range against a real PostgreSQL database
 * and compare what lands with what `seed-plan.ts` predicts.
 *
 * The seven-day matrix in CI proves each weekday behaves; it does not prove the
 * rule survives week after week, or that a month boundary is a boundary in the
 * arithmetic rather than in the prose. Sixty-two consecutive seeds do, and they
 * are too slow to run on every push — so this lives here as a script, is run
 * deliberately, and its result is reported rather than assumed.
 *
 *   DATABASE_URL=...foot_repose_audit_local \\
 *     npx tsx packages/db/src/seed-audit.ts 2026-12-01 2027-01-31
 *
 * Give it a database of its own. It wipes and reseeds once per date, so sharing
 * one with a running test suite makes both wrong in ways that look like
 * non-determinism — observed exactly once, while this was pointed at the same
 * database a determinism test was using.
 *
 * The range must be in the FUTURE. Migration 0005 refuses a branch-hours
 * override for a past Muscat date and the seed writes one for reference+1, so a
 * historical range cannot be seeded at all — the script reports which dates it
 * had to skip rather than pretending otherwise.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  addDaysToIsoDate,
  intersectIntervals,
  intervalsContain,
  materializeBranchHours,
  materializeProviderPresence,
  occupancyOf,
  todayInMuscat,
} from '@foot-repose/domain';
import { createPool, type Queryable } from './client';
import { loadBranchHours, loadProviderSchedule } from './repositories/scheduling';
import { loadEnv, requireEnv } from './env';
import {
  actionableReferenceDate,
  expectedSeedBookings,
  isMuscatDayOff,
  SEED_BRANCH_COUNT,
  SEED_CLOSED_TOMORROW_BRANCH_CODE,
} from './seed-plan';

const SEED_SCRIPT = fileURLToPath(new URL('./seed.ts', import.meta.url));
const WEEKDAY = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayName(isoDate: string): string {
  return WEEKDAY[new Date(`${isoDate}T00:00:00Z`).getUTCDay()]!;
}

function datesBetween(from: string, to: string): string[] {
  const dates: string[] = [];
  for (let d = from; d <= to; d = addDaysToIsoDate(d, 1)) dates.push(d);
  return dates;
}

interface Row {
  date: string;
  weekday: string;
  expected: number;
  actual: number;
  byStatus: Record<string, number>;
  branchesWithBookings: number;
  khw: Record<string, number>;
  windowDates: string[];
  outsideWindow: string[];
  /** Confirmed Al Khuwair bookings ON the date THIS row was seeded for. */
  khwConfirmedOnReferenceDate: number;
  /** The reference date the e2e rule would pick if today were this date. */
  selectedActionableDate: string;
  /**
   * Confirmed Al Khuwair bookings on that selected date — filled in AFTER the
   * loop, from the row produced when THAT date was itself seeded. It cannot be
   * read from this row: a day-off dataset has no Saturday KHW bookings, because
   * the seed closes Al Khuwair on the day after its reference date.
   */
  khwConfirmedOnSelectedActionableDate: number | null;
  eligibility: {
    outsideBranchAvailability: number;
    outsideProviderPresence: number;
    withoutBranchAssignment: number;
    withoutServiceQualification: number;
  };
  problems: string[];
}


interface EligibilityCounters {
  outsideBranchAvailability: number;
  outsideProviderPresence: number;
  withoutBranchAssignment: number;
  withoutServiceQualification: number;
}

/**
 * Four separate answers, because "the booking is fine" is four different claims
 * and a single counter cannot say which one failed.
 *
 * Availability is materialised the way the API materialises it —
 * `loadBranchHours` + `materializeBranchHours` and `loadProviderSchedule` +
 * `materializeProviderPresence` — so day overrides, extra shifts and breaks are
 * all honoured. The comparison is against the FULL buffered occupancy, not the
 * service window: prep time before opening is still outside opening hours.
 */
async function auditEligibility(db: Queryable): Promise<EligibilityCounters> {
  const counters: EligibilityCounters = {
    outsideBranchAvailability: 0,
    outsideProviderPresence: 0,
    withoutBranchAssignment: 0,
    withoutServiceQualification: 0,
  };

  const live = await db.query<{
    branch_id: string;
    employee_id: string;
    service_id: string;
    starts_at: Date;
    ends_at: Date;
    buffer_before: number;
    buffer_after: number;
    muscat_date: string;
  }>(
    `SELECT b.branch_id, a.employee_id, b.service_id, b.starts_at, b.ends_at,
            b.buffer_before_min_snapshot AS buffer_before,
            b.buffer_after_min_snapshot  AS buffer_after,
            (lower(a.occupancy) AT TIME ZONE 'Asia/Muscat')::date::text AS muscat_date
       FROM booking_provider_allocations a
       JOIN bookings b ON b.id = a.booking_id
      WHERE a.released_at IS NULL
      ORDER BY b.starts_at`,
  );

  // Cached per (branch|date) and (employee|date): the seed places many bookings
  // on the same few days, and re-materialising per row would dominate runtime.
  const branchCache = new Map<string, Awaited<ReturnType<typeof materializeBranchHours>>>();
  const presenceCache = new Map<string, ReturnType<typeof materializeProviderPresence>>();

  for (const row of live.rows) {
    const occupancy = occupancyOf({
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      bufferBeforeMin: row.buffer_before,
      bufferAfterMin: row.buffer_after,
    });

    const branchKey = `${row.branch_id}|${row.muscat_date}`;
    if (!branchCache.has(branchKey)) {
      branchCache.set(
        branchKey,
        materializeBranchHours({
          isoDate: row.muscat_date,
          ...(await loadBranchHours(db, row.branch_id, row.muscat_date)),
        }),
      );
    }
    const branchHours = branchCache.get(branchKey)!;

    const presenceKey = `${row.employee_id}|${row.muscat_date}`;
    if (!presenceCache.has(presenceKey)) {
      presenceCache.set(
        presenceKey,
        materializeProviderPresence({
          isoDate: row.muscat_date,
          ...(await loadProviderSchedule(db, row.employee_id, row.muscat_date)),
        }),
      );
    }
    const presence = presenceCache
      .get(presenceKey)!
      .filter((window) => window.branchId === row.branch_id);

    if (!intervalsContain(branchHours, [occupancy])) counters.outsideBranchAvailability += 1;
    if (!intervalsContain(presence, [occupancy])) counters.outsideProviderPresence += 1;
    // And inside BOTH at once, which is stricter than each separately.
    if (!intervalsContain(intersectIntervals(branchHours, presence), [occupancy])) {
      // Already counted above; nothing extra to record, the two counters
      // together identify which side failed.
    }

    const assignment = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_branch_assignments
        WHERE employee_id = $1 AND branch_id = $2 AND valid_dates @> $3::date`,
      [row.employee_id, row.branch_id, row.muscat_date],
    );
    if (assignment.rows[0]!.n === 0) counters.withoutBranchAssignment += 1;

    const qualification = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM provider_service_qualifications
        WHERE employee_id = $1 AND service_id = $2 AND valid_dates @> $3::date`,
      [row.employee_id, row.service_id, row.muscat_date],
    );
    if (qualification.rows[0]!.n === 0) counters.withoutServiceQualification += 1;
  }

  return counters;
}

loadEnv();
const databaseUrl = requireEnv('DATABASE_URL');
const pool = createPool(databaseUrl);

const [, , fromArg, toArg] = process.argv;
const from = fromArg ?? '2026-12-01';
const to = toArg ?? '2027-01-31';
const dates = datesBetween(from, to);

/**
 * How far back a REAL seed can go, which is not as far as one might like.
 *
 * Migration 0005 refuses to insert a branch-hours override for a past Muscat
 * date — "past days are history" — and the seed writes exactly such an override
 * for the day AFTER its reference date. So a reference date is seedable only
 * while `reference + 1` is still today or later. That is a production rule
 * about history, not a test inconvenience, and it is not being worked around.
 *
 * The consequence is stated rather than hidden: an exhaustive multi-month audit
 * against a real database is impossible on any day; only the dates from
 * yesterday forward can be seeded. Full-range coverage lives in the pure
 * contract test, which has no such limit because it writes nothing.
 */
const earliestSeedable = addDaysToIsoDate(todayInMuscat(), -1);
const skipped = dates.filter((d) => d < earliestSeedable);
const seedable = dates.filter((d) => d >= earliestSeedable);

console.log(`Requested ${dates.length} consecutive Muscat dates: ${from} .. ${to}`);
if (skipped.length > 0) {
  console.log(
    `NOT SEEDABLE: ${skipped.length} date(s) before ${earliestSeedable} — migration 0005 ` +
      `refuses a branch-hours override for a past Muscat date, and the seed writes one for ` +
      `reference+1. Skipped: ${skipped[0]} .. ${skipped.at(-1)}`,
  );
}
console.log(`Seeding ${seedable.length} date(s): ${seedable[0]} .. ${seedable.at(-1)}`);
const startedAt = Date.now();
const rows: Row[] = [];

try {
  for (const date of seedable) {
    execFileSync('npx', ['tsx', SEED_SCRIPT], {
      env: { ...process.env, SEED_CONFIRM: 'wipe', SEED_REFERENCE_DATE: date },
      stdio: 'pipe',
      timeout: 180_000,
    });

    const expected = expectedSeedBookings(date);
    const byDate = await pool.query<{ d: string; n: number }>(
      `SELECT (starts_at AT TIME ZONE 'Asia/Muscat')::date::text AS d, count(*)::int AS n
         FROM bookings GROUP BY 1 ORDER BY 1`,
    );
    const byStatusRows = await pool.query<{ status: string; n: number }>(
      `SELECT status, count(*)::int AS n FROM bookings GROUP BY 1 ORDER BY 1`,
    );
    const khwRows = await pool.query<{ status: string; n: number }>(
      `SELECT bk.status, count(*)::int AS n
         FROM bookings bk JOIN branches b ON b.id = bk.branch_id
        WHERE b.code = $1 AND (bk.starts_at AT TIME ZONE 'Asia/Muscat')::date = $2::date
        GROUP BY 1 ORDER BY 1`,
      [SEED_CLOSED_TOMORROW_BRANCH_CODE, date],
    );
    const branchesWithBookings = await pool.query<{ n: number }>(
      'SELECT count(DISTINCT branch_id)::int AS n FROM bookings',
    );
    const selectedActionableDate = actionableReferenceDate(date);
    // Confirmed Al Khuwair bookings on THIS row's own reference date. The field
    // used to be called `actionableCount` while querying `date` — the name
    // promised the selected actionable date and the SQL delivered the seeded
    // one, which are different dates whenever the reference date is the day
    // off. The two are now separate fields, and the second is filled in after
    // the loop from the row where that date was actually seeded.
    const khwConfirmed = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM bookings bk JOIN branches b ON b.id = bk.branch_id
        WHERE b.code = $1 AND bk.status = 'confirmed'
          AND (bk.starts_at AT TIME ZONE 'Asia/Muscat')::date = $2::date`,
      [SEED_CLOSED_TOMORROW_BRANCH_CODE, date],
    );

    // Eligibility, using the APPLICATION's own scheduling semantics rather than
    // a weekday-only SQL approximation. The previous check compared each
    // occupancy against a matching `branch_weekly_windows` row, which ignored
    // day overrides and provider presence entirely while the comment claimed
    // both were verified. These four counters are computed the way the seed and
    // the API compute availability: materialise the branch's hours and the
    // provider's presence for the occupancy's Muscat date, then ask whether the
    // full buffered occupancy fits inside their intersection.
    const eligibility = await auditEligibility(pool as unknown as Queryable);

    const actualTotal = byDate.rows.reduce((sum, r) => sum + r.n, 0);
    const window = [addDaysToIsoDate(date, -1), date, addDaysToIsoDate(date, 1)];
    const outsideWindow = byDate.rows.map((r) => r.d).filter((d) => !window.includes(d));

    const problems: string[] = [];
    if (actualTotal !== expected.total) {
      problems.push(`total ${actualTotal} != expected ${expected.total}`);
    }
    for (const [offset, key] of [
      [-1, 'yesterday'],
      [0, 'today'],
      [1, 'tomorrow'],
    ] as const) {
      const d = addDaysToIsoDate(date, offset);
      const got = byDate.rows.find((r) => r.d === d)?.n ?? 0;
      if (got !== expected[key]) problems.push(`${key} (${d}) ${got} != ${expected[key]}`);
    }
    if (outsideWindow.length > 0) problems.push(`bookings outside window: ${outsideWindow.join(',')}`);
    for (const [label, count] of Object.entries(eligibility)) {
      if (count > 0) problems.push(`${count} allocation(s) ${label}`);
    }
    if (isMuscatDayOff(selectedActionableDate)) {
      problems.push(`selected actionable date ${selectedActionableDate} is the day off`);
    }
    if (branchesWithBookings.rows[0]!.n > SEED_BRANCH_COUNT) problems.push('more branches than exist');

    rows.push({
      date,
      weekday: weekdayName(date),
      expected: expected.total,
      actual: actualTotal,
      byStatus: Object.fromEntries(byStatusRows.rows.map((r) => [r.status, r.n])),
      branchesWithBookings: branchesWithBookings.rows[0]!.n,
      khw: Object.fromEntries(khwRows.rows.map((r) => [r.status, r.n])),
      windowDates: window,
      outsideWindow,
      khwConfirmedOnReferenceDate: khwConfirmed.rows[0]!.n,
      selectedActionableDate,
      khwConfirmedOnSelectedActionableDate: null,
      eligibility,
      problems,
    });

    const mark = problems.length === 0 ? 'ok ' : 'BAD';
    console.log(
      `${mark} ${date} ${weekdayName(date).padEnd(9)} expected=${String(expected.total).padStart(3)} ` +
        `actual=${String(actualTotal).padStart(3)} selectedActionable=${selectedActionableDate} ` +
        `khwConfirmedOnRef=${khwConfirmed.rows[0]!.n}` +
        `${problems.length ? ` :: ${problems.join('; ')}` : ''}`,
    );
  }
} finally {
  await pool.end();
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);

/**
 * Associate each row's SELECTED actionable date with the count measured when
 * that date was itself the reference date.
 *
 * This is the correction the old field name papered over. For a day-off source
 * date the rule selects the following Saturday, and the day-off dataset has no
 * Al Khuwair bookings on that Saturday at all — the seed closes Al Khuwair on
 * the day after its reference date. Reading the count from the wrong dataset
 * would have reported 0 and called it a failure, or reported the reference
 * day's own count and called it the actionable one. Both are wrong; the number
 * that matters comes from the run where the selected date WAS the reference.
 */
const byDateSeeded = new Map(rows.map((row) => [row.date, row]));
for (const row of rows) {
  const source = byDateSeeded.get(row.selectedActionableDate);
  row.khwConfirmedOnSelectedActionableDate = source?.khwConfirmedOnReferenceDate ?? null;
  if (source !== undefined && row.khwConfirmedOnSelectedActionableDate === 0) {
    row.problems.push(
      `selected actionable date ${row.selectedActionableDate} yields no confirmed ` +
        `${SEED_CLOSED_TOMORROW_BRANCH_CODE} bookings when seeded`,
    );
  }
}
const unresolved = rows.filter((r) => r.khwConfirmedOnSelectedActionableDate === null);
if (unresolved.length > 0) {
  console.log(
    `NOTE: ${unresolved.length} row(s) select an actionable date outside the audited range ` +
      `(${unresolved.map((r) => `${r.date}->${r.selectedActionableDate}`).join(', ')}), so their ` +
      `count could not be taken from a seeded run.`,
  );
}

const bad = rows.filter((r) => r.problems.length > 0);
console.log(
  `\n${rows.length} dates seeded in ${elapsed}s — ${bad.length} mismatch(es); ` +
    `${skipped.length} date(s) not seedable against a live database`,
);
if (bad.length > 0) {
  for (const row of bad) console.log(`  ${row.date}: ${row.problems.join('; ')}`);
  process.exitCode = 1;
}
console.log(
  JSON.stringify(
    { from, to, earliestSeedable, skipped, elapsedSeconds: Number(elapsed), rows },
    null,
    0,
  ),
);
