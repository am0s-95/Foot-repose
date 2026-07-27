import { describe, expect, it } from 'vitest';
import {
  BOOKING_ACTIONS,
  BOOKING_STATUSES,
  actionsForStatus,
  canTransition,
  isTerminalStatus,
  nextStatus,
} from '../src/index';

describe('booking state machine', () => {
  it('follows the happy path confirmed → checked_in → in_service → completed', () => {
    expect(nextStatus('confirmed', 'check_in')).toBe('checked_in');
    expect(nextStatus('checked_in', 'start_service')).toBe('in_service');
    expect(nextStatus('in_service', 'complete')).toBe('completed');
  });

  it('allows cancel from confirmed and checked_in only', () => {
    expect(nextStatus('confirmed', 'cancel')).toBe('cancelled');
    expect(nextStatus('checked_in', 'cancel')).toBe('cancelled');
    expect(nextStatus('in_service', 'cancel')).toBeNull();
  });

  it('allows no-show from confirmed only', () => {
    expect(nextStatus('confirmed', 'mark_no_show')).toBe('no_show');
    expect(nextStatus('checked_in', 'mark_no_show')).toBeNull();
    expect(nextStatus('in_service', 'mark_no_show')).toBeNull();
  });

  it('rejects skipping steps', () => {
    expect(canTransition('confirmed', 'start_service')).toBe(false);
    expect(canTransition('confirmed', 'complete')).toBe(false);
    expect(canTransition('checked_in', 'complete')).toBe(false);
  });

  it('rejects repeating an already-performed step', () => {
    expect(canTransition('checked_in', 'check_in')).toBe(false);
    expect(canTransition('in_service', 'start_service')).toBe(false);
    expect(canTransition('completed', 'complete')).toBe(false);
  });

  it('treats completed, cancelled and no_show as terminal', () => {
    for (const status of ['completed', 'cancelled', 'no_show'] as const) {
      expect(isTerminalStatus(status)).toBe(true);
      for (const action of BOOKING_ACTIONS) {
        expect(canTransition(status, action)).toBe(false);
      }
    }
  });

  it('exposes available actions per status', () => {
    expect(actionsForStatus('confirmed').sort()).toEqual(['cancel', 'check_in', 'mark_no_show']);
    expect(actionsForStatus('checked_in').sort()).toEqual(['cancel', 'start_service']);
    expect(actionsForStatus('in_service')).toEqual(['complete']);
    expect(actionsForStatus('completed')).toEqual([]);
  });

  it('only ever transitions into known statuses', () => {
    for (const status of BOOKING_STATUSES) {
      for (const action of BOOKING_ACTIONS) {
        const next = nextStatus(status, action);
        if (next !== null) expect(BOOKING_STATUSES).toContain(next);
      }
    }
  });
});
