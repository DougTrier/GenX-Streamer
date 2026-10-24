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

// Hold the actual bundled startup read: no fixture UI replaces the viewing shell.
const evidenceDirectory = process.env.STARTUP_EVIDENCE_DIR ?? 'artifacts/startup-status/2026-10-15';
async function heldLibrary(
  page: Page,
  library: 'live' | 'genxtra' = 'live',
  saved = false,
  holdPages = false,
) {
  const calls: string[] = [];
  let pageReads = 0;
  const pages = new Map<number, (outcome: 'page' | 'zero' | 'error') => void>();
  const listeners = new Map<string, number>();
  const source = {
    id: 'saved-source',
    name: 'Saved source',
    kind: 'url',
    location: 'https://saved.fixture.invalid/list',
    allowHttp: false,
  };
  const channel = {
    id: 'saved-channel',
    sourceId: source.id,
    name: 'Saved channel',
    category: 'News',
    urls: ['https://saved.fixture.invalid/video.mp4'],
  };
  let release!: (reject?: boolean) => void;
  let reads = 0;
  const preferences = JSON.stringify({
    schemaVersion: 1,
    favorites: [],
    removedChannels: [],
    sources: saved ? [source] : [],
    volume: 0.8,
    muted: false,
    panelWidth: 360,
    contentLibrary: library,
    automaticSourceRefresh: false,
    sourceRefreshCadence: 'off',
    automaticGuideUpdates: false,
    reviewedChannelProviders: [],
    reviewedGuideProviders: [],
  });
  await page.exposeBinding(
    '__startupInvoke',
    async (_binding, command: string, args: Record<string, unknown> = {}) => {
      calls.push(command);
      if (command === 'plugin:event|listen') {
        listeners.set(String(args.event), Number(args.handler));
        return calls.length;
      }
      if (['plugin:event|unlisten', 'cancel_catalog_query', 'cancel_playlist'].includes(command))
        return;
      if (command === 'renderer_recovery_bootstrap')
        return { schemaVersion: 1, recoveredRenderer: false };
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
      if (command === 'read_record_pair') {
        reads++;
        await new Promise<void>((resolve, reject) => {
          release = (fail) =>
            fail ? reject(new Error('private-token https://private.invalid')) : resolve();
        });
        return {
          catalog: saved
            ? JSON.stringify({ schemaVersion: 1, sources: [source], channels: [channel] })
            : null,
          preferences,
          health: null,
          catalogRevision: '0',
          healthRevision: '0',
        };
      }
      if (command === 'retry_storage') return { dataMode: 'application', retryReady: true };
      if (command === 'storage_recovery_status')
        return {
          platform: 'android',
          available: true,
          state: 'failed',
          explicitEnvironment: false,
        };
      if (command === 'device_capabilities') return { isTelevision: true };
      if (command === 'runtime_info') return { platform: 'android', dataMode: 'application' };
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
      if (command === 'list_iptv_accounts') return [];
      // The quiet saved-channel check reads its newest results at start-up.
      if (command === 'read_channel_checks')
        return { schemaVersion: 1, nowMs: Date.now(), checks: [] };
      if (command === 'stop_archive_downloads')
        return { schemaVersion: 1, stopped: true, cleanupPending: false };
      if (command === 'list_archive_downloads')
        return { schemaVersion: 1, revision: '0', entries: [] };
      if (command === 'query_catalog_page') {
        const index = ++pageReads;
        const outcome = holdPages
          ? await new Promise<'page' | 'zero'>((resolve, reject) => {
              pages.set(index, (outcome) =>
                outcome === 'error'
                  ? reject(new Error('controlled query unavailable'))
                  : resolve(outcome),
              );
            })
          : 'page';
        const hasRows = saved && outcome !== 'zero';
        const query = args.query as { requestId: string };
        return {
          schemaVersion: 1,
          requestId: query.requestId,
          catalogRevision: '0',
          viewRevision: '0',
          queryVersion: 'v1-' + 'a'.repeat(64),
          totalCount: hasRows ? 1 : 0,
          startIndex: 0,
          anchorIndex: null,
          rows: hasRows
            ? [
                {
                  id: channel.id,
                  sourceId: source.id,
                  name: channel.name,
                  category: channel.category,
                  favorite: false,
                },
              ]
            : [],
          after: null,
        };
      }
      // Optional post-ready archive browsing is deliberately unavailable; never admit media.
      throw new Error(`controlled-command-unavailable: ${command}`);
    },
  );
  await page.addInitScript(() => {
    let id = 0;
    const callbacks = new Map<number, (payload: unknown) => void>();
    Reflect.set(window, '__startupCallbacks', callbacks);
    Reflect.set(window, 'isTauri', true);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string, args?: unknown) =>
        Reflect.get(window, '__startupInvoke')(command, args),
      transformCallback: (callback: (payload: unknown) => void) => {
        callbacks.set(++id, callback);
        return id;
      },
      unregisterCallback: (callback: number) => {
        callbacks.delete(callback);
      },
    });
    Reflect.set(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  });
  await page.goto('/');
  await expect.poll(() => reads).toBe(1);
  return {
    calls,
    release: (fail = false) => release(fail),
    reads: () => reads,
    pageReads: () => pageReads,
    releasePage: (index: number, outcome: 'page' | 'zero' | 'error' = 'page') => {
      const release = pages.get(index);
      if (!release) throw new Error('No held catalog page.');
      pages.delete(index);
      release(outcome);
    },
    releasePages: () => {
      for (const release of pages.values()) release('page');
      pages.clear();
    },
    close: async () => {
      const handler = listeners.get('native-close-starting');
      if (handler === undefined) throw new Error('The actual close listener was not installed.');
      await page.evaluate((id) => {
        const callbacks = Reflect.get(window, '__startupCallbacks') as Map<
          number,
          (payload: unknown) => void
        >;
        callbacks.get(id)!({
          event: 'native-close-starting',
          id: 1,
          payload: { requestId: 'startup-close-fixture', generation: 1 },
        });
      }, handler);
    },
  };
}

