import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  allocateBooking,
  captureBookingRequirements,
  swapProviders,
  swapResources,
} from '@foot-repose/db';
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
 * Atomic swaps [R4A-3 / R4-5].
 *
 * Two independent reassignments are not a swap: each releases its own side and
 * then collides with the other side's committed claim. A real exchange is one
 * transaction — and two concurrent exchanges must produce ONE winner, not two
 * serialised swaps that quietly cancel out.
 */
let fx: AllocationFixtures;
const DATE = '2030-04-07';

interface Pair {
  a: string;
  b: string;
  c: string;
}

/** Two bookings at the SAME time with different providers and different units,
 * plus an unrelated third booking whose claims must never be touched. */
async function threeBookings(): Promise<Pair> {
  const pool = getPool();
  const mk = (hour: number): Promise<string> =>
    makeBooking({
      branchId: fx.branchA,
      isoDate: DATE,
      hour,
      serviceId: fx.service,
      customerId: fx.customerOne,
    });
  const a = await mk(10);
  const b = await mk(10);
  const c = await mk(15);
  for (const id of [a, b, c]) await captureBookingRequirements(pool, id);
  await allocateBooking(pool, a, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
  await allocateBooking(pool, b, { employeeId: fx.staffB.id, resourceIds: [fx.chairA2] });
  await allocateBooking(pool, c, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
  return { a, b, c };
}

const seqs = async (table: string, bookingId: string): Promise<string[]> => {
  const rows = await getPool().query<{ allocation_seq: string }>(
    `SELECT allocation_seq FROM ${table} WHERE booking_id = $1 AND released_at IS NULL
     ORDER BY allocation_seq`,
    [bookingId],
  );
  return rows.rows.map((r) => r.allocation_seq);
};

const providerOf = async (bookingId: string): Promise<string | null> => {
  const rows = await getPool().query<{ employee_id: string }>(
    'SELECT employee_id FROM booking_provider_allocations WHERE booking_id = $1 AND released_at IS NULL',
    [bookingId],
  );
  return rows.rows[0]?.employee_id ?? null;
};

const resourceOf = async (bookingId: string): Promise<string | null> => {
  const rows = await getPool().query<{ resource_id: string }>(
    'SELECT resource_id FROM booking_resource_allocations WHERE booking_id = $1 AND released_at IS NULL',
    [bookingId],
  );
  return rows.rows[0]?.resource_id ?? null;
};

beforeEach(async () => {
  fx = await setupAllocationFixtures();
});

afterAll(async () => {
  await closePool();
});

describe('a real swap is one transaction', () => {
  it('[R4-5/V19] exchanges two providers atomically', async () => {
    const { a, b } = await threeBookings();
    const [beforeA, beforeB] = [await providerOf(a), await providerOf(b)];
    await swapProviders(getPool(), {
      a: { bookingId: a, expectedAllocationSeqs: await seqs('booking_provider_allocations', a) },
      b: { bookingId: b, expectedAllocationSeqs: await seqs('booking_provider_allocations', b) },
    });
    expect(await providerOf(a)).toBe(beforeB);
    expect(await providerOf(b)).toBe(beforeA);
  });

  it('[R4A-4/V25] exchanges two resource sets atomically', async () => {
    const { a, b } = await threeBookings();
    const [beforeA, beforeB] = [await resourceOf(a), await resourceOf(b)];
    await swapResources(getPool(), {
      a: { bookingId: a, expectedAllocationSeqs: await seqs('booking_resource_allocations', a) },
      b: { bookingId: b, expectedAllocationSeqs: await seqs('booking_resource_allocations', b) },
    });
    expect(await resourceOf(a)).toBe(beforeB);
    expect(await resourceOf(b)).toBe(beforeA);
    // The released rows stay, with the window they really held frozen.
    const history = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM booking_resource_allocations
       WHERE booking_id = ANY($1::uuid[]) AND released_at IS NOT NULL
         AND released_occupancy IS NOT NULL`,
      [[a, b]],
    );
    expect(history.rows[0]!.n).toBe(2);
  });
});

describe('exact expected state [R4A-3]', () => {
  it('[A3.1] refuses a sequence belonging to a third booking, and leaves it untouched', async () => {
    const { a, b, c } = await threeBookings();
    const cSeqs = await seqs('booking_provider_allocations', c);
    const bSeqs = await seqs('booking_provider_allocations', b);
    expect(
      await allocationErrorOf(() =>
        swapProviders(getPool(), {
          a: { bookingId: a, expectedAllocationSeqs: cSeqs },
          b: { bookingId: b, expectedAllocationSeqs: bSeqs },
        }),
      ),
    ).toBe('stale');
    // C is exactly as it was — a flat global `allocation_seq = ANY(...)` would
    // have released it.
    expect(await seqs('booking_provider_allocations', c)).toEqual(cSeqs);
    expect(await providerOf(c)).toBe(fx.staffA.id);
  });

  it('[A3.2] refuses when a live allocation of one side was not listed', async () => {
    const { a, b } = await threeBookings();
    // Give A a second unit so its live set has two rows, then list only one.
    await getPool().query(
      `INSERT INTO booking_resource_allocations
         (booking_id, branch_id, resource_id, resource_type_id,
          b_starts_at, b_ends_at, b_buf_before, b_buf_after)
       SELECT bk.id, bk.branch_id, $2, $3, bk.starts_at, bk.ends_at,
              bk.buffer_before_min_snapshot, bk.buffer_after_min_snapshot
       FROM bookings bk WHERE bk.id = $1`,
      [a, fx.roomA1, fx.roomTypeId],
    );
    const before = await seqs('booking_resource_allocations', a);
    const bSeqs = await seqs('booking_resource_allocations', b);
    expect(before).toHaveLength(2);
    expect(
      await allocationErrorOf(() =>
        swapResources(getPool(), {
          a: { bookingId: a, expectedAllocationSeqs: [before[0]!] },
          b: { bookingId: b, expectedAllocationSeqs: bSeqs },
        }),
      ),
    ).toBe('stale');
    expect(await seqs('booking_resource_allocations', a)).toEqual(before);
  });

  it('[A3.3] refuses a crossed mapping', async () => {
    const { a, b } = await threeBookings();
    const aSeqs = await seqs('booking_provider_allocations', a);
    const bSeqs = await seqs('booking_provider_allocations', b);
    expect(
      await allocationErrorOf(() =>
        swapProviders(getPool(), {
          a: { bookingId: a, expectedAllocationSeqs: bSeqs },
          b: { bookingId: b, expectedAllocationSeqs: aSeqs },
        }),
      ),
    ).toBe('stale');
    expect(await providerOf(a)).toBe(fx.staffA.id);
    expect(await providerOf(b)).toBe(fx.staffB.id);
  });

  it('[A3.4] refuses an empty expectation while live allocations exist', async () => {
    const { a, b } = await threeBookings();
    const bSeqs = await seqs('booking_provider_allocations', b);
    expect(
      await allocationErrorOf(() =>
        swapProviders(getPool(), {
          a: { bookingId: a, expectedAllocationSeqs: [] },
          b: { bookingId: b, expectedAllocationSeqs: bSeqs },
        }),
      ),
    ).toBe('stale');
    expect(await providerOf(a)).toBe(fx.staffA.id);
  });

  it('[A3.5] refuses duplicate sequence values', async () => {
    const { a, b } = await threeBookings();
    const aSeqs = await seqs('booking_provider_allocations', a);
    const bSeqs = await seqs('booking_provider_allocations', b);
    expect(
      await allocationErrorOf(() =>
        swapProviders(getPool(), {
          a: { bookingId: a, expectedAllocationSeqs: [...aSeqs, ...aSeqs] },
          b: { bookingId: b, expectedAllocationSeqs: bSeqs },
        }),
      ),
    ).toBe('stale');
    expect(await providerOf(a)).toBe(fx.staffA.id);
  });
});

describe('two concurrent calls to the swap itself', () => {
  /**
   * Deterministic, not hopeful: the first connection holds its transaction open
   * so the second is PROVEN blocked on it (via pg_blocking_pids for that exact
   * backend, not a global count of ungranted locks) before the first commits.
   */
  async function raceSameSwap(
    table: 'booking_provider_allocations' | 'booking_resource_allocations',
    swap: typeof swapProviders,
  ): Promise<{ secondError: string; blockers: number[] }> {
    const { a, b } = await threeBookings();
    const spec = {
      a: { bookingId: a, expectedAllocationSeqs: await seqs(table, a) },
      b: { bookingId: b, expectedAllocationSeqs: await seqs(table, b) },
    };
    const pool = getPool();
    const first = await pool.connect();
    const second = await pool.connect();
    try {
      const secondPid = await backendPid(second);
      const firstPid = await backendPid(first);
      await first.query('BEGIN');
      await swap(first, spec);

      await second.query('BEGIN');
      const pending = swap(second, spec).then(
        () => 'no error',
        (error: { code?: string }) => error.code ?? 'unknown',
      );
      const blockers = await waitUntilBlockedBy(pool, secondPid);
      expect(blockers).toContain(firstPid);

      await first.query('COMMIT');
      const secondError = await pending;
      await second.query('ROLLBACK').catch(() => undefined);
      return { secondError, blockers };
    } finally {
      first.release();
      second.release();
    }
  }

  it('[A3.6] swapProviders: one winner, one stale rejection, zero deadlocks', async () => {
    const { secondError } = await raceSameSwap('booking_provider_allocations', swapProviders);
    expect(secondError).toBe('stale');
    expect(secondError).not.toBe('40P01');
  }, 30_000);

  it('[A3.7] swapResources: one winner, one stale rejection, zero deadlocks', async () => {
    const { secondError } = await raceSameSwap('booking_resource_allocations', swapResources);
    expect(secondError).toBe('stale');
    expect(secondError).not.toBe('40P01');
  }, 30_000);

  /**
   * [C2] Eligibility has to STAY true for as long as the claim is live.
   *
   * Locking the evidence rows only protects the moment of allocation: the very
   * same mutation could commit a heartbeat later and leave a live claim by a
   * provider who is no longer assigned or qualified. So the mutation is judged
   * against the state it produces, by a statement-level guard.
   *
   * The race is deterministic: the allocator holds its transaction open, the
   * writer is PROVEN blocked on it (pg_blocking_pids for that exact backend),
   * and only then does the allocator commit.
   */
  interface RaceOutcome {
    blockedByAllocator: boolean;
    writerError: string;
    liveClaims: number;
    uncoveredClaims: number;
  }

  /** Live claims of this booking whose provider lacks assignment or
   * qualification on any Muscat date the claim occupies. Must always be 0. */
  async function uncoveredClaims(bookingId: string): Promise<number> {
    const rows = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n
       FROM booking_provider_allocations a
       JOIN bookings b ON b.id = a.booking_id
       CROSS JOIN LATERAL (
         SELECT (lower(a.occupancy) AT TIME ZONE 'Asia/Muscat')::date AS d
         UNION
         SELECT ((upper(a.occupancy) - interval '1 microsecond') AT TIME ZONE 'Asia/Muscat')::date
       ) dates
       WHERE a.booking_id = $1 AND a.released_at IS NULL
         AND (NOT EXISTS (SELECT 1 FROM provider_branch_assignments pa
                           WHERE pa.employee_id = a.employee_id AND pa.branch_id = a.branch_id
                             AND pa.valid_dates @> dates.d)
           OR NOT EXISTS (SELECT 1 FROM provider_service_qualifications q
                           WHERE q.employee_id = a.employee_id AND q.service_id = b.service_id
                             AND q.valid_dates @> dates.d))`,
      [bookingId],
    );
    return rows.rows[0]!.n;
  }

  async function eligibilityRace(
    mutation: { sql: string; values: unknown[] },
  ): Promise<RaceOutcome> {
    const pool = getPool();
    const booking = await makeBooking({
      branchId: fx.branchA,
      isoDate: DATE,
      hour: 10,
      serviceId: fx.service,
      customerId: fx.customerOne,
    });
    await captureBookingRequirements(pool, booking);

    const allocator = await pool.connect();
    const writer = await pool.connect();
    try {
      const allocatorPid = await backendPid(allocator);
      const writerPid = await backendPid(writer);
      await allocator.query('BEGIN');
      await allocateBooking(allocator, booking, {
        employeeId: fx.staffA.id,
        resourceIds: [fx.chairA1],
      });

      await writer.query('BEGIN');
      const pending = writer.query(mutation.sql, mutation.values).then(
        () => 'no error',
        (error: { code?: string; message?: string }) =>
          error.code === 'P0001' ? 'rejected' : (error.code ?? error.message ?? 'unknown'),
      );
      const blockers = await waitUntilBlockedBy(pool, writerPid);
      const blockedByAllocator = blockers.includes(allocatorPid);

      await allocator.query('COMMIT');
      const writerError = await pending;
      // Whatever the writer attempted, it must not be able to keep it.
      await writer.query(writerError === 'no error' ? 'COMMIT' : 'ROLLBACK').catch(() => undefined);

      const live = await pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM booking_provider_allocations
         WHERE booking_id = $1 AND released_at IS NULL`,
        [booking],
      );
      return {
        blockedByAllocator,
        writerError,
        liveClaims: live.rows[0]!.n,
        uncoveredClaims: await uncoveredClaims(booking),
      };
    } finally {
      allocator.release();
      writer.release();
    }
  }

  it('[C2] a branch assignment moved out of coverage blocks, then is REJECTED', async () => {
    const result = await eligibilityRace({
      sql: `UPDATE provider_branch_assignments
               SET valid_dates = daterange('2029-01-01'::date, '2029-06-01'::date, '[)')
             WHERE employee_id = $1 AND branch_id = $2`,
      values: [fx.staffA.id, fx.branchA],
    });
    expect(result.blockedByAllocator).toBe(true);
    expect(result.writerError).toBe('rejected');
    expect(result.liveClaims).toBe(1);
    expect(result.uncoveredClaims).toBe(0);
  }, 30_000);

  it('[C2] deleting the assignment that justifies a live claim blocks, then is REJECTED', async () => {
    const result = await eligibilityRace({
      sql: 'DELETE FROM provider_branch_assignments WHERE employee_id = $1 AND branch_id = $2',
      values: [fx.staffA.id, fx.branchA],
    });
    expect(result.blockedByAllocator).toBe(true);
    expect(result.writerError).toBe('rejected');
    expect(result.uncoveredClaims).toBe(0);
  }, 30_000);

  it('[C2] a qualification moved out of coverage blocks, then is REJECTED', async () => {
    const result = await eligibilityRace({
      sql: `UPDATE provider_service_qualifications
               SET valid_dates = daterange('2029-01-01'::date, '2029-06-01'::date, '[)')
             WHERE employee_id = $1 AND service_id = $2`,
      values: [fx.staffA.id, fx.service],
    });
    expect(result.blockedByAllocator).toBe(true);
    expect(result.writerError).toBe('rejected');
    expect(result.liveClaims).toBe(1);
    expect(result.uncoveredClaims).toBe(0);
  }, 30_000);

  /**
   * Migration 0005 already forbids two OVERLAPPING assignments for one
   * (employee, branch), so the "each row excused by its overlapping sibling"
   * shape cannot arise on these two tables. What can arise — and what the two
   * tests below cover — is a historical row alongside the covering one, and a
   * single statement that removes both.
   */
  const addHistoricalAssignment = (): Promise<unknown> =>
    getPool().query(
      `INSERT INTO provider_branch_assignments (employee_id, branch_id, valid_dates)
       VALUES ($1, $2, daterange('2028-01-01'::date, '2029-01-01'::date, '[)'))`,
      [fx.staffA.id, fx.branchA],
    );

  it('[C2] the mutation is ALLOWED when the remaining row still provides full coverage', async () => {
    await addHistoricalAssignment();
    const result = await eligibilityRace({
      sql: `DELETE FROM provider_branch_assignments
             WHERE employee_id = $1 AND branch_id = $2 AND upper(valid_dates) = '2029-01-01'`,
      values: [fx.staffA.id, fx.branchA],
    });
    expect(result.writerError).toBe('no error');
    expect(result.liveClaims).toBe(1);
    expect(result.uncoveredClaims).toBe(0);
  }, 30_000);

  it('[C2] a multi-row DELETE is judged on the COMPLETE post-statement state', async () => {
    await addHistoricalAssignment();
    // One statement, two rows in the transition table: the guard sees the state
    // AFTER both are gone, not each row in isolation.
    const result = await eligibilityRace({
      sql: 'DELETE FROM provider_branch_assignments WHERE employee_id = $1 AND branch_id = $2',
      values: [fx.staffA.id, fx.branchA],
    });
    expect(result.writerError).toBe('rejected');
    expect(result.uncoveredClaims).toBe(0);
    // And both rows survived the rollback.
    const remaining = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM provider_branch_assignments WHERE employee_id = $1 AND branch_id = $2',
      [fx.staffA.id, fx.branchA],
    );
    expect(remaining.rows[0]!.n).toBe(2);
  }, 30_000);

  it('[C2] when the eligibility change commits FIRST, the later allocation refuses', async () => {
    const booking = await makeBooking({
      branchId: fx.branchA,
      isoDate: DATE,
      hour: 10,
      serviceId: fx.service,
      customerId: fx.customerOne,
    });
    await captureBookingRequirements(getPool(), booking);
    await getPool().query(
      `UPDATE provider_branch_assignments
          SET valid_dates = daterange('2029-01-01'::date, '2029-06-01'::date, '[)')
        WHERE employee_id = $1 AND branch_id = $2`,
      [fx.staffA.id, fx.branchA],
    );
    expect(
      await allocationErrorOf(() =>
        allocateBooking(getPool(), booking, {
          employeeId: fx.staffA.id,
          resourceIds: [fx.chairA1],
        }),
      ),
    ).toBe('not_assigned_to_branch');
    expect(await uncoveredClaims(booking)).toBe(0);
  }, 30_000);

  it('[11] two concurrent allocations of the same provider: exactly one succeeds', async () => {
    const pool = getPool();
    const first = await makeBooking({
      branchId: fx.branchA,
      isoDate: DATE,
      hour: 10,
      serviceId: fx.service,
      customerId: fx.customerOne,
    });
    const second = await makeBooking({
      branchId: fx.branchA,
      isoDate: DATE,
      hour: 10,
      minute: 30,
      serviceId: fx.service,
      customerId: fx.customerTwo,
    });
    for (const id of [first, second]) await captureBookingRequirements(pool, id);

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    try {
      const pid1 = await backendPid(c1);
      const pid2 = await backendPid(c2);
      await c1.query('BEGIN');
      await allocateBooking(c1, first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });

      await c2.query('BEGIN');
      const pending = allocateBooking(c2, second, {
        employeeId: fx.staffA.id,
        resourceIds: [fx.chairA2],
      }).then(
        () => 'no error',
        (error: { code?: string }) => error.code ?? 'unknown',
      );
      // The second waits on the first's uncommitted claim — that is the
      // exclusion constraint doing the deciding, not application code.
      expect(await waitUntilBlockedBy(pool, pid2)).toContain(pid1);
      await c1.query('COMMIT');
      expect(await pending).toBe('23P01');
      await c2.query('ROLLBACK').catch(() => undefined);
    } finally {
      c1.release();
      c2.release();
    }
    expect(await providerOf(first)).toBe(fx.staffA.id);
    expect(await providerOf(second)).toBeNull();
  }, 30_000);
});
