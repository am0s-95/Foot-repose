import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { muscatDateTimeToUtc, occupancyOf } from '@foot-repose/domain';
import {
  allocateBooking,
  applyBookingTransition,
  captureBookingRequirements,
  findBookingById,
  reassignProvider,
} from '@foot-repose/db';
import { closePool, getPool } from '../src/lib/pool';
import {
  allocationErrorOf,
  makeBooking,
  setupAllocationFixtures,
  sqlstateOf,
  type AllocationFixtures,
} from './allocation-helpers';

/**
 * Slice 2A.2b — booking allocation integrity.
 *
 * Every expectation is either a SQLSTATE (what PostgreSQL itself refuses) or an
 * AllocationError code (what the repository refuses under lock). There is no
 * HTTP surface for allocation in this slice, by design.
 */
let fx: AllocationFixtures;

const DATE = '2030-04-07'; // a Sunday
const book = (over: Partial<Parameters<typeof makeBooking>[0]> = {}): Promise<string> =>
  makeBooking({
    branchId: fx.branchA,
    isoDate: DATE,
    hour: 10,
    serviceId: fx.service,
    customerId: fx.customerOne,
    ...over,
  });

const liveProvider = async (bookingId: string): Promise<string | null> => {
  const rows = await getPool().query<{ employee_id: string }>(
    'SELECT employee_id FROM booking_provider_allocations WHERE booking_id = $1 AND released_at IS NULL',
    [bookingId],
  );
  return rows.rows[0]?.employee_id ?? null;
};

const liveSeqs = async (table: string, bookingId: string): Promise<string[]> => {
  const rows = await getPool().query<{ allocation_seq: string }>(
    `SELECT allocation_seq FROM ${table} WHERE booking_id = $1 AND released_at IS NULL
     ORDER BY allocation_seq`,
    [bookingId],
  );
  return rows.rows.map((r) => r.allocation_seq);
};

/** Requirements are frozen once captured, so a test that needs different ones
 * closes the current offering and opens a new version — exactly what the
 * product will have to do. Bookings on DATE fall inside the new version. */
async function replaceOfferingRequirements(
  branchId: string,
  serviceId: string,
  requirements: { typeId: string; qty: number }[],
): Promise<string> {
  await getPool().query(
    `UPDATE branch_service_offerings
        SET valid_during = tstzrange(lower(valid_during), '2030-01-01T00:00:00Z', '[)')
      WHERE branch_id = $1 AND upper(valid_during) IS NULL`,
    [branchId],
  );
  const created = await getPool().query<{ id: string }>(
    `INSERT INTO branch_service_offerings
       (branch_id, service_id, valid_during, price_baisa, duration_min,
        buffer_before_min, buffer_after_min)
     VALUES ($1, $2, tstzrange('2030-01-01T00:00:00Z', NULL, '[)'), 8500, 45, 0, 10)
     RETURNING id`,
    [branchId, serviceId],
  );
  const id = created.rows[0]!.id;
  for (const requirement of requirements) {
    await getPool().query(
      'INSERT INTO branch_service_offering_resources VALUES ($1, $2, $3)',
      [id, requirement.typeId, requirement.qty],
    );
  }
  await getPool().query(
    'UPDATE branch_service_offerings SET resource_requirements_captured_at = now() WHERE id = $1',
    [id],
  );
  return id;
}

beforeEach(async () => {
  fx = await setupAllocationFixtures();
});

afterAll(async () => {
  await closePool();
});

