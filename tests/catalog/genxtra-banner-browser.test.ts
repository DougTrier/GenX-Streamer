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

import { afterAll, beforeAll, expect, it } from 'vitest';
import { build } from 'vite';
import { readFile, writeFile } from 'node:fs/promises';
import { chromium, expect as browserExpect, type Browser, type Page } from '@playwright/test';

let browser: Browser, bundle: string, css: string;
beforeAll(async () => {
  bundle = '';
  for (const [file, name] of [
    ['shell', 'GenxtraShell'],
    ['archive-search', 'GenxtraLayout'],
    ['in-app-select', 'GenxtraSelects'],
    ['selected-guide', 'GenxtraGuide'],
    ['speech-search', 'GenxtraSpeech'],
    ['channel-browser', 'LiveRows'],
    ['fullscreen-presentation', 'LayoutFullscreen'],
    ['vod-dock', 'LayoutVODDock'],
    ['video-quality', 'LayoutQuality'],
    ['../../tests/catalog/fixtures/tv-dock-audio', 'LayoutAudio'],
  ]) {
    const result = await build({
      configFile: false,
      logLevel: 'silent',
      build: {
        write: false,
        lib: { entry: `src/ui/${file}.ts`, name, formats: ['iife'] },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (!output || !('output' in output)) throw new Error('Missing GenXtra fixture bundle');
    const chunk = output.output.find((entry) => entry.type === 'chunk');
    if (!chunk || chunk.type !== 'chunk') throw new Error('Missing GenXtra fixture code');
    bundle += `${chunk.code}\n`;
  }
  // Include the real global cascade, not only the component stylesheet. In particular,
  // responsive.css supplies the generic filter pseudo icon that caused the regression.
  css = (
    await Promise.all(
      [
        'archive-search',
        'style',
        'fullscreen',
        'video-quality',
        'guide',
        'responsive',
        'in-app-select',
        'genxtra',
        'media-results',
        'tv-density',
      ].map((name) => readFile(`src/ui/${name}.css`, 'utf8')),
    )
  ).join('\n');
  for (const font of [
    'yellowtail/Yellowtail-Regular.ttf',
    'roboto-condensed/RobotoCondensed-Variable.ttf',
  ]) {
    const bytes = await readFile(`assets/fonts/${font}`);
    css = css.replace(
      `../../assets/fonts/${font}`,
      `data:font/ttf;base64,${bytes.toString('base64')}`,
    );
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});

async function mount(width: number, height: number, tv = false, withFiles = false): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height } });
  // A controlled loopback document preserves real secure-context APIs used by
  // the audio attachment owner; no network listener or crypto replacement.
  await page.route('http://localhost/controlled-layout', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><div id="app"></div>' }),
  );
  await page.goto('http://localhost/controlled-layout');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    async ({ narrow, tv, withFiles }) => {
      const module = Reflect.get(window, 'GenxtraLayout');
      const app = document.getElementById('app')!;
      Reflect.get(window, 'GenxtraShell').createShell(app);
      app.dataset.deviceKind = tv ? 'tv' : narrow ? 'handheld' : 'desktop';
      app.dataset.contentLibrary = 'genxtra';
      app.classList.toggle('compact-content', narrow);
      app.dataset.compactView = 'channels';
      if (tv) {
        document.getElementById('cast-button')!.hidden = true;
        // The real TV capability disables casting before the viewing shell is shown.
        document.documentElement.style.setProperty('--sidebar', '360px');
      }
      for (const id of ['genxtra-browse-filters', 'genxtra-library'])
        document.getElementById(id)!.hidden = false;
      const yearStatus = document.getElementById('genxtra-filter-status')!;
      yearStatus.hidden = false;
      yearStatus.textContent = 'All years · Original release metadata';
      const input = document.getElementById('search') as HTMLInputElement;
      input.value = 'Controlled layout';
      const speech = Reflect.get(window, 'GenxtraSpeech').mountSpeechSearch(
        document.getElementById('speech-control'),
        input,
        {
          recognizer: {
            capability: async () => {
              throw Error('Unexpected voice activation');
            },
            recognize: async () => {
              throw Error('Unexpected recognition');
            },
            cancel: async () => {},
            dispose: async () => {},
          },
          notice: () => {},
        },
      );
      Reflect.set(window, 'layoutSpeech', speech);
      document.getElementById('clear-search')!.hidden = false;
      const titleRef = 'a'.repeat(64);
      const title = {
        titleRef,
        title: 'Controlled layout fixture',
        kind: 'tv',
        contentType: 'tv',
        contentTypeProvenance: 'provider-item',
        releaseYear: 1972,
        curated: true,
        titleProvenance: 'provider-item',
        fileCount: withFiles ? 2 : 1,
        durationSeconds: 120,
        rights: null,
        rank: 1,
        quality: 'metadata-h264',
        observedMs: 1,
        favorite: false,
      };
      // Decode actual JPEG bytes with the same 180x135 natural dimensions as the
      // packaged failure. This is controlled display data, never production content.
      const canvas = document.createElement('canvas');
      canvas.width = 180;
      canvas.height = 135;
      const context = canvas.getContext('2d')!;
      context.fillStyle = '#369';
      context.fillRect(0, 0, 180, 135);
      context.fillStyle = '#fc3';
      context.fillRect(0, 0, 20, 20);
      context.fillRect(160, 115, 20, 20);
      const dataUrl = canvas.toDataURL('image/jpeg');
      Reflect.set(window, 'selections', []);
      const activity = { queries: 0, discoveries: 0, language: 'english-first' };
      Reflect.set(window, 'layoutActivity', activity);
      const ui = module.mountArchiveSearch(document.getElementById('genxtra-library'), {
        input,
        detailsContainer: document.getElementById('archive-details'),
        readyScope: () => 'controlled-layout',
        playbackActive: () => Reflect.get(window, 'fixturePlaying') === true,
        onTitleSelected: () => {
          app.dataset.compactView = 'watch';
        },
        onSelect: async () => Reflect.get(window, 'selections').push('unexpected-play'),
        onFavorite: async () => {
          throw Error('Unexpected fixture favorite activation');
        },
        artwork: async (request: { titleRef: string }) => ({
          schemaVersion: 1,
          titleRef: request.titleRef,
          revision: '1',
          artworkRef: 'c'.repeat(64),
          mimeType: 'image/jpeg',
          width: 180,
          height: 135,
          byteLength: atob(dataUrl.split(',')[1]).length,
          dataUrl,
        }),
        catalog: {
          query: async (request: { languageMode: string }) => {
            activity.queries++;
            activity.language = request.languageMode;
            const items = Array.from({ length: tv ? 12 : 1 }, (_, i) => ({
              ...title,
              titleRef: (i + 1).toString(16).padStart(64, '0'),
              title: `Controlled layout fixture ${i + 1}`,
            }));
            // Preserve the original first title authority used by the JPEG fixture.
            items[0]!.titleRef = titleRef;
            return {
              schemaVersion: 1,
              revision: '1',
              totalCount: items.length,
              offset: 0,
              items,
              more: false,
            };
          },
          files: async () => ({
            schemaVersion: 1,
            revision: '1',
            titleRef,
            totalCount: withFiles ? 2 : 0,
            offset: 0,
            files: withFiles
              ? [0, 1].map((index) => ({
                  fileRef: (index ? 'd' : 'b').repeat(64),
                  title: `Controlled episode ${index + 1}`,
                  fileName: `controlled-${index + 1}.mp4`,
                  itemId: 'controlled-layout',
                  format: 'h.264',
                  durationSeconds: 120,
                  sizeBytes: '1024',
                  availability: 'unverified',
                  observedMs: 1,
                }))
              : [],
            more: false,
          }),
        },
        discover: async () => {
          activity.discoveries++;
          return { revision: '1', outcome: 'partial' };
        },
      });
      Reflect.set(window, 'archiveLayout', ui);
      await ui.resume(input.value);
      if (tv)
        Reflect.set(
          window,
          'layoutSelects',
          Reflect.get(window, 'GenxtraSelects').installInAppSelects(document.body),
        );
      await document.fonts.ready;
    },
    { narrow: width < 650, tv, withFiles },
  );
  return page;
}

