import {
  muscatDatesOf,
  occupancyOf,
  type BookingStatus,
} from '@foot-repose/domain';
import { withUnitOfWork, type Queryable } from '../client';

/**
 * Booking allocation integrity (Slice 2A.2b).
 *
 * Nothing here decides WHO should serve a booking or WHICH unit to use — there
 * is no automatic selection in this slice. These operations take an explicit
 * choice and either commit it atomically or refuse it.
 *
 * Two rules shape every function below:
 *
 *  * Conflicts are decided by PostgreSQL, never by this file. No operation
 *    checks "is the provider free?" and then inserts; it inserts, and a GiST
 *    exclusion constraint answers. That is the only answer that survives two
 *    concurrent requests from two processes.
 *  * Every operation takes the SAME global lock order — bookings by id, then
 *    branches, then employees by id, then branch_resources by id — because a
 *    swap that releases one side and claims the other is otherwise a textbook
 *    deadlock. `ORDER BY id ... FOR UPDATE` locks in sorted order regardless of
 *    the plan the planner picks (LockRows sits above Sort), which is what makes
 *    the ordering real rather than hopeful.
 *
 * The ordered locks are a LIVENESS measure, not the integrity guarantee: their
 * worst case if bypassed is 40P01 and a full rollback, never a double claim.
 */

const HOLDING_STATUSES: readonly BookingStatus[] = [
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
];

/** Statuses in which a normal allocation or re-allocation may happen at all.
 * `in_service` and `completed` keep their claim but are past the point where
 * the ordinary path may move it. */
const ALLOCATABLE_STATUSES: readonly BookingStatus[] = ['confirmed', 'checked_in'];

export type AllocationErrorCode =
  | 'booking_not_found'
  | 'branch_inactive'
  | 'employee_inactive'
  | 'not_allocatable_status'
  | 'not_assigned_to_branch'
  | 'not_qualified_for_service'
  | 'offering_not_effective'
  | 'offering_requirements_not_captured'
  | 'requirements_not_captured'
  | 'requirements_not_sealed'
  | 'requirements_unsatisfied'
  | 'resource_inactive'
  | 'resource_type_inactive'
  | 'stale';

export class AllocationError extends Error {
  constructor(
    readonly code: AllocationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AllocationError';
  }
}

interface BookingRow {
  id: string;
  branch_id: string;
  service_id: string;
  status: BookingStatus;
  starts_at: Date;
  ends_at: Date;
  buffer_before_min_snapshot: number;
  buffer_after_min_snapshot: number;
}

/** Lock the booking rows this operation touches, in ascending id order. */
async function lockBookings(tx: Queryable, bookingIds: string[]): Promise<BookingRow[]> {
  const result = await tx.query<BookingRow>(
    `SELECT id, branch_id, service_id, status, starts_at, ends_at,
            buffer_before_min_snapshot, buffer_after_min_snapshot
     FROM bookings WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE`,
    [bookingIds],
  );
  if (result.rows.length !== bookingIds.length) {
    throw new AllocationError('booking_not_found', 'Booking not found');
  }
  return result.rows;
}

/** Employees and resources are locked FOR UPDATE as ordered mutexes on the
 * identities a swap contends on. Sorting by id gives every transaction the same
 * acquisition order, so one waits instead of deadlocking. */
async function lockIdentities(
  tx: Queryable,
  employeeIds: string[],
  resourceIds: string[],
): Promise<void> {
  const employees = [...new Set(employeeIds)].sort();
  const resources = [...new Set(resourceIds)].sort();
  if (employees.length > 0) {
    await tx.query('SELECT id FROM employees WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE', [
      employees,
    ]);
  }
  if (resources.length > 0) {
    await tx.query(
      'SELECT id FROM branch_resources WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
      [resources],
    );
  }
}

async function assertBranchActive(tx: Queryable, branchId: string): Promise<void> {
  const result = await tx.query<{ is_active: boolean }>(
    'SELECT is_active FROM branches WHERE id = $1 FOR SHARE',
    [branchId],
  );
  if (result.rows[0]?.is_active !== true) {
    throw new AllocationError('branch_inactive', 'This branch is inactive');
  }
}

