import { defineConfig } from 'vitest/config';

/** Repo-level tests (module boundaries). Workspace tests have their own configs. */
export default defineConfig({
  test: {
    include: ['tools/**/*.test.ts'],
  },
});
