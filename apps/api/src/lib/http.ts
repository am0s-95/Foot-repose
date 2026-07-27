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

export function errorResponse(status: number, code: ApiErrorCode, message: string): Response {
  return Response.json({ error: { code, message } }, { status });
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

export async function parseJsonBody<T>(req: Request, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await req.json();
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

export function clientIp(req: Request): string | null {
  const forwarded = req.headers.get('x-forwarded-for');
  return forwarded ? (forwarded.split(',')[0]?.trim() ?? null) : null;
}
