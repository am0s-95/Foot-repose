import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resetDatabase, resetDatabaseTo } from '@foot-repose/db/testing';
import { closePool, getPool } from '../src/lib/pool';
import { assertAdminIsTestDatabase, withScratchDatabase } from './scratch-database';

/**
 * The destructive reset helpers must interrogate the LIVE connection
 * (SELECT current_database()) and refuse any database whose name does not
 * end exactly with `_test` — BEFORE executing any DROP.
 *
 * The test itself must be harmless on ANY machine:
 *  - it refuses to run unless the admin connection is itself a _test DB;
 *  - scratch databases get collision-proof unique names (never fixed names
 *    that could exist for real), validated as safe SQL identifiers;
 *  - there is NO "DROP ... IF EXISTS" anywhere — a name collision fails the
 *    test safely instead of deleting anything;
 *  - only the exact database this test itself created (created=true) is
 *    dropped afterwards. The literal names foot_repose_prod /
 *    foot_repose_test_backup are covered by a pure unit test on the name
 *    rule in packages/db — no CREATE/DROP involved.
 *
 * That lifecycle now lives in `scratch-database.ts` and is shared with
 * `history-guards.test.ts`, which had grown its own, far weaker version:
 * a hardcoded endpoint, a fixed production-looking name and
 * `DROP DATABASE IF EXISTS`. One implementation, so there is only one thing to
 * get right.
 */
async function expectResetRefused(template: (token: string) => string): Promise<void> {
  await withScratchDatabase(getPool(), template, async ({ pool: target }) => {
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
  });
}

describe('destructive reset helpers verify the live connection', () => {
  beforeAll(async () => {
    // The whole suite refuses to run against a non-_test admin connection.
    await assertAdminIsTestDatabase(getPool());
  });

  afterAll(async () => {
    await closePool();
  });

  it('refuses a production-looking database before any DROP', async () => {
    await expectResetRefused((t) => `foot_repose_prod_guard_${t}`);
  });

  it('refuses near-miss suffixes: only an exact _test ending qualifies', async () => {
    await expectResetRefused((t) => `foot_repose_${t}_test_backup`);
  });

  it('still resets the real _test database', async () => {
    await expect(resetDatabase(getPool())).resolves.toBeUndefined();
    const tables = await getPool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(tables.rows[0]!.n).toBeGreaterThan(5);
  });
});
