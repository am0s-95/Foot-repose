import { expect, test } from '@playwright/test';

/**
 * Customer catalog slice: home directory → branch page → real per-branch
 * services with OMR prices (seeded fictional data).
 */
test('branch page lists its services with OMR prices', async ({ page }) => {
  await page.goto('http://localhost:3003/');
  await expect(page.getByRole('heading', { name: 'Foot Repose' })).toBeVisible();

  // Branches are ordered by name; Al Amerat comes first in the seed set.
  await page.getByRole('link', { name: /Foot Repose Al Amerat/ }).click();
  await expect(page).toHaveURL(/\/branches\//);

  await expect(page.getByRole('heading', { name: 'Foot Repose Al Amerat' })).toBeVisible();
  await expect(page.getByText('Classic Foot Reflexology')).toBeVisible();
  await expect(page.getByText(/OMR \d+\.\d{3}/).first()).toBeVisible();
  // No booking UI in this slice.
  await expect(page.getByRole('button', { name: /book/i })).toHaveCount(0);
});
