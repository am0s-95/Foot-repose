import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { todayInMuscat } from '@foot-repose/domain';
import { futureMonthBoundary, futureWeekAnchor, weekFrom } from '@foot-repose/db';
import { writeSeedContext, type SeedContext } from './seed-context';

// Playwright loads this as CommonJS, so `import.meta.url` is unavailable. The
// config's rootDir is the repository root, which is where Playwright runs.
const DB_PACKAGE_DIR = resolve(process.cwd(), 'packages/db');

/**
 * Resolves the run's dates ONCE, writes them down, and seeds the base dataset.
 *
 * Two problems are closed here. The seed used to be a separate CI step that
 * took whatever day it ran on: on the weekly day off it produces no bookings
 * anywhere, so the board test found no card and failed with nothing wrong in
 * the application. And every process used to read the Muscat clock for itself,
 * so a run crossing midnight could have globalSetup and a spec disagree about
 * what "today" was — including a spec asking for a date the database refuses as
 * historical.
 *
 * Every target is at least two days ahead, so it stays seedable however long
 * the run takes and whichever side of midnight each process lands on.
 */
export default function globalSetup(): void {
  const resolvedAt = todayInMuscat();
  const week = weekFrom(futureWeekAnchor(resolvedAt));
  const boundary = futureMonthBoundary(resolvedAt);

  const context: SeedContext = {
    resolvedAt,
    // The base flow runs on the nearest future Sunday: an ordinary working day
    // whose board is populated.
    baseReference: week[0]!,
    thursday: week[4]!,
    dayOff: week[5]!,
    saturday: week[6]!,
    monthEnd: boundary.monthEnd,
    nextMonthStart: boundary.nextMonthStart,
    monthBoundaryTarget: boundary.actionableTarget,
  };
  writeSeedContext(context);

  console.log(
    `[e2e] Muscat today ${resolvedAt}; seeding base ${context.baseReference}; ` +
      `targets thu=${context.thursday} off=${context.dayOff} sat=${context.saturday} ` +
      `boundary=${context.monthEnd}->${context.nextMonthStart} (target ${context.monthBoundaryTarget})`,
  );

  execFileSync('npx', ['tsx', 'src/seed.ts'], {
    cwd: DB_PACKAGE_DIR,
    env: { ...process.env, SEED_CONFIRM: 'wipe', SEED_REFERENCE_DATE: context.baseReference },
    stdio: 'inherit',
    timeout: 180_000,
  });
}
