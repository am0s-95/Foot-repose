import type { Pool } from 'pg';
import { runMigrations } from './migrations';

// Test-only surface: migrations stay out of the server bundle (see index.ts),
// but upgrade-path tests need to drive them directly.
export { runMigrations } from './migrations';
export { assertLiveDevelopmentDatabase, isDevelopmentDatabaseName } from './seed-guards';

/** Exact-suffix rule shared by the live-connection guard and its unit tests:
 * only names ending precisely in `_test` qualify — `foot_repose_test_backup`
 * does not. */
export function isTestDatabaseName(name: string): boolean {
  return name.endsWith('_test');
}

/**
 * Last line of defense before any destructive reset: ask the LIVE connection
 * which database it is actually attached to, and refuse unless that name
 * ends exactly with `_test`. Checking DATABASE_URL (or trusting the caller)
 * is not enough — one mis-set env var must not be able to wipe a real
 * database.
 */
async function assertConnectedToTestDatabase(pool: Pool): Promise<void> {
  const result = await pool.query<{ db: string }>('SELECT current_database() AS db');
  const db = result.rows[0]!.db;
  if (!isTestDatabaseName(db)) {
    throw new Error(
      `Refusing to reset schema: connected database "${db}" does not end with _test. ` +
        'resetDatabase/resetDatabaseTo are destructive test helpers only.',
    );
  }
}

/** Drop and recreate the public schema, then run all migrations.
 * FOR TESTS ONLY — this destroys every table in the target database. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await assertConnectedToTestDatabase(pool);
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations(pool);
}

/** Like resetDatabase, but stop after the named migration file — used to
 * reproduce upgrade paths (seed old schema, then apply the rest). */
export async function resetDatabaseTo(pool: Pool, upTo: string): Promise<void> {
  await assertConnectedToTestDatabase(pool);
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations(pool, { upTo });
}
