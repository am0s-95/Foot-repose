'use client';

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  addDaysToIsoDate,
  BOOKING_STATUSES,
  type BookingAction,
  type BookingStatus,
  type EmployeeRole,
} from '@foot-repose/domain';
import { ApiError, apiClient } from '@foot-repose/contracts/client';
import type {
  BookingDto,
  BookingsListResponse,
  EmployeeProfile,
} from '@foot-repose/contracts';

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
  const [branchId, setBranchId] = useState('');
  /** undefined = "today", resolved by the server in Asia/Muscat. */
  const [date, setDate] = useState<string | undefined>(undefined);
  const [statusFilter, setStatusFilter] = useState<BookingStatus | ''>('');
  const [q, setQ] = useState('');
  const [debouncedQ, setDebouncedQ] = useState('');
  const [board, setBoard] = useState<BookingsListResponse | null>(null);
  const [loadingBoard, setLoadingBoard] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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
        setBranchId((current) => current || (me.branches[0]?.id ?? ''));
      })
      .catch(() => {
        if (!cancelled) void toLogin();
      });
    return () => {
      cancelled = true;
    };
  }, [toLogin]);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(timer);
  }, [q]);

  const loadBoard = useCallback(async (): Promise<void> => {
    if (!branchId) return;
    setLoadingBoard(true);
    try {
      const data = await apiClient.listBookings(branchId, {
        date,
        status: statusFilter || undefined,
        q: debouncedQ || undefined,
      });
      setBoard(data);
      setNotice(null);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        void toLogin();
        return;
      }
      setNotice(error instanceof ApiError ? error.message : 'Failed to load bookings');
    } finally {
      setLoadingBoard(false);
    }
  }, [branchId, date, statusFilter, debouncedQ, toLogin]);

  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

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
        setBoard((current) =>
          current
            ? {
                ...current,
                bookings: current.bookings.map((b) => (b.id === updated.id ? updated : b)),
              }
            : current,
        );
        setNotice(null);
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          void toLogin();
          return;
        }
        setNotice(error instanceof ApiError ? error.message : 'Action failed');
        void loadBoard(); // board may be stale after a 409/403
      } finally {
        setBusyId(null);
      }
    },
    [loadBoard, toLogin],
  );

  if (!profile) {
    return (
      <main className="page-center">
        <p className="muted">Loading…</p>
      </main>
    );
  }

  const shownDate = board?.date ?? date;

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
            onChange={(event) => setBranchId(event.target.value)}
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
            disabled={!shownDate}
            onClick={() => shownDate && setDate(addDaysToIsoDate(shownDate, -1))}
          >
            ‹
          </button>
          <span className="date-label">{shownDate ?? '…'}</span>
          <button
            className="btn ghost"
            aria-label="Next day"
            disabled={!shownDate}
            onClick={() => shownDate && setDate(addDaysToIsoDate(shownDate, 1))}
          >
            ›
          </button>
          <button className="btn ghost" onClick={() => setDate(undefined)}>
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
            onChange={(event) => setStatusFilter(event.target.value as BookingStatus | '')}
          >
            <option value="">All statuses</option>
            {BOOKING_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          <button className="btn ghost" onClick={() => void loadBoard()}>
            Refresh
          </button>
        </section>

        {notice && (
          <p className="notice" role="alert">
            {notice}
          </p>
        )}

        {!board && loadingBoard ? (
          <p className="muted">Loading bookings…</p>
        ) : !board || board.bookings.length === 0 ? (
          <div className="empty">
            <p>No bookings match this day and filters.</p>
          </div>
        ) : (
          <ul className="bookings">
            {board.bookings.map((booking) => (
              <li key={booking.id} className="booking-card">
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
