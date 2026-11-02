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
        name: 'sports-browser',
        resolveId: (id) => (id.endsWith('virtual:sports-browser') ? '\0sports-browser' : undefined),
        load: (id) =>
          id === '\0sports-browser'
            ? [
                'ui/shell/shell',
                'ui/shell/remote-navigation',
                'ui/shell/in-app-select',
                'ui/channels/channel-browser',
                'ui/channels/category-menu',
                'ui/channels/geography-controls',
                'ui/genxtra/library-switcher',
                'application/accounts/account-browser',
                'application/accounts/account-scope',
              ]
                .map((name) => `export * from ${JSON.stringify(resolve(`src/${name}.ts`))};`)
                .join('\n')
            : undefined,
      },
    ],
    build: {
      write: false,
      minify: false,
      lib: { entry: 'virtual:sports-browser', name: 'SportsBrowser', formats: ['iife'] },
    },
  });
  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !('output' in output)) throw new Error('Missing sports browser bundle');
  bundle = output.output.find((item) => item.type === 'chunk')!.code;
  // Exercise the shipped cascade, including the result-card selectors that
  // override the base row styles. A subset can hide real specificity bugs.
  const main = await readFile('src/main.ts', 'utf8');
  const sheets = [...main.matchAll(/^import '(\.\/ui\/[^']+\.css)';/gm)];
  expect(sheets.length).toBeGreaterThan(10);
  css = (await Promise.all(sheets.map((match) => readStylesheet(resolve('src', match[1]))))).join(
    '\n',
  );
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  if (browser) {
    try {
      expect(browser.contexts()).toHaveLength(0);
    } finally {
      await browser.close();
    }
  }
});

async function mount(width = 960, height = 540, kind = 'tv', withLogos = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent('<!doctype html><main id="app"></main>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    async ({ deviceKind, withLogos }) => {
      const api = Reflect.get(window, 'SportsBrowser');
      const element = (id: string) => document.getElementById(id)!;
      api.createShell(element('app'));
      element('app').dataset.deviceKind = deviceKind;
      element('app').dataset.ready = 'true';
      element('app').dataset.contentLibrary = 'live';
      const channels = [
        { id: 'nfl', name: 'NFL 01', category: 'Sports', geography: { country: 'US' } },
        { id: 'soccer', name: 'MLS Soccer', category: 'Sports', geography: { country: 'CA' } },
        {
          id: 'ppv',
          name: 'NFL PPV 2',
          category: 'Movies',
          originalCategory: 'US|NFL PPV',
          geography: { country: 'US' },
        },
        {
          id: 'unrelated',
          name: 'NFLive Cinema PPV',
          category: 'Movies',
          geography: { country: 'US' },
        },
        {
          id: 'fox',
          name: 'FOX',
          category: 'General',
          geography: { country: 'US' },
          cachedPrograms: [
            {
              title: 'Chicago Bears at Buffalo Bills PPV',
              startMs: Date.now() + 3600000,
              stopMs: Date.now() + 7200000,
            },
          ],
        },
        {
          id: 'mixed',
          name: 'Affiliate',
          category: 'General',
          geography: { country: 'US' },
          cachedPrograms: [
            {
              title: 'Chicago Bears practice',
              startMs: Date.now() + 3600000,
              stopMs: Date.now() + 5400000,
            },
            {
              title: 'Chicago Bears at Buffalo Bills PPV',
              startMs: Date.now() + 5400000,
              stopMs: Date.now() + 7200000,
            },
          ],
        },
      ];
      const selected: string[] = [];
      const channelBrowser = new api.ChannelBrowser(
        element('channel-list'),
        (id: string) => selected.push(id),
        undefined,
        undefined,
        {
          sportsControls: element('sports-filters'),
          ...(withLogos
            ? {
                logos: {
                  get: () =>
                    'data:image/svg+xml,' +
                    encodeURIComponent(
                      '<svg xmlns="http://www.w3.org/2000/svg" width="60" height="40"><rect width="60" height="40" fill="cyan"/></svg>',
                    ),
                  visible: () => {},
                  rejected: () => {},
                },
              }
            : {}),
        },
      );
      const accounts = api.createAccountBrowser();
      const metadata = {
        schemaVersion: 1,
        id: 'a'.repeat(32),
        name: 'Offline fixture',
        kind: 'xtream',
        serverOrigin: 'https://fixture.invalid',
        allowHttp: false,
        revision: '1',
        requiresSignIn: false,
      };
      const queries = { live: '' };
      const chooseCategory = (filter: string) => {
        for (const button of document.querySelectorAll<HTMLElement>('[data-filter]'))
          button.setAttribute('aria-pressed', String(button.dataset.filter === filter));
        (element('compact-filter') as HTMLSelectElement).value = filter;
        channelBrowser.setFilter(filter);
      };
      const geography = api.mountGeographyControls(element('geography-controls'), {
        channels: () => channels,
        apply: ({
          filter,
          sort,
          registry,
        }: {
          filter: unknown;
          sort: unknown;
          registry: unknown;
        }) => channelBrowser.setGeography(filter, sort, registry),
      });
      const render = () => {
        channelBrowser.update(
          channels.map((row) => ({
            ...row,
            id: accounts.selectedAccount ? 'paid-' + row.id : row.id,
          })),
          accounts.selectedAccount ? ['paid-nfl', 'paid-ppv'] : ['nfl', 'ppv'],
          null,
        );
        geography.update();
      };
      const scope = api.createAccountScope({
        accountBrowser: accounts,
        browser: channelBrowser,
        libraryQueries: queries,
        chooseCategory,
        geographyControls: geography,
        element,
        renderCatalog: render,
      });
      for (const button of document.querySelectorAll<HTMLButtonElement>('[data-filter]'))
        button.addEventListener('click', () => chooseCategory(button.dataset.filter!));
      element('search').addEventListener('input', () => {
        queries.live = (element('search') as HTMLInputElement).value;
        channelBrowser.search(queries.live);
      });
      const jobs: Promise<unknown>[] = [];
      const libraries = api.mountLibrarySwitcher(
        {
          list: async () => [metadata],
          ready: () => true,
          selected: () => accounts.selectedAccount,
          select: (value: unknown) => scope.selectAccountScope(value),
          release: async () => {},
          showLive: async () => {
            channelBrowser.search(queries.live);
          },
          openAccounts: () => {},
          run: (work: Promise<unknown>) => jobs.push(work),
        },
        {
          free: element('live-tv-button'),
          paid: element('paid-tv-button'),
          list: element('channel-list'),
        },
      );
      await libraries.reload();
      render();
      const television = deviceKind === 'tv' ? api.installInAppSelects(element('app')) : undefined;
      const removeNavigation = api.installRemoteNavigation({
        editMode: api.createRemoteEditMode(),
      });
      Reflect.set(window, 'fixture', {
        browser: channelBrowser,
        scope,
        metadata,
        accounts,
        libraries,
        queries,
        geography,
        selected,
        chooseCategory,
        settle: () => Promise.all(jobs),
        dispose: async () => {
          removeNavigation();
          television?.dispose();
          libraries.dispose();
          geography.dispose();
          channelBrowser.dispose();
          await accounts.dispose();
        },
      });
    },
    { deviceKind: kind, withLogos },
  );
  return page;
}
async function close(page: Page) {
  await page.evaluate(() => Reflect.get(window, 'fixture').dispose());
  await page.close();
}

