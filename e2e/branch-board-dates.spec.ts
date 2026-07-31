import { expect, test } from '@playwright/test';
import {
  SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY,
  isMuscatDayOff,
} from '@foot-repose/db';
import { checkableCards, checkInFirst, login, navigateTo, seedFor } from './board';
import { readSeedContext } from './seed-context';

/**
 * Real UI transitions on a Thursday, a Saturday and across a month boundary —
 * ALWAYS, not whenever the calendar happens to cooperate.
 *
 * The previous version generated two cases from offsets `[-1, +1, +2]` around
 * the process's own `todayInMuscat()`. That had two faults. It could pick
 * YESTERDAY, and a run crossing Muscat midnight after that date was frozen
 * would then ask the database to seed a two-day-old reference — which migration
 * 0005 refuses as historical, failing with no application defect. And which
 * weekdays it covered depended on the day CI ran: a Friday run happened to
 * exercise Thursday and Saturday, a Monday run would exercise Sunday and
 * Tuesday, so "we test Thursday and Saturday" was true of one run rather than
 * of the suite.
 *
 * Both are closed the same way: `globalSetup` resolves every target once, safely
 * in the future, and writes them to a run-scoped file. Specs read that file,
 * read the board's ACTUAL date label, and navigate forwards from it. The clock
 * may advance mid-run; the targets cannot.
 *
 * There is still no Friday-dated transition, and none is faked: the seed places
 * no booking anywhere on the day off. That emptiness is asserted directly
 * instead.
 */
const context = readSeedContext();

// Serial: each case reseeds the shared database.
test.describe.configure({ mode: 'serial' });

test.afterAll(() => {
  // Leave the database as globalSetup left it, so spec order cannot matter.
  seedFor(context.baseReference);
});

test(`checks in on a future Thursday board (${context.thursday})`, async ({ page }) => {
  seedFor(context.thursday);
  await login(page);
  await navigateTo(page, context.thursday);
  await expect(checkableCards(page)).toHaveCount(SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY);
  await checkInFirst(page);
});

test(`checks in on a future Saturday board (${context.saturday})`, async ({ page }) => {
  seedFor(context.saturday);
  await login(page);
  await navigateTo(page, context.saturday);
  await expect(checkableCards(page)).toHaveCount(SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY);
  await checkInFirst(page);
});

test(`crosses a future month boundary (${context.monthEnd} -> ${context.nextMonthStart})`, async ({
  page,
}) => {
  seedFor(context.monthBoundaryTarget);
  await login(page);
  await navigateTo(page, context.monthEnd);

  // Both sides of the boundary observed in the real UI, in both directions —
  // the label must step from the last day of one month to the first of the
  // next without skipping, repeating or rolling.
  await expect(page.locator('.date-label')).toHaveText(context.monthEnd);
  await page.getByRole('button', { name: 'Next day' }).click();
  await expect(page.locator('.date-label')).toHaveText(context.nextMonthStart);
  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(page.locator('.date-label')).toHaveText(context.monthEnd);

  // ...then a real check-in on whichever side actually carries bookings. A
  // month end that lands on the day off has none, so the target moves to the
  // first of the next month rather than pretending a booking exists.
  await navigateTo(page, context.monthBoundaryTarget);
  await expect(checkableCards(page)).toHaveCount(SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY);
  await checkInFirst(page);
});

test(`shows an empty board on the weekly day off (${context.dayOff})`, async ({ page }) => {
  // Seeded FOR the day off, so its neighbours are full and only the day itself
  // is empty. Without that this would pass against any date at all.
  seedFor(context.dayOff);
  expect(isMuscatDayOff(context.dayOff)).toBe(true);
  await login(page);

  await navigateTo(page, context.dayOff);
  await expect(page.locator('li.booking-card')).toHaveCount(0);

  // The PRECEDING day IS populated, which is what makes the emptiness above a
  // fact about the day off rather than about the seed having failed. It has to
  // be the preceding one: the seed closes Al Khuwair on the day AFTER its
  // reference date, so the following day is empty for this branch too — for an
  // entirely different reason.
  await page.getByRole('button', { name: 'Previous day' }).click();
  await expect(page.locator('.date-label')).not.toHaveText(context.dayOff);
  await expect(page.locator('li.booking-card').first()).toBeVisible();
});
