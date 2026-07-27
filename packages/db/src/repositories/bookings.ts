import type { BookingStatus } from '@foot-repose/domain';
import type { Queryable } from '../client';

export interface BookingRecord {
  id: string;
  branchId: string;
  status: BookingStatus;
  startsAt: Date;
  endsAt: Date;
  priceBaisa: number;
  currency: string;
  notes: string | null;
  service: { id: string; name: string; durationMin: number };
  customer: { id: string; fullName: string; phone: string };
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
  customer_id: string;
  customer_full_name: string;
  customer_phone: string;
  assigned_employee_id: string | null;
  assigned_employee_name: string | null;
}

const BOOKING_SELECT = `
  SELECT b.id, b.branch_id, b.status, b.starts_at, b.ends_at, b.price_baisa, b.currency, b.notes,
         b.service_id, b.service_name_snapshot, b.duration_min_snapshot,
         c.id AS customer_id, c.full_name AS customer_full_name, c.phone AS customer_phone,
         e.id AS assigned_employee_id, e.full_name AS assigned_employee_name
  FROM bookings b
  JOIN customers c ON c.id = b.customer_id
  LEFT JOIN employees e ON e.id = b.assigned_employee_id
`;

function toRecord(row: BookingJoinRow): BookingRecord {
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
    },
    customer: { id: row.customer_id, fullName: row.customer_full_name, phone: row.customer_phone },
    assignedEmployee:
      row.assigned_employee_id !== null && row.assigned_employee_name !== null
        ? { id: row.assigned_employee_id, fullName: row.assigned_employee_name }
        : null,
  };
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
  return result.rows.map(toRecord);
}

export async function findBookingById(db: Queryable, id: string): Promise<BookingRecord | null> {
  const result = await db.query<BookingJoinRow>(`${BOOKING_SELECT} WHERE b.id = $1`, [id]);
  const row = result.rows[0];
  return row ? toRecord(row) : null;
}

/**
 * Compare-and-swap status update. Returns false when the booking is no longer
 * in `from` (a concurrent transition won) — callers must treat that as a
 * conflict, not retry blindly.
 */
export async function transitionBookingStatus(
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
