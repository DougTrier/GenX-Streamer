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

// Phones (October 21, 2026, owner reports on the Galaxy S25 in landscape):
// - the channel panel's Favs, Loc & Sort and Guide stay inside the panel
//   (Guide ran under the divider at 220 px);
// - the dock has no Favorite / Remove channel row: both live on each channel
//   row (its star and its menu), so the picture gets the space.
const SIZES = [
  // As GenX measured it on the S25 in landscape (system bars excluded).
  { name: 'S25 landscape', width: 697, height: 330, sidebar: '240px', phone: true, tv: false },
  { name: 'phone landscape', width: 844, height: 390, sidebar: '240px', phone: true, tv: false },
  { name: 'phone portrait', width: 390, height: 844, sidebar: '360px', phone: true, tv: false },
  { name: 'desktop', width: 1600, height: 900, sidebar: '520px', phone: false, tv: false },
  { name: 'TV 1080p', width: 1920, height: 1080, sidebar: '760px', phone: false, tv: true },
];

async function mount(page: Page, size: (typeof SIZES)[number]): Promise<void> {
  await page.setViewportSize({ width: size.width, height: size.height });
  await page.route('**/phone-panel-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body:
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        [
          'style',
          'management',
          'guide',
          'responsive',
          'fullscreen',
          'video-quality',
          'genxtra',
          'media-results',
          'tv-density',
          'live-replay',
        ]
          .map((name) => `<link rel="stylesheet" href="/src/ui/${name}.css">`)
          .join('') +
        '</head><body><div id="app"></div></body></html>',
    }),
  );
  await page.goto('/phone-panel-fixture');
  await page.evaluate(async ({ tv, sidebar }) => {
    const shell = '/src/ui/shell.ts',
      viewport = '/src/ui/viewport.ts';
    const { createShell } = await import(shell);
    const { installViewport } = await import(viewport);
    const app = document.getElementById('app')!;
    createShell(app);
    app.dataset.deviceKind = tv ? 'tv' : 'personal';
    app.dataset.compactView = 'watch';
    app.dataset.contentLibrary = 'live';
    app.dataset.playMode = 'live';
    app.style.setProperty('--sidebar', sidebar);
    installViewport(app);
    document.getElementById('player-overlay')!.hidden = true;
    document.getElementById('channel-count')!.textContent = '8,765 channels';
    for (const id of ['pause-button', 'favorite-button', 'remove-channel'])
      (document.getElementById(id) as HTMLButtonElement).disabled = false;
  }, size);
}

for (const size of SIZES)
  test(`channel panel row and dock: ${size.name}`, async ({ page }) => {
    await mount(page, size);
    const row = await page.evaluate(() => {
      const head = document.getElementById('channel-count')!.parentElement!;
      const panel = head.closest('.browser')!.getBoundingClientRect();
      return [...head.children]
        .filter((child) => (child as HTMLElement).getClientRects().length > 0)
        .map((child) => {
          const box = child.getBoundingClientRect();
          return {
            name: child.id || child.className,
            inside: box.left >= panel.left - 0.5 && box.right <= panel.right + 0.5,
          };
        });
    });
    expect(row.length).toBeGreaterThanOrEqual(3);
    for (const item of row) expect(item.inside, `${item.name} leaves the channel panel`).toBe(true);
    if (size.phone) {
      await expect(page.locator('.dock .channel-actions')).toBeHidden();
    } else if (!size.tv) {
      // PCs keep them in the dock (the TV dock never had them).
      await expect(page.locator('#favorite-button')).toBeVisible();
      await expect(page.locator('#remove-channel')).toBeVisible();
    }
    if (size.phone && size.height <= 420) {
      // Landscape phones: one compact row of controls under the picture.
      const tops = await page.evaluate(() =>
        [...document.querySelectorAll<HTMLElement>('.dock button, .dock #playback-status')]
          .filter((el) => el.getClientRects().length > 0 && getComputedStyle(el).display !== 'none')
          .map((el) =>
            Math.round(el.getBoundingClientRect().top + el.getBoundingClientRect().height / 2),
          ),
      );
      expect(tops.length).toBeGreaterThanOrEqual(5);
      expect(Math.max(...tops) - Math.min(...tops)).toBeLessThanOrEqual(4);
      const dock = (await page.locator('.watch-card > .dock').boundingBox())!;
      expect(dock.height).toBeLessThanOrEqual(60);
      const card = (await page.locator('.watch-card').boundingBox())!;
      expect(dock.x + dock.width).toBeLessThanOrEqual(card.x + card.width + 0.5);
    }
    if (size.phone) {
      // Full screen keeps Favorite, never Remove.
      await page.evaluate(() =>
        document.getElementById('app')!.classList.add('viewing-fullscreen'),
      );
      await expect(page.locator('#favorite-button')).toBeVisible();
      await expect(page.locator('#remove-channel')).toBeHidden();
      await page.screenshot({
        path: `artifacts/tests/ui/phone-panel-layout/${size.name.replace(/\s+/g, '-')}-fullscreen.png`,
      });
      await page.evaluate(() =>
        document.getElementById('app')!.classList.remove('viewing-fullscreen'),
      );
    }
    await page.screenshot({
      path: `artifacts/tests/ui/phone-panel-layout/${size.name.replace(/\s+/g, '-')}.png`,
    });
  });
