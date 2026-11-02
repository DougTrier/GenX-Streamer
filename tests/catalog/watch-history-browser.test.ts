// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { afterAll, beforeAll, expect, it } from 'vitest';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';
import { build } from 'vite';
import { resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { readStylesheet } from '../support/stylesheet';

let browser: Browser, bundle: string, css: string;
beforeAll(async () => {
  const result = await build({
    configFile: false,
    logLevel: 'silent',
    plugins: [
      {
        name: 'history-browser',
        resolveId: (id) => (id.endsWith('virtual:history') ? '\0history' : undefined),
        load: (id) =>
          id === '\0history'
            ? [
                'ui/channels/channel-browser',
                'playback/watch-history',
                'ui/shell/shell',
                'ui/shell/remote-navigation',
                'application/catalog/live-tab-browse-state',
                'ui/channels/category-menu',
                'ui/channels/geography-controls',
                'ui/player/stream-buffer-controls',
              ]
                .map((name) => `export * from ${JSON.stringify(resolve(`src/${name}.ts`))};`)
                .join('\n')
            : undefined,
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:history', name: 'HistoryUI', formats: ['iife'] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing fixture bundle');
  const chunk = output.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing fixture code');
  bundle = chunk.code;
  const main = await readFile('src/main.ts', 'utf8');
  const sheets = [...main.matchAll(/^import '(\.\/ui\/[^']+\.css)';/gm)];
  css = (await Promise.all(sheets.map((match) => readStylesheet(resolve('src', match[1]))))).join(
    '\n',
  );
  css =
    output.output
      .flatMap((row) =>
        row.type === 'asset' && row.fileName.endsWith('.css') ? [String(row.source)] : [],
      )
      .join('\n') +
    '\n' +
    css;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

async function mount(
  indexed = false,
  heldLoad = false,
  actualLayout: boolean | 'tv' = false,
): Promise<Page> {
  const page = await browser.newPage({
    viewport:
      actualLayout && actualLayout !== 'tv'
        ? { width: 832, height: 397 }
        : { width: 960, height: 540 },
  });
  await page.setContent('<!doctype html><main id="app"></main>');
  await page.addStyleTag({
    content: actualLayout
      ? css
      : `*{box-sizing:border-box}#channel-list{height:300px;width:430px;overflow:auto;position:relative}#channel-rows{position:absolute;top:0;width:100%}.channel-row{display:flex;gap:4px}.channel{flex:1;min-height:66px}.channel-action{width:44px;min-height:44px}.channel-copy{display:block}#channel-spacer{width:1px}[hidden]{display:none!important}`,
  });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    async ({ indexed, heldLoad, actualLayout }) => {
      const api = Reflect.get(window, 'HistoryUI');
      api.createShell(document.getElementById('app'));
      Object.assign(document.getElementById('app')!.dataset, {
        deviceKind: actualLayout === 'tv' ? 'tv' : 'personal',
        ready: 'true',
        contentLibrary: 'live',
      });
      const state = {
        scope: { kind: 'free' },
        saved: null as string | null,
        fail: false,
        loadRelease: () => {},
        writeRelease: () => {},
        holdWrite: false,
        writes: 0,
        calls: [] as Record<string, unknown>[],
        selections: [] as string[],
        favorites: [] as string[],
        manage: [] as string[],
        failures: 0,
      };
      Reflect.set(window, 'state', state);
      const accountId = 'a'.repeat(32),
        paidId = `account-${accountId}-${'b'.repeat(64)}`;
      const channels = [
        { id: 'old', name: 'Old favorite', category: 'News', geography: { country: 'US' } },
        { id: 'ppv', name: 'PPV fight', category: 'Sports', geography: { country: 'US' } },
        {
          id: 'adult',
          name: 'Renamed',
          category: 'News',
          originalCategory: 'Adult XXX',
          geography: { country: 'US' },
        },
        { id: 'ca', name: 'Canada', category: 'News', geography: { country: 'CA' } },
        { id: 'new', name: 'Newest', category: 'News', geography: { country: 'US' } },
        { id: paidId, name: 'Paid watched', category: 'News', geography: { country: 'US' } },
      ];
      const ids = indexed
        ? Array.from({ length: 200 }, (_, i) => `c${199 - i}`)
        : ['old', 'ppv', 'adult', 'ca', 'new'];
      const data = {
        schemaVersion: 1,
        scopes: [
          { scope: 'free', entries: ids.map((id, i) => ({ id, watchedAtMs: 200 - i })) },
          { scope: `paid:${accountId}`, entries: [{ id: paidId, watchedAtMs: 1 }] },
        ],
      };
      state.saved = JSON.stringify(data);
      const store = api.createWatchHistory(
        {
          read: async () => {
            if (heldLoad)
              await new Promise<void>((resolve) => {
                state.loadRelease = resolve;
              });
            return state.saved;
          },
          write: async (text: string) => {
            state.writes++;
            if (state.holdWrite)
              await new Promise<void>((resolve) => {
                state.writeRelease = resolve;
              });
            if (state.fail) throw new Error('fixture storage refusal');
            state.saved = text;
          },
        },
        () => 1000,
      );
      Reflect.set(window, 'store', store);
      const host = indexed
        ? {
            revision: () => '1',
            identity: () => JSON.stringify(state.scope),
            scopeIdentity: () => JSON.stringify(state.scope),
            query: async (q: {
              historyIds?: string[];
              filter: string;
              anchorId?: string;
              startIndex?: number;
              pageSize: number;
            }) => {
              state.calls.push(structuredClone(q));
              const list = q.filter === 'watched' ? q.historyIds! : [];
              const anchor = q.anchorId ? list.indexOf(q.anchorId) : -1;
              const start = q.anchorId
                ? anchor < 0
                  ? 0
                  : Math.max(0, anchor - 1)
                : (q.startIndex ?? 0);
              return {
                schemaVersion: 1,
                requestId: 'fixture',
                catalogRevision: '1',
                viewRevision: '1',
                queryVersion: 'v1-' + 'a'.repeat(64),
                totalCount: list.length,
                startIndex: start,
                anchorIndex: anchor < 0 ? null : anchor,
                rows: list.slice(start, start + q.pageSize).map((id) => ({
                  id,
                  sourceId: 'fixture',
                  name: id,
                  category: 'News',
                  favorite: false,
                })),
                after: null,
              };
            },
          }
        : undefined;
      const cb = new api.ChannelBrowser(
        document.getElementById('channel-list'),
        (id: string) => state.selections.push(id),
        undefined,
        host,
        {
          baseRowHeight: actualLayout === 'tv' ? 52 : actualLayout ? 60 : 72,
          history: {
            store,
            scope: () => state.scope,
            controls: document.querySelector('.sidehead'),
            failed: () => {
              state.failures++;
            },
          },
          onFavorite: (id: string) => state.favorites.push(id),
          onManage: (id: string) => state.manage.push(id),
        },
      );
      Reflect.set(window, 'cb', cb);
      Reflect.set(window, 'channels', channels);
      cb.update(indexed ? [] : channels, ['old'], null);
      const choose = (filter: string) => {
        for (const button of document.querySelectorAll<HTMLElement>('[data-filter]'))
          button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
        (document.getElementById('compact-filter') as HTMLSelectElement).value = filter;
        cb.setFilter(filter);
      };
      Reflect.set(window, 'choose', choose);
      for (const button of document.querySelectorAll<HTMLElement>('[data-filter]'))
        button.addEventListener('click', () => choose(button.dataset.filter!));
      document
        .getElementById('compact-filter')!
        .addEventListener('change', (event) => choose((event.target as HTMLSelectElement).value));
      Reflect.set(window, 'removeNav', api.installRemoteNavigation());
      if (actualLayout) {
        Reflect.set(
          window,
          'geographyControls',
          api.mountGeographyControls(document.getElementById('geography-controls'), {
            channels: () => channels,
            apply: ({
              filter,
              sort,
              registry,
            }: {
              filter: unknown;
              sort: unknown;
              registry: unknown;
            }) => cb.setGeography(filter, sort, registry),
          }),
        );
        Reflect.set(
          window,
          'categoryMenu',
          api.installCategoryMenu(document.getElementById('app')),
        );
        Reflect.set(
          window,
          'bufferUI',
          api.mountStreamBufferControls(document.getElementById('app'), {
            current: () => ({
              selection: {
                id: 'old',
                name: 'Current',
                url: 'https://example.invalid/fixture.m3u8',
              },
              generation: 1,
              state: 'playing',
              telemetry: {
                incomingBitsPerSecond: 1250000,
                bufferedSeconds: 8,
                targetSeconds: 10,
                mode: 'manual',
                capability: 'controlled',
              },
            }),
            key: async () => 'a'.repeat(64),
            save: async () => {},
            apply: async () => true,
            notice: () => {},
          }),
        );
      }
    },
    { indexed, heldLoad, actualLayout },
  );
  return page;
}
async function cleanup(page: Page) {
  await page.evaluate(async () => {
    Reflect.get(window, 'state').loadRelease();
    Reflect.get(window, 'state').writeRelease();
    await Reflect.get(window, 'cb').dispose();
    Reflect.get(window, 'removeNav')();
    Reflect.get(window, 'categoryMenu')?.dispose();
    Reflect.get(window, 'geographyControls')?.dispose();
    await Reflect.get(window, 'bufferUI')?.dispose();
  });
  await page.close();
}
const ids = (page: Page) =>
  page
    .locator('[data-channel]')
    .evaluateAll((rows) => rows.map((row) => (row as HTMLElement).dataset.channel));

it('History is explicit, newest-first, and intersects location/search/adult metadata without favorite reordering', async () => {
  const page = await mount();
  try {
    await browserExpect(page.locator('[data-filter="watched"]')).toHaveText('History');
    await browserExpect(page.locator('#compact-filter option[value="watched"]')).toHaveText(
      'History',
    );
    await page.evaluate(async () => {
      const store = Reflect.get(window, 'store');
      await store.load();
      await store.record({ kind: 'free' }, 'new');
      await store.record({ kind: 'free' }, 'ppv');
      Reflect.get(window, 'cb').setFilter('watched');
    });
    expect(await ids(page)).toEqual(['ppv', 'new', 'old', 'ca']);
    await browserExpect(page.locator('#channel-count')).toHaveText('4 channels');
    await page.evaluate(() => Reflect.get(window, 'cb').setGeography({ country: 'US' }, 'name'));
    expect(await ids(page)).toEqual(['ppv', 'new', 'old']);
    await page.evaluate(() => Reflect.get(window, 'cb').search('Old'));
    expect(await ids(page)).toEqual(['old']);
    await page.evaluate(() => {
      Reflect.get(window, 'cb').search('');
      Reflect.get(window, 'cb').setFilter('all');
    });
    expect(await ids(page)).not.toContain('ppv');
    expect(await ids(page)).not.toContain('adult');
    await browserExpect(page.locator('#clear-watch-history')).toBeHidden();
  } finally {
    await cleanup(page);
  }
});

it('remote row removal only removes History and Clear is scoped to the active Paid account', async () => {
  const page = await mount();
  try {
    await page.evaluate(async () => {
      await Reflect.get(window, 'store').load();
      Reflect.get(window, 'cb').setFilter('watched');
    });
    await page.locator('[data-channel="old"]').focus();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await browserExpect(
      page.locator('[data-channel-action="history-remove"][data-channel-id="old"]'),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await browserExpect(page.locator('[data-channel="old"]')).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        const s = Reflect.get(window, 'state');
        return [s.selections, s.manage, s.favorites];
      }),
    ).toEqual([[], [], []]);
    await page.evaluate(() => {
      const state = Reflect.get(window, 'state');
      state.scope = { kind: 'paid', accountId: 'a'.repeat(32) };
      Reflect.get(window, 'cb').update(Reflect.get(window, 'channels'), [], null);
    });
    await browserExpect(page.locator('#channel-count')).toHaveText('1 channel');
    await page.locator('#clear-watch-history').focus();
    await page.keyboard.press('Enter');
    await browserExpect(page.locator('#channel-count')).toHaveText('0 channels');
    await browserExpect(page.locator('#channel-list')).toBeFocused();
    await browserExpect(page.locator('#list-empty')).toContainText('No watched channels');
    expect(await page.evaluate(() => Reflect.get(window, 'store').ids({ kind: 'free' }))).toEqual([
      'ppv',
      'adult',
      'ca',
      'new',
    ]);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'store').ids({ kind: 'paid', accountId: 'a'.repeat(32) }),
      ),
    ).toEqual([]);
  } finally {
    await cleanup(page);
  }
});

