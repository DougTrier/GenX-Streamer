// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { resolve } from 'node:path';
import { fixture, useGuideUiBrowser } from './guide-ui-browser.fixture';
import { readStylesheet } from '../support/stylesheet';
useGuideUiBrowser();
let styles: string, paidBundle: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'paid-guide-native-back',
        resolveId: (id) => (id.endsWith('virtual:paid-back') ? '\0paid-back' : undefined),
        load: (id) =>
          id === '\0paid-back'
            ? `export {mountPaidGuide} from ${JSON.stringify(resolve('src/ui/guide/paid-guide.ts'))}; export {createForegroundController} from ${JSON.stringify(resolve('src/application/shell/foreground-controller.ts'))}; export {installFullscreenPresentation} from ${JSON.stringify(resolve('src/ui/player/fullscreen-presentation.ts'))}; export {createPageController} from ${JSON.stringify(resolve('src/application/shell/page-controller.ts'))}; export {createPageState} from ${JSON.stringify(resolve('src/application/shell/page-state.ts'))};`
            : undefined,
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:paid-back', formats: ['iife'], name: 'PaidPane' },
    },
  });
  const out = Array.isArray(result) ? result[0] : result;
  if (!out || !('output' in out)) throw new Error('Missing Paid Back bundle');
  const chunk = out.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing Paid Back entry');
  paidBundle = chunk.code;
  styles = (
    await Promise.all(
      [
        'style',
        'management',
        'guide',
        'guide-timeline',
        'responsive',
        'modal-viewport',
        'fullscreen',
        'tv-density',
        'account-vod',
        'genxtra',
        'media-results',
        'guide-panel',
      ].map((name) => readStylesheet(`src/ui/${name}.css`)),
    )
  ).join('\n');
});
async function mounted(pageMode = true, initialLoad?: 'configuration' | 'inventory' | 'programme') {
  const page = await fixture(false, true, true);
  await page.addStyleTag({ content: styles });
  await page.evaluate(
    async ({ pageMode, initialLoad }) => {
      await Reflect.get(window, 'guide').dispose();
      const ui = Reflect.get(window, 'GuideUI'),
        app = document.getElementById('guide')!;
      app.id = 'app';
      ui.createShell(app);
      app.dataset.deviceKind = 'tv';
      app.dataset.guidePanel = 'open';
      app.dataset.playerIdle = initialLoad ? 'true' : 'false';
      if (initialLoad) document.documentElement.style.setProperty('--sidebar', '350px');
      document.getElementById('cast-button')!.hidden = true;
      const primary = document.getElementById('primary-view-host')!;
      primary.hidden = false;
      const screen = document.getElementById('screen')!;
      screen.tabIndex = 0;
      screen.setAttribute('role', 'button');
      screen.setAttribute('aria-label', 'Watch full screen');
      const list = document.getElementById('channel-list')!;
      Reflect.set(window, 'underlayTunes', 0);
      list.replaceChildren(
        ...Array.from({ length: 12 }, (_, i) => {
          const b = document.createElement('button');
          b.className = 'channel';
          b.dataset.channel = 'left-' + i;
          b.textContent = 'Left channel ' + i;
          b.addEventListener('click', () =>
            Reflect.set(window, 'underlayTunes', Reflect.get(window, 'underlayTunes') + 1),
          );
          return b;
        }),
      );
      const rows = Array.from({ length: 180 }, (_, i) => ({
        id: 'c' + i,
        sourceId: 'catalog',
        name: 'Guide channel ' + i,
        category: 'Sports',
      }));
      const map = (c: { id: string; sourceId: string }) => ({
        catalogSourceId: c.sourceId,
        appChannelId: c.id,
        guideSourceId: 'guide',
        xmltvChannelId: c.id,
      });
      const programme = (c: { id: string; sourceId: string }, alternate = false) => ({
        ...map(c),
        startMs: 1699999999000,
        stopMs: 1700000100000,
        ordinal: alternate ? 1 : 0,
        title: (alternate ? 'Alternate ' : 'First ') + c.id,
        description: 'Fixture programme',
      });
      const host = Reflect.get(window, 'host');
      host.channels = () => rows;
      host.selectedChannel = () => rows[0];
      host.presentation = pageMode ? 'page' : undefined;
      host.enableTimeline = true;
      host.mappings = async () => rows.map(map);
      let firstRead = true;
      const holdInitialRead = async () => {
        if (!firstRead) return;
        firstRead = false;
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseInitialRead', resolve));
      };
      if (initialLoad) {
        const sources = host.sources;
        if (initialLoad === 'configuration')
          host.sources = async (signal: AbortSignal) => {
            await holdInitialRead();
            return sources(signal);
          };
        host.listedChannels = async () => {
          if (initialLoad === 'inventory') await holdInitialRead();
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: rows.map((c) => ({ ...map(c), sourceRevision: 1 })),
          };
        };
      }
      const query = async (q: { appChannelIds: string[] }) => ({
        programs: q.appChannelIds.flatMap((id) => {
          const c = rows.find((c) => c.id === id)!;
          return [programme(c), programme(c, true)];
        }),
        nextCursor: null,
        sourceRevision: 1,
        databaseRevision: 1,
      });
      host.query = async (q: { appChannelIds: string[] }) => {
        if (initialLoad === 'programme' && q.appChannelIds[0] === 'c0') await holdInitialRead();
        return query(q);
      };
      host.summary = async (q: { appChannelId: string; atMs: number }) => {
        const c = rows.find((c) => c.id === q.appChannelId)!;
        return {
          ...q,
          catalogSourceId: 'catalog',
          catalogRevision: '1',
          databaseRevision: 1,
          mappingStatus: 'mapped',
          mapping: map(c),
          sourceRevision: 1,
          publishedRevision: 1,
          updatedMs: 1700000000000,
          coverage: { startMs: 1699999999000, endMs: 1700000100000 },
          cacheStatus: 'current',
          currentStatus: 'current',
          nextStatus: 'none',
          current: programme(c),
          next: null,
        };
      };
      Reflect.set(window, 'guide', ui.mountGuide(primary, host));
      Reflect.set(
        window,
        'removePaneNavigation',
        ui.installRemoteNavigation({ editMode: ui.createRemoteEditMode() }),
      );
      await Reflect.get(window, 'guide').open();
    },
    { pageMode, initialLoad },
  );
  if (initialLoad)
    await page.waitForFunction(
      () => typeof Reflect.get(window, 'releaseInitialRead') === 'function',
    );
  else await page.locator('.gx-timeline-row').nth(8).waitFor();
  return page;
}
async function close(page: Awaited<ReturnType<typeof mounted>>) {
  await page.evaluate(async () => {
    Reflect.get(window, 'releaseInitialRead')?.();
    await Reflect.get(window, 'guide').dispose();
    Reflect.get(window, 'removePaneNavigation')();
  });
  await page.close();
}
it('real Guide chooser and programme details own DPAD until Back restores the exact originating cell', async () => {
  const page = await mounted();
  try {
    const origin = page.locator('.gx-timeline-row').first().locator('.gx-timeline-cell');
    await origin.focus();
    await page.evaluate(() => Reflect.set(window, 'paneOrigin', document.activeElement));
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Back to timeline', exact: true }).waitFor();
    await page.keyboard.press('ArrowDown');
    expect(
      await page.evaluate(() => document.activeElement?.closest('.gx-timeline-choices') !== null),
    ).toBe(true);
    for (let n = 0; n < 6; n++) {
      await page.keyboard.press('ArrowDown');
      expect(
        await page.evaluate(() => document.activeElement?.closest('.gx-timeline-details') !== null),
      ).toBe(true);
    }
    for (let n = 0; n < 6; n++) await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowDown');
    expect(
      await page.locator('.gx-timeline-viewport').evaluate((node) => (node as HTMLElement).inert),
    ).toBe(true);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Watch current channel', exact: true }).waitFor();
    expect(await page.locator('.gx-timeline-details strong').textContent()).toBe('First c0');
    await page.keyboard.press('ArrowDown');
    expect(
      await page.evaluate(() => document.activeElement?.closest('.gx-timeline-details') !== null),
    ).toBe(true);
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    expect(
      await page.evaluate(() => document.activeElement?.closest('.gx-timeline-details') !== null),
    ).toBe(true);
    await page.keyboard.press('Escape');
    expect(
      await page.evaluate(() => document.activeElement === Reflect.get(window, 'paneOrigin')),
    ).toBe(true);
    expect(
      await page.locator('.gx-timeline-viewport').evaluate((node) => (node as HTMLElement).inert),
    ).toBe(false);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Back to timeline', exact: true }).waitFor();
    await page.evaluate(() =>
      document
        .querySelector('dialog[open]')!
        .dispatchEvent(new Event('cancel', { cancelable: true })),
    );
    expect(
      await page.evaluate(() => document.activeElement === Reflect.get(window, 'paneOrigin')),
    ).toBe(true);
  } finally {
    await close(page);
  }
});
it('page Guide left boundary reaches the preview or channel pane and Right returns to the same row', async () => {
  const page = await mounted();
  try {
    let label = page.locator('.gx-timeline-channel').nth(5);
    await label.focus();
    await page.evaluate(() => Reflect.set(window, 'paneReturn', document.activeElement));
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('screen');
    await page.keyboard.press('ArrowRight');
    expect(
      await page.evaluate(() => document.activeElement === Reflect.get(window, 'paneReturn')),
    ).toBe(true);
    await page.evaluate(() => {
      document.getElementById('app')!.dataset.playerIdle = 'true';
      document.getElementById('screen')!.removeAttribute('role');
      document.getElementById('screen')!.removeAttribute('tabindex');
    });
    await page.locator('.gx-timeline-row').nth(8).waitFor();
    label = page.locator('.gx-timeline-channel').nth(5);
    await label.focus();
    await page.evaluate(() => Reflect.set(window, 'paneReturn', document.activeElement));
    await page.keyboard.press('ArrowLeft');
    expect(
      await page.evaluate(() => document.activeElement?.closest('#channel-list') !== null),
    ).toBe(true);
    await page.keyboard.press('ArrowRight');
    expect(
      await page.evaluate(() => document.activeElement === Reflect.get(window, 'paneReturn')),
    ).toBe(true);
  } finally {
    await close(page);
  }
});
it('a modal Guide keeps its left boundary inside the modal', async () => {
  const page = await mounted(false);
  try {
    const label = page.locator('.gx-timeline-channel').nth(5);
    await label.focus();
    await page.evaluate(() => Reflect.set(window, 'modalRow', document.activeElement));
    await page.keyboard.press('ArrowLeft');
    expect(
      await page.evaluate(() => document.activeElement === Reflect.get(window, 'modalRow')),
    ).toBe(true);
  } finally {
    await close(page);
  }
});
it('a real Guide with180rows reverses through virtual windows back to its absolute first row', async () => {
  const page = await mounted();
  try {
    await page.locator('.gx-timeline-channel').first().focus();
    const focused = () =>
      page.evaluate(
        () =>
          document.activeElement?.querySelector('.media-result-title')?.textContent ??
          document.activeElement?.textContent,
      );
    for (let n = 1; n <= 65; n++) {
      await page.keyboard.press('ArrowDown');
      await expect.poll(focused).toBe('Guide channel ' + n);
    }
    expect(await page.locator('.gx-timeline-row').count()).toBeLessThan(40);
    for (let n = 64; n >= 0; n--) {
      await page.keyboard.press('ArrowUp');
      await expect.poll(focused).toBe('Guide channel ' + n);
    }
    expect(await page.locator('.gx-timeline-viewport').evaluate((node) => node.scrollTop)).toBe(0);
  } finally {
    await close(page);
  }
});

