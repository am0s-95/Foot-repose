import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { resetAllLoginAttempts } from '@foot-repose/db';
import { closePool, getPool } from '../src/lib/pool';
import { POST as loginPost } from '../src/app/api/auth/login/route';
import { trustedClientIp, trustedProxyHops } from '../src/lib/client-ip';
import {
  DUMMY_HASH,
  MAX_CONCURRENT_VERIFICATIONS,
  PASSWORD_COST,
  shutdownPasswordWorkers,
  verificationGate,
  verifyPassword,
  VerificationOverloadError,
} from '../src/modules/auth/password';
import {
  LOGIN_RATE_LIMIT,
  loginIdentifierKey,
  loginSourceKey,
} from '../src/modules/auth/rate-limit';
import { countAuditRows, setupFixtures, TEST_PASSWORD, type Fixtures } from './helpers';

/**
 * F1 — login abuse boundary.
 *
 * Two defects, one threat model: an UNAUTHENTICATED caller decides both how many
 * login attempts to make and what `X-Forwarded-For` says. Before this change
 * that meant (a) rotating the header handed out a fresh rate-limit counter per
 * attempt, and (b) each attempt ran a synchronous bcrypt compare that stopped
 * the whole process.
 */
let fx: Fixtures;

beforeAll(async () => {
  fx = await setupFixtures();
});

afterAll(async () => {
  await shutdownPasswordWorkers();
  await closePool();
});

beforeEach(async () => {
  await resetAllLoginAttempts(getPool());
});

/** A login attempt with an attacker-chosen forwarding header. */
const attempt = (email: string, forwardedFor?: string, password = 'wrong-password') =>
  loginPost(
    new Request('http://test.local/api/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(forwardedFor === undefined ? {} : { 'x-forwarded-for': forwardedFor }),
      },
      body: JSON.stringify({ email, password }),
    }),
  );

const attemptsFor = async (key: string): Promise<number> => {
  const row = await getPool().query<{ total: string }>(
    'SELECT coalesce(sum(attempts), 0) AS total FROM login_rate_limits WHERE key = $1',
    [key],
  );
  return Number(row.rows[0]!.total);
};

/**
 * Fill the verification gate through its own API and keep it full until
 * released. No fake work, no race against a real comparison finishing early:
 * the gate is simply in the state under test.
 */
const holdGate = (): { release: () => void } => {
  let taken = 0;
  while (verificationGate.tryAcquire()) taken += 1;
  expect(taken).toBe(MAX_CONCURRENT_VERIFICATIONS);
  return {
    release: () => {
      for (let i = 0; i < taken; i += 1) verificationGate.release();
    },
  };
};

const keysLike = async (pattern: string): Promise<string[]> => {
  const rows = await getPool().query<{ key: string }>(
    'SELECT DISTINCT key FROM login_rate_limits WHERE key LIKE $1 ORDER BY key',
    [pattern],
  );
  return rows.rows.map((r) => r.key);
};

describe('[F1a] rotated X-Forwarded-For cannot buy fresh attempts', () => {
  it('keeps ONE counter for one email across more than MAX_ATTEMPTS distinct forged addresses', async () => {
    const email = 'rotated@test.example';
    const statuses: number[] = [];
    // One distinct attacker-controlled address per attempt — the exact shape
    // that used to reset the counter every time.
    for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_ATTEMPTS + 3; i += 1) {
      statuses.push((await attempt(email, `203.0.113.${i + 1}`)).status);
    }
    // The allowance is spent once, not once per address.
    expect(statuses.slice(0, LOGIN_RATE_LIMIT.MAX_ATTEMPTS)).toEqual(
      Array(LOGIN_RATE_LIMIT.MAX_ATTEMPTS).fill(401),
    );
    expect(statuses.slice(LOGIN_RATE_LIMIT.MAX_ATTEMPTS)).toEqual([429, 429, 429]);
    // Every attempt landed in the same identifier bucket...
    expect(await attemptsFor(loginIdentifierKey(email))).toBe(LOGIN_RATE_LIMIT.MAX_ATTEMPTS + 3);
    // ...and no per-address bucket exists at all, because no address is trusted.
    expect(await keysLike('login:ip:%')).toEqual([]);
  }, 60_000);

  it('throttles on the first request past the allowance even when the header changes every time', async () => {
    const email = 'firstpast@test.example';
    for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_ATTEMPTS; i += 1) {
      expect((await attempt(email, `198.51.100.${i + 1}`)).status).toBe(401);
    }
    const throttled = await attempt(email, '198.51.100.250');
    expect(throttled.status).toBe(429);
    expect((await throttled.json()).error.code).toBe('rate_limited');
    expect(throttled.headers.get('cache-control')).toBe('private, no-store');
  }, 60_000);
});

