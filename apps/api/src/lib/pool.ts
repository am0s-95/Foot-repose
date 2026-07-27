import { createPool, type Pool } from '@foot-repose/db';
import { env } from './env';

/** One pool per process, survives dev-server hot reloads. */
const globalStore = globalThis as unknown as { __frPool?: Pool };

export function getPool(): Pool {
  globalStore.__frPool ??= createPool(env.databaseUrl);
  return globalStore.__frPool;
}

export async function closePool(): Promise<void> {
  if (globalStore.__frPool) {
    await globalStore.__frPool.end();
    globalStore.__frPool = undefined;
  }
}
