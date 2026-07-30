import { expect, test } from '@playwright/test';
import { Client } from 'pg';
import { actionableDayOffset, SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY } from '@foot-repose/db';

/**
 * End-to-end vertical slice: login → today's board → check-in → status badge
 * updates AND the audit log gains exactly one booking.check_in row.
 *
 * Preconditions (CI does both): `npm run db:migrate` and a fresh
 * `SEED_CONFIRM=wipe npm run db:seed` against DATABASE_URL.
 */
const MANAGER_EMAIL = 'manager.khw@footrepose.example';
const SEED_PASSWORD = 'FootRepose!Dev1';

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

test('login → bookings board → check-in → status + audit log', async ({ page }) => {
  const auditsBefore = await countCheckInAudits();

  // Unauthenticated visits land on the login screen.
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);

  await page.locator('input[type="email"]').fill(MANAGER_EMAIL);
  await page.locator('input[type="password"]').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();

  // Board loads with the manager's branch and its own idea of today.
  await expect(page).toHaveURL('http://localhost:3001/');
  await expect(page.getByText('Branch board')).toBeVisible();
  await expect(page.locator('.chip')).toHaveText('Foot Repose Al Khuwair');

  // Move to the day the seed made actionable, THROUGH THE REAL UI.
  //
  // The board opens on the API's today, and on the weekly day off the seed
  // places no bookings at all — so "today always has something to check in" was
  // simply false twice a week. Al Khuwair cannot fall back to tomorrow either:
  // it is the branch the seed closes that day. `global-setup.ts` therefore
  // seeded `actionableReferenceDate(today)`, and this walks to the same date
  // using the same rule and the same next-day button a manager would use.
  const boardDate = (await page.locator('.date-label').innerText()).trim();
  expect(boardDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  const offset = actionableDayOffset(boardDate);
  for (let step = 0; step < offset; step += 1) {
    await page.getByRole('button', { name: 'Next day' }).click();
  }
  const targetDate = new Date(`${boardDate}T00:00:00Z`);
  targetDate.setUTCDate(targetDate.getUTCDate() + offset);
  const expectedDate = targetDate.toISOString().slice(0, 10);
  await expect(page.locator('.date-label')).toHaveText(expectedDate);

  // The seeded day carries a known number of check-in-able bookings. Asserting
  // the count first means "the card was not found" fails as a missing
  // precondition rather than as a mysterious timeout on the click below.
  const checkable = page.locator('li.booking-card', {
    has: page.getByRole('button', { name: 'Check in' }),
  });
  await expect(checkable).toHaveCount(SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY);

  // Pin the card by its id — live locators would otherwise jump to the next
  // check-in-able card the moment this one stops being one.
  const firstCheckable = checkable
    .first();
  await expect(firstCheckable).toBeVisible();
  const bookingId = await firstCheckable.getAttribute('data-booking-id');
  expect(bookingId).toBeTruthy();
  const card = page.locator(`li.booking-card[data-booking-id="${bookingId}"]`);
  await expect(card.locator('.status')).toHaveText('Confirmed');

  await card.getByRole('button', { name: 'Check in' }).click();

  // The card reflects the server-confirmed new state and next actions.
  await expect(card.locator('.status')).toHaveText('Checked in');
  await expect(card.getByRole('button', { name: 'Start service' })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Check in' })).toHaveCount(0);

  // The transition was audited exactly once.
  expect(await countCheckInAudits()).toBe(auditsBefore + 1);
});