it.each([
  { width: 960, height: 540, tv: true },
  { width: 1280, height: 800, tv: false },
  { width: 854, height: 432, tv: false },
])(
  'Live video fills its pane without selected guide or mapping controls at $width×$height',
  async ({ width, height, tv }) => {
    const page = await mount(width, height, tv);
    try {
      await page.evaluate(() => {
        const app = document.getElementById('app')!;
        app.dataset.contentLibrary = 'live';
        app.dataset.compactView = 'watch';
        document.getElementById('archive-details')!.hidden = true;
        document.getElementById('genxtra-library')!.hidden = true;
        document.getElementById('genxtra-browse-filters')!.hidden = true;
        const rows = new (Reflect.get(window, 'LiveRows').ChannelBrowser)(
          document.getElementById('channel-list'),
          () => {
            throw Error('Unexpected playback');
          },
        );
        rows.update(
          [{ id: 'live-fixture', sourceId: 's', name: 'Fixture channel', category: 'News' }],
          [],
          null,
        );
        Reflect.set(window, 'livePaneRows', rows);
      });
      const retained = await page.locator('#video').elementHandle();
      const measure = () =>
        page.evaluate(() => {
          const rect = (selector: string) => {
            const r = document.querySelector(selector)!.getBoundingClientRect();
            return {
              top: r.top,
              bottom: r.bottom,
              left: r.left,
              right: r.right,
              width: r.width,
              height: r.height,
            };
          };
          return {
            view: rect('.view'),
            card: rect('.watch-card'),
            screen: rect('#screen'),
            video: rect('#video'),
            dock: rect('.watch-card > .dock'),
            viewPaddingBottom:
              parseFloat(getComputedStyle(document.querySelector('.view')!).paddingBottom) || 0,
            screenInner: {
              width: document.getElementById('screen')!.clientWidth,
              height: document.getElementById('screen')!.clientHeight,
            },
            padding:
              parseFloat(getComputedStyle(document.querySelector('.watch-card')!).paddingTop) || 0,
          };
        });
      const before = await measure();
      expect(
        await page
          .locator(
            '#selected-guide-details,#selected-guide-status-slot,.watch-card .selected-guide-map',
          )
          .count(),
      ).toBe(0);
      expect(await page.locator('.watchhead').isVisible()).toBe(false);
      expect(before.screen.top - before.card.top).toBeLessThanOrEqual(before.padding + 1);
      expect(before.screen.bottom).toBeLessThanOrEqual(before.dock.top + 1);
      expect(before.card.bottom).toBeCloseTo(before.view.bottom - before.viewPaddingBottom, 0);
      expect(before.screen.height).toBeGreaterThan(150);
      expect(before.video.height).toBeCloseTo(before.screenInner.height, 0);
      expect(before.video.width).toBeCloseTo(before.screenInner.width, 0);
      // Changing real saved-guide state belongs to the list/Guide page and cannot
      // allocate controls or replace the retained viewing video element.
      for (const mapped of [false, true]) {
        await page.evaluate((mapped) => {
          const at = 1700000000000;
          Reflect.get(window, 'livePaneRows').setGuideRows([
            {
              catalogSourceId: 's',
              appChannelId: 'live-fixture',
              status: 'ready',
              summary: {
                requestId: 'fixture',
                catalogSourceId: 's',
                appChannelId: 'live-fixture',
                atMs: at,
                catalogRevision: '1',
                databaseRevision: 1,
                mappingStatus: mapped ? 'mapped' : 'unmapped',
                mapping: mapped
                  ? {
                      catalogSourceId: 's',
                      appChannelId: 'live-fixture',
                      guideSourceId: 'g',
                      xmltvChannelId: 'x',
                    }
                  : null,
                sourceRevision: mapped ? 1 : null,
                publishedRevision: mapped ? 1 : null,
                updatedMs: mapped ? at : null,
                coverage: { startMs: null, endMs: null },
                cacheStatus: mapped ? 'current' : 'unavailable',
                currentStatus: mapped ? 'current' : null,
                nextStatus: 'none',
                current: mapped
                  ? {
                      title: 'Actual controlled current program',
                      startMs: at - 1000,
                      stopMs: at + 1000,
                    }
                  : null,
                next: null,
              },
            },
          ]);
        }, mapped);
        await page.waitForTimeout(30);
        expect(await measure()).toEqual(before);
        expect(await retained!.evaluate((node) => node === document.querySelector('#video'))).toBe(
          true,
        );
      }
      expect(await page.locator('#guide-button').isVisible()).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
    } finally {
      await page.close();
    }
  },
);