it('indexed deep paging forwards the same ordered IDs and removal relocates the owned anchor', async () => {
  const page = await mount(true);
  try {
    await page.evaluate(async () => {
      await Reflect.get(window, 'store').load();
      Reflect.get(window, 'cb').setFilter('watched');
    });
    await browserExpect(page.locator('#channel-count')).toHaveText('200 channels');
    await page.locator('#channel-list').evaluate((list) => {
      list.scrollTop = 72 * 120;
      list.dispatchEvent(new Event('scroll'));
    });
    await browserExpect(page.locator('[data-channel="c79"]')).toBeVisible();
    await page.locator('[data-channel="c79"]').focus();
    await page.evaluate(async () => {
      await Reflect.get(window, 'store').remove({ kind: 'free' }, 'c199');
    });
    await browserExpect(page.locator('[data-channel="c79"]')).toBeFocused();
    await browserExpect(page.locator('#channel-count')).toHaveText('199 channels');
    const calls = await page.evaluate(() =>
      Reflect.get(window, 'state').calls.filter((q: { filter: string }) => q.filter === 'watched'),
    );
    expect(calls.some((q: { startIndex?: number }) => (q.startIndex ?? 0) >= 100)).toBe(true);
    expect(calls.some((q: { anchorId?: string }) => q.anchorId === 'c79')).toBe(true);
    for (const q of calls) {
      expect(q.historyIds).toHaveLength(q.historyIds.includes('c199') ? 200 : 199);
      expect(q.historyIds[0]).toBe(q.historyIds.length === 200 ? 'c199' : 'c198');
    }
    expect(await page.evaluate(() => Reflect.get(window, 'state').selections)).toEqual([]);
  } finally {
    await cleanup(page);
  }
});