it('native Paid Guide Back closes chooser/details before Guide and restores the exact programme cell', async () => {
  const page = await mounted();
  await page.addScriptTag({ content: paidBundle });
  try {
    await page.evaluate(async () => {
      await Reflect.get(window, 'guide').dispose();
      const host = document.getElementById('primary-view-host')!,
        api = Reflect.get(window, 'PaidPane');
      const id = 'a'.repeat(32),
        now = 1700000000000;
      const account = {
        schemaVersion: 1,
        id,
        name: 'Provider',
        kind: 'xtream',
        serverOrigin: 'https://provider.invalid',
        allowHttp: false,
        revision: '1',
        requiresSignIn: false,
      };
      const channel = {
        id: 'account-' + id + '-' + '1'.repeat(64),
        name: 'Paid sports',
        category: 'Sports',
        epgId: 'paid.sports',
        providerId: '1',
        streamReference: 'b'.repeat(32),
        favorite: false,
      };
      const guide = {
        status: async () => ({ revision: 1, fetchedMs: now, programs: 2, channels: 1, skipped: 0 }),
        refresh: async () => {
          throw new Error('No acquisition expected');
        },
        channels: async () => [channel],
        listed: async () => ({ revision: 1, epgIds: [channel.epgId] }),
        programs: async () => ({
          revision: 1,
          programs: [0, 1].map((n) => ({
            epgId: channel.epgId,
            startMs: now - 1000,
            stopMs: now + 100000,
            ordinal: n,
            title: n ? 'Other paid' : 'First paid',
            description: 'Sport',
            categories: [],
          })),
        }),
      };
      const panel = api.mountPaidGuide(host, {
        guide,
        watch: async () => {},
        close: () => {},
        now: () => now,
        formatTime: (ms: number) => String(ms),
      });
      Reflect.set(window, 'paidPanel', panel);
      Reflect.set(window, 'paidPageTransitions', 0);
      const pageState = { primaryPage: 'guide' };
      api.createForegroundController({
        element: (id: string) => document.getElementById(id),
        fullscreenPresentation: { set() {} },
        updatePreviewControl() {},
        remoteEditMode: { exit: () => false },
        primaryHost: host,
        pageState,
        paidGuide: panel,
        playerView: { liveReplay: null },
        switchPrimaryPage: async () => {
          Reflect.set(
            window,
            'paidPageTransitions',
            Reflect.get(window, 'paidPageTransitions') + 1,
          );
          await panel.hide();
          pageState.primaryPage = 'watch';
        },
        notice: () => {},
        nativeViewingForeground: true,
        applicationClosing: false,
      });
      await panel.show(account);
    });
    const cell = page.locator('.paid-guide .gx-timeline-cell').first();
    await cell.focus();
    await page.evaluate(() => Reflect.set(window, 'paidOrigin', document.activeElement));
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Back to timeline', exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('native-back-requested')));
    expect(await page.evaluate(() => Reflect.get(window, 'paidPanel').open)).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'paidPageTransitions'))).toBe(0);
    expect(
      await page.evaluate(() => document.activeElement === Reflect.get(window, 'paidOrigin')),
    ).toBe(true);
    await page.keyboard.press('Enter');
    await page.locator('.gx-timeline-choices button').first().click();
    await page.getByRole('button', { name: 'Back to timeline', exact: true }).waitFor();
    await page.evaluate(() => window.dispatchEvent(new Event('native-back-requested')));
    expect(await page.evaluate(() => Reflect.get(window, 'paidPanel').open)).toBe(true);
    expect(
      await page.evaluate(() => document.activeElement === Reflect.get(window, 'paidOrigin')),
    ).toBe(true);
    const paidLabel = page.locator('.paid-guide .gx-timeline-channel').first();
    await paidLabel.focus();
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('screen');
    await page.keyboard.press('ArrowRight');
    expect(await paidLabel.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.evaluate(() => window.dispatchEvent(new Event('native-back-requested')));
    await page.waitForFunction(
      () =>
        Reflect.get(window, 'paidPageTransitions') === 1 && !Reflect.get(window, 'paidPanel').open,
    );
  } finally {
    await page.evaluate(() => Reflect.get(window, 'paidPanel')?.dispose());
    await close(page);
  }
});

