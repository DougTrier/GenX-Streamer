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
import { createHash } from 'node:crypto';
import type { ScanCheckpoint } from '../../src/discovery/scan-checkpoint';
import { installOnlineDirectoryFixture } from './online-directory-fixture';
import { openPlaylistImport, saveReviewedSource } from './helpers/source-scan';

const provider = 'https://resume-intent.fixture.invalid/index.m3u';
const source = {
  id: 'retained-file',
  name: 'Retained library',
  kind: 'file' as const,
  location: 'retained.m3u',
};
const baseline = {
  schemaVersion: 1,
  sources: [source],
  channels: [
    {
      id: 'favorite-kept',
      sourceId: source.id,
      name: 'Favorite retained',
      category: 'News',
      urls: ['https://retained.fixture.invalid/one'],
    },
    {
      id: 'removed-kept',
      sourceId: source.id,
      name: 'Removed retained',
      category: 'Sports',
      urls: ['https://retained.fixture.invalid/two'],
    },
  ],
};
async function expiredCheckpoint(): Promise<ScanCheckpoint> {
  // Independent controlled fixture: no Vitest-only JSON import or public endpoint.
  const capturedSource = {
    id: 'checkpoint-source',
    name: 'Captured public source',
    kind: 'url' as const,
    location: provider,
    allowHttp: false,
  };
  const digest = (tuple: unknown) =>
    createHash('sha256').update(JSON.stringify(tuple)).digest('hex');
  const sourceDefinitions = [
    {
      source: capturedSource,
      definitionFingerprint: digest([
        capturedSource.id,
        capturedSource.name,
        capturedSource.kind,
        capturedSource.location,
        false,
        null,
        null,
      ]),
    },
  ];
  const checkpoint: ScanCheckpoint = {
    schemaVersion: 1,
    jobId: 'resume-intent-expired',
    createdAtMs: 1000,
    catalogRevision: '7',
    policyFingerprint: '',
    sourceDefinitions,
    budgetMs: 20000,
    platform: 'browser',
    observerProfile: 'fixture',
    review: {
      sessionRevision: 'runtime-capture',
      query: '',
      status: 'completed',
      sources: [
        {
          sourceId: capturedSource.id,
          fingerprint: 'captured-fingerprint',
          status: 'completed',
          inspected: 1,
          matched: 1,
          warnings: 0,
        },
      ],
      candidates: [
        {
          key: 'captured-key',
          sourceId: capturedSource.id,
          sourceFingerprint: 'captured-fingerprint',
          sessionRevision: 'runtime-capture',
          channel: {
            sourceId: capturedSource.id,
            name: 'Live',
            category: 'General',
            urls: ['https://checkpoint.fixture.invalid/live'],
          },
        },
      ],
      counts: { inspected: 1, matched: 1, failedSources: 0, canceledSources: 0 },
    },
    observations: [
      {
        channelId: 'captured-key',
        sourceId: capturedSource.id,
        fingerprint: 'captured-fingerprint',
        platform: 'browser',
        observedAt: 1000,
        verdict: 'Reachable',
        evidence: { kind: 'recognized-media-response' },
      },
    ],
    publishedKeys: [],
  };
  // Version1 canonical tuple contract. This fixture does not test the hash algorithm.
  checkpoint.policyFingerprint = digest([
    [
      [
        'captured-provider',
        'Captured public source',
        provider,
        'https://provenance.fixture.invalid/project',
        false,
      ],
    ],
    null,
    checkpoint.budgetMs,
    checkpoint.platform,
    checkpoint.observerProfile,
    sourceDefinitions.map((definition) => definition.definitionFingerprint),
  ]);
  return checkpoint;
}
async function rawRecords(page: Page) {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('tmg-tv', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Fixture storage unavailable'));
    });
    try {
      return await new Promise<Record<string, unknown>>((resolve, reject) => {
        const tx = database.transaction('records', 'readonly');
        const store = tx.objectStore('records');
        const keys = [
          'catalog',
          'preferences',
          'health',
          'catalogRevision',
          'healthRevision',
          'scanCheckpoint',
          'checkpointJobId',
          'checkpointRevision',
        ];
        const reads = keys.map((key) => store.get(key));
        tx.oncomplete = () =>
          resolve(
            Object.fromEntries(keys.map((key, index) => [key, reads[index]!.result ?? null])),
          );
        tx.onabort = () => reject(new Error('Fixture storage read aborted'));
      });
    } finally {
      database.close();
    }
  });
}
async function seed(page: Page, serialized: string, jobId: string) {
  await page.evaluate(
    async (records) => {
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('tmg-tv', 1);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(new Error('Fixture storage unavailable'));
      });
      try {
        await new Promise<void>((resolve, reject) => {
          const tx = database.transaction('records', 'readwrite');
          const store = tx.objectStore('records');
          for (const [key, value] of Object.entries(records)) store.put(value, key);
          store.delete('health');
          tx.oncomplete = () => resolve();
          tx.onabort = () => reject(new Error('Fixture seed refused'));
        });
      } finally {
        database.close();
      }
    },
    {
      catalog: JSON.stringify(baseline),
      preferences: JSON.stringify({
        schemaVersion: 1,
        volume: 0.8,
        muted: false,
        panelWidth: 360,
        automaticSourceRefresh: false,
        sourceRefreshCadence: 'off',
        sourceRefreshAttemptAt: 0,
        voiceSearchConsent: false,
        sources: [source],
        favorites: ['favorite-kept'],
        removedChannels: ['removed-kept'],
        reviewedChannelProviders: [],
        reviewedGuideProviders: [],
      }),
      catalogRevision: '7',
      healthRevision: '3',
      checkpointRevision: '9',
      scanCheckpoint: serialized,
      checkpointJobId: jobId,
    },
  );
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.evaluate(() => {
    const writes: { operation: string; key: unknown }[] = [];
    Reflect.set(window, '__RESUME_INTENT_WRITES__', writes);
    const put = IDBObjectStore.prototype.put;
    const remove = IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.put = function (value, key) {
      if (this.name === 'records') writes.push({ operation: 'put', key });
      return put.call(this, value, key);
    };
    IDBObjectStore.prototype.delete = function (key) {
      if (this.name === 'records') writes.push({ operation: 'delete', key });
      return remove.call(this, key);
    };
  });
}