it('a new account pointer cannot clear History from controls still presenting the previous scope', async () => {
  const page = await mount();
  try {
    await page.evaluate(async () => {
      await Reflect.get(window, 'store').load();
      Reflect.get(window, 'cb').setFilter('watched');
    });
    await page.evaluate(async () => {
      Reflect.get(window, 'state').scope = { kind: 'paid', accountId: 'a'.repeat(32) };
      await Reflect.get(window, 'cb').clearHistory();
    });
    expect(
      await page.evaluate(() => Reflect.get(window, 'store').ids({ kind: 'free' })),
    ).toHaveLength(5);
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'store').ids({ kind: 'paid', accountId: 'a'.repeat(32) }),
      ),
    ).toHaveLength(1);
    expect(await page.evaluate(() => Reflect.get(window, 'state').writes)).toBe(0);
  } finally {
    await cleanup(page);
  }
});

it('failed persistence retains acknowledged membership and reports a fixed error', async () => {
  const page = await mount();
  try {
    await page.evaluate(async () => {
      await Reflect.get(window, 'store').load();
      Reflect.get(window, 'cb').setFilter('watched');
      Reflect.get(window, 'state').fail = true;
    });
    await page.locator('#clear-watch-history').click();
    await browserExpect(page.locator('#list-empty')).toContainText('History could not');
    await browserExpect(page.locator('#list-empty')).toBeVisible();
    expect(
      await page.evaluate(() => Reflect.get(window, 'store').ids({ kind: 'free' })),
    ).toHaveLength(5);
    expect(await page.evaluate(() => Reflect.get(window, 'state').failures)).toBe(1);
    expect(await ids(page)).toEqual(['old', 'ppv', 'ca', 'new']);
  } finally {
    await cleanup(page);
  }
});

