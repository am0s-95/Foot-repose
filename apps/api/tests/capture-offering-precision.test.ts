import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { captureBookingRequirements } from '@foot-repose/db';
import { closePool, getPool } from '../src/lib/pool';
import {
  allocationErrorOf,
  backendPid,
  makeBooking,
  setupAllocationFixtures,
  waitUntilBlockedBy,
  type AllocationFixtures,
} from './allocation-helpers';

/**
 * Which offering version was effective when the booking starts — decided by
 * PostgreSQL, on the booking row, at full precision.
 *
 * This one had no foreign key to catch it. `valid_during @> $3::timestamptz`
 * was bound to a JavaScript `Date`, so a version boundary anywhere inside the
 * booking's own millisecond put the test instant on the wrong side of it, and
 * the capture SUCCEEDED with the previous version's price, duration, buffers
 * and resource requirements. Wrong money, wrong occupancy window, wrong room —
 * and no error anywhere.
 *
 * Every membership question below is therefore asked INSIDE PostgreSQL.
 * Comparing two values that have both already been truncated to a JavaScript
 * `Date` would agree with itself on exactly the data that used to be wrong.
 */
let fx: AllocationFixtures;

const DATE = '2030-04-07';
/** Boundaries deliberately placed BELOW the millisecond, on both edges. */
const LOWER = {
  boundary: '2030-04-07T06:00:00.123400Z',
  start: '2030-04-07T06:00:00.123456Z',
  digits: '123456',
};
const UPPER = {
  boundary: '2030-04-07T10:00:00.999400Z',
  start: '2030-04-07T10:00:00.999999Z',
  digits: '999999',
};

/** What the NEW version says, and none of it matches the fixture's old one. */
const NEW_VERSION = { price: 9900, duration: 60, bufferBefore: 5, bufferAfter: 20, rooms: 2 };
/** ...against the fixture's original: 8500 / 45 / 0 / 10 / one chair. */
const OLD_VERSION = { price: 8500, duration: 45, bufferBefore: 0, bufferAfter: 10 };

beforeEach(async () => {
  fx = await setupAllocationFixtures();
});

afterAll(async () => {
  await closePool();
});

interface Versions {
  oldId: string;
  newId: string;
}

/**
 * Split branch A's catalog into two EXACTLY adjacent versions at `boundary` —
 * no gap and no overlap, so exactly one of them covers any given instant.
 */
async function twoAdjacentVersions(boundary: string, captureNew = true): Promise<Versions> {
  const pool = getPool();
  const oldId = (
    await pool.query<{ id: string }>(
      `UPDATE branch_service_offerings
          SET valid_during = tstzrange(lower(valid_during), $2::timestamptz, '[)')
        WHERE branch_id = $1 AND upper(valid_during) IS NULL
        RETURNING id`,
      [fx.branchA, boundary],
    )
  ).rows[0]!.id;
  const newId = await addVersion(boundary, captureNew);
  return { oldId, newId };
}

async function addVersion(from: string, capture = true): Promise<string> {
  const pool = getPool();
  const id = (
    await pool.query<{ id: string }>(
      `INSERT INTO branch_service_offerings
         (branch_id, service_id, valid_during, price_baisa, duration_min,
          buffer_before_min, buffer_after_min)
       VALUES ($1, $2, tstzrange($3::timestamptz, NULL, '[)'), $4, $5, $6, $7)
       RETURNING id`,
      [
        fx.branchA,
        fx.service,
        from,
        NEW_VERSION.price,
        NEW_VERSION.duration,
        NEW_VERSION.bufferBefore,
        NEW_VERSION.bufferAfter,
      ],
    )
  ).rows[0]!.id;
  await pool.query(
    `INSERT INTO branch_service_offering_resources (offering_id, resource_type_id, required_qty)
     VALUES ($1, $2, $3)`,
    [id, fx.roomTypeId, NEW_VERSION.rooms],
  );
  if (capture) {
    await pool.query(
      'UPDATE branch_service_offerings SET resource_requirements_captured_at = now() WHERE id = $1',
      [id],
    );
  }
  return id;
}

