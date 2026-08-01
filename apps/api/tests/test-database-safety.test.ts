import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { closePool, getPool } from '../src/lib/pool';
import {
  createScratchDatabase,
  dropScratchDatabase,
  uniqueScratchDbName,
  urlForDatabase,
  withScratchDatabase,
  type ScratchDatabase,
} from './scratch-database';

/**
 * The test suite must not be able to destroy a database it did not create.
 *
 * This exists because it once could. `history-guards.test.ts` opened a fixed
 * connection to `127.0.0.1:5432/postgres` — ignoring the configured
 * `DATABASE_URL` entirely — and ran `DROP DATABASE IF EXISTS foot_repose_prod`
 * in a `beforeAll`, before a single assertion. On a machine with a real
 * `foot_repose_prod` there, `npm test` deleted it: the `pg_database` OID changed
 * and every row was gone.
 *
 * Two kinds of proof are needed and neither is sufficient alone. The scans below
 * are cheap and catch a reintroduction in review; the execution proofs are what
 * actually demonstrate the lifecycle. The decisive proof is neither — it is
 * running this suite with `DATABASE_URL` on a NON-DEFAULT port and nothing
 * listening on 5432 at all, which is recorded in the pull request and enforced
 * by the CI job's port.
 */

const TESTS_DIR = fileURLToPath(new URL('.', import.meta.url));

/**
 * This file is excluded from its own scans: it necessarily contains the very
 * patterns it forbids. Everything else in the directory is fair game, which is
 * what matters — a reintroduction would land in a test file, not here.
 */
const SCANNER = 'test-database-safety.test.ts';

/**
 * Scan CODE, not prose.
 *
 * The first version of these scans failed on the docblocks that explain this
 * defect — the comments quote the old hardcoded URL and the old
 * `DROP DATABASE IF EXISTS` on purpose. Stripping `//` to end of line would have
 * been worse: it would eat `postgres://…` out of the very code being checked.
 * So lines that OPEN with a comment marker are skipped, and nothing else is.
 */
function offendingFiles(pattern: RegExp, allowed: string[] = []): string[] {
  const skip = new Set([SCANNER, ...allowed]);
  return readdirSync(TESTS_DIR)
    .filter((name) => name.endsWith('.ts') && !skip.has(name))
    .filter((name) =>
      readFileSync(join(TESTS_DIR, name), 'utf8')
        .split('\n')
        .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
        .some((line) => pattern.test(line)),
    );
}