describe('what PostgreSQL refuses', () => {
  it('[1] refuses the same provider in two overlapping windows', async () => {
    const first = await book({ hour: 10 });
    const second = await book({ hour: 10, minute: 30 });
    for (const id of [first, second]) await captureBookingRequirements(getPool(), id);
    await allocateBooking(getPool(), first, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });
    expect(
      await sqlstateOf(() =>
        allocateBooking(getPool(), second, {
          employeeId: fx.staffA.id,
          resourceIds: [fx.chairA2],
        }),
      ),
    ).toBe('23P01');
    expect(await liveSeqs('booking_provider_allocations', second)).toEqual([]);
  });

  it('[2] accepts adjacent half-open windows [a,b) and [b,c)', async () => {
    // 10:00 + 45min service + 10min buffer ends 10:55; the next starts 10:55.
    const first = await book({ hour: 10 });
    const second = await book({ hour: 10, minute: 55, bufferAfterMin: 0 });
    for (const id of [first, second]) await captureBookingRequirements(getPool(), id);
    await allocateBooking(getPool(), first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
    await allocateBooking(getPool(), second, { employeeId: fx.staffA.id, resourceIds: [fx.chairA2] });
    expect(await liveSeqs('booking_provider_allocations', second)).toHaveLength(1);
  });

  it('[3] accepts two different providers at the same instant', async () => {
    const first = await book();
    const second = await book();
    for (const id of [first, second]) await captureBookingRequirements(getPool(), id);
    await allocateBooking(getPool(), first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
    await allocateBooking(getPool(), second, { employeeId: fx.staffB.id, resourceIds: [fx.chairA2] });
    expect(await liveSeqs('booking_provider_allocations', second)).toHaveLength(1);
  });

  it('[4] refuses the same physical unit in two overlapping windows, [5] but not two units of one type', async () => {
    const first = await book({ hour: 10 });
    const second = await book({ hour: 10, minute: 30 });
    for (const id of [first, second]) await captureBookingRequirements(getPool(), id);
    await allocateBooking(getPool(), first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
    // Same unit -> refused by the exclusion constraint.
    expect(
      await sqlstateOf(() =>
        allocateBooking(getPool(), second, { employeeId: fx.staffB.id, resourceIds: [fx.chairA1] }),
      ),
    ).toBe('23P01');
    // A different unit of the same type -> accepted. This is the difference
    // between individually allocatable units and a capacity counter.
    await allocateBooking(getPool(), second, { employeeId: fx.staffB.id, resourceIds: [fx.chairA2] });
    expect(await liveSeqs('booking_resource_allocations', second)).toHaveLength(1);
  });

  it('[6] lets the buffer refuse an apparently-valid adjacency, and accepts one minute wider', async () => {
    const first = await book({ hour: 10 }); // service 10:00-10:45, cleaning to 10:55
    await captureBookingRequirements(getPool(), first);
    await allocateBooking(getPool(), first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });

    // Starts at 10:50: the SERVICE windows do not overlap at all, only the
    // cleaning buffer does. Rejected — which is the whole point of buffers.
    const tooSoon = await book({ hour: 10, minute: 50 });
    await captureBookingRequirements(getPool(), tooSoon);
    expect(
      await sqlstateOf(() =>
        allocateBooking(getPool(), tooSoon, { employeeId: fx.staffA.id, resourceIds: [fx.chairA2] }),
      ),
    ).toBe('23P01');

    const justFits = await book({ hour: 10, minute: 55 });
    await captureBookingRequirements(getPool(), justFits);
    await allocateBooking(getPool(), justFits, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA2],
    });
    expect(await liveSeqs('booking_provider_allocations', justFits)).toHaveLength(1);
  });

  it('[7] makes a unit from another branch structurally impossible', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    // Straight through the repository first (better message), then raw SQL to
    // prove the database itself refuses it with 23503.
    expect(
      await allocationErrorOf(() =>
        allocateBooking(getPool(), booking, {
          employeeId: fx.staffA.id,
          resourceIds: [fx.chairB1],
        }),
      ),
    ).toBe('resource_inactive');
    expect(
      await sqlstateOf(() =>
        getPool().query(
          `INSERT INTO booking_resource_allocations
             (booking_id, branch_id, resource_id, resource_type_id,
              b_starts_at, b_ends_at, b_buf_before, b_buf_after)
           SELECT b.id, b.branch_id, $2, $3, b.starts_at, b.ends_at,
                  b.buffer_before_min_snapshot, b.buffer_after_min_snapshot
           FROM bookings b WHERE b.id = $1`,
          [booking, fx.chairB1, fx.chairTypeId],
        ),
      ),
    ).toBe('23503');
  });

  it('[C9.3] refuses direct SQL that states its own occupancy or lies about the mirrors', async () => {
    const booking = await book();
    // The generated column cannot be written at all.
    expect(
      await sqlstateOf(() =>
        getPool().query(
          `INSERT INTO booking_provider_allocations
             (booking_id, branch_id, employee_id, b_starts_at, b_ends_at,
              b_buf_before, b_buf_after, occupancy)
           VALUES ($1, $2, $3, now(), now() + interval '1 hour', 0, 0,
                   tstzrange(now(), now() + interval '9 hours', '[)'))`,
          [booking, fx.branchA, fx.staffA.id],
        ),
      ),
    ).toBe('428C9');
    // And the mirrors have to match the booking row.
    expect(
      await sqlstateOf(() =>
        getPool().query(
          `INSERT INTO booking_provider_allocations
             (booking_id, branch_id, employee_id, b_starts_at, b_ends_at, b_buf_before, b_buf_after)
           VALUES ($1, $2, $3, '2031-01-01T10:00:00Z', '2031-01-01T11:00:00Z', 0, 0)`,
          [booking, fx.branchA, fx.staffA.id],
        ),
      ),
    ).toBe('23503');
  });

  it('[C9.14] moves every claim atomically when the booking is rescheduled, or refuses with a conflict', async () => {
    const moving = await book({ hour: 10 });
    const blocker = await book({ hour: 14 });
    for (const id of [moving, blocker]) await captureBookingRequirements(getPool(), id);
    await allocateBooking(getPool(), moving, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
    await allocateBooking(getPool(), blocker, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA2],
    });

    const before = await getPool().query<{ occupancy: string }>(
      'SELECT occupancy::text FROM booking_provider_allocations WHERE booking_id = $1',
      [moving],
    );
    // A free slot: the claim follows.
    await getPool().query(
      "UPDATE bookings SET starts_at = starts_at + interval '2 hours', ends_at = ends_at + interval '2 hours' WHERE id = $1",
      [moving],
    );
    const after = await getPool().query<{ occupancy: string }>(
      'SELECT occupancy::text FROM booking_provider_allocations WHERE booking_id = $1',
      [moving],
    );
    expect(after.rows[0]!.occupancy).not.toBe(before.rows[0]!.occupancy);

    // Onto the blocker: refused by the exclusion constraint, from inside the cascade.
    expect(
      await sqlstateOf(() =>
        getPool().query(
          "UPDATE bookings SET starts_at = starts_at + interval '2 hours', ends_at = ends_at + interval '2 hours' WHERE id = $1",
          [moving],
        ),
      ),
    ).toBe('23P01');
  });

  it('[+1] derives the same occupancy in SQL and in the domain', async () => {
    const cases = [
      { hour: 10, minute: 0, durationMin: 45, bufferBeforeMin: 0, bufferAfterMin: 10 },
      { hour: 23, minute: 30, durationMin: 60, bufferBeforeMin: 15, bufferAfterMin: 15 },
      { hour: 0, minute: 15, durationMin: 30, bufferBeforeMin: 0, bufferAfterMin: 0 },
      { hour: 22, minute: 0, durationMin: 90, bufferBeforeMin: 45, bufferAfterMin: 60 },
    ];
    for (const spec of cases) {
      const id = await book(spec);
      await captureBookingRequirements(getPool(), id);
      await allocateBooking(getPool(), id, {
        employeeId: fx.staffA.id,
        resourceIds: [fx.chairA1],
      });
      const row = await getPool().query<{ lo: Date; hi: Date }>(
        `SELECT lower(occupancy) AS lo, upper(occupancy) AS hi
         FROM booking_provider_allocations WHERE booking_id = $1`,
        [id],
      );
      const startsAt = muscatDateTimeToUtc(DATE, spec.hour, spec.minute);
      const expected = occupancyOf({
        startsAt,
        endsAt: new Date(startsAt.getTime() + spec.durationMin * 60_000),
        bufferBeforeMin: spec.bufferBeforeMin,
        bufferAfterMin: spec.bufferAfterMin,
      });
      expect(row.rows[0]!.lo.toISOString()).toBe(expected.startUtc.toISOString());
      expect(row.rows[0]!.hi.toISOString()).toBe(expected.endUtc.toISOString());
      await getPool().query('UPDATE bookings SET status = $2 WHERE id = $1', [id, 'cancelled']);
      await getPool().query(
        `UPDATE booking_provider_allocations SET released_at = now(), release_reason = 'test'
         WHERE booking_id = $1 AND released_at IS NULL`,
        [id],
      );
      await getPool().query(
        `UPDATE booking_resource_allocations SET released_at = now(), release_reason = 'test'
         WHERE booking_id = $1 AND released_at IS NULL`,
        [id],
      );
    }
  });
});

