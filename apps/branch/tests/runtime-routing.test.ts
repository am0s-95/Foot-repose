import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * [F29] The Branch app's API destination, proven on the artifact that ships.
 *
 * The defect this replaces was invisible to every cheaper form of evidence.
 * `rewrites()` runs during `next build`, so the destination lived in
 * `.next/routes-manifest.json`; `next dev` and `next start` inside a checkout
 * that was itself built for the current environment always looked correct.
 * Measured on pre-fix main c6f7cac3: an artifact built with
 * `API_URL=http://127.0.0.1:4101`, then started with `API_URL=http://127.0.0.1:4102`,
 * sent both `GET /api/auth/me` and `POST /api/auth/login` to 4101 while 4102
 * received zero requests — and the artifact bytes were byte-identical before and
 * after, so nothing had "adapted". Only rebuilding moved it.
 *
 * So this test does the one thing that could have caught it:
 *
 *   * it builds ONCE, deliberately with a POISON destination — an upstream that
 *     must never receive anything. If any build-time value survived, that is
 *     where the traffic goes, and the whole suite fails loudly rather than
 *     passing because the build happened to use the right value;
 *   * it copies the standalone artifact OUTSIDE the repository, so nothing above
 *     it can quietly supply what the artifact failed to bring;
 *   * it runs that same directory against two different upstreams, hashing the
 *     tree around the runs, so "the same artifact" is a measured claim.
 *
 * It is slow because it builds. That is the price of the only evidence that
 * covers this failure.
 */
const BRANCH_ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const REPO_ROOT = new URL('../../..', import.meta.url).pathname.replace(/\/$/, '');

const POISON_PORT = 4191;
const B_PORT = 4192;
const C_PORT = 4193;
const EVIL_PORT = 4194;
/** Never listens. Reaching it is a connect failure, which is the point. */
const DEAD_PORT = 4195;

const POISON_URL = `http://127.0.0.1:${POISON_PORT}`;
const B_URL = `http://127.0.0.1:${B_PORT}`;
const C_URL = `http://127.0.0.1:${C_PORT}`;

interface Seen {
  method: string;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

interface Upstream {
  marker: string;
  seen: Seen[];
  server: Server;
}

/**
 * A deterministic upstream. Every response names the upstream that produced it,
 * so "which one answered" is read off the body rather than inferred from timing
 * or from a log. It also records what it received, which is how the header,
 * query and body fidelity assertions are made against the far side of the
 * gateway rather than against the gateway's own intentions.
 */
function startUpstream(marker: string, port: number): Promise<Upstream> {
  const seen: Seen[] = [];
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers, body });
      const path = (req.url ?? '').split('?')[0] ?? '';
      if (path === '/api/cookies') {
        res.writeHead(200, [
          ['content-type', 'application/json'],
          ['x-upstream', marker],
          ['set-cookie', 'fr_wf_session=abc; Path=/; HttpOnly; SameSite=Lax'],
          ['set-cookie', 'fr_flag=one; Path=/'],
          ['set-cookie', 'fr_stale=; Path=/; Max-Age=0'],
        ]);
        res.end(JSON.stringify({ upstream: marker }));
        return;
      }
      if (path === '/api/empty') {
        // The marker rides in a HEADER as well as the body, so an assertion
        // about a body-less response can still say which upstream answered.
        // Without it, "the 204 came back intact" passed against the pre-fix
        // build too — which proxied a perfectly intact 204 from the wrong place.
        res.writeHead(204, { 'x-upstream': marker });
        res.end();
        return;
      }
      if (path === '/api/cacheable') {
        res.writeHead(200, {
          'content-type': 'application/json',
          'x-upstream': marker,
          'cache-control': 'public, max-age=60',
        });
        res.end(JSON.stringify({ upstream: marker }));
        return;
      }
      if (path.startsWith('/api/status/')) {
        const status = Number(path.slice('/api/status/'.length));
        res.writeHead(status, { 'content-type': 'application/json', 'x-upstream': marker });
        res.end(JSON.stringify({ upstream: marker, status }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': marker });
      res.end(
        JSON.stringify({ upstream: marker, method: req.method, url: req.url, body }),
      );
    });
  };
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve({ marker, seen, server }));
  });
}

