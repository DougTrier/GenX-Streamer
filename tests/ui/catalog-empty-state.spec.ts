import { openPlaylistImport } from './helpers/source-scan';
import { saveReviewedSource } from './helpers/source-scan';
import { chooseSettingsSection } from './helpers/settings-section';
import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route('https://fixture.invalid/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
});

test('no saved sources explains how to start and cannot refresh', async ({ page }) => {
  await expect(page.locator('#source-status')).toHaveText('0 playlists saved');
  await expect(page.locator('#list-empty')).toHaveText('Select the search icon to find channels.');
  await expect(page.locator('#refresh-button')).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Search channels' }).fill('anything');
  await expect(page.locator('#list-empty')).toHaveText('Select the search icon to find channels.');
});

test('removing the last channel explains restoration across restart instead of adding a source', async ({
  page,
}) => {
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'one-channel.data',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      '#EXTM3U\n#EXTINF:-1 tvg-id="one" group-title="News",Only channel\nhttps://fixture.invalid/one\n',
    ),
  });
  await saveReviewedSource(page);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await page.getByRole('searchbox', { name: 'Search channels' }).fill('absent');
  await expect(page.locator('#list-empty')).toHaveText(
    'No channels here. Try another filter or search.',
  );
  await page.getByRole('searchbox', { name: 'Search channels' }).fill('');
  await page.locator('.channel').click();
  await page.locator('#remove-channel').click();
  const message = 'All saved channels are removed. Restore removed channels in Settings.';
  await expect(page.locator('#list-empty')).toHaveText(message);
  await expect(page.locator('#source-status')).toHaveText('1 playlist saved');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#list-empty')).toHaveText(message);
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'sources');
  await page.locator('#restore-channels').click();
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await expect(page.locator('#list-empty')).toBeHidden();
});

test('reviewed empty-source backup stays distinct from missing sources after restart', async ({
  page,
}) => {
  const source = {
    id: 'empty-source',
    name: 'Saved empty source',
    location: 'https://fixture.invalid/empty',
    kind: 'url',
  };
  const backup = {
    format: 'genx-tv-backup',
    schemaVersion: 1,
    catalog: { schemaVersion: 1, sources: [source], channels: [] },
    preferences: {
      schemaVersion: 1,
      sources: [source],
      favorites: [],
      removedChannels: [],
      volume: 0.8,
      muted: false,
      panelWidth: 320,
    },
  };
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'data');
  await page.locator('#backup-file').setInputFiles({
    name: 'empty-source.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.locator('#transfer-apply')).toBeEnabled();
  await page.locator('#transfer-apply').click();
  await expect(page.locator('#transfer-dialog')).not.toBeVisible();
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#source-status')).toHaveText('1 playlist saved');
  await expect(page.locator('#list-empty')).toHaveText(
    'Your saved sources contain no channels. Update or replace a source in Settings.',
  );
  await expect(page.locator('#refresh-button')).toBeEnabled();
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'sources');
  await expect(page.locator('#restore-channels')).toBeDisabled();
});
