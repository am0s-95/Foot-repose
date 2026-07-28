/**
 * Safety interlocks for the destructive seed. Three independent guards must
 * all pass — NODE_ENV alone is not trusted, so a production database with a
 * production-looking name is refused even when NODE_ENV is set wrongly.
 */
export function assertSeedSafety(input: {
  databaseUrl: string;
  env: Record<string, string | undefined>;
}): void {
  if (input.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed: NODE_ENV=production.');
  }

  let dbName: string;
  try {
    dbName = new URL(input.databaseUrl).pathname.replace(/^\//, '');
  } catch {
    throw new Error('Refusing to seed: DATABASE_URL is not a parseable URL.');
  }
  if (!/_(dev|development|local|test)$/.test(dbName)) {
    throw new Error(
      `Refusing to seed: database "${dbName}" does not look like a development database ` +
        '(expected a name ending in _dev, _development, _local or _test).',
    );
  }

  if (input.env.SEED_CONFIRM !== 'wipe') {
    throw new Error(
      'Refusing to seed: the seed TRUNCATEs every table. Set SEED_CONFIRM=wipe to confirm.',
    );
  }
}

/** The name pattern a development database must match, shared by the URL guard
 * above and the live-connection guard below so the two can never disagree. */
export function isDevelopmentDatabaseName(name: string): boolean {
  return /_(dev|development|local|test)$/.test(name);
}

/**
 * Ask the LIVE connection which database it is attached to, and refuse anything
 * that does not look like a development database.
 *
 * This must run BEFORE migrations, not merely before the TRUNCATE: a wrong
 * DATABASE_URL that only failed at wipe time would already have applied DDL to
 * a real database. It is repeated on the destructive transaction's own client,
 * because a pool hands out a different connection than the one checked first.
 */
export function assertLiveDevelopmentDatabase(dbName: string, stage: string): void {
  if (!isDevelopmentDatabaseName(dbName)) {
    throw new Error(
      `Refusing to seed (${stage}): the live connection is attached to "${dbName}", ` +
        'which is not a development database (expected a name ending in _dev, _development, ' +
        '_local or _test). No migration, DDL or DML has been performed.',
    );
  }
}