function walk(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else files.push(full);
  }
  return files.sort();
}

/** A hash of every file in the artifact, path included, so a change anywhere
 * shows up. This is what turns "the same artifact" into something checkable. */
function hashTree(dir: string): string {
  const digest = createHash('sha256');
  for (const file of walk(dir)) {
    digest.update(relative(dir, file));
    digest.update(createHash('sha256').update(readFileSync(file)).digest());
  }
  return digest.digest('hex');
}

interface Gateway {
  base: string;
  log: () => string;
  stop: () => void;
}

let artifactDir = '';
let poison: Upstream;
let bUpstream: Upstream;
let cUpstream: Upstream;
let evil: Upstream;
let hashAtBuild = '';

async function startGateway(port: number, extraEnv: Record<string, string>): Promise<Gateway> {
  let log = '';
  // A MINIMAL environment, built from nothing rather than from process.env: the
  // "API_URL is unset" case has to be genuinely unset, not merely overwritten.
  const child: ChildProcess = spawn('node', ['apps/branch/server.js'], {
    cwd: artifactDir,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: 'production',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (chunk: Buffer) => (log += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (log += chunk.toString()));

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      // Any HTTP answer means the server is listening. The STATUS is what the
      // misconfiguration tests are about, so it must not be a readiness signal.
      await fetch(`${base}/api/__ready`);
      return { base, log: () => log, stop: () => child.kill('SIGKILL') };
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  child.kill('SIGKILL');
  throw new Error(`Gateway never answered on ${base}. Log:\n${log}`);
}

beforeAll(async () => {
  [poison, bUpstream, cUpstream, evil] = await Promise.all([
    startUpstream('POISON', POISON_PORT),
    startUpstream('UPSTREAM-B', B_PORT),
    startUpstream('UPSTREAM-C', C_PORT),
    startUpstream('EVIL', EVIL_PORT),
  ]);

  // Built ONCE, with a destination that must never be used.
  execFileSync('npx', ['next', 'build'], {
    cwd: BRANCH_ROOT,
    stdio: 'pipe',
    env: { ...process.env, API_URL: POISON_URL },
  });

  artifactDir = mkdtempSync(join(tmpdir(), 'fr-branch-artifact-'));
  cpSync(join(BRANCH_ROOT, '.next/standalone'), artifactDir, { recursive: true });
  cpSync(join(BRANCH_ROOT, '.next/static'), join(artifactDir, 'apps/branch/.next/static'), {
    recursive: true,
  });
  hashAtBuild = hashTree(artifactDir);
}, 900_000);

afterAll(async () => {
  if (artifactDir) rmSync(artifactDir, { recursive: true, force: true });
  await Promise.all(
    [poison, bUpstream, cUpstream, evil].map(
      (upstream) => new Promise((resolve) => upstream?.server.close(resolve)),
    ),
  );
});

describe('[F29-A] no build-time destination survives into the artifact', () => {
  it('runs from outside the repository', () => {
    // Both halves matter: an artifact under the repo could be satisfied by an
    // ancestor node_modules, and a relative check could pass by accident.
    expect(artifactDir.startsWith(tmpdir() + sep)).toBe(true);
    expect(artifactDir.startsWith(REPO_ROOT + sep)).toBe(false);
  });

  it('contains no rewrite rule at all', () => {
    const manifest = JSON.parse(
      readFileSync(join(BRANCH_ROOT, '.next/routes-manifest.json'), 'utf8'),
    ) as { rewrites: { beforeFiles: unknown[]; afterFiles: unknown[]; fallback: unknown[] } };
    // Pre-fix this held { source: '/api/:path*', destination: '<API_URL>/api/:path*' }.
    expect(manifest.rewrites.afterFiles).toEqual([]);
    expect(manifest.rewrites.beforeFiles).toEqual([]);
    expect(manifest.rewrites.fallback).toEqual([]);
  });

  it('contains no trace of the destination it was built with', () => {
    const needle = `127.0.0.1:${POISON_PORT}`;
    const carrying = walk(artifactDir).filter((file) =>
      readFileSync(file).includes(needle),
    );
    expect(carrying.map((file) => relative(artifactDir, file))).toEqual([]);
  });
});

describe('[F29-B] one immutable artifact, two environments', () => {
  it('routes to B, then to C, with no rebuild and no mutation', async () => {
    const first = await startGateway(3191, { API_URL: B_URL });
    let response = await fetch(`${first.base}/api/auth/me`);
    const fromB = (await response.json()) as { upstream: string };
    first.stop();

    const hashAfterB = hashTree(artifactDir);

    const second = await startGateway(3192, { API_URL: C_URL });
    response = await fetch(`${second.base}/api/auth/me`);
    const fromC = (await response.json()) as { upstream: string };
    second.stop();

    // The destination followed the environment, not the build.
    expect(fromB.upstream).toBe('UPSTREAM-B');
    expect(fromC.upstream).toBe('UPSTREAM-C');

    // ...and the artifact is the same artifact throughout. Pre-fix this was
    // also true, which is exactly why it was broken: identical bytes meant
    // identical routing.
    expect(hashAfterB).toBe(hashAtBuild);
    expect(hashTree(artifactDir)).toBe(hashAtBuild);
  }, 300_000);
});

describe('[F29-C][F29-D][F29-G] what crosses the gateway', () => {
  let gateway: Gateway;

  beforeAll(async () => {
    gateway = await startGateway(3193, { API_URL: B_URL });
  }, 120_000);

  afterAll(() => gateway?.stop());

  const lastSeen = (): Seen => {
    const seen = bUpstream.seen.at(-1);
    if (!seen) throw new Error('upstream B recorded nothing');
    return seen;
  };

  it('[D] forwards method, path, repeated query parameters and correlation id', async () => {
    const response = await fetch(
      `${gateway.base}/api/branches/b1/bookings?status=confirmed&status=checked_in&status=confirmed`,
      { headers: { 'x-request-id': 'corr-4f2a' } },
    );
    expect(response.status).toBe(200);
    const seen = lastSeen();
    expect(seen.method).toBe('GET');
    // The raw query string, duplicates and order intact.
    expect(seen.url).toBe(
      '/api/branches/b1/bookings?status=confirmed&status=checked_in&status=confirmed',
    );
    expect(seen.headers['x-request-id']).toBe('corr-4f2a');
  });

  it('[D] forwards a JSON body and its content type', async () => {
    const payload = JSON.stringify({ action: 'check_in' });
    const response = await fetch(`${gateway.base}/api/bookings/x/transition`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: payload,
    });
    expect(response.status).toBe(200);
    const seen = lastSeen();
    expect(seen.method).toBe('POST');
    expect(seen.body).toBe(payload);
    expect(seen.headers['content-type']).toBe('application/json');
    // Re-framed by the outgoing client, never copied from the inbound request.
    expect(seen.headers['content-length']).toBe(String(Buffer.byteLength(payload)));
  });

  it('[D] does not forward hop-by-hop headers', async () => {
    await fetch(`${gateway.base}/api/auth/me`, {
      headers: { te: 'trailers', 'proxy-authorization': 'Basic zzz' },
    });
    const seen = lastSeen();
    expect(seen.headers.te).toBeUndefined();
    expect(seen.headers['proxy-authorization']).toBeUndefined();
    expect(seen.headers.trailer).toBeUndefined();
    // `host` belongs to this hop; the upstream must see its own.
    expect(seen.headers.host).toBe(`127.0.0.1:${B_PORT}`);
  });

  it('[D] passes an upstream status through unchanged', async () => {
    const response = await fetch(`${gateway.base}/api/status/418`);
    expect(response.status).toBe(418);
    expect((await response.json()) as { upstream: string }).toMatchObject({
      upstream: 'UPSTREAM-B',
    });
  });

  it('[D] passes a body-less 204 through without inventing a body', async () => {
    const response = await fetch(`${gateway.base}/api/empty`);
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('x-upstream')).toBe('UPSTREAM-B');
  });

  it('[D] passes an upstream Cache-Control through, and defaults to no-store', async () => {
    const cacheable = await fetch(`${gateway.base}/api/cacheable`);
    expect(cacheable.headers.get('cache-control')).toBe('public, max-age=60');
    // The upstream echo route sets no Cache-Control; authenticated API traffic
    // must not become cacheable just because nobody said so.
    const plain = await fetch(`${gateway.base}/api/auth/me`);
    expect(plain.headers.get('cache-control')).toBe('private, no-store');
  });

  it('[C] forwards the request Cookie header', async () => {
    await fetch(`${gateway.base}/api/auth/me`, {
      headers: { cookie: 'fr_wf_session=session-value; other=1' },
    });
    expect(lastSeen().headers.cookie).toBe('fr_wf_session=session-value; other=1');
  });

  it('[C] preserves several Set-Cookie headers, deletion included', async () => {
    const response = await fetch(`${gateway.base}/api/cookies`);
    const cookies = response.headers.getSetCookie();
    // Three distinct cookies, not one comma-joined string: merging them would
    // silently drop the session cookie's attributes, and logout depends on its
    // own Max-Age=0 cookie arriving as a cookie.
    expect(cookies).toHaveLength(3);
    expect(cookies[0]).toBe('fr_wf_session=abc; Path=/; HttpOnly; SameSite=Lax');
    expect(cookies[1]).toBe('fr_flag=one; Path=/');
    expect(cookies[2]).toBe('fr_stale=; Path=/; Max-Age=0');
    expect(response.headers.get('x-upstream')).toBe('UPSTREAM-B');
  });

  it('[G] never lets a browser-supplied client address reach the API', async () => {
    await fetch(`${gateway.base}/api/auth/login`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '198.51.100.9',
        forwarded: 'for=198.51.100.9',
        'x-real-ip': '198.51.100.9',
        'cf-connecting-ip': '198.51.100.9',
        'true-client-ip': '198.51.100.9',
        'x-client-ip': '198.51.100.9',
      },
      body: JSON.stringify({ email: 'a@b.c', password: 'x' }),
    });
    const seen = lastSeen();
    for (const header of [
      'x-forwarded-for',
      'forwarded',
      'x-real-ip',
      'cf-connecting-ip',
      'true-client-ip',
      'x-client-ip',
    ]) {
      expect(seen.headers[header]).toBeUndefined();
    }
    // Nor does the gateway append a hop of its own: it is not trusted
    // infrastructure and does not pretend to be.
    expect(JSON.stringify(seen.headers)).not.toContain('198.51.100.9');
  });
});

