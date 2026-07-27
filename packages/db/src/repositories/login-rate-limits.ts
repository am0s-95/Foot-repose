import type { Queryable } from '../client';

/**
 * Count one login attempt for `key` in the current fixed window and return
 * the new total. One atomic INSERT ... ON CONFLICT upsert: concurrent
 * attempts can never lose increments, and the counter is shared by every
 * API instance because it lives in PostgreSQL.
 */
export async function registerLoginAttempt(
  db: Queryable,
  key: string,
  windowSeconds: number,
): Promise<number> {
  // Opportunistic cleanup — the table only ever holds live login windows.
  await db.query(
    "DELETE FROM login_rate_limits WHERE window_start < now() - ($1 * 2) * interval '1 second'",
    [windowSeconds],
  );
  const result = await db.query<{ attempts: number }>(
    `INSERT INTO login_rate_limits AS l (key, window_start, attempts)
     VALUES ($1, to_timestamp(floor(extract(epoch from now()) / $2) * $2), 1)
     ON CONFLICT (key, window_start) DO UPDATE SET attempts = l.attempts + 1
     RETURNING attempts`,
    [key, windowSeconds],
  );
  return result.rows[0]!.attempts;
}

/** Successful login wipes the counter for that key. */
export async function clearLoginAttempts(db: Queryable, key: string): Promise<void> {
  await db.query('DELETE FROM login_rate_limits WHERE key = $1', [key]);
}

/** Test helper. */
export async function resetAllLoginAttempts(db: Queryable): Promise<void> {
  await db.query('DELETE FROM login_rate_limits');
}
