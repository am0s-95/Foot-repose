import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { todayInMuscat } from '@foot-repose/domain';
import { closePool, getPool } from '../src/lib/pool';

const DB_PACKAGE_DIR = fileURLToPath(new URL('../../../packages/db', import.meta.url));

/**
 * Reseeding the same reference date must produce the same dataset — the WHOLE
 * dataset, not just a total.
 *
 * An exact expected count is only as good as the determinism under it. If two
 * runs of the same date could differ in which provider took which slot, the new
 * assertions would be a coincidence that happens to hold, and the next change
 * to placement order would look like a regression somewhere else entirely.
 *
 * DELIBERATELY EXCLUDED FROM THE SNAPSHOT: primary keys. `bookings.id`,
 * allocation ids, customer ids and employee ids are `gen_random_uuid()` and are
 * expected to differ between runs — the seed makes no claim about them and
 * nothing depends on their values. Everything that carries meaning is compared:
 * branch, provider, service, status, and the exact start and end instants.
 */
const REFERENCE_DATES = [
  '2026-07-30',
  '2026-07-31',
  '2026-08-01',
  '2026-08-02',
  '2026-08-31',
] as const;

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

interface Snapshot {
  bookings: string[];
  perBranch: Record<string, number>;
  perStatus: Record<string, number>;
}

async function snapshot(): Promise<Snapshot> {
  const pool = getPool();
  // Ordered by the booking's own identity-free fields, so the comparison does
  // not depend on insertion order or on any generated id.
  const bookings = await pool.query<{ row: string }>(
    `SELECT b.code || '|' || e.email || '|' || s.name || '|' || bk.status || '|'
            || to_char(bk.starts_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') || '|'
            || to_char(bk.ends_at   AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS row
       FROM bookings bk
       JOIN branches b ON b.id = bk.branch_id
       JOIN services s ON s.id = bk.service_id
       JOIN booking_provider_allocations a ON a.booking_id = bk.id
       JOIN employees e ON e.id = a.employee_id
      ORDER BY 1`,
  );
  const perBranch = await pool.query<{ code: string; n: number }>(
    `SELECT b.code, count(*)::int AS n FROM bookings bk
       JOIN branches b ON b.id = bk.branch_id GROUP BY 1 ORDER BY 1`,
  );
  const perStatus = await pool.query<{ status: string; n: number }>(
    'SELECT status, count(*)::int AS n FROM bookings GROUP BY 1 ORDER BY 1',
  );
  return {
    bookings: bookings.rows.map((r) => r.row),
    perBranch: Object.fromEntries(perBranch.rows.map((r) => [r.code, r.n])),
    perStatus: Object.fromEntries(perStatus.rows.map((r) => [r.status, r.n])),
  };
}

afterAll(async () => {
  await closePool();
});

describe('reseeding the same reference date reproduces the same dataset', () => {
  it.each(REFERENCE_DATES)(
    '%s is byte-identical across two seeds, ids aside',
    async (referenceDate) => {
      seedFor(referenceDate);
      const first = await snapshot();
      seedFor(referenceDate);
      const second = await snapshot();

      // Branch, provider, service, status and both instants, for every booking.
      expect(second.bookings).toEqual(first.bookings);
      expect(second.perBranch).toEqual(first.perBranch);
      expect(second.perStatus).toEqual(first.perStatus);
      // A non-empty snapshot, so an empty-equals-empty pass is impossible —
      // except on the day off, which legitimately seeds nothing on the day
      // itself and is covered by the weekday matrix.
      expect(first.bookings.length).toBeGreaterThan(0);
    },
    600_000,
  );

  it('cannot seed a reference date whose tomorrow is already past', () => {
    // Not a limitation of these tests: migration 0005 refuses a branch-hours
    // override for a past Muscat date ("past days are history"), and the seed
    // writes one for reference+1. So an arbitrary historical date is NOT
    // seedable against a live database, and any multi-month audit that claims
    // to have seeded one is wrong. 2026-07-01 is in that category.
    const earliestSeedable = todayInMuscat();
    expect(() => seedFor('2020-01-01')).toThrow();
    expect(earliestSeedable > '2020-01-02').toBe(true);
  }, 180_000);
});