for (const entry of [
  { query: 'Fox', checkpoint: 'malformed' },
  { query: '', checkpoint: 'malformed' },
  { query: 'Fox', checkpoint: 'expired-policy' },
] as const) {
  test(`unavailable ${entry.checkpoint} checkpoint requires explicit Rescan for query ${entry.query || '(empty)'}`, async ({
    page,
  }) => {
    const payloads: string[] = [];
    const probes: string[] = [];
    await page.route('https://**', (route) => route.abort());
    await page.route('https://iptv-org.github.io/api/**', (route) => route.fulfill({ json: [] }));
    const directory = await installOnlineDirectoryFixture(page, [provider]);
    await page.route(provider, (route) => {
      payloads.push(route.request().url());
      return route.fulfill({
        contentType: 'text/plain',
        body: '#EXTM3U\n#EXTINF:-1 group-title="News",Fox new match\nhttps://fox-resume.fixture.invalid/feed\n#EXTINF:-1 group-title="Other",Other new channel\nhttps://other-resume.fixture.invalid/feed\n',
      });
    });
    await page.route(/^https:\/\/(fox-resume|other-resume)\.fixture\.invalid\/feed$/, (route) => {
      probes.push(route.request().url());
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
      });
    });
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    const stale = await expiredCheckpoint();
    const checkpoint =
      entry.checkpoint === 'malformed'
        ? JSON.stringify({ schemaVersion: 1, jobId: 'resume-intent-owned' })
        : JSON.stringify(stale);
    await seed(
      page,
      checkpoint,
      entry.checkpoint === 'malformed' ? 'resume-intent-owned' : stale.jobId,
    );
    const before = await rawRecords(page);
    await page.locator('#search').fill(entry.query);
    await page.locator('#search-programs').click();
    await expect(page.locator('#inline-scan-rescan')).toBeVisible();
    await expect(page.locator('#search-programs')).toBeEnabled();
    await expect(page.locator('#inline-scan-status')).toContainText(
      'Previous scan progress cannot resume',
    );
    await expect(page.locator('#inline-scan-continue')).toBeHidden();
    expect(directory.requests).toEqual([]);
    expect(payloads).toEqual([]);
    expect(probes).toEqual([]);
    expect(await rawRecords(page)).toEqual(before);
    expect(await page.evaluate(() => Reflect.get(window, '__RESUME_INTENT_WRITES__'))).toEqual([]);
    await expect(page.getByRole('dialog', { name: 'Review source scan' })).not.toBeVisible();

    await page.locator('#inline-scan-rescan').click();
    await expect
      .poll(
        async () => {
          const record = await rawRecords(page);
          return JSON.parse(String(record.catalog)).channels.length;
        },
        { timeout: 30000 },
      )
      .toBe(entry.query ? 3 : 4);
    await expect(page.locator('#inline-scan-stop')).toBeHidden();
    expect(directory.repositories).toHaveLength(7);
    expect(payloads).toHaveLength(1);
    expect(probes).toHaveLength(entry.query ? 1 : 2);
    const after = await rawRecords(page);
    const preferences = JSON.parse(String(after.preferences));
    expect(preferences.favorites).toEqual(['favorite-kept']);
    expect(preferences.removedChannels).toEqual(['removed-kept']);
    expect(JSON.parse(String(after.catalog)).channels.slice(0, 2)).toEqual(baseline.channels);
    expect(BigInt(String(after.checkpointRevision))).toBeGreaterThan(9n);
    expect(after.scanCheckpoint).not.toBe(before.scanCheckpoint);
    const writes = (await page.evaluate(() => Reflect.get(window, '__RESUME_INTENT_WRITES__'))) as {
      operation: string;
      key: unknown;
    }[];
    expect(
      writes.some((write) => write.operation === 'delete' && write.key === 'scanCheckpoint'),
    ).toBe(true);
    expect(writes.some((write) => write.operation === 'put' && write.key === 'catalog')).toBe(true);
  });
}