/**
 * Everything a provider must satisfy at claim time. Dated facts (T5/T6) are
 * range containment across two tables, which no foreign key can state, so this
 * is a repository guarantee — read FOR SHARE so a concurrent change to the
 * assignment or qualification cannot slip between the check and the write.
 *
 * Presence (roster, opening hours) is NOT checked here: that is the availability
 * engine's job in a later slice.
 */
async function assertProviderEligible(
  tx: Queryable,
  employeeId: string,
  booking: BookingRow,
  muscatDates: string[],
): Promise<void> {
  const employee = await tx.query<{ is_active: boolean }>(
    'SELECT is_active FROM employees WHERE id = $1 FOR SHARE',
    [employeeId],
  );
  if (employee.rows[0]?.is_active !== true) {
    throw new AllocationError('employee_inactive', 'This employee is inactive');
  }

  // Two statements on purpose: FOR SHARE cannot be combined with an aggregate,
  // so the candidate rows are locked first and then counted. Ending a dated
  // assignment is an UPDATE that closes its range, and the lock is what stops
  // one slipping between this check and the write.
  const [firstDate, lastDate] = [muscatDates[0]!, muscatDates[muscatDates.length - 1]!];
  await tx.query(
    `SELECT 1 FROM provider_branch_assignments
      WHERE employee_id = $1 AND branch_id = $2
        AND valid_dates && daterange($3::date, ($4::date + 1), '[)')
      FOR SHARE`,
    [employeeId, booking.branch_id, firstDate, lastDate],
  );
  const assigned = await tx.query<{ covered: number }>(
    `SELECT count(*)::int AS covered FROM (
       SELECT d FROM unnest($3::date[]) AS d
        WHERE EXISTS (SELECT 1 FROM provider_branch_assignments a
                      WHERE a.employee_id = $1 AND a.branch_id = $2 AND a.valid_dates @> d)
     ) covered_dates`,
    [employeeId, booking.branch_id, muscatDates],
  );
  if (assigned.rows[0]!.covered !== muscatDates.length) {
    throw new AllocationError(
      'not_assigned_to_branch',
      'This provider is not assigned to the branch for every Muscat date the booking occupies',
    );
  }

  await tx.query(
    `SELECT 1 FROM provider_service_qualifications
      WHERE employee_id = $1 AND service_id = $2
        AND valid_dates && daterange($3::date, ($4::date + 1), '[)')
      FOR SHARE`,
    [employeeId, booking.service_id, firstDate, lastDate],
  );
  const qualified = await tx.query<{ covered: number }>(
    `SELECT count(*)::int AS covered FROM (
       SELECT d FROM unnest($3::date[]) AS d
        WHERE EXISTS (SELECT 1 FROM provider_service_qualifications q
                      WHERE q.employee_id = $1 AND q.service_id = $2 AND q.valid_dates @> d)
     ) covered_dates`,
    [employeeId, booking.service_id, muscatDates],
  );
  if (qualified.rows[0]!.covered !== muscatDates.length) {
    throw new AllocationError(
      'not_qualified_for_service',
      'This provider is not qualified for the service for every Muscat date the booking occupies',
    );
  }
}

interface ResourceRow {
  id: string;
  resource_type_id: string;
  is_active: boolean;
  type_active: boolean;
}

async function loadResources(
  tx: Queryable,
  branchId: string,
  resourceIds: string[],
): Promise<ResourceRow[]> {
  // Checked before the read, because a duplicated id would otherwise come back
  // as a missing row and be reported as the wrong problem.
  if (new Set(resourceIds).size !== resourceIds.length) {
    throw new AllocationError('requirements_unsatisfied', 'Duplicate resource in the request');
  }
  const result = await tx.query<ResourceRow>(
    `SELECT r.id, r.resource_type_id, r.is_active, t.is_active AS type_active
     FROM branch_resources r
     JOIN resource_types t ON t.id = r.resource_type_id
     WHERE r.id = ANY($1::uuid[]) AND r.branch_id = $2
     ORDER BY r.id
     FOR SHARE`,
    [resourceIds, branchId],
  );
  if (result.rows.length !== resourceIds.length) {
    // A unit from another branch is refused by the composite FK too (23503);
    // failing here just produces a better message.
    throw new AllocationError(
      'resource_inactive',
      'Every requested resource must exist in this branch',
    );
  }
  for (const row of result.rows) {
    if (!row.is_active) {
      throw new AllocationError('resource_inactive', `Resource ${row.id} is retired`);
    }
    if (!row.type_active) {
      throw new AllocationError(
        'resource_type_inactive',
        `Resource ${row.id} has a retired resource type`,
      );
    }
  }
  return result.rows;
}

