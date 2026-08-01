import type { ApiErrorCode } from '@foot-repose/contracts';
import { z, type ZodError, type ZodType } from 'zod';
import { env } from './env';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ApiErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/** API responses default to uncacheable: almost everything here is per-actor
 * data. Public endpoints opt out explicitly via init.headers. */
export function jsonResponse(
  data: unknown,
  init?: ResponseInit & { headers?: Record<string, string> },
): Response {
  return Response.json(data, {
    ...init,
    headers: { 'cache-control': 'private, no-store', ...(init?.headers ?? {}) },
  });
}

/** Constructor form keeps Set-Cookie intact across fetch Headers guards. */
export function jsonWithCookie(data: unknown, cookie: string, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'private, no-store',
      'set-cookie': cookie,
    },
  });
}

/**
 * CSRF guard for state-changing routes. Browsers always attach Origin to
 * cross-site (and same-origin) POSTs; a request from an origin outside the
 * allowlist is rejected. Requests without Origin (curl, server-to-server)
 * pass — they carry no ambient browser cookies, which is what CSRF abuses.
 */
export function assertTrustedOrigin(req: Request): void {
  const origin = req.headers.get('origin');
  if (!origin) return;
  if (!env.allowedOrigins.includes(origin)) {
    throw new HttpError(403, 'forbidden', 'Origin not allowed');
  }
}

/** Errors are as actor-specific as successes — never cacheable. */
export function errorResponse(status: number, code: ApiErrorCode, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { 'cache-control': 'private, no-store' } },
  );
}

/** Wrap a route body: HttpError maps to its status/code, anything else to 500. */
export function handle(fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((error: unknown) => {
    if (error instanceof HttpError) {
      return errorResponse(error.status, error.code, error.message);
    }
    console.error('Unhandled API error:', error);
    return errorResponse(500, 'internal_error', 'Internal server error');
  });
}

function zodIssuesMessage(error: ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`)
    .join('; ');
}

/**
 * [T3] The ceiling on a JSON request body, in RAW BYTES.
 *
 * Measured on pre-fix main 02494832: `parseJsonBody` called `req.json()`
 * directly, so a 2 MiB body was buffered and JSON-parsed before Zod saw it —
 * through a declared Content-Length and through chunked framing alike. Login
 * answered 401 (password verification had run), and an authenticated
 * transition answered 200 and actually moved the booking. The body limit was
 * whatever the runtime happened to allow.
 *
 * 16 KiB is far above every legitimate request this API accepts — the largest
 * contract is a login with a 320-character email and a 200-character password,
 * and a transition carries one `action` string — and far below a size worth
 * holding in memory for an unauthenticated caller. It is a fixed constant on
 * purpose: an environment variable would let a deployment quietly raise a
 * security ceiling, and there is no operational reason to.
 */
export const MAX_JSON_BODY_BYTES = 16_384;

function bodyTooLarge(): HttpError {
  // The message is a constant. Echoing the observed size or any of the body
  // would hand an attacker a measurement channel and put payloads in logs.
  return new HttpError(413, 'payload_too_large', 'Request body too large');
}

/**
 * Read at most `maxBytes` of the request body, or refuse.
 *
 * Content-Length is used ONLY to refuse early — never as evidence that a body
 * is small enough. It is a claim by the caller, and a chunked request does not
 * make one at all, so the counting below is what actually enforces the limit.
 */
async function readBoundedBody(req: Request, maxBytes: number): Promise<Uint8Array> {
  const declared = req.headers.get('content-length');
  if (declared !== null && /^\d+$/.test(declared)) {
    const length = Number(declared);
    if (Number.isSafeInteger(length) && length > maxBytes) throw bodyTooLarge();
  }

  const body = req.body;
  if (body === null) return new Uint8Array(0);

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      // Checked BEFORE the chunk is retained, so an oversized body is never
      // assembled in memory even once.
      if (total > maxBytes) throw bodyTooLarge();
      chunks.push(value);
    }
  } finally {
    // Cancel on every exit, including the overflow throw: without it the source
    // keeps being pulled after the route has already answered 413.
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

export async function parseJsonBody<T>(
  req: Request,
  schema: ZodType<T>,
  // A future route with a genuinely larger contract can raise this explicitly.
  // Neither current caller does, and none may opt in silently.
  maxBytes: number = MAX_JSON_BODY_BYTES,
): Promise<T> {
  const bytes = await readBoundedBody(req, maxBytes);

  let raw: unknown;
  try {
    // The same UTF-8 decode `Request.json()` performs, so decoding behaviour —
    // BOM handling, replacement characters — is unchanged for every body that
    // was already within the limit.
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new HttpError(400, 'validation_error', 'Body must be valid JSON');
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'validation_error', zodIssuesMessage(parsed.error));
  return parsed.data;
}

/** Parse listed query params (absent/empty params are omitted, not errors). */
export function parseQuery<T>(req: Request, schema: ZodType<T>, keys: readonly string[]): T {
  const url = new URL(req.url);
  const raw: Record<string, string> = {};
  for (const key of keys) {
    const value = url.searchParams.get(key);
    if (value) raw[key] = value;
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, 'validation_error', zodIssuesMessage(parsed.error));
  return parsed.data;
}

const uuidSchema = z.string().uuid();

/** Path ids that are not UUIDs can never match a row — treat as 404. */
export function assertUuid(value: string, entity: string): string {
  if (!uuidSchema.safeParse(value).success) {
    throw new HttpError(404, 'not_found', `${entity} not found`);
  }
  return value;
}

/** Re-exported so route handlers have one obvious import, and so no caller can
 * reach for a raw `x-forwarded-for` value by accident. */
export { trustedClientIp } from './client-ip';