it('uses the same two-line TV card styling for actual Live and collapsed GenXtra renderers', async () => {
  const page = await mount(960, 540, true);
  try {
    const style = (selector: string) =>
      page
        .locator(selector)
        .first()
        .evaluate((node) => {
          const button = node.querySelector('.media-result-main,.gx-archive-title-button')!;
          const title = node.querySelector('.media-result-title,.gx-archive-result-name')!;
          const subtitle = node.querySelector(
            '.media-result-subtitle,.gx-archive-result-subtitle',
          )!;
          const tile = node.querySelector('.media-result-artwork,.gx-archive-result-artwork')!;
          const favorite = node.querySelector('.channel-favorite,.gx-archive-favorite')!;
          const rect = tile.getBoundingClientRect();
          return {
            height: node.getBoundingClientRect().height,
            background: getComputedStyle(node).backgroundImage,
            title: getComputedStyle(title).font,
            subtitle: getComputedStyle(subtitle).font,
            paddingTop: getComputedStyle(button).paddingTop,
            gap: getComputedStyle(button).gap,
            artwork: [rect.width, rect.height],
            favorite: getComputedStyle(favorite).color,
            favoriteSize: favorite.getBoundingClientRect().height,
          };
        });
    const archive = await style('.gx-archive-result-row');
    await page.screenshot({
      path: 'artifacts/tv-navigation/2026-10-15/tv-density-controlled-genxtra.png',
    });
    await page.evaluate(() => {
      const app = document.getElementById('app')!;
      app.dataset.contentLibrary = 'live';
      document.getElementById('genxtra-library')!.hidden = true;
      document.getElementById('genxtra-browse-filters')!.hidden = true;
      const rows = new (Reflect.get(window, 'LiveRows').ChannelBrowser)(
        document.getElementById('channel-list'),
        () => {
          throw Error('Unexpected Live playback');
        },
        undefined,
        undefined,
        { baseRowHeight: 52, onFavorite: () => {}, onManage: () => {} },
      );
      rows.update(
        [
          {
            id: 'controlled-live',
            sourceId: 'controlled-source',
            name: 'Controlled Live fixture',
            category: 'Controlled category',
          },
        ],
        [],
        null,
      );
      Reflect.set(window, 'layoutLiveRows', rows);
    });
    await browserExpect(page.locator('#channel-rows .media-result-row')).toBeVisible();
    await browserExpect.poll(() => style('#channel-rows .media-result-row')).toEqual(archive);
    const live = await style('#channel-rows .media-result-row');
    expect(live).toEqual(archive);
    expect(live).toMatchObject({ height: 52, artwork: [60, 44], favoriteSize: 34 });
    const management = page.locator('#channel-rows .channel-manage');
    await browserExpect(management).toHaveText('⌄');
    const managementBox = await management.boundingBox();
    const favoriteBox = await page.locator('#channel-rows .channel-favorite').boundingBox();
    expect(managementBox!.width).toBe(26);
    expect(managementBox!.height).toBe(34);
    expect(favoriteBox!.x).toBeGreaterThanOrEqual(managementBox!.x + managementBox!.width);
    for (const button of await page
      .locator('.browse-options .filters button:not([hidden])')
      .all()) {
      expect(await button.evaluate((node) => node.getBoundingClientRect().height)).toBe(34);
      expect(await button.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
      expect(await button.evaluate((node) => getComputedStyle(node).whiteSpace)).toBe('nowrap');
    }
    await page.screenshot({
      path: 'artifacts/tv-navigation/2026-10-15/tv-density-controlled-live.png',
    });
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'layoutLiveRows')?.dispose());
    await page.close();
  }
});

