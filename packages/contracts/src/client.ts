import type { BookingAction } from '@foot-repose/domain';
import type {
  ApiErrorBody,
  BookingsListResponse,
  EmployeeProfile,
  LoginRequest,
  TransitionResponse,
} from './index';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** Same-origin fetch wrapper. Frontends proxy /api/* to the shared API, so
 * session cookies flow automatically. */
async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    const parsed = body as Partial<ApiErrorBody> | null;
    throw new ApiError(
      response.status,
      parsed?.error?.code ?? 'internal_error',
      parsed?.error?.message ?? `Request failed with status ${response.status}`,
    );
  }
  return body as T;
}

export const apiClient = {
  login: (input: LoginRequest) =>
    request<EmployeeProfile>('/api/auth/login', { method: 'POST', body: JSON.stringify(input) }),
  logout: () => request<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
  me: () => request<EmployeeProfile>('/api/auth/me'),
  /**
   * `signal` lets a caller drop a board request it has already superseded —
   * rapid day navigation issues one per click. It is a courtesy only: a request
   * can still complete in the instant the abort is signalled, so the caller must
   * also decide for itself which response is allowed to win.
   */
  listBookings: (
    branchId: string,
    params: { date?: string; status?: string; q?: string } = {},
    signal?: AbortSignal,
  ) => {
    const search = new URLSearchParams();
    if (params.date) search.set('date', params.date);
    if (params.status) search.set('status', params.status);
    if (params.q) search.set('q', params.q);
    const qs = search.toString();
    return request<BookingsListResponse>(
      `/api/branches/${branchId}/bookings${qs ? `?${qs}` : ''}`,
      signal ? { signal } : undefined,
    );
  },
  transition: (bookingId: string, action: BookingAction) =>
    request<TransitionResponse>(`/api/bookings/${bookingId}/transition`, {
      method: 'POST',
      body: JSON.stringify({ action }),
    }),
};
