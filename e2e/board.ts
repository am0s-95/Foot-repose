import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, type Page } from '@playwright/test';
import { Client } from 'pg';
import { daysBetween } from './seed-context';

export const MANAGER_EMAIL = 'manager.khw@footrepose.example';
export const SEED_PASSWORD = 'FootRepose!Dev1';
const DB_PACKAGE_DIR = resolve(process.cwd(), 'packages/db');

export function seedFor(referenceDate: string): void {
  execFileSync('npx', ['tsx', 'src/seed.ts'], {
    cwd: DB_PACKAGE_DIR,
    env: { ...process.env, SEED_CONFIRM: 'wipe', SEED_REFERENCE_DATE: referenceDate },
    stdio: 'pipe',
    timeout: 180_000,
  });
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

export async function countCheckInAudits(): Promise<number> {
  const rows = await query<{ n: number }>(
    "SELECT count(*)::int AS n FROM audit_logs WHERE action = 'booking.check_in'",
  );
  return rows[0]!.n;
}

export async function statusOf(bookingId: string): Promise<string> {
  const rows = await query<{ status: string }>('SELECT status FROM bookings WHERE id = $1', [
    bookingId,
  ]);
  return rows[0]!.status;
}

export async function login(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login$/);
  await page.locator('input[type="email"]').fill(MANAGER_EMAIL);
  await page.locator('input[type="password"]').fill(SEED_PASSWORD);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL('http://localhost:3001/');
  await expect(page.locator('.chip')).toHaveText('Foot Repose Al Khuwair');
}

/** The date the board is actually showing. The label reads '…' until the first
 * response lands, so this waits for a real date rather than racing a cold API. */
export async function boardDate(page: Page): Promise<string> {
  await expect(page.locator('.date-label')).toHaveText(/^\d{4}-\d{2}-\d{2}$/);
  return (await page.locator('.date-label').innerText()).trim();
}

/**
 * Walk the board to `target` using the real day controls.
 *
 * The distance is measured from the board's OWN current label, never from a
 * date this process remembered earlier — that difference is what makes the
 * navigation immune to the Muscat clock advancing mid-run. Every seeded target
 * is in the future, so this only ever moves forwards; a backwards step would
 * mean the target had become historical, which is precisely the state the
 * database refuses.
 */
export async function navigateTo(page: Page, target: string): Promise<void> {
  const from = await boardDate(page);
  const steps = daysBetween(from, target);
  expect(
    steps,
    `board is at ${from} but the seeded target ${target} is in the past — the run must never seed a past date`,
  ).toBeGreaterThanOrEqual(0);

  // One day at a time, WAITING for each step to land — a deliberate choice for
  // these tests, not a workaround any more. The board now steps from the last
  // INTENT, so rapid clicking is exact and is proved as such in
  // `branch-board-rapid-navigation.spec.ts`. Walking day by day here keeps the
  // seeded-date specs about their own subject: each intermediate board is
  // observed to land, so a failure names the day it happened on.
  let current = from;
  for (let step = 0; step < steps; step += 1) {
    const next = addDays(current, 1);
    await page.getByRole('button', { name: 'Next day' }).click();
    await expect(page.locator('.date-label')).toHaveText(next);
    current = next;
  }
  await expect(page.locator('.date-label')).toHaveText(target);
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function checkableCards(page: Page) {
  return page.locator('li.booking-card', {
    has: page.getByRole('button', { name: 'Check in' }),
  });
}

/**
 * Check in the first actionable booking and verify it everywhere it is
 * recorded: the card, the database row, and exactly one audit entry.
 */
export async function checkInFirst(page: Page): Promise<string> {
  const auditsBefore = await countCheckInAudits();
  const card = checkableCards(page).first();
  await expect(card).toBeVisible();
  const bookingId = await card.getAttribute('data-booking-id');
  expect(bookingId).toBeTruthy();

  // Pin by id: a live locator would jump to the next check-in-able card the
  // moment this one stops being one.
  const pinned = page.locator(`li.booking-card[data-booking-id="${bookingId}"]`);
  await expect(pinned.locator('.status')).toHaveText('Confirmed');
  await pinned.getByRole('button', { name: 'Check in' }).click();

  await expect(pinned.locator('.status')).toHaveText('Checked in');
  await expect(pinned.getByRole('button', { name: 'Start service' })).toBeVisible();
  await expect(pinned.getByRole('button', { name: 'Check in' })).toHaveCount(0);
  expect(await statusOf(bookingId!)).toBe('checked_in');
  expect(await countCheckInAudits()).toBe(auditsBefore + 1);
  return bookingId!;
}
