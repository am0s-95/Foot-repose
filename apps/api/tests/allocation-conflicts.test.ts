import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  allocateBooking,
  AllocationError,
  captureBookingRequirements,
  classifyClaimConflict,
  reassignProvider,
  swapProviders,
  swapResources,
} from '@foot-repose/db';
import { closePool, getPool } from '../src/lib/pool';
import {
  backendPid,
  claimContradictions,
  makeBooking,
  NO_CONTRADICTIONS,
  replaceOffering,
  setupAllocationFixtures,
  sqlstateOf,
  waitUntilBlockedBy,
  type AllocationFixtures,
} from './allocation-helpers';

/**
 * P5 — an expected conflict is an answer, not a crash.
 *
 * "The provider is already booked" and "the database is broken" arrived at the
 * caller as the same thing: a raw `pg` `DatabaseError`. Telling them apart meant
 * knowing a SQLSTATE and a constraint name, which is repository knowledge that
 * had leaked out of the repository.
 *
 * What is asserted here is deliberately narrow. PostgreSQL still decides every
 * conflict; nothing is pre-checked, nothing is retried, and a classified
 * conflict still aborts and rolls back the whole unit of work. Only the NAME of
 * the answer changed — and only for four exact constraint names.
 */
let fx: AllocationFixtures;
const DATE = '2030-04-07';

beforeEach(async () => {
  fx = await setupAllocationFixtures();
});

afterAll(async () => {
  await closePool();
});

const book = (hour: number, minute = 0): Promise<string> =>
  makeBooking({
    branchId: fx.branchA,
    isoDate: DATE,
    hour,
    minute,
    serviceId: fx.service,
    customerId: fx.customerOne,
  });

const booked = async (hour: number, minute = 0): Promise<string> => {
  const id = await book(hour, minute);
  await captureBookingRequirements(getPool(), id);
  return id;
};

/** What the caller actually caught: the class, the code, and the message. */
interface Caught {
  constructor: string;
  isAllocationError: boolean;
  code: string;
  message: string;
  cause: { code?: string; constraint?: string; detail?: string; hasStack: boolean } | null;
}

async function caught(run: () => Promise<unknown>): Promise<Caught> {
  try {
    await run();
    return {
      constructor: '(none)',
      isAllocationError: false,
      code: 'no error',
      message: '',
      cause: null,
    };
  } catch (error) {
    const cause = (error as { cause?: unknown }).cause as
      | { code?: string; constraint?: string; detail?: string; stack?: string }
      | undefined;
    return {
      constructor: (error as object).constructor.name,
      isAllocationError: error instanceof AllocationError,
      code: (error as { code?: string }).code ?? '(no code)',
      message: (error as Error).message,
      cause:
        cause === undefined
          ? null
          : {
              code: cause.code,
              constraint: cause.constraint,
              detail: cause.detail,
              hasStack: typeof cause.stack === 'string' && cause.stack.length > 0,
            },
    };
  }
}

