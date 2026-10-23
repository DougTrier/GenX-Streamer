import { openPlaylistImport } from './helpers/source-scan';
import { expect, test } from '@playwright/test';

test('Settings playlist import preserves website discovery without an Add channels header button', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  // Includes the Local globe. The Guide sits in the channel row, not the header.
  await expect(page.locator('.top-actions button:visible')).toHaveCount(6);
  await expect(page.locator('.sidehead #guide-button')).toBeVisible();
  await expect(page.locator('#live-tv-button')).toHaveText('Free TV');
  await expect(page.locator('#paid-tv-button')).toBeVisible();
  await expect(page.locator('#genxtra-button')).toBeVisible();
  await expect(page.locator('#search-programs')).toBeVisible();
  await openPlaylistImport(page);
  await page.getByLabel('Source URL', { exact: true }).fill('https://example.invalid/channels');
  await page.locator('#find-sources-button').click();
  const discovery = page.getByRole('dialog', { name: 'Find sources on a website', exact: true });
  await expect(discovery).toBeVisible();
  await expect(discovery.getByLabel('Website URL', { exact: true })).toHaveValue(
    'https://example.invalid/channels',
  );
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(discovery.getByRole('button', { name: 'Scan website', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(discovery).not.toBeVisible();
  await expect(page.locator('#settings-button')).toBeFocused();
});

test('Settings exposes Exit and browser preview explains how to leave', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-button').click();
  await page.getByRole('button', { name: 'Exit app', exact: true }).click();
  await expect(page.locator('#notice')).toHaveText('Close this browser tab to exit the preview.');
  await expect(page.locator('#exit-button')).toBeEnabled();
});
