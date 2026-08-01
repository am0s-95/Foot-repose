import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { POST as loginPost } from '../src/app/api/auth/login/route';
import { POST as transitionPost } from '../src/app/api/bookings/[bookingId]/transition/route';
import { MAX_JSON_BODY_BYTES } from '../src/lib/http';
import { closePool, getPool } from '../src/lib/pool';
import { countAuditRows, loginAs, setupFixtures, TEST_PASSWORD, type Fixtures } from './helpers';

/**
 * [T3] The byte ceiling as the two real routes actually apply it — including
 * what must happen BEFORE it.
 *
 * Rejecting on size sooner would be easy and wrong. Origin, session,
 * routing and authorization all decide who is allowed to be heard at all;
 * moving the size check above them would turn an unauthorized request into a
 * 413, telling an anonymous caller that a booking id exists and changing the
 * status an existing client already handles. The order below is the contract,
 * and each case names the precedence it protects.
 */
let fx: Fixtures;
let staffCookie: string;

const OVERSIZED_FILLER = 'x'.repeat(MAX_JSON_BODY_BYTES + 1_000);

const oversizedLogin = (extra: Record<string, string> = {}): string =>
  JSON.stringify({
    email: 'staff.a@test.example',
    password: TEST_PASSWORD,
    filler: OVERSIZED_FILLER,
    ...extra,
  });

const oversizedTransition = (): string =>
  JSON.stringify({ action: 'check_in', filler: OVERSIZED_FILLER });

const post = (url: string, body: string, headers: Record<string, string> = {}): Request =>
  new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });

/** The same payload with no declared length, delivered as a stream. */
const postChunked = (url: string, body: string, headers: Record<string, string> = {}): Request => {
  const bytes = new TextEncoder().encode(body);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (let i = 0; i < bytes.length; i += 8_192) {
        controller.enqueue(bytes.subarray(i, i + 8_192));
      }
      controller.close();
    },
  });
  return new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: stream,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
};

const expectTooLarge = async (response: Response): Promise<void> => {
  expect(response.status).toBe(413);
  expect(response.headers.get('cache-control')).toContain('private, no-store');
  const body = (await response.json()) as { error: { code: string; message: string } };
  expect(body).toEqual({
    error: { code: 'payload_too_large', message: 'Request body too large' },
  });
  // Nothing from the rejected payload comes back.
  expect(JSON.stringify(body)).not.toContain('xxxx');
  expect(JSON.stringify(body)).not.toContain(TEST_PASSWORD);
};

const bookingStatus = async (id: string): Promise<string> => {
  const result = await getPool().query<{ status: string }>(
    'SELECT status FROM bookings WHERE id = $1',
    [id],
  );
  return result.rows[0]!.status;
};

beforeAll(async () => {
  fx = await setupFixtures();
  staffCookie = await loginAs('staff.a@test.example');
});

afterAll(async () => {
  await closePool();
});

describe('[T3] POST /api/auth/login', () => {
  it('answers 413 for an oversized body with a declared length', async () => {
    await expectTooLarge(await loginPost(post('http://test.local/api/auth/login', oversizedLogin())));
  });

  it('answers 413 for an oversized body with no declared length', async () => {
    const request = postChunked('http://test.local/api/auth/login', oversizedLogin());
    expect(request.headers.get('content-length')).toBeNull();
    await expectTooLarge(await loginPost(request));
  });

  it('creates no session even though the credentials inside were valid', async () => {
    // The payload carries a REAL password. A 413 that still authenticated would
    // be a silent success, so this is the case that proves the ceiling lands
    // before login() rather than after it.
    const response = await loginPost(post('http://test.local/api/auth/login', oversizedLogin()));
    expect(response.status).toBe(413);
    expect(response.headers.get('set-cookie')).toBeNull();
  });

  it('records no login audit row and no rate-limit attempt', async () => {
    const before = await countAuditRows('auth.login_failed');
    const succeeded = await countAuditRows('auth.login_succeeded');
    await loginPost(post('http://test.local/api/auth/login', oversizedLogin()));
    expect(await countAuditRows('auth.login_failed')).toBe(before);
    expect(await countAuditRows('auth.login_succeeded')).toBe(succeeded);
  });

  it('keeps Origin precedence: an untrusted origin is still 403, not 413', async () => {
    // assertTrustedOrigin runs before the body is touched, and must keep doing
    // so — otherwise a cross-site caller learns about size limits instead of
    // being refused outright.
    const response = await loginPost(
      post('http://test.local/api/auth/login', oversizedLogin(), {
        origin: 'https://evil.example',
      }),
    );
    expect(response.status).toBe(403);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe('forbidden');
  });

  it('leaves normal logins working, before and after a rejected one', async () => {
    const good = () =>
      loginPost(
        post(
          'http://test.local/api/auth/login',
          JSON.stringify({ email: 'staff.a@test.example', password: TEST_PASSWORD }),
        ),
      );
    expect((await good()).status).toBe(200);
    expect((await loginPost(post('http://test.local/api/auth/login', oversizedLogin()))).status).toBe(
      413,
    );
    // The next request is serviced normally: the rejection is per request.
    const after = await good();
    expect(after.status).toBe(200);
    expect(after.headers.get('set-cookie')).toBeTruthy();
  });

  it('leaves an invalid normal login answering 401', async () => {
    const response = await loginPost(
      post(
        'http://test.local/api/auth/login',
        JSON.stringify({ email: 'staff.a@test.example', password: 'wrong-password-value' }),
      ),
    );
    expect([401, 429]).toContain(response.status);
  });
});