it('keeps two ordinary logo cards and their real actions fully readable on Thor landscape', async () => {
  const page = await mount(833, 397, 'personal');
  try {
    const font = (
      await readFile('assets/fonts/roboto-condensed/RobotoCondensed-Variable.ttf')
    ).toString('base64');
    await page.evaluate(async (font) => {
      // Load the actual shipped face: an about:blank fixture cannot resolve its CSS URL.
      const face = new FontFace('GenX UI', `url(data:font/ttf;base64,${font})`, {
        weight: '100 900',
      });
      document.fonts.add(await face.load());
      await document.fonts.ready;
      const api = Reflect.get(window, 'SportsBrowser');
      Reflect.get(window, 'fixture').browser.dispose();
      const actions: string[] = [];
      const browser = new api.ChannelBrowser(
        document.getElementById('channel-list')!,
        () => {},
        { onVisibleGuideRows: () => {} },
        undefined,
        {
          baseRowHeight: 60,
          onManage: (id: string) => actions.push(`manage:${id}`),
          onFavorite: (id: string) => actions.push(`favorite:${id}`),
          logos: {
            get: () =>
              'data:image/svg+xml,' +
              encodeURIComponent(
                '<svg xmlns="http://www.w3.org/2000/svg" width="54" height="38"><rect width="54" height="38" fill="cyan"/></svg>',
              ),
            visible: () => {},
            rejected: () => {},
          },
        },
      );
      browser.update(
        [
          {
            id: 'ordinary-3abn',
            sourceId: 'ordinary-fixture',
            name: '3ABN Canada (720p)',
            category: 'Religious',
          },
          {
            id: 'ordinary-replay',
            sourceId: 'ordinary-fixture',
            name: '00s Replay',
            category: 'Movies',
          },
          {
            id: 'ordinary-next',
            sourceId: 'ordinary-fixture',
            name: '1+1 International HD (720p)',
            category: 'General',
          },
          {
            id: 'ordinary-marafon',
            sourceId: 'ordinary-fixture',
            name: '1+1 Marafon (1080p)',
            category: 'General',
          },
          {
            id: 'ordinary-almere',
            sourceId: 'ordinary-fixture',
            name: '1AlmereTV (720p)',
            category: 'General',
          },
          {
            id: 'ordinary-music',
            sourceId: 'ordinary-fixture',
            name: '1HD Music Television (1080p)',
            category: 'Music',
          },
          {
            id: 'ordinary-family',
            sourceId: 'ordinary-fixture',
            name: '1KZN TV (576p)',
            category: 'Entertainment;Family;General',
          },
          {
            id: 'ordinary-one',
            sourceId: 'ordinary-fixture',
            name: '1TV (720p)',
            category: 'General',
          },
          {
            id: 'ordinary-twente',
            sourceId: 'ordinary-fixture',
            name: '1Twente TV (1080p)',
            category: 'General',
          },
        ],
        [],
        null,
      );
      Reflect.set(window, 'ordinaryCards', { browser, actions });
    }, font);
    const first = page.locator('[data-channel="ordinary-3abn"]');
    const second = page.locator('[data-channel="ordinary-replay"]');
    await browserExpect(page.locator('#compact-filter')).toBeVisible();
    expect(await page.locator('.in-app-select').count()).toBe(0);
    await browserExpect(first.locator('.channel-logo-image')).toBeVisible();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await first.focus();
    await page.keyboard.press('ArrowDown');
    await browserExpect(second).toBeFocused();
    const geometry = () =>
      page.evaluate(() => {
        const list = document.getElementById('channel-list')!;
        const l = list.getBoundingClientRect();
        const b = list.closest('.browser')!.getBoundingClientRect();
        const footer = document.querySelector('.app-signoff')!.getBoundingClientRect();
        const top = Math.max(0, l.top, b.top);
        const bottom = Math.min(innerHeight, l.bottom, b.bottom, footer.top);
        const rect = (r: DOMRect) => ({
          x: r.x,
          y: r.y,
          width: r.width,
          height: r.height,
          bottom: r.bottom,
        });
        const rows = ['ordinary-3abn', 'ordinary-replay'].map((id) => {
          const main = document.querySelector<HTMLElement>(`[data-channel="${id}"]`)!;
          const row = main.closest('.channel-row')!;
          const controls = [...row.querySelectorAll<HTMLElement>('button')].map((button) => {
            const r = button.getBoundingClientRect();
            return {
              action: button.dataset.channelAction ?? 'main',
              rect: rect(r),
              complete: r.top >= top - 0.5 && r.bottom <= bottom + 0.5,
              hit: button.contains(
                document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
              ),
            };
          });
          return {
            id,
            main: rect(main.getBoundingClientRect()),
            title: main.querySelector('.media-result-title')!.textContent,
            fontSize: getComputedStyle(main.querySelector('.media-result-title')!).fontSize,
            logo: rect(main.querySelector('.channel-logo-image')!.getBoundingClientRect()),
            controls,
          };
        });
        return {
          list: rect(l),
          browser: rect(b),
          footer: rect(footer),
          top,
          bottom,
          pitch: rows[1].main.y - rows[0].main.y,
          rows,
          completeRows: rows.filter((row) =>
            row.controls.every((control) => control.complete && control.hit),
          ).length,
        };
      });
    console.info('Thor ordinary card settled geometry', JSON.stringify(await geometry()));
    await expect.poll(async () => (await geometry()).completeRows).toBe(2);
    const measured = await geometry();
    console.info('Thor ordinary card geometry', JSON.stringify(measured));
    expect(measured.rows[0].fontSize).toBe('16px');
    expect(measured.rows.every((row) => row.controls.length === 3)).toBe(true);
    for (const row of measured.rows) {
      for (const control of row.controls) {
        expect(control.rect.height).toBeGreaterThanOrEqual(44);
        expect(control.rect.width).toBeGreaterThanOrEqual(44);
        expect(control.complete).toBe(true);
        expect(control.hit).toBe(true);
      }
    }
    await page.keyboard.press('ArrowRight');
    await browserExpect(
      page.locator('[data-channel-id="ordinary-replay"][data-channel-action="manage"]'),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowRight');
    await browserExpect(
      page.locator('[data-channel-id="ordinary-replay"][data-channel-action="favorite"]'),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'ordinaryCards').actions)).toEqual([
      'manage:ordinary-replay',
      'favorite:ordinary-replay',
    ]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'ordinaryCards')?.browser.dispose());
    await close(page);
  }
});

