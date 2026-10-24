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

import { installOnlineDirectoryFixture } from './online-directory-fixture';
import { expect, test, type Page } from '@playwright/test';
import { chooseSettingsSection } from './helpers/settings-section';
import {
  canonicalRecords,
  saveReviewedSource,
  configureControlledDiscoveryProviders,
} from './helpers/source-scan';

const providers = [
  'https://iptv-org.github.io/iptv/index.m3u',
  'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
];
const manifest = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n';
async function fixture(page: Page) {
  let held = true,
    providerRequests = 0,
    excludedRequests = 0;
  const probes = new Map<number, number>();
  const releases: (() => void)[] = [];
  const settlements: Promise<void>[] = [];
  await page.route('https://**', (route) => route.abort());
  await page.route('https://iptv-org.github.io/api/**', (route) =>
    route.fulfill({ contentType: 'application/json', body: '[]' }),
  );
  const body =
    '#EXTM3U\n' +
    Array.from(
      { length: 48 },
      (_, index) =>
        `#EXTINF:-1 group-title="News",Fox ${String(index).padStart(2, '0')}\nhttps://inline${index}.fixture.invalid/feed\n`,
    ).join('') +
    '#EXTINF:-1 group-title="Other",Other channel\nhttps://excluded.fixture.invalid/feed\n';
  for (const [index, url] of providers.entries())
    await page.route(url, (route) => {
      providerRequests++;
      return route.fulfill({ contentType: 'text/plain', body: index === 0 ? body : '#EXTM3U\n' });
    });
  await page.route('https://excluded.fixture.invalid/**', (route) => {
    excludedRequests++;
    return route.abort();
  });
  await page.route(/^https:\/\/inline\d+\.fixture\.invalid\/feed$/, async (route) => {
    const index = Number(new URL(route.request().url()).hostname.match(/inline(\d+)/)![1]);
    probes.set(index, (probes.get(index) ?? 0) + 1);
    if (held && index >= 16) {
      let settled!: () => void;
      settlements.push(
        new Promise<void>((resolve) => {
          settled = resolve;
        }),
      );
      try {
        await new Promise<void>((resolve) => releases.push(resolve));
        await route
          .fulfill({ contentType: 'application/vnd.apple.mpegurl', body: manifest })
          .catch(() => undefined);
      } finally {
        settled();
      }
    } else await route.fulfill({ contentType: 'application/vnd.apple.mpegurl', body: manifest });
  });
  const directory = await installOnlineDirectoryFixture(page, providers);
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await configureControlledDiscoveryProviders(page);
  return {
    probes,
    get directoryRequests() {
      return directory.requests.length;
    },
    get providerRequests() {
      return providerRequests;
    },
    get excludedRequests() {
      return excludedRequests;
    },
    async release() {
      held = false;
      releases.splice(0).forEach((resolve) => resolve());
      await Promise.all(settlements);
    },
  };
}
async function savedNames(page: Page) {
  const records = await canonicalRecords(page);
  return records[0] === null
    ? []
    : (JSON.parse(String(records[0])) as { channels: { name: string }[] }).channels.map(
        (channel) => channel.name,
      );
}
async function seedFavoriteAndRemoval(page: Page) {
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'sources');
  await expect(page.getByRole('button', { name: 'Import playlist', exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Export channel list', exact: true }),
  ).toBeVisible();
  await page.locator('#import-button').click();
  await page.locator('#custom-source-options > summary').click();
  await page.locator('#playlist-file').setInputFiles({
    name: 'retained.m3u',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      '#EXTM3U\n#EXTINF:-1,Retained favorite\nhttps://seed.fixture.invalid/one\n#EXTINF:-1,Retained removal\nhttps://seed.fixture.invalid/two\n',
    ),
  });
  await saveReviewedSource(page, 2);
  await page
    .locator('.channel')
    .filter({ has: page.locator('strong', { hasText: 'Retained favorite' }) })
    .click();
  await page.locator('#favorite-button').click();
  await expect(page.locator('#favorite-button')).toHaveAttribute('aria-pressed', 'true');
  await page
    .locator('.channel')
    .filter({ has: page.locator('strong', { hasText: 'Retained removal' }) })
    .click();
  await page.locator('#remove-channel').click();
  await expect(page.locator('.channel strong')).not.toContainText(['Retained removal']);
  const before = await canonicalRecords(page);
  const preferences = JSON.parse(String(before[1])) as {
    favorites: string[];
    removedChannels: string[];
  };
  expect(preferences.favorites).toHaveLength(1);
  expect(preferences.removedChannels).toHaveLength(1);
  return preferences;
}