describe('[F1b] the counted identity is the NORMALIZED email', () => {
  it('shares one counter across case and whitespace variants', async () => {
    const variants = [
      'Mixed.Case@Test.Example',
      'mixed.case@test.example',
      '  mixed.case@test.example  ',
      'MIXED.CASE@TEST.EXAMPLE',
    ];
    for (const variant of variants) {
      expect((await attempt(variant, '203.0.113.7')).status).toBe(401);
    }
    expect(await attemptsFor(loginIdentifierKey('mixed.case@test.example'))).toBe(variants.length);
    expect(await keysLike('login:id:%')).toEqual([loginIdentifierKey('mixed.case@test.example')]);
  }, 30_000);
});

describe('[F1c] untrusted forwarding data influences nothing', () => {
  it('ignores malformed, single and comma-chained values alike', async () => {
    const email = 'shapes@test.example';
    const shapes = [
      undefined,
      '',
      'not-an-ip',
      '10.0.0.1',
      '10.0.0.1, 10.0.0.2, 10.0.0.3',
      '  , ,  ',
      '::1',
      '999.999.999.999',
      'localhost, <script>, 1.2.3.4',
    ];
    for (const shape of shapes) {
      expect((await attempt(email, shape)).status).toBe(401);
    }
    // Every shape counted once, in the same bucket, with no address bucket.
    expect(await attemptsFor(loginIdentifierKey(email))).toBe(shapes.length);
    expect(await keysLike('login:ip:%')).toEqual([]);
  }, 60_000);

  it('never writes a forwarded value as a trusted session or audit address', async () => {
    const spoof = '203.0.113.99';
    // A FAILED attempt...
    await attempt('staff.a@test.example', spoof);
    // ...and a SUCCESSFUL one, which also creates a session row.
    const ok = await loginPost(
      new Request('http://test.local/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': spoof },
        body: JSON.stringify({ email: 'staff.a@test.example', password: TEST_PASSWORD }),
      }),
    );
    expect(ok.status).toBe(200);

    const audit = await getPool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM audit_logs WHERE ip = $1 OR metadata::text LIKE '%' || $1 || '%'",
      [spoof],
    );
    expect(audit.rows[0]!.n).toBe(0);
    const sessions = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sessions WHERE ip = $1',
      [spoof],
    );
    expect(sessions.rows[0]!.n).toBe(0);
  }, 30_000);

  it('returns null with no trusted-proxy contract, and applies the exact hop rule when one is declared', () => {
    const req = (xff: string): Request =>
      new Request('http://test.local/api/auth/login', { headers: { 'x-forwarded-for': xff } });

    expect(trustedProxyHops()).toBe(0);
    expect(trustedClientIp(req('1.2.3.4, 5.6.7.8'))).toBeNull();

    const previous = process.env.TRUSTED_PROXY_HOPS;
    try {
      // One trusted hop: the authoritative address is the one that hop appended
      // — the RIGHT-most entry — never the left-most value the caller chose.
      process.env.TRUSTED_PROXY_HOPS = '1';
      expect(trustedClientIp(req('9.9.9.9, 5.6.7.8'))).toBe('5.6.7.8');
      expect(trustedClientIp(req('5.6.7.8'))).toBe('5.6.7.8');
      // Two trusted hops: the FIRST entry of the two-element trusted suffix.
      process.env.TRUSTED_PROXY_HOPS = '2';
      expect(trustedClientIp(req('9.9.9.9, 5.6.7.8, 10.0.0.1'))).toBe('5.6.7.8');
      // The exact reported case: an empty trailing element with N=2 used to
      // compact down to two entries and return the UNTRUSTED left-hand value.
      expect(trustedClientIp(req('198.51.100.9, 203.0.113.7,'))).toBeNull();
      // Every entry of the trusted suffix is validated, not only the one
      // returned: a malformed NON-candidate hop disqualifies the chain too.
      expect(trustedClientIp(req('9.9.9.9, 5.6.7.8, not-an-ip'))).toBeNull();
      expect(trustedClientIp(req('9.9.9.9, 5.6.7.8, 10.0.0.1:443'))).toBeNull();
      expect(trustedClientIp(req('9.9.9.9, not-an-ip, 10.0.0.1'))).toBeNull();
      // ...while junk further LEFT is still ignored, as it must be.
      expect(trustedClientIp(req('<script>, 5.6.7.8, 10.0.0.1'))).toBe('5.6.7.8');
      expect(trustedClientIp(req(', , 5.6.7.8, 10.0.0.1'))).toBe('5.6.7.8');
      // Fewer entries than declared hops means the request did not traverse the
      // expected boundary: fail closed rather than guess.
      expect(trustedClientIp(req('5.6.7.8'))).toBeNull();
      // Malformed candidates are refused even inside the trusted position.
      process.env.TRUSTED_PROXY_HOPS = '1';
      expect(trustedClientIp(req('1.2.3.4, not-an-ip'))).toBeNull();
      expect(trustedClientIp(req('1.2.3.4, 999.999.999.999'))).toBeNull();
      expect(trustedClientIp(req('1.2.3.4, 5.6.7.8:1234'))).toBeNull();
      // An EMPTY trailing element is an element. Compacting the chain would
      // slide 203.0.113.7 into the trusted slot and hand back an untrusted
      // value; positions are preserved, so this fails closed instead.
      expect(trustedClientIp(req('198.51.100.9, 203.0.113.7,'))).toBeNull();
      expect(trustedClientIp(req('5.6.7.8, '))).toBeNull();
      expect(trustedClientIp(req(', 5.6.7.8'))).toBe('5.6.7.8');
      // IPv6 is a real address, not a parse failure.
      expect(trustedClientIp(req('1.2.3.4, 2001:db8::1'))).toBe('2001:db8::1');
      // A nonsense contract is refused loudly rather than silently trusting.
      process.env.TRUSTED_PROXY_HOPS = 'yes-please';
      expect(() => trustedClientIp(req('1.2.3.4'))).toThrow(/TRUSTED_PROXY_HOPS/);
    } finally {
      if (previous === undefined) delete process.env.TRUSTED_PROXY_HOPS;
      else process.env.TRUSTED_PROXY_HOPS = previous;
    }
    expect(trustedProxyHops()).toBe(0);
  });

  it('counts an authoritative address separately once a boundary IS declared', async () => {
    const previous = process.env.TRUSTED_PROXY_HOPS;
    process.env.TRUSTED_PROXY_HOPS = '1';
    try {
      await attempt('sourced@test.example', '9.9.9.9, 192.0.2.44');
      expect(await attemptsFor(loginSourceKey('192.0.2.44'))).toBe(1);
      // The caller-chosen left-hand value is still not a bucket.
      expect(await attemptsFor(loginSourceKey('9.9.9.9'))).toBe(0);
    } finally {
      if (previous === undefined) delete process.env.TRUSTED_PROXY_HOPS;
      else process.env.TRUSTED_PROXY_HOPS = previous;
    }
  }, 30_000);
});