it('uses compact TV selectors and at least 225px of results with keyboard-accessible local filters at 960x540', async () => {
  const page = await mount(960, 540, true);
  try {
    const toggle = page.locator('.gx-archive-filter-toggle');
    await browserExpect(toggle).toHaveAttribute('aria-expanded', 'false');
    await browserExpect(page.locator('#genxtra-language')).toBeHidden();
    const density = await page.evaluate(() => {
      const toolbar = document.querySelector('.gx-archive-tools')!.getBoundingClientRect();
      const list = document.querySelector('.gx-archive-results')!.getBoundingClientRect();
      const row = document.querySelector('.gx-archive-result-row')!;
      const status = document.getElementById('genxtra-filter-status')!;
      const filters = document.getElementById('genxtra-browse-filters')!.getBoundingClientRect();
      return {
        toolbar: toolbar.height,
        toolbarGap: toolbar.top - filters.bottom,
        list: list.height,
        row: row.getBoundingClientRect().height,
        statusHeight: status.getBoundingClientRect().height,
        statusClip: getComputedStyle(status).clipPath,
        title: parseFloat(getComputedStyle(row.querySelector('.gx-archive-result-name')!).fontSize),
        subtitle: parseFloat(
          getComputedStyle(row.querySelector('.gx-archive-result-subtitle')!).fontSize,
        ),
        actions: [...row.querySelectorAll('button')].map(
          (node) => node.getBoundingClientRect().height,
        ),
      };
    });
    expect(density.toolbar).toBe(34);
    expect(density.toolbarGap).toBeGreaterThanOrEqual(8);
    expect(density.list).toBeGreaterThanOrEqual(225);
    expect(density.row).toBeGreaterThanOrEqual(52);
    expect(density.row).toBeLessThanOrEqual(56);
    expect(density).toMatchObject({ title: 17, subtitle: 13.5, statusHeight: 1 });
    expect(density.statusClip).toBe('inset(50%)');
    expect(density.actions[0]).toBeGreaterThanOrEqual(48);
    expect(density.actions.slice(1).every((height) => height >= 32)).toBe(true);
    for (const selector of ['#search-programs', '#clear-search', '.speech-search-button']) {
      const icon = await page.locator(selector).evaluate((node) => ({
        font: getComputedStyle(node).fontSize,
        scrollWidth: node.scrollWidth,
        width: node.clientWidth,
        scrollHeight: node.scrollHeight,
        height: node.clientHeight,
      }));
      expect(icon.scrollWidth).toBeLessThanOrEqual(icon.width);
      expect(icon.scrollHeight).toBeLessThanOrEqual(icon.height);
      if (selector === '#search-programs') expect(icon.font).toBe('0px');
    }
    const selectors = page.locator('#genxtra-browse-filters > .in-app-select > button');
    await browserExpect(selectors).toHaveCount(2);
    const selectorBoxes = await selectors.evaluateAll((nodes) =>
      nodes.map((node) => {
        const rect = node.getBoundingClientRect();
        const chevron = getComputedStyle(node, '::after');
        return {
          x: rect.x,
          y: rect.y,
          width: rect.width,
          height: rect.height,
          chevron: {
            content: chevron.content,
            width: chevron.width,
            height: chevron.height,
            border: chevron.borderRightStyle,
            color: chevron.borderRightColor,
            transform: chevron.transform,
            position: chevron.position,
            pointerEvents: chevron.pointerEvents,
          },
        };
      }),
    );
    expect(selectorBoxes[0]!.height).toBe(34);
    expect(selectorBoxes[1]!.height).toBe(34);
    expect(selectorBoxes[0]!.y).toBe(selectorBoxes[1]!.y);
    expect(selectorBoxes[1]!.x).toBeGreaterThan(selectorBoxes[0]!.x + selectorBoxes[0]!.width);
    for (const box of selectorBoxes) {
      expect(box.chevron).toMatchObject({
        content: '""',
        width: '6px',
        height: '6px',
        border: 'solid',
        color: 'rgb(138, 232, 243)',
        position: 'absolute',
        pointerEvents: 'none',
      });
      expect(box.chevron.transform).not.toBe('none');
    }
    expect(
      await page
        .locator('#genxtra-kind-select option')
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value)),
    ).toEqual(['all', 'tv', 'movie', 'short', 'favorites']);
    expect(
      await page
        .locator('#genxtra-decade-select option')
        .evaluateAll((nodes) => nodes.map((node) => (node as HTMLOptionElement).value)),
    ).toEqual(['all', '1960', '1970', '1980', '1990', '2000', '2010', '2020']);
    await writeFile(
      'artifacts/tv-navigation/2026-10-15/tv-density-geometry.json',
      JSON.stringify(
        {
          scope:
            'controlled Chrome fixture, production renderer/styles/TV select owner; no native decoder proof',
          viewport: [960, 540],
          ...density,
        },
        null,
        2,
      ),
    );
    await page.locator('#search').click();
    for (let i = 0; i < 20; i++) {
      await page.keyboard.press('Tab');
      if (await toggle.evaluate((node) => document.activeElement === node)) break;
    }
    await browserExpect(toggle).toBeFocused();
    await page.keyboard.press('Enter');
    await browserExpect(toggle).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('Tab');
    const languageTrigger = page.getByRole('button', { name: 'Browse video languages' });
    await browserExpect(languageTrigger).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await browserExpect
      .poll(() => page.evaluate(() => Reflect.get(window, 'layoutActivity').queries))
      .toBe(2);
    await page.keyboard.press('Escape');
    await browserExpect(toggle).toBeFocused();
    await browserExpect(toggle).toHaveAttribute('aria-expanded', 'false');
    await browserExpect(page.locator('#genxtra-language')).toBeHidden();
    expect(await page.evaluate(() => Reflect.get(window, 'layoutActivity'))).toEqual({
      queries: 2,
      discoveries: 0,
      language: 'english',
    });
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => Reflect.get(window, 'archiveLayout').dismissFilters())).toBe(
      true,
    );
    await browserExpect(toggle).toBeFocused();
    expect(await page.evaluate(() => Reflect.get(window, 'archiveLayout').dismissFilters())).toBe(
      false,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
    expect(await page.locator('video[src]').count()).toBe(0);
    await page.locator('.gx-archive-title-button').first().click();
    const player = await page.locator('#video').elementHandle();
    await page.evaluate(() => {
      Reflect.set(window, 'fixturePlaying', true);
      document.getElementById('app')!.dataset.playMode = 'on-demand';
      Reflect.get(window, 'archiveLayout').syncDetails();
    });
    await browserExpect(page.locator('#archive-details')).toBeHidden();
    await browserExpect(page.locator('.dock .channel-actions')).toBeHidden();
    const screen = await page.locator('#screen').boundingBox();
    expect(screen!.height).toBeGreaterThanOrEqual(260);
    expect(screen!.width).toBeGreaterThan(500);
    expect(await player!.evaluate((node) => node === document.querySelector('#video'))).toBe(true);
    for (const control of await page.locator('.dock .controls button:visible').all()) {
      const rect = await control.boundingBox();
      expect(rect!.height).toBe(34);
      expect(rect!.y + rect!.height).toBeLessThanOrEqual(540);
      expect(await control.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    }
    const dock = await page.locator('.dock').evaluate((node) => {
      const controls = [...node.querySelectorAll<HTMLElement>('button')].filter(
        (button) => button.getClientRects().length > 0,
      );
      const bounds = node.getBoundingClientRect();
      return controls.map((button) => {
        const rect = button.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          contained: rect.left >= bounds.left && rect.right <= bounds.right,
          textFits:
            button.scrollWidth <= button.clientWidth && button.scrollHeight <= button.clientHeight,
        };
      });
    });
    expect(dock.length).toBeGreaterThanOrEqual(4);
    expect(dock.every((button) => button.contained && button.textFits)).toBe(true);
    expect(new Set(dock.map((button) => button.top)).size).toBe(1);
    expect(
      await page.locator('.dock').evaluate((node) => node.getBoundingClientRect().height),
    ).toBe(34);
    await page.screenshot({
      path: 'artifacts/tv-navigation/2026-10-15/tv-density-controlled-playing.png',
    });
  } finally {
    await page.evaluate(() => Reflect.get(window, 'layoutSelects')?.dispose());
    await page.evaluate(() => Reflect.get(window, 'archiveLayout').dispose());
    await page.close();
  }
});

