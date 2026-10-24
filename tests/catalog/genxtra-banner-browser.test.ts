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

/**
 * GenXtra banner in a real browser: live video, TV cards and compact TV
 * selectors.
 */
import { expect, it } from 'vitest';
import { expect as browserExpect } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import { useGenxtraBannerBrowser, mount } from './genxtra-banner-browser.fixture';

useGenxtraBannerBrowser();

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
