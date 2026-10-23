import { readFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';

// Actual main, ArchivePlayer, PlaybackController and browser engine. The native
// bridge is controlled; only the engine's next media-element seek is held.
async function fixture(page: Page) {
  const body = await readFile('tests/fixtures/media/protocol/ranges.mp4');
  const calls: string[] = [];
  let preferences = JSON.stringify({
    schemaVersion: 1,
    favorites: [],
    removedChannels: [],
    volume: 0.8,
    muted: true,
    panelWidth: 360,
    sources: [],
    automaticSourceRefresh: false,
    sourceRefreshCadence: 'off',
    automaticGuideUpdates: false,
    reviewedChannelProviders: [],
    reviewedGuideProviders: [],
  });
  const saved = {
    downloadRef: '1'.repeat(64),
    fileRef: '2'.repeat(64),
    titleRef: '3'.repeat(64),
    title: 'Saved finite fixture',
    fileTitle: 'Controlled video',
    fileName: 'fixture.mp4',
    sizeBytes: String(body.length),
    completedMs: 1,
    integrity: 'size-verified',
    available: true,
  };
  await page.exposeBinding('__seekFixtureInvoke', async (_binding, command: string, args = {}) => {
    const values = args as Record<string, unknown>;
    calls.push(command);
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
        requestedActive: values.active,
        foreground: true,
        platform: 'android',
        windowKeepScreenOn: values.active,
        webViewKeepScreenOn: values.active,
        decorKeepScreenOn: values.active,
      };
    if (command === 'read_record_pair')
      return {
        catalog: JSON.stringify({ schemaVersion: 1, sources: [], channels: [] }),
        preferences,
        health: null,
        catalogRevision: '1',
        healthRevision: '0',
      };
    if (command === 'read_record') return preferences;
    if (command === 'write_record_receipt') {
      preferences = String(values.contents);
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
      const query = values.query as { requestId: string; startIndex?: number };
      return {
        schemaVersion: 1,
        requestId: query.requestId,
        catalogRevision: '1',
        viewRevision: '1',
        queryVersion: 'v1-' + 'a'.repeat(64),
        totalCount: 0,
        startIndex: query.startIndex ?? 0,
        anchorIndex: null,
        rows: [],
        after: null,
      };
    }
    if (command === 'list_archive_downloads')
      return { schemaVersion: 1, revision: '1', entries: [saved] };
    if (command === 'stop_archive_downloads')
      return { schemaVersion: 1, stopped: true, cleanupPending: false };
    if (command === 'start_archive_download_playback')
      return {
        kind: 'started',
        schemaVersion: 1,
        sessionGeneration: '1',
        mediaUrl: `http://127.0.0.1:1234/archive/${'c'.repeat(64)}/${'d'.repeat(64)}.mp4`,
        leaseMs: 60000,
        cleanupPending: false,
      };
    if (command === 'stop_archive_playback')
      return {
        schemaVersion: 1,
        sessionGeneration: (values.request as { sessionGeneration: string }).sessionGeneration,
        stopped: true,
        cleanupPending: false,
      };
    if (command === 'read_archive_bookmark')
      return {
        schemaVersion: 1,
        sessionGeneration: (values.request as { sessionGeneration: string }).sessionGeneration,
        supported: false,
        revision: '0',
        position: null,
      };
    if (['list_iptv_accounts', 'guide_sources', 'guide_mappings'].includes(command)) return [];
    throw new Error('controlled-optional-command-unavailable');
  });
  await page.addInitScript(() => {
    let id = 0;
    Reflect.set(window, 'isTauri', true);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string, args?: unknown) =>
        Reflect.get(window, '__seekFixtureInvoke')(command, args),
      transformCallback: () => ++id,
      unregisterCallback: () => {},
    });
    Reflect.set(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { unregisterListener: () => {} });
  });
  await page.route('http://127.0.0.1:1234/archive/**', async (route) => {
    const match = /^bytes=(\d+)-(\d*)$/u.exec(route.request().headers().range ?? '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), body.length - 1) : body.length - 1;
    await route.fulfill({
      status: match ? 206 : 200,
      headers: {
        'content-type': 'video/mp4',
        'accept-ranges': 'bytes',
        'access-control-allow-origin': '*',
        ...(match ? { 'content-range': `bytes ${start}-${end}/${body.length}` } : {}),
      },
      body: body.subarray(start, end + 1),
    });
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#genxtra-button').click();
  await page.getByLabel('Saved on this device · 1', { exact: true }).click();
  await page.getByRole('button', { name: 'Play saved', exact: true }).click();
  await expect(page.locator('#playback-status')).toHaveText('Playing', { timeout: 15000 });
  await expect
    .poll(() => page.locator('video').evaluate((video) => (video as HTMLVideoElement).currentTime))
    .toBeGreaterThan(1);
  await page.locator('#pause-button').click();
  await expect(page.locator('#playback-status')).toHaveText('Paused');
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('#app')!.dataset.deviceKind = 'tv';
    const video = document.querySelector('video')!;
    const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'currentTime')!;
    const state = {
      assignments: [] as number[],
      pending: null as number | null,
      released: false,
      seeked: 0,
      clicks: [] as string[],
    };
    const seeked = () => state.seeked++;
    video.addEventListener('seeked', seeked);
    const buttons = ['vod-rewind', 'vod-forward'].map(
      (id) => document.getElementById(id) as HTMLButtonElement,
    );
    const clicked = (event: Event) => state.clicks.push((event.currentTarget as HTMLElement).id);
    for (const button of buttons) button.addEventListener('click', clicked);
    Object.defineProperty(video, 'currentTime', {
      configurable: true,
      get: () => descriptor.get!.call(video),
      set: (target: number) => {
        state.assignments.push(target);
        if (state.released) {
          descriptor.set!.call(video, target);
          return;
        }
        if (state.pending !== null) throw new Error('A second seek reached the media element.');
        state.pending = target;
      },
    });
    Reflect.set(window, 'heldMediaSeek', {
      state,
      release() {
        if (state.pending === null) return;
        const target = state.pending;
        state.pending = null;
        state.released = true;
        // Cancellation may already have retired the real engine/attachment.
        if (video.getAttribute('src')) descriptor.set!.call(video, target);
      },
      dispose() {
        delete (video as unknown as Record<string, unknown>).currentTime;
        video.removeEventListener('seeked', seeked);
        for (const button of buttons) button.removeEventListener('click', clicked);
      },
    });
  });
  return {
    async close() {
      await page.evaluate(() => {
        Reflect.get(window, 'heldMediaSeek')?.release();
        window.dispatchEvent(new Event('native-app-background'));
      });
      await expect
        .poll(() =>
          page.evaluate(
            () => Reflect.get(window, '__GENX_PLAYBACK_OWNERS__').counts.browserEngines,
          ),
        )
        .toBe(0);
      await page.evaluate(() => Reflect.get(window, 'heldMediaSeek')?.dispose());
      await test.info().attach('controlled-native-calls', {
        body: Buffer.from(JSON.stringify(calls)),
        contentType: 'application/json',
      });
      await page.unrouteAll({ behavior: 'wait' });
    },
  };
}

