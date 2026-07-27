import { Pool, type PoolClient, type QueryResult, type QueryResultRow } from 'pg';

export type { Pool, PoolClient } from 'pg';

/** Minimal query surface implemented by both Pool and PoolClient, so
 * repositories work inside and outside transactions. */
export interface Queryable {
  query<R extends QueryResultRow = QueryResultRow>(
    queryText: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}

export function createPool(databaseUrl: string): Pool {
  return new Pool({ connectionString: databaseUrl, max: 10 });
}

export async function withTransaction<T>(
  pool: Pool,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
