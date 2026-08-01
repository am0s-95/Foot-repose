import { describe, expect, it } from 'vitest';
import type { BookingsListResponse } from '@foot-repose/contracts';
import {
  boardReducer,
  initialBoardState,
  requestFor,
  shownDate,
  visibleBoard,
  type BoardAction,
  type BoardState,
} from '../src/lib/board-navigation';

/**
 * The board's navigation machine.
 *
 * These are the cases a browser cannot exhaust cheaply — twenty-five clicks,
 * every calendar boundary, every stale-arrival ordering. The browser proof in
 * `e2e/branch-board-rapid-navigation.spec.ts` shows the real component actually
 * dispatches this machine; here the machine itself is pinned down.
 *
 * Rapid clicking is modelled the way React models it: a fold of actions over
 * the state each previous action produced, with NO response in between. That is
 * exactly the situation the old code got wrong, because it read the last loaded
 * response instead of the previous intent.
 */

const BRANCH_A = '00000000-0000-4000-8000-00000000000a';
const BRANCH_B = '00000000-0000-4000-8000-00000000000b';

const SERVICE_ID = '00000000-0000-4000-8000-000000000002';
const CUSTOMER_ID = '00000000-0000-4000-8000-000000000003';

function response(date: string, branchId = BRANCH_A, count = 1): BookingsListResponse {
  return {
    branch: { id: branchId, code: `B${branchId.slice(-1)}`, name: `Branch ${branchId.slice(-1)}`, area: 'Muscat' },
    date,
    bookings: Array.from({ length: count }, (_, index) => ({
      id: `00000000-0000-4000-8000-00000000${String(index).padStart(4, '0')}`,
      branchId,
      status: 'confirmed' as const,
      startsAt: `${date}T06:00:00.000Z`,
      endsAt: `${date}T06:45:00.000Z`,
      startTimeLocal: '10:00',
      endTimeLocal: '10:45',
      priceBaisa: 8500,
      priceFormatted: 'OMR 8.500',
      currency: 'OMR' as const,
      notes: null,
      service: {
        id: SERVICE_ID,
        name: `Day ${date}`,
        durationMin: 45,
        bufferBeforeMin: 0,
        bufferAfterMin: 10,
      },
      customer: { id: CUSTOMER_ID, fullName: 'Fictional Customer', phone: '+968 24000000' },
      assignedEmployee: null,
      allowedActions: [],
    })),
  };
}

const fold = (state: BoardState, actions: BoardAction[]): BoardState =>
  actions.reduce(boardReducer, state);

/** A board sitting on `date`, with that day's response committed. */
function settledOn(date: string): BoardState {
  const started = boardReducer(initialBoardState(), { type: 'branch', branchId: BRANCH_A });
  return boardReducer(started, {
    type: 'loaded',
    generation: started.generation,
    data: response(date),
  });
}

const step = (days: number): BoardAction => ({ type: 'step', days });
const nextTimes = (n: number): BoardAction[] => Array.from({ length: n }, () => step(1));
const prevTimes = (n: number): BoardAction[] => Array.from({ length: n }, () => step(-1));