it('native Back from the Guide preview fullscreen restores its preview control before Right returns to the remembered row', async () => {
  const page = await mounted();
  await page.addScriptTag({ content: paidBundle });
  try {
    const row = page.locator('.gx-timeline-channel').nth(4);
    await row.focus();
    await page.keyboard.press('ArrowLeft');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('screen');
    await page.evaluate(() => {
      const api = Reflect.get(window, 'PaidPane'),
        app = document.getElementById('app')!,
        element = (id: string) => document.getElementById(id);
      const pageState = { primaryPage: 'guide' };
      const pageOwner = api.createPageController({
        element,
        pageState,
        library: { contentLibrary: 'live' },
        applicationClosing: false,
      });
      const presentation = api.installFullscreenPresentation(app);
      Reflect.set(window, 'previewFullscreenPresentation', presentation);
      Reflect.set(document.querySelector('.workspace')!, 'requestFullscreen', async () => {});
      api.createForegroundController({
        element,
        fullscreenPresentation: presentation,
        updatePreviewControl: pageOwner.updatePreviewControl,
        remoteEditMode: { exit: () => false },
        primaryHost: element('primary-view-host'),
        pageState,
        paidGuide: { open: false, closeDetails: () => false },
        playerView: { liveReplay: null },
        notice: () => {},
        nativeViewingForeground: true,
        applicationClosing: false,
      });
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() =>
      document.getElementById('app')!.classList.contains('viewing-fullscreen'),
    );
    await page.evaluate(() => window.dispatchEvent(new Event('native-back-requested')));
    await page.waitForFunction(
      () => !document.getElementById('app')!.classList.contains('viewing-fullscreen'),
    );
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('screen');
    await page.keyboard.press('ArrowRight');
    expect(await row.evaluate((node) => node === document.activeElement)).toBe(true);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'previewFullscreenPresentation')?.dispose());
    await close(page);
  }
});

