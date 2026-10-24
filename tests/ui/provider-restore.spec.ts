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
import { readFile } from 'node:fs/promises';
import { chooseSettingsSection } from './helpers/settings-section';

async function pair(page: Page) {
  return page.evaluate(async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('tmg-tv', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Fixture storage read failed.'));
    });
    try {
      return await new Promise<{ catalog: string; preferences: string }>((resolve, reject) => {
        const tx = db.transaction('records', 'readonly'),
          store = tx.objectStore('records');
        const catalog = store.get('catalog'),
          preferences = store.get('preferences');
        tx.oncomplete = () => {
          if (typeof catalog.result !== 'string' || typeof preferences.result !== 'string')
            return reject(new Error('Fixture records missing.'));
          resolve({ catalog: catalog.result, preferences: preferences.result });
        };
        tx.onabort = () => reject(new Error('Fixture snapshot transaction failed.'));
      });
    } finally {
      db.close();
    }
  });
}

for (const registry of ['empty', 'custom'] as const)
  test(`explicit restore preserves ${registry} providers at startup and changes only reviewed provider lists`, async ({
    page,
  }) => {
    const externalRequests: string[] = [];
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
      externalRequests.push(url.protocol);
      return route.abort();
    });
    const source = {
      id: 'saved-source',
      name: 'Saved source',
      kind: 'url',
      location: 'https://fixture.invalid/saved',
      allowHttp: false,
    };
    const reviewedChannelProviders =
      registry === 'custom'
        ? [
            {
              id: 'custom-channels',
              name: 'My reviewed channels',
              location: 'https://fixture.invalid/custom',
              provenance: 'https://fixture.invalid/project',
              // Reviewed channel providers allow HTTP (decisions/included-sources-allow-http.md).
              allowHttp: true,
            },
          ]
        : [];
    const reviewedGuideProviders =
      registry === 'custom'
        ? [
            {
              id: 'custom-guide',
              name: 'My reviewed guide',
              location: 'https://fixture.invalid/custom-guide',
              provenance: 'https://fixture.invalid/guide-project',
              limitations: 'Fixture guide scope only.',
            },
          ]
        : [];
    const backup = {
      format: 'genx-tv-backup',
      schemaVersion: 1,
      catalog: {
        schemaVersion: 1,
        sources: [source],
        channels: [
          {
            id: 'favorite-one',
            sourceId: source.id,
            name: 'Favorite kept',
            category: 'News',
            urls: ['https://fixture.invalid/one'],
          },
          {
            id: 'removed-two',
            sourceId: source.id,
            name: 'Removed kept',
            category: 'Sports',
            urls: ['https://fixture.invalid/two'],
          },
        ],
      },
      preferences: {
        schemaVersion: 1,
        sources: [source],
        favorites: ['favorite-one'],
        removedChannels: ['removed-two'],
        volume: 0.6,
        muted: false,
        panelWidth: 320,
        automaticSourceRefresh: true,
        sourceRefreshCadence: 'weekly',
        sourceRefreshAttemptAt: Date.now(),
        voiceSearchConsent: false,
        reviewedChannelProviders,
        reviewedGuideProviders,
      },
    };
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await page.locator('#settings-button').click();
    await chooseSettingsSection(page, 'data');
    await page.locator('#backup-file').setInputFiles({
      name: 'reviewed-library.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(backup)),
    });
    await expect(page.locator('#transfer-apply')).toBeEnabled();
    await page.locator('#transfer-apply').click();
    await expect(page.locator('#transfer-dialog')).not.toBeVisible();
    const baseline = await pair(page);
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    const restarted = await pair(page);
    expect(restarted).toEqual(baseline);
    const originalPreferences = JSON.parse(restarted.preferences);
    expect(originalPreferences.reviewedChannelProviders).toEqual(reviewedChannelProviders);
    expect(originalPreferences.reviewedGuideProviders).toEqual(reviewedGuideProviders);
    await expect(page.locator('.channel strong')).toHaveText('Favorite kept');
    await page.locator('#settings-button').click();
    await chooseSettingsSection(page, 'advanced');
    await page.getByText('Discovery providers', { exact: true }).click();
    const configured = JSON.parse(await page.locator('#provider-configuration').inputValue());
    expect(configured.reviewedChannelProviders).toEqual(reviewedChannelProviders);
    expect(configured.reviewedGuideProviders).toEqual(reviewedGuideProviders);
    await page.getByRole('button', { name: 'Restore suggested sources', exact: true }).click();
    await expect(page.locator('#provider-configuration-status')).toHaveText(
      'Suggested sources restored. Scan channels or find program guides when you are ready.',
    );
    const defaults = JSON.parse(await readFile('src/discovery/providers.json', 'utf8'));
    const restored = await pair(page),
      preferences = JSON.parse(restored.preferences);
    expect(restored.catalog).toBe(baseline.catalog);
    expect(preferences.reviewedChannelProviders).toEqual(defaults.reviewedChannelProviders);
    expect(preferences.reviewedGuideProviders).toEqual(defaults.reviewedGuideProviders);
    expect(preferences.reviewedGuideProviders).toHaveLength(defaults.reviewedGuideProviders.length);
    const withoutProviders = (p: Record<string, unknown>) =>
      Object.fromEntries(
        Object.entries(p).filter(
          ([key]) => !['reviewedChannelProviders', 'reviewedGuideProviders'].includes(key),
        ),
      );
    expect(withoutProviders(preferences)).toEqual(withoutProviders(originalPreferences));
    expect(externalRequests).toEqual([]);
    await page.reload();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    expect(await pair(page)).toEqual(restored);
    expect(externalRequests).toEqual([]);
  });