it('fits actual-font Play text on one line in the 42px TV episode action without changing its neighbors', async () => {
  const page = await mount(960, 540, true, true);
  try {
    await page.locator('.gx-archive-title-button').first().click();
    const play = page.locator('.gx-archive-file-button').first();
    await browserExpect(play).toHaveText('Play');
    const geometry = await play.evaluate((button) => {
      const box = button.getBoundingClientRect(),
        style = getComputedStyle(button);
      const range = document.createRange();
      range.selectNodeContents(button);
      const lines = [...range.getClientRects()].map((rect) => ({
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
        width: rect.width,
      }));
      const more = button.nextElementSibling!.querySelector('summary')!.getBoundingClientRect();
      return {
        width: box.width,
        height: box.height,
        font: style.font,
        size: style.fontSize,
        weight: style.fontWeight,
        available:
          button.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
        lines,
        moreWidth: more.width,
        moreHeight: more.height,
        gap: more.left - box.right,
      };
    });
    await writeFile(
      'artifacts/tv-navigation/2026-10-15/tv-play-text-geometry.json',
      JSON.stringify(geometry, null, 2),
    );
    await page.screenshot({ path: 'artifacts/tv-navigation/2026-10-15/tv-play-text.png' });
    expect(geometry).toMatchObject({
      width: 42,
      height: 34,
      size: '14px',
      weight: '600',
      moreWidth: 26,
      moreHeight: 34,
      gap: 8,
    });
    expect(geometry.lines).toHaveLength(1);
    expect(geometry.lines[0]!.width).toBeLessThanOrEqual(geometry.available);
    expect(geometry.lines[0]!.left).toBeGreaterThanOrEqual(geometry.left);
    expect(geometry.lines[0]!.right).toBeLessThanOrEqual(geometry.right);
    expect(geometry.lines[0]!.bottom).toBeLessThanOrEqual(geometry.bottom);
    const more = page.locator('.gx-archive-file-details > summary');
    await browserExpect(more.first()).toHaveText('⌄');
    await browserExpect(more.first()).toHaveAttribute(
      'aria-label',
      'Video details for Controlled episode 1',
    );
    // The real selected-file renderer reveals and focuses its first Play.
    await browserExpect(play).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await browserExpect(more.first()).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await browserExpect(more.nth(1)).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await browserExpect(page.locator('.gx-archive-file-button').nth(1)).toBeFocused();
    expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
  } finally {
    await page.close();
  }
});

