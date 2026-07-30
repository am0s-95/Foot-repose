import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { todayInMuscat } from '@foot-repose/domain';
import { actionableReferenceDate } from '@foot-repose/db';

// Playwright loads this as CommonJS, so `import.meta.url` is unavailable. The
// config's rootDir is the repository root, which is where Playwright runs.
const DB_PACKAGE_DIR = resolve(process.cwd(), 'packages/db');

/**
 * Seeds the e2e database for a date the board can actually be driven on.
 *
 * The seed used to be a separate CI step that took whatever day it ran on. On
 * the weekly day off it produces no bookings anywhere, so the board test found
 * no card to check in and failed — with nothing wrong in the application. That
 * is a false negative that only appears on two days in seven, which is worse
 * than one that appears always.
 *
 * Seeding here instead means ONE place decides the reference date, and the spec
 * can derive the same date from the same rule instead of guessing. The board
 * still opens on the API's own today, so the reference date stays within a day
 * of it and the spec navigates the rest through the real UI.
 */
export default function globalSetup(): void {
  const today = todayInMuscat();
  const reference = actionableReferenceDate(today);
  console.log(`[e2e] seeding for Muscat reference date ${reference} (today is ${today})`);
  execFileSync('npx', ['tsx', 'src/seed.ts'], {
    cwd: DB_PACKAGE_DIR,
    env: { ...process.env, SEED_CONFIRM: 'wipe', SEED_REFERENCE_DATE: reference },
    stdio: 'inherit',
    timeout: 180_000,
  });
}
