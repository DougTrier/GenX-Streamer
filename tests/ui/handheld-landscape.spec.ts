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

import { expect, test, type Locator, type Page } from '@playwright/test';
import { openPlaylistImport, saveReviewedSource } from './helpers/source-scan';

const channels = Array.from(
  { length: 16 },
  (_, index) => `Metro News ${String(index).padStart(2, '0')}`,
);
const playlist =
  '#EXTM3U\n' +
  channels
    .map(
      (name, index) =>
        `#EXTINF:-1 tvg-id="readable-${index}" group-title="News",${name}\nhttps://layout.fixture.invalid/${index}\n`,
    )
    .join('');

async function visibleTarget(
  page: Page,
  locator: Locator,
  width: number,
  height: number,
  minimum = { width: 44, height: 44 },
) {
  await expect(locator).toBeVisible();
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThanOrEqual(minimum.width);
  expect(box!.height).toBeGreaterThanOrEqual(minimum.height);
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.y).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(width + 0.5);
  expect(box!.y + box!.height).toBeLessThanOrEqual(height + 0.5);
  expect(
    await locator.evaluate((node) => {
      const rect = node.getBoundingClientRect();
      const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
      return hit === node || (!!hit && node.contains(hit));
    }),
  ).toBe(true);
}

for (const configuration of [
  { width: 854, height: 432, kind: 'personal' },
  { width: 850, height: 420, kind: 'personal' },
  { width: 960, height: 540, kind: 'personal' },
  { width: 390, height: 844, kind: 'personal' },
  { width: 960, height: 540, kind: 'tv' },
] as const) {
  test(`channel text stays readable with complete rows and usable controls ${configuration.kind} ${configuration.width}x${configuration.height}`, async ({
    page,
  }, testInfo) => {
    const { width, height, kind } = configuration;
    await page.setViewportSize({ width, height });
    let acquisitions = 0;
    await page.route('https://**', (route) => {
      acquisitions++;
      return route.abort();
    });
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    // CSS/device-kind fixture only: this does not emulate Android IPC, IME or a decoder.
    await page.locator('#app').evaluate((root, kind) => {
      root.dataset.deviceKind = kind;
    }, kind);
    await openPlaylistImport(page);
    await page.locator('#playlist-file').setInputFiles({
      name: 'readable-layout.m3u',
      mimeType: 'text/plain',
      buffer: Buffer.from(playlist),
    });
    await saveReviewedSource(page, channels.length);
    const viewing = page.getByLabel('Viewing panel', { exact: true });
    if (await viewing.isVisible()) await viewing.selectOption('channels');
    await expect(page.locator('#channel-count')).toHaveText('16 channels');
    const geometry = await page.locator('#channel-list').evaluate((list) => {
      const bounds = list.getBoundingClientRect();
      const complete = [...list.querySelectorAll<HTMLElement>('.channel-row')].filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.top >= bounds.top - 0.5 && rect.bottom <= bounds.bottom + 0.5;
      });
      return {
        height: bounds.height,
        complete: complete.length,
        rows: complete.slice(0, 3).map((row) => {
          const main = row.querySelector<HTMLElement>('.channel')!;
          const copy = row.querySelector<HTMLElement>('.channel-copy')!;
          const strong = copy.querySelector('strong')!;
          const text = strong.firstChild!;
          const range = document.createRange();
          range.setStart(text, 0);
          range.setEnd(text, Math.min(4, text.textContent!.length));
          const letter = range.getBoundingClientRect();
          const box = copy.getBoundingClientRect(),
            button = main.getBoundingClientRect();
          return {
            name: strong.textContent,
            textWidth: box.width,
            visiblePrefix:
              letter.width > 0 &&
              letter.height > 0 &&
              letter.left >= Math.max(box.left, button.left, bounds.left) - 0.5 &&
              letter.right <= Math.min(box.right, button.right, bounds.right) + 0.5 &&
              letter.top >= bounds.top - 0.5 &&
              letter.bottom <= bounds.bottom + 0.5,
          };
        }),
      };
    });
    expect(geometry.complete).toBeGreaterThanOrEqual(kind === 'tv' ? 5 : 2);
    expect(geometry.rows.length).toBeGreaterThanOrEqual(2);
    for (const row of geometry.rows) {
      expect(row.name).toMatch(/^Metro News/);
      expect(row.textWidth).toBeGreaterThanOrEqual(80);
      expect(row.visiblePrefix).toBe(true);
    }
    await visibleTarget(page, page.locator('#search-programs'), width, height, {
      width: kind === 'tv' ? 34 : 44,
      height: kind === 'tv' ? 34 : 44,
    });
    for (const id of ['live-tv-button', 'genxtra-button', 'guide-button', 'settings-button'])
      await visibleTarget(page, page.locator('#' + id), width, height, {
        width: kind === 'tv' ? 34 : 44,
        height: kind === 'tv' ? 34 : 44,
      });
    if (await page.locator('#cast-button').isVisible())
      await visibleTarget(page, page.locator('#cast-button'), width, height, {
        width: kind === 'tv' ? 34 : 44,
        height: kind === 'tv' ? 34 : 44,
      });
    await visibleTarget(
      page,
      page.locator('[data-channel-action="favorite"]').first(),
      width,
      height,
      { width: kind === 'tv' ? 34 : 44, height: kind === 'tv' ? 34 : 44 },
    );
    await visibleTarget(
      page,
      page.locator('[data-channel-action="manage"]').first(),
      width,
      height,
      { width: kind === 'tv' ? 26 : 44, height: kind === 'tv' ? 34 : 44 },
    );
    if (await viewing.isVisible()) await viewing.selectOption('watch');
    const screen = await page.locator('.screen').boundingBox();
    expect(screen).not.toBeNull();
    expect(screen!.width).toBeGreaterThanOrEqual(160);
    expect(screen!.height).toBeGreaterThanOrEqual(90);
    for (const id of ['pause-button', 'mute-button', 'expand-button', 'fullscreen-button'])
      await visibleTarget(page, page.locator('#' + id), width, height, {
        width: kind === 'tv' ? 34 : 44,
        height: kind === 'tv' ? 34 : 44,
      });
    const chrome = await page.evaluate(() => {
      const header = document.querySelector('.topbar')!.getBoundingClientRect();
      const footer = document.querySelector('.app-signoff')?.getBoundingClientRect();
      return {
        headerBottom: header.bottom,
        footerBottom: footer?.bottom,
        bodyWidth: document.documentElement.scrollWidth,
        bodyHeight: document.documentElement.scrollHeight,
      };
    });
    expect(chrome.headerBottom).toBeLessThan(height / 3);
    if (chrome.footerBottom !== undefined)
      expect(chrome.footerBottom).toBeLessThanOrEqual(height + 0.5);
    expect(chrome.bodyWidth).toBeLessThanOrEqual(width);
    expect(chrome.bodyHeight).toBeLessThanOrEqual(height + 1);
    await expect(page.locator('#video')).toHaveJSProperty('paused', true);
    expect(acquisitions).toBe(0);
    await testInfo.attach('layout-geometry', {
      body: JSON.stringify({ configuration, geometry, screen, chrome }),
      contentType: 'application/json',
    });
    await testInfo.attach('layout', { body: await page.screenshot(), contentType: 'image/png' });
  });
}
