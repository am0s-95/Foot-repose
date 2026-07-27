import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/lib/pool';
import { POST as loginPost } from '../src/app/api/auth/login/route';
import { POST as logoutPost } from '../src/app/api/auth/logout/route';
import { GET as meGet } from '../src/app/api/auth/me/route';
import { GET as branchesGet } from '../src/app/api/branches/route';
import { GET as publicBranchesGet } from '../src/app/api/public/branches/route';
import { LOGIN_RATE_LIMIT } from '../src/modules/auth/rate-limit';
import { getPool } from '../src/lib/pool';
import {
  createPool,
  registerLoginAttempt as dbRegisterLoginAttempt,
  resetAllLoginAttempts,
} from '@foot-repose/db';
import {
  countAuditRows,
  getReq,
  loginAs,
  postReq,
  setupFixtures,
  TEST_PASSWORD,
  type Fixtures,
} from './helpers';

let fx: Fixtures;

beforeAll(async () => {
  fx = await setupFixtures();
});

afterAll(async () => {
  await closePool();
});

describe('POST /api/auth/login', () => {
  it('sets an HttpOnly session cookie and returns the profile with branches', async () => {
    const response = await loginPost(
      postReq('http://test.local/api/auth/login', undefined, {
        email: 'staff.a@test.example',
        password: TEST_PASSWORD,
      }),
    );
    expect(response.status).toBe(200);
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('fr_wf_session=');
    expect(setCookie).toContain('HttpOnly');
    const profile = await response.json();
    expect(profile.employee.email).toBe('staff.a@test.example');
    expect(profile.employee.role).toBe('staff');
    expect(profile.branches.map((b: { id: string }) => b.id)).toEqual([fx.branchA]);
    expect(await countAuditRows('auth.login', fx.staffA.id)).toBeGreaterThanOrEqual(1);
  });

  it('gives super_admin every active branch', async () => {
    const cookie = await loginAs('super@test.example');
    const response = await meGet(getReq('http://test.local/api/auth/me', cookie));
    const profile = await response.json();
    expect(profile.branches).toHaveLength(2);
  });

  it('rejects a wrong password and audits the failure', async () => {
    const before = await countAuditRows('auth.login_failed', fx.staffA.id);
    const response = await loginPost(
      postReq('http://test.local/api/auth/login', undefined, {
        email: 'staff.a@test.example',
        password: 'wrong-password',
      }),
    );
    expect(response.status).toBe(401);
    expect(await countAuditRows('auth.login_failed', fx.staffA.id)).toBe(before + 1);
  });

  it('rejects unknown emails and deactivated employees', async () => {
    const unknown = await loginPost(
      postReq('http://test.local/api/auth/login', undefined, {
        email: 'nobody@test.example',
        password: TEST_PASSWORD,
      }),
    );
    expect(unknown.status).toBe(401);

    const inactive = await loginPost(
      postReq('http://test.local/api/auth/login', undefined, {
        email: 'gone@test.example',
        password: TEST_PASSWORD,
      }),
    );
    expect(inactive.status).toBe(401);
  });

  it('rejects malformed bodies with validation_error', async () => {
    const response = await loginPost(
      postReq('http://test.local/api/auth/login', undefined, { email: 'not-an-email' }),
    );
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('validation_error');
  });
});

describe('GET /api/auth/me', () => {
  it('requires a session, and the 401 is uncacheable', async () => {
    const response = await meGet(getReq('http://test.local/api/auth/me'));
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });

  it('rejects a tampered session token', async () => {
    const response = await meGet(
      getReq('http://test.local/api/auth/me', 'fr_wf_session=not-a-real-token'),
    );
    expect(response.status).toBe(401);
  });

  it('marks authenticated responses uncacheable', async () => {
    const cookie = await loginAs('staff.a@test.example');
    const response = await meGet(getReq('http://test.local/api/auth/me', cookie));
    expect(response.headers.get('cache-control')).toBe('private, no-store');
  });
});

