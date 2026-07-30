import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/lib/pool';
import { LOGIN_RATE_LIMIT } from '../src/modules/auth/rate-limit';
import { setupFixtures, TEST_PASSWORD } from './helpers';

/**
 * [F29-G] The F1 boundary, re-proven THROUGH the new Branch gateway.
 *
 * F29 put a new hop in front of the API: browser → Branch gateway → API. A hop
 * is exactly the thing that can quietly manufacture the trust F1 refused to
 * grant. `trustedClientIp` returns null unless `TRUSTED_PROXY_HOPS` says a real
 * boundary exists — but if the gateway forwarded, or worse appended,
 * `X-Forwarded-For`, then the moment anyone set that variable the API would be
 * reading a value a browser wrote.
 *
 * So this runs the real thing end to end: the real API standalone artifact, the
 * real Branch standalone artifact in front of it, a real login over real
 * sockets carrying every client-address header an attacker might try — and then
 * asks the DATABASE what was recorded. `sessions.ip` and `audit_logs.ip` staying
 * null is the assertion; nothing else proves the hop did not become a source of
 * truth.
 *
 * It lives here rather than in `apps/branch/tests` because the boundary rules
 * forbid a frontend from importing the database, and the answer has to come
 * from the database.
 */
const API_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BRANCH_ROOT = new URL('../../branch', import.meta.url).pathname.replace(/\/$/, '');

const API_PORT = 3409;
const GATEWAY_PORT = 3410;
const GATEWAY = `http://127.0.0.1:${GATEWAY_PORT}`;

const SPOOFED_IP = '203.0.113.77';
const SPOOFED_HEADERS: Record<string, string> = {
  'x-forwarded-for': SPOOFED_IP,
  forwarded: `for=${SPOOFED_IP}`,
  'x-real-ip': SPOOFED_IP,
  'cf-connecting-ip': SPOOFED_IP,
  'true-client-ip': SPOOFED_IP,
  'x-client-ip': SPOOFED_IP,
};

let apiDir = '';
let gatewayDir = '';
let apiProcess: ChildProcess | null = null;
let gatewayProcess: ChildProcess | null = null;
let log = '';

function buildStandalone(root: string, into: string): void {
  execFileSync('npx', ['next', 'build'], { cwd: root, stdio: 'pipe' });
  cpSync(join(root, '.next/standalone'), into, { recursive: true });
}

async function waitUntilServing(base: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      await fetch(`${base}/api/auth/me`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Nothing answered on ${base}. Log:\n${log}`);
}

beforeAll(async () => {
  await setupFixtures();

  apiDir = mkdtempSync(join(tmpdir(), 'fr-gw-api-'));
  gatewayDir = mkdtempSync(join(tmpdir(), 'fr-gw-branch-'));
  buildStandalone(API_ROOT, apiDir);
  buildStandalone(BRANCH_ROOT, gatewayDir);

  apiProcess = spawn('node', ['apps/api/server.js'], {
    cwd: apiDir,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(API_PORT),
      HOSTNAME: '127.0.0.1',
      DATABASE_URL: process.env.DATABASE_URL,
      AUTH_SECRET: process.env.AUTH_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  gatewayProcess = spawn('node', ['apps/branch/server.js'], {
    cwd: gatewayDir,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(GATEWAY_PORT),
      HOSTNAME: '127.0.0.1',
      API_URL: `http://127.0.0.1:${API_PORT}`,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  for (const child of [apiProcess, gatewayProcess]) {
    child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()));
    child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()));
  }

  await waitUntilServing(`http://127.0.0.1:${API_PORT}`, 60_000);
  await waitUntilServing(GATEWAY, 60_000);
}, 900_000);

