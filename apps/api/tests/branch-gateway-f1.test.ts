import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/lib/pool';
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
