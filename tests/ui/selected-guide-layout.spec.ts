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
import {
  mountLiveViewingPane,
  expectLiveVideoOnly,
  livePaneGeometry,
} from './helpers/live-viewing-pane';
// User contract supersedes the former Now/Up Next and status panels in Live TV.
for (const size of [
  { width: 1920, height: 1080, tv: false },
  { width: 1280, height: 800, tv: false },
  { width: 960, height: 540, tv: true },
  { width: 854, height: 432, tv: false },
  { width: 360, height: 640, tv: false },
]) {
  test(`Live video owns the right pane at ${size.width}x${size.height}, TV=${size.tv}`, async ({
    page,
  }) => {
    await mountLiveViewingPane(page, size.width, size.height, size.tv);
    const retained = await page.locator('#video').elementHandle();
    const baseline = await expectLiveVideoOnly(page);
    for (const mapped of [false, true, false]) {
      await page.evaluate(
        (mapped) => Reflect.get(window, 'livePaneFixture').update(mapped),
        mapped,
      );
      await page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => r())));
      await expectLiveVideoOnly(page);
      expect(await livePaneGeometry(page)).toEqual(baseline);
      expect(await retained!.evaluate((n) => n === document.getElementById('video'))).toBe(true);
    }
    await page.evaluate(() => Reflect.get(window, 'livePaneFixture').dispose());
  });
}

test('Live results remain actual channels after search and playback activation', async ({
  page,
}) => {
  await mountLiveViewingPane(page, 960, 540, true);
  await page.locator('#search').fill('news');
  await page.evaluate(() => Reflect.get(window, 'livePaneFixture').search('news'));
  await expect(page.locator('[data-channel="c"]')).toBeVisible();
  await page.locator('[data-channel="c"]').click();
  expect(await page.evaluate(() => Reflect.get(window, 'livePaneFixture').selected)).toEqual(['c']);
  await expect(page.locator('#search')).toHaveValue('news');
  await expect(page.locator('[data-channel="c"]')).toBeVisible();
  await expect(page.locator('.gx-program-search,.gx-program-search-inline')).toHaveCount(0);
  await expect(page.locator('.browser [data-channel]')).toHaveCount(1);
  await expectLiveVideoOnly(page);
  await page.evaluate(() => Reflect.get(window, 'livePaneFixture').dispose());
});