for (const change of ['absent', 'invalid'] as const)
  test(`Continue refuses ${change} authoritative checkpoint after a genuine stopped scan without fresh discovery`, async ({
    page,
  }) => {
    const acquisitions: string[] = [];
    const probes: string[] = [];
    await page.route('https://**', (route) => route.abort());
    await page.route('https://iptv-org.github.io/api/**', (route) => route.fulfill({ json: [] }));
    const directory = await installOnlineDirectoryFixture(page, [provider]);
    await page.route(provider, (route) => {
      acquisitions.push(route.request().url());
      return route.fulfill({
        contentType: 'text/plain',
        body: '#EXTM3U\n#EXTINF:-1,Fox settled\nhttps://continue-settled.fixture.invalid/live\n#EXTINF:-1,Fox pending\nhttps://continue-pending.fixture.invalid/live\n',
      });
    });
    await page.route('https://continue-settled.fixture.invalid/live', (route) => {
      probes.push('settled');
      return route.fulfill({
        contentType: 'application/vnd.apple.mpegurl',
        body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
      });
    });
    let release: (() => void) | undefined;
    await page.route('https://continue-pending.fixture.invalid/live', async (route) => {
      probes.push('pending');
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      await route.abort().catch(() => {});
    });
    try {
      await page.goto('/');
      await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
      await page.locator('#search').fill('Fox');
      await page.locator('#search-programs').click();
      await expect.poll(() => probes.includes('pending')).toBe(true);
      await expect(
        page.locator('#channel-list').getByRole('button', { name: /^Fox settled(?: ·|$)/ }),
      ).toHaveCount(1, { timeout: 30000 });
      await page.locator('#inline-scan-stop').click();
      release?.();
      await expect(page.locator('#inline-scan-stop')).toBeHidden();
      await expect(page.locator('#inline-scan-continue')).toBeVisible();
      const before = await rawRecords(page);
      const beforeNetwork = {
        acquisitions: acquisitions.length,
        probes: probes.length,
        metadata: directory.requests.length,
      };
      await page.evaluate(
        async ({ change, revision }) => {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open('tmg-tv', 1);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(new Error('Fixture storage unavailable'));
          });
          try {
            await new Promise<void>((resolve, reject) => {
              const tx = db.transaction('records', 'readwrite'),
                store = tx.objectStore('records');
              if (change === 'absent') {
                store.delete('scanCheckpoint');
                store.delete('checkpointJobId');
              } else store.put('{"schemaVersion":3,"malformed":true}', 'scanCheckpoint');
              store.put(String(Number(revision) + 1), 'checkpointRevision');
              tx.oncomplete = () => resolve();
              tx.onabort = () => reject(new Error('Fixture checkpoint edit aborted'));
            });
          } finally {
            db.close();
          }
        },
        { change, revision: before.checkpointRevision },
      );
      const changed = await rawRecords(page);
      await page.locator('#inline-scan-continue').click();
      await expect(page.locator('#inline-scan-status')).toContainText(
        'This saved scan cannot continue',
      );
      await expect(page.locator('#inline-scan-continue')).toBeHidden();
      await expect(page.locator('#inline-scan-rescan')).toBeVisible();
      expect({
        acquisitions: acquisitions.length,
        probes: probes.length,
        metadata: directory.requests.length,
      }).toEqual(beforeNetwork);
      expect(await rawRecords(page)).toEqual(changed);
      await page.locator('#search-programs').click();
      await expect(page.locator('#search-programs')).toBeEnabled();
      expect({
        acquisitions: acquisitions.length,
        probes: probes.length,
        metadata: directory.requests.length,
      }).toEqual(beforeNetwork);
      expect(await rawRecords(page)).toEqual(changed);
      expect(changed.catalog).toEqual(before.catalog);
      expect(changed.preferences).toEqual(before.preferences);
      expect(changed.health).toEqual(before.health);
    } finally {
      release?.();
    }
  });

