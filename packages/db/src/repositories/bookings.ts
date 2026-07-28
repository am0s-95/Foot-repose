import type { BookingStatus } from '@foot-repose/domain';
import { withUnitOfWork, type Queryable } from '../client';
import {
  listLatestProviderAllocations,
  releaseBookingAllocations,
  HOLDING_BOOKING_STATUSES,
} from './allocations';

export interface BookingRecord {
  id: string;
  branchId: string;
  status: BookingStatus;
  startsAt: Date;
  endsAt: Date;
  priceBaisa: number;
  currency: string;
  notes: string | null;
  service: {
    id: string;
    name: string;
    durationMin: number;
    bufferBeforeMin: number;
    bufferAfterMin: number;
  };
  customer: { id: string; fullName: string; phone: string };
  /** The provider most recently allocated to this booking, live or released.
   * Kept nullable and singular: the schema allows one live provider per
   * booking, and contracts, the DTO and the branch board all model exactly one. */
  assignedEmployee: { id: string; fullName: string } | null;
}

export interface BookingListFilters {
  status?: BookingStatus;
  q?: string;
}

interface BookingJoinRow {
  id: string;
  branch_id: string;
  status: BookingStatus;
  starts_at: Date;
  ends_at: Date;
  price_baisa: number;
  currency: string;
  notes: string | null;
  service_id: string;
  service_name_snapshot: string;
  duration_min_snapshot: number;
  buffer_before_min_snapshot: number;
  buffer_after_min_snapshot: number;
  customer_id: string;
  customer_full_name: string;
  customer_phone: string;
}

const BOOKING_SELECT = `
  SELECT b.id, b.branch_id, b.status, b.starts_at, b.ends_at, b.price_baisa, b.currency, b.notes,
         b.service_id, b.service_name_snapshot, b.duration_min_snapshot,
         b.buffer_before_min_snapshot, b.buffer_after_min_snapshot,
         c.id AS customer_id, c.full_name AS customer_full_name, c.phone AS customer_phone
  FROM bookings b
  JOIN customers c ON c.id = b.customer_id
`;

function toRecord(
  row: BookingJoinRow,
  provider: { id: string; fullName: string } | null,
): BookingRecord {
  return {
    id: row.id,
    branchId: row.branch_id,
    status: row.status,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    priceBaisa: row.price_baisa,
    currency: row.currency,
    notes: row.notes,
    // Snapshots taken at booking time — later catalog changes never rewrite history.
    service: {
      id: row.service_id,
      name: row.service_name_snapshot,
      durationMin: row.duration_min_snapshot,
      bufferBeforeMin: row.buffer_before_min_snapshot,
      bufferAfterMin: row.buffer_after_min_snapshot,
    },
    customer: { id: row.customer_id, fullName: row.customer_full_name, phone: row.customer_phone },
    assignedEmployee: provider,
  };
}

/**
 * Attach the latest provider allocation to a page of bookings with ONE extra
 * statement, whatever the page size. Since 0006 the provider lives in
 * `booking_provider_allocations`, not in a column on `bookings` — there is no
 * second source of truth to drift.
 */
async function withProviders(db: Queryable, rows: BookingJoinRow[]): Promise<BookingRecord[]> {
  const latest = await listLatestProviderAllocations(
    db,
    rows.map((row) => row.id),
  );
  const byBooking = new Map(
    latest.map((entry) => [entry.bookingId, { id: entry.employeeId, fullName: entry.fullName }]),
  );
  return rows.map((row) => toRecord(row, byBooking.get(row.id) ?? null));
}

export async function listBookingsForBranchRange(
  db: Queryable,
  branchId: string,
  startUtc: Date,
  endUtc: Date,
  filters: BookingListFilters = {},
): Promise<BookingRecord[]> {
  const conditions = ['b.branch_id = $1', 'b.starts_at >= $2', 'b.starts_at < $3'];
  const values: unknown[] = [branchId, startUtc, endUtc];
  if (filters.status) {
    values.push(filters.status);
    conditions.push(`b.status = $${values.length}`);
  }
  if (filters.q) {
    values.push(`%${filters.q}%`);
    conditions.push(`(c.full_name ILIKE $${values.length} OR c.phone ILIKE $${values.length})`);
  }
  const result = await db.query<BookingJoinRow>(
    `${BOOKING_SELECT} WHERE ${conditions.join(' AND ')} ORDER BY b.starts_at, b.id`,
    values,
  );
  return withProviders(db, result.rows);
}

export async function findBookingById(db: Queryable, id: string): Promise<BookingRecord | null> {
  const result = await db.query<BookingJoinRow>(`${BOOKING_SELECT} WHERE b.id = $1`, [id]);
  if (result.rowCount === 0) return null;
  return (await withProviders(db, result.rows))[0]!;
}

/**
 * Compare-and-swap status update. Returns false when the booking is no longer
 * in `from` (a concurrent transition won).
 *
 * Deliberately NOT exported from the package: flipping a booking's status
 * without releasing the capacity it holds would leave a provider and a room
 * blocked forever. `applyBookingTransition` is the only public way in.
 */
async function compareAndSwapStatus(
  db: Queryable,
  id: string,
  from: BookingStatus,
  to: BookingStatus,
): Promise<boolean> {
  const result = await db.query(
    'UPDATE bookings SET status = $3, updated_at = now() WHERE id = $1 AND status = $2',
    [id, from, to],
  );
  return result.rowCount === 1;
}

export interface BookingTransitionResult {
  ok: boolean;
  booking: BookingRecord | null;
}

/**
 * Status change and capacity release as ONE atomic repository operation.
 *
 * A status that no longer holds capacity must free the provider and the units
 * in the same transaction that sets it, and the caller must not be handed the
 * pre-release snapshot it read a moment earlier — so the record is re-read
 * after the writes and that re-read is what comes back.
 *
 * The link "status stopped holding capacity, therefore release" is a repository
 * guarantee, not a constraint. Its failure direction is safe: a missed release
 * over-blocks a slot (lost availability), it never permits a double claim.
 */
export async function applyBookingTransition(
  db: Queryable,
  id: string,
  from: BookingStatus,
  to: BookingStatus,
): Promise<BookingTransitionResult> {
  return withUnitOfWork(db, async (tx) => {
    const swapped = await compareAndSwapStatus(tx, id, from, to);
    if (!swapped) return { ok: false, booking: null };
    if (!HOLDING_BOOKING_STATUSES.includes(to)) {
      await releaseBookingAllocations(tx, id, `booking_status:${to}`);
    }
    return { ok: true, booking: await findBookingById(tx, id) };
  });
}
