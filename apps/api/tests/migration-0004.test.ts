import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabaseTo, runMigrations } from '@foot-repose/db/testing';
import { closePool, getPool } from '../src/lib/pool';

/**
 * Upgrade-path proof: a database standing at 0003 with real bookings is
 * migrated to 0004. Row count must be preserved, duration snapshots must
 * come from each booking's own scheduled window (NOT the mutable
 * services.duration_min), and buffers must equal the approved 0/10
 * transition policy.
 */
describe('migration 0004 backfill on an existing database', () => {
  beforeAll(async () => {
    const pool = getPool();
    await resetDatabaseTo(pool, '0003_login_rate_limits.sql');

    const branch = (
      await pool.query<{ id: string }>(
        "INSERT INTO branches (code, name, area, phone) VALUES ('UPG', 'Upgrade Branch', 'Upgrade Branch', '+968 24000009') RETURNING id",
      )
    ).rows[0]!.id;
    const customer = (
      await pool.query<{ id: string }>(
        "INSERT INTO customers (full_name, phone) VALUES ('Upgrade Customer', '+968 90999999') RETURNING id",
      )
    ).rows[0]!.id;
    // The service SAYS 45 minutes, but the bookings below were scheduled
    // for 50 and 30 minutes — the snapshot must trust the booking window.
    const service = (
      await pool.query<{ id: string }>(
        "INSERT INTO services (name, duration_min, price_baisa) VALUES ('Legacy Service', 45, 8000) RETURNING id",
      )
    ).rows[0]!.id;
    const base = Date.parse('2026-07-20T10:00:00Z');
    const insertLegacyBooking = (startMs: number, minutes: number) =>
      pool.query(
        `INSERT INTO bookings (branch_id, customer_id, service_id, status, starts_at, ends_at, price_baisa)
         VALUES ($1, $2, $3, 'completed', $4, $5, 8000)`,
        [branch, customer, service, new Date(startMs), new Date(startMs + minutes * 60_000)],
      );
    await insertLegacyBooking(base, 50);
    await insertLegacyBooking(base + 2 * 60 * 60_000, 30);

    await runMigrations(pool); // applies 0004 on top
  });

  afterAll(async () => {
    await closePool();
  });

  it('preserves every booking and derives duration from the booking window', async () => {
    const rows = await getPool().query<{
      duration_min_snapshot: number;
      service_name_snapshot: string;
      buffer_before_min_snapshot: number;
      buffer_after_min_snapshot: number;
    }>(
      `SELECT duration_min_snapshot, service_name_snapshot,
              buffer_before_min_snapshot, buffer_after_min_snapshot
       FROM bookings ORDER BY starts_at`,
    );
    expect(rows.rowCount).toBe(2);
    expect(rows.rows[0]).toEqual({
      duration_min_snapshot: 50,
      service_name_snapshot: 'Legacy Service',
      buffer_before_min_snapshot: 0,
      buffer_after_min_snapshot: 10,
    });
    expect(rows.rows[1]!.duration_min_snapshot).toBe(30);
  });

  it('locks snapshots NOT NULL with no silent defaults for new rows', async () => {
    const pool = getPool();
    const meta = await pool.query<{ column_name: string; column_default: string | null; is_nullable: string }>(
      `SELECT column_name, column_default, is_nullable
       FROM information_schema.columns
       WHERE table_name = 'bookings' AND column_name LIKE '%snapshot'`,
    );
    expect(meta.rowCount).toBe(4);
    for (const column of meta.rows) {
      expect(column.is_nullable).toBe('NO');
      expect(column.column_default).toBeNull();
    }

    // A new booking that omits snapshots must be rejected by PostgreSQL.
    const ids = await pool.query<{ b: string; c: string; s: string }>(
      `SELECT (SELECT id FROM branches LIMIT 1) AS b,
              (SELECT id FROM customers LIMIT 1) AS c,
              (SELECT id FROM services LIMIT 1) AS s`,
    );
    const { b, c, s } = ids.rows[0]!;
    let code: string | undefined;
    try {
      await pool.query(
        `INSERT INTO bookings (branch_id, customer_id, service_id, status, starts_at, ends_at, price_baisa)
         VALUES ($1, $2, $3, 'confirmed', now(), now() + interval '45 minutes', 8000)`,
        [b, c, s],
      );
    } catch (error) {
      code = (error as { code?: string }).code;
    }
    expect(code).toBe('23502'); // not_null_violation
  });
});
