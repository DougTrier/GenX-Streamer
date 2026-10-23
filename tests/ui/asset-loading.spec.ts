import { openPlaylistImport } from './helpers/source-scan';
import { expect, test } from '@playwright/test';

test('bundled GX artwork decodes while idle controls reflect their actual owners', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  for (const id of ['brand-icon', 'welcome-icon']) {
    await expect
      .poll(() => page.locator(`#${id}`).evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBeGreaterThan(0);
  }
  await expect(page.locator('.brand-wordmark')).toBeVisible();
  await expect(page.locator('.brand-copy')).toBeHidden();
  await expect
    .poll(() =>
      page.locator('.brand-wordmark').evaluate((image: HTMLImageElement) => image.naturalWidth),
    )
    .toBeGreaterThan(0);
  await expect(page.locator('#pause-button')).toBeDisabled();
  await expect(page.locator('#refresh-button')).toBeDisabled();
  await expect(page.locator('#mute-button')).toBeEnabled();
  await expect(page.locator('#expand-button')).toBeEnabled();
  await expect(page.locator('#fullscreen-button')).toBeEnabled();
});

test('missing decorative GX artwork preserves text, layout space and setup access', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.brand-wordmark')).toBeVisible();
  const healthyLockup = await page.locator('.brand-lockup').boundingBox();
  expect(healthyLockup?.width).toBeGreaterThan(0);
  expect(healthyLockup?.height).toBeGreaterThan(0);
  let blocked = 0;
  await page.route(
    /(?:tmg-retro-tv-96.*\.png|genx-wordmark.*\.(?:svg|png)|genx-play-display.*\.jpg)/,
    async (route) => {
      blocked++;
      await route.abort();
    },
  );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect.poll(() => blocked).toBeGreaterThan(0);
  const image = page.locator('#brand-icon');
  await expect(image).toHaveCSS('visibility', 'hidden');
  const bounds = await image.boundingBox();
  expect(bounds?.width).toBeGreaterThan(0);
  expect(bounds?.height).toBeGreaterThan(0);
  // The empty picture shows the play-screen artwork (the small TV icon is not
  // used there); without the artwork its words still show.
  await expect(page.locator('#player-overlay')).toHaveAttribute('data-art', 'play');
  await expect(page.locator('#overlay-title')).toBeVisible();
  await expect(page.locator('.brand')).toContainText('GenX');
  await expect(page.locator('.brand-wordmark')).toBeHidden();
  await expect(page.locator('.brand-copy')).toBeVisible();
  await expect(page.locator('.brand-copy')).toContainText('Streamer');
  const lockup = await page.locator('.brand-lockup').boundingBox();
  expect(lockup?.width).toBe(healthyLockup?.width);
  expect(lockup?.height).toBe(healthyLockup?.height);
  await expect(page.locator('#overlay-message')).toContainText(/search/i);
  await openPlaylistImport(page);
  await expect(page.locator('#import-dialog')).toBeVisible();
  await page.getByRole('button', { name: 'Close import' }).click();
  await expect(page.locator('#pause-button')).toBeDisabled();
  expect(errors).toEqual([]);
});
