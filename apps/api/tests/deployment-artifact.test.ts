import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { Agent, request as httpRequest } from 'node:http';
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/lib/pool';
import { setupFixtures, TEST_PASSWORD } from './helpers';

/**
 * [F1g] The fix has to survive being DEPLOYED.
 *
 * The password worker requires bcryptjs from a source string that is opaque to
 * the bundler on purpose — and an opaque require is opaque to Next's dependency
 * tracer too. A build therefore shipped a server with no bcryptjs in it, while
 * every unit test and every `next start` inside this checkout stayed green,
 * because the repository's own node_modules was still there to satisfy the
 * require. Measured on the pre-fix packaging: the isolated artifact answered a
 * correct password with 500 and `Cannot find module 'bcryptjs'`.
 *
 * So this test refuses the two shortcuts that hid it:
 *
 *   * it builds the STANDALONE artifact, which is the thing that gets deployed;
 *   * it runs that artifact from a directory outside the repository, where no
 *     ancestor node_modules can quietly satisfy anything the artifact forgot.
 *
 * It is slow because it builds. That is the price of the only evidence that
 * actually covers this failure.
 */
const API_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const PORT = 3407;
const BASE = `http://127.0.0.1:${PORT}`;

let artifactDir = '';
let server: ChildProcess | null = null;
let serverLog = '';

