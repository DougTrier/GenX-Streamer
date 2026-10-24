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

// Real bundled main/guide owner/bridge; controlled native receipts are not
// SQLite, network freshness, decoder, or physical background evidence.
async function fixture(
  page: Page,
  guideEnabled: boolean,
  held = false,
  recovery: 'ordinary' | 'recovered' | 'unavailable' = 'ordinary',
) {
  const calls: string[] = [];
  let finishRefresh!: () => void;
  let finishCancellation!: () => void;
  let lastGood = 'original-schedule';
  let refreshed = false;
  const preferences = JSON.stringify({
    schemaVersion: 1,
    favorites: [],
    removedChannels: [],
    volume: 0.8,
    muted: false,
    panelWidth: 360,
    sources: [],
    automaticSourceRefresh: false,
    sourceRefreshCadence: 'off',
    automaticGuideUpdates: guideEnabled,
    sourceRefreshAttemptAt: 0,
    reviewedChannelProviders: [],
    reviewedGuideProviders: [],
  });
  await page.exposeFunction(
    '__guideInvoke',
    async (
      command: string,
      args: { requestId?: string; active?: boolean; request?: unknown; query?: unknown } = {},
    ) => {
      calls.push(command);
      if (command === 'plugin:event|listen') return calls.length;
      if (command === 'plugin:event|unlisten' || command === 'cancel_catalog_query') return;
      if (command === 'renderer_recovery_bootstrap') {
        if (recovery === 'unavailable') throw new Error('controlled-recovery-unavailable');
        return { schemaVersion: 1, recoveredRenderer: recovery === 'recovered' };
      }
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
      if (command === 'plugin:app|version') return '0.1.0';
      if (command === 'query_catalog_page') {
        const q = args.query as { requestId: string; startIndex?: number };
        return {
          schemaVersion: 1,
          requestId: q.requestId,
          catalogRevision: '0',
          viewRevision: '0',
          queryVersion: 'v1-' + 'a'.repeat(64),
          totalCount: 0,
          startIndex: q.startIndex ?? 0,
          anchorIndex: null,
          rows: [],
          after: null,
        };
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
          catalogRevision: '0',
          checkpointRevision: '0',
        };
      if (command === 'guide_sources' || command === 'guide_mappings') return [];
      if (command === 'runtime_info') return { platform: 'android', dataMode: 'application' };
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
      if (command === 'read_record_pair')
        return {
          catalog: null,
          health: null,
          preferences,
          catalogRevision: '0',
          healthRevision: '0',
        };
      if (command === 'read_record') return preferences;
      if (command === 'guide_refresh_plan')
        return {
          nowMs: Date.now(),
          sources: [
            {
              sourceId: 'retained-guide',
              sourceRevision: 1,
              nextDueMs: refreshed ? Date.now() + 86400000 : 0,
            },
          ],
        };
      if (command === 'guide_refresh_due') {
        if (held) {
          await new Promise<void>((resolve) => {
            finishRefresh = resolve;
          });
          // A canceled noncommitting operation preserves the stored schedule.
          throw 'canceled';
        }
        refreshed = true;
        lastGood = 'updated-schedule';
        return {
          requestId: args.requestId,
          sourceId: 'retained-guide',
          sourceRevision: 2,
          status: 'refreshed',
          nextDueMs: Date.now() + 86400000,
          updatedMs: Date.now(),
        };
      }
      if (command === 'cancel_playlist') {
        await new Promise<void>((resolve) => {
          finishCancellation = resolve;
        });
        // The controlled retained guide's next attempt is not due immediately.
        refreshed = true;
        return;
      }
      throw new Error('controlled-command-unavailable');
    },
  );
  await page.addInitScript(() => {
    let callbackId = 0;
    Reflect.set(window, 'isTauri', true);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string, args?: unknown) =>
        Reflect.get(window, '__guideInvoke')(command, args),
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
    schedule: () => lastGood,
    finishRefresh: () => finishRefresh(),
    finishCancellation: () => finishCancellation(),
  };
}

test('automatic guide On refreshes a due retained guide while source cadence is Off', async ({
  page,
}) => {
  const f = await fixture(page, true);
  await expect.poll(() => f.calls.filter((c) => c === 'guide_refresh_due').length).toBe(1);
  expect(f.schedule()).toBe('updated-schedule');
  expect(f.calls).not.toContain('inspect_source');
});

test('automatic guide Off prevents plan and acquisition despite foreground wake', async ({
  page,
}) => {
  const f = await fixture(page, false);
  await page.evaluate(() => {
    window.dispatchEvent(new Event('native-app-foreground'));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  expect(f.calls).not.toContain('guide_refresh_plan');
  expect(f.calls).not.toContain('guide_refresh_due');
  expect(f.schedule()).toBe('original-schedule');
});

test('background cancellation joins held refresh and cancel before foreground replans; last good remains', async ({
  page,
}) => {
  const f = await fixture(page, true, true);
  await expect.poll(() => f.calls.filter((c) => c === 'guide_refresh_due').length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('native-app-background')));
  await expect.poll(() => f.calls.filter((c) => c === 'cancel_playlist').length).toBe(1);
  await page.evaluate(() => window.dispatchEvent(new Event('native-app-foreground')));
  expect(f.calls.filter((c) => c === 'guide_refresh_plan')).toHaveLength(1);
  f.finishRefresh();
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
  expect(f.calls.filter((c) => c === 'guide_refresh_plan')).toHaveLength(1);
  expect(f.schedule()).toBe('original-schedule');
  // Keep native foreground false when the suspension finishes so no second
  // held operation is admitted merely to clean up the fixture.
  await page.evaluate(() => window.dispatchEvent(new Event('native-app-background')));
  f.finishCancellation();
  await page.evaluate(() => window.dispatchEvent(new Event('native-app-foreground')));
  await expect.poll(() => f.calls.filter((c) => c === 'guide_refresh_plan').length).toBe(2);
  expect(f.calls.filter((c) => c === 'guide_refresh_due')).toHaveLength(1);
  expect(f.schedule()).toBe('original-schedule');
});

for (const recovery of ['recovered', 'unavailable'] as const) {
  test(`automatic guide retains its saved preference but refuses ${recovery} bootstrap without session authorization`, async ({
    page,
  }) => {
    const f = await fixture(page, true, false, recovery);
    await page.evaluate(() => window.dispatchEvent(new Event('native-app-foreground')));
    await expect(page.locator('#notice')).toHaveText(
      'Automatic updates are paused for this session. Use Scan or Refresh when you are ready.',
    );
    expect(f.calls).not.toContain('guide_refresh_plan');
    expect(f.calls).not.toContain('guide_refresh_due');
    expect(f.schedule()).toBe('original-schedule');
    expect(f.calls).not.toContain('write_record_receipt');
  });
}
