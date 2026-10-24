/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { chooseCategory } from './helpers/category';
import {
  canonicalRecords,
  configureControlledDiscoveryProviders,
  openPlaylistImport,
} from './helpers/source-scan';
import { saveReviewedSource } from './helpers/source-scan';
import { test, expect, type Page } from '@playwright/test';
import { chooseSettingsSection } from './helpers/settings-section';

const text =
  '#EXTM3U\n#EXTINF:-1 tvg-id="one" group-title="News",Channel One\nhttps://fixture.invalid/one\n#EXTINF:-1 tvg-id="two" group-title="Sports",Channel Two\nhttps://fixture.invalid/two\n';
async function add(page: Page, name = 'catalog.data', updateSourceId?: string): Promise<void> {
  await openPlaylistImport(page, updateSourceId);
  await page
    .locator('#playlist-file')
    .setInputFiles({ name, mimeType: 'application/octet-stream', buffer: Buffer.from(text) });
  await saveReviewedSource(page);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
}
test.beforeEach(async ({ page }) => {
  await page.route('https://fixture.invalid/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
});

test('manual receiver entry is optional and browser preview never claims a connection', async ({
  page,
}) => {
  await page.locator('#cast-button').click();
  await expect(page.locator('#cast-known-address')).not.toBeVisible();
  await page.getByLabel('Connection method').selectOption('known');
  await page.locator('#cast-known-address').fill('192.168.1.23');
  await page.locator('#cast-known-name').fill('My TV');
  await page.locator('#cast-known-check').click();
  await expect(page.locator('#cast-status')).toHaveText(
    'Casting requires the installed application.',
  );
  await expect(page.locator('#cast-devices .cast-device')).toHaveCount(0);
  await expect(page.locator('#cast-known-check')).toBeEnabled();
  await expect(page.locator('#cast-stop')).toBeDisabled();
});

test('channel removal persists across reload and refresh, and can be restored', async ({
  page,
}) => {
  await add(page);
  const sourceId = JSON.parse((await canonicalRecords(page))[0] as string).sources[0].id;
  await page.locator('.channel').first().click();
  await page.locator('#remove-channel').click();
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await page.reload();
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await add(page, 'catalog.data', sourceId);
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await expect(page.locator('.channel strong')).toHaveText('Channel Two');
  await page.locator('#settings-button').click();
  await page.locator('#restore-channels').click();
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
});
test('removing one source retains channels from the other source', async ({ page }) => {
  await add(page, 'first.data');
  await add(page, 'second.data');
  await expect(page.locator('#channel-count')).toHaveText('4 channels');
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'advanced');
  await page.getByRole('button', { name: 'Remove source first.data', exact: true }).click();
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
  await page.reload();
  await expect(page.locator('#source-status')).toHaveText('1 playlist saved');
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
});

test('individual provider removal survives reload without deleting saved channels or restoring defaults', async ({
  page,
}) => {
  await add(page);
  await configureControlledDiscoveryProviders(page);
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'advanced');
  const configurationDetails = page
    .locator('details')
    .filter({ has: page.locator('#provider-configuration') });
  if (!(await configurationDetails.evaluate((node) => (node as HTMLDetailsElement).open)))
    await configurationDetails.locator(':scope > summary').click();
  const configuration = JSON.parse(await page.locator('#provider-configuration').inputValue());
  configuration.reviewedGuideProviders = [
    {
      id: 'controlled-removable-guide',
      name: 'Controlled guide',
      location: 'https://fixture.invalid/programs.xml',
      provenance: 'https://fixture.invalid/guide-project',
      limitations: 'Controlled removal fixture; no guide acquisition or coverage claim.',
    },
  ];
  await page.locator('#provider-configuration').fill(JSON.stringify(configuration));
  await page.locator('#save-provider-configuration').click();
  await expect(page.locator('#provider-configuration-status')).toContainText(
    'Discovery providers saved.',
  );
  await page.locator('[data-close="settings-dialog"]').click();
  const original = await canonicalRecords(page);
  const initial = JSON.parse(String(original[1]));
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'advanced');
  const details = page.locator('details').filter({ has: page.locator('#provider-management') });
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
    await details.locator('summary').click();
  await page
    .getByRole('button', { name: 'Remove channel provider Controlled global catalog', exact: true })
    .click();
  await expect(
    page.getByRole('button', {
      name: 'Remove channel provider Controlled global catalog',
      exact: true,
    }),
  ).toHaveCount(0);
  await page
    .getByRole('button', {
      name: 'Remove channel provider Controlled Free-TV catalog',
      exact: true,
    })
    .click();
  await expect(page.getByRole('list', { name: 'Channel providers', exact: true })).toContainText(
    'No discovery providers configured.',
  );
  const guide = initial.reviewedGuideProviders[0];
  await page
    .getByRole('button', { name: `Remove guide provider ${guide.name}`, exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: `Remove guide provider ${guide.name}`, exact: true }),
  ).toHaveCount(0);
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const saved = await canonicalRecords(page);
  expect(saved[0]).toEqual(original[0]);
  expect(saved[2]).toEqual(original[2]);
  const preferences = JSON.parse(String(saved[1]));
  expect(preferences.reviewedChannelProviders).toEqual([]);
  expect(preferences.reviewedGuideProviders).toEqual(initial.reviewedGuideProviders.slice(1));
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'advanced');
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
    await details.locator('summary').click();
  await expect(page.getByRole('list', { name: 'Channel providers', exact: true })).toContainText(
    'No discovery providers configured.',
  );
});