test('storage ready hands off to an unresolved catalog without a false zero or acquisition', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  const fixture = await heldLibrary(page, 'live', true, true);
  try {
    fixture.release();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await expect.poll(() => fixture.pageReads()).toBe(1);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_STARTUP__').state))
      .toBe('completed');
    await expect(page.locator('#channel-count')).toHaveText('Loading channels…');
    await expect(page.locator('#channel-list')).toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#channel-list')).toHaveAttribute('data-catalog-state', 'pending');
    await expect(page.locator('#list-empty')).toHaveText('Loading channels…');
    await expect(page.locator('#channel-list button[data-channel]')).toHaveCount(0);
    expect(
      fixture.calls.filter((command) => /^(start_|inspect_|write_record)/.test(command)),
    ).toEqual([]);
    await page.screenshot({ path: `${evidenceDirectory}/paged-library-pending.png` });
    fixture.releasePage(1);
    await expect(page.locator('#channel-count')).toHaveText('1 channel');
    await expect(page.locator('#channel-list')).toHaveAttribute('aria-busy', 'false');
    await expect(page.locator('#channel-list')).toHaveAttribute('data-catalog-state', 'ready');
    await expect(page.locator('button[data-channel="saved-channel"]')).toBeVisible();
  } finally {
    fixture.release();
    fixture.releasePages();
  }
});

