import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  allocateBooking,
  applyBookingTransition,
  captureBookingRequirements,
  reassignProvider,
  releaseBookingAllocations,
  swapProviders,
  swapResources,
} from '@foot-repose/db';
import { closePool, getPool } from '../src/lib/pool';
import {
  claimContradictions,
  makeBooking,
  NO_CONTRADICTIONS,
  setupAllocationFixtures,
  type AllocationFixtures,
} from './allocation-helpers';

/**
 * P2 — microsecond precision through the claim mirrors.
 * P4 — release as one atomic unit.
 *
 * Both defects lived in the boundary between PostgreSQL and JavaScript, and both
 * were invisible to every existing test because those tests create bookings from
 * JavaScript `Date`s (millisecond) and release through a path that never fails
 * halfway. So the bookings here are written with real `timestamptz` literals that
 * carry six fractional digits, and the release here is made to fail on its SECOND
 * statement on purpose.
 *
 * Every equality between a claim and its booking is evaluated INSIDE PostgreSQL.
 * Comparing them in JavaScript would truncate both sides identically and report
 * success on exactly the data that used to fail.
 */
let fx: AllocationFixtures;

const DATE = '2030-04-07'; // a Sunday, inside every fixture assignment window
/** Muscat is +04:00 all year; these are the exact instants PostgreSQL stores. */
const MICRO_A = `${DATE}T10:00:00.123456+04:00`;
const MICRO_B = `${DATE}T10:00:00.999999+04:00`;
const MICRO_C = `${DATE}T15:00:00.500001+04:00`;

beforeEach(async () => {
  fx = await setupAllocationFixtures();
});

afterAll(async () => {
  await closePool();
});

/**
 * A booking at an EXACT instant, created the only way that keeps six digits: the
 * literal goes to PostgreSQL as text and `ends_at` is derived by the database.
 * `makeBooking` cannot do this — it builds a JavaScript `Date` first, and the
 * precision is already gone by the time the driver sees it.
 */
async function bookAtExactInstant(literal: string): Promise<string> {
  const result = await getPool().query<{ id: string }>(
    `INSERT INTO bookings
       (branch_id, customer_id, service_id, status, starts_at, ends_at, price_baisa,
        service_name_snapshot, duration_min_snapshot,
        buffer_before_min_snapshot, buffer_after_min_snapshot)
     VALUES ($1, $2, $3, 'confirmed', $4::timestamptz,
             fr_shift_minutes($4::timestamptz, 45), 8500, 'Fixture service', 45, 0, 10)
     RETURNING id`,
    [fx.branchA, fx.customerOne, fx.service, literal],
  );
  const id = result.rows[0]!.id;
  await captureBookingRequirements(getPool(), id);
  return id;
}

/**
 * Do the live mirrors of this booking equal the booking itself, column for
 * column? Answered by PostgreSQL, over both allocation tables at once, and
 * false when a table has no live claim at all.
 */
async function mirrorsAreExact(bookingId: string): Promise<boolean> {
  const result = await getPool().query<{ exact: boolean }>(
    `WITH mirrors AS (
       SELECT a.b_starts_at, a.b_ends_at, a.b_buf_before, a.b_buf_after
         FROM booking_provider_allocations a
        WHERE a.booking_id = $1 AND a.released_at IS NULL
       UNION ALL
       SELECT r.b_starts_at, r.b_ends_at, r.b_buf_before, r.b_buf_after
         FROM booking_resource_allocations r
        WHERE r.booking_id = $1 AND r.released_at IS NULL
     )
     SELECT count(*) = 2
            AND bool_and(m.b_starts_at = b.starts_at
                     AND m.b_ends_at = b.ends_at
                     AND m.b_buf_before = b.buffer_before_min_snapshot
                     AND m.b_buf_after = b.buffer_after_min_snapshot) AS exact
       FROM mirrors m CROSS JOIN bookings b
      WHERE b.id = $1`,
    [bookingId],
  );
  return result.rows[0]!.exact;
}

/** The six fractional digits of every live mirror, as PostgreSQL renders them. */
async function mirrorMicroseconds(bookingId: string): Promise<string[]> {
  const result = await getPool().query<{ digits: string }>(
    `SELECT to_char(b_starts_at AT TIME ZONE 'UTC', 'US') AS digits
       FROM booking_provider_allocations
      WHERE booking_id = $1 AND released_at IS NULL
      UNION ALL
     SELECT to_char(b_starts_at AT TIME ZONE 'UTC', 'US')
       FROM booking_resource_allocations
      WHERE booking_id = $1 AND released_at IS NULL`,
    [bookingId],
  );
  return result.rows.map((r) => r.digits);
}