describe('resource classification history [R4A / R3-2]', () => {
  it('[R2c] refuses a claim that misstates the unit type', async () => {
    const booking = await book();
    expect(
      await sqlstateOf(() =>
        getPool().query(
          `INSERT INTO booking_resource_allocations
             (booking_id, branch_id, resource_id, resource_type_id,
              b_starts_at, b_ends_at, b_buf_before, b_buf_after)
           SELECT b.id, b.branch_id, $2, $3, b.starts_at, b.ends_at,
                  b.buffer_before_min_snapshot, b.buffer_after_min_snapshot
           FROM bookings b WHERE b.id = $1`,
          [booking, fx.chairA1, fx.roomTypeId],
        ),
      ),
    ).toBe('23503');
  });

  it('[R2a] refuses to reclassify a unit that has allocation history, [R2b] but allows retire + replace', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    await allocateBooking(getPool(), booking, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });

    expect(
      await sqlstateOf(() =>
        getPool().query('UPDATE branch_resources SET resource_type_id = $2 WHERE id = $1', [
          fx.chairA1,
          fx.roomTypeId,
        ]),
      ),
    ).toBe('23503');

    // Retire and replace, reusing both the code and the display label.
    await getPool().query('UPDATE branch_resources SET is_active = false WHERE id = $1', [
      fx.chairA1,
    ]);
    const replacement = await getPool().query<{ id: string }>(
      `INSERT INTO branch_resources (branch_id, resource_type_id, code, label)
       VALUES ($1, $2, 'CH01', 'Fictional chair 1') RETURNING id`,
      [fx.branchA, fx.roomTypeId],
    );
    expect(replacement.rows[0]!.id).toBeTypeOf('string');

    // [R2b] the historical claim still says what it always said.
    const historical = await getPool().query<{ resource_type_id: string }>(
      'SELECT resource_type_id FROM booking_resource_allocations WHERE booking_id = $1',
      [booking],
    );
    expect(historical.rows[0]!.resource_type_id).toBe(fx.chairTypeId);
  });

  it('[13] keeps history when a unit is retired, and refuses new claims on it', async () => {
    const first = await book({ hour: 10 });
    await captureBookingRequirements(getPool(), first);
    await allocateBooking(getPool(), first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });
    await getPool().query('UPDATE branch_resources SET is_active = false WHERE id = $1', [
      fx.chairA1,
    ]);
    const rows = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM booking_resource_allocations WHERE resource_id = $1',
      [fx.chairA1],
    );
    expect(rows.rows[0]!.n).toBe(1);

    const later = await book({ hour: 16 });
    await captureBookingRequirements(getPool(), later);
    expect(
      await allocationErrorOf(() =>
        allocateBooking(getPool(), later, {
          employeeId: fx.staffA.id,
          resourceIds: [fx.chairA1],
        }),
      ),
    ).toBe('resource_inactive');
  });

  it('[C9.6] refuses a unit whose TYPE has been retired', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    await getPool().query('UPDATE resource_types SET is_active = false WHERE id = $1', [
      fx.chairTypeId,
    ]);
    expect(
      await allocationErrorOf(() =>
        allocateBooking(getPool(), booking, {
          employeeId: fx.staffA.id,
          resourceIds: [fx.chairA1],
        }),
      ),
    ).toBe('resource_type_inactive');
  });
});

