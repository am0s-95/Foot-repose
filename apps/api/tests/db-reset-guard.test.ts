import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, type Pool } from '@foot-repose/db';
import { resetDatabase, resetDatabaseTo } from '@foot-repose/db/testing';
import { closePool, getPool } from '../src/lib/pool';

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
 */
const SAFE_IDENTIFIER = /^[a-z][a-z0-9_]{0,62}$/;

function uniqueScratchDbName(template: (token: string) => string): string {
  const token = randomUUID().replace(/-/g, '');
  const name = template(token);
  if (!SAFE_IDENTIFIER.test(name)) throw new Error(`unsafe generated database name: ${name}`);
  if (name.endsWith('_test')) {
    throw new Error(`guard-test scratch database must NOT end with _test: ${name}`);
  }
  return name;
}

function urlForDatabase(name: string): string {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.pathname = `/${name}`;
  return url.toString();
}

async function expectResetRefused(dbName: string): Promise<void> {
  const admin = getPool();
  let created = false;
  let target: Pool | null = null;
  try {
    // No IF EXISTS: if this unique name somehow collides, fail safely
    // rather than touching anything pre-existing.
    await admin.query(`CREATE DATABASE ${dbName}`);
    created = true;
    target = createPool(urlForDatabase(dbName));
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
    if (target) await target.end();
    if (created) await admin.query(`DROP DATABASE ${dbName}`);
  }
}

describe('destructive reset helpers verify the live connection', () => {
  beforeAll(async () => {
    // The whole suite refuses to run against a non-_test admin connection.
    const row = await getPool().query<{ db: string }>('SELECT current_database() AS db');
    const db = row.rows[0]!.db;
    if (!db.endsWith('_test')) {
      throw new Error(
        `Refusing to run reset-guard tests: admin connection is "${db}", not a _test database`,
      );
    }
  });

  afterAll(async () => {
    await closePool();
  });

  it('refuses a production-looking database before any DROP', async () => {
    await expectResetRefused(uniqueScratchDbName((t) => `foot_repose_prod_guard_${t}`));
  });

  it('refuses near-miss suffixes: only an exact _test ending qualifies', async () => {
    await expectResetRefused(uniqueScratchDbName((t) => `foot_repose_${t}_test_backup`));
  });

  it('still resets the real _test database', async () => {
    await expect(resetDatabase(getPool())).resolves.toBeUndefined();
    const tables = await getPool().query<{ n: number }>(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    expect(tables.rows[0]!.n).toBeGreaterThan(5);
  });
});
