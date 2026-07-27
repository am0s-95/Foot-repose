import {
  clearLoginAttempts as dbClearLoginAttempts,
  registerLoginAttempt as dbRegisterLoginAttempt,
} from '@foot-repose/db';
import { getPool } from '../../lib/pool';

/**
 * Login rate limit: fixed window per email+ip, stored in PostgreSQL so the
 * count is shared across API instances, survives cold starts, and counts
 * concurrent attempts atomically (single upsert per attempt).
 */
export const LOGIN_RATE_LIMIT = {
  WINDOW_SECONDS: 15 * 60,
  MAX_ATTEMPTS: 10,
} as const;

export function loginRateLimitKey(email: string, ip: string | null): string {
  return `${email}|${ip ?? 'unknown'}`;
}

/** Count this attempt (blocked ones included) and report whether the key is
 * over the limit. */
export async function registerLoginAttempt(
  key: string,
): Promise<{ limited: boolean; attempts: number }> {
  const attempts = await dbRegisterLoginAttempt(getPool(), key, LOGIN_RATE_LIMIT.WINDOW_SECONDS);
  return { limited: attempts > LOGIN_RATE_LIMIT.MAX_ATTEMPTS, attempts };
}

export async function clearLoginFailures(key: string): Promise<void> {
  await dbClearLoginAttempts(getPool(), key);
}