it('dispose joins a held History load and prevents late UI updates or subscription refreshes', async () => {
  const page = await mount(false, true);
  try {
    await page.evaluate(() => {
      const cb = Reflect.get(window, 'cb');
      cb.setFilter('watched');
      Reflect.set(window, 'historyClosed', false);
      Reflect.set(
        window,
        'closing',
        cb.dispose().then(() => Reflect.set(window, 'historyClosed', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'historyClosed'))).toBe(false);
    await page.evaluate(async () => {
      Reflect.get(window, 'state').loadRelease();
      await Reflect.get(window, 'closing');
      await Reflect.get(window, 'store').record({ kind: 'free' }, 'new');
    });
    await browserExpect(page.locator('#channel-list')).toHaveAttribute(
      'data-catalog-state',
      'closed',
    );
    await browserExpect(page.locator('#clear-watch-history')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, 'historyClosed'))).toBe(true);
  } finally {
    await cleanup(page);
  }
});

it('disposal joins the exact pending remove write and cannot publish a late row refresh', async () => {
  const page = await mount();
  try {
    await page.evaluate(async () => {
      await Reflect.get(window, 'store').load();
      Reflect.get(window, 'cb').setFilter('watched');
      Reflect.get(window, 'state').holdWrite = true;
    });
    await page.locator('[data-channel-action="history-remove"][data-channel-id="old"]').click();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'state').writes)).toBe(1);
    await page.evaluate(() => {
      Reflect.set(window, 'historyClosed', false);
      Reflect.set(
        window,
        'closing',
        Reflect.get(window, 'cb')
          .dispose()
          .then(() => Reflect.set(window, 'historyClosed', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'historyClosed'))).toBe(false);
    await page.evaluate(async () => {
      Reflect.get(window, 'state').writeRelease();
      await Reflect.get(window, 'closing');
    });
    expect(
      await page.evaluate(() => Reflect.get(window, 'store').ids({ kind: 'free' })),
    ).not.toContain('old');
    await browserExpect(page.locator('#channel-list')).toHaveAttribute(
      'data-catalog-state',
      'closed',
    );
    await browserExpect(page.locator('#clear-watch-history')).toHaveCount(0);
  } finally {
    await cleanup(page);
  }
});