it('a delayed programme Watch retains pane focus while busy and completion cannot steal a later user move', async () => {
  const page = await mounted();
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host'),
        original = host.summary;
      let calls = 0;
      host.summary = async (query: unknown, signal: AbortSignal) => {
        if (++calls === 2)
          await new Promise<void>((resolve) => Reflect.set(window, 'releaseBusySummary', resolve));
        return original(query, signal);
      };
    });
    await page.locator('.gx-timeline-cell').first().click();
    await page.locator('.gx-timeline-choices button').first().click();
    const watch = page.getByRole('button', { name: 'Watch current channel', exact: true });
    await watch.waitFor();
    await watch.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(
      () => typeof Reflect.get(window, 'releaseBusySummary') === 'function',
    );
    expect(await watch.isDisabled()).toBe(true);
    expect(
      await page
        .getByRole('button', { name: 'Back to timeline', exact: true })
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('ArrowDown');
    expect(
      await page.evaluate(() => document.activeElement?.closest('.gx-timeline-details') !== null),
    ).toBe(true);
    await page.locator('#settings-button').focus();
    await page.evaluate(() => Reflect.get(window, 'releaseBusySummary')());
    await page.waitForFunction(() => Reflect.get(window, 'calls').watch.length === 1);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('settings-button');
  } finally {
    await page.evaluate(() => Reflect.get(window, 'releaseBusySummary')?.());
    await close(page);
  }
});

