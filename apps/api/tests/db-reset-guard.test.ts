import { afterAll, describe, expect, it } from 'vitest';
import { createPool } from '@foot-repose/db';
import { resetDatabase, resetDatabaseTo } from '@foot-repose/db/testing';
import { closePool, getPool } from '../src/lib/pool';

/**
 * The destructive reset helpers must interrogate the LIVE connection
 * (SELECT current_database()) and refuse any database whose name does not
 * end exactly with `_test` — BEFORE executing any DROP. A marker table
 * proves nothing was dropped on refusal.
 */
function urlForDatabase(name: string): string {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.pathname = `/${name}`;
  return url.toString();
}

async function expectResetRefused(dbName: string): Promise<void> {
  const admin = getPool();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  await admin.query(`CREATE DATABASE ${dbName}`);
  const target = createPool(urlForDatabase(dbName));
  try {
    await target.query('CREATE TABLE guard_marker (id int)');

    await expect(resetDatabase(target)).rejects.toThrow(/does not end with _test/);
    await expect(resetDatabaseTo(target, '0001_init.sql')).rejects.toThrow(
      /does not end with _test/,
    );

    // The DROP never ran: the marker table is still there.
    const marker = await target.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_name = 'guard_marker'",
    );
    expect(marker.rows[0]!.n).toBe(1);
  } finally {
    await target.end();
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
  }
}

describe('destructive reset helpers verify the live connection', () => {
  afterAll(async () => {
    await closePool();
  });

  it('refuse a production-looking database before any DROP', async () => {
    await expectResetRefused('foot_repose_prod');
  });

  it('refuse near-miss names: the suffix must be exactly _test', async () => {
    await expectResetRefused('foot_repose_test_backup');
  });

  it('still reset the real _test database', async () => {
    await expect(resetDatabase(getPool())).resolves.toBeUndefined();
    const tables = await getPool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(tables.rows[0]!.n).toBeGreaterThan(5);
  });
});
