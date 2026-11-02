// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { fixture, useGuideUiBrowser } from './guide-ui-browser.fixture';
import { readStylesheet } from '../support/stylesheet';
useGuideUiBrowser();
let bundle: string, styles: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'guide-watch-policy',
        enforce: 'pre',
        resolveId(id) {
          if (id.endsWith('virtual:guide-watch-policy')) return '\0guide-watch-policy';
          if (
            id.replaceAll('\\', '/').endsWith('/platform/account-guide') ||
            id.replaceAll('\\', '/').endsWith('/platform/account-guide.ts')
          )
            return '\0paid-native';
        },
        load(id) {
          if (id === '\0paid-native')
            return 'export const createAccountGuide=()=>window.paidNative;';
          if (id === '\0guide-watch-policy')
            return `export {createGuideViews} from ${JSON.stringify(resolve('src/application/guide/guide-views.ts'))}; export {createPageController} from ${JSON.stringify(resolve('src/application/shell/page-controller.ts'))}; export {createPageState} from ${JSON.stringify(resolve('src/application/shell/page-state.ts'))}; export {mountStreamBufferControls} from ${JSON.stringify(resolve('src/ui/player/stream-buffer-controls.ts'))};`;
        },
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:guide-watch-policy', formats: ['iife'], name: 'GuideWatchPolicy' },
    },
  });
  const out = Array.isArray(result) ? result[0] : result;
  if (!out || !('output' in out)) throw new Error('Missing Guide Watch bundle');
  const chunk = out.output.find((item) => item.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing Guide Watch entry');
  expect(chunk.code).toContain('window.paidNative');
  bundle = chunk.code;
  const main = await readFile('src/main.ts', 'utf8');
  const sheets = [...main.matchAll(/^import '(\.\/ui\/[^']+\.css)';/gm)];
  expect(sheets.length).toBeGreaterThan(10);
  const moduleCss = out.output
    .flatMap((item) =>
      item.type === 'asset' && item.fileName.endsWith('.css') ? [String(item.source)] : [],
    )
    .join('\n');
  styles =
    moduleCss +
    '\n' +
    (await Promise.all(sheets.map((match) => readStylesheet(resolve('src', match[1]))))).join('\n');
});
async function mounted(
  compact: boolean,
  paid: boolean,
  held = false,
  options: { idle?: boolean; rich?: boolean; width?: number } = {},
) {
  const page = await fixture(false, true, true);
  await page.evaluate(() => Reflect.get(window, 'guide').dispose());
  await page.setContent('<!doctype html><main id="guide"></main>');
  await page.setViewportSize(
    compact ? { width: options.width ?? 833, height: 397 } : { width: 1280, height: 720 },
  );
  await page.addStyleTag({ content: styles });
  await page.addScriptTag({ content: bundle });
  const font = (
    await readFile('assets/fonts/roboto-condensed/RobotoCondensed-Variable.ttf')
  ).toString('base64');
  await page.evaluate(async (font) => {
    const face = new FontFace('GenX UI', `url(data:font/ttf;base64,${font})`, {
      weight: '100 900',
    });
    document.fonts.add(await face.load());
    await document.fonts.ready;
  }, font);
  await page.evaluate(
    async ({ compact, paid, held, options }) => {
      await Reflect.get(window, 'guide').dispose();
      const ui = Reflect.get(window, 'GuideUI'),
        api = Reflect.get(window, 'GuideWatchPolicy'),
        app = document.getElementById('guide')!;
      app.id = 'app';
      ui.createShell(app);
      app.dataset.deviceKind = compact ? 'personal' : 'tv';
      if (compact) app.classList.add('compact-content');
      app.dataset.compactView = 'channels';
      app.dataset.playerIdle = options.idle ? 'true' : 'false';
      document.getElementById('player-overlay')!.hidden = !options.idle;
      document.getElementById('cast-button')!.hidden = true;
      const now = 1700000000000,
        id = 'a'.repeat(32),
        account = {
          schemaVersion: 1,
          id,
          name: 'Provider',
          kind: 'xtream',
          serverOrigin: 'https://provider.invalid',
          allowHttp: false,
          revision: '1',
          requiresSignIn: false,
        };
      const row = {
        id: 'account-' + id + '-' + '1'.repeat(64),
        name: 'Paid sport',
        category: 'Sports',
        epgId: 'paid.sport',
        providerId: '1',
        streamReference: 'b'.repeat(32),
        favorite: false,
      };
      Reflect.set(window, 'paidNative', {
        status: async () => ({ revision: 1, fetchedMs: now, programs: 1, channels: 1, skipped: 0 }),
        channels: async () => [row],
        listed: async () => ({ revision: 1, epgIds: [row.epgId] }),
        programs: async () => ({
          revision: 1,
          programs: [
            {
              epgId: row.epgId,
              startMs: now - 1000,
              stopMs: now + 100000,
              ordinal: 0,
              title: 'Paid match',
              description: 'Sport',
              categories: [],
            },
          ],
        }),
      });
      const bufferControls = api.mountStreamBufferControls(app, {
        current: () => ({
          selection:
            options.idle && !Reflect.get(window, 'watchCompleted')
              ? null
              : {
                  id: 'free-fixture',
                  name: 'Controlled public channel',
                  url: 'https://fixture.invalid/public.m3u8',
                },
          state: 'playing',
          generation: 1,
          telemetry: {
            capability: 'controlled',
            mode: 'manual',
            targetSeconds: 4,
            bufferedSeconds: 8,
            incomingBitsPerSecond: 1500000,
          },
        }),
        key: async () => null,
        save: async () => {},
        apply: async () => false,
        notice: () => {},
      });
      const element = (id: string) => document.getElementById(id),
        pageState = api.createPageState();
      const library = { contentLibrary: 'live', archiveStorageEpoch: 0 },
        accountBrowser = {
          selectedAccount: paid ? account : null,
          preferenceScope: () => ({ accountId: id, accountRevision: '1', mediaRevision: '1' }),
        };
      const watched = async () => {
        Reflect.set(window, 'watchStarted', true);
        if (held)
          await new Promise<void>((resolve) => Reflect.set(window, 'releaseWatch', resolve));
        app.dataset.playerIdle = 'false';
        document.getElementById('player-overlay')!.hidden = true;
        (element('pause-button') as HTMLButtonElement).disabled = false;
        const preview = element('screen')!.getBoundingClientRect();
        Reflect.set(window, 'previewBeforeWatchReturn', [
          preview.x,
          preview.y,
          preview.width,
          preview.height,
        ]);
        Reflect.set(window, 'watchCompleted', true);
        bufferControls.render();
      };
      const host = Reflect.get(window, 'host');
      host.watch = watched;
      if (options.rich) {
        const saved = Array.from({ length: 31 }, (_, i) => ({
          id: 'sports-' + i,
          sourceId: 'catalog',
          name: i ? 'Sports station ' + i : 'ACC Digital Network (1080p)',
          category: 'Sports',
        }));
        const mapping = (c: (typeof saved)[number]) => ({
          catalogSourceId: c.sourceId,
          appChannelId: c.id,
          guideSourceId: 'guide',
          xmltvChannelId: 'xml-' + c.id,
        });
        host.channels = () => saved;
        host.selectedChannel = () => saved[0];
        host.mappings = async () => saved.map(mapping);
        host.listedChannels = async () => ({
          catalogRevision: '1',
          databaseRevision: 1,
          viewRevision: '1',
          groupingPolicy: 'exact-ordered-endpoints-policy-v2',
          channels: saved.map((c) => ({ ...mapping(c), sourceRevision: 1, filterMask: 4 })),
        });
        host.query = async (q: { appChannelIds: string[] }) => ({
          programs: saved
            .filter((c) => q.appChannelIds.includes(c.id))
            .map((c) => ({
              ...mapping(c),
              title: 'Detroit Lions vs. Chicago Bears Football Replay',
              description: 'Controlled cached programme',
              categories: [{ text: 'NFL' }],
              startMs: now - 1000,
              stopMs: now + 7200000,
              ordinal: 0,
            })),
          nextCursor: null,
          sourceRevision: 1,
          databaseRevision: 1,
        });
      }
      const jobs: Promise<unknown>[] = [];
      const views = api.createGuideViews({
        element,
        pageState,
        library,
        accountBrowser,
        applicationClosing: false,
        nativeViewingForeground: true,
        browser: {
          getGeographyFilter: () => ({}),
          getBrowseState: () => ({ filter: 'all', query: '' }),
          getSportsScope: () => undefined,
          refreshProgrammeMembership: () => {},
        },
        persistedCatalogRevision: '1',
        primaryHost: element('primary-view-host'),
        guideHost: host,
        guideController: {},
        automaticGuides: {},
        wakeDailyRefresh: () => {},
        selectAccountPlayback: watched,
        playbackAction: (work: Promise<unknown>) => jobs.push(work),
        switchPrimaryPage: (page: string) => controller.switchPrimaryPage(page),
        presentPrimaryPage: (page: string) => controller.presentPrimaryPage(page),
      });
      const controller = api.createPageController({
        element,
        pageState,
        library,
        accountBrowser,
        applicationClosing: false,
        nativeViewingForeground: true,
        guide: views.guide,
        paidGuide: views.paidGuide,
        archiveDiscovery: { suspend: async () => {} },
        libraryQueries: { live: '', genxtra: '' },
      });
      const removeRemote = ui.installRemoteNavigation();
      Reflect.set(window, 'watchPolicy', {
        views,
        controller,
        pageState,
        jobs,
        removeRemote,
        bufferControls,
      });
      await controller.switchPrimaryPage('guide');
    },
    { compact, paid, held, options },
  );
  await page.locator('.gx-timeline-channel:visible,.gx-agenda-channel:visible').first().waitFor();
  expect(await page.evaluate(() => document.compatMode)).toBe('CSS1Compat');
  return page;
}
async function close(page: Awaited<ReturnType<typeof mounted>>) {
  await page.evaluate(async () => {
    Reflect.get(window, 'releaseWatch')?.();
    const { views, jobs, removeRemote, bufferControls } = Reflect.get(window, 'watchPolicy');
    removeRemote();
    await bufferControls.dispose();
    await Promise.allSettled(jobs);
    await views.guide.dispose();
    await views.paidGuide.dispose();
    await views.guideChannelLogos.dispose();
  });
  await page.close();
}
for (const paid of [false, true]) {
  it(`${paid ? 'Paid' : 'Free'} short-landscape and TV Guide Watch keep their visible preview and Guide`, async () => {
    for (const compact of [true, false]) {
      const page = await mounted(compact, paid);
      try {
        const before = await page.locator('#screen').boundingBox();
        expect(Boolean(before && before.width && before.height)).toBe(true);
        await page.locator('.gx-timeline-channel').first().click();
        await page.waitForFunction(() => Reflect.get(window, 'watchCompleted'));
        await page.evaluate(async () => {
          await Promise.all(Reflect.get(window, 'watchPolicy').jobs);
          await Reflect.get(window, 'watchPolicy').pageState.primaryTransitions;
        });
        expect(await page.locator('#app').getAttribute('data-guide-panel')).toBe('open');
        expect(await page.locator('#screen').isVisible()).toBe(true);
        const bounds = await page.locator('#screen').boundingBox();
        expect(Boolean(bounds && bounds.width > 100 && bounds.height > 50)).toBe(true);
        if (compact) {
          expect(await page.locator('#app').getAttribute('data-compact-view')).toBe('watch');
          expect(
            await page.evaluate(() => {
              const active = document.activeElement;
              return (
                active instanceof HTMLElement &&
                active !== document.body &&
                active.getClientRects().length > 0 &&
                !active.closest('[hidden],[inert]')
              );
            }),
          ).toBe(true);
        }
      } finally {
        await close(page);
      }
    }
  });
  if (!paid)
    it('Free short-landscape programme-details Watch retains Guide without waiting on itself', async () => {
      const page = await mounted(true, paid);
      try {
        await page.locator('.gx-timeline-cell').first().click();
        const choice = page.locator('.gx-timeline-choices button').first();
        if (await choice.isVisible()) await choice.click();
        await page.getByRole('button', { name: 'Watch current channel', exact: true }).click();
        await page.waitForFunction(() => Reflect.get(window, 'watchCompleted'));
        await page.evaluate(() => Promise.all(Reflect.get(window, 'watchPolicy').jobs));
        expect(await page.locator('#screen').isVisible()).toBe(true);
        expect(
          await page.evaluate(
            () => Reflect.get(window, 'watchPolicy').pageState.primaryTransitionPending,
          ),
        ).toBe(0);
      } finally {
        await close(page);
      }
    });
  it(`${paid ? 'Paid' : 'Free'} delayed compact Watch cannot disturb a newly opened modal`, async () => {
    const page = await mounted(true, paid, true);
    try {
      await page.locator('.gx-timeline-channel').first().click();
      await page.waitForFunction(() => Reflect.get(window, 'watchStarted'));
      await page.evaluate(() => {
        const dialog = document.createElement('dialog'),
          control = document.createElement('button');
        control.textContent = 'Settings modal control';
        dialog.append(control);
        document.body.append(dialog);
        dialog.showModal();
        control.focus();
        Reflect.get(window, 'releaseWatch')();
      });
      await page.waitForFunction(() => Reflect.get(window, 'watchCompleted'));
      expect(await page.evaluate(() => Reflect.get(window, 'watchPolicy').jobs.length)).toBe(0);
      expect(
        await page
          .getByRole('button', { name: 'Settings modal control' })
          .evaluate((node) => node === document.activeElement),
      ).toBe(true);
      expect(await page.locator('#app').getAttribute('data-guide-panel')).toBe('open');
    } finally {
      await close(page);
    }
  });
  it(`${paid ? 'Paid' : 'Free'} late compact Watch completion cannot override a newer page intent`, async () => {
    const page = await mounted(true, paid, true);
    try {
      await page.locator('.gx-timeline-channel').first().click();
      await page.waitForFunction(() => Reflect.get(window, 'watchStarted'));
      await page.evaluate(() => {
        const { controller } = Reflect.get(window, 'watchPolicy');
        Reflect.set(window, 'backWork', controller.switchPrimaryPage('watch'));
        document.getElementById('settings-button')!.focus();
        Reflect.get(window, 'releaseWatch')();
      });
      await page.evaluate(() => Reflect.get(window, 'backWork'));
      expect(
        await page.evaluate(() => Reflect.get(window, 'watchPolicy').pageState.primaryIntent),
      ).toBe(2);
      expect(await page.evaluate(() => Reflect.get(window, 'watchPolicy').jobs.length)).toBe(0);
    } finally {
      await close(page);
    }
  });
}

