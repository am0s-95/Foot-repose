import { actionsForStatus, type BookingAction, type BookingStatus } from './booking';

export const EMPLOYEE_ROLES = ['super_admin', 'branch_manager', 'staff'] as const;

export type EmployeeRole = (typeof EMPLOYEE_ROLES)[number];

/**
 * Which roles may perform each booking action. This map is enforced on the
 * server — UIs only mirror it through the API's `allowedActions` field.
 */
const ACTION_ROLES: Readonly<Record<BookingAction, readonly EmployeeRole[]>> = {
  check_in: ['staff', 'branch_manager', 'super_admin'],
  start_service: ['staff', 'branch_manager', 'super_admin'],
  complete: ['staff', 'branch_manager', 'super_admin'],
  cancel: ['branch_manager', 'super_admin'],
  mark_no_show: ['branch_manager', 'super_admin'],
};

export interface Actor {
  employeeId: string;
  role: EmployeeRole;
  /** Branches the employee is assigned to. Ignored for super_admin, who can
   * access every branch. */
  branchIds: readonly string[];
}

export function canAccessBranch(actor: Actor, branchId: string): boolean {
  return actor.role === 'super_admin' || actor.branchIds.includes(branchId);
}

export function roleAllowsBookingAction(role: EmployeeRole, action: BookingAction): boolean {
  return ACTION_ROLES[action].includes(role);
}

export type PermissionCheck =
  | { allowed: true }
  | { allowed: false; reason: 'branch_not_allowed' | 'role_not_allowed' };

export function checkBookingActionPermission(
  actor: Actor,
  action: BookingAction,
  bookingBranchId: string,
): PermissionCheck {
  if (!canAccessBranch(actor, bookingBranchId)) {
    return { allowed: false, reason: 'branch_not_allowed' };
  }
  if (!roleAllowsBookingAction(actor.role, action)) {
    return { allowed: false, reason: 'role_not_allowed' };
  }
  return { allowed: true };
}

/**
 * Actions this actor may perform on a booking right now: the intersection of
 * the state machine, the actor's role and their branch assignment.
 */
export function allowedBookingActions(
  actor: Actor,
  status: BookingStatus,
  bookingBranchId: string,
): BookingAction[] {
  if (!canAccessBranch(actor, bookingBranchId)) return [];
  return actionsForStatus(status).filter((action) => roleAllowsBookingAction(actor.role, action));
}

export function isEmployeeRole(value: string): value is EmployeeRole {
  return (EMPLOYEE_ROLES as readonly string[]).includes(value);
}
