import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // Builds a production artifact and binds fixed ports.
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 900_000,
  },
});
