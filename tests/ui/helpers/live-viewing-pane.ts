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

import { expect, type Page } from '@playwright/test';
export async function mountLiveViewingPane(
  page: Page,
  width: number,
  height: number,
  tv: boolean,
  scale = 1,
) {
  await page.setViewportSize({ width, height });
  await page.route('**/live-viewing-pane-fixture', (r) =>
    r.fulfill({
      contentType: 'text/html',
      body:
        '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">' +
        [
          'style',
          'management',
          'guide',
          'guide-timeline',
          'responsive',
          'in-app-select',
          'genxtra',
          'media-results',
          'tv-density',
        ]
          .map((name) => `<link rel="stylesheet" href="/src/ui/${name}.css">`)
          .join('') +
        '</head><body><div id="app"></div></body></html>',
    }),
  );
  await page.goto('/live-viewing-pane-fixture');
  await page.evaluate(
    async ({ tv, scale }) => {
      const shell = '/src/ui/shell/shell.ts',
        viewport = '/src/ui/shell/viewport.ts',
        channelBrowser = '/src/ui/channels/channel-browser.ts';
      const { createShell } = await import(shell),
        { installViewport } = await import(viewport),
        { ChannelBrowser } = await import(channelBrowser);
      const app = document.getElementById('app')!;
      createShell(app);
      app.dataset.deviceKind = tv ? 'tv' : 'handheld';
      app.dataset.contentLibrary = 'live';
      app.dataset.compactView = 'watch';
      app.style.setProperty('--sidebar', '360px');
      document.getElementById('player-overlay')!.hidden = true;
      document.getElementById('playback-status')!.textContent = 'Playing';
      for (const id of ['pause-button', 'favorite-button', 'remove-channel'])
        document.getElementById(id)!.removeAttribute('disabled');
      if (tv) document.getElementById('cast-button')!.hidden = true;
      const selected: string[] = [];
      const channels = [{ id: 'c', sourceId: 's', name: 'Controlled channel', category: 'News' }];
      const rows = new ChannelBrowser(document.getElementById('channel-list')!, (id: string) => {
        selected.push(id);
        rows.update(channels, [], id);
      });
      rows.update(
        [{ id: 'c', sourceId: 's', name: 'Controlled channel', category: 'News' }],
        [],
        null,
      );
      const update = (mapped: boolean) => {
        const at = 1700000000000;
        rows.setGuideRows([
          {
            catalogSourceId: 's',
            appChannelId: 'c',
            status: 'ready',
            summary: {
              requestId: 'fixture',
              catalogSourceId: 's',
              appChannelId: 'c',
              atMs: at,
              catalogRevision: '1',
              databaseRevision: 1,
              mappingStatus: mapped ? 'mapped' : 'unmapped',
              mapping: mapped
                ? {
                    catalogSourceId: 's',
                    appChannelId: 'c',
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
                ? { title: 'Saved controlled program', startMs: at - 1000, stopMs: at + 1000 }
                : null,
              next: null,
            },
          },
        ]);
      };
      const owner = installViewport(app);
      Reflect.set(window, 'livePaneFixture', {
        update,
        search: (query: string) => rows.search(query),
        selected,
        dispose: () => {
          rows.dispose();
          owner();
        },
      });
      if (scale !== 1)
        for (const node of app.querySelectorAll<HTMLElement>(
          'button,input,label,summary,h2,p,output',
        ))
          node.style.fontSize = `${parseFloat(getComputedStyle(node).fontSize) * scale}px`;
    },
    { tv, scale },
  );
  await page.evaluate(() => document.fonts.ready);
}
export async function livePaneGeometry(page: Page) {
  return page.evaluate(() => {
    const box = (selector: string) => {
      const n = document.querySelector(selector)!;
      const r = n.getBoundingClientRect();
      return {
        x: r.x,
        y: r.y,
        width: r.width,
        height: r.height,
        top: r.top,
        bottom: r.bottom,
        left: r.left,
        right: r.right,
      };
    };
    const card = document.querySelector('.watch-card')!,
      view = document.querySelector('.view')!,
      screen = document.getElementById('screen')!;
    return {
      view: box('.view'),
      card: box('.watch-card'),
      screen: box('#screen'),
      video: box('#video'),
      dock: box('.watch-card > .dock'),
      padding: parseFloat(getComputedStyle(card).paddingTop) || 0,
      viewBottomPadding: parseFloat(getComputedStyle(view).paddingBottom) || 0,
      inner: { width: screen.clientWidth, height: screen.clientHeight },
    };
  });
}
export async function expectLiveVideoOnly(page: Page) {
  expect(
    await page
      .locator(
        '#selected-guide-details,#selected-guide-status-slot,.view .selected-guide,.view .selected-guide-map',
      )
      .count(),
  ).toBe(0);
  await expect(page.locator('.watchhead')).toBeHidden();
  const g = await livePaneGeometry(page);
  expect(g.screen.top - g.card.top).toBeLessThanOrEqual(g.padding + 1);
  expect(g.screen.bottom).toBeLessThanOrEqual(g.dock.top + 1);
  expect(g.card.bottom).toBeCloseTo(g.view.bottom - g.viewBottomPadding, 0);
  expect(g.video.height).toBeCloseTo(g.inner.height, 0);
  expect(g.video.width).toBeCloseTo(g.inner.width, 0);
  expect(g.screen.height).toBeGreaterThan(90);
  // The Guide belongs to the channel row; a phone's Watch view hides that panel.
  const guide = page.getByRole('button', { name: 'Free TV guide', exact: true });
  await expect(page.locator('.sidehead #guide-button')).toHaveCount(1);
  if (await page.locator('.browser').isVisible()) await expect(guide).toBeVisible();
  return g;
}
