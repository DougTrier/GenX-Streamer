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

// Actual bundled main/owners and browser engine with a controlled native bridge.
// This is lifecycle wiring proof, not native SQLite, proxy, or device decoding proof.
async function fixture(
  page: Page,
  mode: 'public' | 'private-start' | 'archive-stop' | 'archive-start',
) {
  const source = {
    id: 'public-source',
    name: 'Public fixture',
    kind: 'url',
    location: 'https://lifecycle.fixture.invalid/catalog',
    allowHttp: false,
  };
  const channels = ['a', 'b'].map((id) => ({
    id,
    sourceId: source.id,
    name: `Public ${id.toUpperCase()}`,
    category: 'Fixture',
    urls: [`https://stream.lifecycle.invalid/${id}.mp4`],
  }));
  const account = {
    schemaVersion: 1,
    id: 'a'.repeat(32),
    name: 'Private fixture',
    kind: 'playlist',
    serverOrigin: 'https://account.fixture.invalid',
    allowHttp: false,
    revision: '1',
    requiresSignIn: false,
  };
  const privateChannel = {
    id: `account-${account.id}-${'b'.repeat(64)}`,
    name: 'Private channel',
    category: 'Fixture',
    providerId: null,
    epgId: null,
    streamReference: 'e'.repeat(32),
    favorite: false,
    originalCategory: 'Fixture',
  };
  const saved = {
    downloadRef: '1'.repeat(64),
    fileRef: '2'.repeat(64),
    titleRef: '3'.repeat(64),
    title: 'Saved fixture',
    fileTitle: 'Saved video',
    fileName: 'fixture.mp4',
    sizeBytes: '100',
    completedMs: 1,
    integrity: 'size-verified',
    available: true,
  };
  const catalog = JSON.stringify({ schemaVersion: 1, sources: [source], channels });
  let preferences = JSON.stringify({
    schemaVersion: 1,
    favorites: [],
    removedChannels: [],
    volume: 0.8,
    muted: false,
    panelWidth: 360,
    sources: [source],
    automaticSourceRefresh: false,
    sourceRefreshCadence: 'off',
    automaticGuideUpdates: false,
    reviewedChannelProviders: [],
    reviewedGuideProviders: [],
  });
  const calls: { command: string; args: Record<string, unknown> }[] = [];
  const releases = new Map<string, () => void>();
  let inspections = 0,
    privateStarts = 0,
    archiveStarts = 0,
    mediaRequests = 0,
    closing = false;
  const mediaReleases: (() => void)[] = [];
  const hold = async (key: string) => {
    if (!closing) await new Promise<void>((resolve) => releases.set(key, resolve));
  };
  await page.exposeBinding(
    '__lifecycleInvoke',
    async (_binding, command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      if (command === 'plugin:event|listen') return calls.length;
      if (['plugin:event|unlisten', 'cancel_catalog_query', 'cancel_playlist'].includes(command))
        return;
      if (command === 'renderer_recovery_bootstrap')
        return { schemaVersion: 1, recoveredRenderer: false };
      if (command === 'runtime_info') return { platform: 'android', dataMode: 'application' };
      if (command === 'device_capabilities') return { isTelevision: false };
      if (command === 'plugin:app|version') return '0.1.0';
      if (command === 'set_viewing_active')
        return {
          schemaVersion: 1,
          adapterVersion: 'viewing-wake-v1',
          requestedActive: args.active,
          foreground: true,
          platform: 'android',
          windowKeepScreenOn: args.active,
          webViewKeepScreenOn: args.active,
          decorKeepScreenOn: args.active,
        };
      if (command === 'read_record_pair')
        return { catalog, preferences, health: null, catalogRevision: '1', healthRevision: '0' };
      if (command === 'read_record') return preferences;
      if (command === 'write_record_receipt') {
        preferences = String(args.contents);
        return { committed: true, catalogRevision: '1', healthRevision: '0' };
      }
      if (command === 'read_scan_checkpoint_summary')
        return {
          schemaVersion: 1,
          checkpointStatus: 'absent',
          storedVersion: null,
          total: 0,
          checked: 0,
          responded: 0,
          published: 0,
          unfinished: false,
          catalogRevision: '1',
          checkpointRevision: '0',
        };
      if (command === 'query_catalog_page') {
        const query = args.query as { requestId: string; startIndex?: number };
        return {
          schemaVersion: 1,
          requestId: query.requestId,
          catalogRevision: '1',
          viewRevision: '1',
          queryVersion: 'v1-' + 'a'.repeat(64),
          totalCount: channels.length,
          startIndex: query.startIndex ?? 0,
          anchorIndex: null,
          rows: channels.map(({ id, sourceId, name, category }) => ({
            id,
            sourceId,
            name,
            category,
            favorite: false,
          })),
          after: null,
        };
      }
      if (command === 'list_iptv_accounts') return [account];
      if (command === 'query_iptv_account_channels')
        return {
          schemaVersion: 1,
          accountId: account.id,
          accountRevision: '1',
          mediaRevision: '1',
          preferencesRevision: '0',
          queryVersion: 'account-sqlite-ascii-v2',
          startIndex: 0,
          anchorIndex: null,
          total: 1,
          items: [privateChannel],
        };
      if (command === 'list_archive_downloads')
        return { schemaVersion: 1, revision: '1', entries: [saved] };
      if (command === 'stop_archive_downloads')
        return { schemaVersion: 1, stopped: true, cleanupPending: false };
      if (command === 'start_iptv_playback') {
        privateStarts++;
        if (mode === 'private-start' && privateStarts === 1) await hold('private-start');
        return {
          schemaVersion: 1,
          sessionGeneration: String(privateStarts),
          mediaUrl: `http://127.0.0.1:1234/account/${'c'.repeat(64)}/media/${String(privateStarts).repeat(64)}`,
        };
      }
      if (command === 'stop_iptv_playback') {
        if (mode === 'private-start' && args.sessionGeneration === '1') await hold('private-stop');
        return { schemaVersion: 1, sessionGeneration: args.sessionGeneration, stopped: true };
      }
      if (command === 'start_archive_download_playback') {
        archiveStarts++;
        if (mode === 'archive-start' && archiveStarts === 1) await hold('archive-start');
        return {
          kind: 'started',
          schemaVersion: 1,
          sessionGeneration: String(archiveStarts),
          mediaUrl: `http://127.0.0.1:1234/archive/${'c'.repeat(64)}/${'d'.repeat(64)}.mp4`,
          leaseMs: 60000,
          cleanupPending: false,
        };
      }
      if (command === 'stop_archive_playback') {
        if (mode === 'archive-stop' && !closing) await hold('archive-stop');
        return {
          schemaVersion: 1,
          sessionGeneration: (args.request as { sessionGeneration: string }).sessionGeneration,
          stopped: true,
          cleanupPending: false,
        };
      }
      if (command === 'read_archive_bookmark')
        return {
          schemaVersion: 1,
          sessionGeneration: (args.request as { sessionGeneration: string }).sessionGeneration,
          supported: false,
          revision: '0',
          position: null,
        };
      if (command === 'inspect_source') {
        inspections++;
        if (mode === 'public' && inspections === 1) await hold('public-inspection');
        return { kind: 'media', mime: 'video/mp4' };
      }
      if (command === 'guide_sources' || command === 'guide_mappings') return [];
      throw new Error('controlled-optional-command-unavailable');
    },
  );
  await page.addInitScript(() => {
    let id = 0;
    Reflect.set(window, 'isTauri', true);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string, args?: unknown) =>
        Reflect.get(window, '__lifecycleInvoke')(command, args),
      transformCallback: () => ++id,
      unregisterCallback: () => {},
    });
    Reflect.set(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  });
  await page.route(
    /^(https:\/\/stream\.lifecycle\.invalid\/|http:\/\/127\.0\.0\.1:1234\/)/,
    async (route) => {
      mediaRequests++;
      if (!closing) await new Promise<void>((resolve) => mediaReleases.push(resolve));
      await route.abort().catch(() => {});
    },
  );
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('.channel')).toHaveCount(2);
  return {
    calls,
    account,
    privateStarts: () => privateStarts,
    archiveStarts: () => archiveStarts,
    mediaRequests: () => mediaRequests,
    held: (key: string) => releases.has(key),
    release: (key: string) => {
      const release = releases.get(key);
      if (!release) throw new Error(`No held ${key}`);
      releases.delete(key);
      release();
    },
    async close() {
      await test.info().attach('controlled-bridge-calls', {
        body: Buffer.from(JSON.stringify(calls)),
        contentType: 'application/json',
      });
      closing = true;
      releases.forEach((release) => release());
      releases.clear();
      await page.evaluate(() => window.dispatchEvent(new Event('native-app-background')));
      mediaReleases.splice(0).forEach((release) => release());
      await page.unrouteAll({ behavior: 'wait' });
    },
  };
}
const background = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event('native-app-background')));
const foreground = (page: Page) =>
  page.evaluate(() => window.dispatchEvent(new Event('native-app-foreground')));
