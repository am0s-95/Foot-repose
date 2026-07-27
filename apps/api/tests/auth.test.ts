import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/lib/pool';
import { POST as loginPost } from '../src/app/api/auth/login/route';
import { POST as logoutPost } from '../src/app/api/auth/logout/route';
import { GET as meGet } from '../src/app/api/auth/me/route';
import { GET as branchesGet } from '../src/app/api/branches/route';
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
    expect(setCookie).toContain('fr_session=');
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
  it('requires a session', async () => {
    const response = await meGet(getReq('http://test.local/api/auth/me'));
    expect(response.status).toBe(401);
  });

  it('rejects a tampered session token', async () => {
    const response = await meGet(
      getReq('http://test.local/api/auth/me', 'fr_session=not-a-real-token'),
    );
    expect(response.status).toBe(401);
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
  it('clears the cookie and audits the logout', async () => {
    const cookie = await loginAs('manager.a@test.example');
    const response = await logoutPost(postReq('http://test.local/api/auth/logout', cookie, {}));
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    expect(await countAuditRows('auth.logout', fx.managerA.id)).toBe(1);
  });
});