for (const paid of [false, true])
  it(`${paid ? 'Paid' : 'Free'} idle-first landscape tune exposes the mini before compact-close admission`, async () => {
    const page = await mounted(true, paid, true, { idle: true });
    try {
      expect(await page.locator('#screen').isVisible()).toBe(false);
      const row = page.locator('.gx-timeline-channel').first();
      await row.focus();
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => Reflect.get(window, 'watchStarted'));
      expect(await page.locator('#app').getAttribute('data-guide-panel')).toBe('open');
      await page.evaluate(() => Reflect.get(window, 'releaseWatch')());
      await page.waitForFunction(() => Reflect.get(window, 'watchCompleted'));
      await page.evaluate(() => Promise.all(Reflect.get(window, 'watchPolicy').jobs));
      const rect = await page.evaluate(() => Reflect.get(window, 'previewBeforeWatchReturn'));
      expect(rect[2]).toBeGreaterThanOrEqual(160);
      expect(rect[3]).toBeGreaterThan(85);
      expect(await page.locator('#app').getAttribute('data-guide-panel')).toBe('open');
      expect(
        await page.evaluate(() => Reflect.get(window, 'watchPolicy').pageState.primaryPage),
      ).toBe('guide');
      expect(await row.evaluate((node) => document.activeElement === node)).toBe(true);
      if (!paid)
        await page.screenshot({
          path: 'artifacts/buffer-footer-testing/c7-guide-first-idle-tune-preview.png',
        });
    } finally {
      await close(page);
    }
  });