/**
 * These go over a RAW SOCKET on purpose.
 *
 * `fetch()` resolves `/api/../internal` to `/internal` in the client's own URL
 * parser before a byte leaves the process, so a fetch-based traversal test
 * measures the test harness, not the gateway. An attacker writes the request
 * line by hand. So do these.
 */
function rawGet(
  port: number,
  path: string,
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${path} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let raw = '';
    socket.on('data', (chunk: Buffer) => (raw += chunk.toString()));
    socket.on('error', reject);
    socket.on('end', () => {
      const [head = '', ...rest] = raw.split('\r\n\r\n');
      const [statusLine = '', ...headerLines] = head.split('\r\n');
      const headers: Record<string, string> = {};
      for (const line of headerLines) {
        const at = line.indexOf(':');
        if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
      }
      // Chunk framing is left in: these assertions are about status, headers and
      // whether a known string is present, none of which need it decoded.
      resolve({ status: Number(statusLine.split(' ')[1] ?? 0), headers, body: rest.join('\r\n\r\n') });
    });
  });
}

describe('[F29-F] the gateway cannot be turned into an open proxy', () => {
  let gateway: Gateway;
  const PORT = 3194;

  beforeAll(async () => {
    gateway = await startGateway(PORT, { API_URL: B_URL });
  }, 120_000);

  afterAll(() => gateway?.stop());

  it.each(['/api/../internal', '/api/../../etc/passwd', '/api/%2e%2e/internal'])(
    'never forwards %s',
    async (path) => {
      const before = bUpstream.seen.length;
      const response = await rawGet(PORT, path);
      // MEASURED, and not what I first assumed: Next resolves dot segments —
      // percent-encoded ones included — before routing, so the path no longer
      // matches /api/[...path] and Next answers its own 404. The gateway's dot
      // segment check never runs for these. It stays because it is the layer
      // that would still hold if routing ever stopped normalising, and because
      // the invariant that matters is the one below: nothing was forwarded.
      expect(response.status).toBe(404);
      expect(bUpstream.seen.length).toBe(before);
    },
  );

  it.each([`/api/%2f%2f127.0.0.1:${EVIL_PORT}/x`, '/api/a%5cb', '/api/a%2fb'])(
    'refuses %s at the gateway, before any outbound request',
    async (path) => {
      const before = bUpstream.seen.length;
      const response = await rawGet(PORT, path);
      // An encoded separator survives normalisation, so these DO reach the
      // handler — and this is the check that stops them.
      expect(response.status).toBe(400);
      expect(response.headers['content-type']).toContain('application/json');
      expect(response.body).toContain('"code":"validation_error"');
      expect(response.body).toContain('Unsupported API path');
      expect(bUpstream.seen.length).toBe(before);
    },
  );

  it('does not redirect an authority-shaped path off this origin', async () => {
    const before = bUpstream.seen.length;
    const response = await rawGet(PORT, '//evil.host/api/x');
    // Next collapses the leading slashes and redirects; what matters is that
    // Location stays a path on this origin rather than becoming an absolute URL
    // pointing at evil.host, which would be an open redirect.
    expect(response.status).toBe(308);
    expect(response.headers.location).toBe('/evil.host/api/x');
    expect(response.headers.location?.startsWith('http')).toBe(false);
    expect(bUpstream.seen.length).toBe(before);
  });

  it('sends an absolute-URL-shaped path to the configured upstream, not to the URL in it', async () => {
    const response = await rawGet(PORT, `/api/http:/127.0.0.1:${EVIL_PORT}/steal`);
    // Whatever the upstream makes of that path, it was the CONFIGURED upstream
    // that made it. The origin is not negotiable from the request line.
    expect(response.status).toBe(200);
    expect(response.body).toContain('UPSTREAM-B');
  });

  it('never reached the evil upstream by any route', () => {
    expect(evil.seen).toEqual([]);
  });
});

