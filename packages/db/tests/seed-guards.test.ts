import { describe, expect, it } from 'vitest';
import { assertSeedSafety } from '../src/seed-guards';

const DEV_URL = 'postgres://postgres:postgres@localhost:5432/foot_repose_dev';
const OK_ENV = { SEED_CONFIRM: 'wipe' };

describe('assertSeedSafety', () => {
  it('passes for a dev database with explicit confirmation', () => {
    expect(() => assertSeedSafety({ databaseUrl: DEV_URL, env: OK_ENV })).not.toThrow();
    expect(() =>
      assertSeedSafety({
        databaseUrl: 'postgres://u:p@db.example.com:5432/foot_repose_local',
        env: OK_ENV,
      }),
    ).not.toThrow();
  });

  it('refuses NODE_ENV=production even with confirmation and a dev name', () => {
    expect(() =>
      assertSeedSafety({ databaseUrl: DEV_URL, env: { ...OK_ENV, NODE_ENV: 'production' } }),
    ).toThrow(/NODE_ENV=production/);
  });

  it('refuses databases that do not look like development databases, even when NODE_ENV is wrong', () => {
    for (const name of ['foot_repose', 'foot_repose_prod', 'foot_repose_production', 'app']) {
      expect(() =>
        assertSeedSafety({
          databaseUrl: `postgres://u:p@host:5432/${name}`,
          env: { ...OK_ENV, NODE_ENV: 'development' },
        }),
      ).toThrow(/does not look like a development database/);
    }
  });

  it('refuses to TRUNCATE without the explicit SEED_CONFIRM=wipe variable', () => {
    expect(() => assertSeedSafety({ databaseUrl: DEV_URL, env: {} })).toThrow(/SEED_CONFIRM=wipe/);
    expect(() =>
      assertSeedSafety({ databaseUrl: DEV_URL, env: { SEED_CONFIRM: 'yes' } }),
    ).toThrow(/SEED_CONFIRM=wipe/);
  });

  it('refuses an unparseable DATABASE_URL', () => {
    expect(() => assertSeedSafety({ databaseUrl: 'not a url', env: OK_ENV })).toThrow(
      /not a parseable URL/,
    );
  });
});