it('real Paid Guide entry and manual Update keep stable Close focus during held downloads without late focus steals', async () => {
  const page = await mounted();
  await page.addScriptTag({ content: paidBundle });
  try {
    await page.evaluate(async () => {
      await Reflect.get(window, 'guide').dispose();
      const app = document.getElementById('app')!;
      app.dataset.guidePanel = 'closed';
      const api = Reflect.get(window, 'PaidPane'),
        element = (id: string) => document.getElementById(id),
        now = 1700000000000,
        id = 'a'.repeat(32);
      const account = {
        schemaVersion: 1,
        id,
        name: 'Provider',
        kind: 'xtream',
        serverOrigin: 'https://provider.invalid',
        allowHttp: false,
        revision: '1',
        requiresSignIn: false,
      };
      let cached: unknown = null;
      Reflect.set(window, 'paidEntryDownloads', 0);
      const channel = {
        id: 'account-' + id + '-' + '1'.repeat(64),
        name: 'Paid sport',
        category: 'Sports',
        epgId: 'paid.sport',
        providerId: '1',
        streamReference: 'b'.repeat(32),
        favorite: false,
      };
      const native = {
        status: async () => cached,
        refresh: async () => {
          Reflect.set(window, 'paidEntryDownloads', Reflect.get(window, 'paidEntryDownloads') + 1);
          await new Promise<void>((resolve) => Reflect.set(window, 'releasePaidEntry', resolve));
          cached = { revision: 1, fetchedMs: now, programs: 1, channels: 1, skipped: 0 };
          return cached;
        },
        channels: async () => [channel],
        listed: async () => ({ revision: 1, epgIds: [channel.epgId] }),
        programs: async () => ({
          revision: 1,
          programs: [
            {
              epgId: channel.epgId,
              startMs: now - 1000,
              stopMs: now + 100000,
              ordinal: 0,
              title: 'Paid match',
              description: 'Sport',
              categories: [],
            },
          ],
        }),
      };
      const panel = api.mountPaidGuide(element('primary-view-host'), {
        guide: native,
        watch: async () => {},
        close: () => {},
        now: () => now,
        formatTime: (ms: number) => String(ms),
      });
      Reflect.set(window, 'paidPanel', panel);
      const owner = api.createPageController({
        element,
        pageState: api.createPageState(),
        library: { contentLibrary: 'live' },
        applicationClosing: false,
        guide: { close: async () => {} },
        paidGuide: panel,
        archiveDiscovery: { suspend: async () => {} },
        nativeViewingForeground: true,
        accountBrowser: { selectedAccount: account },
        libraryQueries: { live: '', genxtra: '' },
      });
      await owner.switchPrimaryPage('guide');
    });
    await page.waitForFunction(() => Reflect.get(window, 'paidEntryDownloads') === 1);
    const exit = page.getByRole('button', { name: 'Close guide', exact: true }),
      update = page.getByRole('button', { name: 'Update guide', exact: true });
    expect(await update.isDisabled()).toBe(true);
    expect(await exit.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.evaluate(() => Reflect.get(window, 'releasePaidEntry')());
    await page.locator('.paid-guide .gx-timeline-cell').waitFor();
    await update.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => Reflect.get(window, 'paidEntryDownloads') === 2);
    expect(await exit.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.locator('#settings-button').focus();
    await page.evaluate(() => Reflect.get(window, 'releasePaidEntry')());
    await page.waitForFunction(
      () => !document.querySelector<HTMLButtonElement>('.paid-guide-head button')!.disabled,
    );
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('settings-button');
  } finally {
    await page.evaluate(() => {
      Reflect.get(window, 'releasePaidEntry')?.();
      return Reflect.get(window, 'paidPanel')?.dispose();
    });
    await close(page);
  }
});

it.each(['configuration', 'inventory', 'programme'] as const)(
  'toolbar Down/OK owns the Guide during held first %s loading without tuning an underlying channel',
  async (stage) => {
    const page = await mounted(true, stage);
    try {
      await page.getByRole('button', { name: 'All channels', exact: true }).focus();
      for (let n = 0; n < 6; n++) await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => Reflect.get(window, 'underlayTunes'))).toBe(0);
      expect(
        await page.evaluate(() => document.activeElement?.closest('.gx-timeline') !== null),
      ).toBe(true);
      if (stage !== 'programme') {
        expect(await page.locator('.gx-timeline-row').count()).toBe(0);
        expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
        expect(
          await page
            .locator('.gx-timeline-viewport')
            .evaluate((node) => node === document.activeElement),
        ).toBe(true);
      }
      await page.evaluate(() => Reflect.get(window, 'releaseInitialRead')());
      await page.locator('.gx-timeline-row').nth(8).waitFor();
      await page.keyboard.press('ArrowDown');
      expect(
        await page.evaluate(() => document.activeElement?.closest('.gx-timeline-row') !== null),
      ).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'underlayTunes'))).toBe(0);
    } finally {
      await close(page);
    }
  },
);

