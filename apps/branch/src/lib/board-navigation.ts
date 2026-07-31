import { addDaysToIsoDate, type BookingStatus } from '@foot-repose/domain';
import type { BookingDto, BookingsListResponse } from '@foot-repose/contracts';

/**
 * The board's navigation intent and its committed response, kept apart.
 *
 * They used to be the same thing. The day controls computed their next target
 * from `board?.date ?? date` — the LAST LOADED response — so every click issued
 * before that response arrived started from the same day and produced the same
 * target. Measured on the production board with the bookings endpoint held:
 * eleven "next" clicks moved the label zero days and asked the API for exactly
 * one new date. A manager stepping through a week did not get a week.
 *
 * Two rules make it exact, and both are needed:
 *
 *   INTENT — a step is computed from `targetDate`, the value the PREVIOUS action
 *     produced, never from a response and never from a render closure. Because
 *     this is a reducer, N dispatches fold N times whatever is in flight, so N
 *     clicks are N days.
 *   COMMIT — every request carries the `generation` that was current when it
 *     started, and only a response quoting the CURRENT generation may change
 *     anything. An older success, an older failure and an older branch are all
 *     dropped on arrival rather than raced.
 *
 * Cancellation is a courtesy on top of that, not the guarantee: a request can
 * complete in the instant an abort is signalled, so the generation check — not
 * the AbortController — is what decides.
 */

export interface CommittedBoard {
  /** Which request produced this, so nothing older can pretend to be it. */
  generation: number;
  branchId: string;
  date: string;
  data: BookingsListResponse;
}

export interface BoardState {
  branchId: string;
  /**
   * The day the user has asked for. `undefined` means "whatever the server
   * calls today in Asia/Muscat", which is only unknown until the first response
   * names it — the day controls are disabled until then, exactly as before.
   */
  targetDate: string | undefined;
  statusFilter: BookingStatus | '';
  /** The debounced search text actually sent to the API. */
  query: string;
  /** Monotonic. Bumped by everything that makes a new request necessary. */
  generation: number;
  committed: CommittedBoard | null;
  loading: boolean;
  error: string | null;
}

export type BoardAction =
  | { type: 'branch'; branchId: string }
  | { type: 'step'; days: number }
  | { type: 'today' }
  | { type: 'status'; status: BookingStatus | '' }
  | { type: 'query'; query: string }
  | { type: 'reload' }
  | { type: 'loaded'; generation: number; data: BookingsListResponse }
  | { type: 'failed'; generation: number; message: string }
  | { type: 'booking'; booking: BookingDto };

export function initialBoardState(branchId = ''): BoardState {
  return {
    branchId,
    targetDate: undefined,
    statusFilter: '',
    query: '',
    generation: 0,
    committed: null,
    loading: true,
    error: null,
  };
}

/** Start a new request: bump the generation, and clear the error that belonged
 * to the request being superseded. */
function requesting(state: BoardState, changes: Partial<BoardState>): BoardState {
  return { ...state, ...changes, generation: state.generation + 1, loading: true, error: null };
}

export function boardReducer(state: BoardState, action: BoardAction): BoardState {
  switch (action.type) {
    case 'branch':
      if (action.branchId === state.branchId) return state;
      // The pending request for the old branch keeps its old generation, so it
      // can no longer commit — and its cards stop being current immediately.
      return requesting(state, { branchId: action.branchId });

    case 'step': {
      // The ONLY place a step is computed. `targetDate` first: the response is
      // consulted solely for the very first step away from the server's today,
      // when there is no target yet. Every later step folds on the previous one.
      const from = state.targetDate ?? state.committed?.date;
      if (from === undefined) return state;
      return requesting(state, { targetDate: addDaysToIsoDate(from, action.days) });
    }

    case 'today':
      if (state.targetDate === undefined) return state;
      return requesting(state, { targetDate: undefined });

    case 'status':
      if (action.status === state.statusFilter) return state;
      return requesting(state, { statusFilter: action.status });

    case 'query':
      if (action.query === state.query) return state;
      return requesting(state, { query: action.query });

    case 'reload':
      return requesting(state, {});

    case 'loaded':
      if (action.generation !== state.generation) return state; // superseded
      return {
        ...state,
        committed: {
          generation: action.generation,
          branchId: state.branchId,
          date: action.data.date,
          data: action.data,
        },
        loading: false,
        error: null,
      };

    case 'failed':
      if (action.generation !== state.generation) return state; // superseded
      return { ...state, loading: false, error: action.message };

    case 'booking': {
      // A transition result patches the committed board in place. It is not a
      // navigation event and must not disturb the generation.
      const committed = state.committed;
      if (!committed) return state;
      return {
        ...state,
        committed: {
          ...committed,
          data: {
            ...committed.data,
            bookings: committed.data.bookings.map((booking) =>
              booking.id === action.booking.id ? action.booking : booking,
            ),
          },
        },
      };
    }

    default:
      return state;
  }
}

/** The date on the label: what the user asked for, falling back to what the
 * server resolved when they have not asked for anything yet. */
export function shownDate(state: BoardState): string | undefined {
  return state.targetDate ?? state.committed?.date;
}

/**
 * The response that may be rendered right now — `null` when the committed data
 * belongs to a different branch or a different day from the one on the label.
 *
 * This is what keeps the promise that cards never sit under a date they do not
 * belong to. A filter change does not hide them: the label still names the same
 * day, so the old cards remain honest until the narrower answer arrives.
 */
export function visibleBoard(state: BoardState): BookingsListResponse | null {
  const committed = state.committed;
  if (committed === null) return null;
  if (committed.branchId !== state.branchId) return null;
  const shown = shownDate(state);
  if (shown !== undefined && committed.date !== shown) return null;
  return committed.data;
}

/** The parameters the effect should request for the current generation. */
export function requestFor(state: BoardState): {
  branchId: string;
  date?: string;
  status?: string;
  q?: string;
} {
  return {
    branchId: state.branchId,
    date: state.targetDate,
    status: state.statusFilter || undefined,
    q: state.query || undefined,
  };
}