test('automatic source updates wait while a paused scan can still continue', async ({ page }) => {
  const acquisitions: string[] = [];
  let playlistDownloads = 0;
  await page.route('https://**', (route) => route.abort());
  await page.route('https://saved-playlist.fixture.invalid/daily', (route) => {
    playlistDownloads++;
    return route.fulfill({
      contentType: 'text/plain',
      body: '#EXTM3U\n#EXTINF:-1 tvg-id="daily",Saved channel\nhttps://saved-playlist.fixture.invalid/video\n',
    });
  });
  await page.route('https://saved-playlist.fixture.invalid/video', (route) =>
    route.fulfill({
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
    }),
  );
  await page.route('https://iptv-org.github.io/api/**', (route) => route.fulfill({ json: [] }));
  await installOnlineDirectoryFixture(page, [provider]);
  await page.route(provider, (route) => {
    acquisitions.push(route.request().url());
    return route.fulfill({
      contentType: 'text/plain',
      body: '#EXTM3U\n#EXTINF:-1,Fox settled\nhttps://continue-settled.fixture.invalid/live\n#EXTINF:-1,Fox pending\nhttps://continue-pending.fixture.invalid/live\n',
    });
  });
  await page.route('https://continue-settled.fixture.invalid/live', (route) =>
    route.fulfill({
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
    }),
  );
  let release: (() => void) | undefined;
  let pending = false;
  await page.route('https://continue-pending.fixture.invalid/live', async (route) => {
    pending = true;
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    await route.abort().catch(() => {});
  });
  try {
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    // A saved URL playlist is what automatic updates refresh.
    await openPlaylistImport(page);
    await page.locator('#playlist-url').fill('https://saved-playlist.fixture.invalid/daily');
    await page.locator('#load-button').click();
    await saveReviewedSource(page);
    await expect(page.locator('.channel strong').first()).toBeVisible();
    await page.locator('#search').fill('Fox');
    await page.locator('#search-programs').click();
    await expect.poll(() => pending).toBe(true);
    await page.locator('#inline-scan-stop').click();
    release?.();
    await expect(page.locator('#inline-scan-continue')).toBeVisible();
    const downloaded = playlistDownloads;
    // Turning automatic updates on would normally refresh the saved URL source at once.
    await page.locator('#settings-button').click();
    await page.locator('#daily-source-refresh').selectOption('hourly');
    await page.getByRole('button', { name: 'Close settings', exact: true }).click();
    await page.waitForTimeout(3000);
    expect(playlistDownloads).toBe(downloaded);
    await expect(page.locator('#inline-scan-continue')).toBeVisible();
  } finally {
    release?.();
  }
});