test('local typing stays local; magnifier publishes filtered channels inline and Stop/Continue owns the same query', async ({
  page,
}) => {
  const owned = await fixture(page);
  try {
    const preferences = await seedFavoriteAndRemoval(page);
    await expect(page.locator('.topbar #import-button')).toHaveCount(0);
    const beforeTitle = await page.locator('#watch-title').textContent();
    await page.locator('#search').fill('Fox');
    expect(owned.providerRequests).toBe(0);
    expect(owned.probes.size).toBe(0);
    await page.getByRole('button', { name: 'Find channels online', exact: true }).click();
    await expect(page.locator('#inline-source-scan')).toBeVisible();
    await expect(page.locator('#import-dialog')).not.toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
    await expect(page.locator('#primary-view-host')).toBeHidden();
    await expect
      .poll(async () => (await savedNames(page)).filter((name) => name.startsWith('Fox ')).length, {
        timeout: 15000,
      })
      .toBe(16);
    await expect(page.locator('#inline-scan-status')).toContainText('16 saved');
    await expect(page.locator('.channel strong').first()).toContainText('Fox');
    expect(owned.excludedRequests).toBe(0);
    const activeRequests = owned.providerRequests;
    const activeDirectoryRequests = owned.directoryRequests;
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await page.getByRole('button', { name: 'Find channels online', exact: true }).click();
    await expect(page.locator('#inline-scan-status')).toContainText('“Fox”');
    expect(owned.providerRequests).toBe(activeRequests);
    expect(owned.directoryRequests).toBe(activeDirectoryRequests);
    await page.locator('#inline-scan-stop').click();
    await expect(page.locator('#inline-scan-stop')).toBeHidden();
    await expect(page.locator('#inline-scan-continue')).toBeVisible();
    const count = [...owned.probes.values()].reduce((sum, value) => sum + value, 0);
    await owned.release();
    expect([...owned.probes.values()].reduce((sum, value) => sum + value, 0)).toBe(count);
    await page.locator('#search').fill('Other');
    await page.getByRole('button', { name: 'Find channels online', exact: true }).click();
    await expect(page.locator('#inline-scan-error')).toContainText('Scan query changed');
    expect(owned.providerRequests).toBe(2);
    expect(owned.excludedRequests).toBe(0);
    await page.locator('#inline-scan-continue').click();
    await expect
      .poll(async () => (await savedNames(page)).filter((name) => name.startsWith('Fox ')).length, {
        timeout: 15000,
      })
      .toBe(48);
    await expect(page.locator('#inline-scan-stop')).toBeHidden();
    expect(owned.providerRequests).toBe(2);
    for (let index = 0; index < 16; index++) expect(owned.probes.get(index)).toBe(1);
    expect(owned.directoryRequests).toBe(activeDirectoryRequests);
    const after = JSON.parse(String((await canonicalRecords(page))[1]));
    expect(after.favorites).toEqual(preferences.favorites);
    expect(after.removedChannels).toEqual(preferences.removedChannels);
    await expect(page.locator('#watch-title')).toHaveText(beforeTitle!);
    await page.getByRole('button', { name: 'Clear search', exact: true }).click();
    await expect(page.locator('#search')).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Clear search', exact: true })).toBeHidden();
  } finally {
    await owned.release();
  }
});