describe('[NAV] rapid clicks accumulate exactly', () => {
  it('[NAV-1] eleven next clicks with nothing loading in between are eleven days', () => {
    const after = fold(settledOn('2026-08-01'), nextTimes(11));
    expect(shownDate(after)).toBe('2026-08-12');
    // ...and every one of them asked for a new request.
    expect(after.generation).toBe(settledOn('2026-08-01').generation + 11);
  });

  it('[NAV-2] seven previous clicks are seven days back', () => {
    expect(shownDate(fold(settledOn('2026-08-10'), prevTimes(7)))).toBe('2026-08-03');
  });

  it('[NAV-3] a mixed sequence keeps its exact net intent', () => {
    const after = fold(settledOn('2026-08-01'), [
      step(1),
      step(1),
      step(1),
      step(-1),
      step(-1),
      step(1),
    ]);
    expect(shownDate(after)).toBe('2026-08-03');
  });

  it('[NAV-4] twenty-five clicks lose nothing', () => {
    expect(shownDate(fold(settledOn('2026-08-01'), nextTimes(25)))).toBe('2026-08-26');
    expect(shownDate(fold(settledOn('2026-08-01'), prevTimes(25)))).toBe('2026-07-07');
  });

  it('[NAV-5/6/7] month, year and leap boundaries are the domain helper, not local Date math', () => {
    expect(shownDate(fold(settledOn('2026-01-31'), nextTimes(1)))).toBe('2026-02-01');
    expect(shownDate(fold(settledOn('2026-12-31'), nextTimes(1)))).toBe('2027-01-01');
    // 2028 is a leap year: the 29th exists and must be stepped through, not over.
    const leap = fold(settledOn('2028-02-28'), nextTimes(2));
    expect(shownDate(fold(settledOn('2028-02-28'), nextTimes(1)))).toBe('2028-02-29');
    expect(shownDate(leap)).toBe('2028-03-01');
    // 2027 is not: February has 28 days.
    expect(shownDate(fold(settledOn('2027-02-28'), nextTimes(1)))).toBe('2027-03-01');
    // Rapid clicking across a month end is the same arithmetic.
    expect(shownDate(fold(settledOn('2026-12-28'), nextTimes(11)))).toBe('2027-01-08');
  });

  it('[NAV-16] a single click still moves exactly one day', () => {
    expect(shownDate(boardReducer(settledOn('2026-08-01'), step(1)))).toBe('2026-08-02');
    expect(shownDate(boardReducer(settledOn('2026-08-01'), step(-1)))).toBe('2026-07-31');
  });

  it('refuses to step before the server has named a day, and the control is disabled then', () => {
    const fresh = boardReducer(initialBoardState(), { type: 'branch', branchId: BRANCH_A });
    expect(shownDate(fresh)).toBeUndefined();
    const clicked = fold(fresh, nextTimes(3));
    expect(shownDate(clicked)).toBeUndefined();
    expect(clicked.generation).toBe(fresh.generation); // no wasted requests
  });

  it('the first step away from "today" uses the resolved day, and never consults it again', () => {
    const settled = settledOn('2026-08-01');
    const once = boardReducer(settled, step(1));
    expect(shownDate(once)).toBe('2026-08-02');
    // A response for the OLD day arriving now must not drag the target back.
    const late = boardReducer(once, {
      type: 'loaded',
      generation: settled.generation,
      data: response('2026-08-01'),
    });
    expect(shownDate(late)).toBe('2026-08-02');
    expect(shownDate(fold(late, nextTimes(2)))).toBe('2026-08-04');
  });

  it('"Today" hands the day back to the server', () => {
    const after = boardReducer(fold(settledOn('2026-08-01'), nextTimes(3)), { type: 'today' });
    expect(after.targetDate).toBeUndefined();
    expect(requestFor(after).date).toBeUndefined();
  });
});