/**
 * The booking's OWN sealed requirement snapshot decides what must be claimed.
 * The live catalog is never consulted here: an offering version split after the
 * booking was made must not change what that booking requires.
 *
 * The three states are distinct and none of them is "zero":
 *   * no header      -> a pre-0006 booking, never initialised. Refused; never
 *                       silently read as "needs no resources".
 *   * header unsealed-> half built. Refused.
 *   * header sealed  -> authoritative, and MAY legitimately have zero rows.
 */
async function loadSealedRequirements(
  tx: Queryable,
  bookingId: string,
): Promise<Map<string, number>> {
  const header = await tx.query<{ sealed_at: Date | null }>(
    'SELECT sealed_at FROM booking_resource_requirement_sets WHERE booking_id = $1 FOR SHARE',
    [bookingId],
  );
  if (header.rowCount === 0) {
    throw new AllocationError(
      'requirements_not_captured',
      'This booking has no resource requirement set (it predates resource requirements); ' +
        'its requirements cannot be guessed',
    );
  }
  if (header.rows[0]!.sealed_at === null) {
    throw new AllocationError(
      'requirements_not_sealed',
      'This booking\'s requirement set is still being built',
    );
  }
  const rows = await tx.query<{ resource_type_id: string; required_qty: number }>(
    'SELECT resource_type_id, required_qty FROM booking_resource_requirements WHERE booking_id = $1',
    [bookingId],
  );
  return new Map(rows.rows.map((r) => [r.resource_type_id, r.required_qty]));
}

/**
 * The requested units must satisfy the snapshot EXACTLY: the right number of
 * the right types, no duplicates, and nothing extra. An "extra" unit is either
 * a data-entry mistake or a requirement that was never captured — both are
 * reasons to stop, not to consume capacity silently.
 *
 * This is a set property, not a row property, so no constraint can state it.
 */
function assertRequirementsSatisfied(
  requirements: Map<string, number>,
  resources: ResourceRow[],
): void {
  const ids = resources.map((r) => r.id);
  if (new Set(ids).size !== ids.length) {
    throw new AllocationError('requirements_unsatisfied', 'Duplicate resource in the request');
  }
  const supplied = new Map<string, number>();
  for (const resource of resources) {
    supplied.set(resource.resource_type_id, (supplied.get(resource.resource_type_id) ?? 0) + 1);
  }
  for (const [typeId, needed] of requirements) {
    const got = supplied.get(typeId) ?? 0;
    if (got !== needed) {
      throw new AllocationError(
        'requirements_unsatisfied',
        `Resource type ${typeId}: requires exactly ${needed}, received ${got}`,
      );
    }
  }
  for (const typeId of supplied.keys()) {
    if (!requirements.has(typeId)) {
      throw new AllocationError(
        'requirements_unsatisfied',
        `Resource type ${typeId} is not required by this booking`,
      );
    }
  }
}

function assertAllocatable(booking: BookingRow): void {
  if (!ALLOCATABLE_STATUSES.includes(booking.status)) {
    throw new AllocationError(
      'not_allocatable_status',
      `A booking with status ${booking.status} cannot be allocated or re-allocated`,
    );
  }
}

const bookingOccupancy = (booking: BookingRow): { startUtc: Date; endUtc: Date } =>
  occupancyOf({
    startsAt: booking.starts_at,
    endsAt: booking.ends_at,
    bufferBeforeMin: booking.buffer_before_min_snapshot,
    bufferAfterMin: booking.buffer_after_min_snapshot,
  });

// ------------------------------------------------------------ requirements

/**
 * Copy the effective offering's price, duration, buffers and resource
 * requirements onto the booking, then SEAL the snapshot — one unit of work.
 *
 * The composite foreign keys prove structurally that the source offering is for
 * this booking's own branch and own service. What they cannot prove is temporal
 * effectiveness (range containment across two tables), so that is checked here
 * with the offering row read FOR SHARE.
 *
 * Stated exactly: effectiveness is proved AT CAPTURE TIME, against the booking
 * start observed then. A later reschedule moves the booking (and cascades every
 * claim) but does NOT re-prove that the source offering was effective at the new
 * start. Slice 2B must either revalidate on reschedule or deliberately keep the
 * original capture as historical provenance.
 */
