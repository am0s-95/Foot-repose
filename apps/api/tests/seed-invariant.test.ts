import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  intersectIntervals,
  intervalsContain,
  materializeBranchHours,
  materializeProviderPresence,
  occupancyOf,
  todayInMuscat,
} from '@foot-repose/domain';
import {
  expectedSeedBookings,
  futureWeekAnchor,
  loadBranchHours,
  loadProviderSchedule,
  SEED_BRANCH_COUNT,
  SEED_EMPLOYEE_COUNT,
  weekFrom,
} from '@foot-repose/db';
import { closePool, getPool } from '../src/lib/pool';

const DB_PACKAGE_DIR = fileURLToPath(new URL('../../../packages/db', import.meta.url));

/**
 * Runs the REAL seed script against the test database, then proves the
 * seed invariant with SQL: every booking references a service its branch
 * actually offers, and its price/duration/buffer snapshots equal the
 * offering effective at the booking's start instant.
 */
/**
 * Seeded for an EXPLICIT Muscat date, never for "whatever today is".
 *
 * These invariants used to run against a dataset whose size depended on the day
 * the suite happened to execute — so `bookings > 100` held on a Wednesday (161)
 * and failed on a Friday (95) with nothing in the code having changed. A
 * Wednesday is the reference date here because it is an ordinary working day;
 * the weekday-specific behaviour has its own matrix in
 * `seed-weekday-matrix.test.ts`, including the day off.
 *
 * DERIVED, never written down. A pinned date is seedable when it is written and
 * forbidden once the calendar passes it — migration 0005 refuses a branch-hours
 * override for a past date, and the seed writes one for reference+1. A fixed
 * date here would be the same expiring-test defect this branch removes.
 */
const REFERENCE_DATE = weekFrom(futureWeekAnchor(todayInMuscat()))[3]!; // Wednesday

function runSeed(referenceDate: string): void {
  execFileSync('npx', ['tsx', 'src/seed.ts'], {
    cwd: DB_PACKAGE_DIR,
    env: {
      ...process.env,
      DATABASE_URL: process.env.DATABASE_URL,
      SEED_CONFIRM: 'wipe',
      SEED_REFERENCE_DATE: referenceDate,
    },
    stdio: 'pipe',
    timeout: 120_000,
  });
}