type ViewingMode = 'GenXtra idle' | 'GenXtra playing' | 'Live';
async function viewingMode(page: Page, mode: ViewingMode): Promise<void> {
  await page.evaluate(async (mode) => {
    const app = document.getElementById('app')!;
    const dockPath = '/src/ui/player/vod-dock.ts';
    const { installVODDock } = await import(dockPath);
    const previous = Reflect.get(window, 'paneDockFixture');
    previous?.dispose();
    const onDemand = mode === 'GenXtra playing';
    app.dataset.contentLibrary = mode === 'Live' ? 'live' : 'genxtra';
    const details = document.getElementById('archive-details')!;
    details.hidden = true;
    if (onDemand) details.dataset.playbackActive = 'true';
    else delete details.dataset.playbackActive;
    document.getElementById('vod-transport')!.hidden = !onDemand;
    for (const id of ['vod-rewind', 'vod-forward'])
      document.querySelector<HTMLButtonElement>(`#${id}`)!.disabled = !onDemand;
    document.getElementById('vod-position')!.textContent = '12:34';
    document.getElementById('playback-status')!.textContent =
      mode === 'GenXtra idle' ? 'Ready when you are' : 'Playing';
    const owner = installVODDock(app);
    owner.render(onDemand);
    Reflect.set(window, 'paneDockFixture', owner);
  }, mode);
}
async function settledLayout(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
}
async function dockIntegrity(page: Page) {
  return page.locator('.watch-card > .dock').evaluate((dock) => {
    const owner = dock.getBoundingClientRect();
    const controls = [...dock.querySelectorAll<HTMLButtonElement>('button')].filter(
      (button) =>
        button.getClientRects().length > 0 && getComputedStyle(button).visibility !== 'hidden',
    );
    return {
      rows: new Set(controls.map((button) => Math.round(button.getBoundingClientRect().top))).size,
      overflow: dock.scrollWidth > dock.clientWidth + 1,
      clippedOrCovered: controls
        .filter((button) => {
          const box = button.getBoundingClientRect();
          const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
          return (
            box.left < owner.left - 1 ||
            box.right > owner.right + 1 ||
            box.top < owner.top - 1 ||
            box.bottom > owner.bottom + 1 ||
            !button.contains(hit)
          );
        })
        .map((button) => button.id),
      objectFit: getComputedStyle(document.getElementById('video')!).objectFit,
    };
  });
}
for (const mode of ['GenXtra idle', 'GenXtra playing', 'Live'] as const) {
  test(`${mode} fills the right pane through desktop resizing without replacing video`, async ({
    page,
  }, testInfo) => {
    await mountLiveViewingPane(page, 1478, 1030, false);
    await viewingMode(page, mode);
    // Test-only CSSOM removal proves the old gap against the same fixture and
    // assertions, without reverting or editing any production source file.
    if (process.env.GENX_LAYOUT_DISABLE_FILL === '1') {
      const removed = await page.evaluate(() => {
        const sheet = [...document.styleSheets].find((sheet) =>
          sheet.href?.endsWith('/src/ui/media-results.css'),
        )!;
        for (const outer of sheet.cssRules) {
          if (!(outer instanceof CSSMediaRule)) continue;
          for (const rule of outer.cssRules) {
            if (
              rule instanceof CSSStyleRule &&
              rule.selectorText ===
                '#app:not(.viewing-fullscreen):not(.keyboard-open) .workspace > .view > .watch-card'
            ) {
              rule.style.removeProperty('flex');
              rule.style.removeProperty('min-height');
              rule.style.removeProperty('max-height');
              return true;
            }
          }
        }
        return false;
      });
      expect(removed).toBe(true);
    }
    const retained = await page.locator('#video').elementHandle();
    const observations = [];
    for (const viewport of [
      { width: 1478, height: 1030 },
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
    ]) {
      await page.setViewportSize(viewport);
      await settledLayout(page);
      const g = await livePaneGeometry(page);
      const dock = await dockIntegrity(page);
      observations.push({ viewport, geometry: g, dock });
      await testInfo.attach(`geometry-${viewport.width}x${viewport.height}`, {
        body: JSON.stringify({ mode, viewport, geometry: g, dock }, null, 2),
        contentType: 'application/json',
      });
      expect(g.card.bottom, 'unused space below the viewing card').toBeCloseTo(
        g.view.bottom - g.viewBottomPadding,
        0,
      );
      expect(g.screen.height).toBeGreaterThan(g.card.height * 0.7);
      expect(g.screen.width).toBeGreaterThanOrEqual(g.card.width - 2 * g.padding - 3);
      expect(g.video.width).toBeCloseTo(g.inner.width, 0);
      expect(g.video.height).toBeCloseTo(g.inner.height, 0);
      expect(g.screen.bottom).toBeLessThanOrEqual(g.dock.top + 1);
      expect(g.card.bottom - g.dock.bottom).toBeLessThanOrEqual(g.padding + 1);
      expect(g.card.right).toBeLessThanOrEqual(g.view.right + 1);
      expect(g.card.width).toBeGreaterThan(g.view.width - 20);
      expect(dock).toMatchObject({
        rows: 1,
        overflow: false,
        clippedOrCovered: [],
        objectFit: 'contain',
      });
      expect(await retained!.evaluate((node) => node === document.getElementById('video'))).toBe(
        true,
      );
      if (viewport.width === 1478) {
        const screenshot = testInfo.outputPath('right-pane.png');
        await page.screenshot({ path: screenshot });
        await testInfo.attach('right-pane', { path: screenshot, contentType: 'image/png' });
      }
    }
    expect(observations).toHaveLength(3);
    // Preserve the existing compact presentation: it may wrap its control dock,
    // but resizing must not crop, cover, overflow or replace the viewing surface.
    for (const viewport of [
      { width: 854, height: 432 },
      { width: 360, height: 640 },
    ]) {
      await page.setViewportSize(viewport);
      await settledLayout(page);
      const g = await livePaneGeometry(page);
      const dock = await dockIntegrity(page);
      await testInfo.attach(`compact-${viewport.width}x${viewport.height}`, {
        body: JSON.stringify({ mode, viewport, geometry: g, dock }, null, 2),
        contentType: 'application/json',
      });
      expect(g.screen.height).toBeGreaterThan(50);
      expect(g.video.width).toBeCloseTo(g.inner.width, 0);
      expect(g.video.height).toBeCloseTo(g.inner.height, 0);
      expect(g.screen.bottom).toBeLessThanOrEqual(g.dock.top + 1);
      expect(g.dock.bottom).toBeLessThanOrEqual(viewport.height);
      expect(dock).toMatchObject({ overflow: false, clippedOrCovered: [], objectFit: 'contain' });
      expect(await retained!.evaluate((node) => node === document.getElementById('video'))).toBe(
        true,
      );
    }
    await page.evaluate(() => {
      Reflect.get(window, 'paneDockFixture').dispose();
      Reflect.get(window, 'livePaneFixture').dispose();
    });
  });
}