it('sizes and centers the full TV capability dock to its text in normal and fullscreen views', async () => {
  const page = await mount(960, 540, true);
  try {
    await page.evaluate(() => {
      const video = document.querySelector<HTMLVideoElement>('video')!;
      const tracks = Object.assign(new EventTarget(), { length: 2 });
      for (let i = 0; i < 2; i++)
        Reflect.set(tracks, i, {
          enabled: i === 0,
          label: `Controlled track ${i}`,
          language: 'English supplementary description',
        });
      Object.defineProperty(video, 'audioTracks', { value: tracks, configurable: true });
      const audio = Reflect.get(window, 'LayoutAudio').createBrowserAudioTracks(video, {
        current: () => true,
        canSelect: () => true,
        emit: () => {},
        owners: Reflect.get(window, 'LayoutAudio').createResourceOwners(),
      });
      audio.activate();
      audio.attachNative();
      Reflect.set(window, 'dockAudioOwner', audio);
      Reflect.set(
        window,
        'dockAudioDispose',
        Reflect.get(window, 'LayoutAudio').installAudioTracks(
          video,
          document.getElementById('audio-tracks'),
        ),
      );
      Reflect.set(
        window,
        'dockQualityDispose',
        Reflect.get(window, 'LayoutQuality').installVideoQuality(
          video,
          document.getElementById('video-quality'),
          {
            read: () => ({
              auto: true,
              currentLevel: 0,
              availableLevels: [{ index: 0, height: 2160, bitrate: 8000000 }],
              levelsTruncated: false,
            }),
            set: () => {
              throw Error('Unexpected quality activation');
            },
          },
        ),
      );
      Reflect.set(
        window,
        'dockFullscreen',
        Reflect.get(window, 'LayoutFullscreen').installFullscreenPresentation(
          document.getElementById('app'),
        ),
      );
    });
    const measurements = [];
    for (const fullscreen of [false, true]) {
      await page.evaluate((active) => {
        Reflect.get(window, 'dockFullscreen').set(active);
        document.getElementById('fullscreen-button')!.textContent = active
          ? 'Exit full screen'
          : 'Full screen';
      }, fullscreen);
      const measured = await page.locator('.dock').evaluate((dock) => {
        const rect = dock.getBoundingClientRect();
        const buttons = [...dock.querySelectorAll<HTMLButtonElement>('button')].filter(
          (button) => button.getClientRects().length > 0,
        );
        return {
          left: rect.left,
          right: rect.right,
          height: rect.height,
          buttons: buttons.map((button) => {
            const box = button.getBoundingClientRect();
            const style = getComputedStyle(button);
            const range = document.createRange();
            range.selectNodeContents(button);
            return {
              label: button.getAttribute('aria-label') || button.textContent!,
              left: box.left,
              right: box.right,
              top: box.top,
              width: box.width,
              height: box.height,
              textWidth: range.getBoundingClientRect().width,
              padding: parseFloat(style.paddingLeft) + parseFloat(style.paddingRight),
              ellipsis: style.textOverflow === 'ellipsis',
              fullAccessibleLabel: button.getAttribute('aria-label'),
              textFits:
                button.scrollWidth <= button.clientWidth &&
                button.scrollHeight <= button.clientHeight,
            };
          }),
        };
      });
      measurements.push({ fullscreen, ...measured });
      expect(measured.buttons).toHaveLength(fullscreen ? 6 : 7);
      expect(new Set(measured.buttons.map((button) => button.top)).size).toBe(1);
      const first = measured.buttons[0]!,
        last = measured.buttons.at(-1)!;
      expect(first.left - measured.left).toBeCloseTo(measured.right - last.right, 0);
      for (let i = 0; i < measured.buttons.length; i++) {
        const button = measured.buttons[i]!;
        expect(button.height).toBe(34);
        expect(button.left).toBeGreaterThanOrEqual(measured.left);
        expect(button.right).toBeLessThanOrEqual(measured.right);
        if (i) expect(button.left - measured.buttons[i - 1]!.right).toBeGreaterThanOrEqual(8);
        if (button.ellipsis) {
          expect(button.width).toBeLessThanOrEqual(120);
          expect(button.fullAccessibleLabel).toMatch(/Video quality|Audio track/);
        } else {
          expect(button.textFits).toBe(true);
          expect(button.width).toBeLessThanOrEqual(
            Math.max(34, button.textWidth + button.padding + 30),
          );
        }
      }
      await page.screenshot({
        path: `artifacts/tv-navigation/2026-10-15/tv-content-width-${fullscreen ? 'fullscreen' : 'normal'}.png`,
      });
    }
    await page.getByRole('button', { name: 'Audio track', exact: true }).click();
    const audioChoice = page.getByRole('menuitemradio').filter({ hasText: 'Controlled track 0' });
    await browserExpect(audioChoice).toHaveAttribute('title', /English supplementary description/);
    await page.keyboard.press('Escape');
    await page.evaluate(() => {
      Reflect.get(window, 'dockFullscreen').set(false);
      document.getElementById('fullscreen-button')!.textContent = 'Full screen';
      const vod = Reflect.get(window, 'LayoutVODDock').installVODDock(
        document.getElementById('app'),
      );
      vod.render(true);
      Reflect.set(window, 'dockVOD', vod);
      document.getElementById('vod-transport')!.hidden = false;
    });
    const vod = await page.locator('.dock').evaluate((node) => {
      const dock = node.getBoundingClientRect();
      const controls = [...node.querySelectorAll<HTMLElement>('button,output')].filter(
        (control) => control.getClientRects().length > 0,
      );
      return controls.map((control) => {
        const box = control.getBoundingClientRect();
        return {
          left: box.left,
          right: box.right,
          top: box.top,
          center: box.top + box.height / 2,
          height: box.height,
          contained: box.left >= dock.left && box.right <= dock.right,
        };
      });
    });
    expect(vod.every((control) => control.contained)).toBe(true);
    expect(new Set(vod.map((control) => control.center)).size).toBe(1);
    expect(vod.filter((control) => control.height === 34)).toHaveLength(8);
    for (let i = 1; i < vod.length; i++)
      expect(vod[i]!.left - vod[i - 1]!.right).toBeGreaterThanOrEqual(8);
    await page.screenshot({ path: 'artifacts/tv-navigation/2026-10-15/tv-content-width-vod.png' });
    await writeFile(
      'artifacts/tv-navigation/2026-10-15/tv-content-width-geometry.json',
      JSON.stringify(measurements, null, 2),
    );
    await writeFile(
      'artifacts/tv-navigation/2026-10-15/tv-content-width-vod-geometry.json',
      JSON.stringify(vod, null, 2),
    );
  } finally {
    await page.evaluate(() => {
      Reflect.get(window, 'dockFullscreen')?.dispose();
      Reflect.get(window, 'dockVOD')?.dispose();
      Reflect.get(window, 'dockQualityDispose')?.();
      Reflect.get(window, 'dockAudioDispose')?.();
      Reflect.get(window, 'dockAudioOwner')?.dispose();
    });
    await page.close();
  }
});