describe('eligibility, checked under lock [R3-3 / C9.4 / C9.5]', () => {
  it('[8] refuses a provider not assigned to the branch on the booking dates', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    await getPool().query(
      'DELETE FROM provider_branch_assignments WHERE employee_id = $1 AND branch_id = $2',
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
  });

  it('[9] refuses a provider not qualified for the service, and accepts the qualified counterpart', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    await getPool().query('DELETE FROM provider_service_qualifications WHERE employee_id = $1', [
      fx.staffA.id,
    ]);
    expect(
      await allocationErrorOf(() =>
        allocateBooking(getPool(), booking, {
          employeeId: fx.staffA.id,
          resourceIds: [fx.chairA1],
        }),
      ),
    ).toBe('not_qualified_for_service');
    await allocateBooking(getPool(), booking, {
      employeeId: fx.staffB.id,
      resourceIds: [fx.chairA1],
    });
    expect(await liveProvider(booking)).toBe(fx.staffB.id);
  });

  it('[C9.4] refuses an inactive employee and [C9.5] an inactive branch', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    await getPool().query('UPDATE employees SET is_active = false WHERE id = $1', [fx.staffA.id]);
    expect(
      await allocationErrorOf(() =>
        allocateBooking(getPool(), booking, {
          employeeId: fx.staffA.id,
          resourceIds: [fx.chairA1],
        }),
      ),
    ).toBe('employee_inactive');

    await getPool().query('UPDATE branches SET is_active = false WHERE id = $1', [fx.branchA]);
    expect(
      await allocationErrorOf(() =>
        allocateBooking(getPool(), booking, {
          employeeId: fx.staffB.id,
          resourceIds: [fx.chairA1],
        }),
      ),
    ).toBe('branch_inactive');
  });

  it('[C9.7] cannot be given a multi-day gap: occupancy over 24 hours is refused outright', async () => {
    const booking = await book({ hour: 10, durationMin: 26 * 60 });
    await captureBookingRequirements(getPool(), booking);
    expect(
      await sqlstateOf(() =>
        allocateBooking(getPool(), booking, {
          employeeId: fx.staffA.id,
          resourceIds: [fx.chairA1],
        }),
      ),
    ).toBe('23514');
  });

  it('[10] rolls the whole transaction back when a later unit conflicts', async () => {
    const first = await book({ hour: 10 });
    await captureBookingRequirements(getPool(), first);
    await allocateBooking(getPool(), first, { employeeId: fx.staffA.id, resourceIds: [fx.chairA1] });

    // A booking needing TWO chairs, one of which is already claimed.
    const second = await book({ hour: 10, minute: 15 });
    await replaceOfferingRequirements(fx.branchA, fx.service, [
      { typeId: fx.chairTypeId, qty: 2 },
    ]);
    await captureBookingRequirements(getPool(), second);
    expect(
      await sqlstateOf(() =>
        allocateBooking(getPool(), second, {
          employeeId: fx.staffB.id,
          resourceIds: [fx.chairA2, fx.chairA1],
        }),
      ).catch(() => 'threw'),
    ).toBe('23P01');
    // Nothing survived: not the provider claim, not the first unit.
    expect(await liveSeqs('booking_provider_allocations', second)).toEqual([]);
    expect(await liveSeqs('booking_resource_allocations', second)).toEqual([]);
  });
});

