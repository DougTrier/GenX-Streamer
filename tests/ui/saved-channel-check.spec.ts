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

// The bundled app with controlled IPC: proves the Not responding marks, the
// category item and Remove dead channels wiring only. The native rules (two
// days, a response clears) are proven by the Rust channel_check tests.
async function fixture(
  page: Page,
  options: { favorites?: string[]; deadTwo?: boolean; slow?: string[] } = {},
) {
  const sources = [
    { id: 'first', name: 'first', kind: 'url', location: 'https://first.fixture.invalid/list.m3u' },
  ];
  const channels = ['Alive one', 'Dead one', 'Alive two'].map((name, index) => ({
    id: `channel-${index}`,
    sourceId: 'first',
    name,
    category: 'News',
    urls: [`https://stream.fixture.invalid/${index}`],
  }));
  const catalog = JSON.stringify({ schemaVersion: 1, sources, channels });
  let preferences = JSON.stringify({
    schemaVersion: 1,
    favorites: options.favorites ?? [],
    removedChannels: [],
    volume: 0.8,
    muted: false,
    panelWidth: 360,
    sources,
    automaticSourceRefresh: false,
    sourceRefreshCadence: 'off',
    automaticGuideUpdates: false,
    reviewedChannelProviders: [],
    reviewedGuideProviders: [],
    channelCategoryOverrides: [],
  });
  const now = Date.now();
  const day = 86_400_000;
  const checks = [
    {
      channelId: 'channel-0',
      checkedMs: now,
      okMs: now,
      firstFailMs: null,
      lastFailMs: null,
      verdict: 'Reachable',
      notResponding: false,
    },
    {
      channelId: 'channel-1',
      checkedMs: now,
      okMs: null,
      firstFailMs: now - day,
      lastFailMs: now,
      verdict: 'TimedOut',
      notResponding: true,
    },
    ...(options.deadTwo
      ? [
          {
            channelId: 'channel-2',
            checkedMs: now,
            okMs: null,
            firstFailMs: now - day,
            lastFailMs: now,
            verdict: 'TimedOut',
            notResponding: true,
          },
        ]
      : []),
  ];
  let viewRevision = 1;
  const calls: { command: string; args: Record<string, unknown> }[] = [],
    unknown: string[] = [];
  await page.exposeBinding(
    '__savedCheckInvoke',
    async (_binding, command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      const prefs = JSON.parse(preferences);
      if (command === 'plugin:event|listen') return calls.length;
      if (['plugin:event|unlisten', 'cancel_catalog_query', 'cancel_playlist'].includes(command))
        return;
      if (command === 'renderer_recovery_bootstrap')
        return { schemaVersion: 1, recoveredRenderer: false };
      if (command === 'list_archive_downloads')
        return { schemaVersion: 1, revision: '0', entries: [] };
      if (command === 'list_iptv_accounts') return [];
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
      if (command === 'guide_sources' || command === 'guide_mappings') return [];
      if (command === 'read_channel_checks')
        return { schemaVersion: 1, nowMs: now, checks, slowChannels: options.slow ?? [] };
      if (command === 'query_catalog_page') {
        const q = args.query as {
          requestId: string;
          startIndex?: number;
          pageSize: number;
          filter: string;
        };
        const rows = channels
          .filter((c) => !prefs.removedChannels.includes(c.id))
          .filter(
            (c) =>
              q.filter !== 'unresponsive' ||
              checks.some((k) => k.channelId === c.id && k.notResponding),
          )
          .map((c) => ({
            id: c.id,
            sourceId: c.sourceId,
            name: c.name,
            category: c.category,
            favorite: false,
          }));
        const start = q.startIndex ?? 0;
        return {
          schemaVersion: 1,
          requestId: q.requestId,
          catalogRevision: '1',
          viewRevision: String(viewRevision),
          queryVersion: 'v1-' + 'a'.repeat(64),
          totalCount: rows.length,
          startIndex: start,
          anchorIndex: null,
          rows: rows.slice(start, start + q.pageSize),
          after:
            start + q.pageSize < rows.length
              ? {
                  schemaVersion: 1,
                  queryKey: 'a'.repeat(64),
                  catalogRevision: '1',
                  viewRevision: String(viewRevision),
                  sortKey: '',
                  id: rows[start + q.pageSize - 1]!.id,
                }
              : null,
        };
      }
      if (command === 'mutate_catalog_group') {
        const request = args.request as {
          channelId: string;
          action: { kind: string };
          moreChannelIds?: string[];
        };
        expect(request.action).toEqual({ kind: 'remove' });
        prefs.removedChannels = [
          ...prefs.removedChannels,
          request.channelId,
          ...(request.moreChannelIds ?? []),
        ];
        preferences = JSON.stringify(prefs);
        viewRevision++;
        return {
          schemaVersion: 1,
          committed: true,
          catalogRevision: '1',
          viewRevision: String(viewRevision),
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
      if (command === 'read_viewing_settings')
        return { schemaVersion: 1, hideAdult: true, accountBuffers: {} };
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
        Reflect.get(window, '__savedCheckInvoke')(command, args),
      transformCallback: () => ++id,
      unregisterCallback: () => undefined,
    });
    Reflect.set(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      unregisterListener: () => undefined,
    });
  });
  // No stream is ever fetched by the page in this test.
  await page.route('https://stream.fixture.invalid/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#app'), `unanswered: ${unknown.join(', ')}`).toHaveAttribute(
    'data-ready',
    'true',
  );
  return { calls, preferences: () => JSON.parse(preferences) };
}