it('releases only the settled empty card reserve and ignores an earlier long-row pitch', async () => {
  const page = await mount(736, 414, 'personal');
  const list = page.locator('#channel-list');
  try {
    await browserExpect(list).toHaveAttribute('data-catalog-empty', 'false');
    const minimum = () => list.evaluate((node) => parseFloat(getComputedStyle(node).minHeight));
    expect(await minimum()).toBeGreaterThanOrEqual(120);
    await page.evaluate(() => {
      Reflect.get(window, 'fixture').browser.update(
        [
          {
            id: 'long',
            sourceId: 'fixture',
            name: 'The complete very long provider channel label '.repeat(12),
            category: 'News',
          },
        ],
        [],
        null,
      );
    });
    const pitch = () =>
      list.evaluate((node) => parseFloat(node.style.getPropertyValue('--channel-row-height')));
    await expect.poll(pitch).toBeGreaterThan(120);
    const longPitch = await pitch();
    expect(await minimum()).toBeGreaterThanOrEqual(longPitch);
    await page.evaluate(() =>
      Reflect.get(window, 'fixture').browser.search('no-such-channel-unique'),
    );
    await browserExpect(list).toHaveAttribute('data-catalog-empty', 'true');
    await browserExpect(page.locator('.channel-row')).toHaveCount(0);
    expect(await minimum()).toBe(72);
    expect(await pitch()).toBe(longPitch);
    const empty = await page.locator('#refresh-button').evaluate((button) => {
      const box = button.getBoundingClientRect();
      const footer = document.querySelector('.app-signoff')!.getBoundingClientRect();
      return {
        aboveFooter: box.bottom <= footer.top + 0.5,
        insideWindow: box.top >= 0 && box.bottom <= innerHeight,
        height: box.height,
        hits: [box.top + 3, (box.top + box.bottom) / 2, box.bottom - 3].every((y) =>
          button.contains(document.elementFromPoint((box.left + box.right) / 2, y)),
        ),
      };
    });
    expect(empty).toMatchObject({ aboveFooter: true, insideWindow: true, hits: true });
    expect(empty.height).toBeGreaterThanOrEqual(44);
    await page.evaluate(() => Reflect.get(window, 'fixture').browser.search(''));
    await browserExpect(list).toHaveAttribute('data-catalog-empty', 'false');
    await browserExpect(page.locator('.channel-row')).toHaveCount(1);
    expect(await minimum()).toBeGreaterThanOrEqual(longPitch);
  } finally {
    await close(page);
  }
});

it.each([
  { width: 960, height: 540, kind: 'tv' },
  { width: 1280, height: 720, kind: 'desktop' },
  { width: 832, height: 397, kind: 'personal' },
])(
  'keeps folded Sports controls above channel cards at $width×$height',
  async ({ width, height, kind }) => {
    const page = await mount(width, height, kind);
    try {
      await page.evaluate(() => {
        const api = Reflect.get(window, 'SportsBrowser');
        Reflect.set(
          window,
          'categoryMenu',
          api.installCategoryMenu(document.getElementById('app')!),
        );
        Reflect.get(window, 'fixture').chooseCategory('sports');
      });
      for (const facet of [
        {},
        { sport: 'american-football' },
        { sport: 'american-football', league: 'nfl' },
      ]) {
        await page.evaluate(
          (next) => Reflect.get(window, 'fixture').browser.setSportsFacet(next),
          facet,
        );
        await page.evaluate(
          () =>
            new Promise<void>((done) =>
              requestAnimationFrame(() => requestAnimationFrame(() => done())),
            ),
        );
        const geometry = await page.locator('#channel-list').evaluate((node) => {
          const bounds = node.getBoundingClientRect();
          const first = node.querySelector('.channel')!.getBoundingClientRect();
          const head = document.querySelector('.sidehead')!.getBoundingClientRect();
          const filters = document.getElementById('sports-filters')!.getBoundingClientRect();
          return {
            top: bounds.top,
            height: bounds.height,
            firstTop: first.top,
            controlsBottom: Math.max(head.bottom, filters.bottom),
          };
        });
        expect(geometry.top).toBeGreaterThanOrEqual(geometry.controlsBottom - 0.5);
        expect(geometry.height).toBeGreaterThanOrEqual(52);
        expect(geometry.firstTop).toBeGreaterThanOrEqual(geometry.top - 0.5);
      }
    } finally {
      await page.evaluate(() => Reflect.get(window, 'categoryMenu')?.dispose());
      await close(page);
    }
  },
);

it('uses saved programme evidence for generic affiliates and badges only PPV-only matching rows', async () => {
  const page = await mount();
  try {
    await page.locator('#search').fill('NFL');
    await browserExpect(page.locator('.sports-inclusion-status')).toContainText(
      'Matching PPV included',
    );
    await browserExpect(page.locator('.channel')).toHaveCount(4);
    const badges = await page
      .locator('.channel')
      .evaluateAll((rows) =>
        rows.filter((row) => row.querySelector('.ppv-badge')).map((row) => row.textContent),
      );
    expect(badges.some((text) => text?.includes('FOX'))).toBe(true);
    expect(badges.some((text) => text?.includes('NFL PPV'))).toBe(true);
    expect(badges.some((text) => text?.includes('Affiliate'))).toBe(false);
    await browserExpect(page.locator('.channel')).not.toContainText(['NFLive']);
    await page.locator('#search').fill('');
    await browserExpect(page.locator('.channel')).toHaveCount(4);
    await browserExpect(page.locator('.channel .ppv-badge')).toHaveCount(0);
    await page.getByRole('button', { name: 'PPV', exact: true }).click();
    await browserExpect(page.locator('.channel')).toHaveCount(2);
  } finally {
    await close(page);
  }
});

