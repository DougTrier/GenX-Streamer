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

// The header buttons wear the owner's sprite-sheet art (src/ui/header-art.css,
// assets/genx-nav-art-provenance.md): each keeps its accessible name, its art
// loads, and the row stays one line on desktop and phones.
const BUTTONS: [string, string, string][] = [
  ['live-tv-button', 'genx-nav-free-tv', 'Free TV'],
  ['paid-tv-button', 'genx-nav-paid-tv', 'Paid TV'],
  ['local-button', 'genx-nav-globe', 'Local TV and radio'],
];

for (const viewport of [
  { width: 1280, height: 720 },
  { width: 375, height: 812 },
  { width: 844, height: 390 },
  // Retroid Flip 2: its labelled Settings once ran off the screen's edge.
  { width: 854, height: 432 },
])
  test(`header art at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const failed: string[] = [];
    page.on('requestfailed', (request) => {
      if (request.url().includes('genx-nav-')) failed.push(request.url());
    });
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    for (const [id, art, name] of BUTTONS) {
      const button = page.locator(`#${id}`);
      await expect(button).toHaveAccessibleName(name);
      expect(await button.evaluate((node) => getComputedStyle(node).backgroundImage)).toContain(
        art,
      );
    }
    // Below 1000 px (not TVs) Cast and Settings are painted icons; wider screens the labelled art.
    const phone = viewport.width < 1000;
    for (const [id, art] of [
      ['cast-button', phone ? 'genx-nav-cast-icon' : 'genx-nav-cast'],
      ['settings-button', phone ? 'genx-nav-settings-icon' : 'genx-nav-settings'],
    ])
      expect(
        await page.locator(`#${id}`).evaluate((node) => getComputedStyle(node).backgroundImage),
      ).toContain(art);
    // One row, inside the window.
    const boxes = await page.locator('.top-actions > button').evaluateAll((buttons) =>
      buttons
        .filter((button) => button.getClientRects().length > 0)
        .map((button) => button.getBoundingClientRect())
        .map((r) => ({ top: r.top, bottom: r.bottom, left: r.left, right: r.right })),
    );
    const tops = boxes.map((box) => box.top);
    expect(Math.max(...tops) - Math.min(...tops)).toBeLessThan(8);
    expect(Math.min(...boxes.map((box) => box.left))).toBeGreaterThanOrEqual(0);
    expect(Math.max(...boxes.map((box) => box.right))).toBeLessThanOrEqual(viewport.width);
    expect(failed).toEqual([]);
  });

// Owner, October 23, 2026: Free TV, Paid TV and GenXtra are one size on phones
// (an S25 is 697x330 in landscape and 360x697 upright). Before, the GenXtra
// badge was squeezed into its share of the row and drew at 32x13.
for (const viewport of [
  { width: 697, height: 330 },
  { width: 360, height: 697 },
])
  test(`Free TV, Paid TV and GenXtra share one size at ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    const boxes = await page.evaluate(() =>
      ['live-tv-button', 'paid-tv-button', 'genxtra-button'].map((id) => {
        const box = document.getElementById(id)!.getBoundingClientRect();
        return { width: box.width, height: box.height, top: box.top };
      }),
    );
    for (const box of boxes) {
      expect(Math.abs(box.width - boxes[0]!.width)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.height - boxes[0]!.height)).toBeLessThanOrEqual(1);
      expect(Math.abs(box.top - boxes[0]!.top)).toBeLessThanOrEqual(1);
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
    const badge = await page
      .locator('#genxtra-button .genxtra-badge')
      .evaluate((node) => node.getBoundingClientRect().width);
    expect(badge).toBeGreaterThanOrEqual(boxes[0]!.width - 1);
  });
