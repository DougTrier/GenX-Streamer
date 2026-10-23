import { openPlaylistImport } from './helpers/source-scan';
import { saveReviewedSource } from './helpers/source-scan';
import { test, expect } from '@playwright/test';

const playlist =
  '#EXTM3U\n' +
  '#EXTINF:-1 tvg-id="fox" tvg-country="US" tvg-region="NORAM" tvg-state="US-IL" group-title="News",FOX Chicago\nhttps://media.invalid/fox\n' +
  '#EXTINF:-1 tvg-id="ca" tvg-country="CA" tvg-state="CA-ON" group-title="News",Canada Station\nhttps://media.invalid/ca\n' +
  '#EXTINF:-1 tvg-id="unknown" group-title="Sports",Unknown Station\nhttps://media.invalid/unknown\n';

test('declared geography survives import/reload and location filters never tune', async ({
  page,
}) => {
  let streamRequests = 0;
  await page.route('https://media.invalid/**', (route) => {
    streamRequests++;
    return route.abort();
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'locations.m3u',
    mimeType: 'text/plain',
    buffer: Buffer.from(playlist),
  });
  await saveReviewedSource(page);
  await expect(page.locator('#channel-count')).toHaveText('3 channels');
  await page.getByRole('button', { name: 'Location and sort', exact: true }).click();
  await page.locator('.geography-countries button[data-code="US"]').click();
  await page.getByLabel('State / subdivision', { exact: true }).selectOption('US-IL');
  await expect(page.locator('.channel strong')).toHaveText('FOX Chicago');
  // Countries are toggles: uncheck the United States, check Canada.
  await page.locator('.geography-countries button[data-code="US"]').click();
  await page.locator('.geography-countries button[data-code="CA"]').click();
  await expect(page.getByLabel('State / subdivision')).toHaveValue('');
  await expect(page.locator('.channel strong')).toHaveText('Canada Station');
  await page.locator('.geography-countries button[data-code="?"]').click();
  await expect(page.locator('.channel strong')).toHaveText('Unknown Station');
  expect(streamRequests).toBe(0);
  await page.reload();
  await expect(page.locator('#channel-count')).toHaveText('3 channels');
  await page.getByRole('button', { name: 'Location and sort', exact: true }).click();
  await page.locator('.geography-countries button[data-code="US"]').click();
  await page.getByLabel('State / subdivision', { exact: true }).selectOption('US-IL');
  await expect(page.locator('.channel strong')).toHaveText('FOX Chicago');
  expect(streamRequests).toBe(0);
});