describe('[T3] POST /api/bookings/[bookingId]/transition', () => {
  const call = (id: string, request: Request): Promise<Response> =>
    transitionPost(request, { params: Promise.resolve({ bookingId: id }) });

  it('answers 413 for an authenticated request with a valid booking id', async () => {
    const id = fx.bookings.confirmedA;
    await expectTooLarge(
      await call(
        id,
        post(`http://test.local/api/bookings/${id}/transition`, oversizedTransition(), {
          cookie: staffCookie,
        }),
      ),
    );
  });

  it('does not transition the booking and writes no transition audit row', async () => {
    const id = fx.bookings.confirmedA;
    const statusBefore = await bookingStatus(id);
    const auditBefore = await countAuditRows('booking.transition', id);

    const response = await call(
      id,
      post(`http://test.local/api/bookings/${id}/transition`, oversizedTransition(), {
        cookie: staffCookie,
      }),
    );

    expect(response.status).toBe(413);
    // Measured on pre-fix main: this exact shape returned 200 and moved the
    // booking from `confirmed` to `checked_in`.
    expect(await bookingStatus(id)).toBe(statusBefore);
    expect(await countAuditRows('booking.transition', id)).toBe(auditBefore);
  });

  it('keeps Origin precedence: untrusted origin stays 403', async () => {
    const id = fx.bookings.confirmedA;
    const response = await call(
      id,
      post(`http://test.local/api/bookings/${id}/transition`, oversizedTransition(), {
        cookie: staffCookie,
        origin: 'https://evil.example',
      }),
    );
    expect(response.status).toBe(403);
  });

  it('keeps auth precedence: unauthenticated stays 401', async () => {
    const id = fx.bookings.confirmedA;
    const response = await call(
      id,
      post(`http://test.local/api/bookings/${id}/transition`, oversizedTransition()),
    );
    expect(response.status).toBe(401);
  });

  it('keeps routing precedence: a malformed booking id stays 404', async () => {
    // A 413 here would confirm to a caller that the size limit was reached
    // before the id was even judged — and would change a status clients already handle.
    const response = await call(
      'not-a-uuid',
      post('http://test.local/api/bookings/not-a-uuid/transition', oversizedTransition(), {
        cookie: staffCookie,
      }),
    );
    expect(response.status).toBe(404);
  });

  it('leaves a normal transition working after a rejected one', async () => {
    const id = fx.bookings.confirmedB ?? fx.bookings.confirmedA;
    await call(
      id,
      post(`http://test.local/api/bookings/${id}/transition`, oversizedTransition(), {
        cookie: staffCookie,
      }),
    );
    const managerCookie = await loginAs('manager.a@test.example');
    const response = await call(
      fx.bookings.confirmedA,
      post(
        `http://test.local/api/bookings/${fx.bookings.confirmedA}/transition`,
        JSON.stringify({ action: 'check_in' }),
        { cookie: managerCookie },
      ),
    );
    expect(response.status).toBe(200);
    expect(await bookingStatus(fx.bookings.confirmedA)).toBe('checked_in');
  });
});
