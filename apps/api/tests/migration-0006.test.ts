import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { resetDatabaseTo, runMigrations } from '@foot-repose/db/testing';
import { closePool, getPool } from '../src/lib/pool';

/**
 * Upgrade path 0005 -> 0006 [14 / 15 / R6a / R6b].
 *
 * A database standing at 0005 with real bookings is migrated. What must NOT
 * happen is as important as what must: no physical resource and no requirement
 * set is invented for a pre-0006 booking, and no provider is invented where
 * `assigned_employee_id` was NULL.
 */
const NEW_TABLES = [
  'resource_types',
  'branch_resources',
  'branch_service_offering_resources',
  'booking_resource_requirement_sets',
  'booking_resource_requirements',
  'booking_resource_allocations',
];

interface Sentinels {
  branch: string;
  employee: string;
  withProvider: string;
  withoutProvider: string;
  cancelled: string;
}

async function seedAt0005(overrides: { bufferAfter?: number; durationHours?: number } = {}): Promise<Sentinels> {
  const pool = getPool();
  await resetDatabaseTo(pool, '0005_scheduling_inputs.sql');
  const one = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) =>
    (await pool.query<T>(sql, values)).rows[0]!;

  const branch = (
    await one<{ id: string }>(
      "INSERT INTO branches (code, name, area, phone) VALUES ('UP6', 'Upgrade', 'Upgrade', '+968 24000006') RETURNING id",
    )
  ).id;
  const employee = (
    await one<{ id: string }>(
      `INSERT INTO employees (email, password_hash, full_name, role)
       VALUES ('upgrade@test.example', 'x', 'Upgrade Provider', 'staff') RETURNING id`,
    )
  ).id;
  const customer = (
    await one<{ id: string }>(
      "INSERT INTO customers (full_name, phone) VALUES ('Upgrade Customer', '+968 90999996') RETURNING id",
    )
  ).id;
  const service = (
    await one<{ id: string }>(
      "INSERT INTO services (name, duration_min, price_baisa) VALUES ('Upgrade Service', 45, 8000) RETURNING id",
    )
  ).id;

  // A real 0005 database that used T5/T6 has these rows. The migration must
  // never invent them — the fixture supplies them, and a separate test proves
  // the migration aborts when they are missing.
  await pool.query(
    `INSERT INTO provider_branch_assignments (employee_id, branch_id, valid_dates)
     VALUES ($1, $2, daterange('2020-01-01'::date, NULL, '[)'))`,
    [employee, branch],
  );
  await pool.query(
    `INSERT INTO provider_service_qualifications (employee_id, service_id, valid_dates)
     VALUES ($1, $2, daterange('2020-01-01'::date, NULL, '[)'))`,
    [employee, service],
  );

  const insert = async (
    status: string,
    provider: string | null,
    startIso: string,
  ): Promise<string> => {
    const start = Date.parse(startIso);
    const hours = overrides.durationHours ?? 1;
    return (
      await one<{ id: string }>(
        `INSERT INTO bookings
           (branch_id, customer_id, service_id, assigned_employee_id, status, starts_at, ends_at,
            price_baisa, service_name_snapshot, duration_min_snapshot,
            buffer_before_min_snapshot, buffer_after_min_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 8000, 'Upgrade Service', 45, 0, $8)
         RETURNING id`,
        [
          branch,
          customer,
          service,
          provider,
          status,
          new Date(start),
          new Date(start + hours * 3_600_000),
          overrides.bufferAfter ?? 10,
        ],
      )
    ).id;
  };

  return {
    branch,
    employee,
    withProvider: await insert('confirmed', employee, '2026-07-20T10:00:00Z'),
    withoutProvider: await insert('confirmed', null, '2026-07-20T14:00:00Z'),
    cancelled: await insert('cancelled', employee, '2026-07-20T16:00:00Z'),
  };
}

afterAll(async () => {
  await closePool();
});