const liveCounts = async (bookingId: string): Promise<{ provider: number; resource: number }> => {
  const result = await getPool().query<{ p: number; s: number }>(
    `SELECT (SELECT count(*)::int FROM booking_provider_allocations
              WHERE booking_id = $1 AND released_at IS NULL) AS p,
            (SELECT count(*)::int FROM booking_resource_allocations
              WHERE booking_id = $1 AND released_at IS NULL) AS s`,
    [bookingId],
  );
  return { provider: result.rows[0]!.p, resource: result.rows[0]!.s };
};

const providerOf = async (bookingId: string): Promise<string | null> =>
  (
    await getPool().query<{ employee_id: string }>(
      `SELECT employee_id FROM booking_provider_allocations
        WHERE booking_id = $1 AND released_at IS NULL`,
      [bookingId],
    )
  ).rows[0]?.employee_id ?? null;

const resourceOf = async (bookingId: string): Promise<string | null> =>
  (
    await getPool().query<{ resource_id: string }>(
      `SELECT resource_id FROM booking_resource_allocations
        WHERE booking_id = $1 AND released_at IS NULL`,
      [bookingId],
    )
  ).rows[0]?.resource_id ?? null;

const seqsOf = async (table: string, bookingId: string): Promise<string[]> =>
  (
    await getPool().query<{ allocation_seq: string }>(
      `SELECT allocation_seq FROM ${table} WHERE booking_id = $1 AND released_at IS NULL
        ORDER BY allocation_seq`,
      [bookingId],
    )
  ).rows.map((r) => r.allocation_seq);

// =========================================================== P2: precision