describe('requirement snapshots [C1 / R4-2 / R4A-1]', () => {
  it('[C9.2 / R7b] refuses to allocate a booking that has no requirement set', async () => {
    const legacy = await book();
    expect(
      await allocationErrorOf(() =>
        allocateBooking(getPool(), legacy, {
          employeeId: fx.staffA.id,
          resourceIds: [fx.chairA1],
        }),
      ),
    ).toBe('requirements_not_captured');
  });

  it('[R7a] still reassigns the provider of a legacy booking, without touching resources', async () => {
    const legacy = await book();
    await getPool().query(
      `INSERT INTO booking_provider_allocations
         (booking_id, branch_id, employee_id, b_starts_at, b_ends_at, b_buf_before, b_buf_after)
       SELECT b.id, b.branch_id, $2, b.starts_at, b.ends_at,
              b.buffer_before_min_snapshot, b.buffer_after_min_snapshot
       FROM bookings b WHERE b.id = $1`,
      [legacy, fx.staffA.id],
    );
    await reassignProvider(getPool(), legacy, fx.staffB.id);
    expect(await liveProvider(legacy)).toBe(fx.staffB.id);
    expect(await liveSeqs('booking_resource_allocations', legacy)).toEqual([]);
    const sets = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM booking_resource_requirement_sets WHERE booking_id = $1',
      [legacy],
    );
    expect(sets.rows[0]!.n).toBe(0);
  });

  it('[12 / C9.1] keeps a booking\'s snapshot when a future offering version is added', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    const before = await getPool().query<{ resource_type_id: string }>(
      'SELECT resource_type_id FROM booking_resource_requirements WHERE booking_id = $1',
      [booking],
    );
    // Close the current offering and open a new version that needs a ROOM.
    await getPool().query(
      `UPDATE branch_service_offerings
          SET valid_during = tstzrange(lower(valid_during), '2030-04-01T00:00:00Z', '[)')
        WHERE id = $1`,
      [fx.offeringA],
    );
    const next = await getPool().query<{ id: string }>(
      `INSERT INTO branch_service_offerings
         (branch_id, service_id, valid_during, price_baisa, duration_min,
          buffer_before_min, buffer_after_min, resource_requirements_captured_at)
       VALUES ($1, $2, tstzrange('2030-04-01T00:00:00Z', NULL, '[)'), 9000, 45, 0, 10, NULL)
       RETURNING id`,
      [fx.branchA, fx.service],
    );
    await getPool().query(
      `INSERT INTO branch_service_offering_resources (offering_id, resource_type_id, required_qty)
       VALUES ($1, $2, 1)`,
      [next.rows[0]!.id, fx.roomTypeId],
    );
    await getPool().query(
      'UPDATE branch_service_offerings SET resource_requirements_captured_at = now() WHERE id = $1',
      [next.rows[0]!.id],
    );
    const after = await getPool().query<{ resource_type_id: string }>(
      'SELECT resource_type_id FROM booking_resource_requirements WHERE booking_id = $1',
      [booking],
    );
    expect(after.rows[0]!.resource_type_id).toBe(before.rows[0]!.resource_type_id);
    expect(after.rows[0]!.resource_type_id).toBe(fx.chairTypeId);
  });

  it('[R4-2a/b] refuses a source offering from another branch or another service', async () => {
    // Structural: the composite FKs make both impossible to even state.
    const booking = await book();
    const offeringB = await getPool().query<{ id: string }>(
      'SELECT id FROM branch_service_offerings WHERE branch_id = $1',
      [fx.branchB],
    );
    expect(
      await sqlstateOf(() =>
        getPool().query(
          `INSERT INTO booking_resource_requirement_sets
             (booking_id, branch_id, service_id, source_offering_id)
           VALUES ($1, $2, $3, $4)`,
          [booking, fx.branchA, fx.service, offeringB.rows[0]!.id],
        ),
      ),
    ).toBe('23503');
    expect(
      await sqlstateOf(() =>
        getPool().query(
          `INSERT INTO booking_resource_requirement_sets
             (booking_id, branch_id, service_id, source_offering_id)
           VALUES ($1, $2, $3, $4)`,
          [booking, fx.branchB, fx.service, offeringB.rows[0]!.id],
        ),
      ),
    ).toBe('23503');
  });

  it('[R4-2d] refuses capture when no offering is effective at the booking start', async () => {
    const booking = await book({ isoDate: '2028-06-01' });
    expect(
      await allocationErrorOf(() => captureBookingRequirements(getPool(), booking)),
    ).toBe('offering_not_effective');
  });

  it('[R4-1b/c] refuses a set created already sealed, unsealing, deleting, and post-seal edits', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);

    expect(
      await sqlstateOf(() =>
        getPool().query(
          `INSERT INTO booking_resource_requirement_sets
             (booking_id, branch_id, service_id, source_offering_id, sealed_at)
           VALUES ($1, $2, $3, $4, now())`,
          [fx.bookings.confirmedB, fx.branchB, fx.service, fx.offeringA],
        ),
      ),
    ).toBe('P0001');
    for (const statement of [
      'UPDATE booking_resource_requirement_sets SET sealed_at = NULL',
      'DELETE FROM booking_resource_requirement_sets',
      'UPDATE booking_resource_requirements SET required_qty = 9',
      'DELETE FROM booking_resource_requirements',
    ]) {
      expect(`${statement} -> ${await sqlstateOf(() => getPool().query(statement))}`).toBe(
        `${statement} -> P0001`,
      );
    }
  });

  it('[A1.1-A1.3] freezes the whole primary key so a child cannot leave a sealed set', async () => {
    const sealed = await book({ hour: 10 });
    await captureBookingRequirements(getPool(), sealed);
    // A second booking whose set is deliberately left UNSEALED.
    const unsealed = await book({ hour: 16 });
    await getPool().query(
      `INSERT INTO booking_resource_requirement_sets
         (booking_id, branch_id, service_id, source_offering_id)
       VALUES ($1, $2, $3, $4)`,
      [unsealed, fx.branchA, fx.service, fx.offeringA],
    );

    // [A1.1] relocation from sealed to unsealed
    expect(
      await sqlstateOf(() =>
        getPool().query(
          'UPDATE booking_resource_requirements SET booking_id = $2 WHERE booking_id = $1',
          [sealed, unsealed],
        ),
      ),
    ).toBe('P0001');
    // [A1.2] relocation between two unsealed parents is refused just the same
    await getPool().query(
      'INSERT INTO booking_resource_requirements VALUES ($1, $2, 1)',
      [unsealed, fx.roomTypeId],
    );
    const other = await book({ hour: 18 });
    await getPool().query(
      `INSERT INTO booking_resource_requirement_sets
         (booking_id, branch_id, service_id, source_offering_id)
       VALUES ($1, $2, $3, $4)`,
      [other, fx.branchA, fx.service, fx.offeringA],
    );
    expect(
      await sqlstateOf(() =>
        getPool().query(
          'UPDATE booking_resource_requirements SET booking_id = $2 WHERE booking_id = $1',
          [unsealed, other],
        ),
      ),
    ).toBe('P0001');
    // [A1.3] changing the type half of the key is refused
    expect(
      await sqlstateOf(() =>
        getPool().query(
          'UPDATE booking_resource_requirements SET resource_type_id = $2 WHERE booking_id = $1',
          [unsealed, fx.chairTypeId],
        ),
      ),
    ).toBe('P0001');

    // Source and destination are both exactly as they were.
    const rows = await getPool().query<{ booking_id: string; n: number }>(
      `SELECT booking_id, count(*)::int AS n FROM booking_resource_requirements
       GROUP BY booking_id ORDER BY booking_id`,
    );
    const byBooking = new Map(rows.rows.map((r) => [r.booking_id, r.n]));
    expect(byBooking.get(sealed)).toBe(1);
    expect(byBooking.get(unsealed)).toBe(1);
    expect(byBooking.get(other) ?? 0).toBe(0);
  });

  it('[A1.4] allows DELETE + INSERT while the set is unsealed', async () => {
    const booking = await book();
    await getPool().query(
      `INSERT INTO booking_resource_requirement_sets
         (booking_id, branch_id, service_id, source_offering_id)
       VALUES ($1, $2, $3, $4)`,
      [booking, fx.branchA, fx.service, fx.offeringA],
    );
    await getPool().query('INSERT INTO booking_resource_requirements VALUES ($1, $2, 1)', [
      booking,
      fx.chairTypeId,
    ]);
    await getPool().query('DELETE FROM booking_resource_requirements WHERE booking_id = $1', [
      booking,
    ]);
    await getPool().query('INSERT INTO booking_resource_requirements VALUES ($1, $2, 2)', [
      booking,
      fx.roomTypeId,
    ]);
    const rows = await getPool().query<{ resource_type_id: string; required_qty: number }>(
      'SELECT resource_type_id, required_qty FROM booking_resource_requirements WHERE booking_id = $1',
      [booking],
    );
    expect(rows.rows).toEqual([{ resource_type_id: fx.roomTypeId, required_qty: 2 }]);
  });

  it('[A1.5-A1.8] applies the same lifecycle to offering requirements', async () => {
    // A fresh, NOT captured offering. Branch B's existing offering is
    // open-ended, so it has to be closed before another version can start.
    await getPool().query(
      `UPDATE branch_service_offerings
          SET valid_during = tstzrange(lower(valid_during), '2034-01-01T00:00:00Z', '[)')
        WHERE branch_id = $1`,
      [fx.branchB],
    );
    const draft = await getPool().query<{ id: string }>(
      `INSERT INTO branch_service_offerings
         (branch_id, service_id, valid_during, price_baisa, duration_min,
          buffer_before_min, buffer_after_min)
       VALUES ($1, $2, tstzrange('2035-01-01T00:00:00Z', NULL, '[)'), 9000, 45, 0, 10)
       RETURNING id`,
      [fx.branchB, fx.service],
    );
    const draftId = draft.rows[0]!.id;
    await getPool().query(
      'INSERT INTO branch_service_offering_resources VALUES ($1, $2, 1)',
      [draftId, fx.chairTypeId],
    );
    // [A1.8] corrections before capture are DELETE + INSERT and work
    await getPool().query('DELETE FROM branch_service_offering_resources WHERE offering_id = $1', [
      draftId,
    ]);
    await getPool().query(
      'INSERT INTO branch_service_offering_resources VALUES ($1, $2, 1)',
      [draftId, fx.roomTypeId],
    );
    // [A1.5] relocation into a captured offering is refused
    expect(
      await sqlstateOf(() =>
        getPool().query(
          'UPDATE branch_service_offering_resources SET offering_id = $2 WHERE offering_id = $1',
          [draftId, fx.offeringA],
        ),
      ),
    ).toBe('P0001');
    // [A1.6] once captured, nothing may change
    await getPool().query(
      'UPDATE branch_service_offerings SET resource_requirements_captured_at = now() WHERE id = $1',
      [draftId],
    );
    expect(
      await sqlstateOf(() =>
        getPool().query(
          'UPDATE branch_service_offering_resources SET required_qty = 4 WHERE offering_id = $1',
          [draftId],
        ),
      ),
    ).toBe('P0001');
    // [A1.7] capture cannot be undone
    expect(
      await sqlstateOf(() =>
        getPool().query(
          'UPDATE branch_service_offerings SET resource_requirements_captured_at = NULL WHERE id = $1',
          [draftId],
        ),
      ),
    ).toBe('P0001');
  });

  it('[C7] requires the exact multiset: no duplicates, no extras, no shortfall', async () => {
    await replaceOfferingRequirements(fx.branchA, fx.service, [
      { typeId: fx.chairTypeId, qty: 2 },
    ]);
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    const attempt = (resourceIds: string[]): Promise<string> =>
      allocationErrorOf(() =>
        allocateBooking(getPool(), booking, { employeeId: fx.staffA.id, resourceIds }),
      );
    expect(await attempt([fx.chairA1])).toBe('requirements_unsatisfied'); // shortfall
    expect(await attempt([fx.chairA1, fx.chairA1])).toBe('requirements_unsatisfied'); // duplicate
    expect(await attempt([fx.chairA1, fx.chairA2, fx.roomA1])).toBe('requirements_unsatisfied'); // extra type
    await allocateBooking(getPool(), booking, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1, fx.chairA2],
    });
    expect(await liveSeqs('booking_resource_allocations', booking)).toHaveLength(2);
  });
});