for (const outcome of ['zero', 'error'] as const) {
  test(`accepted ${outcome} catalog outcome is distinct from unresolved startup`, async ({
    page,
  }) => {
    const fixture = await heldLibrary(page, 'live', true, true);
    try {
      fixture.release();
      await expect.poll(() => fixture.pageReads()).toBe(1);
      fixture.releasePage(1, outcome);
      await expect(page.locator('#channel-count')).toHaveText(
        outcome === 'zero' ? '0 channels' : 'Channels unavailable',
      );
      await expect(page.locator('#channel-list')).toHaveAttribute('aria-busy', 'false');
      await expect(page.locator('#channel-list')).toHaveAttribute(
        'data-catalog-state',
        outcome === 'zero' ? 'ready' : 'error',
      );
      if (outcome === 'error')
        await expect(page.locator('#list-empty')).toContainText('could not be loaded');
    } finally {
      fixture.release();
      fixture.releasePages();
    }
  });
}

test('close joins a held first catalog page and its late result cannot publish rows', async ({
  page,
}) => {
  const fixture = await heldLibrary(page, 'live', true, true);
  try {
    fixture.release();
    await expect.poll(() => fixture.pageReads()).toBe(1);
    await fixture.close();
    await expect(page.locator('#channel-list')).toHaveAttribute('data-catalog-state', 'closed');
    fixture.releasePage(1);
    await expect
      .poll(() =>
        page.evaluate(() => Reflect.get(window, '__GENX_CATALOG_QUERY__').originalPending),
      )
      .toBe(0);
    await expect(page.locator('#channel-list button[data-channel]')).toHaveCount(0);
    await expect(page.locator('#channel-count')).not.toHaveText('0 channels');
    await expect(page.locator('#channel-list')).toHaveAttribute('aria-busy', 'false');
  } finally {
    fixture.release();
    fixture.releasePages();
  }
});

test('held saved library shows honest opening status without an empty or ready claim', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  const fixture = await heldLibrary(page);
  try {
    await expect(page.getByRole('status', { name: 'Opening saved library' })).toBeVisible();
    await expect(page.locator('#channel-count')).not.toBeVisible();
    // TV and Windows show the count in the category button: hidden too while opening.
    await expect(page.locator('#category-button .category-count')).not.toBeVisible();
    await expect(page.locator('#list-empty')).not.toBeVisible();
    await expect(page.locator('#playback-status')).not.toBeVisible();
    await expect(page.locator('#overlay-title')).not.toBeVisible();
    const status = page.locator('[data-startup-status]');
    const rect = await status.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(960);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(540);
    await page.screenshot({ path: `${evidenceDirectory}/opening-library-960.png` });
    expect(await page.locator('#app').evaluate((app) => (app as HTMLElement).inert)).toBe(true);
    expect(
      fixture.calls.filter((name) =>
        /write|query_catalog|archive|inspect|scan_checkpoint|start_|fetch/.test(name),
      ),
    ).toEqual([]);
    fixture.release();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await expect(page.getByRole('status', { name: 'Opening saved library' })).toHaveCount(0);
    await expect(page.locator('#channel-count')).toHaveText('0 channels');
    // The count shows once ready: on its own, or in the category button.
    await expect(
      page.locator('#channel-count, #category-button .category-count').locator('visible=true'),
    ).toHaveCount(1);
  } finally {
    fixture.release();
    await test.info().attach('startup-bridge-calls', {
      body: JSON.stringify(fixture.calls),
      contentType: 'application/json',
    });
  }
});

test('compact startup fits and saved channels replace opening only after the checked read', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 568 });
  const fixture = await heldLibrary(page, 'live', true);
  try {
    const status = page.getByRole('status', { name: 'Opening saved library' });
    await expect(status).toBeVisible();
    const rect = await status.boundingBox();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(320);
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(568);
    await page.screenshot({ path: `${evidenceDirectory}/opening-library-320.png` });
    fixture.release();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('.channel')).toHaveCount(1);
    await expect(page.locator('.channel')).toContainText('Saved channel');
    await expect(status).toHaveCount(0);
  } finally {
    fixture.release();
  }
});