test('a channel that failed on two days is marked, listed and removable in one step', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const f = await fixture(page);
  const dead = page.locator('.channel-row[data-not-responding="true"]');
  await expect(dead).toHaveCount(1);
  await expect(dead).toContainText('Dead one');
  await expect(dead.locator('.channel-dead-mark')).toHaveText('Not responding');
  await expect(page.locator('.channel-row:not([data-not-responding])')).toHaveCount(2);

  // The category menu offers Not responding, with its count.
  await page.locator('#category-button').click();
  const item = page.locator('.filters [data-filter="unresponsive"]');
  await expect(item).toBeVisible();
  await expect(item).toHaveAttribute('data-count', '1');
  await item.click();
  await expect(page.locator('.channel-row')).toHaveCount(1);
  await expect(page.locator('#dead-channels')).toBeVisible();
  await expect(page.locator('#dead-channels-text')).toHaveText(
    '1 saved channel failed checks on two different days.',
  );

  await page.locator('#remove-dead-channels').click();
  await expect(page.locator('#dead-channels')).toBeHidden();
  await expect(page.locator('.channel-row')).toHaveCount(2);
  await expect(page.locator('.channel-row', { hasText: 'Dead one' })).toHaveCount(0);
  await expect(page.locator('#category-button')).toContainText('All');
  expect(f.preferences().removedChannels).toEqual(['channel-1']);
  const removals = f.calls.filter((c) => c.command === 'mutate_catalog_group');
  expect(removals).toHaveLength(1);
  // The item is gone once nothing is marked; nothing was checked or recorded here.
  await page.locator('#category-button').click();
  await expect(item).toBeHidden();
  expect(f.calls.some((c) => c.command === 'record_channel_checks')).toBe(false);
});

// Refresh (owner decision, October 21, 2026): channels the daily check
// confirmed dead are removed, favorites are kept, then new channels are looked
// for (the scan's Refresh mode; its trust windows are proven in Rust).
test('Refresh removes confirmed-dead channels but keeps a favorite', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const f = await fixture(page, { favorites: ['channel-2'], deadTwo: true });
  await expect(page.locator('.channel-row[data-not-responding="true"]')).toHaveCount(2);
  await page.locator('#inline-scan-refresh').dispatchEvent('click');
  await expect.poll(() => f.preferences().removedChannels).toEqual(['channel-1']);
  await expect(page.locator('.channel-row', { hasText: 'Dead one' })).toHaveCount(0);
  // The favorite stays, still marked Not responding.
  await expect(
    page.locator('.channel-row[data-not-responding="true"]', { hasText: 'Alive two' }),
  ).toHaveCount(1);
  expect(f.calls.filter((c) => c.command === 'mutate_catalog_group')).toHaveLength(1);
});

// Batch removal (owner design, October 21, 2026): every confirmed-dead
// channel leaves in one native write and one list refresh.
test('removing not responding channels is one write for all of them', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const f = await fixture(page, { deadTwo: true });
  await expect(page.locator('.channel-row[data-not-responding="true"]')).toHaveCount(2);
  await page.locator('#category-button').click();
  await page.locator('.filters [data-filter="unresponsive"]').click();
  await expect(page.locator('#dead-channels')).toBeVisible();
  await page.locator('#remove-dead-channels').click();
  await expect.poll(() => f.preferences().removedChannels).toEqual(['channel-1', 'channel-2']);
  const removals = f.calls.filter((c) => c.command === 'mutate_catalog_group');
  expect(removals).toHaveLength(1);
  expect((removals[0]!.args.request as { moreChannelIds: string[] }).moreChannelIds).toEqual([
    'channel-2',
  ]);
});

// The Slow badge (owner design, October 21, 2026): the native rule decides
// (Rust tests); this proves the mark reaches the right row only.
test('a Slow channel is marked Slow, and a Not responding one keeps that mark', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const f = await fixture(page, { slow: ['channel-0', 'channel-1'] });
  const slow = page.locator('.channel-row[data-slow="true"]');
  await expect(slow).toHaveCount(1);
  await expect(slow).toContainText('Alive one');
  await expect(slow.locator('.channel-slow-mark')).toHaveText('Slow');
  // Not responding takes precedence over Slow.
  const dead = page.locator('.channel-row', { hasText: 'Dead one' });
  await expect(dead.locator('.channel-dead-mark')).toHaveText('Not responding');
  await expect(dead.locator('.channel-slow-mark')).toHaveCount(0);
  // Slow channels sort after fast ones natively (order proven in Rust): a
  // changed Slow set makes the list read again from the start, once.
  const fresh = (calls: typeof f.calls) =>
    calls.filter(
      (c) =>
        c.command === 'query_catalog_page' &&
        !(c.args.query as { after?: unknown; startIndex?: number }).after &&
        !(c.args.query as { startIndex?: number }).startIndex,
    ).length;
  await page.waitForTimeout(1500);
  const withSlow = fresh(f.calls);
  const other = await page.context().newPage();
  await other.setViewportSize({ width: 1280, height: 720 });
  const plain = await fixture(other, {});
  await expect(other.locator('.channel-row')).toHaveCount(3);
  await other.waitForTimeout(1500);
  expect(withSlow).toBe(fresh(plain.calls) + 1);
  await other.close();
});
