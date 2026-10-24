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

// Real bundled main + capture worker + automatic guide owner + Guide host.
// Controlled IPC replies do not prove native SQLite, acquisition, matching or decoding.
async function fixture(page: Page, revoke: boolean) {
  const source = {
    id: 'playlist-source',
    name: 'Owned playlist',
    location: 'http://playlist.fixture.invalid/catalog.m3u',
    kind: 'url',
    allowHttp: true,
    contentKind: 'catalog',
    mediaMime: 'text/plain',
  };
  const channel = {
    id: 'owned-channel',
    sourceId: source.id,
    providerId: 'owned-xmltv',
    name: 'Owned channel',
    category: 'Fixture',
    urls: ['https://stream.fixture.invalid/live.m3u8'],
  };
  const catalog = JSON.stringify({ schemaVersion: 1, sources: [source], channels: [channel] });
  const preferences = JSON.stringify({
    schemaVersion: 1,
    favorites: [],
    removedChannels: [],
    volume: 0.8,
    muted: false,
    panelWidth: 360,
    sources: [source],
    automaticSourceRefresh: false,
    sourceRefreshCadence: 'off',
    automaticGuideUpdates: true,
    reviewedChannelProviders: [],
    reviewedGuideProviders: [],
    sourceRefreshAttemptAt: 0,
  });
  let guide = {
    id: 'saved-guide',
    name: 'My explicit guide name',
    location: 'http://guide.fixture.invalid/schedule.xml',
    kind: 'url',
    allowHttp: true,
    revision: 1,
    updatedMs: null as number | null,
  };
  let published = false,
    mapped = false,
    coverageReads = 0,
    holdReads = false;
  const pending: (() => void)[] = [],
    calls: { command: string; args: Record<string, unknown> }[] = [],
    unknown: string[] = [];
  const at = Date.now();
  const pair = { catalog, preferences, health: null, catalogRevision: '1', healthRevision: '0' };
  const snapshot = () => ({ ...guide });
  await page.exposeBinding(
    '__permissionInvoke',
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
      if (command === 'device_capabilities') return { isTelevision: false };
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
      if (command === 'read_record_pair') return pair;
      if (command === 'read_record') return preferences;
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
      // Read-only publisher feed suggestions: none for this owned fixture catalog.
      if (command === 'guide_pack_suggestions') return [];
      if (command === 'query_catalog_page') {
        const query = args.query as { requestId: string; startIndex?: number };
        return {
          schemaVersion: 1,
          requestId: query.requestId,
          catalogRevision: '1',
          viewRevision: '1',
          queryVersion: 'v1-' + 'a'.repeat(64),
          totalCount: 1,
          startIndex: query.startIndex ?? 0,
          anchorIndex: null,
          rows: [
            {
              id: channel.id,
              sourceId: source.id,
              providerId: channel.providerId,
              name: channel.name,
              category: channel.category,
              favorite: false,
            },
          ],
          after: null,
        };
      }
      if (command === 'guide_sources') {
        if (holdReads) await new Promise<void>((resolve) => pending.push(resolve));
        return [snapshot()];
      }
      if (command === 'guide_mappings')
        return mapped
          ? [
              {
                catalogSourceId: source.id,
                appChannelId: channel.id,
                guideSourceId: guide.id,
                xmltvChannelId: channel.providerId,
              },
            ]
          : [];
      if (command === 'inspect_source') {
        expect(args.url).toBe(source.location);
        expect(args.allowHttp).toBe(true);
        return {
          kind: 'catalog',
          mime: 'text/plain',
          text:
            '#EXTM3U x-tvg-url="' +
            guide.location +
            '"\n#EXTINF:-1 tvg-id="owned-xmltv",Owned channel\n' +
            channel.urls[0] +
            '\n',
        };
      }
      if (command === 'guide_coverage') {
        expect(args.sourceId).toBe(guide.id);
        coverageReads++;
        // Initial whole-scope connection then cacheReady have both seen the captured grant.
        // Hold subsequent actual metadata reads before source-ID preview can be admitted.
        if (revoke && coverageReads === 2) holdReads = true;
        return {
          sourceRevision: guide.revision,
          publishedRevision: published ? guide.revision : null,
          channelCount: published ? 1 : 0,
          programCount: published ? 1 : 0,
          firstStartMs: published ? at : null,
          lastStartMs: published ? at : null,
          lastStopMs: published ? at + 3600000 : null,
          unknownEndCount: 0,
        };
      }
      if (command === 'guide_connect_cached_catalog') {
        expect(args.expectedCatalogRevision).toBe('1');
        const caches = args.sources as unknown[];
        if (published && caches.length === 1) mapped = true;
        return {
          catalogRevision: '1',
          matched: mapped ? 1 : 0,
          unmatched: mapped ? 0 : 1,
          ambiguous: 0,
          preservedMappings: 0,
          checkedSources: caches.length,
          mappingConflictAssessment: 'complete',
          preservedMappingConflicts: 0,
        };
      }
      if (command === 'guide_preview') {
        expect(args.sourceId).toBe('saved-guide');
        expect(guide.allowHttp).toBe(true);
        return {
          ticket: 'owned-preview',
          sourceId: guide.id,
          sourceRevision: guide.revision,
          channels: 1,
          programs: 1,
          firstStartMs: at,
          lastStartMs: at,
          lastKnownStopMs: at + 3600000,
        };
      }
      if (command === 'guide_commit') {
        expect(args.ticket).toBe('owned-preview');
        expect(args.expectedRevision).toBe(1);
        expect(args.allowEmpty).toBe(false);
        published = true;
        guide = { ...guide, revision: 2, updatedMs: Date.now() };
        return 2;
      }
      if (command === 'guide_listed_channels') {
        const q = args.query as { startMs: number; endMs: number };
        return {
          startMs: q.startMs,
          endMs: q.endMs,
          rootGeneration: 1,
          catalogRevision: '1',
          databaseRevision: 1,
          viewRevision: '1',
          groupingPolicy: 'exact-ordered-endpoints-policy-v2',
          channels:
            published && mapped && at < q.endMs && at + 3600000 > q.startMs
              ? [
                  {
                    catalogSourceId: source.id,
                    appChannelId: channel.id,
                    guideSourceId: guide.id,
                    xmltvChannelId: channel.providerId,
                    sourceRevision: guide.revision,
                    filterMask: 0,
                  },
                ]
              : [],
          nextCursor: null,
        };
      }
      if (command === 'guide_programs')
        return {
          programs:
            published && mapped
              ? [
                  {
                    catalogSourceId: source.id,
                    appChannelId: channel.id,
                    guideSourceId: guide.id,
                    xmltvChannelId: channel.providerId,
                    startMs: at,
                    stopMs: at + 3600000,
                    title: 'Owned programme',
                    description: null,
                    ordinal: 0,
                    categories: [],
                  },
                ]
              : [],
          nextCursor: null,
          sourceRevision: guide.revision,
          databaseRevision: 1,
        };
      if (['guide_visible_summaries', 'guide_selected_summary'].includes(command))
        throw 'controlled-summary-unavailable';
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
    let callbackId = 0;
    Reflect.set(window, 'isTauri', true);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string, args?: unknown) =>
        Reflect.get(window, '__permissionInvoke')(command, args),
      transformCallback: () => ++callbackId,
      unregisterCallback: () => undefined,
    });
    Reflect.set(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      unregisterListener: () => undefined,
    });
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  return {
    calls,
    unknown,
    snapshot,
    pendingCount: () => pending.length,
    mapped: () => mapped,
    published: () => published,
    revokeAndRelease: () => {
      guide = { ...guide, allowHttp: false, revision: 2 };
      holdReads = false;
      for (const release of pending.splice(0)) release();
    },
  };
}

