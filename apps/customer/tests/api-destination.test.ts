import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * [F29-I] Classification, not a fix.
 *
 * F29 was reported against the Branch app, whose API destination was frozen
 * into `.next/routes-manifest.json` by a build-time `rewrites()`. The Customer
 * app also reads `process.env.API_URL`, so the obvious question is whether it
 * has the same defect. It does not, and this test is the reason that claim is
 * allowed to be made: the read happens inside a `force-dynamic` Server
 * Component, which runs per request, so the value is the RUNTIME one.
 *
 * Proven the same way as the Branch app: built with one destination, started
 * with another, and the traffic follows the environment.
 *
 * Two things this test deliberately does NOT claim:
 *
 *   * it is not a packaging proof. The Customer app has no `output: 'standalone'`
 *     and this runs `next start` inside the checkout, because the subject here
 *     is WHEN the variable is read, not what ships. F29's scope is the Branch
 *     app; changing the Customer app's packaging is not in it.
 *   * the Customer app still falls back to `http://localhost:3000` when
 *     `API_URL` is unset. That fallback is real and is NOT fixed here — it is a
 *     server-side read in a public, unauthenticated page, not the frozen-artifact
 *     defect, and touching it would widen this change beyond F29.
 */
const CUSTOMER_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const BUILD_PORT = 4291;
const RUNTIME_PORT = 4292;
const APP_PORT = 3291;

interface Upstream {
  marker: string;
  seen: string[];
  server: Server;
}

function startUpstream(marker: string, port: number): Promise<Upstream> {
  const seen: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(req.url ?? '');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        branches: [{ id: '11111111-1111-1111-1111-111111111111', name: marker, city: 'Muscat' }],
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ marker, seen, server }));
  });
}

let buildTime: Upstream;
let runTime: Upstream;
let app: ChildProcess | null = null;
let log = '';

beforeAll(async () => {
  [buildTime, runTime] = await Promise.all([
    startUpstream('BUILD-TIME-BRANCH', BUILD_PORT),
    startUpstream('RUNTIME-BRANCH', RUNTIME_PORT),
  ]);

  execFileSync('npx', ['next', 'build'], {
    cwd: CUSTOMER_ROOT,
    stdio: 'pipe',
    env: { ...process.env, API_URL: `http://127.0.0.1:${BUILD_PORT}` },
  });

  app = spawn('npx', ['next', 'start', '--port', String(APP_PORT)], {
    cwd: CUSTOMER_ROOT,
    env: { ...process.env, NODE_ENV: 'production', API_URL: `http://127.0.0.1:${RUNTIME_PORT}` },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  app.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()));
  app.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()));

  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      await fetch(`http://127.0.0.1:${APP_PORT}/`);
      break;
    } catch {
      if (Date.now() > deadline) throw new Error(`Customer app never started. Log:\n${log}`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}, 900_000);

afterAll(async () => {
  app?.kill('SIGKILL');
  await Promise.all(
    [buildTime, runTime].map((upstream) => new Promise((resolve) => upstream?.server.close(resolve))),
  );
});

describe('[F29-I] the Customer app reads its API destination at request time', () => {
  it('fetches from the environment it is RUNNING in, not the one it was BUILT in', async () => {
    const before = runTime.seen.length;
    const response = await fetch(`http://127.0.0.1:${APP_PORT}/`);
    expect(response.status).toBe(200);
    const html = await response.text();

    // The branch name in the page came from the runtime upstream.
    expect(html).toContain('RUNTIME-BRANCH');
    expect(html).not.toContain('BUILD-TIME-BRANCH');

    expect(runTime.seen.slice(before)).toContain('/api/public/branches');
    // The destination it was built with was never contacted.
    expect(buildTime.seen).toEqual([]);
  }, 120_000);

  it('re-reads on every request rather than caching the first answer', async () => {
    const before = runTime.seen.length;
    await fetch(`http://127.0.0.1:${APP_PORT}/`);
    await fetch(`http://127.0.0.1:${APP_PORT}/`);
    // `force-dynamic` plus `cache: 'no-store'`: two requests, two fetches.
    expect(runTime.seen.length - before).toBe(2);
    expect(buildTime.seen).toEqual([]);
  }, 120_000);
});
