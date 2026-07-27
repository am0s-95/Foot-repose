import type { Pool } from 'pg';
import { runMigrations } from './migrations';

// Test-only surface: migrations stay out of the server bundle (see index.ts),
// but upgrade-path tests need to drive them directly.
export { runMigrations } from './migrations';

/** Drop and recreate the public schema, then run all migrations.
 * FOR TESTS ONLY — this destroys every table in the target database. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations(pool);
}

/** Like resetDatabase, but stop after the named migration file — used to
 * reproduce upgrade paths (seed old schema, then apply the rest). */
export async function resetDatabaseTo(pool: Pool, upTo: string): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations(pool, { upTo });
}
