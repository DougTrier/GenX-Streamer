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

// Actual bundled main and preference owner. Controlled IPC proves frontend wiring only,
// not SQLite durability, native acquisition, or decoder behavior.
async function fixture(page: Page) {
  const sources = ['first', 'second'].map((id) => ({
    id,
    name: id,
    kind: 'url',
    location: `https://${id}.fixture.invalid/catalog.m3u`,
  }));
  const channels = [
    {
      id: 'twin-first',
      sourceId: 'first',
      name: 'Shared name',
      category: 'News',
      urls: ['https://stream.fixture.invalid/first'],
    },
    {
      id: 'twin-second',
      sourceId: 'second',
      name: 'Shared name',
      category: 'News',
      urls: ['https://stream.fixture.invalid/second'],
    },
    {
      id: 'removed-favorite',
      sourceId: 'first',
      name: 'Removed favorite',
      category: 'Sports',
      urls: ['https://stream.fixture.invalid/removed'],
    },
  ];
  const catalog = JSON.stringify({ schemaVersion: 1, sources, channels });
  const scheduleStart = Math.floor(Date.now() / 1800000) * 1800000;
  const guideSource = {
    id: 'saved-guide',
    name: 'Saved fixture guide',
    kind: 'url',
    location: 'https://guide.fixture.invalid/guide',
    allowHttp: false,
    revision: 1,
    updatedMs: Date.now(),
  };
  const mappings = channels.map((c) => ({
    catalogSourceId: c.sourceId,
    appChannelId: c.id,
    guideSourceId: guideSource.id,
    xmltvChannelId: c.id,
  }));
  const programs = mappings.map((m, ordinal) => ({
    ...m,
    title: 'Saved fixture programme',
    description: null,
    categories: [],
    ordinal,
    startMs: scheduleStart,
    stopMs: scheduleStart + 3 * 60 * 60 * 1000,
  }));
  let preferences = JSON.stringify({
    schemaVersion: 1,
    favorites: ['twin-first', 'removed-favorite'],
    removedChannels: ['removed-favorite'],
    volume: 0.8,
    muted: false,
    panelWidth: 360,
    sources,
    automaticSourceRefresh: false,
    sourceRefreshCadence: 'off',
    automaticGuideUpdates: false,
    reviewedChannelProviders: [],
    reviewedGuideProviders: [],
    channelCategoryOverrides: [{ channelId: 'twin-second', category: 'Sports' }],
  });
  let release: (() => void) | null = null;
  let viewRevision = '1';
  const calls: { command: string; args: Record<string, unknown> }[] = [],
    unknown: string[] = [];
  await page.exposeBinding(
    '__guideFavoriteInvoke',
    async (_binding, command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      if (command === 'plugin:event|listen') return calls.length;
      if (['plugin:event|unlisten', 'cancel_catalog_query', 'cancel_playlist'].includes(command))
        return;
      if (command === 'renderer_recovery_bootstrap')
        return { schemaVersion: 1, recoveredRenderer: false };
      if (command === 'list_archive_downloads')
        return { schemaVersion: 1, revision: '0', entries: [] };
      if (command === 'list_iptv_accounts') return [];
      // The quiet saved-channel check reads its newest results at start-up.
      if (command === 'read_channel_checks')
        return { schemaVersion: 1, nowMs: Date.now(), checks: [] };
      if (command === 'channel_logos') {
        const request = args.request as { channelIds: string[]; expectedRevision: string };
        return {
          schemaVersion: 1,
          catalogRevision: request.expectedRevision,
          attemptedChannelIds: request.channelIds,
          images: [],
        };
      }
      if (command === 'runtime_info') return { platform: 'android', dataMode: 'application' };
      if (command === 'plugin:app|version') return '0.1.0';
      if (command === 'device_capabilities') return { isTelevision: true };
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
      if (command === 'read_record') {
        expect(args.name).toBe('preferences');
        return preferences;
      }
      if (command === 'read_guide_capture') return { catalog, preferences, catalogRevision: '1' };
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
      if (command === 'guide_refresh_plan') return { nowMs: Date.now(), sources: [] };
      if (command === 'guide_sources') return [guideSource];
      if (command === 'guide_mappings') return mappings;
      if (command === 'guide_listed_channels') {
        const q = args.query as { startMs: number; endMs: number };
        const prefs = JSON.parse(preferences);
        const removed = prefs.removedChannels as string[];
        return {
          startMs: q.startMs,
          endMs: q.endMs,
          rootGeneration: 1,
          catalogRevision: '1',
          databaseRevision: 1,
          viewRevision,
          groupingPolicy: 'exact-ordered-endpoints-policy-v2',
          channels: programs
            .filter(
              (p) =>
                !removed.includes(p.appChannelId) && p.startMs < q.endMs && p.stopMs > q.startMs,
            )
            .map((p) => {
              const saved = channels.find(
                (c) => c.id === p.appChannelId && c.sourceId === p.catalogSourceId,
              )!;
              const category = (
                prefs.channelCategoryOverrides.find(
                  (o: { channelId: string }) => o.channelId === saved.id,
                )?.category ?? saved.category
              )
                .normalize('NFKC')
                .toLowerCase();
              return {
                catalogSourceId: p.catalogSourceId,
                appChannelId: p.appChannelId,
                guideSourceId: p.guideSourceId,
                xmltvChannelId: p.xmltvChannelId,
                sourceRevision: 1,
                filterMask:
                  Number(prefs.favorites.includes(saved.id)) +
                  2 * Number(category.includes('news')) +
                  4 * Number(category.includes('sports')),
              };
            })
            .sort(
              (a, b) =>
                a.catalogSourceId.localeCompare(b.catalogSourceId) ||
                a.appChannelId.localeCompare(b.appChannelId),
            ),
          nextCursor: null,
        };
      }
      if (command === 'guide_programs') {
        const q = args.query as {
          appChannelIds: string[];
          windowStartMs: number;
          windowEndMs: number;
        };
        return {
          sourceRevision: 1,
          databaseRevision: 1,
          nextCursor: null,
          programs: programs.filter(
            (p) =>
              q.appChannelIds.includes(p.appChannelId) &&
              p.startMs < q.windowEndMs &&
              p.stopMs > q.windowStartMs,
          ),
        };
      }
      if (command === 'guide_visible_summaries' || command === 'guide_selected_summary')
        throw 'controlled-summary-unavailable';
      if (command === 'query_catalog_page') {
        const q = args.query as { requestId: string; startIndex?: number; pageSize: number };
        const prefs = JSON.parse(preferences);
        const rows = channels
          .filter((c) => !prefs.removedChannels.includes(c.id))
          .map((c) => ({
            id: c.id,
            sourceId: c.sourceId,
            name: c.name,
            category:
              prefs.channelCategoryOverrides.find(
                (o: { channelId: string }) => o.channelId === c.id,
              )?.category ?? c.category,
            favorite: prefs.favorites.includes(c.id),
          }));
        return {
          schemaVersion: 1,
          requestId: q.requestId,
          catalogRevision: '1',
          viewRevision,
          queryVersion: 'v1-' + 'a'.repeat(64),
          totalCount: rows.length,
          startIndex: q.startIndex ?? 0,
          anchorIndex: null,
          rows: rows.slice(q.startIndex ?? 0, (q.startIndex ?? 0) + q.pageSize),
          after:
            (q.startIndex ?? 0) + q.pageSize < rows.length
              ? {
                  schemaVersion: 1,
                  queryKey: 'a'.repeat(64),
                  catalogRevision: '1',
                  viewRevision,
                  sortKey: '',
                  id: rows[(q.startIndex ?? 0) + q.pageSize - 1]!.id,
                }
              : null,
        };
      }
      if (command === 'mutate_catalog_group') {
        const request = args.request as {
          schemaVersion: number;
          requestId: string;
          channelId: string;
          expectedCatalogRevision: string;
          expectedViewRevision: string;
          action: { kind: string; value: boolean };
        };
        expect(request).toMatchObject({
          schemaVersion: 1,
          channelId: 'twin-second',
          expectedCatalogRevision: '1',
          expectedViewRevision: viewRevision,
          action: { kind: 'favorite', value: true },
        });
        expect(request.requestId).toEqual(expect.any(String));
        const next = JSON.parse(preferences);
        next.favorites = [...next.favorites, request.channelId];
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        preferences = JSON.stringify(next);
        viewRevision = '2';
        release = null;
        return {
          schemaVersion: 1,
          committed: true,
          catalogRevision: '1',
          viewRevision,
          affectedCount: 1,
        };
      }
      if (command === 'append_diagnostic_event')
        return {
          schemaVersion: 1,
          id: String(calls.length),
          timestampMs: Date.now(),
          ...(args.event as object),
        };
      // Stored viewing choices at their defaults (adult hidden, no account buffers).
      if (command === 'read_viewing_settings')
        return { schemaVersion: 1, hideAdult: true, accountBuffers: {} };
      // The header's VPN shield: no VPN on this controlled device.
      if (command === 'vpn_status') return { connected: false };
      unknown.push(command);
      throw new Error('controlled-command-unavailable');
    },
  );
  await page.addInitScript(() => {
    let id = 0;
    Reflect.set(window, 'isTauri', true);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string, args?: unknown) =>
        Reflect.get(window, '__guideFavoriteInvoke')(command, args),
      transformCallback: () => ++id,
      unregisterCallback: () => undefined,
    });
    Reflect.set(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      unregisterListener: () => undefined,
    });
  });
  let acquisitions = 0;
  await page.route('https://stream.fixture.invalid/**', (route) => {
    acquisitions++;
    return route.abort();
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  return {
    calls,
    unknown,
    acquisitions: () => acquisitions,
    held: () => release !== null,
    ack: () => {
      if (!release) throw new Error('No held write');
      release();
    },
    preferences: () => JSON.parse(preferences),
  };
}

test('bundled Guide uses saved category and exact favorite identity only after preference ACK', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const f = await fixture(page);
  const title = await page.locator('#watch-title').textContent();
  await page.locator('#guide-button').click();
  const guide = page.getByRole('dialog', { name: 'Program guide', exact: true });
  const filters = guide.getByRole('group', { name: 'Guide channel categories', exact: true });
  const identities = () =>
    guide
      .locator('.gx-timeline-row')
      .evaluateAll((rows) =>
        rows.map((row) => JSON.parse((row as HTMLElement).dataset.channelKey!)[0]),
      );
  await filters.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect.poll(identities).toEqual(['twin-first']);
  await expect(guide.getByText('Removed favorite', { exact: true })).toHaveCount(0);
  await filters.getByRole('button', { name: 'Sports', exact: true }).click();
  await expect.poll(identities).toEqual(['twin-second']);
  await expect(guide.locator('.gx-timeline-channel .media-result-title')).toHaveText([
    'Shared name',
  ]);
  await guide.getByRole('button', { name: 'Close guide', exact: true }).click();
  const second = page
    .locator('.channel-row')
    .filter({ has: page.locator('[data-channel="twin-second"]') });
  // Exact saved ID scopes the action despite duplicate display names.
  await second.getByRole('button', { name: 'Favorite Shared name', exact: true }).click();
  await expect.poll(f.held).toBe(true);
  expect(f.calls.filter((c) => c.command === 'mutate_catalog_group')).toHaveLength(1);
  expect(f.calls.some((c) => c.command === 'write_record_receipt')).toBe(false);
  expect(f.preferences().favorites).toEqual(['twin-first', 'removed-favorite']);
  await page.locator('#guide-button').click();
  await filters.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect.poll(identities).toEqual(['twin-first']);
  f.ack();
  await expect.poll(() => f.preferences().favorites).toContain('twin-second');
  await expect.poll(identities).toEqual(['twin-first', 'twin-second']);
  await expect(guide.locator('.gx-timeline-channel .media-result-title')).toHaveText([
    'Shared name',
    'Shared name',
  ]);
  expect(await page.locator('#watch-title').textContent()).toBe(title);
  await expect(page.locator('#video')).toHaveJSProperty('paused', true);
  expect(
    f.calls.filter((c) =>
      /^(inspect_|guide_preview|guide_commit|guide_save_source)/.test(c.command),
    ),
  ).toEqual([]);
  expect(f.acquisitions()).toBe(0);
  expect(f.unknown).toEqual([]);
});
