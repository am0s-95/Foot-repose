/**
 * Login rate limiter: sliding window per email+ip.
 * ponytail: in-process Map — the API runs as one instance today; swap for a
 * shared store (Redis/Postgres) when the API scales out.
 */
export const LOGIN_RATE_LIMIT = {
  WINDOW_MS: 15 * 60_000,
  MAX_ATTEMPTS: 10,
} as const;

const failures = new Map<string, number[]>();

export function loginRateLimitKey(email: string, ip: string | null): string {
  return `${email}|${ip ?? 'unknown'}`;
}

export function isLoginRateLimited(key: string, now = Date.now()): boolean {
  const recent = (failures.get(key) ?? []).filter(
    (t) => now - t < LOGIN_RATE_LIMIT.WINDOW_MS,
  );
  failures.set(key, recent);
  return recent.length >= LOGIN_RATE_LIMIT.MAX_ATTEMPTS;
}

export function recordFailedLogin(key: string, now = Date.now()): void {
  const recent = (failures.get(key) ?? []).filter(
    (t) => now - t < LOGIN_RATE_LIMIT.WINDOW_MS,
  );
  recent.push(now);
  failures.set(key, recent);
}

export function clearLoginFailures(key: string): void {
  failures.delete(key);
}

/** Test helper. */
export function resetLoginRateLimiter(): void {
  failures.clear();
}