for (const size of [
  { width: 833, height: 397 },
  { width: 854, height: 432 },
])
  it(`short-landscape Sports keeps three rows, a mini, and remotely revealed toolbar controls at ${size.width}x${size.height}`, async () => {
    const page = await mounted(true, false, false, { rich: true, width: size.width });
    try {
      await page.setViewportSize(size);
      const sports = page
        .locator('.gx-timeline-toolbar')
        .getByRole('button', { name: 'Sports', exact: true });
      await sports.focus();
      await page.keyboard.press('Enter');
      const sport = page.locator('.guide-dialog[open] .sports-filters select[aria-label="Sport"]');
      await sport.waitFor();
      await sport.selectOption('american-football');
      await page
        .locator('.guide-dialog[open] .sports-filters select[aria-label="League"]')
        .waitFor();
      await page.locator('.gx-timeline-status[data-state="ready"]').waitFor();
      const geometry = await page.evaluate(() => {
        const scope = document.querySelector('.guide-dialog[open]')!;
        const box = (s: string) => {
          const r = (s === '#screen' ? document : scope).querySelector(s)!.getBoundingClientRect();
          return {
            left: r.left,
            top: r.top,
            right: r.right,
            bottom: r.bottom,
            width: r.width,
            height: r.height,
          };
        };
        const viewport = box('.gx-timeline-viewport');
        return {
          preview: box('#screen'),
          footer: (() => {
            const r = document
              .querySelector('.app-signoff.stream-buffer-footer')!
              .getBoundingClientRect();
            return { top: r.top, bottom: r.bottom, height: r.height };
          })(),
          toolbar: box('.gx-timeline-toolbar'),
          viewport,
          complete: [...scope.querySelectorAll('.gx-timeline-row')].filter((row) => {
            const r = row.getBoundingClientRect();
            return r.top >= viewport.top - 0.1 && r.bottom <= viewport.bottom + 0.1;
          }).length,
          bodyScroll: [scrollX, scrollY],
        };
      });
      await writeFile(
        `artifacts/buffer-footer-testing/c7-guide-geometry-${size.width}x${size.height}.json`,
        JSON.stringify({ size, ...geometry }, null, 2),
      );
      await page.screenshot({
        path: `artifacts/buffer-footer-testing/c7-guide-landscape-${size.width}x${size.height}.png`,
      });
      expect(geometry.complete).toBeGreaterThanOrEqual(3);
      expect(geometry.preview.width).toBeGreaterThanOrEqual(160);
      expect(geometry.preview.right).toBeLessThanOrEqual(geometry.toolbar.left);
      expect(geometry.preview.bottom).toBeLessThanOrEqual(geometry.viewport.top);
      expect(geometry.viewport.width).toBeGreaterThan(750);
      const labels: string[] = [];
      for (let index = 0; index < 20; index++) {
        const fact = await page.evaluate(() => {
          const active = document.activeElement as HTMLElement,
            toolbar = document.querySelector('.guide-dialog[open] .gx-timeline-toolbar')!;
          const r = active.getBoundingClientRect(),
            frame = toolbar.getBoundingClientRect();
          const clip = {
            left: frame.left + toolbar.clientLeft,
            top: frame.top + toolbar.clientTop,
            right: frame.left + toolbar.clientLeft + toolbar.clientWidth,
            bottom: frame.top + toolbar.clientTop + toolbar.clientHeight,
          };
          return {
            label: active.getAttribute('aria-label') || active.textContent || '',
            tag: active.tagName,
            inToolbar: toolbar.contains(active),
            width: r.width,
            height: r.height,
            inside:
              r.left >= clip.left - 1 &&
              r.right <= clip.right + 1 &&
              r.top >= clip.top - 1 &&
              r.bottom <= clip.bottom + 1,
            hit: active.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)),
          };
        });
        expect(fact.inToolbar).toBe(true);
        expect(fact.width).toBeGreaterThanOrEqual(44);
        expect(fact.height).toBeGreaterThanOrEqual(44);
        expect(fact.inside, JSON.stringify(fact)).toBe(true);
        expect(fact.hit, JSON.stringify(fact)).toBe(true);
        labels.push(fact.label);
        if (fact.label === 'Close guide') break;
        await page.keyboard.press('ArrowRight');
      }
      expect(labels).toContain('Sport');
      expect(labels).toContain('League');
      expect(labels).toContain('Now');
      expect(labels.at(-1)).toBe('Close guide');
      await page.screenshot({
        path: `artifacts/buffer-footer-testing/c7-guide-close-revealed-${size.width}x${size.height}.png`,
      });
      expect(await page.evaluate(() => [scrollX, scrollY])).toEqual(geometry.bodyScroll);
      await page.keyboard.press('ArrowDown');
      expect(
        await page
          .locator('.gx-timeline-channel')
          .first()
          .evaluate((node) => node === document.activeElement),
      ).toBe(true);
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowRight');
      expect(await page.locator('.gx-timeline-cell:focus').count()).toBe(1);
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      const toolbarFocus = await page.evaluate(() => {
        const a = document.activeElement as HTMLElement,
          t = document.querySelector('.guide-dialog[open] .gx-timeline-toolbar')!;
        const r = a.getBoundingClientRect(),
          frame = t.getBoundingClientRect();
        const c = {
          left: frame.left + t.clientLeft,
          top: frame.top + t.clientTop,
          right: frame.left + t.clientLeft + t.clientWidth,
          bottom: frame.top + t.clientTop + t.clientHeight,
        };
        return {
          inside:
            t.contains(a) &&
            r.left >= c.left - 1 &&
            r.right <= c.right + 1 &&
            r.top >= c.top - 1 &&
            r.bottom <= c.bottom + 1,
        };
      });
      expect(toolbarFocus.inside).toBe(true);
    } finally {
      await close(page);
    }
  });

it('narrow phone Guide keeps the full-workspace Watch return policy', async () => {
  const page = await mounted(true, false, false, { width: 640 });
  try {
    expect(await page.locator('#screen').isVisible()).toBe(false);
    await page.locator('.gx-agenda-watch:visible').click();
    await page.waitForFunction(() => Reflect.get(window, 'watchCompleted'));
    await page.evaluate(() => Promise.all(Reflect.get(window, 'watchPolicy').jobs));
    expect(await page.locator('#app').getAttribute('data-guide-panel')).toBe('closed');
    expect(await page.locator('#screen').isVisible()).toBe(true);
  } finally {
    await close(page);
  }
});
