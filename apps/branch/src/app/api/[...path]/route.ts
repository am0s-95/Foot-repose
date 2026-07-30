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
 * [F1] Client-address claims. Anyone can send these; the API is behind this
 * gateway, so if they were forwarded the API would be reading a browser-supplied
 * string. `trustedClientIp` already refuses to believe `x-forwarded-for` unless
 * `TRUSTED_PROXY_HOPS` says a real boundary exists — this makes sure the gateway
 * is not the thing that quietly manufactures one. Nothing here appends a hop
 * either: this gateway does not claim to be trusted infrastructure, so
 * `sessions.ip` and `audit_logs.ip` stay null exactly as they were.
 */
const CLIENT_IP_CLAIMS = new Set([
  'x-forwarded-for',
  'forwarded',
  'x-real-ip',
  'cf-connecting-ip',
  'true-client-ip',
  'x-client-ip',
]);

/**
 * Headers whose value describes the message we are NOT relaying verbatim.
 * `host` belongs to this origin; `content-length` describes the body we read,
 * and the outgoing body is re-framed by the client, so a copied value would be
 * a stale one.
 */
const REQUEST_ONLY = new Set(['host', 'content-length']);

/**
 * `fetch` decodes the response body before we see it, so the upstream's
 * `content-encoding` and `content-length` describe bytes that no longer exist.
 */
const RESPONSE_ONLY = new Set(['content-encoding', 'content-length']);

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
    if (HOP_BY_HOP.has(key) || REQUEST_ONLY.has(key) || CLIENT_IP_CLAIMS.has(key)) return;
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
  // Authenticated API traffic is per-actor. The API already says so on every
  // response; this is the floor for anything that does not.
  if (!headers.has('cache-control')) headers.set('cache-control', 'private, no-store');
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

  // Buffered rather than streamed: a streaming body needs `duplex: 'half'` and
  // gives the caller a way to hold a socket open on both sides at once. These
  // are small JSON requests.
  const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
  const body = hasBody ? await req.arrayBuffer() : undefined;

  let response: Response;
  try {
    response = await fetch(target, {
      method: req.method,
      headers: outboundHeaders(req),
      body: body !== undefined && body.byteLength > 0 ? body : undefined,
      redirect: 'manual',
      // Nothing here is cacheable, and no retry: a repeated POST is a second
      // booking transition, not a retry.
      cache: 'no-store',
    });
  } catch (error) {
    console.error('[gateway] upstream request failed:', error);
    return gatewayError(UPSTREAM_UNAVAILABLE, 'API is unavailable');
  }

  const headers = inboundHeaders(response);
  // 204 and 304 are defined to carry no body; handing one to `Response` throws.
  const bodyless = response.status === 204 || response.status === 304;
  return new Response(bodyless ? null : await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export const GET = forward;
export const HEAD = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
export const OPTIONS = forward;