async function savedVideo(page: Page) {
  await page.locator('#genxtra-button').click();
  await page.getByLabel('Saved on this device · 1', { exact: true }).click();
  await page.getByRole('button', { name: 'Play saved', exact: true }).click();
}

test('native handoff keeps admitted public Connecting paused until explicit Resume', async ({
  page,
}) => {
  const f = await fixture(page, 'public');
  try {
    await page.locator('.channel').first().click();
    await expect.poll(() => f.held('public-inspection')).toBe(true);
    await expect(page.locator('#playback-status')).toHaveText('Connecting…');
    await background(page);
    await expect(page.locator('#playback-status')).toHaveText('Paused');
    await expect(page.locator('#watch-title')).toHaveText('Public A');
    await foreground(page);
    expect(f.mediaRequests()).toBe(0);
    f.release('public-inspection');
    await page.locator('#pause-button').click();
    await expect.poll(f.mediaRequests).toBe(1);
  } finally {
    await f.close();
  }
});

for (const timing of ['during cleanup', 'after cleanup'] as const)
  test(`pending private allocation and Stop are joined before explicit Resume ${timing}`, async ({
    page,
  }) => {
    const f = await fixture(page, 'private-start');
    try {
      // One saved account: Paid TV opens it directly (no picker needed).
      await page.locator('#paid-tv-button').click();
      await expect(page.locator('#paid-tv-button')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('.channel strong')).toHaveText('Private channel');
      await page.locator('.channel').click();
      await expect.poll(() => f.held('private-start')).toBe(true);
      await background(page);
      await background(page);
      await expect(page.locator('#playback-status')).toHaveText('Paused');
      await expect(page.locator('#watch-title')).toHaveText('Private channel');
      await expect(page.locator('#pause-button')).toHaveText('Resume');
      await foreground(page);
      if (timing === 'during cleanup') await page.locator('#pause-button').click();
      expect(f.privateStarts()).toBe(1);
      expect(f.mediaRequests()).toBe(0);
      f.release('private-start');
      await expect.poll(() => f.held('private-stop')).toBe(true);
      expect(f.privateStarts()).toBe(1);
      expect(f.mediaRequests()).toBe(0);
      f.release('private-stop');
      if (timing === 'after cleanup') {
        await expect(page.locator('.browser')).not.toHaveAttribute('inert', '');
        await expect(page.locator('#playback-status')).toHaveText('Paused');
        expect(f.privateStarts()).toBe(1);
        expect(f.mediaRequests()).toBe(0);
        await page.locator('#pause-button').click();
      }
      await expect.poll(f.privateStarts).toBe(2);
      await expect.poll(f.mediaRequests).toBe(1);
      await expect(page.locator('#watch-title')).toHaveText('Private channel');
    } finally {
      await f.close();
    }
  });