it.each([
  { width: 960, height: 540, kind: 'tv' },
  { width: 832, height: 397, kind: 'personal' },
])(
  'Sport and League remote choices stay contained at $width×$height with enlarged text',
  async ({ width, height, kind }) => {
    const page = await mount(width, height, kind);
    try {
      await page.addStyleTag({
        content:
          '#app #sports-filters .sports-filter-controls label,#app #sports-filters .sports-filter-controls select,#app #sports-filters .sports-filter-controls button { font-size:20px !important; }',
      });
      await page.evaluate(() => {
        document.getElementById('app')!.style.fontSize = '20px';
        Reflect.get(window, 'fixture').chooseCategory('sports');
      });
      const sport = page.locator('select[aria-label="Sport"]');
      if (kind === 'tv') {
        const control = page.getByRole('button', { name: 'Sport', exact: true });
        await control.focus();
        await page.keyboard.press('Enter');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
      } else {
        await browserExpect(sport).toBeVisible();
        await sport.focus();
        await page.keyboard.press('ArrowDown');
      }
      await browserExpect(sport).toHaveValue('american-football');
      const league = page.locator('select[aria-label="League"]');
      if (kind === 'tv') {
        const leagueControl = page.getByRole('button', { name: 'League', exact: true });
        await page.keyboard.press('ArrowRight');
        await browserExpect(leagueControl).toBeFocused();
        await page.keyboard.press('Enter');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Escape');
        await browserExpect(leagueControl).toBeFocused();
        await browserExpect(league).toHaveValue('');
        await page.keyboard.press('Enter');
        await page.keyboard.press('ArrowDown');
        await page.keyboard.press('Enter');
      } else {
        await browserExpect(league).toBeVisible();
        await league.focus();
        await page.keyboard.press('ArrowDown');
      }
      await browserExpect(league).toHaveValue('nfl');
      const geometry = await page.locator('.sports-filter-controls').evaluate((node) => {
        const r = node.getBoundingClientRect();
        return {
          left: r.left,
          right: r.right,
          bottom: r.bottom,
          width: innerWidth,
          height: innerHeight,
          list: document.getElementById('channel-list')!.getBoundingClientRect().height,
          font: parseFloat(
            getComputedStyle(node.querySelector('button,select:not(.in-app-select-native)')!)
              .fontSize,
          ),
        };
      });
      expect(geometry.left).toBeGreaterThanOrEqual(0);
      expect(geometry.right).toBeLessThanOrEqual(geometry.width);
      expect(geometry.bottom).toBeLessThanOrEqual(geometry.height);
      expect(geometry.list).toBeGreaterThanOrEqual(52);
      expect(geometry.font).toBe(20);
      await browserExpect(page.locator('.sports-inclusion-status')).toBeVisible();
      await page.keyboard.press('Escape');
      await page.locator('.channel').first().focus();
      await page.keyboard.press('Enter');
      expect(await page.evaluate(() => Reflect.get(window, 'fixture').selected.length)).toBe(1);
    } finally {
      await close(page);
    }
  },
);

it('restores independent Free/Paid category, sport, search and geography through actual library selection', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.chooseCategory('sports');
      f.browser.setSportsFacet({ sport: 'american-football', league: 'nfl' });
      f.geography.restore({ filter: { country: 'US' }, sort: 'name' });
    });
    await page.locator('#search').fill('NFL');
    const free = await page.evaluate(() => Reflect.get(window, 'fixture').browser.getBrowseState());
    await page.locator('#paid-tv-button').click();
    await page.evaluate(() => Reflect.get(window, 'fixture').settle());
    expect(
      await page.evaluate(() => Reflect.get(window, 'fixture').browser.getBrowseState()),
    ).toMatchObject({ filter: 'all', query: '', sportsFacet: {}, geography: {}, sort: 'source' });
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.chooseCategory('ppv');
      f.geography.restore({ filter: { country: 'CA' }, sort: 'geography' });
    });
    await page.locator('#search').fill('cinema');
    const paid = await page.evaluate(() => Reflect.get(window, 'fixture').browser.getBrowseState());
    await page.locator('#live-tv-button').click();
    await page.evaluate(() => Reflect.get(window, 'fixture').settle());
    expect(
      await page.evaluate(() => Reflect.get(window, 'fixture').browser.getBrowseState()),
    ).toEqual(free);
    await browserExpect(page.locator('#search')).toHaveValue('NFL');
    await page.locator('#paid-tv-button').click();
    await page.evaluate(() => Reflect.get(window, 'fixture').settle());
    expect(
      await page.evaluate(() => Reflect.get(window, 'fixture').browser.getBrowseState()),
    ).toEqual(paid);
    await browserExpect(page.locator('#search')).toHaveValue('cinema');
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').queries.live)).toBe('cinema');
  } finally {
    await close(page);
  }
});

it('canceled and superseded account transitions retain the presented tab and do not seed Paid with Free choices', async () => {
  const page = await mount();
  try {
    await page.locator('#search').fill('Chicago Bears');
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.chooseCategory('sports');
      f.browser.setSportsFacet({ sport: 'american-football', league: 'nfl' });
    });
    const before = await page.evaluate(() =>
      Reflect.get(window, 'fixture').browser.getBrowseState(),
    );
    const outcome = await page.evaluate(async () => {
      const f = Reflect.get(window, 'fixture');
      const abort = new AbortController();
      const work = f.scope
        .selectAccountScope(f.metadata, abort.signal)
        .catch((error: Error) => error.name);
      abort.abort();
      return await work;
    });
    expect(outcome).toBe('AbortError');
    expect(
      await page.evaluate(() => Reflect.get(window, 'fixture').browser.getBrowseState()),
    ).toEqual(before);
    expect(
      await page.evaluate(() => Reflect.get(window, 'fixture').accounts.selectedAccount),
    ).toBeNull();
    await page.evaluate(async () => {
      const f = Reflect.get(window, 'fixture');
      await Promise.allSettled([
        f.scope.selectAccountScope(f.metadata),
        f.scope.selectAccountScope(null),
      ]);
    });
    expect(
      await page.evaluate(() => Reflect.get(window, 'fixture').browser.getBrowseState()),
    ).toEqual(before);
    await page.locator('#paid-tv-button').click();
    await page.evaluate(() => Reflect.get(window, 'fixture').settle());
    expect(
      await page.evaluate(() => Reflect.get(window, 'fixture').browser.getBrowseState()),
    ).toMatchObject({ filter: 'all', query: '', sportsFacet: {}, geography: {} });
  } finally {
    await close(page);
  }
});

it('hides live sport controls in unrelated libraries without changing their queries', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => Reflect.get(window, 'fixture').chooseCategory('sports'));
    for (const mode of ['genxtra', 'vod', 'web']) {
      await page.evaluate((value) => {
        const app = document.getElementById('app')!;
        app.dataset.contentLibrary = value === 'genxtra' ? 'genxtra' : 'live';
        app.dataset.vod = value === 'vod' ? 'open' : 'closed';
        app.classList.toggle('local-page-open', value === 'web');
      }, mode);
      await browserExpect(page.locator('#sports-filters')).toBeHidden();
      expect(
        await page.evaluate(() => Reflect.get(window, 'fixture').browser.getBrowseState().query),
      ).toBe('');
    }
  } finally {
    await close(page);
  }
});

it('holds a captured schedule window across same-scope redraws and preserves missing country choices while metadata loads', async () => {
  const page = await mount();
  try {
    await page.locator('#search').fill('NFL');
    const result = await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      const first = f.browser.getSportsScope();
      const originalNow = Date.now;
      try {
        Date.now = () => originalNow() + 3600000;
        f.browser.search('NFL');
        const redraw = f.browser.getSportsScope();
        f.browser.search('NBA');
        const changed = f.browser.getSportsScope();
        f.geography.restore({ filter: { country: 'GB' }, sort: 'name' });
        f.geography.update();
        return { first, redraw, changed, geography: f.browser.getGeographyFilter() };
      } finally {
        Date.now = originalNow;
      }
    });
    expect(result.redraw).toEqual(result.first);
    expect(result.changed.windowStartMs).toBeGreaterThan(result.first.windowStartMs);
    expect(result.geography).toEqual({ country: 'GB' });
    await browserExpect(page.locator('[data-code="GB"]')).toContainText('(0)');
  } finally {
    await close(page);
  }
});

