import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { addDaysToIsoDate } from '@foot-repose/domain';
import {
  actionableDayOffset,
  actionableReferenceDate,
  expectedSeedBookings,
  isMuscatDayOff,
  SEED_BRANCH_COUNT,
  SEED_CLOSED_TOMORROW_BRANCH_CODE,
  SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY,
} from '@foot-repose/db';
import { closePool, getPool } from '../src/lib/pool';

const DB_PACKAGE_DIR = fileURLToPath(new URL('../../../packages/db', import.meta.url));

/**
 * Every Muscat weekday, on demand, whatever day it happens to be.
 *
 * This is the test that would have caught the defect. The suite was green for
 * months and then failed on a Friday with nothing changed, because the only
 * weekday ever exercised was the one the runner happened to start on. CI runs
 * whenever it runs; the seed's behaviour on the other six days was simply never
 * observed.
 *
 * So all seven reference dates are seeded here, in one place, with Friday — the
 * weekly day off, and the day that produces NO bookings at all — and Saturday
 * given their own named assertions rather than being folded into a loop and
 * forgotten.
 */
const WEEK: { date: string; weekday: string }[] = [
  { date: '2026-08-02', weekday: 'Sunday' },
  { date: '2026-08-03', weekday: 'Monday' },
  { date: '2026-08-04', weekday: 'Tuesday' },
  { date: '2026-08-05', weekday: 'Wednesday' },
  { date: '2026-07-30', weekday: 'Thursday' },
  { date: '2026-07-31', weekday: 'Friday' },
  { date: '2026-08-01', weekday: 'Saturday' },
];

function seedFor(referenceDate: string): void {
  execFileSync('npx', ['tsx', 'src/seed.ts'], {
    cwd: DB_PACKAGE_DIR,
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL,
      SEED_CONFIRM: 'wipe',
      SEED_REFERENCE_DATE: referenceDate,
    },
    stdio: 'pipe',
    timeout: 180_000,
  });
}

async function bookingsByMuscatDate(): Promise<Record<string, number>> {
  const result = await getPool().query<{ d: string; n: number }>(
    `SELECT (starts_at AT TIME ZONE 'Asia/Muscat')::date::text AS d, count(*)::int AS n
       FROM bookings GROUP BY 1 ORDER BY 1`,
  );
  return Object.fromEntries(result.rows.map((row) => [row.d, row.n]));
}

async function total(): Promise<number> {
  const result = await getPool().query<{ n: number }>('SELECT count(*)::int AS n FROM bookings');
  return result.rows[0]!.n;
}

afterAll(async () => {
  await closePool();
});

describe('the seed is deterministic on every Muscat weekday', () => {
  it.each(WEEK)(
    'seeds $weekday ($date) to exactly the predicted total',
    async ({ date }) => {
      seedFor(date);
      const expected = expectedSeedBookings(date);
      expect(await total()).toBe(expected.total);

      const byDate = await bookingsByMuscatDate();
      // Not just the total: each of the three days lands where the rule says.
      expect(byDate[addDaysToIsoDate(date, -1)] ?? 0).toBe(expected.yesterday);
      expect(byDate[date] ?? 0).toBe(expected.today);
      expect(byDate[addDaysToIsoDate(date, 1)] ?? 0).toBe(expected.tomorrow);

      // Nothing outside the three-day window.
      const window = new Set([addDaysToIsoDate(date, -1), date, addDaysToIsoDate(date, 1)]);
      expect(Object.keys(byDate).filter((d) => !window.has(d))).toEqual([]);
    },
    300_000,
  );

  it('seeds no bookings at all on the weekly day off', async () => {
    // The specific fact that broke the old assertions, stated outright: Friday
    // is not "quieter", it is empty, because every roster omits it.
    const friday = '2026-07-31';
    expect(isMuscatDayOff(friday)).toBe(true);
    seedFor(friday);
    expect((await bookingsByMuscatDate())[friday] ?? 0).toBe(0);
    expect(await total()).toBe(95);
  }, 300_000);

  it('still seeds a full Saturday, which the old threshold nearly failed on', async () => {
    const saturday = '2026-08-01';
    seedFor(saturday);
    // 106: a working day whose YESTERDAY is the day off. Under the old
    // `> 100` assertion this passed by six bookings, for no stated reason.
    expect(await total()).toBe(106);
    expect((await bookingsByMuscatDate())[saturday] ?? 0).toBe(66);
  }, 300_000);

  it('gives the e2e branch an actionable reference day on every weekday', async () => {
    // Al Khuwair is the branch the seed CLOSES tomorrow, so "look at tomorrow
    // instead" is not an escape for it — the reference day itself has to work.
    for (const { date } of WEEK) {
      const reference = actionableReferenceDate(date);
      expect(isMuscatDayOff(reference)).toBe(false);
      expect(actionableDayOffset(date)).toBe(date === reference ? 0 : 1);
      expect(reference).toBe(
        date === reference ? date : addDaysToIsoDate(date, 1),
      );
    }
  });

  it.each(WEEK)(
    'leaves $weekday actionable for the e2e manager after the offset is applied',
    async ({ date }) => {
      const reference = actionableReferenceDate(date);
      seedFor(reference);
      const confirmed = await getPool().query<{ n: number }>(
        `SELECT count(*)::int AS n
           FROM bookings bk JOIN branches b ON b.id = bk.branch_id
          WHERE b.code = $1
            AND bk.status = 'confirmed'
            AND (bk.starts_at AT TIME ZONE 'Asia/Muscat')::date = $2::date`,
        [SEED_CLOSED_TOMORROW_BRANCH_CODE, reference],
      );
      // This is precisely the precondition the Playwright test needs, checked
      // for all seven possible "todays" without waiting for any of them.
      expect(confirmed.rows[0]!.n).toBe(SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY);
    },
    300_000,
  );

  it('keeps the fixed company shape on every reference date', async () => {
    const shape = await getPool().query<{ branches: number }>(
      'SELECT count(*)::int AS branches FROM branches',
    );
    expect(shape.rows[0]!.branches).toBe(SEED_BRANCH_COUNT);
  });
});