test('Archive cleanup held before public admission retains the queued public Resume without late playback', async ({
  page,
}) => {
  const f = await fixture(page, 'archive-stop');
  try {
    await savedVideo(page);
    await expect.poll(f.mediaRequests).toBe(1);
    await page.locator('#live-tv-button').click();
    await expect(page.locator('.channel')).toHaveCount(2);
    await page.locator('.channel').last().click();
    await expect.poll(() => f.held('archive-stop')).toBe(true);
    await background(page);
    await expect(page.locator('#playback-status')).toHaveText('Paused');
    await expect(page.locator('#watch-title')).toHaveText('Public B');
    await foreground(page);
    expect(f.mediaRequests()).toBe(1);
    f.release('archive-stop');
    await expect(page.locator('#pause-button')).toHaveText('Resume');
    expect(f.mediaRequests()).toBe(1);
    await page.locator('#pause-button').click();
    await expect.poll(f.mediaRequests).toBe(2);
    await expect(page.locator('#watch-title')).toHaveText('Public B');
  } finally {
    await f.close();
  }
});

test('background joins a late Archive allocation and compensating Stop without a decoder or implicit foreground play', async ({
  page,
}) => {
  const f = await fixture(page, 'archive-start');
  try {
    await savedVideo(page);
    await expect.poll(() => f.held('archive-start')).toBe(true);
    await background(page);
    f.release('archive-start');
    await expect
      .poll(() => f.calls.filter((call) => call.command === 'stop_archive_playback').length)
      .toBe(1);
    await foreground(page);
    expect(f.archiveStarts()).toBe(1);
    expect(f.mediaRequests()).toBe(0);
    expect(f.calls.some((call) => call.command === 'read_archive_bookmark')).toBe(false);
  } finally {
    await f.close();
  }
});