export async function captureBookingRequirements(
  db: Queryable,
  bookingId: string,
): Promise<string> {
  return withUnitOfWork(db, async (tx) => {
    const [booking] = await lockBookings(tx, [bookingId]);
    const offering = await tx.query<{
      id: string;
      price_baisa: number;
      duration_min: number;
      buffer_before_min: number;
      buffer_after_min: number;
      captured: Date | null;
    }>(
      `SELECT o.id, o.price_baisa, o.duration_min, o.buffer_before_min, o.buffer_after_min,
              o.resource_requirements_captured_at AS captured
       FROM branch_service_offerings o
       WHERE o.branch_id = $1 AND o.service_id = $2 AND o.valid_during @> $3::timestamptz
       FOR SHARE`,
      [booking!.branch_id, booking!.service_id, booking!.starts_at],
    );
    if (offering.rowCount === 0) {
      throw new AllocationError(
        'offering_not_effective',
        'No offering of this service is effective in this branch at the booking start',
      );
    }
    const source = offering.rows[0]!;
    if (source.captured === null) {
      throw new AllocationError(
        'offering_requirements_not_captured',
        'This offering has no captured resource requirements; they cannot be guessed',
      );
    }

    await tx.query(
      `INSERT INTO booking_resource_requirement_sets
         (booking_id, branch_id, service_id, source_offering_id)
       VALUES ($1, $2, $3, $4)`,
      [bookingId, booking!.branch_id, booking!.service_id, source.id],
    );
    await tx.query(
      `INSERT INTO booking_resource_requirements (booking_id, resource_type_id, required_qty)
       SELECT $1, r.resource_type_id, r.required_qty
       FROM branch_service_offering_resources r WHERE r.offering_id = $2`,
      [bookingId, source.id],
    );
    // Sealing takes the same row lock the child guard takes, so a child insert
    // racing the seal is serialised and then refused.
    await tx.query(
      `UPDATE booking_resource_requirement_sets SET sealed_at = statement_timestamp()
       WHERE booking_id = (SELECT booking_id FROM booking_resource_requirement_sets
                            WHERE booking_id = $1 FOR UPDATE)`,
      [bookingId],
    );
    return source.id;
  });
}

// -------------------------------------------------------------- allocation

export interface AllocateBookingInput {
  employeeId: string;
  resourceIds: string[];
}

/** Claim a provider and the exact set of units the booking's sealed snapshot
 * requires. All or nothing: a conflict on the last unit undoes the provider. */
export async function allocateBooking(
  db: Queryable,
  bookingId: string,
  input: AllocateBookingInput,
): Promise<void> {
  await withUnitOfWork(db, async (tx) => {
    const [booking] = await lockBookings(tx, [bookingId]);
    assertAllocatable(booking!);
    await lockIdentities(tx, [input.employeeId], input.resourceIds);
    await assertBranchActive(tx, booking!.branch_id);

    const dates = muscatDatesOf(bookingOccupancy(booking!));
    await assertProviderEligible(tx, input.employeeId, booking!, dates);

    const requirements = await loadSealedRequirements(tx, bookingId);
    const resources = await loadResources(tx, booking!.branch_id, input.resourceIds);
    assertRequirementsSatisfied(requirements, resources);

    await insertProviderClaim(tx, booking!, input.employeeId);
    for (const resource of resources) {
      await insertResourceClaim(tx, booking!, resource);
    }
  });
}

async function insertProviderClaim(
  tx: Queryable,
  booking: BookingRow,
  employeeId: string,
): Promise<void> {
  // The occupancy is derived by the database from the booking row itself; this
  // statement cannot state one.
  await tx.query(
    `INSERT INTO booking_provider_allocations
       (booking_id, branch_id, employee_id, b_starts_at, b_ends_at, b_buf_before, b_buf_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      booking.id,
      booking.branch_id,
      employeeId,
      booking.starts_at,
      booking.ends_at,
      booking.buffer_before_min_snapshot,
      booking.buffer_after_min_snapshot,
    ],
  );
}

async function insertResourceClaim(
  tx: Queryable,
  booking: BookingRow,
  resource: { id: string; resource_type_id: string },
): Promise<void> {
  await tx.query(
    `INSERT INTO booking_resource_allocations
       (booking_id, branch_id, resource_id, resource_type_id,
        b_starts_at, b_ends_at, b_buf_before, b_buf_after)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      booking.id,
      booking.branch_id,
      resource.id,
      resource.resource_type_id,
      booking.starts_at,
      booking.ends_at,
      booking.buffer_before_min_snapshot,
      booking.buffer_after_min_snapshot,
    ],
  );
}

