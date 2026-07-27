import type { Pool } from 'pg';
import { runMigrations } from './migrations';

/** Drop and recreate the public schema, then run all migrations.
 * FOR TESTS ONLY — this destroys every table in the target database. */
export async function resetDatabase(pool: Pool): Promise<void> {
  await pool.query('DROP SCHEMA public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations(pool);
}