const login = async (email: string, password: string): Promise<Response> =>
  fetch(`${BASE}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });

async function waitUntilServing(deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (Date.now() < deadline) {
    try {
      // Any answer at all means the server is up; the status does not matter.
      await fetch(`${BASE}/api/auth/me`);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error(`Artifact server never answered on ${BASE}. Log:\n${serverLog}`);
}

beforeAll(async () => {
  await setupFixtures();

  execFileSync('npx', ['next', 'build'], { cwd: API_ROOT, stdio: 'pipe' });

  // Outside the repository entirely: nothing above this directory can resolve
  // a package the artifact failed to bring with it.
  artifactDir = mkdtempSync(join(tmpdir(), 'fr-deploy-artifact-'));
  cpSync(join(API_ROOT, '.next/standalone'), artifactDir, { recursive: true });

  server = spawn('node', ['apps/api/server.js'], {
    cwd: artifactDir,
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',
      // Same database the rest of this suite uses, so the fixtures above are
      // the accounts the artifact authenticates.
      DATABASE_URL: process.env.DATABASE_URL,
      AUTH_SECRET: process.env.AUTH_SECRET,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
  server.stderr?.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));

  await waitUntilServing(60_000);
}, 600_000);

afterAll(async () => {
  server?.kill('SIGKILL');
  if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
  await closePool();
});

describe('[F1g] the deployment artifact carries what the password worker needs', () => {
  it('traces bcryptjs into the standalone output', () => {
    // The worker's only non-builtin dependency. Its absence is the whole defect.
    const traced = join(API_ROOT, '.next/standalone/node_modules/bcryptjs');
    expect(existsSync(traced)).toBe(true);
    expect(existsSync(join(traced, 'package.json'))).toBe(true);
    // pg is the control: it was always traced, so a bare "something is present"
    // assertion could not have distinguished a fixed build from a broken one.
    expect(existsSync(join(API_ROOT, '.next/standalone/node_modules/pg'))).toBe(true);
  });

  it('refuses a wrong password from the isolated artifact', async () => {
    const response = await login('staff.a@test.example', 'definitely-wrong');
    expect(response.status).toBe(401);
    expect(serverLog).not.toContain('MODULE_NOT_FOUND');
  }, 60_000);

  it('completes a real login from the isolated artifact, worker and all', async () => {
    const response = await login('staff.a@test.example', TEST_PASSWORD);
    // A 500 here is the pre-fix signature: the worker died on `require`.
    expect(response.status).toBe(200);
    expect(response.headers.get('set-cookie') ?? '').toContain('fr_wf_session=');
    const profile = (await response.json()) as { employee: { email: string } };
    expect(profile.employee.email).toBe('staff.a@test.example');
    expect(serverLog).not.toContain("Cannot find module 'bcryptjs'");
  }, 60_000);
});

/**
 * [T3] The byte ceiling, over real sockets, on the artifact that ships.
 *
 * The helper tests prove the counting. These prove what a real client actually
 * experiences — including the two framings a caller chooses between, which the
 * application never sees directly.
 *
 * Measured on pre-fix main 02494832 against this same artifact: a 2 MiB login
 * answered 401 in 245ms with a declared length and 121ms chunked, meaning the
 * body was read and the password was verified; and a 2 MiB authenticated
 * transition answered 200 and moved the booking.
 */
describe('[T3] oversized bodies are refused by the deployed artifact', () => {
  const oversized = (fillerBytes: number): string =>
    JSON.stringify({
      email: 'staff.a@test.example',
      // A REAL password: a 413 that still authenticated would be a silent success.
      password: TEST_PASSWORD,
      filler: 'A'.repeat(fillerBytes),
    });

  /** Two megabytes: proves nothing of that size is ever buffered. */
  const HUGE = oversized(2 * 1024 * 1024);
  /**
   * Comfortably over the 16 KiB ceiling, and small enough to leave the client
   * in one write.
   *
   * MEASURED: with a 2 MiB chunked body the client is still uploading when the
   * server answers 413 and closes, so under load it observes EPIPE instead of
   * the response. That is legitimate server behaviour — see the reuse test
   * below — but it makes the assertion about the STATUS a race. A body that
   * flushes in one go removes the race without weakening the claim: it still
   * carries no Content-Length, and it is still over the limit.
   */
  const OVER_LIMIT_CHUNKED = oversized(40_000);

  interface Sent {
    status?: number;
    body: string;
    setCookie?: string[];
    error?: string;
    ms: number;
  }

  /** One request, framed either by a declared length or as chunked. */
  const send = (
    body: string,
    options: { chunked?: boolean; agent?: Agent | false } = {},
  ): Promise<Sent> =>
    new Promise((resolve) => {
      const buffer = Buffer.from(body, 'utf8');
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (options.chunked) headers['transfer-encoding'] = 'chunked';
      else headers['content-length'] = String(buffer.length);
      const started = Date.now();

      const req = httpRequest(
        {
          host: '127.0.0.1',
          port: PORT,
          path: '/api/auth/login',
          method: 'POST',
          headers,
          agent: options.agent ?? false,
        },
        (res) => {
          let text = '';
          res.on('data', (chunk: Buffer) => (text += chunk.toString()));
          res.on('end', () =>
            resolve({
              status: res.statusCode,
              body: text,
              setCookie: res.headers['set-cookie'],
              ms: Date.now() - started,
            }),
          );
        },
      );
      req.on('error', (error: NodeJS.ErrnoException) =>
        resolve({ error: error.code ?? error.message, body: '', ms: Date.now() - started }),
      );
      if (options.chunked) {
        for (let i = 0; i < buffer.length; i += 64 * 1024) {
          req.write(buffer.subarray(i, i + 64 * 1024));
        }
        req.end();
      } else {
        req.end(buffer);
      }
    });

  const expectRefused = (sent: Sent): void => {
    expect(sent.status).toBe(413);
    expect(JSON.parse(sent.body)).toEqual({
      error: { code: 'payload_too_large', message: 'Request body too large' },
    });
    // The valid credentials inside were never acted on.
    expect(sent.setCookie).toBeUndefined();
    expect(sent.body).not.toContain('AAAA');
    expect(sent.body).not.toContain(TEST_PASSWORD);
  };

  it('refuses a body with a declared Content-Length', async () => {
    expectRefused(await send(HUGE));
  }, 60_000);

  it('refuses a chunked body that declares no length at all', async () => {
    // The case a Content-Length check alone cannot cover: the caller never says
    // how much is coming.
    expectRefused(await send(OVER_LIMIT_CHUNKED, { chunked: true }));
  }, 60_000);

  it('keeps a declared-length connection reusable across the rejection', async () => {
    const pool = new Agent({ keepAlive: true, maxSockets: 1 });
    try {
      expect((await send(JSON.stringify({ email: 'a@b.test', password: 'x' }), { agent: pool })).status)
        .toBe(401);
      expectRefused(await send(HUGE, { agent: pool }));
      // Same pooled socket, and the following request is answered correctly
      // rather than misparsed as a continuation of the rejected body.
      expect((await send(JSON.stringify({ email: 'a@b.test', password: 'x' }), { agent: pool })).status)
        .toBe(401);
    } finally {
      pool.destroy();
    }
  }, 60_000);

  it('serves the next request normally after a chunked rejection', async () => {
    // MEASURED with a 2 MiB chunked body: the server closes that connection,
    // because the client was still uploading into a request it had stopped
    // reading, and a client reusing that pooled socket sees a reset ~6s later.
    // Closing is the documented, acceptable outcome — hanging, crashing or
    // misparsing the next request is not. Whichever way the rejected connection
    // ends, a fresh one is immediately serviceable, which is what this asserts.
    expectRefused(await send(OVER_LIMIT_CHUNKED, { chunked: true }));
    const next = await send(JSON.stringify({ email: 'staff.a@test.example', password: TEST_PASSWORD }));
    expect(next.status).toBe(200);
    expect((next.setCookie ?? []).join(';')).toContain('fr_wf_session=');
  }, 60_000);

  it('leaves the artifact healthy and logs no payload', async () => {
    const health = await fetch(`${BASE}/api/health`);
    expect(health.status).toBe(200);
    expect(serverLog).not.toContain('AAAA');
    expect(serverLog).not.toContain(TEST_PASSWORD);
  }, 60_000);
});
