/**
 * [F29] Where the Branch app's API traffic actually goes — decided at RUNTIME.
 *
 * This used to be a `rewrites()` entry in `next.config.ts`. `rewrites()` runs
 * during `next build`, so the destination was written into
 * `.next/routes-manifest.json` and frozen there. Measured on the pre-fix tree:
 * an artifact built with `API_URL=http://127.0.0.1:4101` and then started with
 * `API_URL=http://127.0.0.1:4102` sent every `/api/*` request to 4101 — 4102
 * received zero. The artifact bytes did not change; only a rebuild moved it.
 * That means an artifact cannot be promoted between environments, and the
 * artifact that was tested is never the artifact that ships.
 *
 * So the destination is read from the environment on each request instead, and
 * the browser keeps talking to its own origin (see the gateway route).
 *
 * There is NO fallback. A missing or malformed value fails closed: guessing
 * `http://localhost:3000` in production is how a frontend silently answers
 * nothing, or worse, answers from somewhere unintended.
 */
export const UPSTREAM_VAR = 'API_URL';

export class UpstreamConfigError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'UpstreamConfigError';
  }
}

/**
 * The configured API origin, or a thrown `UpstreamConfigError`.
 *
 * The returned URL is an ORIGIN and nothing else — scheme, host, port. Every
 * other URL component is rejected rather than normalised away, because each one
 * is a way for the forwarded path to mean something other than it reads:
 *
 *   * a non-http(s) scheme (`file:`, `data:`, `gopher:`) is not a web upstream;
 *   * credentials in the URL would be sent on every proxied request;
 *   * a query or fragment cannot survive being concatenated with the request's
 *     own query — it would be silently dropped or would swallow it;
 *   * a path prefix makes "which part of the outgoing path came from the
 *     caller" ambiguous, which is exactly the ambiguity a gateway must not have.
 *
 * The reason text names the RULE, never the value: this string reaches logs, and
 * the configured value can contain internal hostnames.
 */
export function resolveUpstream(env: Record<string, string | undefined> = process.env): URL {
  const raw = env[UPSTREAM_VAR]?.trim();
  if (!raw) {
    throw new UpstreamConfigError(`${UPSTREAM_VAR} is not set`);
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UpstreamConfigError(`${UPSTREAM_VAR} is not an absolute URL`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new UpstreamConfigError(`${UPSTREAM_VAR} must use http: or https:`);
  }
  if (url.username !== '' || url.password !== '') {
    throw new UpstreamConfigError(`${UPSTREAM_VAR} must not contain credentials`);
  }
  if (url.search !== '') {
    throw new UpstreamConfigError(`${UPSTREAM_VAR} must not contain a query string`);
  }
  if (url.hash !== '') {
    throw new UpstreamConfigError(`${UPSTREAM_VAR} must not contain a fragment`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new UpstreamConfigError(`${UPSTREAM_VAR} must not contain a path`);
  }

  // `origin` drops anything the checks above did not already refuse, so the
  // value the gateway resolves against is provably just an origin.
  return new URL(url.origin);
}

/**
 * The prefix this gateway owns. Everything it forwards starts here, on both
 * sides, so the caller cannot address anything else on the upstream.
 */
export const GATEWAY_PREFIX = '/api/';

/**
 * Reject a request path that could mean something other than it reads.
 *
 * A gateway turns a caller-supplied string into an outbound URL, so the only
 * safe posture is to refuse anything that could re-point that URL rather than
 * to try to normalise it:
 *
 *   * dot segments (`.`, `..`) climb out of the prefix;
 *   * `%2e` hides a dot segment from a literal comparison, and `%2f` / `%5c`
 *     hide a separator — a path that survives this check means the same thing
 *     before and after decoding;
 *   * a backslash is a separator to some servers and a literal to others.
 *
 * Measured on the deployed artifact: Next's router resolves dot segments —
 * percent-encoded ones included — BEFORE a request can match this route, so in
 * this deployment those cases 404 without ever reaching here, and it is the
 * encoded-separator cases that this check actually refuses. The dot-segment
 * rules stay because they cost nothing and do not depend on that behaviour
 * continuing to hold.
 *
 * Returns `null` when the path is acceptable, or a reason when it is not.
 * `resolveTarget` still asserts the resulting ORIGIN afterwards: this check is
 * the explanation, that assertion is the guarantee.
 */
export function rejectUnsafePath(pathname: string): string | null {
  if (!pathname.startsWith(GATEWAY_PREFIX)) return 'path is outside the gateway prefix';
  if (pathname.includes('\\')) return 'path contains a backslash';
  const lowered = pathname.toLowerCase();
  for (const encoded of ['%2e', '%2f', '%5c']) {
    if (lowered.includes(encoded)) return `path contains ${encoded}`;
  }
  for (const segment of pathname.split('/')) {
    if (segment === '.' || segment === '..') return 'path contains a dot segment';
  }
  return null;
}

/**
 * The outbound URL, or `null` when the request must not be forwarded.
 *
 * `search` is passed through as the RAW query string rather than rebuilt from
 * `URLSearchParams`, so repeated parameters keep their order and their count.
 *
 * The origin assertion at the end is not defensive decoration. `new URL()`
 * against a base honours anything that looks like an authority — `//evil.host/x`
 * resolves to `evil.host`, not to the base — so the only way to know the result
 * is still the configured upstream is to compare it.
 */
export function resolveTarget(pathname: string, search: string, upstream: URL): URL | null {
  if (rejectUnsafePath(pathname) !== null) return null;
  let target: URL;
  try {
    target = new URL(pathname + search, upstream);
  } catch {
    return null;
  }
  if (target.origin !== upstream.origin) return null;
  if (!target.pathname.startsWith(GATEWAY_PREFIX)) return null;
  return target;
}
