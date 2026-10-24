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

import { expect, test } from '@playwright/test';
import { openGuideProgramSearch, seedSavedSearchChannels } from './helpers/search-workflows';

for (const viewport of [
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 640, height: 480 },
  { width: 360, height: 640 },
]) {
  test(`inline saved search retains one voice owner across Guide at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    let acquisitions = 0;
    await page.route('https://**', (route) => {
      acquisitions++;
      return route.abort();
    });
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await seedSavedSearchChannels(page);
    const title = await page.locator('#watch-title').textContent();
    const query = page.locator('#search');
    const clear = page.getByRole('button', { name: 'Clear search', exact: true });
    await expect(page.locator('#speech-control .speech-search-button')).toHaveCount(1);
    await expect(page.locator('.speech-search-button')).toHaveCount(1);
    await query.fill('Chicago Bears');
    await query.press('Enter');
    await expect(page.locator('#channel-list .channel strong')).toHaveText(['Chicago Bears TV']);
    await expect(page.locator('#primary-view-host')).toBeHidden();
    await expect(clear).toBeVisible();
    await clear.click();
    await expect(query).toHaveValue('');
    await expect(clear).toBeHidden();
    await expect(page.locator('#channel-list')).toBeFocused();
    await expect(page.locator('#channel-count')).toHaveText('2 channels');
    await query.fill('Chicago Bears');
    await page.locator('#guide-button').click();
    const guide = page.getByRole('dialog', { name: 'Program guide', exact: true });
    await expect(guide).toBeVisible();
    await expect(guide).toHaveAttribute('data-primary-page', 'guide');
    // The Guide opens in the right panel: the channel area and library stay.
    await expect(page.locator('#app')).toHaveAttribute('data-guide-panel', 'open');
    await expect(page.locator('.workspace')).toBeVisible();
    await expect(page.locator('.topbar')).toBeVisible();
    await expect(page.locator('#live-tv-button')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.speech-search-button')).toHaveCount(1);
    await expect(page.locator('#speech-control .speech-search-button')).toHaveCount(1);
    await expect(guide.locator('.speech-search-button')).toHaveCount(0);
    const close = guide.getByRole('button', { name: 'Close guide', exact: true });
    const box = await close.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    await close.click();
    await expect(guide).not.toBeVisible();
    await expect(page.locator('#guide-button')).toBeFocused();
    await expect(query).toHaveValue('Chicago Bears');
    await expect(page.locator('.workspace')).toBeVisible();
    await expect(page.locator('#live-tv-button')).toHaveAttribute('aria-pressed', 'true');
    await page.locator('#guide-button').click();
    await page.keyboard.press('Escape');
    await expect(guide).not.toBeVisible();
    await expect(page.locator('#guide-button')).toBeFocused();
    await page.locator('#guide-button').click();
    await page.locator('#live-tv-button').click();
    await expect(guide).not.toBeVisible();
    await expect(page.locator('#speech-control .speech-search-button')).toHaveCount(1);
    const programSearch = await openGuideProgramSearch(page, 'Chicago Bears');
    await expect(programSearch.input).toHaveValue('Chicago Bears');
    await expect(programSearch.guide).not.toHaveAttribute('data-primary-page', 'guide');
    await expect(page.locator('#primary-view-host')).toBeHidden();
    await expect(page.locator('.speech-search-button')).toHaveCount(1);
    await programSearch.guide.getByRole('button', { name: 'Close guide', exact: true }).click();
    await expect(programSearch.guide).not.toBeVisible();
    await expect(page.locator('.workspace')).toBeVisible();
    await expect(query).toHaveValue('Chicago Bears');
    await expect(page.locator('#channel-list .channel strong')).toHaveText(['Chicago Bears TV']);
    expect(await page.locator('#watch-title').textContent()).toBe(title);
    await expect(page.locator('#video')).toHaveJSProperty('paused', true);
    expect(acquisitions).toBe(0);
  });
}
