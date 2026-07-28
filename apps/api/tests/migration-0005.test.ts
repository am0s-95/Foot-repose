import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabaseTo, runMigrations } from '@foot-repose/db/testing';
import { closePool, getPool } from '../src/lib/pool';

/**
 * Upgrade-path proof: a database standing at 0004 with real bookings is
 * migrated to 0005. Scheduling inputs are NEW tables — nothing is inferred,
 * backfilled or guessed for them — so the upgrade must leave every existing
 * booking untouched and every new table empty.
 */
describe('migration 0005 on an existing database', () => {
  let bookingsBefore = 0;

  beforeAll(async () => {
    const pool = getPool();
    await resetDatabaseTo(pool, '0004_branch_service_catalog.sql');

    const branch = (
      await pool.query<{ id: string }>(
        "INSERT INTO branches (code, name, area, phone) VALUES ('UP5', 'Upgrade Branch', 'Upgrade', '+968 24000005') RETURNING id",
      )
    ).rows[0]!.id;
    const customer = (
      await pool.query<{ id: string }>(
        "INSERT INTO customers (full_name, phone) VALUES ('Upgrade Customer', '+968 90999995') RETURNING id",
      )
    ).rows[0]!.id;
    const service = (
      await pool.query<{ id: string }>(
        "INSERT INTO services (name, duration_min, price_baisa) VALUES ('Upgrade Service', 45, 8000) RETURNING id",
      )
    ).rows[0]!.id;
    const start = Date.parse('2026-07-20T10:00:00Z');
    await pool.query(
      `INSERT INTO bookings
         (branch_id, customer_id, service_id, status, starts_at, ends_at, price_baisa,
          service_name_snapshot, duration_min_snapshot, buffer_before_min_snapshot, buffer_after_min_snapshot)
       VALUES ($1, $2, $3, 'completed', $4, $5, 8000, 'Upgrade Service', 45, 0, 10)`,
      [branch, customer, service, new Date(start), new Date(start + 45 * 60_000)],
    );
    bookingsBefore = Number(
      (await pool.query<{ n: string }>('SELECT count(*) AS n FROM bookings')).rows[0]!.n,
    );

    await runMigrations(pool); // applies 0005 on top
  });

  afterAll(async () => {
    await closePool();
  });

  it('creates every scheduling-input table and leaves them empty', async () => {
    const counts = await getPool().query<{ table_name: string; n: number }>(
      `SELECT 'branch_weekly_windows' AS table_name, count(*)::int AS n FROM branch_weekly_windows
       UNION ALL SELECT 'branch_hours_overrides', count(*)::int FROM branch_hours_overrides
       UNION ALL SELECT 'branch_hours_override_windows', count(*)::int FROM branch_hours_override_windows
       UNION ALL SELECT 'provider_branch_assignments', count(*)::int FROM provider_branch_assignments
       UNION ALL SELECT 'provider_service_qualifications', count(*)::int FROM provider_service_qualifications
       UNION ALL SELECT 'provider_weekly_windows', count(*)::int FROM provider_weekly_windows
       UNION ALL SELECT 'provider_extra_shifts', count(*)::int FROM provider_extra_shifts
       ORDER BY table_name`,
    );
    expect(counts.rows).toHaveLength(7);
    expect(counts.rows.every((row) => row.n === 0)).toBe(true);
  });

  it('leaves existing bookings exactly as they were', async () => {
    const after = await getPool().query<{ n: string; snapshot: string; duration: number }>(
      `SELECT (SELECT count(*) FROM bookings) AS n,
              service_name_snapshot AS snapshot, duration_min_snapshot AS duration
       FROM bookings ORDER BY starts_at LIMIT 1`,
    );
    expect(Number(after.rows[0]!.n)).toBe(bookingsBefore);
    expect(after.rows[0]!.snapshot).toBe('Upgrade Service');
    expect(after.rows[0]!.duration).toBe(45);
  });

  it('reads today in Muscat, not in UTC', async () => {
    const row = await getPool().query<{ muscat: string; utc: string }>(
      "SELECT muscat_today()::text AS muscat, (statement_timestamp() at time zone 'UTC')::date::text AS utc",
    );
    const { muscat, utc } = row.rows[0]!;
    // Muscat is UTC+4, so its date is the UTC date or one day ahead.
    const diffDays = (Date.parse(`${muscat}T00:00:00Z`) - Date.parse(`${utc}T00:00:00Z`)) / 86_400_000;
    expect([0, 1]).toContain(diffDays);
  });
});
