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

/**
 * A Pool hands out connections; a PoolClient is already one. Sniffing for a
 * `connect` method is NOT enough — pg's PoolClient inherits Client.connect and
 * would be mistaken for a pool. `instanceof` is the exact test; the pool-only
 * counters are a fallback for the case where two copies of pg are loaded.
 */
function isPool(db: Queryable): db is Pool {
  if (db instanceof Pool) return true;
  const candidate = db as Partial<Pool>;
  return typeof candidate.connect === 'function' && typeof candidate.totalCount === 'number';
}

let unitSeq = 0;

/**
 * Run `fn` as ONE atomic unit whatever the caller handed us.
 *
 * - Given a Pool, take a single connection and wrap the work in a real
 *   BEGIN/COMMIT, rolling back completely on any failure. Multi-statement
 *   repository operations must never be issued straight at a pool: each
 *   statement could land on a different connection, so a later failure would
 *   leave the earlier writes committed.
 * - Given a connection that is already inside a caller's transaction, use a
 *   SAVEPOINT so this unit still rolls back as a whole without destroying the
 *   caller's work.
 * - Given a bare connection with no open transaction (SAVEPOINT answers
 *   25P01), open and close one here.
 */
export async function withUnitOfWork<T>(
  db: Queryable,
  fn: (tx: Queryable) => Promise<T>,
): Promise<T> {
  if (isPool(db)) {
    const client = await db.connect();
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

  const savepoint = `fr_unit_${(unitSeq += 1)}`;
  let nested = true;
  try {
    await db.query(`SAVEPOINT ${savepoint}`);
  } catch (error) {
    if ((error as { code?: string }).code !== '25P01') throw error;
    nested = false;
    await db.query('BEGIN');
  }
  try {
    const result = await fn(db);
    await db.query(nested ? `RELEASE SAVEPOINT ${savepoint}` : 'COMMIT');
    return result;
  } catch (error) {
    await db
      .query(nested ? `ROLLBACK TO SAVEPOINT ${savepoint}` : 'ROLLBACK')
      .catch(() => undefined);
    throw error;
  }
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