describe('[NAV] only the newest request may commit', () => {
  it('[NAV-8/9] an older success cannot overwrite a newer one', () => {
    const settled = settledOn('2026-08-01');
    const secondDay = boardReducer(settled, step(1)); // generation g+1
    const thirdDay = boardReducer(secondDay, step(1)); // generation g+2

    const newestFirst = boardReducer(thirdDay, {
      type: 'loaded',
      generation: thirdDay.generation,
      data: response('2026-08-03', BRANCH_A, 3),
    });
    expect(visibleBoard(newestFirst)?.date).toBe('2026-08-03');

    // The older answer, arriving late.
    const stale = boardReducer(newestFirst, {
      type: 'loaded',
      generation: secondDay.generation,
      data: response('2026-08-02', BRANCH_A, 9),
    });
    expect(visibleBoard(stale)?.date).toBe('2026-08-03');
    expect(visibleBoard(stale)?.bookings).toHaveLength(3);
    expect(shownDate(stale)).toBe('2026-08-03');
    expect(stale.loading).toBe(false);
    expect(stale.error).toBeNull();
  });

  it('[NAV-10] an older failure cannot replace a newer success or a newer pending state', () => {
    const settled = settledOn('2026-08-01');
    const older = boardReducer(settled, step(1));
    const newer = boardReducer(older, step(1));

    const succeeded = boardReducer(newer, {
      type: 'loaded',
      generation: newer.generation,
      data: response('2026-08-03'),
    });
    const afterStaleFailure = boardReducer(succeeded, {
      type: 'failed',
      generation: older.generation,
      message: 'Boom',
    });
    expect(afterStaleFailure.error).toBeNull();
    expect(visibleBoard(afterStaleFailure)?.date).toBe('2026-08-03');

    // ...and it cannot end a newer request's loading state either.
    const stillPending = boardReducer(newer, {
      type: 'failed',
      generation: older.generation,
      message: 'Boom',
    });
    expect(stillPending.loading).toBe(true);
    expect(stillPending.error).toBeNull();
  });

  it('[NAV-13/14] the newest failure is reported, and navigation still works afterwards', () => {
    const pending = boardReducer(settledOn('2026-08-01'), step(1));
    const failed = boardReducer(pending, {
      type: 'failed',
      generation: pending.generation,
      message: 'Failed to load bookings',
    });
    expect(failed.error).toBe('Failed to load bookings');
    expect(failed.loading).toBe(false);
    // The target does not jump back, and the next click still steps from it.
    expect(shownDate(failed)).toBe('2026-08-02');
    const recovered = boardReducer(failed, step(1));
    expect(shownDate(recovered)).toBe('2026-08-03');
    expect(recovered.error).toBeNull(); // superseded error cleared
    expect(recovered.loading).toBe(true);
  });

  it('[NAV-AUTH-1] a stale unauthorized outcome cannot sign anyone out', () => {
    const settled = settledOn('2026-08-01');
    const older = boardReducer(settled, step(1)); // generation N
    const newer = boardReducer(older, step(1)); // generation N+1

    // The older request's 401 settles after the newer navigation was dispatched.
    const ignored = boardReducer(newer, { type: 'unauthorized', generation: older.generation });
    expect(ignored.authRequired).toBe(false);
    expect(ignored).toBe(newer); // nothing about the newer request moved
    expect(ignored.loading).toBe(true);

    // ...and the newer request still lands normally afterwards.
    const landed = boardReducer(ignored, {
      type: 'loaded',
      generation: newer.generation,
      data: response('2026-08-03'),
    });
    expect(landed.authRequired).toBe(false);
    expect(visibleBoard(landed)?.date).toBe('2026-08-03');
  });

  it('[NAV-AUTH-2] the CURRENT unauthorized outcome hands over exactly once', () => {
    const pending = boardReducer(settledOn('2026-08-01'), step(1));
    const unauthorized = boardReducer(pending, {
      type: 'unauthorized',
      generation: pending.generation,
    });
    expect(unauthorized.authRequired).toBe(true);
    expect(unauthorized.loading).toBe(false);
    // It is a flag, not an event: repeating it changes nothing, so the effect
    // that watches it cannot fire twice.
    const again = boardReducer(unauthorized, {
      type: 'unauthorized',
      generation: unauthorized.generation,
    });
    expect(again.authRequired).toBe(true);
    expect(again).toEqual(unauthorized);
  });

  it('[NAV-AUTH-3] starting a newer request supersedes a prior unauthorized state', () => {
    const pending = boardReducer(settledOn('2026-08-01'), step(1));
    const unauthorized = boardReducer(pending, {
      type: 'unauthorized',
      generation: pending.generation,
    });
    for (const action of [
      step(1),
      { type: 'today' } as const,
      { type: 'reload' } as const,
      { type: 'branch', branchId: BRANCH_B } as const,
      { type: 'status', status: 'completed' } as const,
    ]) {
      expect(boardReducer(unauthorized, action).authRequired).toBe(false);
    }
  });

  it('[NAV-AUTH-4] a stale unauthorized outcome cannot erase a newer success either', () => {
    const settled = settledOn('2026-08-01');
    const older = boardReducer(settled, step(1));
    const newer = boardReducer(older, step(1));
    const succeeded = boardReducer(newer, {
      type: 'loaded',
      generation: newer.generation,
      data: response('2026-08-03'),
    });
    const afterStale401 = boardReducer(succeeded, {
      type: 'unauthorized',
      generation: older.generation,
    });
    expect(afterStale401.authRequired).toBe(false);
    expect(visibleBoard(afterStale401)?.date).toBe('2026-08-03');
    expect(shownDate(afterStale401)).toBe('2026-08-03');
  });

  it('[NAV-11] changing branch invalidates the former branch response', () => {
    const settled = settledOn('2026-08-01');
    const switched = boardReducer(settled, { type: 'branch', branchId: BRANCH_B });

    // Branch A's cards are no longer current the instant the branch changes.
    expect(visibleBoard(switched)).toBeNull();

    // Branch A's in-flight response arrives late: it must not commit.
    const stale = boardReducer(switched, {
      type: 'loaded',
      generation: settled.generation,
      data: response('2026-08-01', BRANCH_A),
    });
    expect(visibleBoard(stale)).toBeNull();

    const fresh = boardReducer(stale, {
      type: 'loaded',
      generation: switched.generation,
      data: response('2026-08-01', BRANCH_B),
    });
    expect(visibleBoard(fresh)?.branch.id).toBe(BRANCH_B);
  });
});

