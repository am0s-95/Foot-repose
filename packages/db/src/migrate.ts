import { createPool } from './client';
import { loadEnv, requireEnv } from './env';
import { runMigrations } from './migrations';

loadEnv();
const pool = createPool(requireEnv('DATABASE_URL'));
try {
  const applied = await runMigrations(pool);
  console.log(
    applied.length === 0 ? 'No pending migrations.' : `Applied migrations: ${applied.join(', ')}`,
  );
} finally {
  await pool.end();
}