test('completed discovery uses explicit Rescan for a new query without an import or review modal', async ({
  page,
}) => {
  const owned = await fixture(page);
  try {
    await owned.release();
    await page.locator('#search').fill('Fox 00');
    await page.getByRole('button', { name: 'Find channels online', exact: true }).click();
    await expect.poll(() => savedNames(page)).toEqual(['Fox 00']);
    await expect(page.locator('#inline-scan-stop')).toBeHidden();
    const completedRecords = await canonicalRecords(page);
    const completedProbeCount = [...owned.probes.values()].reduce((sum, value) => sum + value, 0);
    for (let index = 0; index < 2; index++) {
      await page.locator('#search').fill('');
      await page.getByRole('button', { name: 'Find channels online', exact: true }).click();
      await expect(page.locator('#inline-scan-status')).toContainText('previous scan is finished');
      await expect(page.locator('#inline-scan-rescan')).toBeVisible();
      await expect(page.locator('#inline-scan-continue')).toBeHidden();
      expect(owned.providerRequests).toBe(2);
      expect([...owned.probes.values()].reduce((sum, value) => sum + value, 0)).toBe(
        completedProbeCount,
      );
      expect(await canonicalRecords(page)).toEqual(completedRecords);
    }
    await page.locator('#search').fill('Fox 01');
    expect(owned.providerRequests).toBe(2);
    await page.locator('#inline-scan-rescan').click();
    await expect.poll(async () => (await savedNames(page)).sort()).toEqual(['Fox 00', 'Fox 01']);
    expect(owned.providerRequests).toBe(4);
    expect(owned.probes.get(0)).toBe(1);
    expect(owned.probes.get(1)).toBe(1);
    await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
    await expect(page.locator('#import-dialog')).not.toBeVisible();
    await expect(page.locator('#primary-view-host')).toBeHidden();
  } finally {
    await owned.release();
  }
});

test('saved library without resumable progress offers explicit Rescan without empty-query acquisition', async ({
  page,
}) => {
  const owned = await fixture(page);
  try {
    await owned.release();
    const preferences = await seedFavoriteAndRemoval(page);
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    const baseline = await canonicalRecords(page);
    const beforeTitle = await page.locator('#watch-title').textContent();
    for (let index = 0; index < 2; index++) {
      await page.getByRole('button', { name: 'Find channels online', exact: true }).click();
      await expect(page.locator('#inline-scan-status')).toContainText('Saved channels are ready');
      await expect(page.locator('#inline-scan-rescan')).toBeVisible();
      await expect(page.locator('#inline-scan-continue')).toBeHidden();
      await expect(page.locator('#inline-scan-stop')).toBeHidden();
      expect(owned.providerRequests).toBe(0);
      expect(owned.probes.size).toBe(0);
      expect(await canonicalRecords(page)).toEqual(baseline);
    }
    await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();
    await expect(page.locator('#watch-title')).toHaveText(beforeTitle!);
    // Close dismisses the panel; the magnifier brings it back with the same choices.
    await expect(page.locator('#inline-scan-close')).toBeVisible();
    await page.locator('#inline-scan-close').click();
    await expect(page.locator('#inline-source-scan')).toBeHidden();
    await page.getByRole('button', { name: 'Find channels online', exact: true }).click();
    await expect(page.locator('#inline-source-scan')).toBeVisible();
    await expect(page.locator('#inline-scan-close')).toBeVisible();
    expect(owned.providerRequests).toBe(0);
    await page.locator('#inline-scan-rescan').click();
    await expect.poll(() => owned.providerRequests).toBe(2);
    await expect
      .poll(async () => (await savedNames(page)).filter((name) => name.startsWith('Fox ')).length, {
        timeout: 15000,
      })
      .toBe(48);
    const after = JSON.parse(String((await canonicalRecords(page))[1]));
    expect(after.favorites).toEqual(preferences.favorites);
    expect(after.removedChannels).toEqual(preferences.removedChannels);
  } finally {
    await owned.release();
  }
});