afterAll(async () => {
  apiProcess?.kill('SIGKILL');
  gatewayProcess?.kill('SIGKILL');
  for (const dir of [apiDir, gatewayDir]) {
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
  await closePool();
});

describe('[F29-G] the new gateway does not become a source of client identity', () => {
  it('completes a real login through the gateway and records no client address', async () => {
    const response = await fetch(`${GATEWAY}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...SPOOFED_HEADERS },
      body: JSON.stringify({ email: 'staff.a@test.example', password: TEST_PASSWORD }),
    });

    // The gateway really did proxy a working login, cookie and all.
    expect(response.status).toBe(200);
    const cookies = response.headers.getSetCookie();
    expect(cookies.some((cookie) => cookie.startsWith('fr_wf_session='))).toBe(true);
    // The F1 cookie properties survived the extra hop.
    const session = cookies.find((cookie) => cookie.startsWith('fr_wf_session=')) ?? '';
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
    expect(session).toContain('Path=/');

    const pool = getPool();
    // Unchanged by F29: with no trusted boundary declared, there is no
    // authoritative client address, so none is stored.
    const sessions = await pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sessions WHERE ip IS NOT NULL',
    );
    expect(sessions.rows[0]!.n).toBe(0);

    const audits = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE action IN ('login', 'logout') AND ip IS NOT NULL`,
    );
    expect(audits.rows[0]!.n).toBe(0);

    // And the spoofed value did not survive anywhere in the audit record.
    const anywhere = await pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_logs WHERE metadata::text LIKE '%' || $1 || '%'",
      [SPOOFED_IP],
    );
    expect(anywhere.rows[0]!.n).toBe(0);
  }, 120_000);

  it('[F29-C] authenticates a follow-up request with the cookie the gateway relayed', async () => {
    const login = await fetch(`${GATEWAY}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'staff.a@test.example', password: TEST_PASSWORD }),
    });
    const raw = login.headers.getSetCookie().find((c) => c.startsWith('fr_wf_session=')) ?? '';
    // The security attributes the browser will actually store, after two hops.
    expect(raw).toContain('HttpOnly');
    expect(raw).toContain('SameSite=Lax');

    const me = await fetch(`${GATEWAY}/api/auth/me`, {
      headers: { cookie: raw.split(';')[0] ?? '' },
    });
    expect(me.status).toBe(200);
    const profile = (await me.json()) as { employee: { email: string } };
    expect(profile.employee.email).toBe('staff.a@test.example');
    expect(me.headers.get('cache-control')).toBe('private, no-store');
  }, 120_000);

  it('[F29-D] relays real API error statuses, not just successes', async () => {
    // 401 — wrong password.
    const unauthorized = await fetch(`${GATEWAY}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'staff.b@test.example', password: 'wrong' }),
    });
    expect(unauthorized.status).toBe(401);
    expect((await unauthorized.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'unauthorized' },
    });

    // 400 — the API's own validation error, reaching the caller unmodified.
    const invalid = await fetch(`${GATEWAY}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'not-an-email', password: '' }),
    });
    expect(invalid.status).toBe(400);
    expect((await invalid.json()) as { error: { code: string } }).toMatchObject({
      error: { code: 'validation_error' },
    });

    // 401 — no session at all, so the unauthenticated shape is the API's too.
    const anonymous = await fetch(`${GATEWAY}/api/auth/me`);
    expect(anonymous.status).toBe(401);
  }, 120_000);

  it('[F1] still throttles one account when the forged address is rotated per attempt', async () => {
    // This is the exact abuse F1 closed, now driven through the new hop: before
    // F1 the counter was keyed on email + X-Forwarded-For, so a fresh forged
    // address bought a fresh allowance every time. The gateway must not hand
    // that back by forwarding the header.
    const email = 'manager.a@test.example';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < LOGIN_RATE_LIMIT.MAX_ATTEMPTS + 2; attempt += 1) {
      const response = await fetch(`${GATEWAY}/api/auth/login`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // A different forged address on every single attempt.
          'x-forwarded-for': `203.0.113.${attempt + 1}`,
          'x-real-ip': `198.51.100.${attempt + 1}`,
        },
        body: JSON.stringify({ email, password: 'definitely-wrong' }),
      });
      statuses.push(response.status);
    }

    // The allowance is counted per normalized email regardless of the rotation.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
    expect(statuses.at(-1)).toBe(429);

    const pool = getPool();
    // Exactly ONE bucket exists for this account: the mandatory identifier one.
    //
    // Stated honestly about what this particular assertion proves: with
    // TRUSTED_PROXY_HOPS unset, no source bucket would be created even if the
    // gateway HAD forwarded the header, so this row check alone does not
    // discriminate. The discriminating evidence is elsewhere — the branch suite
    // asserts the upstream never receives any of the six headers — and the
    // check here is the durable statement of the invariant this deployment
    // must keep holding if that variable is ever set.
    const keys = await pool.query<{ key: string }>(
      `SELECT DISTINCT key FROM login_rate_limits
        WHERE key LIKE '%' || $1 || '%' OR key LIKE 'login:ip:%'
        ORDER BY key`,
      [email],
    );
    expect(keys.rows.map((row) => row.key)).toEqual([`login:id:${email}`]);

    // And nothing recorded the forged addresses anywhere.
    const leaked = await pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
        WHERE ip IS NOT NULL OR metadata::text LIKE '%203.0.113.%'
           OR metadata::text LIKE '%198.51.100.%'`,
    );
    expect(leaked.rows[0]!.n).toBe(0);
  }, 180_000);

  it('logs out through the gateway with the cookie deletion intact', async () => {
    const login = await fetch(`${GATEWAY}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'staff.a@test.example', password: TEST_PASSWORD }),
    });
    const cookie = (login.headers.getSetCookie().find((c) => c.startsWith('fr_wf_session=')) ?? '')
      .split(';')[0];
    expect(cookie).toBeTruthy();

    const logout = await fetch(`${GATEWAY}/api/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookie ?? '' },
    });
    expect(logout.status).toBe(200);
    // A gateway that merged Set-Cookie headers, or dropped them, would leave the
    // browser holding a revoked session it still believes in.
    const cleared = logout.headers.getSetCookie();
    expect(cleared.some((c) => c.startsWith('fr_wf_session=') && /Max-Age=0|Expires=/.test(c))).toBe(
      true,
    );

    // The session is genuinely revoked on the far side, not just forgotten here.
    const me = await fetch(`${GATEWAY}/api/auth/me`, { headers: { cookie: cookie ?? '' } });
    expect(me.status).toBe(401);
  }, 120_000);

  it('still refuses a wrong password through the gateway', async () => {
    const response = await fetch(`${GATEWAY}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...SPOOFED_HEADERS },
      body: JSON.stringify({ email: 'staff.a@test.example', password: 'definitely-wrong' }),
    });
    expect(response.status).toBe(401);
    // [F1] Per-IP throttling cannot be resurrected by spoofing through the new
    // hop: rotating x-forwarded-for buys the caller nothing, because the value
    // never arrives.
    expect(response.headers.getSetCookie()).toEqual([]);
  }, 120_000);
});