describe('seed invariants', () => {
  beforeAll(() => {
    runSeed(REFERENCE_DATE);
  }, 120_000);

  afterAll(async () => {
    await closePool();
  });

  it('produces the same dataset when the same reference date is seeded twice', async () => {
    const snapshot = async (): Promise<Record<string, number>> => {
      const result = await getPool().query<{ status: string; n: number }>(
        `SELECT status, count(*)::int AS n FROM bookings GROUP BY status ORDER BY status`,
      );
      return Object.fromEntries(result.rows.map((row) => [row.status, row.n]));
    };
    const first = await snapshot();
    runSeed(REFERENCE_DATE);
    // Determinism is the property the whole fix rests on: if reseeding the same
    // day could produce a different distribution, an exact expectation would be
    // no better than the threshold it replaced.
    expect(await snapshot()).toEqual(first);
    expect(Object.values(first).reduce((a, b) => a + b, 0)).toBe(
      expectedSeedBookings(REFERENCE_DATE).total,
    );
  }, 180_000);

  it('seeds exactly the dataset the documented rules predict', async () => {
    const counts = await getPool().query<{
      bookings: number;
      offerings: number;
      branches: number;
      employees: number;
    }>(
      `SELECT (SELECT count(*)::int FROM bookings) AS bookings,
              (SELECT count(*)::int FROM branch_service_offerings) AS offerings,
              (SELECT count(*)::int FROM branches) AS branches,
              (SELECT count(*)::int FROM employees) AS employees`,
    );
    // Fixed shape of the fictional company — nothing here varies by date.
    expect(counts.rows[0]!.branches).toBe(SEED_BRANCH_COUNT);
    expect(counts.rows[0]!.employees).toBe(SEED_EMPLOYEE_COUNT);
    // ...and the booking total DERIVED from the seed's own rules for this
    // reference date, not a threshold chosen to be survivable.
    expect(counts.rows[0]!.bookings).toBe(expectedSeedBookings(REFERENCE_DATE).total);
    // 6 services x 11 branches, all current; the history versions carry an
    // earlier valid_during and are counted here too, so this is a floor with a
    // reason rather than a round number.
    expect(counts.rows[0]!.offerings).toBeGreaterThanOrEqual(SEED_BRANCH_COUNT * 6);
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

  /**
   * Row-level anti-joins, not counts. Each one names rows that BREAK an
   * invariant, so "0" is the proof. Every query is then re-run against a
   * deliberately broken fixture inside a rolled-back transaction, so a query
   * that could never fail cannot pass for a guarantee.
   */
  const INVARIANTS = {
    /**
     * Occurrence-level coverage, the same rule `breakIsCoveredByShifts`
     * applies — not `week_spans @>` and not overlapping `valid_dates`, both of
     * which accept a break justified by an occurrence that never happens.
     *
     * For every probe date (each version boundary of the break or of that
     * provider's shifts in that branch, from the day before it through a full
     * week after — beyond which the picture repeats weekly) it materialises:
     *   * the minutes the BREAK really occupies that Muscat day: its own
     *     weekday part, plus the after-midnight remainder of an occurrence
     *     ANCHORED on the previous day — which counts only when the version
     *     was in force on that anchor day AND is still in force on this one;
     *   * the same for every SHIFT of that provider in that branch, unioned.
     * A break minute with no shift minute under it is a violation.
     */
    uncoveredBreaks: `
      WITH b AS (
        SELECT id, employee_id, branch_id, valid_dates, day_of_week, open_minute, close_minute
        FROM provider_weekly_windows WHERE kind = 'break'
      ),
      probe AS (
        SELECT DISTINCT b.id AS break_id, (a.d + off)::date AS on_date
        FROM b
        CROSS JOIN LATERAL (
          SELECT lower(b.valid_dates) AS d
          UNION SELECT upper(b.valid_dates)
          UNION SELECT lower(s.valid_dates) FROM provider_weekly_windows s
            WHERE s.kind = 'shift' AND s.employee_id = b.employee_id AND s.branch_id = b.branch_id
          UNION SELECT upper(s.valid_dates) FROM provider_weekly_windows s
            WHERE s.kind = 'shift' AND s.employee_id = b.employee_id AND s.branch_id = b.branch_id
        ) a
        CROSS JOIN generate_series(-1, 7) AS off
        WHERE a.d IS NOT NULL
      ),
      needed AS (
        SELECT p.break_id, p.on_date, range_agg(part.r) AS spans
        FROM probe p JOIN b ON b.id = p.break_id
        CROSS JOIN LATERAL (
          SELECT int4range(b.open_minute, least(b.close_minute, 1440)) AS r
           WHERE b.day_of_week = extract(dow FROM p.on_date)::int
             AND b.valid_dates @> p.on_date
          UNION ALL
          SELECT int4range(0, b.close_minute - 1440)
           WHERE b.close_minute > 1440
             AND b.day_of_week = extract(dow FROM p.on_date - 1)::int
             AND b.valid_dates @> (p.on_date - 1)
             AND b.valid_dates @> p.on_date
        ) part
        GROUP BY 1, 2
      ),
      available AS (
        SELECT n.break_id, n.on_date, range_agg(part.r) AS spans
        FROM needed n JOIN b ON b.id = n.break_id
        JOIN provider_weekly_windows s
          ON s.kind = 'shift' AND s.employee_id = b.employee_id AND s.branch_id = b.branch_id
        CROSS JOIN LATERAL (
          SELECT int4range(s.open_minute, least(s.close_minute, 1440)) AS r
           WHERE s.day_of_week = extract(dow FROM n.on_date)::int
             AND s.valid_dates @> n.on_date
          UNION ALL
          SELECT int4range(0, s.close_minute - 1440)
           WHERE s.close_minute > 1440
             AND s.day_of_week = extract(dow FROM n.on_date - 1)::int
             AND s.valid_dates @> (n.on_date - 1)
             AND s.valid_dates @> n.on_date
        ) part
        GROUP BY 1, 2
      )
      SELECT count(*)::int AS n
      FROM needed n
      LEFT JOIN available a ON a.break_id = n.break_id AND a.on_date = n.on_date
      WHERE NOT (coalesce(a.spans, '{}'::int4multirange) @> n.spans)`,
    // Every operational assignment of a staff provider must have a real roster
    // in that branch — an assignment with no shift is a phantom.
    assignmentsWithoutRoster: `
      SELECT count(*)::int AS n
      FROM provider_branch_assignments a
      JOIN employees e ON e.id = a.employee_id AND e.role = 'staff'
      WHERE NOT EXISTS (
        SELECT 1 FROM provider_weekly_windows w
        WHERE w.employee_id = a.employee_id
          AND w.branch_id = a.branch_id
          AND w.kind = 'shift'
          AND w.valid_dates && a.valid_dates)`,
    // An extra shift must fall inside an assignment for the SAME branch that
    // covers both its first and its last Muscat date.
    extraShiftsOutsideAssignment: `
      SELECT count(*)::int AS n
      FROM provider_extra_shifts x
      WHERE NOT EXISTS (
        SELECT 1 FROM provider_branch_assignments a
        WHERE a.employee_id = x.employee_id
          AND a.branch_id = x.branch_id
          AND a.valid_dates @> (lower(x.during) AT TIME ZONE 'Asia/Muscat')::date
          AND a.valid_dates @>
              ((upper(x.during) - interval '1 microsecond') AT TIME ZONE 'Asia/Muscat')::date)`,
    // Seeded scheduling rows must stay obviously fictional.
    unmarkedFictionalRows: `
      SELECT count(*)::int AS n FROM (
        SELECT note FROM branch_hours_overrides
        UNION ALL SELECT note FROM provider_extra_shifts) t
      WHERE note IS NULL OR note NOT LIKE 'fictional %'`,
    // ... and so must the seeded physical inventory.
    unmarkedFictionalResources: `
      SELECT count(*)::int AS n FROM branch_resources
      WHERE label NOT LIKE 'Fictional %'`,
    // A booking that no longer holds capacity may not keep a live claim. The
    // link is a repository guarantee (applyBookingTransition), so it is
    // re-proved here over the whole dataset.
    liveClaimsOnNonHoldingBookings: `
      SELECT count(*)::int AS n FROM (
        SELECT a.booking_id FROM booking_provider_allocations a
         JOIN bookings b ON b.id = a.booking_id
         WHERE a.released_at IS NULL AND b.status IN ('cancelled', 'no_show')
        UNION
        SELECT r.booking_id FROM booking_resource_allocations r
         JOIN bookings b ON b.id = r.booking_id
         WHERE r.released_at IS NULL AND b.status IN ('cancelled', 'no_show')) t`,
    // Eligibility is a repository guarantee too: assignment AND qualification
    // must cover every Muscat date the claim's occupancy touches.
    claimsViolatingEligibility: `
      SELECT count(*)::int AS n
      FROM booking_provider_allocations a
      JOIN bookings b ON b.id = a.booking_id
      CROSS JOIN LATERAL (
        SELECT (lower(a.occupancy) AT TIME ZONE 'Asia/Muscat')::date AS d
        UNION
        SELECT ((upper(a.occupancy) - interval '1 microsecond') AT TIME ZONE 'Asia/Muscat')::date
      ) dates
      WHERE a.released_at IS NULL
        AND (NOT EXISTS (SELECT 1 FROM provider_branch_assignments pa
                         WHERE pa.employee_id = a.employee_id AND pa.branch_id = a.branch_id
                           AND pa.valid_dates @> dates.d)
         OR NOT EXISTS (SELECT 1 FROM provider_service_qualifications q
                         WHERE q.employee_id = a.employee_id AND q.service_id = b.service_id
                           AND q.valid_dates @> dates.d))`,
    // Every booking with a SEALED snapshot must have exactly the units it
    // requires. Bookings without a snapshot are pre-0006 history and are
    // deliberately out of scope — never read as "needs nothing".
    unsatisfiedRequirements: `
      WITH holding AS (
        SELECT s.booking_id FROM booking_resource_requirement_sets s
        JOIN bookings b ON b.id = s.booking_id
        WHERE s.sealed_at IS NOT NULL
          AND b.status IN ('confirmed', 'checked_in', 'in_service', 'completed')
      ),
      required AS (
        SELECT h.booking_id, r.resource_type_id, r.required_qty
        FROM holding h JOIN booking_resource_requirements r ON r.booking_id = h.booking_id
      ),
      held AS (
        SELECT h.booking_id, a.resource_type_id, count(*)::int AS qty
        FROM holding h JOIN booking_resource_allocations a ON a.booking_id = h.booking_id
        WHERE a.released_at IS NULL
        GROUP BY 1, 2
      )
      -- FULL OUTER on purpose: a missing type, an extra type, a wrong quantity
      -- and a live unit on a sealed ZERO-requirement set are all one comparison.
      SELECT count(*)::int AS n
      FROM required r
      FULL OUTER JOIN held e
        ON e.booking_id = r.booking_id AND e.resource_type_id = r.resource_type_id
      WHERE coalesce(r.required_qty, 0) <> coalesce(e.qty, 0)`,
  } as const;

  const violations = async (sql: string): Promise<number> =>
    Number((await getPool().query<{ n: number }>(sql)).rows[0]!.n);

  it('seeds a schedule for every branch and every staff provider', async () => {
    const gaps = await getPool().query<{
      branches_without_hours: number;
      staff_without_shifts: number;
      extras: number;
    }>(
      `SELECT (SELECT count(*)::int FROM branches b
                 WHERE NOT EXISTS (SELECT 1 FROM branch_weekly_windows w WHERE w.branch_id = b.id))
                AS branches_without_hours,
              (SELECT count(*)::int FROM employees e
                 WHERE e.role = 'staff'
                   AND NOT EXISTS (SELECT 1 FROM provider_weekly_windows w
                                   WHERE w.employee_id = e.id AND w.kind = 'shift'))
                AS staff_without_shifts,
              (SELECT count(*)::int FROM provider_extra_shifts) AS extras`,
    );
    expect(gaps.rows[0]!.branches_without_hours).toBe(0);
    expect(gaps.rows[0]!.staff_without_shifts).toBe(0);
    expect(gaps.rows[0]!.extras).toBeGreaterThan(0);
  });

  it('holds every scheduling invariant on the seeded data', async () => {
    for (const [name, sql] of Object.entries(INVARIANTS)) {
      expect(`${name}=${await violations(sql)}`).toBe(`${name}=0`);
    }
  });

  it('does not flag the legitimate counterpart of the midnight fixture', async () => {
    // Same shapes, but the shift version starts on the SATURDAY, so the
    // Sunday-morning occurrence really exists and the break is covered. The
    // invariant must stay silent — it may not be stricter than the write path.
    const pool = getPool();
    const target = await pool.query<{ staff: string; home: string }>(
      `SELECT w.employee_id AS staff, w.branch_id AS home
       FROM provider_weekly_windows w WHERE w.kind = 'shift'
       ORDER BY w.employee_id LIMIT 1`,
    );
    const { staff, home } = target.rows[0]!;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO provider_weekly_windows
           (employee_id, branch_id, kind, valid_dates, day_of_week, open_minute, close_minute)
         VALUES ('${staff}', '${home}', 'shift', daterange('2030-01-05'::date, NULL, '[)'), 6, 1380, 1560);
         INSERT INTO provider_weekly_windows
           (employee_id, branch_id, kind, valid_dates, day_of_week, open_minute, close_minute)
         VALUES ('${staff}', '${home}', 'break', daterange('2030-01-06'::date, NULL, '[)'), 0, 30, 60)`,
      );
      const found = Number(
        (await client.query<{ n: number }>(INVARIANTS.uncoveredBreaks)).rows[0]!.n,
      );
      expect(`covered-by-anchored-shift violations=${found}`).toBe(
        'covered-by-anchored-shift violations=0',
      );
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });

  it('each invariant actually fires on a deliberately broken fixture', async () => {
    const pool = getPool();
    const ids = await pool.query<{ staff: string; home: string; other: string; from: string }>(
      `SELECT w.employee_id AS staff, w.branch_id AS home,
              (SELECT id FROM branches x WHERE x.id <> w.branch_id
                 AND NOT EXISTS (SELECT 1 FROM provider_weekly_windows y
                                 WHERE y.employee_id = w.employee_id AND y.branch_id = x.id)
               ORDER BY x.code LIMIT 1) AS other,
              lower(w.valid_dates)::text AS from
       FROM provider_weekly_windows w
       WHERE w.kind = 'shift'
         AND NOT EXISTS (SELECT 1 FROM provider_weekly_windows f
                         WHERE f.employee_id = w.employee_id AND f.day_of_week = 5)
       ORDER BY w.employee_id LIMIT 1`,
    );
    const { staff, home, other, from } = ids.rows[0]!;

    // `claimsViolatingEligibility` has no broken fixture on purpose: since the
    // allocation eligibility guard landed, an uncovered live claim can no longer
    // be created through ordinary DML at all. The database rejection is tested
    // instead, below — an invariant fixture for an unreachable state would only
    // prove the trigger was disabled.
    const brokenFixtures: Partial<Record<keyof typeof INVARIANTS, string>> = {
      // The midnight version-boundary case: a Saturday 23:00 -> Sunday 02:00
      // shift whose version only starts on the Sunday produces no Sunday
      // occurrence at all, so the Sunday-morning break it "justifies" is
      // uncovered. 2030-01-06 is a Sunday.
      uncoveredBreaks: `INSERT INTO provider_weekly_windows
        (employee_id, branch_id, kind, valid_dates, day_of_week, open_minute, close_minute)
        VALUES ('${staff}', '${home}', 'shift', daterange('2030-01-06'::date, NULL, '[)'), 6, 1380, 1560);
        INSERT INTO provider_weekly_windows
        (employee_id, branch_id, kind, valid_dates, day_of_week, open_minute, close_minute)
        VALUES ('${staff}', '${home}', 'break', daterange('2030-01-06'::date, NULL, '[)'), 0, 30, 60)`,
      // An assignment to a branch this provider has no roster in.
      assignmentsWithoutRoster: `INSERT INTO provider_branch_assignments
        (employee_id, branch_id, valid_dates)
        VALUES ('${staff}', '${other}', daterange('${from}'::date, NULL, '[)'))`,
      // An extra shift in a branch this provider is not assigned to.
      extraShiftsOutsideAssignment: `INSERT INTO provider_extra_shifts
        (employee_id, branch_id, during, note)
        VALUES ('${staff}', '${other}',
                tstzrange('2035-04-01T06:00:00Z', '2035-04-01T08:00:00Z', '[)'), 'fictional probe')`,
      // A scheduling row with no fictional marker.
      unmarkedFictionalRows: `INSERT INTO provider_extra_shifts
        (employee_id, branch_id, during, note)
        VALUES ('${staff}', '${home}',
                tstzrange('2035-05-01T06:00:00Z', '2035-05-01T08:00:00Z', '[)'), 'unmarked')`,
      // A resource unit whose label does not announce that it is invented.
      unmarkedFictionalResources: `UPDATE branch_resources SET label = 'Chair 3'
        WHERE id = (SELECT id FROM branch_resources ORDER BY id LIMIT 1)`,
      // Cancel a booking behind the repository's back, leaving its claim live.
      // This fixture is still reachable INSIDE a transaction only because the
      // guard that now forbids it is DEFERRED — the state exists until COMMIT,
      // which is exactly what the invariant query has to be able to see. That
      // the same statement can never be committed is proven separately below.
      liveClaimsOnNonHoldingBookings: `UPDATE bookings SET status = 'cancelled'
        WHERE id = (SELECT booking_id FROM booking_provider_allocations
                     WHERE released_at IS NULL ORDER BY booking_id LIMIT 1)`,
      // Release one unit of a booking that still requires it.
      unsatisfiedRequirements: `UPDATE booking_resource_allocations
        SET released_at = now(), release_reason = 'probe'
        WHERE id = (SELECT a.id FROM booking_resource_allocations a
                    JOIN bookings b ON b.id = a.booking_id
                    WHERE a.released_at IS NULL AND b.status = 'confirmed'
                    ORDER BY a.id LIMIT 1)`,
    };

    for (const [name, fixture] of Object.entries(brokenFixtures) as [
      keyof typeof INVARIANTS,
      string,
    ][]) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(fixture);
        const found = Number(
          (await client.query<{ n: number }>(INVARIANTS[name])).rows[0]!.n,
        );
        expect(`${name} detected ${found}`).toBe(`${name} detected 1`);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
    // The rollbacks put everything back: the invariants hold again.
    for (const sql of Object.values(INVARIANTS)) expect(await violations(sql)).toBe(0);
  });

  it('[C2-service] the database refuses to COMMIT either broken parent-row state', async () => {
    const pool = getPool();
    const target = await pool.query<{ booking_id: string }>(
      `SELECT a.booking_id FROM booking_provider_allocations a
       JOIN bookings b ON b.id = a.booking_id
       WHERE a.released_at IS NULL AND b.status = 'confirmed'
       ORDER BY a.booking_id LIMIT 1`,
    );
    const bookingId = target.rows[0]!.booking_id;

    // 1. Cancelling behind the repository's back cannot survive COMMIT.
    const cancelling = await pool.connect();
    let cancelOutcome = 'no error';
    try {
      await cancelling.query('BEGIN');
      await cancelling.query("UPDATE bookings SET status = 'cancelled' WHERE id = $1", [bookingId]);
      await cancelling.query('COMMIT');
    } catch (error) {
      cancelOutcome = (error as { code?: string }).code ?? 'unknown';
      await cancelling.query('ROLLBACK').catch(() => undefined);
    } finally {
      cancelling.release();
    }
    expect(cancelOutcome).toBe('P0001');

    // 2. Re-pointing a seeded booking at another service is refused outright:
    //    every seeded booking carries a sealed snapshot and live claims.
    const other = await pool.query<{ id: string }>(
      'SELECT id FROM services WHERE id <> (SELECT service_id FROM bookings WHERE id = $1) ORDER BY id LIMIT 1',
      [bookingId],
    );
    let serviceOutcome = 'no error';
    try {
      await pool.query('UPDATE bookings SET service_id = $2 WHERE id = $1', [
        bookingId,
        other.rows[0]!.id,
      ]);
    } catch (error) {
      serviceOutcome = (error as { code?: string }).code ?? 'unknown';
    }
    expect(serviceOutcome).toBe('P0001');

    // The seeded database is untouched by either attempt.
    for (const sql of Object.values(INVARIANTS)) expect(await violations(sql)).toBe(0);
  });

  it('[C2-reschedule] the database refuses to create an uncovered live claim at all', async () => {
    const pool = getPool();
    const target = await pool.query<{ booking_id: string }>(
      `SELECT a.booking_id FROM booking_provider_allocations a
       JOIN bookings b ON b.id = a.booking_id
       WHERE a.released_at IS NULL AND b.status = 'confirmed'
       ORDER BY a.booking_id LIMIT 1`,
    );
    const bookingId = target.rows[0]!.booking_id;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // An unassigned, unqualified provider cannot be given a live claim...
      await client.query(
        `INSERT INTO employees (email, password_hash, full_name, role)
         VALUES ('probe.unassigned@test.example', 'x', 'Probe Unassigned', 'staff')`,
      );
      // A fresh booking, so the one-live-provider index is not what refuses.
      const probe = await client.query<{ id: string }>(
        `INSERT INTO bookings
           (branch_id, customer_id, service_id, status, starts_at, ends_at, price_baisa,
            service_name_snapshot, duration_min_snapshot,
            buffer_before_min_snapshot, buffer_after_min_snapshot)
         SELECT branch_id, customer_id, service_id, 'confirmed',
                '2036-01-01T06:00:00Z'::timestamptz, '2036-01-01T07:00:00Z'::timestamptz,
                price_baisa, service_name_snapshot, duration_min_snapshot,
                buffer_before_min_snapshot, buffer_after_min_snapshot
         FROM bookings WHERE id = $1 RETURNING id`,
        [bookingId],
      );
      const inserting = client
        .query(
          `INSERT INTO booking_provider_allocations
             (booking_id, branch_id, employee_id, b_starts_at, b_ends_at, b_buf_before, b_buf_after)
           SELECT b.id, b.branch_id, e.id, b.starts_at, b.ends_at,
                  b.buffer_before_min_snapshot, b.buffer_after_min_snapshot
           FROM bookings b, employees e
           WHERE b.id = $1 AND e.email = 'probe.unassigned@test.example'`,
          [probe.rows[0]!.id],
        )
        .then(
          () => 'no error',
          (error: { code?: string }) => error.code ?? 'unknown',
        );
      expect(await inserting).toBe('P0001');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    // ...and the seed itself has none.
    expect(await violations(INVARIANTS.claimsViolatingEligibility)).toBe(0);
  });

  it('[C5] the requirement invariant catches an EXTRA type and a live unit on a zero-requirement set', async () => {
    const pool = getPool();
    // A live unit of a type the booking never required.
    const extraType = `
      INSERT INTO booking_resource_allocations
        (booking_id, branch_id, resource_id, resource_type_id,
         b_starts_at, b_ends_at, b_buf_before, b_buf_after)
      SELECT b.id, b.branch_id, r.id, r.resource_type_id, b.starts_at, b.ends_at,
             b.buffer_before_min_snapshot, b.buffer_after_min_snapshot
      FROM bookings b
      JOIN booking_resource_requirement_sets s ON s.booking_id = b.id AND s.sealed_at IS NOT NULL
      JOIN branch_resources r ON r.branch_id = b.branch_id
       AND r.resource_type_id NOT IN (SELECT resource_type_id FROM booking_resource_requirements
                                       WHERE booking_id = b.id)
      WHERE b.status = 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM booking_resource_allocations x
                        WHERE x.resource_id = r.id AND x.released_at IS NULL
                          AND x.occupancy && tstzrange(b.starts_at, b.ends_at, '[)'))
      ORDER BY b.id, r.id LIMIT 1`;
    // A sealed set with ZERO requirements that nevertheless holds a unit: the
    // old shape started from the requirement rows, so it could not see this at all.
    const sealedZero = `
      DELETE FROM booking_resource_requirements
       WHERE booking_id = (SELECT s.booking_id FROM booking_resource_requirement_sets s
                           JOIN bookings b ON b.id = s.booking_id
                           WHERE b.status = 'confirmed' ORDER BY s.booking_id LIMIT 1)`;
    for (const [name, fixture] of [
      ['extra unrequired type', extraType],
      ['sealed zero-requirement set holding a unit', sealedZero],
    ] as const) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // The sealing guard is what normally forbids the second fixture; the
        // point here is that the INVARIANT sees it even if it happened.
        await client.query('ALTER TABLE booking_resource_requirements DISABLE TRIGGER fr_booking_requirements_guard');
        await client.query(fixture);
        const found = Number(
          (await client.query<{ n: number }>(INVARIANTS.unsatisfiedRequirements)).rows[0]!.n,
        );
        expect(`${name} detected ${found}`).toBe(`${name} detected 1`);
      } finally {
        await client.query('ROLLBACK').catch(() => undefined);
        client.release();
      }
    }
  });

  it('[R8a] seeds every booking with its FULL occupancy inside real availability', async () => {
    // Not the service window: the buffered occupancy. A booking starting the
    // minute the branch opens, with prep time before it, would be off-shift.
    const pool = getPool();
    const bookings = await pool.query<{
      id: string;
      branch_id: string;
      employee_id: string;
      starts_at: Date;
      ends_at: Date;
      buffer_before_min_snapshot: number;
      buffer_after_min_snapshot: number;
      muscat_date: string;
    }>(
      `SELECT b.id, b.branch_id, a.employee_id, b.starts_at, b.ends_at,
              b.buffer_before_min_snapshot, b.buffer_after_min_snapshot,
              (lower(a.occupancy) AT TIME ZONE 'Asia/Muscat')::date::text AS muscat_date
       FROM bookings b
       JOIN booking_provider_allocations a ON a.booking_id = b.id
       ORDER BY b.starts_at, b.id`,
    );
    expect(bookings.rows.length).toBe(expectedSeedBookings(REFERENCE_DATE).total);

    const offShift: string[] = [];
    for (const row of bookings.rows) {
      const date = row.muscat_date;
      const hours = materializeBranchHours({
        isoDate: date,
        ...(await loadBranchHours(pool, row.branch_id, date)),
      });
      const presence = materializeProviderPresence({
        isoDate: date,
        ...(await loadProviderSchedule(pool, row.employee_id, date)),
      }).filter((p) => p.branchId === row.branch_id);
      const bookable = intersectIntervals(hours, presence);
      const occupancy = occupancyOf({
        startsAt: row.starts_at,
        endsAt: row.ends_at,
        bufferBeforeMin: row.buffer_before_min_snapshot,
        bufferAfterMin: row.buffer_after_min_snapshot,
      });
      if (!intervalsContain(bookable, [occupancy])) offShift.push(row.id);
    }
    expect(`off-shift bookings: ${offShift.slice(0, 5).join(', ')}`).toBe('off-shift bookings: ');
  }, 120_000);

  it('[R8b] never assigns a service to a provider who is not qualified for it', async () => {
    // The old generator qualified staff for four services and booked from six.
    const rows = await getPool().query<{ n: number; qualified_services: number }>(
      `SELECT (SELECT count(*)::int FROM booking_provider_allocations a
                 JOIN bookings b ON b.id = a.booking_id
                WHERE NOT EXISTS (SELECT 1 FROM provider_service_qualifications q
                                  WHERE q.employee_id = a.employee_id
                                    AND q.service_id = b.service_id)) AS n,
              (SELECT count(DISTINCT service_id)::int
                 FROM provider_service_qualifications) AS qualified_services`,
    );
    expect(rows.rows[0]!.n).toBe(0);
    // And the fixture really is narrower than the catalog, so this is not vacuous.
    const services = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM services',
    );
    expect(rows.rows[0]!.qualified_services).toBeLessThan(services.rows[0]!.n);
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
