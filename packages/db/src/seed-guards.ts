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