it.each([
  {
    label: 'All Sports',
    facet: {},
    title: 'Syracuse vs Clemson (9.28.18) Football Replay',
  },
  {
    label: 'American Football',
    facet: { sport: 'american-football' },
    title: 'NFL live: New England Patriots versus Jacksonville Jaguars — regular season',
  },
  {
    label: 'NFL',
    facet: { sport: 'american-football', league: 'nfl' },
    title: 'NFL live: New England Patriots versus Jacksonville Jaguars — regular season',
  },
])(
  'native compact Sports keeps complete first and deep focused cards for $label',
  async ({ facet, title }) => {
    const page = await mount(832, 397, 'personal', true);
    try {
      await page.evaluate(
        ({ facet, title }) => {
          const f = Reflect.get(window, 'fixture');
          const rows = Array.from({ length: 50 }, (_, i) => ({
            id: `native-long-${i}`,
            sourceId: 'native-layout-fixture',
            name: 'ACC Digital Network',
            category: facet.sport ? 'NFL' : 'Sports',
          }));
          Reflect.set(window, 'nativeLayoutRows', rows);
          f.browser.update(rows, [], null);
          f.chooseCategory('sports');
          f.browser.setSportsFacet(facet);
          f.browser.setNowPlaying(
            rows.map((row) => ({
              catalogSourceId: row.sourceId,
              appChannelId: row.id,
              title,
              startMs: Date.now() - 1000,
              stopMs: Date.now() + 3600000,
            })),
          );
        },
        { facet, title },
      );
      await browserExpect(page.locator('#sports-filters')).toBeVisible();
      await browserExpect(page.locator('select[aria-label="Sport"]')).toBeVisible();
      expect(await page.locator('.in-app-select').count()).toBe(0);
      if (facet.sport) {
        await browserExpect(page.locator('select[aria-label="League"]')).toBeVisible();
        await browserExpect(page.locator('.sports-inclusion-status')).toContainText(
          'Matching PPV included',
        );
      }
      const first = page.locator('[data-channel="native-long-0"]');
      await browserExpect(first.locator('.media-result-title')).toHaveText(title);
      await browserExpect(first.locator('.channel-provider-label')).toHaveText(
        'ACC Digital Network',
      );
      await first.focus();
      const geometry = (id: string) =>
        page.evaluate((id) => {
          const node = document.querySelector<HTMLElement>(`[data-channel="${id}"]`)!;
          const list = document.getElementById('channel-list')!;
          const browser = list.closest<HTMLElement>('.browser')!;
          const footer = browser.querySelector<HTMLElement>('.sidefoot')!;
          const box = node.getBoundingClientRect();
          const l = list.getBoundingClientRect();
          const b = browser.getBoundingClientRect();
          const foot = footer.getBoundingClientRect();
          const clip = {
            top: Math.max(0, l.top, b.top),
            bottom: Math.min(innerHeight, l.bottom, b.bottom, foot.height ? foot.top : Infinity),
            left: Math.max(0, l.left, b.left),
            right: Math.min(innerWidth, l.right, b.right),
          };
          const texts = [
            '.media-result-title',
            '.channel-provider-label',
            '.media-result-subtitle',
          ].map((selector) => {
            const text = node.querySelector<HTMLElement>(selector)!;
            const range = document.createRange();
            range.selectNodeContents(text);
            const rects = [...range.getClientRects()].filter((r) => r.width && r.height);
            return {
              selector,
              text: text.textContent,
              rects: rects.map((r) => ({
                top: r.top,
                bottom: r.bottom,
                left: r.left,
                right: r.right,
              })),
              complete:
                rects.length > 0 &&
                text.scrollWidth <= text.clientWidth + 1 &&
                rects.every(
                  (r) =>
                    r.top >= clip.top - 1 &&
                    r.bottom <= clip.bottom + 1 &&
                    r.left >= clip.left - 1 &&
                    r.right <= clip.right + 1,
                ),
            };
          });
          return {
            focused: document.activeElement === node,
            box: { top: box.top, bottom: box.bottom, height: box.height },
            list: { top: l.top, bottom: l.bottom, height: l.height },
            browser: { top: b.top, bottom: b.bottom },
            footer: { top: foot.top, bottom: foot.bottom, height: foot.height },
            viewport: { width: innerWidth, height: innerHeight },
            clip,
            texts,
            offset: box.top - l.top,
            complete:
              document.activeElement === node &&
              box.top >= clip.top - 1 &&
              box.bottom <= clip.bottom + 1 &&
              texts.every((text) => text.complete),
          };
        }, id);
      const firstGeometry = await geometry('native-long-0');
      for (let i = 1; i <= 20; i++) {
        await page.keyboard.press('ArrowDown');
        await browserExpect(page.locator(`[data-channel="native-long-${i}"]`)).toBeFocused();
      }
      const deep = page.locator('[data-channel="native-long-20"]');
      await browserExpect(deep.locator('.media-result-title')).toHaveText(title);
      const deepGeometry = await geometry('native-long-20');
      await page.evaluate(() => {
        const f = Reflect.get(window, 'fixture');
        const rows = Reflect.get(window, 'nativeLayoutRows');
        f.browser.update([{ ...rows[0], id: 'native-inserted' }, ...rows], [], null);
      });
      await browserExpect(deep).toBeFocused();
      const refreshedGeometry = await geometry('native-long-20');
      expect(refreshedGeometry.offset).toBeCloseTo(deepGeometry.offset, 0);
      const phases = { first: firstGeometry, deep: deepGeometry, refreshed: refreshedGeometry };
      for (let i = 19; i >= 0; i--) {
        await page.keyboard.press('ArrowUp');
        await browserExpect(page.locator(`[data-channel="native-long-${i}"]`)).toBeFocused();
      }
      await page.keyboard.press('ArrowUp');
      await browserExpect(page.locator('[data-channel="native-inserted"]')).toBeFocused();
      let returnedToSelector = false;
      for (let i = 0; i < 6; i++) {
        await page.keyboard.press('ArrowUp');
        returnedToSelector = await page.evaluate(
          () =>
            document.activeElement instanceof HTMLSelectElement &&
            !!document.activeElement.closest('.browse-options'),
        );
        if (returnedToSelector) break;
      }
      const returnGeometry = await page.evaluate(() => {
        const control = document.activeElement as HTMLElement;
        const r = control.getBoundingClientRect();
        const browser = document.querySelector('.browser')!.getBoundingClientRect();
        return {
          control: control.getAttribute('aria-label') ?? control.id,
          top: r.top,
          bottom: r.bottom,
          browserTop: browser.top,
          browserBottom: browser.bottom,
          viewportHeight: innerHeight,
          complete:
            r.top >= Math.max(0, browser.top) - 1 &&
            r.bottom <= Math.min(innerHeight, browser.bottom) + 1,
        };
      });
      expect(returnedToSelector, JSON.stringify(returnGeometry)).toBe(true);
      expect(returnGeometry.complete, JSON.stringify(returnGeometry)).toBe(true);
      expect(
        Object.values(phases).every((result) => result.complete),
        JSON.stringify({ facet, phases }),
      ).toBe(true);
    } finally {
      await close(page);
    }
  },
);

