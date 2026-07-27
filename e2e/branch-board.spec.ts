import { expect, test } from '@playwright/test';
import { Client } from 'pg';

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

  // Board loads with the manager's branch and today's bookings.
  await expect(page).toHaveURL('http://localhost:3001/');
  await expect(page.getByText('Branch board')).toBeVisible();
  await expect(page.locator('.chip')).toHaveText('Foot Repose Al Khuwair');

  // Pick the first booking that can be checked in (seed guarantees several
  // confirmed bookings today per branch), then pin the card by its id —
  // live locators would otherwise jump to the next check-in-able card.
  const firstCheckable = page
    .locator('li.booking-card', { has: page.getByRole('button', { name: 'Check in' }) })
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
