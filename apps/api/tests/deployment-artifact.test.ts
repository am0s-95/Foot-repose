import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
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
