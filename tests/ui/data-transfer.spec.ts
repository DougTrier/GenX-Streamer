import { openPlaylistImport } from './helpers/source-scan';
import { saveReviewedSource } from './helpers/source-scan';
import { chooseSettingsSection } from './helpers/settings-section';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const playlist =
  '#EXTM3U\n#EXTINF:-1 tvg-id="one" group-title="News",Original channel\nhttps://fixture.invalid/one\n';
test.beforeEach(async ({ page }) => {
  await page.route('https://fixture.invalid/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await openPlaylistImport(page);
  await page
    .locator('#playlist-file')
    .setInputFiles({ name: 'original.m3u', mimeType: 'text/plain', buffer: Buffer.from(playlist) });
  await saveReviewedSource(page);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'data');
});

test('full backup uses the real worker and atomically restores the catalog after review', async ({
  page,
}) => {
  const downloadReady = page.waitForEvent('download');
  await page.locator('#backup-export').click();
  const download = await downloadReady;
  const bytes = await readFile((await download.path())!);
  const backup = JSON.parse(bytes.toString());
  expect(backup.format).toBe('genx-tv-backup');
  expect(backup.catalog.channels).toHaveLength(1);
  await chooseSettingsSection(page, 'advanced');
  await page.getByRole('button', { name: 'Remove source original.m3u', exact: true }).click();
  await expect(page.locator('#channel-count')).toHaveText('0 channels');
  await chooseSettingsSection(page, 'data');
  await page
    .locator('#backup-file')
    .setInputFiles({ name: 'restore.json', mimeType: 'application/json', buffer: bytes });
  await expect(page.locator('#transfer-apply')).toBeEnabled();
  await expect(page.locator('#channel-count')).toHaveText('0 channels');
  await page.locator('#transfer-apply').click();
  await expect(page.locator('#transfer-dialog')).not.toBeVisible();
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.channel strong')).toHaveText('Original channel');
});

test('larger full backups pass file admission and round trip through the real worker without trimming records', async ({
  page,
}) => {
  test.setTimeout(60000);
  const firstDownload = page.waitForEvent('download');
  await page.locator('#backup-export').click();
  const record = JSON.parse((await readFile((await (await firstDownload).path())!)).toString());
  const template = record.catalog.channels[0];
  record.catalog.channels = Array.from({ length: 1000 }, (_, index) => ({
    ...template,
    id: `large-${index}`,
    name: `${index}-${'n'.repeat(16000)}`,
  }));
  record.preferences.favorites = Array.from(
    { length: 800 },
    (_, index) => `${index}-${'pending'.repeat(1142)}`,
  );
  record.health = [];
  const input = Buffer.from(JSON.stringify(record));
  expect(input.byteLength).toBeGreaterThan(20 * 1024 * 1024);
  await page
    .locator('#backup-file')
    .setInputFiles({ name: 'large-backup.json', mimeType: 'application/json', buffer: input });
  await expect(page.locator('#transfer-apply')).toBeEnabled({ timeout: 30000 });
  await expect(page.locator('#transfer-status')).toContainText('1000 channels');
  await page.locator('#transfer-apply').click();
  await expect(page.locator('#transfer-dialog')).not.toBeVisible({ timeout: 30000 });
  const downloadReady = page.waitForEvent('download');
  await page.locator('#backup-export').click();
  const output = await readFile((await (await downloadReady).path())!);
  expect(output.byteLength).toBeGreaterThan(20 * 1024 * 1024);
  const restored = JSON.parse(output.toString());
  expect(restored.catalog.channels).toHaveLength(1000);
  expect(restored.preferences.favorites).toEqual(record.preferences.favorites);
  expect(restored.catalog.channels[999].name).toBe(record.catalog.channels[999].name);
});

test('previous app migration preserves unrelated sources and applies individual removals', async ({
  page,
}) => {
  await chooseSettingsSection(page, 'migration');
  await page.getByText('Import from the previous app', { exact: true }).click();
  await page.locator('#legacy-source-name').fill('My old channels');
  const legacy = {
    master_db: [
      { name: 'Old favorite', url: 'https://fixture.invalid/old-one', group: 'Sports' },
      { name: 'Old removed', url: 'https://fixture.invalid/old-two', group: 'News' },
    ],
    favorites: ['https://fixture.invalid/old-one'],
    blacklist: ['https://fixture.invalid/old-two'],
  };
  await page.locator('#legacy-file').setInputFiles({
    name: 'selected-old.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(legacy)),
  });
  await expect(page.locator('#transfer-apply')).toBeEnabled();
  await expect(page.locator('#transfer-status')).toContainText('3 channels');
  await page.locator('#transfer-cancel').click();
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await page.locator('#legacy-file').setInputFiles({
    name: 'selected-old.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(legacy)),
  });
  await expect(page.locator('#transfer-apply')).toBeEnabled();
  await page.locator('#transfer-apply').click();
  await expect(page.locator('#transfer-dialog')).not.toBeVisible();
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
  await page.locator('[data-filter="favorites"]').click();
  await expect(page.locator('.channel strong')).toHaveText('Old favorite');
});

test('failure between IndexedDB writes rolls back the pair and does not acknowledge success', async ({
  page,
}) => {
  const downloadReady = page.waitForEvent('download');
  await page.locator('#backup-export').click();
  const backupRecord = JSON.parse(
    (await readFile((await (await downloadReady).path())!)).toString(),
  );
  backupRecord.catalog.channels[0].name = 'Attempted replacement';
  backupRecord.preferences.volume = 0.15;
  const backup = Buffer.from(JSON.stringify(backupRecord));
  await page
    .locator('#backup-file')
    .setInputFiles({ name: 'pair.json', mimeType: 'application/json', buffer: backup });
  await expect(page.locator('#transfer-apply')).toBeEnabled();
  await page.evaluate(() => {
    // Executes in the browser's actual storage implementation.
    const prototype = IDBObjectStore.prototype;
    const previous = prototype.put;
    prototype.put = function (...args) {
      if (args[1] === 'preferences') throw new Error('Injected second-record failure');
      return previous.apply(this, args);
    };
  });
  await page.locator('#transfer-apply').click();
  await expect(page.locator('#transfer-status')).toContainText('Import was not saved');
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.channel strong')).toHaveText('Original channel');
  await expect(page.locator('#volume')).toHaveValue('0.8');
});
