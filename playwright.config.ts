import { config } from 'dotenv';
import { defineConfig } from '@playwright/test';

// Local runs read DATABASE_URL / AUTH_SECRET from the repo-root .env; CI sets
// them in the workflow environment.
config();

const chromiumPath = process.env.PW_CHROMIUM_EXECUTABLE;

export default defineConfig({
  testDir: 'e2e',
  // Seeds for an explicit Muscat reference date rather than for whatever day
  // the runner starts on — see e2e/global-setup.ts.
  globalSetup: './e2e/global-setup.ts',
  timeout: 60_000,
  fullyParallel: false,
  // One worker: the date-matrix spec reseeds the shared database between cases.
  workers: 1,
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
    {
      command: 'npm run start -w @foot-repose/customer-app',
      url: 'http://localhost:3003/',
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
