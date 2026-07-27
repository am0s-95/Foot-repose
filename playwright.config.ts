import { config } from 'dotenv';
import { defineConfig } from '@playwright/test';

// Local runs read DATABASE_URL / AUTH_SECRET from the repo-root .env; CI sets
// them in the workflow environment.
config();

const chromiumPath = process.env.PW_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://localhost:3001',
    ...(chromiumPath ? { launchOptions: { executablePath: chromiumPath } } : {}),
  },
  webServer: [
    {
      command: 'npm run start -w @foot-repose/api',
      url: 'http://localhost:3000/api/health',
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL: process.env.DATABASE_URL ?? '',
        AUTH_SECRET: process.env.AUTH_SECRET ?? 'e2e-secret-0123456789abcdef0123456789abcdef',
      },
    },
    {
      command: 'npm run start -w @foot-repose/branch-app',
      url: 'http://localhost:3001/login',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
