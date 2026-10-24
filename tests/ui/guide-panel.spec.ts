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

import { seedSavedSearchChannels } from './helpers/search-workflows';
import { expect, test } from '@playwright/test';

test('the Guide opens in the right panel and hides the empty picture box until something plays', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  // Nothing has played yet: the welcome picture box is shown in normal viewing.
  await expect(page.locator('.watch-card')).toBeVisible();
  await page.locator('#guide-button').click();
  await expect(page.getByRole('dialog', { name: 'Program guide', exact: true })).toBeVisible();
  await expect(page.locator('#app')).toHaveAttribute('data-guide-panel', 'open');
  await expect(page.locator('.browser')).toBeVisible();
  // An idle player has no picture to keep in view, so the guide gets the panel.
  await expect(page.locator('#app')).toHaveAttribute('data-player-idle', 'true');
  await expect(page.locator('.watch-card')).toBeHidden();
  await expect(page.locator('.guide-dialog')).not.toContainText('seven days');
  await page.getByRole('button', { name: 'Close guide', exact: true }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-guide-panel', 'closed');
  await expect(page.locator('.watch-card')).toBeVisible();
});

test('the preview beside the Guide opens full screen, and leaving full screen returns to the Guide', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await seedSavedSearchChannels(page);
  // Choosing a channel makes the player busy (the fixture address never plays).
  await page.locator('#channel-list .channel').first().click();
  await expect(page.locator('#app')).toHaveAttribute('data-player-idle', 'false');
  await page.locator('#guide-button').click();
  await expect(page.locator('#app')).toHaveAttribute('data-guide-panel', 'open');
  const preview = page.getByRole('button', { name: 'Watch full screen', exact: true });
  await expect(preview).toBeVisible();
  // The picture sits above the channel list, left of the Guide.
  const [card, guide] = await Promise.all([
    page.locator('.watch-card').boundingBox(),
    page.locator('#primary-view-host').boundingBox(),
  ]);
  expect(card!.x + card!.width).toBeLessThanOrEqual(guide!.x);
  await preview.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#app')).toHaveClass(/viewing-fullscreen/);
  await expect(page.locator('#primary-view-host')).toBeHidden();
  await expect(preview).toHaveCount(0);
  // Back from full screen lands on the Guide, not the normal view.
  await page.keyboard.press('Escape');
  await expect(page.locator('#app')).not.toHaveClass(/viewing-fullscreen/);
  await expect(page.locator('#app')).toHaveAttribute('data-guide-panel', 'open');
  await expect(page.getByRole('dialog', { name: 'Program guide', exact: true })).toBeVisible();
  // Only Close guide returns to the normal view.
  await page.getByRole('button', { name: 'Close guide', exact: true }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-guide-panel', 'closed');
  await expect(page.getByRole('button', { name: 'Watch full screen', exact: true })).toHaveCount(0);
});