describe('released history [R4-4 / R4A-2]', () => {
  it('[R4-4a] ignores a caller-supplied released_occupancy on the live -> released path', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    await allocateBooking(getPool(), booking, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });
    await getPool().query(
      `UPDATE booking_provider_allocations
          SET released_at = now(), release_reason = 'forged',
              released_occupancy = tstzrange('2099-01-01', '2099-01-02', '[)')
        WHERE booking_id = $1`,
      [booking],
    );
    const row = await getPool().query<{ same: boolean }>(
      `SELECT released_occupancy = occupancy AS same
       FROM booking_provider_allocations WHERE booking_id = $1`,
      [booking],
    );
    expect(row.rows[0]!.same).toBe(true);
  });

  it('[A2.1/A2.2] derives released_occupancy for a row INSERTed already released', async () => {
    const booking = await book();
    // occupancy is a generated column and is NOT visible to a BEFORE INSERT
    // trigger, so the value has to be derived from the row's own columns.
    await getPool().query(
      `INSERT INTO booking_provider_allocations
         (booking_id, branch_id, employee_id, b_starts_at, b_ends_at, b_buf_before, b_buf_after,
          released_at, released_occupancy, release_reason)
       SELECT b.id, b.branch_id, $2, b.starts_at, b.ends_at,
              b.buffer_before_min_snapshot, b.buffer_after_min_snapshot,
              now(), tstzrange('2099-01-01', '2099-01-02', '[)'), 'backfill_probe'
       FROM bookings b WHERE b.id = $1`,
      [booking, fx.staffA.id],
    );
    const row = await getPool().query<{ same: boolean; released: string }>(
      `SELECT released_occupancy = occupancy AS same, released_occupancy::text AS released
       FROM booking_provider_allocations WHERE booking_id = $1`,
      [booking],
    );
    expect(row.rows[0]!.same).toBe(true);
    expect(row.rows[0]!.released).not.toContain('2099');
  });

  it('[R4-4b] freezes the release fields and refuses DELETE', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    await allocateBooking(getPool(), booking, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });
    await getPool().query(
      `UPDATE booking_provider_allocations SET released_at = now(), release_reason = 'r'
        WHERE booking_id = $1`,
      [booking],
    );
    for (const statement of [
      "UPDATE booking_provider_allocations SET release_reason = 'changed'",
      'UPDATE booking_provider_allocations SET released_at = NULL, released_occupancy = NULL, release_reason = NULL',
      'DELETE FROM booking_provider_allocations',
      'DELETE FROM booking_resource_allocations',
    ]) {
      expect(`${statement} -> ${await sqlstateOf(() => getPool().query(statement))}`).toBe(
        `${statement} -> P0001`,
      );
    }
  });
});