// ------------------------------------------------------------ reassignment

/**
 * Move a booking to a different provider WITHOUT touching its resources.
 *
 * Deliberately usable on a pre-0006 booking that has no requirement set: it
 * neither invents nor modifies any resource claim, so the absence of a snapshot
 * is irrelevant to it. Every provider eligibility check still applies.
 */
export async function reassignProvider(
  db: Queryable,
  bookingId: string,
  newEmployeeId: string,
): Promise<void> {
  await withUnitOfWork(db, async (tx) => {
    const [booking] = await lockBookings(tx, [bookingId]);
    assertAllocatable(booking!);

    const live = await tx.query<{ allocation_seq: string; employee_id: string }>(
      `SELECT allocation_seq, employee_id FROM booking_provider_allocations
       WHERE booking_id = $1 AND released_at IS NULL`,
      [bookingId],
    );
    const currentEmployee = live.rows[0]?.employee_id;
    await lockIdentities(tx, currentEmployee ? [currentEmployee, newEmployeeId] : [newEmployeeId], []);
    await assertBranchActive(tx, booking!.branch_id);
    await assertProviderEligible(
      tx,
      newEmployeeId,
      booking!,
      muscatDatesOf(bookingOccupancy(booking!)),
    );

    if (live.rows.length > 0) {
      await releaseProviderClaims(
        tx,
        bookingId,
        live.rows.map((r) => r.allocation_seq),
        'reassign',
      );
    }
    await insertProviderClaim(tx, booking!, newEmployeeId);
  });
}

async function releaseProviderClaims(
  tx: Queryable,
  bookingId: string,
  seqs: string[],
  reason: string,
): Promise<void> {
  const result = await tx.query(
    `UPDATE booking_provider_allocations
        SET released_at = statement_timestamp(), release_reason = $3
      WHERE booking_id = $1 AND allocation_seq = ANY($2::bigint[]) AND released_at IS NULL`,
    [bookingId, seqs, reason],
  );
  if (result.rowCount !== seqs.length) {
    throw new AllocationError('stale', 'Allocation state changed while releasing');
  }
}

async function releaseResourceClaims(
  tx: Queryable,
  bookingId: string,
  seqs: string[],
  reason: string,
): Promise<void> {
  const result = await tx.query(
    `UPDATE booking_resource_allocations
        SET released_at = statement_timestamp(), release_reason = $3
      WHERE booking_id = $1 AND allocation_seq = ANY($2::bigint[]) AND released_at IS NULL`,
    [bookingId, seqs, reason],
  );
  if (result.rowCount !== seqs.length) {
    throw new AllocationError('stale', 'Allocation state changed while releasing');
  }
}

// -------------------------------------------------------------------- swaps

/** One side of a swap: the booking, and the caller's belief about its CURRENT
 * live allocations. The belief is checked for exact equality, not containment. */
export interface SwapSide {
  bookingId: string;
  expectedAllocationSeqs: string[];
}

export interface SwapInput {
  a: SwapSide;
  b: SwapSide;
}

/**
 * Validate the caller's expected state against reality, for exactly the two
 * bookings involved, before anything is written.
 *
 * A flat list of sequence numbers is not enough and is actively dangerous: a
 * sequence belonging to a third booking would be released by a global
 * `WHERE allocation_seq = ANY(...)`, and an unlisted live allocation of one of
 * the two bookings would survive a swap that claimed to replace it. So the
 * expectation is keyed by booking, and equality is checked in both directions.
 *
 * The live rows read here are also the ONLY source of the old identities the
 * swap moves — they are never looked up from the caller's sequence numbers.
 */
