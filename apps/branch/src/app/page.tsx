'use client';

import { useCallback, useEffect, useReducer, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  BOOKING_STATUSES,
  type BookingAction,
  type BookingStatus,
  type EmployeeRole,
} from '@foot-repose/domain';
import { ApiError, apiClient } from '@foot-repose/contracts/client';
import type { BookingDto, EmployeeProfile } from '@foot-repose/contracts';
import {
  boardReducer,
  initialBoardState,
  requestFor,
  shownDate as shownDateOf,
  visibleBoard,
} from '../lib/board-navigation';

const STATUS_LABELS: Record<BookingStatus, string> = {
  confirmed: 'Confirmed',
  checked_in: 'Checked in',
  in_service: 'In service',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No show',
};

const ACTION_LABELS: Record<BookingAction, string> = {
  check_in: 'Check in',
  start_service: 'Start service',
  complete: 'Complete',
  cancel: 'Cancel',
  mark_no_show: 'No show',
};

const ROLE_LABELS: Record<EmployeeRole, string> = {
  super_admin: 'Super admin',
  branch_manager: 'Branch manager',
  staff: 'Staff',
};

const DESTRUCTIVE_ACTIONS: ReadonlySet<BookingAction> = new Set(['cancel', 'mark_no_show']);

export default function BoardPage() {
  const router = useRouter();
  const [profile, setProfile] = useState<EmployeeProfile | null>(null);
  /** Navigation intent, request identity and committed response — one machine,
   * so a click folds on the click before it instead of on the last response. */
  const [state, dispatch] = useReducer(boardReducer, undefined, () => initialBoardState());
  const [q, setQ] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  /** A refused transition, kept apart from the board request's own error so one
   * cannot silently stand in for the other. */
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const { branchId, statusFilter, generation, targetDate, query, loading, error, authRequired } =
    state;

  const toLogin = useCallback(async (): Promise<void> => {
    // Clear the (stale) cookie first, or the middleware bounces us back.
    await apiClient.logout().catch(() => undefined);
    router.replace('/login');
  }, [router]);

  useEffect(() => {
    let cancelled = false;
    apiClient
      .me()
      .then((me) => {
        if (cancelled) return;
        setProfile(me);
        dispatch({ type: 'branch', branchId: me.branches[0]?.id ?? '' });
      })
      .catch(() => {
        if (!cancelled) void toLogin();
      });
    return () => {
      cancelled = true;
    };
  }, [toLogin]);

  useEffect(() => {
    const timer = setTimeout(() => dispatch({ type: 'query', query: q.trim() }), 300);
    return () => clearTimeout(timer);
  }, [q]);

  /**
   * One request per generation. The generation is captured here and quoted back
   * on the way in, so the reducer — not the order the network happens to answer
   * in — decides which response is allowed to land. Aborting a superseded
   * request is a saving, not the guarantee: a response can arrive in the same
   * instant the abort is signalled, and the generation check still refuses it.
   */
  useEffect(() => {
    if (!branchId) return undefined;
    const controller = new AbortController();
    const params = requestFor(state);
    apiClient
      .listBookings(
        params.branchId,
        { date: params.date, status: params.status, q: params.q },
        controller.signal,
      )
      .then((data) => dispatch({ type: 'loaded', generation, data }))
      .catch((failure: unknown) => {
        // A request this component itself superseded is never a user-facing
        // error, so it is not reported at all.
        if (controller.signal.aborted) return;
        if (failure instanceof ApiError && failure.status === 401) {
          // Dispatched, never called from here: signing the user out is an
          // external side effect, and only the CURRENT request may cause one.
          dispatch({ type: 'unauthorized', generation });
          return;
        }
        dispatch({
          type: 'failed',
          generation,
          message: failure instanceof ApiError ? failure.message : 'Failed to load bookings',
        });
      });
    return () => controller.abort();
    // `generation` changes on every navigation, filter change and refresh; the
    // rest are listed because they are read above and are stable between bumps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [generation, branchId, targetDate, statusFilter, query]);

  /** The one place the board hands over to the login flow, driven by state the
   * reducer accepted — so it runs once, and only for the current request. */
  useEffect(() => {
    if (authRequired) void toLogin();
  }, [authRequired, toLogin]);

  const runAction = useCallback(
    async (booking: BookingDto, action: BookingAction): Promise<void> => {
      if (
        DESTRUCTIVE_ACTIONS.has(action) &&
        !window.confirm(`${ACTION_LABELS[action]} — ${booking.customer.fullName}?`)
      ) {
        return;
      }
      setBusyId(booking.id);
      try {
        const { booking: updated } = await apiClient.transition(booking.id, action);
        dispatch({ type: 'booking', booking: updated });
        setActionNotice(null);
      } catch (failure) {
        setActionNotice(failure instanceof ApiError ? failure.message : 'Action failed');
        if (failure instanceof ApiError && failure.status === 401) {
          void toLogin();
          return;
        }
        // The board may be stale after a 409/403: reload it, and let that
        // request's own outcome speak.
        dispatch({ type: 'reload' });
      } finally {
        setBusyId(null);
      }
    },
    [toLogin],
  );

  if (!profile) {
    return (
      <main className="page-center">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  if (profile.branches.length === 0) {
    return (
      <main className="page-center">
        <div className="card login-card">
          <div className="brand login-brand">
            <span className="brand-mark">FR</span>
            <div>
              <strong>Foot Repose</strong>
              <span className="brand-sub">Branch board</span>
            </div>
          </div>
          <p>
            <strong>No branch assigned</strong>
          </p>
          <p className="muted">
            Your account ({profile.employee.email}) has no branch assignment yet. Ask your branch
            manager or HQ to assign you to a branch, then sign in again.
          </p>
          <button
            className="btn ghost wide"
            onClick={() => {
              void apiClient
                .logout()
                .catch(() => undefined)
                .then(() => router.replace('/login'));
            }}
          >
            Sign out
          </button>
        </div>
      </main>
    );
  }

  // Intent first, response second — the reverse of this line is the defect.
  const shownDate = shownDateOf(state);
  // Null while the label names a day (or branch) the committed data does not,
  // so cards are never shown under a date they do not belong to.
  const board = visibleBoard(state);
  const notice = error ?? actionNotice;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">FR</span>
          <div>
            <strong>Foot Repose</strong>
            <span className="brand-sub">Branch board</span>
          </div>
        </div>
        {profile.branches.length > 1 ? (
          <select
            className="input"
            aria-label="Branch"
            value={branchId}
            onChange={(event) => dispatch({ type: 'branch', branchId: event.target.value })}
          >
            {profile.branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </select>
        ) : (
          <span className="chip">{profile.branches[0]?.name ?? 'No branch assigned'}</span>
        )}
        <div className="topbar-right">
          <div className="user">
            <strong>{profile.employee.fullName}</strong>
            <span className="muted">{ROLE_LABELS[profile.employee.role]}</span>
          </div>
          <button
            className="btn ghost"
            onClick={() => {
              void apiClient
                .logout()
                .catch(() => undefined)
                .then(() => router.replace('/login'));
            }}
          >
            Sign out
          </button>
        </div>
      </header>

      <main className="content">
        <section className="toolbar" aria-label="Filters">
          <button
            className="btn ghost"
            aria-label="Previous day"
            // Disabled only until the server has named a first day — never
            // while a request is in flight, because rapid stepping is the
            // point. Each click folds on the last INTENT, not the last response.
            disabled={!shownDate}
            onClick={() => dispatch({ type: 'step', days: -1 })}
          >
            ‹
          </button>
          <span className="date-label">{shownDate ?? '…'}</span>
          <button
            className="btn ghost"
            aria-label="Next day"
            disabled={!shownDate}
            onClick={() => dispatch({ type: 'step', days: 1 })}
          >
            ›
          </button>
          <button className="btn ghost" onClick={() => dispatch({ type: 'today' })}>
            Today
          </button>
          <input
            className="input search"
            type="search"
            placeholder="Search customer name or phone"
            aria-label="Search bookings"
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <select
            className="input"
            aria-label="Status filter"
            value={statusFilter}
            onChange={(event) =>
              dispatch({ type: 'status', status: event.target.value as BookingStatus | '' })
            }
          >
            <option value="">All statuses</option>
            {BOOKING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          <button className="btn ghost" onClick={() => dispatch({ type: 'reload' })}>
            Refresh
          </button>
        </section>

        {notice && (
          <p className="notice" role="alert">
            {notice}
          </p>
        )}

        {!board && loading ? (
          <p className="muted">Loading bookings…</p>
        ) : !board || board.bookings.length === 0 ? (
          <div className="empty">
            <p>No bookings match this day and filters.</p>
          </div>
        ) : (
          <ul className="bookings">
            {board.bookings.map((booking) => (
              <li key={booking.id} className="booking-card" data-booking-id={booking.id}>
                <div className="time">
                  <strong>{booking.startTimeLocal}</strong>
                  <span>– {booking.endTimeLocal}</span>
                </div>
                <div className="who">
                  <strong>{booking.customer.fullName}</strong>
                  <span className="muted">{booking.customer.phone}</span>
                </div>
                <div className="what">
                  <strong>{booking.service.name}</strong>
                  <span className="muted">
                    {booking.service.durationMin} min · {booking.priceFormatted}
                  </span>
                </div>
                <div className="therapist">
                  <span className="muted">Therapist</span>
                  <strong>{booking.assignedEmployee?.fullName ?? 'Unassigned'}</strong>
                </div>
                <span className={`status status-${booking.status}`}>
                  {STATUS_LABELS[booking.status]}
                </span>
                <div className="actions">
                  {booking.allowedActions.map((action) => (
                    <button
                      key={action}
                      className={`btn ${DESTRUCTIVE_ACTIONS.has(action) ? 'danger' : 'primary'}`}
                      disabled={busyId === booking.id}
                      onClick={() => void runAction(booking, action)}
                    >
                      {ACTION_LABELS[action]}
                    </button>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        )}

        <p className="board-footer">
          {board ? `${board.bookings.length} bookings · ${board.branch.name}` : ''} · times shown in
          Asia/Muscat · amounts in OMR
        </p>
      </main>
    </div>
  );
}
