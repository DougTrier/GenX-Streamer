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

import { openPlaylistImport } from './helpers/source-scan';
import { saveReviewedSource } from './helpers/source-scan';
import { expect, test, type Locator, type Page } from '@playwright/test';

// Candidate: copy to tests/ui/search-clear.spec.ts only after applying the reviewed patch.
async function reach(page: Page, target: Locator): Promise<void> {
  const visits = new Map<string, number>();
  for (let step = 0; step < 40; step++) {
    if (await target.evaluate((node) => node === document.activeElement)) return;
    const direction = await target.evaluate((node) => {
      const a = document.activeElement!.getBoundingClientRect();
      const b = node.getBoundingClientRect();
      const x = b.x + b.width / 2 - a.x - a.width / 2;
      const y = b.y + b.height / 2 - a.y - a.height / 2;
      return {
        // Unnamed buttons (category chips, Location and sort) are distinct stops.
        identity:
          document.activeElement!.id ||
          `${document.activeElement!.tagName}:${document.activeElement!.textContent?.trim()}`,
        first:
          Math.abs(x) > Math.abs(y)
            ? x > 0
              ? 'ArrowRight'
              : 'ArrowLeft'
            : y > 0
              ? 'ArrowDown'
              : 'ArrowUp',
        second:
          Math.abs(x) > Math.abs(y)
            ? y > 0
              ? 'ArrowDown'
              : 'ArrowUp'
            : x > 0
              ? 'ArrowRight'
              : 'ArrowLeft',
      };
    });
    const count = visits.get(direction.identity) ?? 0;
    visits.set(direction.identity, count + 1);
    await page.keyboard.press(count % 2 ? direction.second : direction.first);
  }
  throw new Error('Clear search has no bounded D-pad route.');
}

for (const size of [
  { width: 1280, height: 800 },
  { width: 640, height: 480 },
]) {
  test(`remote one-action clear restores channels without tuning ${size.width}x${size.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(size);
    let mediaRequests = 0;
    await page.route('https://media.invalid/**', (route) => {
      mediaRequests++;
      return route.abort();
    });
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await openPlaylistImport(page);
    await page.locator('#playlist-file').setInputFiles({
      name: 'clear-search.m3u',
      mimeType: 'text/plain',
      buffer: Buffer.from(
        '#EXTM3U\n#EXTINF:-1,Clear Fixture News\nhttps://media.invalid/news\n#EXTINF:-1,Clear Fixture Sports\nhttps://media.invalid/sports\n',
      ),
    });
    await saveReviewedSource(page);
    await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 30000 });
    if (await page.locator('#compact-view').isVisible())
      await page.locator('#compact-view').selectOption('channels');
    const clear = page.getByRole('button', { name: 'Clear search', exact: true });
    await expect(clear).toBeHidden();
    await page
      .getByRole('searchbox', { name: 'Search channels' })
      .fill('a long unmatched query that should not need individual deletion');
    await expect(page.locator('#channel-count')).toHaveText('0 channels');
    await expect(page.locator('#search-programs')).toBeVisible();
    await clear.evaluate((button) => {
      button.style.fontSize = '200%';
    });
    const hit = await clear.evaluate((button) => {
      const r = button.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        width: r.width,
        height: r.height,
        inBounds: r.x >= 0 && r.y >= 0 && r.right <= innerWidth && r.bottom <= innerHeight,
        hit: top === button || button.contains(top),
      };
    });
    expect(hit.width).toBeGreaterThanOrEqual(44);
    expect(hit.height).toBeGreaterThanOrEqual(44);
    expect(hit.inBounds && hit.hit).toBe(true);
    // Focus setup only; all traversal and activation after this use actual keyboard arrows/OK.
    await page.locator('#channel-list').focus();
    await reach(page, clear);
    await page.keyboard.press('Enter');
    await expect(page.locator('#search')).toHaveValue('');
    await expect(page.locator('#channel-count')).toHaveText('2 channels');
    await expect(page.locator('#search-programs')).toBeVisible();
    await expect(clear).toBeHidden();
    await expect(page.locator('#channel-list')).toBeFocused();
    await expect(page.locator('#playback-status')).toHaveText('Ready when you are');
    expect(mediaRequests).toBe(0);
    await page.getByRole('searchbox', { name: 'Search channels' }).fill('Sports');
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(page.locator('#channel-count')).toHaveText('2 channels');
    await expect(page.locator('#channel-list')).toBeFocused();
  });
}
