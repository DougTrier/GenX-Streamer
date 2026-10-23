import { openPlaylistImport } from './helpers/source-scan';
import { saveReviewedSource } from './helpers/source-scan';
import { test, expect } from '@playwright/test';

test('automatic update intervals are clear and survive an application restart', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-button').click();
  const selector = page.getByRole('combobox', { name: 'Automatic updates', exact: true });
  await expect(selector.locator('option')).toHaveText([
    'Off',
    'Hourly',
    '4 times daily',
    'Daily',
    'Weekly',
    'Every 2 weeks',
    'Monthly',
  ]);
  for (const cadence of ['hourly', 'every6hours', 'weekly', 'every2weeks', 'monthly', 'off']) {
    await selector.selectOption(cadence);
    await expect(selector).toBeEnabled();
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await page.locator('#settings-button').click();
    await expect(selector).toHaveValue(cadence);
  }
});

test('daily source update is opt-in, retains cache on failure and persists its attempt', async ({
  page,
}) => {
  let downloads = 0;
  await page.route('https://fixture.invalid/daily', (route) => {
    downloads++;
    return route.fulfill(
      downloads === 1
        ? {
            status: 200,
            contentType: 'text/plain',
            body: '#EXTM3U\n#EXTINF:-1 tvg-id="daily",Saved channel\nhttps://fixture.invalid/video\n#EXTINF:-1,Unsupported channel\nrtmp://fixture.invalid/video\n',
          }
        : { status: 503, body: 'Unavailable' },
    );
  });
  await page.route('https://fixture.invalid/video', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
    }),
  );
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await openPlaylistImport(page);
  await page.locator('#playlist-url').fill('https://fixture.invalid/daily');
  await page.locator('#load-button').click();
  const review = page.getByRole('dialog', { name: 'Review source scan' });
  await expect(
    review.getByRole('button', { name: 'Save selected channels', exact: true }),
  ).toBeEnabled();
  await expect(review).toContainText('Skipped unsupported stream protocols: rtmp 1');
  await expect(review.getByLabel('Candidate channels')).not.toContainText('Unsupported channel');
  await saveReviewedSource(page);
  await expect(page.locator('.channel strong')).toHaveText('Saved channel');
  await page.locator('#settings-button').click();
  await expect(page.locator('#daily-source-refresh')).toHaveValue('off');
  expect(downloads).toBe(1);
  await page.locator('#daily-source-refresh').selectOption('daily');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await expect.poll(() => downloads).toBe(2);
  await expect(page.locator('#refresh-button')).toBeEnabled();
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.locator('.channel strong')).toHaveText('Saved channel');
  await page.locator('#settings-button').click();
  await expect(page.locator('#source-refresh-status')).toContainText('1 failed and retained');
  await expect(page.locator('#daily-source-refresh')).toHaveValue('daily');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-button').click();
  await expect(page.locator('#daily-source-refresh')).toHaveValue('daily');
  expect(downloads).toBe(2);
  await page.locator('#daily-source-refresh').selectOption('off');
  await expect(page.locator('#daily-source-refresh')).toBeEnabled();
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-button').click();
  await expect(page.locator('#daily-source-refresh')).toHaveValue('off');
});
