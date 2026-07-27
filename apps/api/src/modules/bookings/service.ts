import {
  allowedBookingActions,
  canAccessBranch,
  checkBookingActionPermission,
  formatMuscatTime,
  formatOmr,
  muscatDayUtcRange,
  nextStatus,
  todayInMuscat,
  type Actor,
  type BookingAction,
} from '@foot-repose/domain';
import {
  findBookingById,
  insertAuditLog,
  listBookingsForBranchRange,
  transitionBookingStatus,
  withTransaction,
  type BookingRecord,
  type BranchRecord,
} from '@foot-repose/db';
import type { BookingDto, BookingsListResponse, BookingsQuery } from '@foot-repose/contracts';
import { HttpError } from '../../lib/http';
import { getPool } from '../../lib/pool';
import { toBranchSummary } from '../../lib/session';

function toDto(record: BookingRecord, actor: Actor): BookingDto {
  return {
    id: record.id,
    branchId: record.branchId,
    status: record.status,
    startsAt: record.startsAt.toISOString(),
    endsAt: record.endsAt.toISOString(),
    startTimeLocal: formatMuscatTime(record.startsAt),
    endTimeLocal: formatMuscatTime(record.endsAt),
    priceBaisa: record.priceBaisa,
    priceFormatted: formatOmr(record.priceBaisa),
    currency: 'OMR',
    notes: record.notes,
    service: record.service,
    customer: record.customer,
    assignedEmployee: record.assignedEmployee,
    allowedActions: allowedBookingActions(actor, record.status, record.branchId),
  };
}

export async function listBranchDayBookings(
  actor: Actor,
  accessibleBranches: BranchRecord[],
  branchId: string,
  query: BookingsQuery,
): Promise<BookingsListResponse> {
  if (!canAccessBranch(actor, branchId)) {
    throw new HttpError(403, 'forbidden', 'You are not assigned to this branch');
  }
  const branch = accessibleBranches.find((candidate) => candidate.id === branchId);
  if (!branch) throw new HttpError(404, 'not_found', 'Branch not found');

  const date = query.date ?? todayInMuscat();
  const { startUtc, endUtc } = muscatDayUtcRange(date);
  const records = await listBookingsForBranchRange(getPool(), branchId, startUtc, endUtc, {
    status: query.status,
    q: query.q,
  });
  return {
    branch: toBranchSummary(branch),
    date,
    bookings: records.map((record) => toDto(record, actor)),
  };
}

/**
 * Perform one state-machine transition. Permission checks run server-side,
 * the status update is a compare-and-swap inside a transaction (duplicate or
 * concurrent transitions lose with 409), and every success is audited
 * atomically with the change.
 */
export async function transitionBooking(
  actor: Actor,
  bookingId: string,
  action: BookingAction,
  ip: string | null,
): Promise<BookingDto> {
  const pool = getPool();
  const updated = await withTransaction(pool, async (tx) => {
    const booking = await findBookingById(tx, bookingId);
    if (!booking) throw new HttpError(404, 'not_found', 'Booking not found');

    const permission = checkBookingActionPermission(actor, action, booking.branchId);
    if (!permission.allowed) {
      throw new HttpError(
        403,
        'forbidden',
        permission.reason === 'branch_not_allowed'
          ? 'You are not assigned to the branch of this booking'
          : `Role ${actor.role} is not allowed to ${action}`,
      );
    }

    if (!booking.branchIsActive) {
      throw new HttpError(
        409,
        'conflict',
        'This branch is inactive — its bookings cannot be transitioned',
      );
    }

    const to = nextStatus(booking.status, action);
    if (to === null) {
      throw new HttpError(
        409,
        'invalid_transition',
        `Cannot ${action} a booking with status ${booking.status}`,
      );
    }

    const swapped = await transitionBookingStatus(tx, booking.id, booking.status, to);
    if (!swapped) {
      throw new HttpError(
        409,
        'conflict',
        'Booking was updated by someone else — refresh and try again',
      );
    }

    await insertAuditLog(tx, {
      actorEmployeeId: actor.employeeId,
      action: `booking.${action}`,
      entityType: 'booking',
      entityId: booking.id,
      branchId: booking.branchId,
      fromStatus: booking.status,
      toStatus: to,
      metadata: { startsAt: booking.startsAt.toISOString(), customerId: booking.customer.id },
      ip,
    });

    return { ...booking, status: to };
  });
  return toDto(updated, actor);
}
