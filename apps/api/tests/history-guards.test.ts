import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  assertLiveDevelopmentDatabase,
  isDevelopmentDatabaseName,
  prepareSeed,
  runMigrations,
} from '@foot-repose/db/testing';
import { closePool, getPool } from '../src/lib/pool';
import { setupAllocationFixtures } from './allocation-helpers';

const DB_PACKAGE_DIR = fileURLToPath(new URL('../../../packages/db', import.meta.url));

/**
 * TRUNCATE protection and seed refusal ordering [R4A-4 / R4-3].
 *
 * TRUNCATE does not fire DELETE triggers, so the row-level history guard is
 * blind to it — and the seed truncates through the same DATABASE_URL. The
 * statement-level guard closes that, and the seed has to refuse a wrong live
 * database BEFORE it migrates, not merely before it wipes.
 */
const PROTECTED = [
  'booking_provider_allocations',
  'booking_resource_allocations',
  'booking_resource_requirement_sets',
  'booking_resource_requirements',
];

const UNPROTECTED = ['audit_logs', 'bookings', 'branch_service_offerings', 'branch_weekly_windows'];

const sqlstateOf = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run();
    return 'no error';
  } catch (error) {
    return (error as { code?: string }).code ?? `unexpected: ${(error as Error).message}`;
  }
};

afterAll(async () => {
  await closePool();
});

describe('TRUNCATE guards cover exactly the four history tables [R4A-4]', () => {
  beforeAll(async () => {
    await setupAllocationFixtures();
  });

  it('[A4.3] refuses TRUNCATE on each protected table without the opt-in', async () => {
    for (const table of PROTECTED) {
      const state = await sqlstateOf(() => getPool().query(`TRUNCATE ${table} CASCADE`));
      expect(`${table} -> ${state}`).toBe(`${table} -> P0001`);
    }
  });

  it('[A4.4] refuses TRUNCATE bookings CASCADE, which pulls the allocation tables in', async () => {
    expect(await sqlstateOf(() => getPool().query('TRUNCATE bookings CASCADE'))).toBe('P0001');
    // Nothing was emptied: the guard runs before any table is truncated.
    const rows = await getPool().query<{ n: number }>('SELECT count(*)::int AS n FROM bookings');
    expect(rows.rows[0]!.n).toBeGreaterThan(0);
  });

  it('names exactly the protected tables, and claims nothing about the others', async () => {
    const rows = await getPool().query<{ tablename: string }>(
      `SELECT DISTINCT c.relname AS tablename
       FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'fr_truncate_guard' ORDER BY 1`,
    );
    expect(rows.rows.map((r) => r.tablename)).toEqual([...PROTECTED].sort());
    for (const table of UNPROTECTED) {
      expect(rows.rows.some((r) => r.tablename === table)).toBe(false);
    }
  });

  it('[A4.2] allows the wipe only inside a transaction that opted in, and the flag dies with it', async () => {
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL foot_repose.allow_history_wipe = 'on'");
      await client.query('TRUNCATE booking_resource_allocations');
      await client.query('COMMIT');
      const afterCommit = await client.query<{ flag: string | null }>(
        "SELECT current_setting('foot_repose.allow_history_wipe', true) AS flag",
      );
      expect(afterCommit.rows[0]!.flag ?? 'off').not.toBe('on');

      await client.query('BEGIN');
      await client.query("SET LOCAL foot_repose.allow_history_wipe = 'on'");
      await client.query('ROLLBACK');
      const afterRollback = await client.query<{ flag: string | null }>(
        "SELECT current_setting('foot_repose.allow_history_wipe', true) AS flag",
      );
      expect(afterRollback.rows[0]!.flag ?? 'off').not.toBe('on');
    } finally {
      client.release();
    }
  });
});