it.each([true, 'tv'] as const)(
  'the shipped layout %s keeps History controls above cards and the populated buffer footer',
  async (layout) => {
    const page = await mount(false, false, layout);
    try {
      // Match the app's standards document, ordinary font and device row pitch
      // before exercising a separate enlarged-text, scrollable card.
      expect(await page.evaluate(() => document.compatMode)).toBe('CSS1Compat');
      await page.evaluate(async () => {
        const cb = Reflect.get(window, 'cb');
        await Reflect.get(window, 'store').load();
        cb.update(
          [
            { id: 'old', name: 'One', category: 'News' },
            { id: 'new', name: 'Two', category: 'News' },
          ],
          [],
          null,
        );
        Reflect.get(window, 'choose')('watched');
      });
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await browserExpect(page.locator('#clear-watch-history')).toBeVisible();
      await browserExpect(page.locator('#stream-buffer-footer')).toContainText('1,250 kbps');
      if (layout === true) {
        await browserExpect(page.locator('#compact-filter')).toBeVisible();
        expect(await page.locator('#compact-filter').evaluate((node) => node.tagName)).toBe(
          'SELECT',
        );
      } else await browserExpect(page.locator('#category-button')).toContainText('History');
      const bounds = await page.evaluate(() => {
        const list = document.getElementById('channel-list')!.getBoundingClientRect(),
          footer = document.querySelector('.app-signoff')!.getBoundingClientRect();
        return {
          listTop: list.top,
          listBottom: list.bottom,
          footerTop: footer.top,
          footerHeight: footer.height,
          controls: [
            ...document.querySelectorAll<HTMLElement>(
              '.sidehead > button, .sidehead > .location-trigger, .sidehead > details',
            ),
          ]
            .filter((node) => node.checkVisibility())
            .map((node) => {
              const r = node.getBoundingClientRect();
              return {
                id: node.id,
                top: r.top,
                bottom: r.bottom,
                left: r.left,
                right: r.right,
                width: r.width,
                height: r.height,
              };
            }),
        };
      });
      for (const control of bounds.controls) {
        expect(control.width).toBeGreaterThanOrEqual(layout === 'tv' ? 34 : 44);
        // The shipped TV toolbar uses 34px controls; personal/native selects
        // retain 44px targets. History follows the existing toolbar pitch.
        expect(control.height).toBeGreaterThanOrEqual(layout === 'tv' ? 34 : 44);
        expect(control.bottom).toBeLessThanOrEqual(bounds.listTop + 1);
        expect(control.left).toBeGreaterThanOrEqual(0);
        expect(control.right).toBeLessThanOrEqual(layout === 'tv' ? 960 : 832);
      }
      expect(bounds.listBottom).toBeLessThanOrEqual(bounds.footerTop + 1);
      expect(bounds.footerHeight).toBeGreaterThanOrEqual(44);
      const ordinary = await page.evaluate(() => {
        const list = document.getElementById('channel-list')!.getBoundingClientRect();
        const browser = document.querySelector('.browser')!.getBoundingClientRect();
        const footer = document.querySelector('.app-signoff')!.getBoundingClientRect();
        const top = Math.max(list.top, browser.top);
        const bottom = Math.min(list.bottom, browser.bottom, footer.top);
        return ['old', 'new'].map((id) => {
          const r = document.querySelector(`[data-channel="${id}"]`)!.getBoundingClientRect();
          return { id, height: r.height, complete: r.top >= top - 0.5 && r.bottom <= bottom + 0.5 };
        });
      });
      expect(
        ordinary.every((row) => row.height > 0 && row.complete),
        JSON.stringify(ordinary),
      ).toBe(true);
      // Native/global navigation can enter each toolbar control without opening a menu.
      await page.locator('#guide-button').focus();
      await page.keyboard.press('ArrowRight');
      await browserExpect(page.locator('#clear-watch-history')).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await browserExpect(page.locator('#guide-button')).toBeFocused();
      if (layout === 'tv') {
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await page.keyboard.press('ArrowLeft');
        await browserExpect(page.locator('#category-button')).toBeFocused();
      } else {
        await page.locator('#compact-filter').focus();
        await browserExpect(page.locator('#compact-filter')).toBeFocused();
        await page.keyboard.press('Tab');
        expect(await page.evaluate(() => document.activeElement?.id)).not.toBe('compact-filter');
      }
      if (layout === true)
        await page.addStyleTag({
          content: '#app #channel-list .channel-copy :is(strong,small){font-size:20px!important}',
        });
      const title = 'Syracuse Orange versus Clemson Tigers — complete college football replay';
      await page.evaluate((title) => {
        const cb = Reflect.get(window, 'cb');
        cb.update(
          [
            {
              id: 'old',
              sourceId: 'fixture',
              name: 'US provider: Syracuse Orange versus Clemson Tigers complete programme replay',
              category: 'Sports',
            },
          ],
          [],
          null,
        );
        cb.setNowPlaying([
          {
            catalogSourceId: 'fixture',
            appChannelId: 'old',
            title,
            startMs: Date.now() - 1000,
            stopMs: Date.now() + 3600000,
          },
        ]);
      }, title);
      const target = page.locator('[data-channel="old"]');
      await browserExpect(target.locator('.media-result-subtitle')).toHaveText(title);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const main = document.querySelector<HTMLElement>('[data-channel="old"]')!;
            const copy = main.querySelector<HTMLElement>('.channel-copy')!;
            const style = getComputedStyle(main);
            return (
              copy.getBoundingClientRect().height +
              parseFloat(style.paddingTop) +
              parseFloat(style.paddingBottom) -
              main.getBoundingClientRect().height
            );
          }),
        )
        .toBeLessThanOrEqual(1);
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await target.focus();
      await page.keyboard.press('Home');
      const snapshot = () =>
        page.evaluate(() => {
          // Resolve the current logical virtual row and its text in one task.
          const node = document.querySelector<HTMLElement>('[data-channel="old"]')!;
          const browser = node.closest<HTMLElement>('.browser')!.getBoundingClientRect();
          const list = node.closest<HTMLElement>('#channel-list')!.getBoundingClientRect();
          const footer = document.querySelector('.app-signoff')!.getBoundingClientRect();
          const top = Math.max(0, browser.top, list.top);
          const bottom = Math.min(innerHeight, browser.bottom, list.bottom, footer.top);
          const lines = (selector: string) => {
            const text = node.querySelector<HTMLElement>(selector)!;
            const range = document.createRange();
            range.selectNodeContents(text);
            return [...range.getClientRects()]
              .filter((r) => r.width && r.height)
              .map((r) => r.top >= top - 1 && r.bottom <= bottom + 1);
          };
          const footerButton = document.querySelector<HTMLElement>('#stream-buffer-footer button')!;
          const f = footerButton.getBoundingClientRect();
          return {
            focused: document.activeElement === node,
            rowHeight: node.getBoundingClientRect().height,
            browserHeight: browser.height,
            title: lines('.media-result-title'),
            programme: lines('.media-result-subtitle'),
            footerHit: footerButton.contains(
              document.elementFromPoint(f.x + f.width / 2, f.y + f.height / 2),
            ),
          };
        });
      const first = await snapshot();
      expect(first.footerHit).toBe(true);
      if (layout === true) {
        expect(first.rowHeight).toBeGreaterThan(first.browserHeight);
        expect(first.title[0]).toBe(true);
        const covered = { title: new Set<number>(), programme: new Set<number>() };
        let pages = 0;
        for (let step = 0; step < 12; step++) {
          const state = await snapshot();
          expect(state.focused).toBe(true);
          expect(state.footerHit).toBe(true);
          for (const kind of ['title', 'programme'] as const)
            state[kind].forEach((shown, i) => shown && covered[kind].add(i));
          if (
            covered.title.size === first.title.length &&
            covered.programme.size === first.programme.length
          )
            break;
          await page.keyboard.press('ArrowDown');
          pages++;
        }
        expect(pages).toBeGreaterThan(0);
        for (const kind of ['title', 'programme'] as const) {
          expect(first[kind].length).toBeGreaterThan(0);
          expect(covered[kind].size, `Every ${kind} line must become readable by Down.`).toBe(
            first[kind].length,
          );
        }
      }
      for (const line of await target.locator('.channel-copy :is(strong,small)').all())
        expect(await line.evaluate((node) => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('ArrowRight');
      const remove = page.locator('[data-channel-action="history-remove"]');
      await browserExpect(remove).toBeFocused();
      const rect = await remove.boundingBox();
      const peer = await page.locator('[data-channel-action="favorite"]').boundingBox();
      expect(rect!.width).toBeGreaterThanOrEqual(peer!.width);
      expect(rect!.height).toBeGreaterThanOrEqual(peer!.height);
      expect(rect!.width).toBeGreaterThanOrEqual(layout === 'tv' ? 34 : 44);
      expect(rect!.height).toBeGreaterThanOrEqual(layout === 'tv' ? 34 : 44);
      expect(
        await remove.evaluate((node) => {
          const r = node.getBoundingClientRect();
          return (
            r.width > 0 &&
            r.height > 0 &&
            node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
          );
        }),
      ).toBe(true);
      await page.keyboard.press('Enter');
      await browserExpect(page.locator('#channel-count')).toHaveText('0 channels');
      await browserExpect(page.locator('#channel-list')).toBeFocused();
    } finally {
      await cleanup(page);
    }
  },
);
