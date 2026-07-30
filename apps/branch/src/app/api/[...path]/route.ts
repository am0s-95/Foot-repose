import { resolveTarget, resolveUpstream, UpstreamConfigError } from '../../../lib/upstream';

/**
 * [F29] The Branch app's API gateway.
 *
 * The browser only ever calls this origin: `/api/*`, relative, same-site. That
 * is what lets the session cookie be HttpOnly, SameSite and origin-bound with no
 * CORS anywhere, and it is why this replaced a build-time `rewrites()` rather
 * than being deleted in favour of pointing the browser at the API directly.
 * From the browser's side nothing changed at all — the same relative URLs, the
 * same cookies. What changed is that the destination is now read per request
 * instead of being compiled in.
 *
 * `force-dynamic` because a proxy that could be cached or prerendered is not a
 * proxy; `nodejs` because that is where the deployment runs.
 */
export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

/**
 * Hop-by-hop headers (RFC 9110 §7.6.1) describe THIS connection, not the
 * message. Forwarding them attaches one connection's framing and upgrade
 * negotiation to a different connection.
 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

/**
 * [F1] Every header by which a caller can describe the hop it came through.
 *
 * All of these are caller-controlled. The API sits behind this gateway, so
 * forwarding any of them means the API is reading a browser-supplied string.
 * `trustedClientIp` already refuses to believe `x-forwarded-for` unless
 * `TRUSTED_PROXY_HOPS` says a real boundary exists — this makes sure the gateway
 * is not the thing that quietly manufactures one. Nothing here appends a hop
 * either: this gateway does not claim to be trusted infrastructure, so
 * `sessions.ip` and `audit_logs.ip` stay null exactly as they were.
 *
 * The `x-forwarded-host`/`-proto`/`-port` trio needs saying explicitly, because
 * Next's own server SYNTHESISES them from the caller's `Host` header — so they
 * are present even when the caller sends none, and they carry whatever `Host`
 * the caller chose. Nothing in the API reads them today. Forwarding them anyway
 * leaves a value that LOOKS authoritative sitting in front of whatever
 * middleware is added next, which is the whole shape of the bug F1 closed.
 */
const FORWARDING_CLAIMS = new Set([
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-forwarded-prefix',
]);

/**
 * Headers whose value describes the message we are NOT relaying verbatim.
 * `host` belongs to this origin; `content-length` describes the inbound framing,
 * and the outgoing body is re-framed by the client, so a copied value would be
 * a stale one.
 */
const REQUEST_ONLY = new Set(['host', 'content-length']);

/**
 * `fetch` decodes the response body before we see it, so the upstream's
 * `content-encoding` and `content-length` describe bytes that no longer exist.
 *
 * The caching trio goes too, and is replaced rather than defaulted — see
 * `inboundHeaders`.
 */
const RESPONSE_ONLY = new Set([
  'content-encoding',
  'content-length',
  'cache-control',
  'expires',
  'pragma',
]);

const GATEWAY_MISCONFIGURED = 503;
const UPSTREAM_UNAVAILABLE = 502;

/**
 * The API's error contract, reused so a gateway failure is the same shape the
 * client already parses. The messages are constants: the configured URL, the
 * DNS or connect error and the stack stay on this side of the wire.
 */
function gatewayError(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { code: 'internal_error', message } }), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: { code: 'validation_error', message } }), {
    status: 400,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
  });
}

function outboundHeaders(req: Request): Headers {
  const headers = new Headers();
  req.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    if (HOP_BY_HOP.has(key) || REQUEST_ONLY.has(key) || FORWARDING_CLAIMS.has(key)) return;
    headers.append(name, value);
  });
  return headers;
}

function inboundHeaders(upstream: Response): Headers {
  const headers = new Headers();
  upstream.headers.forEach((value, name) => {
    const key = name.toLowerCase();
    // Set-Cookie is handled separately: iterating Headers collapses repeats into
    // one comma-joined value, which would merge several cookies into one broken
    // one. Logout depends on its own Set-Cookie arriving intact.
    if (HOP_BY_HOP.has(key) || RESPONSE_ONLY.has(key) || key === 'set-cookie') return;
    headers.append(name, value);
  });
  for (const cookie of upstream.headers.getSetCookie()) {
    headers.append('set-cookie', cookie);
  }
  // Every branch /api/* response carries workforce authentication and per-actor
  // data, so this is a CEILING on the upstream's discretion, not a default it
  // can opt out of. It used to be applied only when the upstream said nothing,
  // which meant an upstream `public, max-age=60` passed straight through and a
  // shared cache was free to store and re-serve one employee's data to another.
  // The upstream's own caching headers are dropped above rather than merged,
  // because a surviving `Expires` or `Pragma` is still a directive.
  headers.set('cache-control', 'private, no-store');
  return headers;
}

async function forward(req: Request): Promise<Response> {
  let upstream: URL;
  try {
    upstream = resolveUpstream();
  } catch (error) {
    if (error instanceof UpstreamConfigError) {
      // The reason names the rule, not the value — safe to log, useless to leak.
      console.error(`[gateway] refusing to forward: ${error.message}`);
      return gatewayError(GATEWAY_MISCONFIGURED, 'API gateway is not configured');
    }
    throw error;
  }

  const incoming = new URL(req.url);
  const target = resolveTarget(incoming.pathname, incoming.search, upstream);
  if (target === null) return badRequest('Unsupported API path');

  // STREAMED, not buffered. Reading the body first would hold an entire
  // attacker-chosen payload in this process before the upstream — which has the
  // body limits — ever sees a byte, and this gateway is reachable
  // unauthenticated. "These are small JSON requests" was a description of the
  // intended callers, not a boundary anyone has to respect. `duplex: 'half'` is
  // what undici requires to send a stream body; GET and HEAD have no body to
  // send, and an absent body stays absent.
  const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : (req.body ?? undefined);

  let response: Response;
  try {
    response = await fetch(target, {
      method: req.method,
      headers: outboundHeaders(req),
      body,
      duplex: 'half',
      redirect: 'manual',
      // Nothing here is cacheable, and no retry: a repeated POST is a second
      // booking transition, not a retry.
      cache: 'no-store',
    } as RequestInit & { duplex: 'half' });
  } catch (error) {
    console.error('[gateway] upstream request failed:', error);
    return gatewayError(UPSTREAM_UNAVAILABLE, 'API is unavailable');
  }

  // 204 and 304 are defined to carry no body; handing one to `Response` throws.
  const bodyless = response.status === 204 || response.status === 304;
  let payload: ArrayBuffer | null = null;
  if (!bodyless) {
    try {
      payload = await response.arrayBuffer();
    } catch (error) {
      // `fetch` resolved as soon as the status and headers arrived, so an
      // upstream that then resets the connection, under-delivers against its own
      // Content-Length, or sends a malformed compressed body fails HERE — after
      // the guard above. Left unguarded this rejected out of the handler and
      // Next answered an unstructured HTML 500. It is the same upstream failure
      // as a refused connection and gets the same answer.
      console.error('[gateway] upstream response body failed:', error);
      return gatewayError(UPSTREAM_UNAVAILABLE, 'API is unavailable');
    }
  }

  return new Response(payload, {
    status: response.status,
    statusText: response.statusText,
    headers: inboundHeaders(response),
  });
}

export const GET = forward;
export const HEAD = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
export const OPTIONS = forward;