it('does not reveal an offscreen focused card after background programme growth', async () => {
  const page = await mount(832, 397, 'personal', true);
  try {
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.browser.update(
        Array.from({ length: 8 }, (_, i) => ({
          id: `offscreen-${i}`,
          sourceId: 'offscreen-fixture',
          name: 'ACC Digital Network',
          category: 'NFL',
        })),
        [],
        null,
      );
      f.chooseCategory('sports');
      f.browser.setSportsFacet({ sport: 'american-football', league: 'nfl' });
      // A retained status region can place the list below the scrolling controls.
      // This controlled geometry leaves the old row focused while the user
      // scrolls the sidebar back to those controls before metadata arrives.
      const status = document.createElement('p');
      status.textContent = 'Retained source status';
      status.style.cssText = 'height:360px;flex:0 0 360px;margin:0';
      document.getElementById('channel-list')!.before(status);
    });
    await page.locator('[data-channel="offscreen-0"]').focus();
    await page.keyboard.press('ArrowDown');
    const target = page.locator('[data-channel="offscreen-1"]');
    await browserExpect(target).toBeFocused();
    const beforeHeight = await page
      .locator('#channel-list')
      .evaluate((node) =>
        parseFloat((node as HTMLElement).style.getPropertyValue('--channel-row-height')),
      );
    const hidden = await page.evaluate(() => {
      const sidebar = document.querySelector<HTMLElement>('.browser')!;
      sidebar.scrollTop = 0;
      const focused = document.activeElement!.getBoundingClientRect();
      return {
        scrollTop: sidebar.scrollTop,
        focusedTop: focused.top,
        sidebarBottom: sidebar.getBoundingClientRect().bottom,
      };
    });
    expect(hidden.scrollTop).toBe(0);
    expect(hidden.focusedTop).toBeGreaterThan(hidden.sidebarBottom);
    await page.evaluate(() => {
      Reflect.get(window, 'fixture').browser.setNowPlaying([
        {
          catalogSourceId: 'offscreen-fixture',
          appChannelId: 'offscreen-1',
          title:
            'NFL live: New England Patriots versus Jacksonville Jaguars — complete regular season replay with every drive and postgame analysis',
          startMs: Date.now() - 1000,
          stopMs: Date.now() + 3600000,
        },
      ]);
    });
    await expect
      .poll(() =>
        page
          .locator('#channel-list')
          .evaluate((node) =>
            parseFloat((node as HTMLElement).style.getPropertyValue('--channel-row-height')),
          ),
      )
      .toBeGreaterThan(beforeHeight);
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await browserExpect(target).toBeFocused();
    expect(
      await page.locator('.browser').evaluate((node) => node.scrollTop),
      'An offscreen focused row is not an intent to leave the controls when new metadata grows.',
    ).toBe(0);
  } finally {
    await close(page);
  }
});

