import { randomUUID } from 'node:crypto';
import { createPool, type Pool, type Queryable } from '@foot-repose/db';

/**
 * Scratch databases for tests that need a REAL second database, made harmless
 * on any machine.
 *
 * A test in this suite used to do this:
 *
 *     new Pool({ connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres' })
 *     DROP DATABASE IF EXISTS foot_repose_prod
 *     CREATE DATABASE foot_repose_prod
 *
 * Three separate things were wrong with it, and each one is enough on its own.
 * It ignored the suite's configured `DATABASE_URL` and dialled a fixed endpoint,
 * so it could reach a completely different PostgreSQL cluster from the one the
 * tests were pointed at. It used a FIXED, production-looking name. And
 * `IF EXISTS` turned "this name is already taken" — the one signal that would
 * have saved a real database — into silent deletion. Running `npm test` on a
 * machine with a genuine `foot_repose_prod` at `127.0.0.1:5432` destroyed it:
 * measured, the database's `pg_database` OID changed and every row was gone.
 *
 * The rules here are the ones `db-reset-guard.test.ts` already followed, now in
 * one place so the suite cannot grow a second, weaker copy:
 *
 *  1. every URL is derived from the configured `DATABASE_URL` — no host, port,
 *     user or password is written down anywhere;
 *  2. the admin connection must itself be a `_test` database, checked live with
 *     `SELECT current_database()` before anything is created or dropped;
 *  3. names are random and collision-proof, validated as safe identifiers, and
 *     never a fixed production-looking name;
 *  4. `CREATE DATABASE` is issued WITHOUT `IF NOT EXISTS`, so a collision fails
 *     the test instead of consuming a pre-existing database;
 *  5. `DROP DATABASE` is issued WITHOUT `IF EXISTS`, and only for a database
 *     this helper proved it created;
 *  6. the scratch pool is closed before the drop.
 *
 * Worst case if a process is killed mid-test: one orphaned, uniquely named
 * scratch database. Never the deletion of something that was already there.
 */

/** Deliberately strict: what may be interpolated into a `CREATE DATABASE`. */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

export interface ScratchDatabase {
  readonly name: string;
  readonly url: string;
  readonly pool: Pool;
  /** True only once `CREATE DATABASE` has actually succeeded. */
  readonly created: boolean;
}

/** A URL for `name` on the SAME cluster the suite is configured against. */
export function urlForDatabase(name: string): string {
  const configured = process.env.DATABASE_URL;
  if (!configured) throw new Error('DATABASE_URL is not set; refusing to guess a cluster');
  const url = new URL(configured);
  url.pathname = `/${name}`;
  return url.toString();
}

/**
 * A name nothing else can plausibly own. `template` shapes it so a failure
 * message still says what the database was for; the random token is what makes
 * it safe.
 */
export function uniqueScratchDbName(template: (token: string) => string): string {
  const name = template(randomUUID().replace(/-/g, ''));
  if (!SAFE_IDENTIFIER.test(name)) throw new Error(`unsafe generated database name: ${name}`);
  if (name.endsWith('_test')) {
    // A `_test` name would be eligible for the destructive reset helpers, which
    // is the opposite of what a scratch database is for here.
    throw new Error(`scratch database must NOT end with _test: ${name}`);
  }
  return name;
}

/**
 * Refuse to do anything destructive unless the connection we would issue it
 * from is itself a test database. Asked of the LIVE session, not of the URL:
 * a pooler can make those two disagree, which is the whole reason the guard
 * under test exists.
 */
export async function assertAdminIsTestDatabase(admin: Queryable): Promise<string> {
  const row = await admin.query<{ db: string }>('SELECT current_database() AS db');
  const db = row.rows[0]!.db;
  if (!db.endsWith('_test')) {
    throw new Error(
      `Refusing to create or drop scratch databases: admin connection is "${db}", not a _test database`,
    );
  }
  return db;
}

/**
 * Create a scratch database and connect to it.
 *
 * No `IF NOT EXISTS`: if the generated name somehow collides, PostgreSQL says
 * so (42P04) and the caller fails without having touched the existing database.
 */
export async function createScratchDatabase(
  admin: Queryable,
  template: (token: string) => string,
): Promise<ScratchDatabase> {
  await assertAdminIsTestDatabase(admin);
  const name = uniqueScratchDbName(template);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = urlForDatabase(name);
  return { name, url, pool: createPool(url), created: true };
}

/**
 * Close the scratch pool and drop the database — only when this helper created
 * it, and only by its exact name. No `IF EXISTS`, so a scratch database that
 * disappeared underneath us is a loud failure rather than a shrug.
 */
export async function dropScratchDatabase(
  admin: Queryable,
  scratch: ScratchDatabase | null,
): Promise<void> {
  if (!scratch || !scratch.created) return;
  await scratch.pool.end();
  await admin.query(`DROP DATABASE ${scratch.name}`);
}

/**
 * Run `body` against a scratch database and clean up whatever happens.
 *
 * `finally` rather than a trailing statement: an assertion failure inside
 * `body` must not leave the database behind, and must not skip the drop.
 */
export async function withScratchDatabase<T>(
  admin: Queryable,
  template: (token: string) => string,
  body: (scratch: ScratchDatabase) => Promise<T>,
): Promise<T> {
  const scratch = await createScratchDatabase(admin, template);
  try {
    return await body(scratch);
  } finally {
    await dropScratchDatabase(admin, scratch);
  }
}
