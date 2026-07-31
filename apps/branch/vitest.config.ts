import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The routing tests build a production artifact and bind fixed ports.
    fileParallelism: false,
    testTimeout: 60_000,
    hookTimeout: 600_000,
  },
});