/** A booking at an EXACT instant: the literal goes to PostgreSQL as text. */
async function bookAtExactInstant(literal: string): Promise<string> {
  return (
    await getPool().query<{ id: string }>(
      `INSERT INTO bookings
         (branch_id, customer_id, service_id, status, starts_at, ends_at, price_baisa,
          service_name_snapshot, duration_min_snapshot,
          buffer_before_min_snapshot, buffer_after_min_snapshot)
       VALUES ($1, $2, $3, 'confirmed', $4::timestamptz,
               fr_shift_minutes($4::timestamptz, 45), 8500, 'Fixture service', 45, 0, 10)
       RETURNING id`,
      [fx.branchA, fx.customerOne, fx.service, literal],
    )
  ).rows[0]!.id;
}

/** The version PostgreSQL itself says is effective, at full precision. */
async function effectiveOfferingId(bookingId: string): Promise<string | null> {
  const result = await getPool().query<{ id: string }>(
    `SELECT o.id
       FROM bookings b
       JOIN branch_service_offerings o
         ON o.branch_id = b.branch_id AND o.service_id = b.service_id
        AND o.valid_during @> b.starts_at
      WHERE b.id = $1`,
    [bookingId],
  );
  return result.rows[0]?.id ?? null;
}

interface Captured {
  price: number;
  duration: number;
  bufBefore: number;
  bufAfter: number;
  startDigits: string;
  endDigits: string;
  endsFromStart: boolean;
  sourceOfferingId: string | null;
  requirements: { code: string; qty: number }[];
}

async function captured(bookingId: string): Promise<Captured> {
  const booking = await getPool().query<{
    price_baisa: number;
    duration: number;
    buf_before: number;
    buf_after: number;
    start_digits: string;
    end_digits: string;
    ends_from_start: boolean;
  }>(
    `SELECT price_baisa, duration_min_snapshot AS duration,
            buffer_before_min_snapshot AS buf_before,
            buffer_after_min_snapshot AS buf_after,
            to_char(starts_at AT TIME ZONE 'UTC', 'US') AS start_digits,
            to_char(ends_at   AT TIME ZONE 'UTC', 'US') AS end_digits,
            -- derived by the database from the EXACT start, not rebuilt outside
            ends_at = fr_shift_minutes(starts_at, duration_min_snapshot) AS ends_from_start
       FROM bookings WHERE id = $1`,
    [bookingId],
  );
  const header = await getPool().query<{ source: string }>(
    `SELECT source_offering_id AS source FROM booking_resource_requirement_sets
      WHERE booking_id = $1`,
    [bookingId],
  );
  const reqs = await getPool().query<{ code: string; required_qty: number }>(
    `SELECT t.code, r.required_qty FROM booking_resource_requirements r
       JOIN resource_types t ON t.id = r.resource_type_id
      WHERE r.booking_id = $1 ORDER BY t.code`,
    [bookingId],
  );
  const row = booking.rows[0]!;
  return {
    price: row.price_baisa,
    duration: row.duration,
    bufBefore: row.buf_before,
    bufAfter: row.buf_after,
    startDigits: row.start_digits,
    endDigits: row.end_digits,
    endsFromStart: row.ends_from_start,
    sourceOfferingId: header.rows[0]?.source ?? null,
    requirements: reqs.rows.map((r) => ({ code: r.code, qty: r.required_qty })),
  };
}

// ============================================ the boundary inside a millisecond

