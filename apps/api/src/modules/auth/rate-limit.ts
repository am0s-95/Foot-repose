import {
  clearLoginAttempts as dbClearLoginAttempts,
  registerLoginAttempt as dbRegisterLoginAttempt,
} from '@foot-repose/db';
import { getPool } from '../../lib/pool';

/**
 * Login throttling, stored in PostgreSQL so the count is shared across API
 * instances, survives cold starts, and counts concurrent attempts atomically
 * (one upsert per key per attempt).
 *
 * The identity being counted is the part that matters. It used to be
 * `email|ip`, where `ip` came from `X-Forwarded-For` — a header the requester
 * writes. Rotating it handed the attacker a brand-new counter on every attempt,
 * so ten guesses per window became unlimited guesses against one employee.
 *
 * So the MANDATORY bucket is keyed on the normalized email alone and cannot be
 * influenced by any header. `loginRequestSchema` has already trimmed and
 * lower-cased that address, which is what makes `A@X.com `, `a@x.com` and
 * `  a@x.com` one counter rather than three.
 *
 * A source-address bucket is registered IN ADDITION, but only when
 * `trustedClientIp` produced an authoritative address — never on the strength of
 * a forwarded header. With no trusted boundary configured there is no such
 * bucket, and this is worth stating plainly rather than dressing up: per-email
 * throttling stops an attacker grinding ONE account, and does not stop a
 * distributed attempt spread across many accounts. Closing that needs an
 * authoritative source address (or a different control entirely), which this
 * deployment cannot currently provide.
 */
export const LOGIN_RATE_LIMIT = {
  WINDOW_SECONDS: 15 * 60,
  /** Failed attempts per normalized email per window. */
  MAX_ATTEMPTS: 10,
  /** Attempts per authoritative source address per window, when one exists.
   * Higher than MAX_ATTEMPTS because one address legitimately covers a whole
   * branch behind NAT. */
  MAX_SOURCE_ATTEMPTS: 60,
} as const;

/** Prefixed so an email can never collide with an address, and so the two
 * dimensions stay legible in the table. */
export function loginIdentifierKey(email: string): string {
  return `login:id:${email}`;
}

export function loginSourceKey(ip: string): string {
  return `login:ip:${ip}`;
}

export interface LoginAttemptVerdict {
  limited: boolean;
  /** Count in the mandatory identifier bucket after this attempt. */
  attempts: number;
  /** Which dimension refused, for audit metadata — never for the response. */
  dimension: 'identifier' | 'source' | null;
}

/**
 * Count this attempt against every applicable dimension — blocked attempts
 * included, so hammering cannot outrun its own window — and report whether any
 * dimension is now over its limit.
 */
export async function registerLoginAttempt(
  email: string,
  ip: string | null,
): Promise<LoginAttemptVerdict> {
  const pool = getPool();
  const attempts = await dbRegisterLoginAttempt(
    pool,
    loginIdentifierKey(email),
    LOGIN_RATE_LIMIT.WINDOW_SECONDS,
  );
  const overIdentifier = attempts > LOGIN_RATE_LIMIT.MAX_ATTEMPTS;

  let overSource = false;
  if (ip !== null) {
    const sourceAttempts = await dbRegisterLoginAttempt(
      pool,
      loginSourceKey(ip),
      LOGIN_RATE_LIMIT.WINDOW_SECONDS,
    );
    overSource = sourceAttempts > LOGIN_RATE_LIMIT.MAX_SOURCE_ATTEMPTS;
  }

  return {
    limited: overIdentifier || overSource,
    attempts,
    dimension: overIdentifier ? 'identifier' : overSource ? 'source' : null,
  };
}

/**
 * A successful login clears the failure state for THAT account only.
 *
 * The source bucket is deliberately left alone: it aggregates many accounts, so
 * letting one success wipe it would hand anyone holding a single valid
 * credential a free reset of the shared counter.
 */
export async function clearLoginFailures(email: string): Promise<void> {
  await dbClearLoginAttempts(getPool(), loginIdentifierKey(email));
}
