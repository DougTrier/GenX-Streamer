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

import { chooseSettingsSection } from './helpers/settings-section';
import { test, expect } from '@playwright/test';

test('the phone search icon keeps its label inside its touch target', async ({ page }) => {
  await page.setViewportSize({ width: 360, height: 780 });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#phone-filter-button').click();
  const button = page.locator('#phone-filter-dialog #search-programs');
  await expect(button).toHaveAccessibleName('Find channels online');
  const geometry = await button.evaluate((node) => {
    const box = node.getBoundingClientRect();
    const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    const textBounds: DOMRect[] = [];
    while (walker.nextNode()) {
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      textBounds.push(...range.getClientRects());
    }
    return {
      width: box.width,
      height: box.height,
      contained: textBounds.every(
        (r) =>
          r.height === 0 ||
          (r.left >= box.left - 1 &&
            r.right <= box.right + 1 &&
            r.top >= box.top - 1 &&
            r.bottom <= box.bottom + 1),
      ),
    };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(44);
  expect(geometry.height).toBeGreaterThanOrEqual(44);
  expect(geometry.contained).toBe(true);
});

for (const size of [
  { width: 320, height: 640 },
  { width: 320, height: 480 },
  { width: 360, height: 480 },
  { width: 640, height: 360 },
  { width: 800, height: 600 },
  { width: 1280, height: 720 },
  // T051's widths in both orientations (October 23, 2026).
  { width: 570, height: 320 },
  { width: 320, height: 570 },
  { width: 736, height: 414 },
  { width: 414, height: 736 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
]) {
  test(`viewing actions remain inside ${size.width}x${size.height}`, async ({ page }) => {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    if (size.width === 736 && size.height === 414) {
      await expect(page.locator('#channel-list')).toHaveAttribute('data-catalog-empty', 'true');
      await expect(page.locator('.channel-row')).toHaveCount(0);
      if (await page.locator('#phone-filter-button').isVisible())
        await page.locator('#phone-filter-button').click();
      const refresh = await page.locator('#refresh-button').boundingBox();
      const footer = await page.locator('.app-signoff').boundingBox();
      expect(refresh!.y + refresh!.height).toBeLessThanOrEqual(footer!.y + 0.5);
      if (await page.locator('#phone-filter-dialog').isVisible())
        await page.locator('#phone-filter-close').click();
    }
    if (size.height === 480 && (await page.getByLabel('Viewing panel').isVisible()))
      await page.getByLabel('Viewing panel').selectOption('channels');
    const clipped = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('#app button')]
        .filter((button) => button.getClientRects().length && !button.closest('dialog:not([open])'))
        .map((button) => ({ id: button.id, rect: button.getBoundingClientRect() }))
        .filter(
          ({ rect }) =>
            rect.left < 0 ||
            rect.right > innerWidth + 1 ||
            rect.top < 0 ||
            rect.bottom > innerHeight + 1,
        )
        .map(({ id }) => id),
    );
    expect(clipped).toEqual([]);
    const covered = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('#app button')]
        .filter((button) => button.getClientRects().length && !button.closest('dialog:not([open])'))
        .filter((button) => {
          const box = button.getBoundingClientRect();
          return [
            [(box.left + box.right) / 2, box.top + 3],
            [(box.left + box.right) / 2, box.bottom - 3],
            [(box.left + box.right) / 2, (box.top + box.bottom) / 2],
          ].some(([x, y]) => !button.contains(document.elementFromPoint(x, y)));
        })
        .map((button) => button.id),
    );
    expect(covered).toEqual([]);
    expect(
      await page.evaluate(
        () =>
          document.documentElement.scrollHeight <= innerHeight + 1 &&
          document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    if (await page.getByLabel('Viewing panel').isVisible())
      await page.getByLabel('Viewing panel').selectOption('channels');
    if (await page.locator('#phone-filter-button').isVisible())
      await page.locator('#phone-filter-button').click();
    await page.getByRole('button', { name: 'Location and sort', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Location and sort', exact: true });
    await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeInViewport({
      ratio: 1,
    });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    if (await page.locator('#phone-filter-dialog').isVisible())
      await page.locator('#phone-filter-close').click();
    await page.locator('#settings-button').click();
    for (const section of ['sources', 'preferences', 'data', 'discovery']) {
      await chooseSettingsSection(page, section);
      const bounds = await page.locator('#settings-dialog').boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(size.width);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(size.height);
    }
  });
}