const liveCounts = async (
  bookingId: string,
  db: { query: ReturnType<typeof getPool>['query'] } = getPool(),
): Promise<{ provider: number; resource: number }> => {
  const result = await db.query<{ p: number; s: number }>(
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

// ================================================= the classified refusals

describe('[P5] expected conflicts reach the caller classified', () => {
  it('[P5-1] provider overlap on initial allocation', async () => {
    const first = await booked(10);
    const second = await booked(10, 30);
    await allocateBooking(getPool(), first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });

    const result = await caught(() =>
      allocateBooking(getPool(), second, { employeeId: fx.staffA.id, resourceIds: [fx.chairA2] }),
    );
    expect(result.isAllocationError).toBe(true);
    expect(result.constructor).toBe('AllocationError');
    expect(result.code).toBe('provider_conflict');
    expect(result.message).toBe('The provider is already allocated for an overlapping time');
    expect(await liveCounts(second)).toEqual({ provider: 0, resource: 0 });
  });

  it('[P5-2] resource overlap on initial allocation', async () => {
    const first = await booked(10);
    const second = await booked(10, 30);
    await allocateBooking(getPool(), first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });

    const result = await caught(() =>
      allocateBooking(getPool(), second, { employeeId: fx.staffB.id, resourceIds: [fx.chairA1] }),
    );
    expect(result.isAllocationError).toBe(true);
    expect(result.code).toBe('resource_conflict');
    expect(result.message).toBe('The resource is already allocated for an overlapping time');
  });

  it('[P5-3] a resource conflict rolls back the provider claim made moments earlier', async () => {
    // The provider was free and its claim DID succeed inside the transaction;
    // the unit is what failed. Nothing may survive that.
    const first = await booked(10);
    const second = await booked(10, 30);
    await allocateBooking(getPool(), first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });

    const result = await caught(() =>
      allocateBooking(getPool(), second, { employeeId: fx.staffB.id, resourceIds: [fx.chairA1] }),
    );
    expect(result.code).toBe('resource_conflict');
    expect(await liveCounts(second)).toEqual({ provider: 0, resource: 0 });
    expect(await claimContradictions(getPool())).toEqual(NO_CONTRADICTIONS);
  });

  it('[P5-4] re-allocating a booking that already holds claims, both measured shapes', async () => {
    const bookingId = await booked(10);
    await allocateBooking(getPool(), bookingId, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });

    // Same provider again: the EXCLUSION constraint answers first (23P01), since
    // the provider already overlaps itself.
    const same = await caught(() =>
      allocateBooking(getPool(), bookingId, { employeeId: fx.staffA.id, resourceIds: [fx.chairA2] }),
    );
    expect(same.code).toBe('provider_conflict');
    expect(same.cause?.code).toBe('23P01');
    expect(same.cause?.constraint).toBe('provider_no_double_booking');

    // A different provider: no overlap for THAT employee, so the one-live-per-
    // booking unique index answers instead (23505). Different constraint, same
    // classified answer — which is the whole point of mapping by name.
    const other = await caught(() =>
      allocateBooking(getPool(), bookingId, { employeeId: fx.staffB.id, resourceIds: [fx.chairA2] }),
    );
    expect(other.code).toBe('provider_conflict');
    expect(other.cause?.code).toBe('23505');
    expect(other.cause?.constraint).toBe('provider_allocation_one_live_idx');
    expect(other.message).toBe('This booking already has a live provider allocation');

    expect(await providerOf(bookingId)).toBe(fx.staffA.id);
    expect(await liveCounts(bookingId)).toEqual({ provider: 1, resource: 1 });
  });

  it('[P5-5] reassignProvider into an already-occupied provider', async () => {
    const first = await booked(10);
    const second = await booked(10, 30);
    await allocateBooking(getPool(), first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
    await allocateBooking(getPool(), second, {
      employeeId: fx.staffB.id,
      resourceIds: [fx.chairA2],
    });

    const result = await caught(() => reassignProvider(getPool(), second, fx.staffA.id));
    expect(result.code).toBe('provider_conflict');
    // The release-then-claim is one unit: the old provider is still there.
    expect(await providerOf(second)).toBe(fx.staffB.id);
    expect(await liveCounts(second)).toEqual({ provider: 1, resource: 1 });
  });

  it('[P5-6] swapProviders colliding with a third booking rolls BOTH sides back', async () => {
    const a = await booked(10);
    const b = await booked(14);
    const blocker = await booked(10, 15);
    await allocateBooking(getPool(), a, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
    await allocateBooking(getPool(), b, { employeeId: fx.staffB.id, resourceIds: [fx.chairA1] });
    // staffB is busy in a window overlapping a, so a cannot receive them.
    await allocateBooking(getPool(), blocker, {
      employeeId: fx.staffB.id,
      resourceIds: [fx.chairA2],
    });

    const result = await caught(async () =>
      swapProviders(getPool(), {
        a: { bookingId: a, expectedAllocationSeqs: await seqsOf('booking_provider_allocations', a) },
        b: { bookingId: b, expectedAllocationSeqs: await seqsOf('booking_provider_allocations', b) },
      }),
    );
    expect(result.code).toBe('provider_conflict');
    expect(await providerOf(a)).toBe(fx.staffA.id);
    expect(await providerOf(b)).toBe(fx.staffB.id);
    expect(await liveCounts(a)).toEqual({ provider: 1, resource: 1 });
    expect(await liveCounts(b)).toEqual({ provider: 1, resource: 1 });
    expect(await claimContradictions(getPool())).toEqual(NO_CONTRADICTIONS);
  });

  it('[P5-7] swapResources colliding with a third claim rolls BOTH sides back', async () => {
    const a = await booked(10);
    const b = await booked(14);
    const blocker = await booked(14, 15);
    await allocateBooking(getPool(), a, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
    await allocateBooking(getPool(), b, { employeeId: fx.staffA.id, resourceIds: [fx.chairA2] });
    // chairA1 is taken in a window overlapping b, so b cannot receive it.
    await allocateBooking(getPool(), blocker, {
      employeeId: fx.staffB.id,
      resourceIds: [fx.chairA1],
    });

    const result = await caught(async () =>
      swapResources(getPool(), {
        a: { bookingId: a, expectedAllocationSeqs: await seqsOf('booking_resource_allocations', a) },
        b: { bookingId: b, expectedAllocationSeqs: await seqsOf('booking_resource_allocations', b) },
      }),
    );
    expect(result.code).toBe('resource_conflict');
    expect(await resourceOf(a)).toBe(fx.chairA1);
    expect(await resourceOf(b)).toBe(fx.chairA2);
    expect(await claimContradictions(getPool())).toEqual(NO_CONTRADICTIONS);
  });

  it('[P5-10] keeps the original database error as the cause', async () => {
    const first = await booked(10);
    const second = await booked(10, 30);
    await allocateBooking(getPool(), first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
    const result = await caught(() =>
      allocateBooking(getPool(), second, { employeeId: fx.staffA.id, resourceIds: [fx.chairA2] }),
    );

    expect(result.cause).not.toBeNull();
    expect(result.cause?.code).toBe('23P01');
    expect(result.cause?.constraint).toBe('provider_no_double_booking');
    expect(result.cause?.detail).toContain('employee_id');
    expect(result.cause?.hasStack).toBe(true);

    // ...and none of it is in the message a caller might show someone.
    expect(result.message).toBe('The provider is already allocated for an overlapping time');
    for (const leak of [
      '23P01',
      'provider_no_double_booking',
      'booking_provider_allocations',
      'INSERT',
      'SELECT',
      'occupancy',
    ]) {
      expect(result.message).not.toContain(leak);
    }
    expect(result.message).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
  });
});

// ======================================================== what is NOT touched

describe('[P5] everything else keeps its original error', () => {
  it('[P5-11] a real 23P01 raised outside the claim boundary is untouched', async () => {
    // A reschedule cascade trips the SAME constraint the translator knows —
    // from a statement the repository did not issue. Bounded by call site, not
    // by constraint name.
    const moving = await booked(10);
    const blocker = await booked(14);
    await allocateBooking(getPool(), moving, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });
    await allocateBooking(getPool(), blocker, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA2],
    });

    const result = await caught(() =>
      getPool().query(
        `UPDATE bookings SET starts_at = starts_at + interval '4 hours',
                             ends_at = ends_at + interval '4 hours' WHERE id = $1`,
        [moving],
      ),
    );
    expect(result.isAllocationError).toBe(false);
    expect(result.constructor).toBe('DatabaseError');
    expect(result.code).toBe('23P01');
  });

  it('[P5-12] an unrelated 23505 is untouched', async () => {
    const result = await caught(() =>
      getPool().query("INSERT INTO resource_types (code, name) VALUES ('chair', 'Chair again')"),
    );
    expect(result.isAllocationError).toBe(false);
    expect(result.code).toBe('23505');
  });

  it('[P5-13a] a 23514 raised BY the translated statement passes straight through', async () => {
    // This one matters most: it is thrown by the very INSERT the translator
    // wraps. A catch that keyed on "the claim insert failed" would swallow it.
    await replaceOffering({
      branchId: fx.branchA,
      serviceId: fx.service,
      durationMin: 26 * 60,
      bufferAfterMin: 0,
      requirements: [{ typeId: fx.chairTypeId, qty: 1 }],
    });
    const bookingId = await booked(10);
    const result = await caught(() =>
      allocateBooking(getPool(), bookingId, {
        employeeId: fx.staffA.id,
        resourceIds: [fx.chairA1],
      }),
    );
    expect(result.isAllocationError).toBe(false);
    expect(result.constructor).toBe('DatabaseError');
    expect(result.code).toBe('23514');
  });

  it('[P5-13b] 23503 mirror failures and P0001 eligibility triggers are untouched', async () => {
    const fk = await caught(() =>
      getPool().query(
        `INSERT INTO booking_provider_allocations
           (booking_id, branch_id, employee_id, b_starts_at, b_ends_at, b_buf_before, b_buf_after)
         VALUES (gen_random_uuid(), $1, $2, now(), now() + interval '1 hour', 0, 0)`,
        [fx.branchA, fx.staffA.id],
      ),
    );
    expect(fk.code).toBe('23503');
    expect(fk.isAllocationError).toBe(false);

    // The eligibility trigger: a provider with no assignment to this branch.
    const bookingId = await booked(10);
    const unqualified = await getPool().query<{ id: string }>(
      "SELECT id FROM employees WHERE email = $1",
      [fx.inactive.email],
    );
    expect(
      await sqlstateOf(() =>
        getPool().query(
          `INSERT INTO booking_provider_allocations
             (booking_id, branch_id, employee_id, b_starts_at, b_ends_at, b_buf_before, b_buf_after)
           SELECT b.id, b.branch_id, $2, b.starts_at, b.ends_at,
                  b.buffer_before_min_snapshot, b.buffer_after_min_snapshot
             FROM bookings b WHERE b.id = $1`,
          [bookingId, unqualified.rows[0]!.id],
        ),
      ),
    ).toBe('P0001');
  });
});

