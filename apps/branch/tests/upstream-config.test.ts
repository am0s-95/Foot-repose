import { describe, expect, it } from 'vitest';
import {
  rejectUnsafePath,
  resolveTarget,
  resolveUpstream,
  UPSTREAM_VAR,
  UpstreamConfigError,
} from '../src/lib/upstream';

/**
 * [F29-E] and [F29-F], at the unit where the decisions are actually made.
 *
 * The end-to-end tests prove these rules hold through a real deployed artifact
 * over real sockets. These prove WHICH rule fired, which an HTTP status cannot
 * distinguish, and they enumerate the shapes cheaply enough to be exhaustive.
 */
const at = (value: string | undefined): Record<string, string | undefined> =>
  value === undefined ? {} : { [UPSTREAM_VAR]: value };

describe('[F29-E] a missing or malformed API destination fails closed', () => {
  it('refuses an unset variable rather than guessing localhost', () => {
    // The pre-fix code answered `?? 'http://localhost:3000'` here. In production
    // that is a frontend confidently proxying to nothing.
    expect(() => resolveUpstream(at(undefined))).toThrow(UpstreamConfigError);
    expect(() => resolveUpstream(at(''))).toThrow(UpstreamConfigError);
    expect(() => resolveUpstream(at('   '))).toThrow(UpstreamConfigError);
  });

  it.each([
    ['not-a-url', 'is not an absolute URL'],
    ['/api', 'is not an absolute URL'],
    ['api.internal:8080', 'must use http: or https:'],
    ['file:///etc/passwd', 'must use http: or https:'],
    ['ftp://api.internal', 'must use http: or https:'],
    ['http://user:pass@api.internal', 'must not contain credentials'],
    ['http://user@api.internal', 'must not contain credentials'],
    ['http://api.internal/?token=abc', 'must not contain a query string'],
    ['http://api.internal/#frag', 'must not contain a fragment'],
    ['http://api.internal/gateway', 'must not contain a path'],
  ])('refuses %s', (value, reason) => {
    expect(() => resolveUpstream(at(value))).toThrow(reason);
  });

  it('never puts the configured value into the failure reason', () => {
    // The reason reaches logs. Internal hostnames and tokens must not.
    const secret = 'http://svc-internal-7.cluster.local:9000/?token=s3cr3t';
    try {
      resolveUpstream(at(secret));
      throw new Error('expected a rejection');
    } catch (error) {
      const message = (error as Error).message;
      expect(error).toBeInstanceOf(UpstreamConfigError);
      expect(message).not.toContain('svc-internal-7');
      expect(message).not.toContain('s3cr3t');
    }
  });

  it.each(['http://127.0.0.1:4101', 'http://127.0.0.1:4101/', 'https://api.example.test'])(
    'accepts %s and reduces it to an origin',
    (value) => {
      const url = resolveUpstream(at(value));
      expect(url.href).toBe(new URL(value).origin + '/');
      expect(url.pathname).toBe('/');
    },
  );
});

describe('[F29-F] the request path cannot escape the configured upstream', () => {
  const upstream = new URL('http://127.0.0.1:4101');

  it('forwards an ordinary path unchanged, query included', () => {
    const target = resolveTarget('/api/branches/abc/bookings', '?date=2026-07-30', upstream);
    expect(target?.href).toBe('http://127.0.0.1:4101/api/branches/abc/bookings?date=2026-07-30');
  });

  it('preserves repeated query parameters exactly', () => {
    // Rebuilding the query through URLSearchParams is where duplicates get
    // collapsed or reordered; the raw string is passed through instead.
    const target = resolveTarget('/api/x', '?status=a&status=b&status=a', upstream);
    expect(target?.search).toBe('?status=a&status=b&status=a');
  });

  it.each([
    ['/api/../admin', 'dot segment'],
    ['/api/../../etc/passwd', 'dot segments'],
    ['/api/%2e%2e/admin', 'encoded dot segment'],
    ['/api/a%2fb', 'encoded separator'],
    ['/api/a%5cb', 'encoded backslash'],
    ['/api/a\\b', 'literal backslash'],
    ['/internal/secrets', 'outside the gateway prefix'],
    ['/', 'outside the gateway prefix'],
  ])('refuses %s (%s)', (pathname) => {
    expect(rejectUnsafePath(pathname)).not.toBeNull();
    expect(resolveTarget(pathname, '', upstream)).toBeNull();
  });

  it('cannot be turned into an open proxy by an authority-shaped path', () => {
    // `new URL('//evil.host/x', base)` resolves to evil.host, not to base. The
    // prefix check refuses it first; the origin assertion refuses it again.
    expect(resolveTarget('//evil.host/api/x', '', upstream)).toBeNull();
    expect(resolveTarget('/api//evil.host/x', '', upstream)?.origin).toBe(upstream.origin);
    expect(resolveTarget('/api/http://evil.host/x', '', upstream)?.origin).toBe(upstream.origin);
  });

  it('keeps every accepted target on the configured origin', () => {
    for (const pathname of ['/api/x', '/api/a/b/c', '/api/%20', "/api/a'b", '/api/:x@y']) {
      const target = resolveTarget(pathname, '', upstream);
      if (target !== null) expect(target.origin).toBe(upstream.origin);
    }
  });
});