it('pages oversized text within the focused card before advancing and returns Up to controls', async () => {
  const page = await mount(832, 397, 'personal', true);
  try {
    await page.addStyleTag({
      content:
        '#app #channel-list .channel-copy :is(strong,small){font-size:20px!important;line-height:1.25!important}',
    });
    const title =
      'NFL live: New England Patriots versus Jacksonville Jaguars — ' +
      Array.from({ length: 24 }, (_, i) => `drive ${i + 1} replay`).join(' ');
    await page.evaluate((title) => {
      const f = Reflect.get(window, 'fixture');
      f.browser.update(
        Array.from({ length: 3 }, (_, i) => ({
          id: `oversized-${i}`,
          sourceId: 'oversized-fixture',
          name: 'ACC Digital Network',
          category: 'NFL',
        })),
        [],
        null,
      );
      f.chooseCategory('sports');
      f.browser.setSportsFacet({ sport: 'american-football', league: 'nfl' });
      f.browser.setNowPlaying(
        ['oversized-0', 'oversized-1', 'oversized-2'].map((id, i) => ({
          catalogSourceId: 'oversized-fixture',
          appChannelId: id,
          title: i === 0 ? title : `NFL highlights ${i}`,
          startMs: Date.now() - 1000,
          stopMs: Date.now() + 3600000,
        })),
      );
    }, title);
    const target = page.locator('[data-channel="oversized-0"]');
    await browserExpect(target.locator('.media-result-title')).toHaveText(title);
    await target.focus();
    await page.keyboard.press('Home');
    const snapshot = () =>
      page.evaluate(() => {
        const node = document.querySelector<HTMLElement>('[data-channel="oversized-0"]')!;
        const sidebar = node.closest<HTMLElement>('.browser')!;
        const list = node.closest<HTMLElement>('#channel-list')!;
        const b = sidebar.getBoundingClientRect();
        const l = list.getBoundingClientRect();
        const top = Math.max(0, b.top, l.top);
        const bottom = Math.min(innerHeight, b.bottom, l.bottom);
        const lines = (selector: string) => {
          const range = document.createRange();
          range.selectNodeContents(node.querySelector(selector)!);
          return [...range.getClientRects()]
            .filter((r) => r.width && r.height)
            .map((r) => r.top >= top - 1 && r.bottom <= bottom + 1);
        };
        return {
          focus: (document.activeElement as HTMLElement)?.dataset.channel,
          rowHeight: node.getBoundingClientRect().height,
          sidebarHeight: b.height,
          scrollTop: sidebar.scrollTop,
          title: lines('.media-result-title'),
          provider: lines('.channel-provider-label').some(Boolean),
          time: lines('.media-result-subtitle').some(Boolean),
        };
      });
    const first = await snapshot();
    expect(first.rowHeight).toBeGreaterThan(first.sidebarHeight);
    expect(first.title[0]).toBe(true);
    const covered = new Set<number>();
    let sawProvider = false;
    let sawTime = false;
    let retainedSteps = 0;
    let advanced = false;
    for (let step = 0; step < 12; step++) {
      const state = await snapshot();
      state.title.forEach((shown, i) => shown && covered.add(i));
      sawProvider ||= state.provider;
      sawTime ||= state.time;
      await page.keyboard.press('ArrowDown');
      const focused = await page.evaluate(
        () => (document.activeElement as HTMLElement)?.dataset.channel,
      );
      if (focused === 'oversized-1') {
        advanced = true;
        break;
      }
      expect(focused).toBe('oversized-0');
      retainedSteps++;
    }
    expect(
      retainedSteps,
      'Down must reveal the same card before moving to the next one.',
    ).toBeGreaterThan(0);
    expect(advanced).toBe(true);
    expect(covered.size, 'Every wrapped title line must become readable.').toBe(first.title.length);
    expect(sawProvider).toBe(true);
    expect(sawTime).toBe(true);
    const readableShortCard = (id: string) =>
      page.evaluate((id) => {
        // Virtualization may replace the element after locator resolution.
        // Resolve the current logical row and measure it in the same task.
        const node = document.querySelector<HTMLElement>(`[data-channel="${id}"]`)!;
        const b = node.closest<HTMLElement>('.browser')!.getBoundingClientRect();
        const l = node.closest<HTMLElement>('#channel-list')!.getBoundingClientRect();
        const top = Math.max(0, b.top, l.top);
        const bottom = Math.min(innerHeight, b.bottom, l.bottom);
        const texts = [
          '.media-result-title',
          '.channel-provider-label',
          '.media-result-subtitle',
        ].map((selector) => {
          const text = node.querySelector<HTMLElement>(selector)!;
          const range = document.createRange();
          range.selectNodeContents(text);
          const rects = [...range.getClientRects()].filter((r) => r.width && r.height);
          return {
            selector,
            text: text.textContent,
            complete:
              rects.length > 0 && rects.every((r) => r.top >= top - 1 && r.bottom <= bottom + 1),
          };
        });
        return { focused: document.activeElement === node, texts };
      }, id);
    const nextShort = await readableShortCard('oversized-1');
    expect(nextShort.focused).toBe(true);
    expect(
      nextShort.texts.every((text) => text.complete),
      JSON.stringify(nextShort),
    ).toBe(true);
    await page.keyboard.press('ArrowDown');
    await browserExpect(page.locator('[data-channel="oversized-2"]')).toBeFocused();
    const lastShort = await readableShortCard('oversized-2');
    expect(
      lastShort.texts.every((text) => text.complete),
      JSON.stringify(lastShort),
    ).toBe(true);
    await page.keyboard.press('ArrowUp');
    await browserExpect(page.locator('[data-channel="oversized-1"]')).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await browserExpect(target).toBeFocused();
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowDown');
    await browserExpect(target).toBeFocused();
    expect((await snapshot()).title[0]).toBe(false);
    let upPages = 0;
    while (!(await snapshot()).title[0] && upPages < 12) {
      await page.keyboard.press('ArrowUp');
      await browserExpect(target).toBeFocused();
      upPages++;
    }
    expect(upPages).toBeGreaterThan(0);
    expect((await snapshot()).title[0]).toBe(true);
    let returnedToControls = false;
    for (let step = 0; step < 6; step++) {
      await page.keyboard.press('ArrowUp');
      returnedToControls = await page.evaluate(() => {
        const control = document.activeElement;
        if (!(control instanceof HTMLSelectElement) || !control.closest('.browse-options'))
          return false;
        const r = control.getBoundingClientRect();
        const b = control.closest('.browser')!.getBoundingClientRect();
        return r.top >= Math.max(0, b.top) - 1 && r.bottom <= Math.min(innerHeight, b.bottom) + 1;
      });
      if (returnedToControls) break;
    }
    expect(returnedToControls).toBe(true);
  } finally {
    await close(page);
  }
});

it.each([
  { width: 960, height: 540, kind: 'tv', fontSize: null },
  { width: 832, height: 397, kind: 'personal', fontSize: null },
  { width: 960, height: 540, kind: 'tv', fontSize: 20 },
  { width: 832, height: 397, kind: 'personal', fontSize: 20 },
])(
  'shows the entire cached matchup on a nonfirst virtual row and retains its focused identity at $width×$height with text $fontSize',
  async ({ width, height, kind, fontSize }) => {
    const page = await mount(width, height, kind);
    try {
      if (fontSize)
        await page.addStyleTag({
          content: `#app #channel-list .channel-copy :is(strong,small){font-size:${fontSize}px!important}`,
        });
      await page.evaluate(() => {
        const f = Reflect.get(window, 'fixture');
        f.browser.update(
          Array.from({ length: 80 }, (_, i) => ({
            id: `long-${i}`,
            sourceId: 'matchup-fixture',
            name: `Provider channel ${i}`,
            category: 'NFL',
          })),
          [],
          null,
        );
        document.getElementById('channel-list')!.scrollTop = 40 * 72;
      });
      const target = page.locator('[data-channel="long-40"]');
      await browserExpect(target).toBeVisible();
      await target.focus();
      const before = await page.evaluate(
        () => document.querySelector('[data-channel="long-40"]')!.getBoundingClientRect().top,
      );
      const title =
        'NFL live: New England Patriots versus Jacksonville Jaguars — regular season, complete matchup';
      await page.evaluate(
        (text) =>
          Reflect.get(window, 'fixture').browser.setNowPlaying([
            {
              catalogSourceId: 'matchup-fixture',
              appChannelId: 'long-40',
              title: text,
              startMs: Date.now() - 1000,
              stopMs: Date.now() + 3600000,
            },
          ]),
        title,
      );
      await browserExpect(target.locator('.media-result-subtitle')).toHaveText(title);
      const geometry = () =>
        page.evaluate(() => {
          // Resolve and measure in one task. The virtual list can replace an
          // ElementHandle between locator resolution and evaluation while
          // correctly restoring focus to the same logical row.
          const node = document.querySelector<HTMLElement>('[data-channel="long-40"]')!;
          const line = node.querySelector<HTMLElement>('.media-result-subtitle')!;
          const copy = node.querySelector<HTMLElement>('.channel-copy')!;
          const box = node.getBoundingClientRect();
          const list = document.getElementById('channel-list')!.getBoundingClientRect();
          const style = getComputedStyle(node);
          return {
            scrollWidth: line.scrollWidth,
            width: line.clientWidth,
            copyHeight: copy.getBoundingClientRect().height,
            padding:
              parseFloat(style.paddingTop) +
              parseFloat(style.paddingBottom) +
              parseFloat(style.borderTopWidth) +
              parseFloat(style.borderBottomWidth),
            buttonHeight: box.height,
            top: box.top,
            listTop: list.top,
            listBottom: list.bottom,
            height: box.height,
            focused: document.activeElement === node,
            active: {
              tag: document.activeElement?.tagName,
              id: document.activeElement?.id,
              channel: (document.activeElement as HTMLElement)?.dataset.channel,
            },
          };
        });
      await expect
        .poll(async () => {
          const r = await geometry();
          return r.width > 0 && r.scrollWidth <= r.width + 1;
        })
        .toBe(true);
      await expect
        .poll(async () => {
          const r = await geometry();
          return r.copyHeight + r.padding - r.buttonHeight;
        })
        .toBeLessThanOrEqual(1);
      const after = await geometry();
      expect(after.focused, JSON.stringify(after)).toBe(true);
      expect(after.top).toBeGreaterThanOrEqual(after.listTop - 1);
      expect(after.top).toBeLessThan(after.listBottom);
      if (!fontSize)
        expect(after.top + after.height, JSON.stringify(after)).toBeLessThanOrEqual(
          after.listBottom + 1,
        );
      await browserExpect(target.locator('.media-result-title')).toHaveText('Provider channel 40');
      // A new row above the focused item keeps its identity and the current compensated offset.
      const offset = after.top - after.listTop;
      await page.evaluate(() => {
        const f = Reflect.get(window, 'fixture');
        f.browser.update(
          [
            { id: 'inserted', sourceId: 'matchup-fixture', name: 'Inserted', category: 'NFL' },
            ...Array.from({ length: 80 }, (_, i) => ({
              id: `long-${i}`,
              sourceId: 'matchup-fixture',
              name: `Provider channel ${i}`,
              category: 'NFL',
            })),
          ],
          [],
          null,
        );
      });
      await browserExpect(target).toBeFocused();
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.querySelector('[data-channel="long-40"]')!.getBoundingClientRect().top -
              document.getElementById('channel-list')!.getBoundingClientRect().top,
          ),
        )
        .toBeCloseTo(offset, 0);
      expect(before).toBeGreaterThanOrEqual(0);
    } finally {
      await close(page);
    }
  },
);

