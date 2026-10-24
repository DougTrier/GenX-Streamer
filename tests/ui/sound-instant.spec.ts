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

// Actual bundled main with a controlled native bridge whose preference writes
// are held: Mute and volume must be heard before the save finishes (the S25 took
// 4.4 s to save), and a failed save must restore the saved sound. Wiring proof,
// not native storage proof.
async function fixture(page: Page) {
  const source = {
    id: 'sound-source',
    name: 'Sound fixture',
    kind: 'url',
    location: 'https://sound.fixture.invalid/catalog',
    allowHttp: false,
  };
  const channels = [
    {
      id: 'a',
      sourceId: source.id,
      name: 'Sound A',
      category: 'Fixture',
      urls: ['https://stream.sound.invalid/a.mp4'],
    },
  ];
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
  const writes: { contents: string; settle: (ok: boolean) => void }[] = [];
  await page.exposeBinding(
    '__soundInvoke',
    async (_binding, command: string, args: Record<string, unknown> = {}) => {
      if (command === 'plugin:event|listen') return 1;
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
        const contents = String(args.contents);
        const ok = await new Promise<boolean>((settle) => writes.push({ contents, settle }));
        if (!ok) throw new Error('storage-write-failed');
        preferences = contents;
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
      if (command === 'list_iptv_accounts') return [];
      if (command === 'list_archive_downloads')
        return { schemaVersion: 1, revision: '1', entries: [] };
      if (command === 'guide_sources' || command === 'guide_mappings') return [];
      throw new Error('controlled-optional-command-unavailable');
    },
  );
  await page.addInitScript(() => {
    let id = 0;
    Reflect.set(window, 'isTauri', true);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string, args?: unknown) =>
        Reflect.get(window, '__soundInvoke')(command, args),
      transformCallback: () => ++id,
      unregisterCallback: () => {},
    });
    Reflect.set(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  return {
    pendingWrites: () => writes.filter((write) => write).length,
    settleNext: (ok: boolean) => {
      const next = writes.shift();
      if (!next) throw new Error('No held write');
      next.settle(ok);
      return JSON.parse(next.contents) as { muted: boolean; volume: number };
    },
  };
}

test('Mute is heard at once while the save is still running, and a failed save restores it', async ({
  page,
}) => {
  const f = await fixture(page);
  const mute = page.locator('#mute-button');
  // The pressed state the player was given (nothing plays in this fixture, so
  // the video element itself is untouched; the device check covers audio).
  const muted = () => mute.getAttribute('aria-pressed').then((value) => value === 'true');
  await expect(mute).toHaveText('Mute');
  expect(await muted()).toBe(false);

  // Muted before the held save finishes.
  await mute.click();
  await expect(mute).toHaveText('Unmute');
  expect(await muted()).toBe(true);
  await expect.poll(() => f.pendingWrites()).toBe(1);
  expect(f.settleNext(true).muted).toBe(true);
  await expect(mute).toHaveText('Unmute');
  expect(await muted()).toBe(true);

  // Two quick presses: no flicker back to the first while the second saves.
  await mute.click();
  await mute.click();
  await expect(mute).toHaveText('Unmute');
  await expect.poll(() => f.pendingWrites()).toBeGreaterThan(0);
  f.settleNext(true);
  await expect(mute).toHaveText('Unmute');
  expect(await muted()).toBe(true);
  await expect.poll(() => f.pendingWrites()).toBeGreaterThan(0);
  f.settleNext(true);
  await expect(mute).toHaveText('Unmute');

  // A failed save puts the saved sound back and says so.
  await mute.click();
  await expect(mute).toHaveText('Mute');
  expect(await muted()).toBe(false);
  await expect.poll(() => f.pendingWrites()).toBe(1);
  f.settleNext(false);
  await expect(mute).toHaveText('Unmute');
  expect(await muted()).toBe(true);
  await expect(page.getByText(/Changes weren’t saved/)).toBeVisible();
});