describe('[P2] a claim mirrors its booking to the microsecond', () => {
  it('[P2-1] allocates a booking whose start carries .123456', async () => {
    const bookingId = await bookAtExactInstant(MICRO_A);
    await allocateBooking(getPool(), bookingId, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });
    expect(await liveCounts(bookingId)).toEqual({ provider: 1, resource: 1 });
    expect(await claimContradictions(getPool())).toEqual(NO_CONTRADICTIONS);
  });

  it('[P2-2] allocates a booking whose start carries .999999', async () => {
    // The rounding-up case: a driver that rounded rather than truncated would
    // land on the NEXT second, which is a different wrong answer, not a right one.
    const bookingId = await bookAtExactInstant(MICRO_B);
    await allocateBooking(getPool(), bookingId, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });
    expect(await liveCounts(bookingId)).toEqual({ provider: 1, resource: 1 });
  });

  it('[P2-3] writes mirror columns EXACTLY equal to the booking columns', async () => {
    for (const literal of [MICRO_A, MICRO_C]) {
      const bookingId = await bookAtExactInstant(literal);
      await allocateBooking(getPool(), bookingId, {
        employeeId: fx.staffA.id,
        resourceIds: [fx.chairA1],
      });
      expect(await mirrorsAreExact(bookingId)).toBe(true);
    }
  });

  it('[P2-4] keeps the fractional microseconds in the mirrors', async () => {
    const bookingId = await bookAtExactInstant(MICRO_A);
    await allocateBooking(getPool(), bookingId, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });
    // Not merely "equal to the booking": the digits below the millisecond are
    // present. A design that truncated BOTH sides would satisfy P2-3 alone.
    expect(await mirrorMicroseconds(bookingId)).toEqual(['123456', '123456']);
  });

  it('[P2-5] derives occupancy from the exact stored timestamps and buffers', async () => {
    const bookingId = await bookAtExactInstant(MICRO_A);
    await allocateBooking(getPool(), bookingId, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });
    const result = await getPool().query<{ same: boolean; lower_us: string; upper_us: string }>(
      `SELECT a.occupancy = tstzrange(
                fr_shift_minutes(b.starts_at, -b.buffer_before_min_snapshot),
                fr_shift_minutes(b.ends_at, b.buffer_after_min_snapshot), '[)') AS same,
              to_char(lower(a.occupancy) AT TIME ZONE 'UTC', 'US') AS lower_us,
              to_char(upper(a.occupancy) AT TIME ZONE 'UTC', 'US') AS upper_us
         FROM booking_provider_allocations a
         JOIN bookings b ON b.id = a.booking_id
        WHERE a.booking_id = $1 AND a.released_at IS NULL`,
      [bookingId],
    );
    expect(result.rows[0]!.same).toBe(true);
    expect(result.rows[0]!.lower_us).toBe('123456');
    expect(result.rows[0]!.upper_us).toBe('123456');
  });

  it('[P2-6] reassigns the provider of a microsecond booking', async () => {
    const bookingId = await bookAtExactInstant(MICRO_A);
    await allocateBooking(getPool(), bookingId, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });
    await reassignProvider(getPool(), bookingId, fx.staffB.id);
    expect(await providerOf(bookingId)).toBe(fx.staffB.id);
    expect(await mirrorsAreExact(bookingId)).toBe(true);
    expect(await mirrorMicroseconds(bookingId)).toEqual(['123456', '123456']);
  });

  it('[P2-7] swaps the providers of two microsecond bookings', async () => {
    const a = await bookAtExactInstant(MICRO_A);
    const b = await bookAtExactInstant(MICRO_B);
    await allocateBooking(getPool(), a, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
    await allocateBooking(getPool(), b, { employeeId: fx.staffB.id, resourceIds: [fx.chairA2] });

    await swapProviders(getPool(), {
      a: { bookingId: a, expectedAllocationSeqs: await seqsOf('booking_provider_allocations', a) },
      b: { bookingId: b, expectedAllocationSeqs: await seqsOf('booking_provider_allocations', b) },
    });

    expect(await providerOf(a)).toBe(fx.staffB.id);
    expect(await providerOf(b)).toBe(fx.staffA.id);
    expect(await mirrorsAreExact(a)).toBe(true);
    expect(await mirrorsAreExact(b)).toBe(true);
    expect(await claimContradictions(getPool())).toEqual(NO_CONTRADICTIONS);
  });

  it('[P2-8] swaps the resources of two microsecond bookings', async () => {
    const a = await bookAtExactInstant(MICRO_A);
    const b = await bookAtExactInstant(MICRO_B);
    await allocateBooking(getPool(), a, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
    await allocateBooking(getPool(), b, { employeeId: fx.staffB.id, resourceIds: [fx.chairA2] });

    await swapResources(getPool(), {
      a: { bookingId: a, expectedAllocationSeqs: await seqsOf('booking_resource_allocations', a) },
      b: { bookingId: b, expectedAllocationSeqs: await seqsOf('booking_resource_allocations', b) },
    });

    expect(await resourceOf(a)).toBe(fx.chairA2);
    expect(await resourceOf(b)).toBe(fx.chairA1);
    expect(await mirrorsAreExact(a)).toBe(true);
    expect(await mirrorsAreExact(b)).toBe(true);
  });

  it('[P2-9] keeps mirror equality across a reschedule to another microsecond instant', async () => {
    const bookingId = await bookAtExactInstant(MICRO_A);
    await allocateBooking(getPool(), bookingId, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });

    // ON UPDATE CASCADE moves both mirrors. The cascade happens entirely inside
    // PostgreSQL, so it was never the lossy step — but it is only sound if what
    // it starts from was exact.
    await getPool().query(
      `UPDATE bookings
          SET starts_at = $2::timestamptz, ends_at = fr_shift_minutes($2::timestamptz, 45)
        WHERE id = $1`,
      [bookingId, MICRO_C],
    );

    expect(await mirrorsAreExact(bookingId)).toBe(true);
    expect(await mirrorMicroseconds(bookingId)).toEqual(['500001', '500001']);
    expect(await claimContradictions(getPool())).toEqual(NO_CONTRADICTIONS);
  });

  it('[P2-10] leaves an ordinary millisecond booking behaving exactly as before', async () => {
    const bookingId = await makeBooking({
      branchId: fx.branchA,
      isoDate: DATE,
      hour: 10,
      serviceId: fx.service,
      customerId: fx.customerOne,
    });
    await captureBookingRequirements(getPool(), bookingId);
    await allocateBooking(getPool(), bookingId, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });
    expect(await liveCounts(bookingId)).toEqual({ provider: 1, resource: 1 });
    expect(await mirrorsAreExact(bookingId)).toBe(true);
    expect(await mirrorMicroseconds(bookingId)).toEqual(['000000', '000000']);
    await reassignProvider(getPool(), bookingId, fx.staffB.id);
    expect(await providerOf(bookingId)).toBe(fx.staffB.id);
    expect(await claimContradictions(getPool())).toEqual(NO_CONTRADICTIONS);
  });
});