function assertExactExpectedState<T extends { allocation_seq: string; booking_id: string }>(
  input: SwapInput,
  live: T[],
): { a: T[]; b: T[] } {
  if (input.a.bookingId === input.b.bookingId) {
    throw new AllocationError('stale', 'A swap needs two distinct bookings');
  }
  const sides = [input.a, input.b];
  const allExpected = sides.flatMap((s) => s.expectedAllocationSeqs);
  if (new Set(allExpected).size !== allExpected.length) {
    throw new AllocationError('stale', 'Duplicate allocation sequence in the expected state');
  }

  const grouped = new Map<string, T[]>([
    [input.a.bookingId, []],
    [input.b.bookingId, []],
  ]);
  for (const row of live) grouped.get(row.booking_id)!.push(row);

  for (const side of sides) {
    const liveSeqs = new Set(grouped.get(side.bookingId)!.map((r) => r.allocation_seq));
    const expected = new Set(side.expectedAllocationSeqs);
    for (const seq of expected) {
      if (!liveSeqs.has(seq)) {
        throw new AllocationError(
          'stale',
          `Allocation ${seq} is not a live allocation of booking ${side.bookingId}`,
        );
      }
    }
    for (const seq of liveSeqs) {
      if (!expected.has(seq)) {
        throw new AllocationError(
          'stale',
          `Booking ${side.bookingId} has live allocation ${seq} that the request did not expect`,
        );
      }
    }
  }
  return { a: grouped.get(input.a.bookingId)!, b: grouped.get(input.b.bookingId)! };
}

/**
 * Exchange the providers of two bookings, atomically.
 *
 * Two independent `reassignProvider` calls are NOT a swap: each releases its own
 * side and then collides with the other side's still-committed claim, so both
 * fail (correctly, but uselessly). A real exchange has to release both and claim
 * both inside one transaction — which is exactly what this does.
 *
 * Two concurrent calls to this function produce one winner: the loser blocks on
 * the ordered identity locks, wakes to find the state it expected is gone, and
 * is refused as stale before it writes anything.
 */
export async function swapProviders(db: Queryable, input: SwapInput): Promise<void> {
  await withUnitOfWork(db, async (tx) => {
    const bookings = await lockBookings(tx, [input.a.bookingId, input.b.bookingId]);
    for (const booking of bookings) assertAllocatable(booking);

    const live = await tx.query<{
      allocation_seq: string;
      booking_id: string;
      employee_id: string;
    }>(
      `SELECT allocation_seq, booking_id, employee_id FROM booking_provider_allocations
       WHERE booking_id = ANY($1::uuid[]) AND released_at IS NULL`,
      [[input.a.bookingId, input.b.bookingId]],
    );
    const sides = assertExactExpectedState(input, live.rows);
    if (sides.a.length !== 1 || sides.b.length !== 1) {
      throw new AllocationError('stale', 'Both bookings must have exactly one live provider');
    }

    await lockIdentities(tx, [sides.a[0]!.employee_id, sides.b[0]!.employee_id], []);

    const byId = new Map(bookings.map((b) => [b.id, b]));
    for (const booking of bookings) await assertBranchActive(tx, booking.branch_id);
    // A gets B's provider and vice versa; each must be eligible for its NEW booking.
    const targets: [BookingRow, string][] = [
      [byId.get(input.a.bookingId)!, sides.b[0]!.employee_id],
      [byId.get(input.b.bookingId)!, sides.a[0]!.employee_id],
    ];
    for (const [booking, employeeId] of targets) {
      await assertProviderEligible(
        tx,
        employeeId,
        booking,
        muscatDatesOf(bookingOccupancy(booking)),
      );
    }

    await releaseProviderClaims(tx, input.a.bookingId, input.a.expectedAllocationSeqs, 'swap');
    await releaseProviderClaims(tx, input.b.bookingId, input.b.expectedAllocationSeqs, 'swap');
    for (const [booking, employeeId] of targets) {
      await insertProviderClaim(tx, booking, employeeId);
    }
  });
}

/** Exchange the physical resource sets of two bookings, atomically. Both
 * bookings need a sealed requirement snapshot, and each incoming set must
 * satisfy the receiving booking's own snapshot exactly. */
