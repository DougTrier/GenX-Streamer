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
import { readFileSync } from 'node:fs';
const packageInfo = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
});

test('About shows the version, the author tab and the quick guide tab; Escape returns to its settings opener', async ({
  page,
}) => {
  await page.locator('#settings-button').click();
  await page.locator('#about-button').click();
  const about = page.getByRole('dialog', { name: 'About GenX Streamer', exact: true });
  await expect(about).toBeVisible();
  await expect(about.locator('#about-version')).toHaveText(
    `Version ${packageInfo.version} · Browser development preview`,
  );
  const authorTab = about.getByRole('tab', { name: 'About the Author' });
  const guideTab = about.getByRole('tab', { name: 'Quick Guide' });
  await expect(authorTab).toHaveAttribute('aria-selected', 'true');
  const authorPanel = about.getByRole('tabpanel', { name: 'About the Author' });
  await expect(authorPanel).toContainText('Doug Trier');
  // Support links sit in the Created by card, and Check for Updates comes right after it.
  const card = authorPanel.locator('.about-author');
  await expect(card).toContainText('you can support its development');
  await expect(card.locator('.about-support .about-support-card').first()).toBeVisible();
  expect(
    await authorPanel.evaluate((panel) => {
      const card = panel.querySelector('.about-author');
      return card?.nextElementSibling?.classList.contains('about-update') ?? false;
    }),
  ).toBe(true);
  await expect(authorPanel).toContainText('Share GenX Streamer');
  await expect(authorPanel.getByRole('button', { name: 'Send app to a friend' })).toBeVisible();
  await expect(about.locator('.about-guide')).toBeHidden();
  await guideTab.click();
  await expect(guideTab).toHaveAttribute('aria-selected', 'true');
  await expect(authorTab).toHaveAttribute('aria-selected', 'false');
  await expect(authorPanel).toBeHidden();
  const steps = about.getByRole('tabpanel', { name: 'Quick Guide' }).locator('li');
  await expect(steps).toHaveCount(8);
  await expect(steps.first()).toContainText('Find channels');
  expect(await page.locator('#video').evaluate((node: HTMLVideoElement) => node.paused)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(about).not.toBeVisible();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator('#about-button')).toBeFocused();
  // Reopening starts on the author tab again.
  await page.locator('#about-button').click();
  await expect(authorTab).toHaveAttribute('aria-selected', 'true');
});

test('Author and support links select only the verified fixed destinations and never open on mount', async ({
  page,
}) => {
  await page.evaluate(() => {
    Reflect.set(window, '__supportCalls', []);
    window.open = (...args) => {
      (Reflect.get(window, '__supportCalls') as unknown[][]).push(args);
      return null;
    };
  });
  await page.locator('#settings-button').click();
  await page.locator('#about-button').click();
  expect(await page.evaluate(() => Reflect.get(window, '__supportCalls'))).toEqual([]);
  const destinations = [
    ['Doug Trier on GitHub', 'https://github.com/dougtrier'],
    ['GitHub Sponsors', 'https://github.com/sponsors/dougtrier'],
    ['Buy Me a Coffee', 'https://www.buymeacoffee.com/dougtrier'],
    ['Open Collective', 'https://opencollective.com/trier-os'],
  ];
  for (const [name] of destinations) await page.getByRole('button', { name, exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, '__supportCalls'))).toEqual(
    destinations.map(([, url]) => [url, '_blank', 'noopener,noreferrer']),
  );
});

for (const viewport of [
  { width: 360, height: 480 },
  { width: 640, height: 360 },
  { width: 1280, height: 800 },
])
  test(`About keeps close, tabs and links reachable at ${viewport.width}x${viewport.height} with enlarged text`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await page.addStyleTag({ content: 'body { font-size: 200%; } button { font-size: inherit; }' });
    await page.locator('#settings-button').click();
    await page.locator('#about-button').click();
    const dialog = page.locator('#about-dialog');
    const close = dialog.getByRole('button', { name: 'Close about' });
    const closeBounds = await close.boundingBox();
    expect(closeBounds).not.toBeNull();
    expect(closeBounds!.y).toBeGreaterThanOrEqual(0);
    expect(closeBounds!.y + closeBounds!.height).toBeLessThanOrEqual(viewport.height);
    for (const tab of ['About the Author', 'Quick Guide'])
      await expect(dialog.getByRole('tab', { name: tab })).toBeInViewport();
    for (const label of [
      'Doug Trier on GitHub',
      'GitHub Sponsors',
      'Buy Me a Coffee',
      'Open Collective',
    ]) {
      const button = dialog.getByRole('button', { name: label, exact: true });
      await button.scrollIntoViewIfNeeded();
      await expect(button).toBeInViewport();
    }
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await dialog.getByRole('tab', { name: 'Quick Guide' }).click();
    const last = dialog.locator('.about-guide li').last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await close.click();
    await expect(dialog).not.toBeVisible();
  });
