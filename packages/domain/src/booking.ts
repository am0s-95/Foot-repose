export const BOOKING_STATUSES = [
  'confirmed',
  'checked_in',
  'in_service',
  'completed',
  'cancelled',
  'no_show',
] as const;

export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const BOOKING_ACTIONS = [
  'check_in',
  'start_service',
  'complete',
  'cancel',
  'mark_no_show',
] as const;

export type BookingAction = (typeof BOOKING_ACTIONS)[number];

/**
 * The booking lifecycle. Anything not listed here is an invalid transition.
 *
 *   confirmed ─check_in→ checked_in ─start_service→ in_service ─complete→ completed
 *       │ │                  │
 *       │ └──mark_no_show→ no_show
 *       └──cancel→ cancelled ←cancel── checked_in
 */
const TRANSITIONS: Readonly<
  Record<BookingStatus, Readonly<Partial<Record<BookingAction, BookingStatus>>>>
> = {
  confirmed: { check_in: 'checked_in', cancel: 'cancelled', mark_no_show: 'no_show' },
  checked_in: { start_service: 'in_service', cancel: 'cancelled' },
  in_service: { complete: 'completed' },
  completed: {},
  cancelled: {},
  no_show: {},
};

export function nextStatus(from: BookingStatus, action: BookingAction): BookingStatus | null {
  return TRANSITIONS[from][action] ?? null;
}

export function canTransition(from: BookingStatus, action: BookingAction): boolean {
  return nextStatus(from, action) !== null;
}

export function actionsForStatus(status: BookingStatus): BookingAction[] {
  return BOOKING_ACTIONS.filter((action) => canTransition(status, action));
}

export function isTerminalStatus(status: BookingStatus): boolean {
  return actionsForStatus(status).length === 0;
}

export function isBookingStatus(value: string): value is BookingStatus {
  return (BOOKING_STATUSES as readonly string[]).includes(value);
}

export function isBookingAction(value: string): value is BookingAction {
  return (BOOKING_ACTIONS as readonly string[]).includes(value);
}
