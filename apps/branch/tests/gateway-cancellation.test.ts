import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET, POST } from '../src/app/api/[...path]/route';

/**
 * [T2-D] A caller that has already gone gets no upstream request at all.
 *
 * The end-to-end tests destroy a real socket mid-flight, which proves the
 * gateway REACTS to a disconnect. They cannot easily produce the other case: a
 * request that arrives already cancelled, where the correct amount of upstream
 * work is none. That is a question about the handler's first decision, so it is
 * asked of the handler directly — no artifact, no sockets, and therefore no
 * ambiguity about whether the upstream simply had not been reached yet.
 *
 * The destination points at a port nothing listens on, so if the guard ever
 * regressed the test would not merely fail — the attempt itself would be
 * visible as a connection error rather than as a silent pass.
 */
const NOWHERE = 'http://127.0.0.1:4299';

/** Return type is inferred deliberately: naming vitest's `MockInstance` shape
 * for an overloaded global like `fetch` costs more than it explains. */
function watchFetch() {
  return vi.spyOn(globalThis, 'fetch');
}

describe('[T2] an already-cancelled caller starts no upstream work', () => {
  let fetchSpy: ReturnType<typeof watchFetch>;

  beforeEach(() => {
    process.env.API_URL = NOWHERE;
    delete process.env.API_UPSTREAM_TIMEOUT_MS;
    fetchSpy = watchFetch();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    delete process.env.API_URL;
  });

  const cancelled = (url: string, method = 'GET'): Request => {
    const controller = new AbortController();
    controller.abort();
    return new Request(url, { signal: controller.signal, method });
  };

  it('never opens the upstream request', async () => {
    const request = cancelled('http://branch.test/api/auth/me');
    expect(request.signal.aborted).toBe(true);

    await expect(GET(request)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not perform a non-GET transition on behalf of a caller that left', async () => {
    // The case that matters most: a POST is a booking transition, and running
    // one for an abandoned request is a state change nobody asked to keep.
    const request = cancelled('http://branch.test/api/bookings/x/transition', 'POST');
    await expect(POST(request)).rejects.toThrow();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('ends as a cancellation rather than as a gateway error', async () => {
    // Not a 502, 503 or 504: inventing a public error contract for a browser
    // that has already disconnected would put a permanent upstream failure in
    // the operator's log every time someone closes a tab.
    const error = await GET(cancelled('http://branch.test/api/auth/me')).then(
      (response) => response,
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe('AbortError');
  });

  it('leaves no timer behind', async () => {
    // The deadline timer must never have been armed — an abandoned interval in
    // a route handler is a leak that only shows up under load.
    vi.useFakeTimers();
    await expect(GET(cancelled('http://branch.test/api/auth/me'))).rejects.toThrow();
    expect(vi.getTimerCount()).toBe(0);
  });
});