test('actual close during a held read cancels readiness and late completion cannot resurrect status', async ({
  page,
}) => {
  const fixture = await heldLibrary(page);
  try {
    await expect(page.locator('[data-startup-status]')).toBeVisible();
    await fixture.close();
    fixture.release();
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, '__GENX_STARTUP__').state))
      .toBe('cancelled');
    await expect(page.locator('#app')).not.toHaveAttribute('data-ready', 'true');
    await expect(page.locator('[data-startup-status]')).toHaveCount(0);
    await expect(page.locator('#channel-count')).not.toBeVisible();
    expect(
      fixture.calls.filter((command) =>
        /^(query_catalog|start_|inspect_|write_record)/.test(command),
      ),
    ).toEqual([]);
  } finally {
    fixture.release();
  }
});

test('failed library stays unavailable and retry opens the saved GenXtra library', async ({
  page,
}) => {
  const fixture = await heldLibrary(page, 'genxtra');
  try {
    fixture.release(true);
    const recovery = page.getByRole('dialog', { name: 'Saved data needs attention' });
    await expect(recovery).toBeVisible();
    await expect(page.locator('#channel-count')).not.toBeVisible();
    await expect(page.locator('#playback-status')).not.toBeVisible();
    await expect(page.locator('[data-startup-status]')).not.toContainText('private-token');
    await recovery.getByRole('button', { name: 'Retry saved data' }).click();
    await expect.poll(() => fixture.reads()).toBe(2);
    await expect(page.locator('#app')).toHaveAttribute('data-startup', 'pending');
    fixture.release();
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await expect(page.locator('#genxtra-button')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('[data-startup-status]')).toHaveCount(0);
    await expect(recovery).toHaveCount(0);
  } finally {
    fixture.release();
    await test.info().attach('startup-bridge-calls', {
      body: JSON.stringify(fixture.calls),
      contentType: 'application/json',
    });
  }
});

for (const stage of ['shell', 'viewport'] as const) {
  test(`early ${stage} failure stays readable and keeps raw errors out of diagnostics`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 854, height: 480 });
    await page.addInitScript((phase) => {
      const original = EventTarget.prototype.addEventListener;
      let used = false;
      EventTarget.prototype.addEventListener = function (...args) {
        const shell =
          this instanceof HTMLElement && this.id === 'event-history-button' && args[0] === 'click';
        const viewport = this === window.visualViewport && args[0] === 'resize';
        if (!used && (phase === 'shell' ? shell : viewport)) {
          used = true;
          throw new Error('private-token https://private.invalid/secret');
        }
        return Reflect.apply(original, this, args);
      };
    }, stage);
    await page.goto('/');
    const dialog = page.getByRole('alertdialog', { name: 'GenX Streamer could not open' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Close and reopen GenX Streamer');
    await expect(dialog).not.toContainText('private-token');
    await expect(dialog.getByRole('button')).toHaveCount(0);
    const observed = await page.evaluate(() => ({
      bootstrap: Reflect.get(window, '__GENX_BOOTSTRAP__'),
      startup: Reflect.get(window, '__GENX_STARTUP__'),
      ready: document.getElementById('app')?.dataset.ready,
      inert: document.getElementById('app')?.inert,
    }));
    expect(observed.bootstrap).toMatchObject({
      phase: 'failed',
      stage,
      reason: 'mount-failed',
      pending: false,
      canRetry: false,
      canClose: false,
    });
    expect(observed.startup).toBeDefined();
    expect(observed.ready).not.toBe('true');
    if (stage === 'viewport') expect(observed.inert).toBe(true);
    expect(JSON.stringify(observed)).not.toContain('private-token');
    const rect = await dialog.boundingBox();
    expect(rect).not.toBeNull();
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.y).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(854);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(480);
  });
}

test('healthy startup distinguishes synchronous mounts from saved data readiness', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('[data-bootstrap-recovery]')).toHaveCount(0);
  const state = await page.evaluate(() => Reflect.get(window, '__GENX_BOOTSTRAP__'));
  expect(state).toMatchObject({ phase: 'mounted', reason: 'none', errorCount: 0, pending: false });
});