describe('allocation ordering and reads [R3-1 / R3-8]', () => {
  it('[R1a] orders two allocations made inside ONE transaction, and returns the second', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await allocateBooking(client, booking, {
        employeeId: fx.staffA.id,
        resourceIds: [fx.chairA1],
      });
      await reassignProvider(client, booking, fx.staffB.id);
      const rows = await client.query<{ allocation_seq: string }>(
        `SELECT allocation_seq FROM booking_provider_allocations
         WHERE booking_id = $1 ORDER BY allocation_seq`,
        [booking],
      );
      expect(rows.rows).toHaveLength(2);
      expect(Number(rows.rows[1]!.allocation_seq)).toBeGreaterThan(
        Number(rows.rows[0]!.allocation_seq),
      );
      // And the reason a timestamp is not the ordering key: now() is
      // transaction-stable, so it cannot separate two writes made here.
      const clock = await client.query<{ same: boolean }>(
        'SELECT now() = (SELECT now()) AS same',
      );
      expect(clock.rows[0]!.same).toBe(true);
      const record = await findBookingById(client, booking);
      expect(record!.assignedEmployee!.id).toBe(fx.staffB.id);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
  });

  it('[C9.10] keeps naming the last provider after cancel, and never returns pre-release data', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    await allocateBooking(getPool(), booking, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });
    const result = await applyBookingTransition(getPool(), booking, 'confirmed', 'cancelled');
    expect(result.ok).toBe(true);
    // The returned record is the one read AFTER the release.
    expect(result.booking!.status).toBe('cancelled');
    expect(result.booking!.assignedEmployee!.id).toBe(fx.staffA.id);
    expect(await liveProvider(booking)).toBeNull();
    expect(await liveSeqs('booking_resource_allocations', booking)).toEqual([]);
  });

  it('[C9.11] keeps a completed booking\'s claim but refuses to move it', async () => {
    const booking = await book();
    await captureBookingRequirements(getPool(), booking);
    await allocateBooking(getPool(), booking, {
      employeeId: fx.staffA.id,
      resourceIds: [fx.chairA1],
    });
    for (const [from, to] of [
      ['confirmed', 'checked_in'],
      ['checked_in', 'in_service'],
      ['in_service', 'completed'],
    ] as const) {
      await applyBookingTransition(getPool(), booking, from, to);
    }
    expect(await liveProvider(booking)).toBe(fx.staffA.id);
    expect(
      await allocationErrorOf(() => reassignProvider(getPool(), booking, fx.staffB.id)),
    ).toBe('not_allocatable_status');
  });

  it('[R4-7a] has the index the latest-provider read relies on', async () => {
    const rows = await getPool().query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
       WHERE tablename = 'booking_provider_allocations' AND indexname = 'provider_allocation_latest_idx'`,
    );
    expect(rows.rows[0]!.indexdef).toContain('allocation_seq DESC');
  });

  it('[R3-8] reads a whole day board with a bounded number of statements', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const id = await book({ hour: 9 + i * 2 });
      await captureBookingRequirements(getPool(), id);
      await allocateBooking(getPool(), id, {
        employeeId: i % 2 === 0 ? fx.staffA.id : fx.staffB.id,
        resourceIds: [i % 2 === 0 ? fx.chairA1 : fx.chairA2],
      });
      ids.push(id);
    }
    let statements = 0;
    const counting = {
      query: (text: string, values?: unknown[]) => {
        statements += 1;
        return getPool().query(text, values);
      },
    };
    const { listBookingsForBranchRange } = await import('@foot-repose/db');
    const { startUtc, endUtc } = { startUtc: new Date('2030-04-06T00:00:00Z'), endUtc: new Date('2030-04-08T00:00:00Z') };
    const records = await listBookingsForBranchRange(counting, fx.branchA, startUtc, endUtc);
    expect(records.length).toBeGreaterThanOrEqual(4);
    // One statement for the page, one for every provider on it — never one per row.
    expect(statements).toBe(2);
  });
});
