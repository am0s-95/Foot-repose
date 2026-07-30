import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { todayInMuscat } from '@foot-repose/domain';
import {
  actionableReferenceDate,
  SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY,
} from '@foot-repose/db';

/**
 * The real transition, driven on boards dated to different weekdays.
 *
 * `branch-board.spec.ts` proves the flow on whatever day the suite runs. This
 * proves it on a Thursday-dated board, on a Saturday-dated board, and across
 * the 2026-07-31 → 2026-08-01 month boundary — without waiting for those days
 * to arrive, and without faking a clock.
 *
 * The mechanism is the board's own day navigation: the seed is built around an
 * explicit reference date, and the test walks from the board's today to that
 * date using the same next/previous buttons a manager uses.
 *
 * WHAT CANNOT BE PROVEN, AND WHY: there is no "transition a booking dated on the
 * weekly day off". Every roster omits that day, so the seed places no booking on
 * it at any branch — the empty day IS the behaviour. The nearest honest thing is
 * running the whole suite while today IS that day, which `branch-board.spec.ts`
 * does, and which is exactly the scenario that used to fail.
 */
const MANAGER_EMAIL = 'manager.khw@footrepose.example';
const SEED_PASSWORD = 'FootRepose!Dev1';
const DB_PACKAGE_DIR = resolve(process.cwd(), 'packages/db');

/**
 * Reference dates reachable from the board's today by at most one click.
 *
 * Migration 0005 refuses a branch-hours override for a past Muscat date and the
 * seed writes one for reference+1, so a reference date before yesterday cannot
 * be seeded at all. These are chosen relative to today for that reason, not for
 * convenience.
 */
const TODAY = todayInMuscat();

function isoShift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function weekdayName(date: string): string {
  return ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][
    new Date(`${date}T00:00:00Z`).getUTCDay()
  ]!;
}

function seedFor(referenceDate: string): void {
  execFileSync('npx', ['tsx', 'src/seed.ts'], {
    cwd: DB_PACKAGE_DIR,
    env: { ...process.env, SEED_CONFIRM: 'wipe', SEED_REFERENCE_DATE: referenceDate },
    stdio: 'pipe',
    timeout: 180_000,
  });
}

async function countCheckInAudits(): Promise<number> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query(
      "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'booking.check_in'",
    );
    return result.rows[0].n as number;
  } finally {
    await client.end();
  }
}

async function statusOf(bookingId: string): Promise<string> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const result = await client.query('SELECT status FROM bookings WHERE id = $1', [bookingId]);
    return result.rows[0].status as string;
  } finally {
    await client.end();
  }
}

/**
 * Two offsets that are BOTH seedable and BOTH actionable.
 *
 * -1 is the earliest a live database will accept; +1 and +2 are always fine. At
 * most one of {-1, +1, +2} can be the weekly day off — they are three distinct
 * weekdays — so filtering it out always leaves two. Nothing is skipped: a case
 * that could not exist is never generated in the first place.
 */
const CASES = [-1, 1, 2]
  .map((offset) => ({ offset, reference: isoShift(TODAY, offset) }))
  .filter(({ reference }) => weekdayName(reference) !== 'Friday')
  .slice(0, 2);

// Serial: each case reseeds the shared database.
test.describe.configure({ mode: 'serial' });

test.afterAll(() => {
  // Leave the database as globalSetup left it, so spec order cannot matter.
  seedFor(actionableReferenceDate(TODAY));
});

for (const { offset, reference } of CASES) {
  test(`checks in on a board dated ${reference} (${weekdayName(reference)}, offset ${offset})`, async ({
    page,
  }) => {
    seedFor(reference);
    const auditsBefore = await countCheckInAudits();

    await page.goto('/');
    await expect(page).toHaveURL(/\/login$/);
    await page.locator('input[type="email"]').fill(MANAGER_EMAIL);
    await page.locator('input[type="password"]').fill(SEED_PASSWORD);
    await page.getByRole('button', { name: 'Sign in' }).click();

    await expect(page).toHaveURL('http://localhost:3001/');
    await expect(page.locator('.chip')).toHaveText('Foot Repose Al Khuwair');

    // The label reads '…' until the first board response lands, so wait for a
    // real date before reading it — otherwise this races a cold API.
    await expect(page.locator('.date-label')).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
    // Walk to the seeded reference date through the real controls.
    const boardDate = (await page.locator('.date-label').innerText()).trim();
    expect(boardDate).toBe(TODAY);
    const button = offset > 0 ? 'Next day' : 'Previous day';
    for (let step = 0; step < Math.abs(offset); step += 1) {
      await page.getByRole('button', { name: button }).click();
    }
    await expect(page.locator('.date-label')).toHaveText(reference);

    const checkable = page.locator('li.booking-card', {
      has: page.getByRole('button', { name: 'Check in' }),
    });
    await expect(checkable).toHaveCount(SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY);

    const bookingId = await checkable.first().getAttribute('data-booking-id');
    expect(bookingId).toBeTruthy();
    const card = page.locator(`li.booking-card[data-booking-id="${bookingId}"]`);
    await expect(card.locator('.status')).toHaveText('Confirmed');

    await card.getByRole('button', { name: 'Check in' }).click();

    // The UI shows the server-confirmed state and the next permitted action...
    await expect(card.locator('.status')).toHaveText('Checked in');
    await expect(card.getByRole('button', { name: 'Start service' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'Check in' })).toHaveCount(0);
    // ...the database agrees...
    expect(await statusOf(bookingId!)).toBe('checked_in');
    // ...and the transition was audited exactly once.
    expect(await countCheckInAudits()).toBe(auditsBefore + 1);
  });
}