describe('[F29-E] a missing or malformed destination fails deterministically', () => {
  const assertRefusal = async (gateway: Gateway): Promise<void> => {
    const response = await fetch(`${gateway.base}/api/auth/me`);
    expect(response.status).toBe(503);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    const text = await response.text();
    // Structured, not an HTML error page.
    expect(JSON.parse(text)).toEqual({
      error: { code: 'internal_error', message: 'API gateway is not configured' },
    });
    expect(text).not.toContain('<html');
    // No environment value, no internal topology, no stack.
    expect(text).not.toContain('localhost:3000');
    expect(text).not.toContain('API_URL');
    expect(text).not.toContain('at ');
  };

  it('refuses when the variable is absent', async () => {
    const gateway = await startGateway(3195, {});
    try {
      await assertRefusal(gateway);
      // And it refuses the SAME way every time — no first-request fallback.
      await assertRefusal(gateway);
    } finally {
      gateway.stop();
    }
  }, 120_000);

  it('refuses a value that is not a usable upstream origin', async () => {
    for (const [index, value] of [
      'not-a-url',
      'file:///etc/passwd',
      'http://user:pass@127.0.0.1:4192',
      'http://127.0.0.1:4192/prefix',
    ].entries()) {
      const gateway = await startGateway(3196 + index, { API_URL: value });
      try {
        await assertRefusal(gateway);
      } finally {
        gateway.stop();
      }
    }
  }, 300_000);
});

describe('[F29] an unreachable upstream is contained', () => {
  it('answers 502 without leaking where it tried to go', async () => {
    const gateway = await startGateway(3200, { API_URL: `http://127.0.0.1:${DEAD_PORT}` });
    try {
      const response = await fetch(`${gateway.base}/api/auth/me`);
      expect(response.status).toBe(502);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      const text = await response.text();
      expect(JSON.parse(text)).toEqual({
        error: { code: 'internal_error', message: 'API is unavailable' },
      });
      expect(text).not.toContain(String(DEAD_PORT));
      expect(text).not.toContain('ECONNREFUSED');
      expect(text).not.toContain('127.0.0.1');
      expect(text).not.toContain('<html');
    } finally {
      gateway.stop();
    }
  }, 120_000);
});

describe('[F29-A] the poisoned build destination was never used', () => {
  it('received nothing, from any test above', () => {
    // If a build-time value had survived anywhere, this is where it would show.
    expect(poison.seen).toEqual([]);
  });
});
