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
 *   npx tsx packages/db/src/seed-audit.ts 2026-07-01 2026-08-31
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { addDaysToIsoDate, todayInMuscat } from '@foot-repose/domain';
import { createPool } from './client';
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
  actionableDate: string;
  actionableCount: number;
  problems: string[];
}

loadEnv();
const databaseUrl = requireEnv('DATABASE_URL');
const pool = createPool(databaseUrl);

const [, , fromArg, toArg] = process.argv;
const from = fromArg ?? '2026-07-01';
const to = toArg ?? '2026-08-31';
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
    const actionableDate = actionableReferenceDate(date);
    // What the e2e test would find IF this date were the reference: the
    // actionable day is only meaningful for the date the seed was built around.
    const actionable = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM bookings bk JOIN branches b ON b.id = bk.branch_id
        WHERE b.code = $1 AND bk.status = 'confirmed'
          AND (bk.starts_at AT TIME ZONE 'Asia/Muscat')::date = $2::date`,
      [SEED_CLOSED_TOMORROW_BRANCH_CODE, date],
    );
    // Availability: every allocated occupancy must sit inside the branch's
    // opening hours AND the provider's presence. Checked in SQL against the
    // materialised inputs the API itself reads.
    const outsideAvailability = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n
         FROM booking_provider_allocations a
         JOIN bookings b ON b.id = a.booking_id
        WHERE a.released_at IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM branch_weekly_windows w
             WHERE w.branch_id = b.branch_id
               AND w.valid_dates @> (lower(a.occupancy) AT TIME ZONE 'Asia/Muscat')::date
               AND w.day_of_week =
                   EXTRACT(DOW FROM (lower(a.occupancy) AT TIME ZONE 'Asia/Muscat'))::int
          )`,
    );

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
    if (outsideAvailability.rows[0]!.n > 0) {
      problems.push(`${outsideAvailability.rows[0]!.n} allocation(s) outside branch availability`);
    }
    if (isMuscatDayOff(actionableDate)) problems.push(`actionable date ${actionableDate} is the day off`);
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
      actionableDate,
      actionableCount: actionable.rows[0]!.n,
      problems,
    });

    const mark = problems.length === 0 ? 'ok ' : 'BAD';
    console.log(
      `${mark} ${date} ${weekdayName(date).padEnd(9)} expected=${String(expected.total).padStart(3)} ` +
        `actual=${String(actualTotal).padStart(3)} actionable=${actionableDate} ` +
        `khwConfirmed=${actionable.rows[0]!.n}${problems.length ? ` :: ${problems.join('; ')}` : ''}`,
    );
  }
} finally {
  await pool.end();
}

const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
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
