import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/lib/pool';

const DB_PACKAGE_DIR = fileURLToPath(new URL('../../../packages/db', import.meta.url));

/**
 * Runs the REAL seed script against the test database, then proves the
 * seed invariant with SQL: every booking references a service its branch
 * actually offers, and its price/duration/buffer snapshots equal the
 * offering effective at the booking's start instant.
 */
describe('seed invariants', () => {
  beforeAll(() => {
    execFileSync('npx', ['tsx', 'src/seed.ts'], {
      cwd: DB_PACKAGE_DIR,
      env: {
        ...process.env,
        DATABASE_URL: process.env.DATABASE_URL,
        SEED_CONFIRM: 'wipe',
      },
      stdio: 'pipe',
      timeout: 120_000,
    });
  }, 120_000);

  afterAll(async () => {
    await closePool();
  });

  it('seeds a non-trivial dataset', async () => {
    const counts = await getPool().query<{ bookings: number; offerings: number }>(
      `SELECT (SELECT count(*)::int FROM bookings) AS bookings,
              (SELECT count(*)::int FROM branch_service_offerings) AS offerings`,
    );
    expect(counts.rows[0]!.bookings).toBeGreaterThan(100);
    expect(counts.rows[0]!.offerings).toBeGreaterThan(50);
  });

  it('every booking matches an offering effective in its branch at its start time', async () => {
    const orphans = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM bookings b
       WHERE NOT EXISTS (
         SELECT 1 FROM branch_service_offerings o
         WHERE o.branch_id = b.branch_id
           AND o.service_id = b.service_id
           AND o.valid_during @> b.starts_at
       )`,
    );
    expect(orphans.rows[0]!.n).toBe(0);
  });

  it('seeds scheduling inputs for every branch and provider', async () => {
    const counts = await getPool().query<{
      hours: number;
      branches_without_hours: number;
      assignments: number;
      shifts: number;
      extras: number;
    }>(
      `SELECT (SELECT count(*)::int FROM branch_weekly_windows) AS hours,
              (SELECT count(*)::int FROM branches b
                 WHERE NOT EXISTS (SELECT 1 FROM branch_weekly_windows w WHERE w.branch_id = b.id))
                AS branches_without_hours,
              (SELECT count(*)::int FROM provider_branch_assignments) AS assignments,
              (SELECT count(*)::int FROM provider_weekly_windows WHERE kind = 'shift') AS shifts,
              (SELECT count(*)::int FROM provider_extra_shifts) AS extras`,
    );
    const row = counts.rows[0]!;
    expect(row.branches_without_hours).toBe(0);
    expect(row.hours).toBeGreaterThan(70);
    expect(row.assignments).toBeGreaterThan(150);
    expect(row.shifts).toBeGreaterThan(500);
    expect(row.extras).toBeGreaterThan(0);
  });

  it('every seeded break lies inside one of that provider\'s own shifts', async () => {
    // The database cannot state this containment across rows of one table,
    // so the seed has to be right and the invariant checked here.
    const strays = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM provider_weekly_windows b
       WHERE b.kind = 'break'
         AND NOT EXISTS (
           SELECT 1 FROM provider_weekly_windows s
           WHERE s.employee_id = b.employee_id
             AND s.kind = 'shift'
             AND s.valid_dates && b.valid_dates
             AND s.week_spans @> b.week_spans
         )`,
    );
    expect(strays.rows[0]!.n).toBe(0);
  });

  it('every seeded shift happens in a branch that provider is assigned to', async () => {
    const unassigned = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM provider_weekly_windows w
       WHERE NOT EXISTS (
         SELECT 1 FROM provider_branch_assignments a
         WHERE a.employee_id = w.employee_id
           AND a.branch_id = w.branch_id
           AND a.valid_dates && w.valid_dates
       )`,
    );
    expect(unassigned.rows[0]!.n).toBe(0);
  });

  it('every booking snapshot equals its effective offering (price, duration, buffers)', async () => {
    const mismatches = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM bookings b
       JOIN branch_service_offerings o
         ON o.branch_id = b.branch_id
        AND o.service_id = b.service_id
        AND o.valid_during @> b.starts_at
       WHERE b.price_baisa <> o.price_baisa
          OR b.duration_min_snapshot <> o.duration_min
          OR b.buffer_before_min_snapshot <> o.buffer_before_min
          OR b.buffer_after_min_snapshot <> o.buffer_after_min`,
    );
    expect(mismatches.rows[0]!.n).toBe(0);
  });
});