test('bundled main previews a separately granted existing HTTP guide by ID without overwriting it', async ({
  page,
}) => {
  const f = await fixture(page, false);
  await page.locator('#guide-button').click();
  const guide = page.getByRole('dialog', { name: 'Program guide', exact: true });
  await guide.getByRole('button', { name: 'Find program guides', exact: true }).click();
  await expect.poll(() => f.mapped()).toBe(true);
  await expect(guide).toContainText('1 channel with listings');
  expect(f.calls.filter((c) => c.command === 'guide_preview')).toHaveLength(1);
  expect(f.calls.some((c) => c.command === 'guide_save_source')).toBe(false);
  expect(f.snapshot()).toMatchObject({
    id: 'saved-guide',
    name: 'My explicit guide name',
    location: 'http://guide.fixture.invalid/schedule.xml',
    allowHttp: true,
    revision: 2,
  });
  expect(f.unknown).toEqual([]);
});

test('bundled main refuses a captured HTTP grant revoked during a held latest-source read', async ({
  page,
}) => {
  const f = await fixture(page, true);
  await page.locator('#guide-button').click();
  const guide = page.getByRole('dialog', { name: 'Program guide', exact: true });
  await guide.getByRole('button', { name: 'Find program guides', exact: true }).click();
  await expect.poll(() => f.pendingCount()).toBeGreaterThan(0);
  expect(
    f.calls.some((c) => c.command === 'guide_preview' || c.command === 'guide_save_source'),
  ).toBe(false);
  f.revokeAndRelease();
  await expect(guide.getByRole('alert')).toHaveText(
    'Guide action failed. Previous schedule retained; retry or review the source and mapping.',
  );
  expect(
    f.calls.some(
      (c) =>
        c.command === 'guide_preview' ||
        c.command === 'guide_save_source' ||
        c.command === 'guide_commit',
    ),
  ).toBe(false);
  expect(f.published()).toBe(false);
  expect(f.mapped()).toBe(false);
  expect(f.snapshot()).toMatchObject({
    name: 'My explicit guide name',
    allowHttp: false,
    revision: 2,
  });
  expect(f.unknown).toEqual([]);
});
