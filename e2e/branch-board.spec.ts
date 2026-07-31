import { expect, test } from '@playwright/test';
import { SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY } from '@foot-repose/db';
import { checkableCards, checkInFirst, login, navigateTo } from './board';
import { readSeedContext } from './seed-context';

/**
 * End-to-end vertical slice: login → board → check-in → status badge updates
 * AND the audit log gains exactly one booking.check_in row.
 *
 * The board's date comes from the API's own clock, and the seeded reference
 * comes from `globalSetup` — so this reads the reference from the persisted
 * seed context rather than recomputing "today" and assuming the two processes
 * agreed. They need not: a run can cross Muscat midnight between them.
 */
const context = readSeedContext();

test('login → bookings board → check-in → status + audit log', async ({ page }) => {
  await login(page);

  // Navigate from whatever the board actually reports to the seeded day.
  await navigateTo(page, context.baseReference);
  await expect(checkableCards(page)).toHaveCount(SEED_CONFIRMED_PER_BRANCH_ON_REFERENCE_DAY);

  await checkInFirst(page);
});
