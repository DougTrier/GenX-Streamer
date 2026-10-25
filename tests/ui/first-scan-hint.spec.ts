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

/** Actual hint module over a fixture shell; the in-memory channel count is the test's own. */
async function mount(page: Page): Promise<void> {
  await page.route('**/first-scan-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><div id="app" data-startup="loading" data-content-library="live" data-device-kind="tv"><button id="paid-tv-button" aria-pressed="false">Paid TV</button><div class="search-controls"><button id="search-programs">Find channels online</button></div><section id="inline-source-scan" hidden>scan<button id="inline-scan-stop" hidden>Stop</button></section></div></body></html>',
    }),
  );
  await page.goto('/first-scan-fixture');
  await page.evaluate(async () => {
    const path = '/src/ui/scan/first-scan-hint.ts';
    const { mountFirstScanHint } = await import(path);
    Reflect.set(window, 'count', 0);
    mountFirstScanHint(
      () => false,
      () => Reflect.get(window, 'count') as number,
    );
  });
}
const callout = (page: Page) => page.locator('.first-scan-callout');

test('the first scan is pointed out, explained while it runs, then never shown again', async ({
  page,
}) => {
  await mount(page);
  // Nothing while the app is still starting (the catalog is not known yet).
  await page.waitForTimeout(700);
  await expect(callout(page)).toBeHidden();
  await page.evaluate(() => (document.getElementById('app')!.dataset.startup = 'completed'));
  await expect(callout(page)).toBeVisible();
  await expect(callout(page).locator('strong')).toHaveText('Start here');
  await expect(page.locator('#search-programs')).toHaveClass(/first-scan/);
  await expect(page.locator('#search-programs')).toBeFocused();
  // The scan runs: the note explains the wait; the glow goes.
  // The panel opening is not enough: the scan must be running (its Stop button shows).
  await page.evaluate(() => {
    document.getElementById('inline-source-scan')!.hidden = false;
    document.getElementById('inline-scan-stop')!.hidden = false;
  });
  await expect(callout(page).locator('strong')).toHaveText('First scan');
  // Stopped (the panel stays open with Finish scan): the note goes at once.
  await page.evaluate(() => (document.getElementById('inline-scan-stop')!.hidden = true));
  await expect(callout(page)).toBeHidden();
  await page.evaluate(() => (document.getElementById('inline-scan-stop')!.hidden = false));
  await expect(callout(page)).toBeVisible();
  await expect(callout(page).locator('strong')).toHaveText('First scan');
  await expect(callout(page)).toContainText('can take a long time');
  await expect(page.locator('#search-programs')).not.toHaveClass(/first-scan/);
  // Scan over with channels saved: gone, and it stays gone for later scans.
  await page.evaluate(() => {
    Reflect.set(window, 'count', 9700);
    document.getElementById('inline-source-scan')!.hidden = true;
  });
  await expect(callout(page)).toBeHidden();
  await page.evaluate(() => (document.getElementById('inline-source-scan')!.hidden = false));
  await page.waitForTimeout(700);
  await expect(callout(page)).toBeHidden();
});

test('a paid account or another library never shows it', async ({ page }) => {
  await mount(page);
  await page.evaluate(() => {
    document.getElementById('paid-tv-button')!.setAttribute('aria-pressed', 'true');
    document.getElementById('app')!.dataset.startup = 'completed';
  });
  await page.waitForTimeout(700);
  await expect(callout(page)).toBeHidden();
  await page.evaluate(() => {
    document.getElementById('paid-tv-button')!.setAttribute('aria-pressed', 'false');
    document.getElementById('app')!.dataset.contentLibrary = 'genxtra';
  });
  await page.waitForTimeout(700);
  await expect(callout(page)).toBeHidden();
});