describe('[F1d] concurrency', () => {
  it('loses no increment when attempts for one identifier arrive together', async () => {
    const email = 'concurrent@test.example';
    const parallel = 12;
    await Promise.all(
      Array.from({ length: parallel }, (_, i) => attempt(email, `192.0.2.${i + 1}`)),
    );
    expect(await attemptsFor(loginIdentifierKey(email))).toBe(parallel);
  }, 60_000);
});

describe('[F1e] password verification is asynchronous and bounded', () => {
  it('uses the production work factor for the unknown-email path', () => {
    expect(DUMMY_HASH.split('$')[2]).toBe(String(PASSWORD_COST).padStart(2, '0'));
  });

  it('yields to the event loop while a verification is pending', async () => {
    // Deterministic ORDERING, not a millisecond threshold: the timer is armed in
    // the same synchronous block that starts verification. A synchronous compare
    // cannot let it run first; an asynchronous one must.
    const order: string[] = [];
    const ticked = new Promise<void>((resolve) => {
      setTimeout(() => {
        order.push('timer');
        resolve();
      }, 0);
    });
    const verified = verifyPassword('some-password', null).then(() => {
      order.push('verify');
    });
    await Promise.all([ticked, verified]);
    expect(order[0]).toBe('timer');
  }, 30_000);

  it('refuses work past the explicit bound instead of queueing without limit', async () => {
    const inFlight = Array.from({ length: MAX_CONCURRENT_VERIFICATIONS }, () =>
      verifyPassword('some-password', null),
    );
    // Synchronously after dispatch every permit is taken — no timing guess.
    expect(verificationGate.inUse()).toBe(MAX_CONCURRENT_VERIFICATIONS);
    // The gate is full, so the next arrival is refused rather than admitted.
    await expect(verifyPassword('some-password', null)).rejects.toBeInstanceOf(
      VerificationOverloadError,
    );
    await Promise.all(inFlight);
    expect(verificationGate.inUse()).toBe(0);
    // ...and the gate reopens once the in-flight work drains.
    await expect(verifyPassword('some-password', null)).resolves.toBe(false);
  }, 30_000);

  it('answers a saturated gate exactly like throttling, and records it separately', async () => {
    const before = await countAuditRows('auth.login_verification_rejected');
    // Occupy every slot and KEEP them occupied for the whole probe, so the two
    // requests below cannot win a race against the gate draining.
    const gate = holdGate();
    // Two requests under saturation: one for a REAL account with the CORRECT
    // password, one for an unknown address. Both must look identical on the wire.
    const [real, unknown] = await Promise.all([
      attempt('staff.a@test.example', undefined, TEST_PASSWORD),
      attempt('no-such-person@test.example'),
    ]);
    gate.release();
    expect(real.status).toBe(429);
    expect(unknown.status).toBe(429);
    expect(await real.json()).toEqual(await unknown.json());
    expect(real.headers.get('cache-control')).toBe('private, no-store');
    expect(await countAuditRows('auth.login_verification_rejected')).toBe(before + 2);
  }, 30_000);

  it('never calls a blocking bcrypt primitive on the request thread', () => {
    // Exactly one file may contain a synchronous primitive: the worker script,
    // where blocking a dedicated thread IS the mechanism. Asserted as an
    // allowlist of one so a second exception cannot appear unnoticed.
    const allowed = 'verify-worker-source.ts';
    const offenders: string[] = [];
    const exceptions: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) {
          walk(full);
          continue;
        }
        if (!/\.[cm]?tsx?$/.test(entry)) continue;
        const source = readFileSync(full, 'utf8');
        if (!/\b(?:hashSync|compareSync|genSaltSync)\s*\(/.test(source)) continue;
        if (entry === allowed) {
          exceptions.push(full);
          continue;
        }
        offenders.push(full);
      }
    };
    walk(new URL('../src', import.meta.url).pathname);
    expect(offenders).toEqual([]);
    expect(exceptions.map((path) => path.split('/').pop())).toEqual([allowed]);
  });
});