export async function swapResources(db: Queryable, input: SwapInput): Promise<void> {
  await withUnitOfWork(db, async (tx) => {
    const bookings = await lockBookings(tx, [input.a.bookingId, input.b.bookingId]);
    for (const booking of bookings) assertAllocatable(booking);

    const live = await tx.query<{
      allocation_seq: string;
      booking_id: string;
      resource_id: string;
    }>(
      `SELECT allocation_seq, booking_id, resource_id FROM booking_resource_allocations
       WHERE booking_id = ANY($1::uuid[]) AND released_at IS NULL`,
      [[input.a.bookingId, input.b.bookingId]],
    );
    const sides = assertExactExpectedState(input, live.rows);

    await lockIdentities(
      tx,
      [],
      [...sides.a.map((r) => r.resource_id), ...sides.b.map((r) => r.resource_id)],
    );

    const byId = new Map(bookings.map((b) => [b.id, b]));
    for (const booking of bookings) await assertBranchActive(tx, booking.branch_id);

    // Each booking receives the other's units.
    const targets: [BookingRow, string[]][] = [
      [byId.get(input.a.bookingId)!, sides.b.map((r) => r.resource_id)],
      [byId.get(input.b.bookingId)!, sides.a.map((r) => r.resource_id)],
    ];
    const resolved: [BookingRow, ResourceRow[]][] = [];
    for (const [booking, resourceIds] of targets) {
      const requirements = await loadSealedRequirements(tx, booking.id);
      const resources = await loadResources(tx, booking.branch_id, resourceIds);
      assertRequirementsSatisfied(requirements, resources);
      resolved.push([booking, resources]);
    }

    await releaseResourceClaims(tx, input.a.bookingId, input.a.expectedAllocationSeqs, 'swap');
    await releaseResourceClaims(tx, input.b.bookingId, input.b.expectedAllocationSeqs, 'swap');
    for (const [booking, resources] of resolved) {
      for (const resource of resources) await insertResourceClaim(tx, booking, resource);
    }
  });
}

// ------------------------------------------------------------------ release

/**
 * Release every live claim of a booking. Called by the status transition when a
 * booking moves to a status that no longer holds capacity.
 *
 * The rows stay: `released_occupancy` freezes what was actually claimed, so a
 * later reschedule (which cascades the live mirrors) cannot rewrite history.
 */
export async function releaseBookingAllocations(
  db: Queryable,
  bookingId: string,
  reason: string,
): Promise<void> {
  await db.query(
    `UPDATE booking_provider_allocations
        SET released_at = statement_timestamp(), release_reason = $2
      WHERE booking_id = $1 AND released_at IS NULL`,
    [bookingId, reason],
  );
  await db.query(
    `UPDATE booking_resource_allocations
        SET released_at = statement_timestamp(), release_reason = $2
      WHERE booking_id = $1 AND released_at IS NULL`,
    [bookingId, reason],
  );
}

export const HOLDING_BOOKING_STATUSES = HOLDING_STATUSES;
export const ALLOCATABLE_BOOKING_STATUSES = ALLOCATABLE_STATUSES;

// -------------------------------------------------------------------- reads

export interface LatestProviderAllocation {
  bookingId: string;
  employeeId: string;
  fullName: string;
  isLive: boolean;
}

/**
 * The most recent provider allocation of each booking, live or released.
 *
 * Set-based on purpose: ONE statement for a whole day's board, keyed by
 * `booking_id = ANY($1)`, ordered by `allocation_seq DESC` — the deterministic
 * logical order of writes to that booking. `allocated_at` cannot order them
 * (now() is transaction-stable, so two writes in one transaction share it) and
 * neither can a uuid.
 *
 * "Latest historical", not "current live", is what the booking DTO shows: a
 * cancelled booking keeps naming the provider it was assigned to, exactly as it
 * did when that was a column on `bookings`.
 */
export async function listLatestProviderAllocations(
  db: Queryable,
  bookingIds: string[],
): Promise<LatestProviderAllocation[]> {
  if (bookingIds.length === 0) return [];
  const result = await db.query<{
    booking_id: string;
    employee_id: string;
    full_name: string;
    is_live: boolean;
  }>(
    `SELECT DISTINCT ON (a.booking_id)
            a.booking_id, a.employee_id, e.full_name, (a.released_at IS NULL) AS is_live
     FROM booking_provider_allocations a
     JOIN employees e ON e.id = a.employee_id
     WHERE a.booking_id = ANY($1::uuid[])
     ORDER BY a.booking_id, a.allocation_seq DESC`,
    [bookingIds],
  );
  return result.rows.map((row) => ({
    bookingId: row.booking_id,
    employeeId: row.employee_id,
    fullName: row.full_name,
    isLive: row.is_live,
  }));
}