describe('[NAV] the label and the cards always describe the same response', () => {
  it('[NAV-15] cards are withheld while the label names a day they do not belong to', () => {
    const settled = settledOn('2026-08-01');
    expect(visibleBoard(settled)?.date).toBe('2026-08-01');

    const moved = fold(settled, nextTimes(4));
    expect(shownDate(moved)).toBe('2026-08-05');
    expect(visibleBoard(moved)).toBeNull(); // never 08-01's cards under 08-05

    const landed = boardReducer(moved, {
      type: 'loaded',
      generation: moved.generation,
      data: response('2026-08-05'),
    });
    expect(visibleBoard(landed)?.date).toBe(shownDate(landed));
  });

  it('a filter change does not hide the cards, because the day has not moved', () => {
    const filtered = boardReducer(settledOn('2026-08-01'), {
      type: 'status',
      status: 'confirmed',
    });
    expect(visibleBoard(filtered)?.date).toBe('2026-08-01');
    expect(requestFor(filtered).status).toBe('confirmed');
    expect(filtered.loading).toBe(true);
  });

  it('a transition patches the committed board without disturbing the request identity', () => {
    const settled = settledOn('2026-08-01');
    const target = visibleBoard(settled)!.bookings[0]!;
    const patched = boardReducer(settled, {
      type: 'booking',
      booking: { ...target, status: 'checked_in' },
    });
    expect(visibleBoard(patched)!.bookings[0]!.status).toBe('checked_in');
    expect(patched.generation).toBe(settled.generation);
    expect(patched.loading).toBe(settled.loading);
  });

  it('requestFor sends only what the API needs, and omits empty filters', () => {
    const settled = settledOn('2026-08-01');
    expect(requestFor(settled)).toEqual({
      branchId: BRANCH_A,
      date: undefined,
      status: undefined,
      q: undefined,
    });
    const busy = fold(settled, [
      step(2),
      { type: 'status', status: 'completed' },
      { type: 'query', query: 'ali' },
    ]);
    expect(requestFor(busy)).toEqual({
      branchId: BRANCH_A,
      date: '2026-08-03',
      status: 'completed',
      q: 'ali',
    });
  });

  it('repeating a no-op action starts no request', () => {
    const settled = settledOn('2026-08-01');
    for (const action of [
      { type: 'branch', branchId: BRANCH_A } as const,
      { type: 'status', status: '' } as const,
      { type: 'query', query: '' } as const,
      { type: 'today' } as const,
    ]) {
      expect(boardReducer(settled, action).generation).toBe(settled.generation);
    }
    // Refresh always starts one, even though nothing changed.
    expect(boardReducer(settled, { type: 'reload' }).generation).toBe(settled.generation + 1);
  });
});