describe('migration 0006 on a database standing at 0005', () => {
  let sentinels: Sentinels;

  beforeEach(async () => {
    sentinels = await seedAt0005();
    await runMigrations(getPool());
  });

  it('[14] leaves every booking exactly as it was', async () => {
    const rows = await getPool().query<{ n: number; snapshot: string; duration: number }>(
      `SELECT (SELECT count(*)::int FROM bookings) AS n,
              service_name_snapshot AS snapshot, duration_min_snapshot AS duration
       FROM bookings ORDER BY starts_at LIMIT 1`,
    );
    expect(rows.rows[0]!.n).toBe(3);
    expect(rows.rows[0]!.snapshot).toBe('Upgrade Service');
    expect(rows.rows[0]!.duration).toBe(45);
  });

  it('[14] invents no resource, no requirement set and no provider', async () => {
    for (const table of NEW_TABLES) {
      const rows = await getPool().query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
      expect(`${table}=${rows.rows[0]!.n}`).toBe(`${table}=0`);
    }
    const noProvider = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM booking_provider_allocations WHERE booking_id = $1',
      [sentinels.withoutProvider],
    );
    expect(noProvider.rows[0]!.n).toBe(0);
  });

  it('[14] carries a stored assignment over, live for holding statuses', async () => {
    const rows = await getPool().query<{ employee_id: string; released: boolean }>(
      `SELECT employee_id, released_at IS NOT NULL AS released
       FROM booking_provider_allocations WHERE booking_id = $1`,
      [sentinels.withProvider],
    );
    expect(rows.rows[0]!.employee_id).toBe(sentinels.employee);
    expect(rows.rows[0]!.released).toBe(false);
  });

  it('[14 / A2.4] carries a cancelled booking over as ALREADY released, with a true window', async () => {
    const rows = await getPool().query<{
      released: boolean;
      reason: string;
      same: boolean;
    }>(
      `SELECT released_at IS NOT NULL AS released, release_reason AS reason,
              released_occupancy = occupancy AS same
       FROM booking_provider_allocations WHERE booking_id = $1`,
      [sentinels.cancelled],
    );
    expect(rows.rows[0]!.released).toBe(true);
    expect(rows.rows[0]!.reason).toBe('backfill_non_holding_status');
    expect(rows.rows[0]!.same).toBe(true);
  });

  it('drops the old column, leaving one source of truth', async () => {
    const rows = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'bookings' AND column_name = 'assigned_employee_id'`,
    );
    expect(rows.rows[0]!.n).toBe(0);
  });
});

describe('migration 0006 preflight [15 / R6a / R6b]', () => {
  const migrationFailure = async (): Promise<string> => {
    try {
      await runMigrations(getPool());
      return 'no error';
    } catch (error) {
      const cause = (error as { cause?: { message?: string } }).cause;
      return cause?.message ?? (error as Error).message;
    }
  };

  const assertNothingApplied = async (): Promise<void> => {
    const applied = await getPool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM schema_migrations WHERE version LIKE '0006%'",
    );
    expect(applied.rows[0]!.n).toBe(0);
    const tables = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = ANY($1::text[])`,
      [NEW_TABLES],
    );
    expect(tables.rows[0]!.n).toBe(0);
    // The old column is still there: nothing was half-migrated.
    const column = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_name = 'bookings' AND column_name = 'assigned_employee_id'`,
    );
    expect(column.rows[0]!.n).toBe(1);
  };

  it('[15] fails with a count and sample ids on a pre-existing double booking, and applies nothing', async () => {
    const sentinels = await seedAt0005();
    // A second confirmed booking for the same provider, overlapping the first.
    await getPool().query(
      `INSERT INTO bookings
         (branch_id, customer_id, service_id, assigned_employee_id, status, starts_at, ends_at,
          price_baisa, service_name_snapshot, duration_min_snapshot,
          buffer_before_min_snapshot, buffer_after_min_snapshot)
       SELECT branch_id, customer_id, service_id, $2, 'confirmed',
              starts_at + interval '30 minutes', ends_at + interval '30 minutes',
              price_baisa, service_name_snapshot, duration_min_snapshot,
              buffer_before_min_snapshot, buffer_after_min_snapshot
       FROM bookings WHERE id = $1`,
      [sentinels.withProvider, sentinels.employee],
    );
    const message = await migrationFailure();
    expect(message).toContain('pre-existing provider double-booking');
    expect(message).toContain('1 pre-existing');
    expect(message).toContain(sentinels.withProvider);
    await assertNothingApplied();
  });

  it('[R6a] reports out-of-range buffers instead of dying on a raw constraint violation', async () => {
    await seedAt0005({ bufferAfter: 5000 });
    const message = await migrationFailure();
    expect(message).toContain('buffer snapshots outside [0, 1440]');
    expect(message).not.toContain('is violated by some row');
    await assertNothingApplied();
  });

  it('[R6b] reports an occupancy longer than 24 hours', async () => {
    await seedAt0005({ durationHours: 30 });
    const message = await migrationFailure();
    expect(message).toContain('longer than 24 hours');
    await assertNothingApplied();
  });

  it('[C4] reports the COMPLETE count with a bounded sample when violations exceed 20', async () => {
    const sentinels = await seedAt0005();
    // 25 more confirmed bookings, all overlapping the same provider's window,
    // so every pair among them is a violation — far more than the sample cap.
    for (let i = 0; i < 25; i += 1) {
      await getPool().query(
        `INSERT INTO bookings
           (branch_id, customer_id, service_id, assigned_employee_id, status, starts_at, ends_at,
            price_baisa, service_name_snapshot, duration_min_snapshot,
            buffer_before_min_snapshot, buffer_after_min_snapshot)
         SELECT branch_id, customer_id, service_id, $2, 'confirmed',
                starts_at + make_interval(mins => $3), ends_at + make_interval(mins => $3),
                price_baisa, service_name_snapshot, duration_min_snapshot,
                buffer_before_min_snapshot, buffer_after_min_snapshot
         FROM bookings WHERE id = $1`,
        [sentinels.withProvider, sentinels.employee, i + 1],
      );
    }
    const message = await migrationFailure();
    const reported = Number(/preflight: (\d+) pre-existing/.exec(message)?.[1]);
    const exact = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM bookings a JOIN bookings b
         ON a.assigned_employee_id = b.assigned_employee_id AND a.id < b.id
        AND tstzrange(a.starts_at - make_interval(mins => a.buffer_before_min_snapshot),
                      a.ends_at + make_interval(mins => a.buffer_after_min_snapshot), '[)')
         && tstzrange(b.starts_at - make_interval(mins => b.buffer_before_min_snapshot),
                      b.ends_at + make_interval(mins => b.buffer_after_min_snapshot), '[)')
       WHERE a.assigned_employee_id IS NOT NULL
         AND a.status IN ('confirmed', 'checked_in', 'in_service', 'completed')
         AND b.status IN ('confirmed', 'checked_in', 'in_service', 'completed')`,
    );
    // The complete total, not the size of the sample.
    expect(reported).toBe(exact.rows[0]!.n);
    expect(reported).toBeGreaterThan(20);
    // ...and the sample itself stays bounded.
    const pairs = (/Pairs: (.*)$/s.exec(message)?.[1] ?? '').split(';').filter(Boolean);
    expect(pairs.length).toBeLessThanOrEqual(20);
    await assertNothingApplied();
  }, 60_000);

  it('[C4] reports the complete count of out-of-range buffers, not the sample size', async () => {
    await seedAt0005({ bufferAfter: 5000 });
    for (let i = 0; i < 25; i += 1) {
      await getPool().query(
        `INSERT INTO bookings
           (branch_id, customer_id, service_id, status, starts_at, ends_at, price_baisa,
            service_name_snapshot, duration_min_snapshot,
            buffer_before_min_snapshot, buffer_after_min_snapshot)
         SELECT branch_id, customer_id, service_id, 'confirmed',
                starts_at + make_interval(days => $1), ends_at + make_interval(days => $1),
                price_baisa, service_name_snapshot, duration_min_snapshot, 0, 5000
         FROM bookings ORDER BY id LIMIT 1`,
        [i + 1],
      );
    }
    const message = await migrationFailure();
    const reported = Number(/preflight: (\d+) booking\(s\) carry buffer/.exec(message)?.[1]);
    const exact = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM bookings
       WHERE buffer_before_min_snapshot NOT BETWEEN 0 AND 1440
          OR buffer_after_min_snapshot NOT BETWEEN 0 AND 1440`,
    );
    expect(reported).toBe(exact.rows[0]!.n);
    expect(reported).toBeGreaterThan(20);
    expect((/sample: (.*)$/s.exec(message)?.[1] ?? '').split(',').length).toBeLessThanOrEqual(20);
    await assertNothingApplied();
  }, 60_000);

  it('[C2-legacy] aborts when a holding assigned booking has no eligibility coverage', async () => {
    const sentinels = await seedAt0005();
    // Take the assignment away: 0005 allowed this state, 0006 will not create a
    // live claim out of it.
    await getPool().query('DELETE FROM provider_branch_assignments WHERE employee_id = $1', [
      sentinels.employee,
    ]);
    const message = await migrationFailure();
    expect(message).toContain('would become a live allocation');
    expect(message).toContain('does not invent eligibility');
    expect(message).toContain(sentinels.withProvider);
    // The cancelled booking is backfilled RELEASED, so it is not the reason.
    expect(message).not.toContain(sentinels.cancelled);
    await assertNothingApplied();
  });

  it('[C2-legacy] aborts when the qualification is missing, and reports a bounded sample', async () => {
    const sentinels = await seedAt0005();
    await getPool().query('DELETE FROM provider_service_qualifications WHERE employee_id = $1', [
      sentinels.employee,
    ]);
    const message = await migrationFailure();
    expect(message).toContain('would become a live allocation');
    expect((/Sample bookings: (.*)$/s.exec(message)?.[1] ?? '').split(',').length).toBeLessThanOrEqual(20);
    await assertNothingApplied();
  });

  it('[R6b] validates the buffer bounds once the data is clean', async () => {
    await seedAt0005();
    await runMigrations(getPool());
    const rows = await getPool().query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated FROM pg_constraint
       WHERE conname IN ('bookings_buffer_before_bounds', 'bookings_buffer_after_bounds')
       ORDER BY conname`,
    );
    expect(rows.rows.map((r) => r.convalidated)).toEqual([true, true]);
  });
});