test('source removal atomically removes its discovery suggestion and preserves other sources and favorites after reload', async ({
  page,
}) => {
  const location = 'https://fixture.invalid/source';
  await page.route(location, (route) => route.fulfill({ body: text, contentType: 'text/plain' }));
  await page.route(/^https:\/\/fixture\.invalid\/(one|two)$/, (route) =>
    route.fulfill({
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
    }),
  );
  await openPlaylistImport(page);
  await page.locator('#playlist-url').fill(location);
  await page.locator('#load-button').click();
  await expect(
    page.getByRole('dialog', { name: 'Review source scan' }).getByRole('status'),
  ).toHaveText(
    '2 channels responded. 0 could not be verified. Save to add the responding channels.',
  );
  await saveReviewedSource(page);
  await add(page, 'retained.data');
  const initial = await canonicalRecords(page);
  const catalog = JSON.parse(String(initial[0]));
  const source = catalog.sources.find((entry: { location: string }) => entry.location === location);
  const retained = catalog.channels.find(
    (entry: { sourceId: string }) => entry.sourceId !== source.id,
  );
  await page.locator(`[data-channel-id="${retained.id}"][data-channel-action="favorite"]`).click();
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'advanced');
  const details = page.locator('details').filter({ has: page.locator('#provider-configuration') });
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
    await details.locator('summary').click();
  const configuration = JSON.parse(await page.locator('#provider-configuration').inputValue());
  configuration.reviewedChannelProviders = [
    { id: 'remove-me', name: 'Fixture source', location, provenance: 'https://fixture.invalid/' },
  ];
  await page.locator('#provider-configuration').fill(JSON.stringify(configuration));
  await page.locator('#save-provider-configuration').click();
  await expect(page.locator('#provider-configuration-status')).toContainText(
    'Discovery providers saved.',
  );
  await page.getByRole('button', { name: `Remove source ${source.name}`, exact: true }).click();
  await expect(page.locator('#notice')).toHaveText(
    'Source removed from saved channels and discovery. Other sources and favorites are preserved.',
  );
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const saved = await canonicalRecords(page);
  const after = JSON.parse(String(saved[0]));
  expect(after.sources).toEqual(
    catalog.sources.filter((entry: { id: string }) => entry.id !== source.id),
  );
  expect(after.channels).toEqual(
    catalog.channels.filter((entry: { sourceId: string }) => entry.sourceId !== source.id),
  );
  const prefs = JSON.parse(String(saved[1]));
  expect(prefs.sources).toEqual(after.sources);
  expect(prefs.reviewedChannelProviders).toEqual([]);
  expect(prefs.favorites).toContain(retained.id);
});
test('directional remote navigates and selects without playing while browsing', async ({
  page,
}) => {
  await add(page);
  await page.locator('#channel-list').focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.channel').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.channel').last()).toBeFocused();
  await expect(page.locator('#watch-title')).toHaveText('Make yourself comfortable.');
  await page.keyboard.press('Enter');
  await expect(page.locator('#watch-title')).toHaveText('Channel Two');
});
test('extensionless user URL loads catalogs without a built-in provider shortcut', async ({
  page,
}) => {
  await page.route('https://fixture.invalid/source', (route) =>
    route.fulfill({ status: 200, body: text, contentType: 'text/plain' }),
  );
  await openPlaylistImport(page);
  await expect(page.locator('#iptv-button')).toHaveCount(0);
  await page.route(/^https:\/\/fixture\.invalid\/(one|two)$/, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
    }),
  );
  await page.locator('#playlist-url').fill('https://fixture.invalid/source');
  await page.locator('#load-button').click();
  await saveReviewedSource(page);
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
});

test('worker removes exact duplicates while preserving distinct channel metadata', async ({
  page,
}) => {
  const entry =
    '#EXTINF:-1 tvg-id="one" group-title="News",Channel One\nhttps://fixture.invalid/one\n';
  const distinct = entry.replace('group-title="News"', 'group-title="Sports"');
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'duplicates.data',
    mimeType: 'text/plain',
    buffer: Buffer.from('#EXTM3U\n' + entry + entry + distinct),
  });
  await saveReviewedSource(page);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
  await expect(page.locator('.channel')).toHaveCount(2);
});

test('media and channel keys respect filters, modal scope, and saved audio settings', async ({
  page,
}) => {
  await add(page);
  const key = async (value: string) =>
    page.evaluate(
      (key) =>
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        ),
      value,
    );
  await key('ChannelUp');
  await expect(page.locator('#watch-title')).toHaveText('Channel One');
  await key('ChannelUp');
  await expect(page.locator('#watch-title')).toHaveText('Channel Two');
  await chooseCategory(page, 'News');
  await key('ChannelUp');
  await expect(page.locator('#watch-title')).toHaveText('Channel One');
  await page.locator('#settings-button').click();
  await key('ChannelUp');
  await expect(page.locator('#watch-title')).toHaveText('Channel One');
  await key('AudioVolumeMute');
  await expect(page.locator('#mute-button')).toHaveAttribute('aria-pressed', 'true');
  await key('AudioVolumeDown');
  await expect(page.locator('#volume')).toHaveValue('0.75');
  await key('BrowserBack');
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  await key('MediaStop');
  await expect(page.locator('#watch-title')).toHaveText('Make yourself comfortable.');
  await page.reload();
  await expect(page.locator('#volume')).toHaveValue('0.75');
  await expect(page.locator('#mute-button')).toHaveAttribute('aria-pressed', 'true');
});