describe('seed refusal ordering [R4A-4 / A4.1]', () => {
  const PROD_URL = 'postgres://postgres:postgres@127.0.0.1:5432/foot_repose_prod';
  let prod: Pool;

  beforeAll(async () => {
    // A live database that is NOT a development database, carrying rows that
    // must survive. In production the divergence this guard defends against is
    // a connection pooler: the URL says one thing, current_database() another.
    const admin = new Pool({
      connectionString: 'postgres://postgres:postgres@127.0.0.1:5432/postgres',
    });
    await admin.query('DROP DATABASE IF EXISTS foot_repose_prod');
    await admin.query('CREATE DATABASE foot_repose_prod');
    await admin.end();
    prod = new Pool({ connectionString: PROD_URL });
    await prod.query('CREATE TABLE sentinel (id int primary key)');
    await prod.query('INSERT INTO sentinel VALUES (1), (2), (3)');
  }, 60_000);

  afterAll(async () => {
    await prod.end();
  });

  /**
   * [A4.1] The ordering proof that actually exercises the live guard.
   *
   * A wrong *string* is caught by the textual guard and never reaches
   * current_database() — so a test using a production-looking URL proves nothing
   * about the live check. The dangerous case is the opposite: a URL that looks
   * like a development database while the session is attached to production,
   * which is exactly what a connection pooler produces.
   *
   * `prepareSeed` holds the order, and `migrate` is injected so "never entered"
   * is directly observable. No production guard is weakened to make this
   * possible: the same three textual guards run first and pass.
   */
  it('[A4.1] never enters migrations when the LIVE database is production', async () => {
    // Stand the production database up at 0005 with rows that must survive.
    await runMigrations(prod, { upTo: '0005_scheduling_inputs.sql' });
    await prod.query(
      "INSERT INTO branches (code, name, area, phone) VALUES ('SNT', 'Sentinel', 'Sentinel', '+968 24000007')",
    );
    const before = await prod.query<{ versions: string; branches: number }>(
      `SELECT (SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations) AS versions,
              (SELECT count(*)::int FROM branches) AS branches`,
    );
    expect(before.rows[0]!.versions).toContain('0005_scheduling_inputs.sql');
    expect(before.rows[0]!.versions).not.toContain('0006');

    let migrateCalls = 0;
    await expect(
      prepareSeed({
        // Textual input looks like a development database: the three textual
        // guards pass, so the live check is the only thing that can refuse.
        databaseUrl: 'postgres://postgres:postgres@127.0.0.1:5432/foot_repose_dev',
        env: { NODE_ENV: 'development', SEED_CONFIRM: 'wipe' },
        liveDatabaseName: async () =>
          (await prod.query<{ db: string }>('SELECT current_database() AS db')).rows[0]!.db,
        migrate: async () => {
          migrateCalls += 1;
        },
      }),
    ).rejects.toThrow(/Refusing to seed \(before migrations\).*foot_repose_prod/s);

    expect(migrateCalls).toBe(0);
    const after = await prod.query<{ versions: string; branches: number }>(
      `SELECT (SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations) AS versions,
              (SELECT count(*)::int FROM branches) AS branches`,
    );
    expect(after.rows[0]!.versions).toBe(before.rows[0]!.versions);
    expect(after.rows[0]!.branches).toBe(before.rows[0]!.branches);
    const newTables = await prod.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_name IN ('booking_provider_allocations', 'booking_resource_allocations',
                            'resource_types', 'branch_resources')`,
    );
    expect(newTables.rows[0]!.n).toBe(0);
  }, 120_000);

  it('[A4.1] also refuses end-to-end when the URL itself is production', async () => {
    // The complementary case: the string is wrong too, so the textual guard is
    // what fires. Asserted as "nothing changed" rather than "nothing exists",
    // because the test above deliberately left this database at 0005.
    const snapshot = async (): Promise<string> =>
      JSON.stringify(
        (
          await prod.query(
            `SELECT (SELECT string_agg(version, ',' ORDER BY version) FROM schema_migrations) AS versions,
                    (SELECT string_agg(table_name, ',' ORDER BY table_name)
                       FROM information_schema.tables WHERE table_schema = 'public') AS tables,
                    (SELECT count(*)::int FROM sentinel) AS sentinels`,
          )
        ).rows[0],
      );
    const before = await snapshot();

    let failed = false;
    try {
      execFileSync('npx', ['tsx', 'src/seed.ts'], {
        cwd: DB_PACKAGE_DIR,
        env: { ...process.env, DATABASE_URL: PROD_URL, SEED_CONFIRM: 'wipe' },
        stdio: 'pipe',
        timeout: 120_000,
      });
    } catch (error) {
      failed = true;
      expect(String((error as { stderr?: Buffer }).stderr)).toContain('Refusing to seed');
    }
    expect(failed).toBe(true);
    expect(await snapshot()).toBe(before);

    const flag = await prod.query<{ flag: string | null }>(
      "SELECT current_setting('foot_repose.allow_history_wipe', true) AS flag",
    );
    expect(flag.rows[0]!.flag ?? 'off').not.toBe('on');
  }, 120_000);

  it('shares one name predicate between the URL guard and the live guard', () => {
    expect(isDevelopmentDatabaseName('foot_repose_dev')).toBe(true);
    expect(isDevelopmentDatabaseName('foot_repose_test')).toBe(true);
    expect(isDevelopmentDatabaseName('foot_repose_prod')).toBe(false);
    expect(isDevelopmentDatabaseName('foot_repose_test_backup')).toBe(false);
    expect(() => assertLiveDevelopmentDatabase('foot_repose_prod', 'probe')).toThrow(
      /Refusing to seed \(probe\)/,
    );
    expect(() => assertLiveDevelopmentDatabase('foot_repose_dev', 'probe')).not.toThrow();
  });
});