// ============================================================= P4: release

/**
 * Deterministic fault injection.
 *
 * A trigger, not a mocked client: the point is that the SECOND statement of the
 * release fails for real, inside PostgreSQL, exactly as a constraint violation
 * or a serialisation failure would. It is scoped by `release_reason` so it can
 * only ever fire for the one call under test, and it is dropped in a `finally`
 * so a failing assertion cannot leave it installed.
 *
 * Nothing here is a migration: the function and trigger exist only for the
 * duration of one test, in the test database.
 *
 * Isolation: `apps/api/vitest.config.ts` sets `fileParallelism: false` and tests
 * inside a file run in order, so no other file is touching these tables while
 * the trigger exists.
 */
const FAULT_REASON = 'test-fault:release-second-statement';

async function withResourceReleaseFault<T>(run: () => Promise<T>): Promise<T> {
  const pool = getPool();
  await pool.query(`
    CREATE OR REPLACE FUNCTION fr_test_release_fault() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      RAISE EXCEPTION 'injected release fault' USING ERRCODE = 'P0001';
    END $$`);
  // 'zzz' so it runs after the schema's own before-update guards rather than
  // instead of them: the statement is failed, not bypassed.
  await pool.query(
    `CREATE TRIGGER zzz_fr_test_release_fault
       BEFORE UPDATE ON booking_resource_allocations
       FOR EACH ROW WHEN (NEW.release_reason = '${FAULT_REASON}')
       EXECUTE FUNCTION fr_test_release_fault()`,
  );
  try {
    return await run();
  } finally {
    await pool.query(
      'DROP TRIGGER IF EXISTS zzz_fr_test_release_fault ON booking_resource_allocations',
    );
    await pool.query('DROP FUNCTION IF EXISTS fr_test_release_fault()');
  }
}

async function allocatedBooking(hour = 10): Promise<string> {
  const bookingId = await makeBooking({
    branchId: fx.branchA,
    isoDate: DATE,
    hour,
    serviceId: fx.service,
    customerId: fx.customerOne,
  });
  await captureBookingRequirements(getPool(), bookingId);
  await allocateBooking(getPool(), bookingId, {
    employeeId: fx.staffA.id,
    resourceIds: [fx.chairA1],
  });
  return bookingId;
}