for (const [width, height] of [
  [1280, 825],
  [390, 844],
]) {
  it(`keeps real shell filter labels single-line without phantom icons and contains a decoded JPEG at ${width}x${height}`, async () => {
    const page = await mount(width, height);
    try {
      const controls = page.locator('#genxtra-browse-filters select');
      await browserExpect(controls).toHaveCount(2);
      for (const control of await controls.all()) {
        await browserExpect(control).toBeVisible();
        const layout = await control.evaluate((button) => {
          const select = button as HTMLSelectElement;
          const style = getComputedStyle(select);
          const canvas = document.createElement('canvas');
          const context = canvas.getContext('2d')!;
          context.font = style.font;
          const textWidth = context.measureText(select.selectedOptions[0]!.label).width;
          const before = getComputedStyle(button, '::before');
          const rect = button.getBoundingClientRect();
          return {
            iconAbsent: before.display === 'none' || ['none', 'normal'].includes(before.content),
            textLines: style.whiteSpace === 'nowrap' ? 1 : 0,
            textWidth,
            width: rect.width,
            height: rect.height,
          };
        });
        expect(layout.iconAbsent).toBe(true);
        expect(layout.textLines).toBe(1);
        expect(layout.textWidth).toBeLessThanOrEqual(layout.width);
        expect(layout.height).toBeGreaterThanOrEqual(44);
      }
      const titleButton = page.locator('.gx-archive-title-button');
      const titleGeometry = () =>
        titleButton.evaluate((node) => {
          const marker = getComputedStyle(node, '::after');
          const name = node.querySelector('.gx-archive-result-name')!;
          return {
            expanded: node.getAttribute('aria-expanded'),
            marker: marker.content,
            markerWidth: parseFloat(marker.width),
            markerBorder: marker.borderRightStyle,
            markerPosition: marker.position,
            markerTransform: marker.transform,
            nameWidth: name.getBoundingClientRect().width,
            nameFont: getComputedStyle(name).fontSize,
            buttonHeight: node.getBoundingClientRect().height,
          };
        });
      const collapsed = await titleGeometry();
      expect(collapsed).toMatchObject({
        expanded: 'false',
        marker: '""',
        markerWidth: 4,
        markerBorder: 'solid',
        markerPosition: 'absolute',
        nameFont: '17px',
      });
      await titleButton.click();
      const expanded = await titleGeometry();
      expect(expanded.expanded).toBe('true');
      expect(expanded.markerTransform).not.toBe(collapsed.markerTransform);
      expect(expanded.nameFont).toBe(collapsed.nameFont);
      const image = page.locator('#archive-details .gx-archive-detail-artwork img');
      await browserExpect(image).toBeVisible();
      await image.evaluate((node) => (node as HTMLImageElement).decode());
      const geometry = await image.evaluate((node) => {
        const img = node as HTMLImageElement;
        const box = img.getBoundingClientRect();
        const hero = img.parentElement!;
        const outer = hero.getBoundingClientRect();
        const fit = getComputedStyle(img).objectFit;
        const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight);
        return {
          natural: [img.naturalWidth, img.naturalHeight],
          mime: img.src.slice(0, 23),
          fit,
          contained:
            box.left >= outer.left &&
            box.top >= outer.top &&
            box.right <= outer.right + 0.5 &&
            box.bottom <= outer.bottom + 0.5,
          drawnWidth: img.naturalWidth * scale,
          drawnHeight: img.naturalHeight * scale,
          width: box.width,
          height: box.height,
          heroHeight: outer.height,
        };
      });
      expect(geometry.natural).toEqual([180, 135]);
      expect(geometry.mime).toBe('data:image/jpeg;base64,');
      expect(geometry.fit).toBe('contain');
      expect(geometry.contained).toBe(true);
      expect(geometry.heroHeight).toBeLessThanOrEqual(200);
      expect(geometry.drawnWidth / geometry.drawnHeight).toBeCloseTo(4 / 3, 6);
      expect(geometry.drawnWidth).toBeLessThanOrEqual(geometry.width);
      expect(geometry.drawnHeight).toBeLessThanOrEqual(geometry.height);
      if (width < 650)
        await page.evaluate(() => {
          document.getElementById('app')!.dataset.compactView = 'channels';
        });
      const visibleExpanded = await titleGeometry();
      expect(visibleExpanded.nameWidth).toBe(collapsed.nameWidth);
      // Opening the existing episode section can remove the collapsed row's
      // stretch, but the absolute marker never adds another control or height.
      expect(visibleExpanded.buttonHeight).toBeLessThanOrEqual(collapsed.buttonHeight);
      await titleButton.click();
      if (width < 650)
        await page.evaluate(() => {
          document.getElementById('app')!.dataset.compactView = 'channels';
        });
      const restored = await titleGeometry();
      expect(restored.expanded).toBe('false');
      expect(restored.markerTransform).toBe(collapsed.markerTransform);
      expect(await page.evaluate(() => Reflect.get(window, 'selections'))).toEqual([]);
      expect(await page.locator('video[src]').count()).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'archiveLayout').dispose());
      await page.close();
    }
  });
}