test('actual main pending seek retains local navigation, rejects repeat admission and never steals later focus', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await page.locator('#vod-rewind').focus();
    await page.keyboard.down('Enter');
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'heldMediaSeek').state.assignments))
      .toEqual([0]);
    await expect(page.locator('#vod-rewind')).toBeDisabled();
    await expect(page.locator('#vod-forward')).toBeDisabled();
    await expect(page.locator('#pause-button')).toBeFocused();
    expect(
      await page.evaluate(
        () => Reflect.get(window, '__GENX_PLAYBACK_OWNERS__').counts.initializationWaits,
      ),
    ).toBe(1);
    await page.keyboard.down('Enter');
    await page.keyboard.up('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'heldMediaSeek').state.clicks)).toEqual([
      'vod-rewind',
    ]);
    expect(
      await page.evaluate(() => Reflect.get(window, 'heldMediaSeek').state.assignments),
    ).toEqual([0]);
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.gx-archive-filter-toggle')).toBeFocused();
    expect(await page.evaluate(() => Reflect.get(window, 'heldMediaSeek').state.released)).toBe(
      false,
    );
    await page.evaluate(() => Reflect.get(window, 'heldMediaSeek').release());
    await expect(page.locator('#vod-forward')).toBeEnabled();
    expect(await page.evaluate(() => Reflect.get(window, 'heldMediaSeek').state.seeked)).toBe(1);
    expect(
      await page.evaluate(
        () => Reflect.get(window, '__GENX_PLAYBACK_OWNERS__').counts.initializationWaits,
      ),
    ).toBe(0);
    await expect(page.locator('.gx-archive-filter-toggle')).toBeFocused();
    await expect(page.locator('#playback-status')).toHaveText('Paused');
    expect(
      await page.evaluate(() => Reflect.get(window, 'heldMediaSeek').state.assignments),
    ).toEqual([0]);
    expect(await page.evaluate(() => Reflect.get(window, 'heldMediaSeek').state.clicks)).toEqual([
      'vod-rewind',
    ]);
  } finally {
    await f.close();
  }
});