describe('[F1f] authentication invariants still hold', () => {
  it('still issues a revocable session for correct credentials', async () => {
    const response = await attempt('staff.a@test.example', undefined, TEST_PASSWORD);
    expect(response.status).toBe(200);
    const cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('fr_wf_session=');
    expect(cookie).toContain('HttpOnly');
    const sessions = await getPool().query<{ n: number }>(
      'SELECT count(*)::int AS n FROM sessions WHERE employee_id = $1 AND revoked_at IS NULL',
      [fx.staffA.id],
    );
    expect(sessions.rows[0]!.n).toBeGreaterThanOrEqual(1);
  }, 30_000);

  it('gives wrong password, unknown email and inactive employee the SAME public answer', async () => {
    const responses = await Promise.all([
      attempt('staff.a@test.example', undefined, 'definitely-wrong'),
      attempt('nobody-at-all@test.example', undefined, TEST_PASSWORD),
      attempt('gone@test.example', undefined, TEST_PASSWORD),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    }
    const bodies = await Promise.all(responses.map((r) => r.json()));
    expect(bodies[1]).toEqual(bodies[0]);
    expect(bodies[2]).toEqual(bodies[0]);
  }, 30_000);

  it('clears only the account that succeeded, never a shared counter', async () => {
    const mine = 'clears-mine@test.example';
    await attempt(mine);
    await attempt(mine);
    const other = 'clears-other@test.example';
    await attempt(other);
    expect(await attemptsFor(loginIdentifierKey(mine))).toBe(2);

    // A success on staff.a clears staff.a's bucket and nothing else.
    await attempt('staff.a@test.example', undefined, 'wrong-first');
    expect(await attemptsFor(loginIdentifierKey('staff.a@test.example'))).toBe(1);
    expect((await attempt('staff.a@test.example', undefined, TEST_PASSWORD)).status).toBe(200);
    expect(await attemptsFor(loginIdentifierKey('staff.a@test.example'))).toBe(0);
    expect(await attemptsFor(loginIdentifierKey(mine))).toBe(2);
    expect(await attemptsFor(loginIdentifierKey(other))).toBe(1);
  }, 30_000);

  it('does not verify a password at all once the identifier is throttled', async () => {
    const email = 'no-verify@test.example';
    for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_ATTEMPTS; i += 1) await attempt(email);
    // Saturate the verification gate. If a throttled request tried to verify, it
    // would be refused by the gate and audited as a verification rejection; it
    // must instead be refused by the rate limiter, before any expensive work.
    const gate = holdGate();
    const beforeThrottled = await countAuditRows('auth.login_rate_limited');
    const beforeRejected = await countAuditRows('auth.login_verification_rejected');
    const response = await attempt(email);
    gate.release();
    expect(response.status).toBe(429);
    expect(await countAuditRows('auth.login_rate_limited')).toBe(beforeThrottled + 1);
    expect(await countAuditRows('auth.login_verification_rejected')).toBe(beforeRejected);
  }, 60_000);

  it('audits failures and throttles without ever logging a secret', async () => {
    const email = 'audited@test.example';
    const secret = 'super-secret-password-value';
    for (let i = 0; i < LOGIN_RATE_LIMIT.MAX_ATTEMPTS + 1; i += 1) {
      await attempt(email, undefined, secret);
    }
    expect(await countAuditRows('auth.login_rate_limited')).toBeGreaterThanOrEqual(1);
    const leaked = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM audit_logs
       WHERE metadata::text LIKE '%' || $1 || '%' OR metadata::text ILIKE '%password%'
          OR metadata::text ILIKE '%hash%' OR metadata::text ILIKE '%token%'`,
      [secret],
    );
    expect(leaked.rows[0]!.n).toBe(0);
  }, 60_000);
});