// ==================================================== the translator itself

describe('[P5] the translator maps by constraint name only', () => {
  const cases: [string, 'provider' | 'resource', string | null, string][] = [
    ['provider_no_double_booking', 'provider', 'provider_conflict', '23P01'],
    ['provider_allocation_one_live_idx', 'provider', 'provider_conflict', '23505'],
    ['resource_no_double_booking', 'resource', 'resource_conflict', '23P01'],
    ['resource_allocation_one_live_idx', 'resource', 'resource_conflict', '23505'],
  ];

  it.each(cases)('maps %s on the %s side to %s', (constraint, side, expected, sqlstate) => {
    const result = classifyClaimConflict({ code: sqlstate, constraint }, side);
    expect(result?.code ?? null).toBe(expected);
    expect(result?.cause).toEqual({ code: sqlstate, constraint });
  });

  /**
   * `resource_allocation_one_live_idx` is the reason this function is exported.
   * No public operation reaches it: a duplicate unit in one request is refused
   * before any write; re-allocating a booking trips the PROVIDER one-live index
   * first, because the provider claim is written before any unit; a swap hands
   * each booking the other's units after releasing its own; and even provoked
   * directly, the same booking and unit twice share one occupancy, so
   * `resource_no_double_booking` answers first. Measured, not assumed — so its
   * mapping is proved here instead of by weakening a fixture or dropping a
   * constraint to manufacture a path that does not exist.
   */
  it('proves the unreachable mapping at the boundary rather than in the database', () => {
    const result = classifyClaimConflict(
      { code: '23505', constraint: 'resource_allocation_one_live_idx' },
      'resource',
    );
    expect(result).toBeInstanceOf(AllocationError);
    expect(result?.message).toBe('This booking already has a live allocation for this resource');
  });

  it('never maps by SQLSTATE, and never by the wrong side', () => {
    // The same two codes, on constraints that are not conflicts.
    expect(classifyClaimConflict({ code: '23P01', constraint: 'some_other_exclusion' }, 'provider')).toBeNull();
    expect(classifyClaimConflict({ code: '23505', constraint: 'resource_types_code_key' }, 'resource')).toBeNull();
    expect(classifyClaimConflict({ code: '23503', constraint: 'provider_allocation_booking_fk' }, 'provider')).toBeNull();
    // A provider write may not report a resource conflict, or the reverse.
    expect(classifyClaimConflict({ code: '23P01', constraint: 'resource_no_double_booking' }, 'provider')).toBeNull();
    expect(classifyClaimConflict({ code: '23P01', constraint: 'provider_no_double_booking' }, 'resource')).toBeNull();
    // Errors that carry no constraint at all: triggers, deadlocks,
    // serialisation failures, and anything that is not a database error.
    for (const error of [
      { code: 'P0001', message: 'this provider is not assigned to the branch' },
      { code: '40P01' },
      { code: '40001' },
      { code: undefined },
      new Error('boom'),
      null,
      undefined,
    ]) {
      expect(classifyClaimConflict(error, 'provider')).toBeNull();
      expect(classifyClaimConflict(error, 'resource')).toBeNull();
    }
  });
});