describe('[P4] releasing a booking is one atomic unit', () => {
  it('[P4-1..5] rolls BOTH release groups back when the second statement fails', async () => {
    const bookingId = await allocatedBooking();
    expect(await liveCounts(bookingId)).toEqual({ provider: 1, resource: 1 });

    let thrown = '(nothing)';
    await withResourceReleaseFault(async () => {
      try {
        await releaseBookingAllocations(getPool(), bookingId, FAULT_REASON);
      } catch (error) {
        thrown = (error as Error).message;
      }
    });

    // 1. it still throws — the failure is never swallowed.
    expect(thrown).toContain('injected release fault');
    // 2/3/4. neither release survived; both claims are still live.
    expect(await liveCounts(bookingId)).toEqual({ provider: 1, resource: 1 });
    // 5. and nothing was released under that reason, in either table.
    const marked = await getPool().query<{ n: number }>(
      `SELECT (SELECT count(*) FROM booking_provider_allocations WHERE release_reason = $1)
            + (SELECT count(*) FROM booking_resource_allocations WHERE release_reason = $1) AS n`,
      [FAULT_REASON],
    );
    expect(Number(marked.rows[0]!.n)).toBe(0);
    expect(await claimContradictions(getPool())).toEqual(NO_CONTRADICTIONS);
  });

  it('[P4-6] releases both claim groups when invoked directly with a Pool', async () => {
    const bookingId = await allocatedBooking();
    await releaseBookingAllocations(getPool(), bookingId, 'test:pool');
    expect(await liveCounts(bookingId)).toEqual({ provider: 0, resource: 0 });
  });

  it('[P4-7] preserves the caller transaction when handed a client inside one', async () => {
    const bookingId = await allocatedBooking();
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      // A marker write of the caller's own, which must survive: the unit of work
      // may not commit or roll back the transaction it was handed.
      await client.query("UPDATE bookings SET service_name_snapshot = 'caller-marker' WHERE id = $1", [
        bookingId,
      ]);
      await releaseBookingAllocations(client, bookingId, 'test:inside-tx');
      const inside = await client.query<{ n: number }>(
        `SELECT (SELECT count(*)::int FROM booking_provider_allocations
                  WHERE booking_id = $1 AND released_at IS NULL)
              + (SELECT count(*)::int FROM booking_resource_allocations
                  WHERE booking_id = $1 AND released_at IS NULL) AS n`,
        [bookingId],
      );
      expect(inside.rows[0]!.n).toBe(0);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await liveCounts(bookingId)).toEqual({ provider: 0, resource: 0 });
    const marker = await getPool().query<{ name: string }>(
      'SELECT service_name_snapshot AS name FROM bookings WHERE id = $1',
      [bookingId],
    );
    expect(marker.rows[0]!.name).toBe('caller-marker');
  });

  it('[P4-8] restores both claim groups when the OUTER transaction rolls back', async () => {
    const bookingId = await allocatedBooking();
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await releaseBookingAllocations(client, bookingId, 'test:outer-rollback');
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }
    expect(await liveCounts(bookingId)).toEqual({ provider: 1, resource: 1 });
    expect(await claimContradictions(getPool())).toEqual(NO_CONTRADICTIONS);
  });

  it('[P4-9] keeps applyBookingTransition one atomic status-change-and-release', async () => {
    const bookingId = await allocatedBooking();
    const result = await applyBookingTransition(getPool(), bookingId, 'confirmed', 'cancelled');
    expect(result.ok).toBe(true);
    expect(result.booking?.status).toBe('cancelled');
    expect(await liveCounts(bookingId)).toEqual({ provider: 0, resource: 0 });
    expect(await claimContradictions(getPool())).toEqual(NO_CONTRADICTIONS);
  });

  it('[P4-10] freezes released_occupancy at what was actually held', async () => {
    const bookingId = await allocatedBooking();
    const before = await getPool().query<{ occupancy: string }>(
      `SELECT occupancy::text FROM booking_provider_allocations
        WHERE booking_id = $1 AND released_at IS NULL`,
      [bookingId],
    );
    await releaseBookingAllocations(getPool(), bookingId, 'test:frozen');

    const after = await getPool().query<{ released_occupancy: string; matched: boolean }>(
      `SELECT released_occupancy::text, released_occupancy = $2::tstzrange AS matched
         FROM booking_provider_allocations WHERE booking_id = $1`,
      [bookingId, before.rows[0]!.occupancy],
    );
    expect(after.rows[0]!.matched).toBe(true);

    // A later reschedule cascades the live mirrors; history must not move with it.
    await getPool().query(
      "UPDATE bookings SET starts_at = starts_at + interval '2 hours', " +
        "ends_at = ends_at + interval '2 hours' WHERE id = $1",
      [bookingId],
    );
    const stillFrozen = await getPool().query<{ matched: boolean }>(
      `SELECT released_occupancy = $2::tstzrange AS matched
         FROM booking_provider_allocations WHERE booking_id = $1`,
      [bookingId, before.rows[0]!.occupancy],
    );
    expect(stillFrozen.rows[0]!.matched).toBe(true);
  });

  it('[P4-11] is a no-op when repeated on an already released booking', async () => {
    const bookingId = await allocatedBooking();
    await releaseBookingAllocations(getPool(), bookingId, 'test:first');

    const snapshot = async (): Promise<string> =>
      (
        await getPool().query<{ s: string }>(
          `SELECT coalesce(json_agg(json_build_object(
                    'seq', allocation_seq, 'reason', release_reason,
                    'at', released_at, 'occ', released_occupancy)
                  ORDER BY allocation_seq), '[]'::json)::text AS s
             FROM booking_provider_allocations WHERE booking_id = $1`,
          [bookingId],
        )
      ).rows[0]!.s;

    const first = await snapshot();
    // The second call finds nothing live, so it writes nothing — and in
    // particular it does not overwrite the recorded reason or timestamp, which
    // the schema forbids anyway.
    await releaseBookingAllocations(getPool(), bookingId, 'test:second');
    expect(await snapshot()).toBe(first);
    expect(await liveCounts(bookingId)).toEqual({ provider: 0, resource: 0 });
    expect(await claimContradictions(getPool())).toEqual(NO_CONTRADICTIONS);
  });
});