describe('login rate limiting (PostgreSQL-backed)', () => {
  const failedAttempt = (email: string) =>
    loginPost(
      postReq('http://test.local/api/auth/login', undefined, {
        email,
        password: 'wrong-password',
      }),
    );

  it('throttles repeated failures per email+ip and audits it', async () => {
    await resetAllLoginAttempts(getPool());
    for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_ATTEMPTS; i += 1) {
      expect((await failedAttempt('hammered@test.example')).status).toBe(401);
    }
    const throttled = await failedAttempt('hammered@test.example');
    expect(throttled.status).toBe(429);
    expect(throttled.headers.get('cache-control')).toBe('private, no-store');
    expect((await throttled.json()).error.code).toBe('rate_limited');
    expect(await countAuditRows('auth.login_rate_limited')).toBeGreaterThanOrEqual(1);
    await resetAllLoginAttempts(getPool());
  });

  it('counts concurrent attempts atomically — no lost increments', async () => {
    await resetAllLoginAttempts(getPool());
    const email = 'swarm@test.example';
    const parallelAttempts = 15;
    await Promise.all(
      Array.from({ length: parallelAttempts }, () => failedAttempt(email)),
    );
    const row = await getPool().query<{ total: string }>(
      'SELECT coalesce(sum(attempts), 0) AS total FROM login_rate_limits WHERE key = $1',
      [`${email}|unknown`],
    );
    expect(Number(row.rows[0]!.total)).toBe(parallelAttempts);
    expect((await failedAttempt(email)).status).toBe(429);
    await resetAllLoginAttempts(getPool());
  });

  it('is shared across API instances and survives a cold start', async () => {
    await resetAllLoginAttempts(getPool());
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error('DATABASE_URL missing');
    const key = 'instances@test.example|10.0.0.9';
    const instanceA = createPool(url);
    try {
      for (let i = 1; i <= 6; i += 1) {
        expect(await dbRegisterLoginAttempt(instanceA, key, LOGIN_RATE_LIMIT.WINDOW_SECONDS)).toBe(i);
      }
    } finally {
      await instanceA.end(); // instance A disappears (cold start / scale-down)
    }
    const instanceB = createPool(url);
    try {
      for (let i = 7; i <= 11; i += 1) {
        expect(await dbRegisterLoginAttempt(instanceB, key, LOGIN_RATE_LIMIT.WINDOW_SECONDS)).toBe(i);
      }
      expect(11).toBeGreaterThan(LOGIN_RATE_LIMIT.MAX_ATTEMPTS);
    } finally {
      await instanceB.end();
    }
    await resetAllLoginAttempts(getPool());
  });
});

describe('origin guard on state-changing routes', () => {
  const loginBody = { email: 'staff.a@test.example', password: TEST_PASSWORD };

  it('rejects browser requests from unknown origins', async () => {
    const response = await loginPost(
      new Request('http://test.local/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'https://evil.example' },
        body: JSON.stringify(loginBody),
      }),
    );
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('forbidden');
  });

  it('accepts requests from allowed frontend origins', async () => {
    const response = await loginPost(
      new Request('http://test.local/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://localhost:3001' },
        body: JSON.stringify(loginBody),
      }),
    );
    expect(response.status).toBe(200);
  });
});

describe('GET /api/public/branches', () => {
  it('is public and cacheable for a short time', async () => {
    const response = await publicBranchesGet();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('public, max-age=300');
    const body = await response.json();
    expect(body.branches.length).toBeGreaterThanOrEqual(2);
  });
});

describe('GET /api/branches', () => {
  it('lists only the branches assigned to the employee', async () => {
    const cookie = await loginAs('staff.b@test.example');
    const response = await branchesGet(getReq('http://test.local/api/branches', cookie));
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.branches.map((b: { id: string }) => b.id)).toEqual([fx.branchB]);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session server-side: the old cookie stops working', async () => {
    const cookie = await loginAs('manager.a@test.example');
    expect((await meGet(getReq('http://test.local/api/auth/me', cookie))).status).toBe(200);

    const response = await logoutPost(postReq('http://test.local/api/auth/logout', cookie, {}));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await countAuditRows('auth.logout', fx.managerA.id)).toBe(1);

    // The client may still hold the JWT — the server must reject it anyway.
    const reused = await meGet(getReq('http://test.local/api/auth/me', cookie));
    expect(reused.status).toBe(401);
  });
});