// ========================================================= real concurrency

/**
 * Two connections, one real database barrier. The loser is made to WAIT on the
 * winner's uncommitted claim — `pg_blocking_pids` proves it is blocked, and by
 * whom — so the race is decided by PostgreSQL rather than by a sleep that
 * happens to be long enough.
 */
describe('[P5] two callers, one slot', () => {
  it('[P5-8] concurrent allocations of the same provider: one wins, one is classified', async () => {
    const pool = getPool();
    const first = await booked(10);
    const second = await booked(10, 30);

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    let loser: Caught;
    try {
      const pid2 = await backendPid(c2);
      const pid1 = await backendPid(c1);
      await c1.query('BEGIN');
      await allocateBooking(c1, first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });

      await c2.query('BEGIN');
      const pending = caught(() =>
        allocateBooking(c2, second, { employeeId: fx.staffA.id, resourceIds: [fx.chairA2] }),
      );
      expect(await waitUntilBlockedBy(pool, pid2)).toContain(pid1);
      await c1.query('COMMIT');
      loser = await pending;

      // The savepoint has already undone the loser's work, before it rolls back.
      expect(await liveCounts(second, c2)).toEqual({ provider: 0, resource: 0 });
      await c2.query('ROLLBACK').catch(() => undefined);
    } finally {
      c1.release();
      c2.release();
    }

    expect(loser.isAllocationError).toBe(true);
    expect(loser.constructor).toBe('AllocationError');
    expect(loser.code).toBe('provider_conflict');
    expect(loser.cause?.constraint).toBe('provider_no_double_booking');
    expect(await providerOf(first)).toBe(fx.staffA.id);
    expect(await liveCounts(first)).toEqual({ provider: 1, resource: 1 });
    expect(await liveCounts(second)).toEqual({ provider: 0, resource: 0 });
    expect(await claimContradictions(pool)).toEqual(NO_CONTRADICTIONS);
  }, 30_000);

  it('[P5-9] concurrent allocations of the same unit by different providers', async () => {
    const pool = getPool();
    const first = await booked(10);
    const second = await booked(10, 30);

    const c1 = await pool.connect();
    const c2 = await pool.connect();
    let loser: Caught;
    try {
      const pid1 = await backendPid(c1);
      const pid2 = await backendPid(c2);
      await c1.query('BEGIN');
      await allocateBooking(c1, first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });

      await c2.query('BEGIN');
      // A different, perfectly free provider — the collision is the chair, and
      // the loser's provider claim is written BEFORE it finds that out.
      const pending = caught(() =>
        allocateBooking(c2, second, { employeeId: fx.staffB.id, resourceIds: [fx.chairA1] }),
      );
      expect(await waitUntilBlockedBy(pool, pid2)).toContain(pid1);
      await c1.query('COMMIT');
      loser = await pending;

      expect(await liveCounts(second, c2)).toEqual({ provider: 0, resource: 0 });
      await c2.query('ROLLBACK').catch(() => undefined);
    } finally {
      c1.release();
      c2.release();
    }

    expect(loser.isAllocationError).toBe(true);
    expect(loser.code).toBe('resource_conflict');
    expect(loser.cause?.constraint).toBe('resource_no_double_booking');
    expect(await resourceOf(first)).toBe(fx.chairA1);
    expect(await liveCounts(second)).toEqual({ provider: 0, resource: 0 });
    const doubleClaims = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM booking_resource_allocations
        WHERE resource_id = $1 AND released_at IS NULL`,
      [fx.chairA1],
    );
    expect(doubleClaims.rows[0]!.n).toBe(1);
    expect(await claimContradictions(pool)).toEqual(NO_CONTRADICTIONS);
  }, 30_000);
});