describe('[T1] no test writes a database endpoint down', () => {
  it('contains no hardcoded PostgreSQL connection string', () => {
    // Every connection must be derived from DATABASE_URL. A literal
    // postgres:// URL in a test is how the suite reached a cluster nobody
    // configured.
    expect(offendingFiles(/postgres(?:ql)?:\/\/[^\s'"`]*@/)).toEqual([]);
  });

  it('contains no hardcoded loopback PostgreSQL port', () => {
    expect(offendingFiles(/(?:127\.0\.0\.1|localhost):5432/)).toEqual([]);
  });

  it('never issues DROP DATABASE IF EXISTS, or CREATE DATABASE IF NOT EXISTS', () => {
    // IF EXISTS turns "that name is taken" — the one signal that protects a
    // real database — into silent deletion.
    expect(
      offendingFiles(/DROP\s+DATABASE\s+IF\s+EXISTS|CREATE\s+DATABASE\s+IF\s+NOT\s+EXISTS/i),
    ).toEqual([]);
  });

  it('issues DROP DATABASE from exactly one place', () => {
    // Only the shared helper may drop, so there is one lifecycle to review.
    expect(offendingFiles(/DROP\s+DATABASE/i, ['scratch-database.ts'])).toEqual([]);
  });

  it('the scans would actually catch a reintroduction', () => {
    // Not vacuous: the patterns match the code they are meant to forbid.
    for (const [pattern, line] of [
      [/postgres(?:ql)?:\/\/[^\s'"`]*@/, "new Pool({ connectionString: 'postgres://u:p@h:5432/db' })"],
      [/(?:127\.0\.0\.1|localhost):5432/, "const URL = 'x 127.0.0.1:5432 y';"],
      [/DROP\s+DATABASE\s+IF\s+EXISTS/i, "await admin.query('DROP DATABASE IF EXISTS foot_repose_prod');"],
    ] as [RegExp, string][]) {
      expect(pattern.test(line)).toBe(true);
      // ...and a comment line carrying the same text is skipped by the scanner.
      expect(/^\s*(\/\/|\/\*|\*)/.test(` * ${line}`)).toBe(true);
    }
  });
});

describe('[T1] scratch names cannot collide with anything real', () => {
  it('derives every URL from the configured DATABASE_URL', () => {
    const configured = new URL(process.env.DATABASE_URL!);
    const derived = new URL(urlForDatabase('some_scratch_name'));
    expect(derived.host).toBe(configured.host);
    expect(derived.username).toBe(configured.username);
    expect(derived.pathname).toBe('/some_scratch_name');
  });

  it('generates a different name every time', () => {
    const names = new Set(
      Array.from({ length: 50 }, () => uniqueScratchDbName((t) => `foot_repose_scratch_${t}`)),
    );
    expect(names.size).toBe(50);
  });

  it('refuses an unsafe identifier and refuses a _test name', () => {
    expect(() => uniqueScratchDbName(() => 'drop me; --')).toThrow(/unsafe generated database name/);
    expect(() => uniqueScratchDbName((t) => `scratch_${t}_test`)).toThrow(/NOT end with _test/);
  });
});

describe('[T1] a scratch database is created, owned and dropped', () => {
  afterAll(async () => {
    await closePool();
  });

  const exists = async (name: string): Promise<boolean> =>
    (
      await getPool().query<{ n: number }>(
        'SELECT count(*)::int AS n FROM pg_database WHERE datname = $1',
        [name],
      )
    ).rows[0]!.n === 1;

  const oidOf = async (name: string): Promise<string | null> =>
    (
      await getPool().query<{ oid: string }>('SELECT oid::text FROM pg_database WHERE datname = $1', [
        name,
      ])
    ).rows[0]?.oid ?? null;

  it('drops the scratch database it created, and only that one', async () => {
    let seen = '';
    await withScratchDatabase(getPool(), (t) => `foot_repose_owned_${t}`, async (scratch) => {
      seen = scratch.name;
      expect(await exists(scratch.name)).toBe(true);
    });
    expect(await exists(seen)).toBe(false);
  });

  it('still drops it when the body throws', async () => {
    let seen = '';
    await expect(
      withScratchDatabase(getPool(), (t) => `foot_repose_failing_${t}`, async (scratch) => {
        seen = scratch.name;
        throw new Error('assertion inside the body failed');
      }),
    ).rejects.toThrow(/assertion inside the body failed/);
    expect(seen).not.toBe('');
    expect(await exists(seen)).toBe(false);
  });

  it('a name collision fails safely and preserves the pre-existing database', async () => {
    // Stand in for "a real database of that name already exists".
    const victim = await createScratchDatabase(getPool(), (t) => `foot_repose_prod_like_${t}`);
    try {
      await victim.pool.query('CREATE TABLE precious (id int primary key)');
      await victim.pool.query('INSERT INTO precious VALUES (1), (2), (3)');
      const oidBefore = await oidOf(victim.name);

      // A second CREATE of the SAME name must fail — never consume or replace it.
      await expect(getPool().query(`CREATE DATABASE ${victim.name}`)).rejects.toMatchObject({
        code: '42P04',
      });

      // Untouched: same database, same rows.
      expect(await oidOf(victim.name)).toBe(oidBefore);
      const rows = await victim.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM precious');
      expect(rows.rows[0]!.n).toBe(3);
    } finally {
      await dropScratchDatabase(getPool(), victim);
    }
    expect(await exists(victim.name)).toBe(false);
  });

  it('issues no DROP for a database it failed to create', async () => {
    // `created` is the only thing that authorises a drop, so a scratch record
    // that never got created cannot cause one.
    const notCreated = { name: 'foot_repose_never_created', url: '', created: false } as unknown as
      ScratchDatabase;
    await expect(dropScratchDatabase(getPool(), notCreated)).resolves.toBeUndefined();
    await expect(dropScratchDatabase(getPool(), null)).resolves.toBeUndefined();
  });

  it('refuses to create anything when the admin connection is not a _test database', async () => {
    const notATestDatabase = {
      query: async () => ({ rows: [{ db: 'foot_repose_prod' }] }),
    } as unknown as Parameters<typeof createScratchDatabase>[0];
    await expect(
      createScratchDatabase(notATestDatabase, (t) => `foot_repose_scratch_${t}`),
    ).rejects.toThrow(/not a _test database/);
  });
});