it.each([
  { width: 960, height: 540, kind: 'tv' },
  { width: 832, height: 397, kind: 'personal' },
])(
  'shows a complete long channel name without programme metadata at $width×$height',
  async ({ width, height, kind }) => {
    const page = await mount(width, height, kind);
    try {
      const name = 'US | National Collegiate Athletic Association American Football Network HD';
      await page.evaluate((title) => {
        Reflect.get(window, 'fixture').browser.update(
          Array.from({ length: 80 }, (_, i) => ({
            id: `plain-${i}`,
            sourceId: 'plain-fixture',
            name: i === 40 ? title : `Provider channel ${i}`,
            category: 'Sports',
          })),
          [],
          null,
        );
        document.getElementById('channel-list')!.scrollTop = 40 * 72;
      }, name);
      const target = page.locator('[data-channel="plain-40"]');
      await browserExpect(target).toBeVisible();
      await target.focus();
      await browserExpect(target.locator('.media-result-title')).toHaveText(name);
      await expect
        .poll(() =>
          page.evaluate(() => {
            const node = document.querySelector<HTMLElement>('[data-channel="plain-40"]')!;
            const title = node.querySelector<HTMLElement>('.media-result-title')!;
            const copy = node.querySelector<HTMLElement>('.channel-copy')!;
            const box = node.getBoundingClientRect();
            const list = document.getElementById('channel-list')!.getBoundingClientRect();
            return (
              title.scrollWidth <= title.clientWidth + 1 &&
              copy.getBoundingClientRect().height <= box.height &&
              box.top >= list.top - 1 &&
              box.bottom <= list.bottom + 1 &&
              document.activeElement === node
            );
          }),
        )
        .toBe(true);
      expect(
        await target
          .locator('.media-result-title')
          .evaluate((node) => node.classList.contains('channel-event-title')),
      ).toBe(false);
    } finally {
      await close(page);
    }
  },
);

it('uses cached programme league evidence for full opponent names and leaves ambiguous raw titles intact', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      f.browser.update(
        [
          {
            id: 'known',
            sourceId: 'matchup',
            name: 'FOX original provider label',
            category: 'General',
          },
          {
            id: 'ambiguous',
            sourceId: 'matchup',
            name: 'Other original provider label',
            category: 'General',
          },
        ],
        [],
        null,
      );
      f.browser.setNowPlaying(
        ['known', 'ambiguous'].map((id) => ({
          catalogSourceId: 'matchup',
          appChannelId: id,
          title: 'Week 9: Bears vs Packers (Replay)',
          startMs: Date.now() - 1000,
          stopMs: Date.now() + 3600000,
          ...(id === 'known' ? { categories: [{ text: 'NFL' }] } : {}),
        })),
      );
    });
    await browserExpect(page.locator('[data-channel="known"] .media-result-subtitle')).toHaveText(
      'Week 9: Chicago Bears vs Green Bay Packers (Replay)',
    );
    await browserExpect(page.locator('[data-channel="known"] .media-result-title')).toHaveText(
      'FOX original provider label',
    );
    await browserExpect(
      page.locator('[data-channel="ambiguous"] .media-result-subtitle'),
    ).toHaveText('Week 9: Bears vs Packers (Replay)');
    expect(await page.locator('[data-channel="known"]').getAttribute('aria-label')).toContain(
      'Bears vs Packers',
    );
  } finally {
    await close(page);
  }
});

it('invalidates cached matchup text when programme or in-place channel league evidence changes', async () => {
  const page = await mount();
  try {
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      Reflect.set(window, 'matchupChannel', {
        id: 'cached-matchup',
        sourceId: 'matchup',
        name: 'Original provider label',
        category: 'General',
      });
      const row = Reflect.get(window, 'matchupChannel');
      f.browser.update([row], [], null);
      Reflect.set(
        window,
        'presentMatchup',
        (category: string | undefined, title = 'Bears vs Packers') =>
          f.browser.setNowPlaying([
            {
              catalogSourceId: 'matchup',
              appChannelId: row.id,
              title,
              startMs: Date.now() - 1000,
              stopMs: Date.now() + 3600000,
              ...(category ? { categories: [{ text: category }] } : {}),
            },
          ]),
      );
      Reflect.get(window, 'presentMatchup')('NFL');
    });
    const title = page.locator('[data-channel="cached-matchup"] .media-result-subtitle');
    await browserExpect(title).toHaveText('Chicago Bears vs Green Bay Packers');
    await page.evaluate(() => Reflect.get(window, 'presentMatchup')('NBA'));
    await browserExpect(title).toHaveText('Bears vs Packers');
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      const row = Reflect.get(window, 'matchupChannel');
      row.category = 'NFL';
      f.browser.update([row], [], null);
      Reflect.get(window, 'presentMatchup')(undefined);
    });
    await browserExpect(title).toHaveText('Chicago Bears vs Green Bay Packers');
    await page.evaluate(() => {
      const f = Reflect.get(window, 'fixture');
      const row = Reflect.get(window, 'matchupChannel');
      row.category = 'NBA';
      f.browser.update([row], [], null);
    });
    await browserExpect(title).toHaveText('Bears vs Packers');
    await page.evaluate(() => Reflect.get(window, 'presentMatchup')('NFL', 'Bills at Jaguars'));
    await browserExpect(title).toHaveText('Buffalo Bills at Jacksonville Jaguars');
  } finally {
    await close(page);
  }
});
