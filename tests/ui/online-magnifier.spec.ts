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

import { expect, test, type Page } from '@playwright/test';
import { installOnlineDirectoryFixture } from './online-directory-fixture';
import { canonicalRecords, configureControlledDiscoveryProviders } from './helpers/source-scan';
import { chooseSettingsSection } from './helpers/settings-section';
import known from '../../src/discovery/known-directory-ids.json' with { type: 'json' };

const location = 'https://online-catalog.fixture.invalid/index.m3u';
const media = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n';
const configuredLocations = [
  'https://iptv-org.github.io/iptv/index.m3u',
  'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
] as const;
async function ready(page: Page) {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
}
async function query(page: Page) {
  await page.locator('#search').fill('Fox');
  await page.locator('#search-programs').click();
}

test('directory outage scans only previously configured sources without a metadata preference rewrite', async ({
  page,
}) => {
  await page.route('https://**', (route) => route.abort());
  const directory = await installOnlineDirectoryFixture(page, [], {
    failedIds: known.repositoryIds,
  });
  const catalogs: string[] = [];
  const probes: string[] = [];
  let preferenceWriteCount = 0;
  for (const [index, url] of configuredLocations.entries())
    await page.route(url, async (route) => {
      catalogs.push(url);
      // Publication may update saved source metadata later; directory fallback must not.
      expect((await canonicalRecords(page))[1]).toEqual(originalPreferences);
      expect(preferenceWriteCount).toBe(0);
      await route.fulfill({
        contentType: 'text/plain',
        body:
          index === 0
            ? '#EXTM3U\n#EXTINF:-1,Fox authorized\nhttps://fox-authorized.fixture.invalid/feed\n#EXTINF:-1,Other excluded\nhttps://other-excluded.fixture.invalid/feed\n'
            : '#EXTM3U\n#EXTINF:-1,Other authorized\nhttps://other-authorized.fixture.invalid/feed\n',
      });
    });
  await page.route(
    /https:\/\/(fox-authorized|other-excluded|other-authorized)\.fixture\.invalid\/feed/,
    (route) => {
      probes.push(route.request().url());
      return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: media });
    },
  );
  await ready(page);
  await configureControlledDiscoveryProviders(page);
  const originalPreferences = (await canonicalRecords(page))[1];
  await page.evaluate(() => {
    Reflect.set(window, 'fallbackPreferenceWrites', 0);
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'records' && key === 'preferences')
        Reflect.set(
          window,
          'fallbackPreferenceWrites',
          Reflect.get(window, 'fallbackPreferenceWrites') + 1,
        );
      return original.call(this, value, key);
    };
  });
  // Read the counter at each acquisition, before any channel publication is possible.
  await page.route(configuredLocations[0], async (route) => {
    preferenceWriteCount = await page.evaluate(() =>
      Reflect.get(window, 'fallbackPreferenceWrites'),
    );
    await route.fallback();
  });
  await query(page);
  await expect(page.locator('#inline-scan-status')).toHaveText('1 channel saved.');
  expect(directory.repositories).toEqual(known.repositoryIds);
  expect(catalogs.sort()).toEqual([...configuredLocations].sort());
  expect(probes).toEqual(['https://fox-authorized.fixture.invalid/feed']);
  await expect(page.locator('.channel strong')).toHaveText('Fox authorized');
  const before = JSON.parse(String(originalPreferences));
  const after = JSON.parse(String((await canonicalRecords(page))[1]));
  expect(after.reviewedChannelProviders).toEqual(before.reviewedChannelProviders);
  expect(after.reviewedGuideProviders).toEqual(before.reviewedGuideProviders);
  expect(after.favorites).toEqual(before.favorites);
  expect(after.removedChannels).toEqual(before.removedChannels);
});

test('directory outage with a fresh empty registry acquires and writes nothing', async ({
  page,
}) => {
  let acquisitions = 0;
  await page.route('https://**', (route) => {
    acquisitions++;
    return route.abort();
  });
  const directory = await installOnlineDirectoryFixture(page, [], {
    failedIds: known.repositoryIds,
  });
  await ready(page);
  const before = await canonicalRecords(page);
  await query(page);
  await expect(page.locator('#inline-scan-status')).toContainText('No public channel sources');
  await expect(page.locator('#search-programs')).toBeEnabled();
  expect(directory.repositories).toEqual(known.repositoryIds);
  expect(acquisitions).toBe(0);
  expect(await canonicalRecords(page)).toEqual(before);
});

test('Stop during held failed directories prevents fallback to configured sources', async ({
  page,
}) => {
  let acquisitions = 0;
  await page.route('https://**', (route) => {
    acquisitions++;
    return route.abort();
  });
  const directory = await installOnlineDirectoryFixture(page, [], {
    failedIds: known.repositoryIds,
    hold: true,
  });
  await ready(page);
  await configureControlledDiscoveryProviders(page);
  const before = await canonicalRecords(page);
  try {
    await query(page);
    await expect.poll(() => directory.repositories.length).toBe(1);
    await page.locator('#inline-scan-stop').click();
    directory.release();
    await expect(page.locator('#search-programs')).toBeEnabled();
    expect(directory.repositories).toHaveLength(1);
    expect(acquisitions).toBe(0);
    expect(await canonicalRecords(page)).toEqual(before);
  } finally {
    directory.release();
  }
});

