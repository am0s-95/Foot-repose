import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

// Pick up TEST_DATABASE_URL from the repo root .env when present.
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      DATABASE_URL:
        process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/foot_repose_test',
      AUTH_SECRET: 'test-secret-0123456789abcdef0123456789abcdef',
    },
  },
});