for (const destination of ['modal', 'personal editor'] as const) {
  test(`actual main held seek completion preserves later ${destination} focus`, async ({
    page,
  }) => {
    const f = await fixture(page);
    try {
      await page.locator('#vod-rewind').focus();
      await page.keyboard.press('Enter');
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'heldMediaSeek').state.assignments))
        .toEqual([0]);
      await expect(page.locator('#vod-forward')).toBeDisabled();
      const target =
        destination === 'modal'
          ? page.locator('#settings-dialog [data-close="settings-dialog"]')
          : page.locator('#search');
      if (destination === 'modal') {
        await page.locator('#settings-button').click();
        await target.focus();
      } else {
        await page.evaluate(() => {
          document.querySelector<HTMLElement>('#app')!.dataset.deviceKind = 'desktop';
        });
        await target.click();
        await page.keyboard.type('Personal query');
        await expect(target).not.toHaveAttribute('readonly');
      }
      await page.evaluate(() => Reflect.get(window, 'heldMediaSeek').release());
      await expect(page.locator('#vod-forward')).toBeEnabled();
      await expect(target).toBeFocused();
      if (destination === 'personal editor') {
        await expect(target).toHaveValue('Personal query');
        await expect(target).not.toHaveAttribute('readonly');
      }
      await expect(page.locator('#playback-status')).toHaveText('Paused');
    } finally {
      await f.close();
    }
  });
}

test('actual main background joins the original held seek without returning viewing focus', async ({
  page,
}) => {
  const f = await fixture(page);
  try {
    await page.locator('#vod-rewind').focus();
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'heldMediaSeek').state.assignments))
      .toEqual([0]);
    await page.locator('#search').click();
    await page.evaluate(() => window.dispatchEvent(new Event('native-app-background')));
    await expect
      .poll(() =>
        page.evaluate(() => Reflect.get(window, '__GENX_PLAYBACK_OWNERS__').counts.browserEngines),
      )
      .toBe(0);
    expect(
      await page.evaluate(
        () => Reflect.get(window, '__GENX_PLAYBACK_OWNERS__').counts.initializationWaits,
      ),
    ).toBe(0);
    await expect(page.locator('#vod-transport')).toBeHidden();
    expect(
      await page.evaluate(() =>
        Boolean(document.activeElement?.closest('#vod-transport,.controls')),
      ),
    ).toBe(false);
    expect(
      await page.evaluate(() => Reflect.get(window, 'heldMediaSeek').state.assignments),
    ).toEqual([0]);
  } finally {
    await f.close();
  }
});
