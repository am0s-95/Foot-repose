import { describe, expect, it } from 'vitest';
import {
  allowedBookingActions,
  canAccessBranch,
  checkBookingActionPermission,
  roleAllowsBookingAction,
  type Actor,
} from '../src/index';

const BRANCH_A = 'branch-a';
const BRANCH_B = 'branch-b';

const staffA: Actor = { employeeId: 'e1', role: 'staff', branchIds: [BRANCH_A] };
const managerA: Actor = { employeeId: 'e2', role: 'branch_manager', branchIds: [BRANCH_A] };
const superAdmin: Actor = { employeeId: 'e3', role: 'super_admin', branchIds: [] };

describe('branch access', () => {
  it('staff and managers can only access assigned branches', () => {
    expect(canAccessBranch(staffA, BRANCH_A)).toBe(true);
    expect(canAccessBranch(staffA, BRANCH_B)).toBe(false);
    expect(canAccessBranch(managerA, BRANCH_B)).toBe(false);
  });

  it('super_admin can access every branch', () => {
    expect(canAccessBranch(superAdmin, BRANCH_A)).toBe(true);
    expect(canAccessBranch(superAdmin, BRANCH_B)).toBe(true);
  });
});

describe('booking action permissions', () => {
  it('staff can run the operational flow but not cancel or no-show', () => {
    expect(roleAllowsBookingAction('staff', 'check_in')).toBe(true);
    expect(roleAllowsBookingAction('staff', 'start_service')).toBe(true);
    expect(roleAllowsBookingAction('staff', 'complete')).toBe(true);
    expect(roleAllowsBookingAction('staff', 'cancel')).toBe(false);
    expect(roleAllowsBookingAction('staff', 'mark_no_show')).toBe(false);
  });

  it('managers and super_admin can cancel and mark no-shows', () => {
    expect(roleAllowsBookingAction('branch_manager', 'cancel')).toBe(true);
    expect(roleAllowsBookingAction('branch_manager', 'mark_no_show')).toBe(true);
    expect(roleAllowsBookingAction('super_admin', 'cancel')).toBe(true);
    expect(roleAllowsBookingAction('super_admin', 'mark_no_show')).toBe(true);
  });

  it('denies with branch_not_allowed before role_not_allowed', () => {
    expect(checkBookingActionPermission(staffA, 'cancel', BRANCH_B)).toEqual({
      allowed: false,
      reason: 'branch_not_allowed',
    });
    expect(checkBookingActionPermission(staffA, 'cancel', BRANCH_A)).toEqual({
      allowed: false,
      reason: 'role_not_allowed',
    });
    expect(checkBookingActionPermission(managerA, 'cancel', BRANCH_A)).toEqual({ allowed: true });
  });
});

describe('allowedBookingActions', () => {
  it('intersects state machine, role and branch assignment', () => {
    expect(allowedBookingActions(staffA, 'confirmed', BRANCH_A)).toEqual(['check_in']);
    expect(allowedBookingActions(managerA, 'confirmed', BRANCH_A).sort()).toEqual([
      'cancel',
      'check_in',
      'mark_no_show',
    ]);
    expect(allowedBookingActions(staffA, 'confirmed', BRANCH_B)).toEqual([]);
    expect(allowedBookingActions(superAdmin, 'checked_in', BRANCH_B).sort()).toEqual([
      'cancel',
      'start_service',
    ]);
    expect(allowedBookingActions(managerA, 'completed', BRANCH_A)).toEqual([]);
  });
});