it('toolbar entry chooses a visible deep-window row and scrolls only a partially clipped label', async () => {
  const page = await mounted();
  try {
    for (const fraction of [0, 0.5]) {
      const before = await page.locator('.gx-timeline-viewport').evaluate((node, fraction) => {
        const pitch = parseFloat(
          getComputedStyle(node.closest('.gx-timeline')!).getPropertyValue('--gx-row-height'),
        );
        node.scrollTop = (35 + fraction) * pitch;
        return { scroll: node.scrollTop, pitch };
      }, fraction);
      await page.waitForFunction(() =>
        document
          .querySelector<HTMLElement>('.gx-timeline-row')
          ?.dataset.channelKey?.includes('c27'),
      );
      await page.getByRole('button', { name: 'All channels', exact: true }).focus();
      await page.keyboard.press('ArrowDown');
      const after = await page.evaluate(() => {
        const focused = document.activeElement as HTMLElement,
          viewport = document.querySelector<HTMLElement>('.gx-timeline-viewport')!,
          box = focused.getBoundingClientRect(),
          clip = viewport.getBoundingClientRect();
        return {
          label: focused.getAttribute('aria-label'),
          visible: box.top >= clip.top && box.bottom <= clip.bottom,
          scroll: viewport.scrollTop,
        };
      });
      expect(after.label).toBe('Guide channel 35');
      expect(after.visible).toBe(true);
      if (fraction === 0) expect(after.scroll).toBe(before.scroll);
      else expect(Math.abs(after.scroll - before.scroll)).toBeLessThanOrEqual(before.pitch);
    }
  } finally {
    await close(page);
  }
});
