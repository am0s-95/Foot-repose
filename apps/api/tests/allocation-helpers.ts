import { muscatDateTimeToUtc } from '@foot-repose/domain';
import type { Pool } from '@foot-repose/db';
import { getPool } from '../src/lib/pool';
import { setupFixtures, type Fixtures } from './helpers';

/**
 * Fixtures for Slice 2A.2b. Built on top of the slice-1 fixtures and adding
 * exactly what allocation needs: an offering with CAPTURED resource
 * requirements, physical units in both branches, and dated assignment plus
 * qualification for the providers.
 */
export interface AllocationFixtures extends Fixtures {
  chairTypeId: string;
  roomTypeId: string;
  /** Two interchangeable chairs in branch A, one chair in branch B, one room in A. */
  chairA1: string;
  chairA2: string;
  chairB1: string;
  roomA1: string;
  offeringA: string;
  /** Service that requires one chair; `service` from the base fixtures. */
  bookingDate: string;
}

const VALID_FROM = '2029-01-01';

export async function setupAllocationFixtures(): Promise<AllocationFixtures> {
  const fx = await setupFixtures();
  const pool = getPool();

  const types = await pool.query<{ id: string; code: string }>(
    `INSERT INTO resource_types (code, name) VALUES ('chair', 'Chair'), ('room', 'Room')
     RETURNING id, code`,
  );
  const chairTypeId = types.rows.find((r) => r.code === 'chair')!.id;
  const roomTypeId = types.rows.find((r) => r.code === 'room')!.id;

  const resource = async (
    branchId: string,
    typeId: string,
    code: string,
    label: string,
  ): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO branch_resources (branch_id, resource_type_id, code, label)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [branchId, typeId, code, label],
      )
    ).rows[0]!.id;

  const chairA1 = await resource(fx.branchA, chairTypeId, 'CH01', 'Fictional chair 1');
  const chairA2 = await resource(fx.branchA, chairTypeId, 'CH02', 'Fictional chair 2');
  const roomA1 = await resource(fx.branchA, roomTypeId, 'RM01', 'Fictional room 1');
  const chairB1 = await resource(fx.branchB, chairTypeId, 'CH01', 'Fictional chair 1');

  // One offering per branch for the base service, open-ended, buffers 0/10.
  const offering = async (branchId: string): Promise<string> =>
    (
      await pool.query<{ id: string }>(
        `INSERT INTO branch_service_offerings
           (branch_id, service_id, valid_during, price_baisa, duration_min,
            buffer_before_min, buffer_after_min)
         VALUES ($1, $2, tstzrange('2029-01-01T00:00:00Z', NULL, '[)'), 8500, 45, 0, 10)
         RETURNING id`,
        [branchId, fx.service],
      )
    ).rows[0]!.id;
  const offeringA = await offering(fx.branchA);
  const offeringB = await offering(fx.branchB);

  for (const id of [offeringA, offeringB]) {
    await pool.query(
      `INSERT INTO branch_service_offering_resources (offering_id, resource_type_id, required_qty)
       VALUES ($1, $2, 1)`,
      [id, chairTypeId],
    );
    await pool.query(
      'UPDATE branch_service_offerings SET resource_requirements_captured_at = now() WHERE id = $1',
      [id],
    );
  }

  for (const [employeeId, branchId] of [
    [fx.staffA.id, fx.branchA],
    [fx.staffB.id, fx.branchA],
    [fx.staffA.id, fx.branchB],
  ] as const) {
    await pool.query(
      `INSERT INTO provider_branch_assignments (employee_id, branch_id, valid_dates)
       VALUES ($1, $2, daterange($3::date, NULL, '[)'))`,
      [employeeId, branchId, VALID_FROM],
    );
  }
  for (const employeeId of [fx.staffA.id, fx.staffB.id]) {
    await pool.query(
      `INSERT INTO provider_service_qualifications (employee_id, service_id, valid_dates)
       VALUES ($1, $2, daterange($3::date, NULL, '[)'))`,
      [employeeId, fx.service, VALID_FROM],
    );
  }

  return {
    ...fx,
    chairTypeId,
    roomTypeId,
    chairA1,
    chairA2,
    chairB1,
    roomA1,
    offeringA,
    bookingDate: '2030-04-07',
  };
}

export interface BookingSpec {
  branchId: string;
  isoDate: string;
  hour: number;
  minute?: number;
  durationMin?: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  serviceId: string;
  customerId: string;
  status?: string;
}

/** A booking row plus a sealed, empty-or-chair requirement snapshot. Created
 * directly (there is no booking-creation endpoint in this slice). */
export async function makeBooking(spec: BookingSpec): Promise<string> {
  const pool: Pool = getPool();
  const startsAt = muscatDateTimeToUtc(spec.isoDate, spec.hour, spec.minute ?? 0);
  const endsAt = new Date(startsAt.getTime() + (spec.durationMin ?? 45) * 60_000);
  const result = await pool.query<{ id: string }>(
    `INSERT INTO bookings
       (branch_id, customer_id, service_id, status, starts_at, ends_at, price_baisa,
        service_name_snapshot, duration_min_snapshot,
        buffer_before_min_snapshot, buffer_after_min_snapshot)
     VALUES ($1, $2, $3, $4, $5, $6, 8500, 'Fixture service', $7, $8, $9)
     RETURNING id`,
    [
      spec.branchId,
      spec.customerId,
      spec.serviceId,
      spec.status ?? 'confirmed',
      startsAt,
      endsAt,
      spec.durationMin ?? 45,
      spec.bufferBeforeMin ?? 0,
      spec.bufferAfterMin ?? 10,
    ],
  );
  return result.rows[0]!.id;
}

/** SQLSTATE of a failing statement, or 'no error' when it succeeded. */
export async function sqlstateOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `unexpected: ${(error as Error).message}`;
  }
}

/** The AllocationError code of a failing call, or 'no error'. */
export async function allocationErrorOf(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
    return 'no error';
  } catch (error) {
    const code = (error as { code?: string }).code;
    return code ?? `unexpected: ${(error as Error).message}`;
  }
}

/**
 * Wait until a SPECIFIC backend is blocked, and by whom.
 *
 * `pg_locks WHERE NOT granted` counts every waiter in the cluster, including
 * ones that have nothing to do with the test; `pg_blocking_pids` answers the
 * question actually being asked.
 */
export async function waitUntilBlockedBy(
  db: Pool,
  blockedPid: number,
  timeoutMs = 10_000,
): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await db.query<{ blockers: number[] }>(
      'SELECT pg_blocking_pids($1) AS blockers',
      [blockedPid],
    );
    if (result.rows[0]!.blockers.length > 0) return result.rows[0]!.blockers;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return [];
}

export async function backendPid(client: { query: Pool['query'] }): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
  return result.rows[0]!.pid;
}