test('fresh library acquires nothing until magnifier; all directories resolve before guarded descriptors and filtered automatic save', async ({
  page,
}) => {
  await page.route('https://**', (route) => route.abort());
  const directory = await installOnlineDirectoryFixture(page, [location], {
    failedIds: [known.repositoryIds[1]!],
  });
  let catalogs = 0,
    probes = 0,
    excluded = 0,
    descriptorsAcknowledged = false;
  await page.route(location, async (route) => {
    catalogs++;
    const preferences = JSON.parse(String((await canonicalRecords(page))[1]));
    descriptorsAcknowledged = preferences.reviewedChannelProviders.some(
      (provider: { location: string }) => provider.location === location,
    );
    await route.fulfill({
      contentType: 'text/plain',
      body: '#EXTM3U\n#EXTINF:-1 group-title="News",Fox fixture\nhttps://fox-online.fixture.invalid/feed\n#EXTINF:-1,Other fixture\nhttps://other-online.fixture.invalid/feed\n',
    });
  });
  await page.route('https://fox-online.fixture.invalid/feed', (route) => {
    probes++;
    return route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: media });
  });
  await page.route('https://other-online.fixture.invalid/**', (route) => {
    excluded++;
    return route.abort();
  });
  await ready(page);
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'advanced');
  const providers = page
    .locator('details')
    .filter({ has: page.locator('#provider-configuration') });
  if (!(await providers.evaluate((node) => (node as HTMLDetailsElement).open)))
    await providers.locator(':scope > summary').click();
  const preferences = JSON.parse(await page.locator('#provider-configuration').inputValue());
  expect(preferences.reviewedChannelProviders).toEqual([]);
  expect(preferences.reviewedGuideProviders).toEqual([]);
  await page.locator('[data-close="settings-dialog"]').click();
  await expect(page.locator('#channel-count')).toHaveText('0 channels');
  await page.locator('#search').fill('Fox');
  expect(directory.requests).toEqual([]);
  expect(catalogs).toBe(0);
  expect(probes).toBe(0);
  await page.locator('#search-programs').click();
  await expect(page.locator('#inline-scan-status')).toHaveText('1 channel saved.');
  expect(directory.repositories).toEqual(known.repositoryIds);
  expect(descriptorsAcknowledged).toBe(true);
  expect(catalogs).toBe(1);
  expect(probes).toBe(1);
  expect(excluded).toBe(0);
  await expect(page.locator('.channel strong')).toHaveText('Fox fixture');
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
  const saved = await canonicalRecords(page);
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  expect(await canonicalRecords(page)).toEqual(saved);
  expect(catalogs).toBe(1);
  expect(probes).toBe(1);
});

test('Stop during held metadata joins its owned fetch and rejects late configuration or probes', async ({
  page,
}) => {
  await page.route('https://**', (route) => route.abort());
  const directory = await installOnlineDirectoryFixture(page, [location], { hold: true });
  let payloads = 0;
  await page.route(location, (route) => {
    payloads++;
    return route.abort();
  });
  await ready(page);
  const before = await canonicalRecords(page);
  try {
    await query(page);
    await expect.poll(() => directory.repositories.length).toBe(1);
    await expect(page.locator('#inline-scan-status')).toContainText('Finding');
    await page.locator('#inline-scan-stop').click();
    await expect(page.locator('#inline-scan-stop')).toBeHidden();
    directory.release();
    await expect(page.locator('#search-programs')).toBeEnabled();
    expect(await canonicalRecords(page)).toEqual(before);
    expect(payloads).toBe(0);
    expect(directory.repositories).toHaveLength(1);
  } finally {
    directory.release();
  }
});

test('actual descriptor persistence failure prevents catalog acquisition and probe admission', async ({
  page,
}) => {
  await page.route('https://**', (route) => route.abort());
  await installOnlineDirectoryFixture(page, [location]);
  let payloads = 0;
  await page.route(location, (route) => {
    payloads++;
    return route.abort();
  });
  await ready(page);
  const before = await canonicalRecords(page);
  await page.evaluate(() => {
    const original = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'records' && key === 'preferences')
        throw new DOMException('Controlled storage refusal', 'QuotaExceededError');
      return original.call(this, value, key);
    };
  });
  await query(page);
  await expect(page.locator('#inline-scan-status')).toContainText('could not finish');
  await expect(page.locator('#inline-scan-rescan')).toBeVisible();
  expect(payloads).toBe(0);
  expect(await canonicalRecords(page)).toEqual(before);
});

