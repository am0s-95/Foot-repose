import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import {
  assertLiveDevelopmentDatabase,
  isDevelopmentDatabaseName,
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

  it('[A4.1] refuses before any migration, DDL or DML touches the database', async () => {
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

    // runMigrations creates schema_migrations as its very first act, so the
    // absence of that table proves migrations never started.
    const migrations = await prod.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'schema_migrations'`,
    );
    expect(migrations.rows[0]!.n).toBe(0);

    const objects = await prod.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name <> 'sentinel'`,
    );
    expect(objects.rows[0]!.n).toBe(0);

    const sentinel = await prod.query<{ n: number }>('SELECT count(*)::int AS n FROM sentinel');
    expect(sentinel.rows[0]!.n).toBe(3);

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