describe('[CP] the effective version is chosen at full precision', () => {
  for (const [label, plan] of [
    ['lower edge .123456 against a .123400 boundary', LOWER],
    ['upper edge .999999 against a .999400 boundary', UPPER],
  ] as const) {
    it(`[CP-1/2] ${label}`, async () => {
      const { oldId, newId } = await twoAdjacentVersions(plan.boundary);
      const bookingId = await bookAtExactInstant(plan.start);

      // The premise, asserted rather than assumed: PostgreSQL puts the exact
      // instant in the NEW version and the TRUNCATED instant in the OLD one.
      const sides = await getPool().query<{
        exact_new: boolean;
        exact_old: boolean;
        truncated_new: boolean;
        truncated_old: boolean;
        micros: string;
      }>(
        `SELECT (SELECT valid_during @> b.starts_at FROM branch_service_offerings WHERE id = $2)
                  AS exact_new,
                (SELECT valid_during @> b.starts_at FROM branch_service_offerings WHERE id = $3)
                  AS exact_old,
                (SELECT valid_during @> date_trunc('milliseconds', b.starts_at)
                   FROM branch_service_offerings WHERE id = $2) AS truncated_new,
                (SELECT valid_during @> date_trunc('milliseconds', b.starts_at)
                   FROM branch_service_offerings WHERE id = $3) AS truncated_old,
                to_char(b.starts_at AT TIME ZONE 'UTC', 'US') AS micros
           FROM bookings b WHERE b.id = $1`,
        [bookingId, newId, oldId],
      );
      expect(sides.rows[0]).toEqual({
        exact_new: true,
        exact_old: false,
        truncated_new: false,
        truncated_old: true,
        micros: plan.digits,
      });

      const returned = await captureBookingRequirements(getPool(), bookingId);

      // [CP-3] the id returned is the one PostgreSQL calls effective.
      expect(returned).toBe(newId);
      expect(returned).toBe(await effectiveOfferingId(bookingId));

      const snapshot = await captured(bookingId);
      expect(snapshot.sourceOfferingId).toBe(newId); // [CP-4]
      expect(snapshot.price).toBe(NEW_VERSION.price); // [CP-5]
      expect(snapshot.duration).toBe(NEW_VERSION.duration); // [CP-6]
      expect(snapshot.bufBefore).toBe(NEW_VERSION.bufferBefore); // [CP-7]
      expect(snapshot.bufAfter).toBe(NEW_VERSION.bufferAfter);
      // [CP-8] the NEW version's requirements, and [CP-9] nothing from the old.
      expect(snapshot.requirements).toEqual([{ code: 'room', qty: NEW_VERSION.rooms }]);
      // [CP-10] ends_at is the exact start shifted by the NEW duration, and it
      // still carries all six digits.
      expect(snapshot.endsFromStart).toBe(true);
      expect(snapshot.startDigits).toBe(plan.digits);
      expect(snapshot.endDigits).toBe(plan.digits);

      // Nothing about the OLD version survived anywhere.
      expect(snapshot.price).not.toBe(OLD_VERSION.price);
      expect(snapshot.duration).not.toBe(OLD_VERSION.duration);
      expect(snapshot.requirements.map((r) => r.code)).not.toContain('chair');
    });
  }

  it('[CP-11] a version gap that contains ONLY the truncated instant no longer refuses', async () => {
    // The old version ends months earlier; the new one opens inside the
    // booking's own millisecond. The exact instant is covered; the truncated one
    // falls in the gap — which used to be reported as "no offering is effective".
    await getPool().query(
      `UPDATE branch_service_offerings
          SET valid_during = tstzrange(lower(valid_during), '2030-01-01T00:00:00Z', '[)')
        WHERE branch_id = $1 AND upper(valid_during) IS NULL`,
      [fx.branchA],
    );
    const newId = await addVersion(LOWER.boundary);
    const bookingId = await bookAtExactInstant(LOWER.start);

    const gap = await getPool().query<{ exact: boolean; truncated: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM branch_service_offerings o
                       WHERE o.branch_id = b.branch_id AND o.service_id = b.service_id
                         AND o.valid_during @> b.starts_at) AS exact,
              EXISTS (SELECT 1 FROM branch_service_offerings o
                       WHERE o.branch_id = b.branch_id AND o.service_id = b.service_id
                         AND o.valid_during @> date_trunc('milliseconds', b.starts_at)) AS truncated
         FROM bookings b WHERE b.id = $1`,
      [bookingId],
    );
    expect(gap.rows[0]).toEqual({ exact: true, truncated: false });

    expect(await captureBookingRequirements(getPool(), bookingId)).toBe(newId);
    expect((await captured(bookingId)).price).toBe(NEW_VERSION.price);
  });

  it('[CP-12] a booking genuinely outside every version is still refused', async () => {
    await getPool().query(
      `UPDATE branch_service_offerings
          SET valid_during = tstzrange(lower(valid_during), '2030-01-01T00:00:00Z', '[)')
        WHERE branch_id = $1 AND upper(valid_during) IS NULL`,
      [fx.branchA],
    );
    const bookingId = await bookAtExactInstant(LOWER.start);
    expect(await effectiveOfferingId(bookingId)).toBeNull();
    expect(await allocationErrorOf(() => captureBookingRequirements(getPool(), bookingId))).toBe(
      'offering_not_effective',
    );
  });

  it('[CP-13] an effective version with uncaptured requirements is still refused', async () => {
    const { newId } = await twoAdjacentVersions(LOWER.boundary, false);
    const bookingId = await bookAtExactInstant(LOWER.start);
    // The precise version IS found — it is the one that has nothing to copy.
    expect(await effectiveOfferingId(bookingId)).toBe(newId);
    expect(await allocationErrorOf(() => captureBookingRequirements(getPool(), bookingId))).toBe(
      'offering_requirements_not_captured',
    );
    const sets = await getPool().query(
      'SELECT 1 FROM booking_resource_requirement_sets WHERE booking_id = $1',
      [bookingId],
    );
    expect(sets.rowCount).toBe(0);
  });

  it('[CP-14] an ordinary millisecond booking is unchanged', async () => {
    const bookingId = await makeBooking({
      branchId: fx.branchA,
      isoDate: DATE,
      hour: 10,
      serviceId: fx.service,
      customerId: fx.customerOne,
    });
    const returned = await captureBookingRequirements(getPool(), bookingId);
    expect(returned).toBe(fx.offeringA);
    const snapshot = await captured(bookingId);
    expect(snapshot.price).toBe(OLD_VERSION.price);
    expect(snapshot.duration).toBe(OLD_VERSION.duration);
    expect(snapshot.bufBefore).toBe(OLD_VERSION.bufferBefore);
    expect(snapshot.bufAfter).toBe(OLD_VERSION.bufferAfter);
    expect(snapshot.requirements).toEqual([{ code: 'chair', qty: 1 }]);
    expect(snapshot.startDigits).toBe('000000');
    expect(snapshot.endsFromStart).toBe(true);
  });
});

// ================================================================== locking

/**
 * Reading the booking inside the offering query must not have loosened
 * anything: the booking is still locked FOR UPDATE first, and the chosen
 * offering row is still held FOR SHARE for the rest of the unit of work.
 */
describe('[CP] the locks the capture depended on are still held', () => {
  it('holds the booking row FOR UPDATE across the capture', async () => {
    const bookingId = await bookAtExactInstant(LOWER.start);
    await twoAdjacentVersions(LOWER.boundary);
    const pool = getPool();
    const holder = await pool.connect();
    const rival = await pool.connect();
    try {
      const holderPid = await backendPid(holder);
      const rivalPid = await backendPid(rival);
      await holder.query('BEGIN');
      await captureBookingRequirements(holder, bookingId);

      const blocked = rival.query('SELECT id FROM bookings WHERE id = $1 FOR UPDATE', [bookingId]);
      expect(await waitUntilBlockedBy(pool, rivalPid)).toContain(holderPid);
      await holder.query('COMMIT');
      await blocked;
    } finally {
      holder.release();
      rival.release();
    }
  }, 30_000);

  it('holds the SELECTED offering row FOR SHARE, so its values cannot move under the snapshot', async () => {
    const { newId } = await twoAdjacentVersions(LOWER.boundary);
    const bookingId = await bookAtExactInstant(LOWER.start);
    const pool = getPool();
    const holder = await pool.connect();
    const rival = await pool.connect();
    try {
      const holderPid = await backendPid(holder);
      const rivalPid = await backendPid(rival);
      await holder.query('BEGIN');
      expect(await captureBookingRequirements(holder, bookingId)).toBe(newId);

      // A concurrent repricing of that exact version has to wait.
      const repricing = rival.query(
        'UPDATE branch_service_offerings SET price_baisa = 1 WHERE id = $1',
        [newId],
      );
      expect(await waitUntilBlockedBy(pool, rivalPid)).toContain(holderPid);
      await holder.query('COMMIT');
      await repricing;
    } finally {
      holder.release();
      rival.release();
    }

    // The snapshot kept what was effective when it was taken.
    expect((await captured(bookingId)).price).toBe(NEW_VERSION.price);
  }, 30_000);
});