// An included channel provider's HTTP grant cannot change (owner decision,
// October 17, 2026: always allowed); the editor test below covers that.
for (const change of ['provider-location', 'region'] as const) {
  test(`held directory outage refuses configured-source fallback after ${change} changes`, async ({
    page,
  }) => {
    const acquisitions: string[] = [];
    await page.route('https://**', (route) => {
      acquisitions.push(route.request().url());
      return route.abort();
    });
    const directory = await installOnlineDirectoryFixture(page, [], {
      failedIds: known.repositoryIds,
      hold: true,
    });
    await ready(page);
    await configureControlledDiscoveryProviders(page);
    const original = await canonicalRecords(page);
    try {
      await query(page);
      await expect.poll(() => directory.repositories.length).toBe(1);
      await expect(page.locator('#inline-scan-status')).toContainText('Finding');
      await page.locator('#settings-button').click();
      if (change === 'region') {
        await chooseSettingsSection(page, 'sources');
        await page.getByLabel('Region country', { exact: true }).selectOption('US');
        await page.getByRole('button', { name: 'Save region', exact: true }).click();
        await expect(page.locator('#region-settings [role="status"]')).toContainText('US first');
      } else {
        await chooseSettingsSection(page, 'advanced');
        const details = page
          .locator('details')
          .filter({ has: page.locator('#provider-configuration') });
        if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
          await details.locator(':scope > summary').click();
        const editor = page.locator('#provider-configuration');
        const configuration = JSON.parse(await editor.inputValue());
        configuration.reviewedChannelProviders[0].location =
          'https://changed-catalog.fixture.invalid/index.m3u';
        await editor.fill(JSON.stringify(configuration));
        await page.locator('#save-provider-configuration').click();
        await expect.poll(async () => (await canonicalRecords(page))[1]).not.toEqual(original[1]);
        await expect(page.locator('#provider-configuration-status')).toContainText(
          'Discovery providers saved.',
        );
      }
      await page.locator('[data-close="settings-dialog"]').click();
      const changed = await canonicalRecords(page);
      const preferences = JSON.parse(String(changed[1]));
      if (change === 'region')
        expect(preferences.preferredRegion).toEqual({ country: 'US', origin: 'manual' });
      else
        expect(preferences.reviewedChannelProviders[0].location).toBe(
          'https://changed-catalog.fixture.invalid/index.m3u',
        );
      // Only the explicit settings action changed data while directory metadata was held.
      expect(changed[0]).toEqual(original[0]);
      expect(changed.slice(2)).toEqual(original.slice(2));
      expect(acquisitions).toEqual([]);
      directory.release();
      await expect(page.locator('#search-programs')).toBeEnabled();
      await expect(page.locator('#inline-scan-status')).toContainText(
        'Online source discovery could not finish',
      );
      await expect(page.locator('#inline-scan-rescan')).toBeVisible();
      await expect(page.locator('#inline-scan-stop')).toBeHidden();
      expect(directory.repositories).toEqual(known.repositoryIds);
      // Neither old nor changed source endpoints, stream probes, or source publications were admitted.
      expect(acquisitions).toEqual([]);
      expect(await canonicalRecords(page)).toEqual(changed);
      await page.reload();
      await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
      expect(await canonicalRecords(page)).toEqual(changed);
      expect(acquisitions).toEqual([]);
    } finally {
      directory.release();
    }
  });
}

// Owner decision, October 17, 2026: included channel sources always allow
// plain HTTP, and the start-up grant restores it. The editor keeps it on and
// says so, so an "off" is never saved and then silently undone at next start.
test('the provider editor keeps HTTP on for included channel sources and says so', async ({
  page,
}) => {
  await page.route('https://**', (route) => route.abort());
  await ready(page);
  await configureControlledDiscoveryProviders(page);
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'advanced');
  const details = page.locator('details').filter({ has: page.locator('#provider-configuration') });
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
    await details.locator(':scope > summary').click();
  const editor = page.locator('#provider-configuration');
  const configuration = JSON.parse(await editor.inputValue());
  configuration.reviewedChannelProviders[0].allowHttp = false;
  configuration.reviewedChannelProviders[1].name = 'Renamed Free-TV catalog';
  await editor.fill(JSON.stringify(configuration));
  await page.locator('#save-provider-configuration').click();
  await expect(page.locator('#provider-configuration-status')).toContainText(
    'Included channel sources always allow plain HTTP, so that stays on.',
  );
  // The other edit is saved; the box shows what was saved.
  const shown = JSON.parse(await editor.inputValue());
  expect(shown.reviewedChannelProviders.map((p: { allowHttp: boolean }) => p.allowHttp)).toEqual([
    true,
    true,
  ]);
  const saved = JSON.parse(String((await canonicalRecords(page))[1]));
  expect(saved.reviewedChannelProviders[0].allowHttp).toBe(true);
  expect(saved.reviewedChannelProviders[1].name).toBe('Renamed Free-TV catalog');
  // A restart changes nothing further: the start-up grant has nothing to undo.
  const before = await canonicalRecords(page);
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.waitForTimeout(1500);
  expect(await canonicalRecords(page)).toEqual(before);
});