test('startup grants HTTP once to included sources and their saved records, not to custom sources', async ({
  page,
}) => {
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url());
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
      ? route.continue()
      : route.abort();
  });
  const included = {
    id: 'included-source',
    name: 'Included source',
    kind: 'url',
    location: 'https://fixture.invalid/included',
    allowHttp: false,
  };
  const custom = {
    ...included,
    id: 'custom-source',
    name: 'Custom source',
    location: 'https://fixture.invalid/custom',
  };
  const channel = (id: string, sourceId: string) => ({
    id,
    sourceId,
    name: id,
    category: 'News',
    urls: [`https://fixture.invalid/${id}`],
  });
  const backup = {
    format: 'genx-tv-backup',
    schemaVersion: 1,
    catalog: {
      schemaVersion: 1,
      sources: [included, custom],
      channels: [channel('one', included.id), channel('two', custom.id)],
    },
    preferences: {
      schemaVersion: 1,
      sources: [included, custom],
      favorites: [],
      removedChannels: [],
      volume: 0.6,
      muted: false,
      panelWidth: 320,
      automaticSourceRefresh: false,
      sourceRefreshCadence: 'off',
      voiceSearchConsent: false,
      reviewedChannelProviders: [
        {
          id: 'included-provider',
          name: 'Included provider',
          location: included.location,
          provenance: 'https://fixture.invalid/project',
          allowHttp: false,
        },
      ],
      reviewedGuideProviders: [],
    },
  };
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'data');
  await page.locator('#backup-file').setInputFiles({
    name: 'http-default.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(backup)),
  });
  await expect(page.locator('#transfer-apply')).toBeEnabled();
  await page.locator('#transfer-apply').click();
  await expect(page.locator('#transfer-dialog')).not.toBeVisible();
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const grants = async () => {
    const { catalog, preferences } = await pair(page);
    const c = JSON.parse(catalog),
      p = JSON.parse(preferences);
    return {
      catalog: c.sources.map((s: { id: string; allowHttp?: boolean }) => [
        s.id,
        s.allowHttp === true,
      ]),
      preferences: p.sources.map((s: { id: string; allowHttp?: boolean }) => [
        s.id,
        s.allowHttp === true,
      ]),
      providers: p.reviewedChannelProviders.map(
        (x: { allowHttp?: boolean }) => x.allowHttp === true,
      ),
      channels: c.channels.length,
    };
  };
  const expected = {
    catalog: [
      ['included-source', true],
      ['custom-source', false],
    ],
    preferences: [
      ['included-source', true],
      ['custom-source', false],
    ],
    providers: [true],
    channels: 2,
  };
  await expect.poll(grants).toEqual(expected);
  // Settings shows the adopted grant, so saving the editor cannot quietly undo it.
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'advanced');
  const details = page.locator('details').filter({ has: page.locator('#provider-configuration') });
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
    await details.locator(':scope > summary').click();
  expect(
    JSON.parse(await page.locator('#provider-configuration').inputValue())
      .reviewedChannelProviders[0].allowHttp,
  ).toBe(true);
  await page.locator('[data-close="settings-dialog"]').click();
  // Applied once: another restart leaves the adopted records as they are.
  const adopted = await pair(page);
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  expect(await pair(page)).toEqual(adopted);
});
