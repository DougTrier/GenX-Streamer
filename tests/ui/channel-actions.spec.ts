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
import { canonicalRecords, openPlaylistImport, saveReviewedSource } from './helpers/source-scan';
import { chooseSettingsSection } from './helpers/settings-section';

const names = [
  'Zulu News',
  'Alpha Sports',
  'Beta Documentary',
  ...Array.from({ length: 77 }, (_, i) => `Channel ${String(i).padStart(2, '0')}`),
];
const playlist =
  '#EXTM3U\n' +
  names
    .map(
      (name, i) =>
        `#EXTINF:-1 tvg-id="actions-${i}" group-title="${i === 2 ? 'Documentary' : i === 1 ? 'Sports' : 'News'}",${name}\nhttps://actions.fixture.invalid/${i}\n`,
    )
    .join('');

test('Manage removes an unplayed channel durably without tuning, and Settings can restore it', async ({
  page,
}) => {
  const acquired = await prepare(page);
  const original = await canonicalRecords(page);
  const title = await page.locator('#watch-title').textContent();
  const row = page
    .locator('.channel')
    .filter({ has: page.locator('strong', { hasText: /^Beta Documentary$/ }) });
  const id = await row.getAttribute('data-channel');
  await page.getByRole('button', { name: 'Favorite Beta Documentary', exact: true }).click();
  await page.getByRole('button', { name: 'Manage Beta Documentary', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Beta Documentary', exact: true });
  await dialog.getByRole('button', { name: 'Remove channel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#channel-count')).toHaveText('79 channels');
  expect(await page.locator('#watch-title').textContent()).toBe(title);
  await expect(page.locator('#video')).toHaveJSProperty('paused', true);
  const saved = await canonicalRecords(page);
  expect(saved[0]).toEqual(original[0]);
  expect(JSON.parse(String(saved[1])).removedChannels).toEqual([id]);
  expect(JSON.parse(String(saved[1])).favorites).toContain(id);
  await page.reload();
  await expect(page.locator('#channel-count')).toHaveText('79 channels');
  await expect(
    page.getByRole('button', { name: 'Manage Beta Documentary', exact: true }),
  ).toHaveCount(0);
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'sources');
  await page.getByRole('button', { name: 'Restore removed channels', exact: true }).click();
  await expect(page.locator('#channel-count')).toHaveText('80 channels');
  expect(acquired()).toBe(0);
});

async function prepare(page: Page): Promise<() => number> {
  let acquired = 0;
  await page.route('https://**', (route) => {
    acquired++;
    return route.abort();
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'row-actions.m3u',
    mimeType: 'text/plain',
    buffer: Buffer.from(playlist),
  });
  await saveReviewedSource(page, 80);
  await expect(page.locator('#channel-count')).toHaveText('80 channels');
  return () => acquired;
}

test('heart changes favorites without tuning and favorites precede the chosen name order after restart', async ({
  page,
}) => {
  const acquired = await prepare(page);
  const original = await canonicalRecords(page);
  const title = await page.locator('#watch-title').textContent();
  const heart = page.getByRole('button', { name: 'Favorite Beta Documentary', exact: true });
  await heart.click();
  await expect(heart).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.channel strong').first()).toHaveText('Beta Documentary');
  await page.getByRole('button', { name: 'Location and sort', exact: true }).click();
  await page.getByLabel('Channel sort', { exact: true }).selectOption('name');
  await page.keyboard.press('Escape');
  await expect(page.locator('.channel strong').nth(1)).toHaveText('Alpha Sports');
  const saved = await canonicalRecords(page);
  expect(saved[0]).toEqual(original[0]);
  expect(saved[2]).toEqual(original[2]);
  expect(JSON.parse(String(saved[1])).favorites).toHaveLength(1);
  expect(await page.locator('#watch-title').textContent()).toBe(title);
  await expect(page.locator('#video')).toHaveJSProperty('paused', true);
  expect(acquired()).toBe(0);
  await page.reload();
  await expect(page.locator('.channel strong').first()).toHaveText('Beta Documentary');
  await expect(
    page.getByRole('button', { name: 'Favorite Beta Documentary', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  expect(acquired()).toBe(0);
});

for (const viewport of [
  { width: 960, height: 540 },
  { width: 390, height: 844 },
]) {
  test(`row actions preserve remote identity and approved target geometry through category changes ${viewport.width}x${viewport.height}`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    const acquired = await prepare(page);
    if (viewport.width === 960)
      await page.locator('#app').evaluate((root) => {
        root.dataset.deviceKind = 'tv';
      });
    if (await page.getByLabel('Viewing panel').isVisible())
      await page.getByLabel('Viewing panel').selectOption('channels');
    const original = await canonicalRecords(page);
    const play = page
      .locator('.channel')
      .filter({ has: page.locator('strong', { hasText: /^Beta Documentary$/ }) });
    const id = await play.getAttribute('data-channel');
    await play.focus();
    const manage = page.getByRole('button', { name: 'Manage Beta Documentary', exact: true });
    const favorite = page.getByRole('button', { name: 'Favorite Beta Documentary', exact: true });
    await page.keyboard.press('ArrowRight');
    await expect(manage).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(favorite).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(manage).toBeFocused();
    for (const button of [
      play,
      manage,
      page.getByRole('button', { name: 'Favorite Beta Documentary', exact: true }),
    ]) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.width).toBeGreaterThanOrEqual(
        viewport.width === 960 ? (button === manage ? 26 : 34) : 44,
      );
      expect(box!.height).toBeGreaterThanOrEqual(viewport.width === 960 ? 34 : 44);
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
      expect(box!.y).toBeGreaterThanOrEqual(0);
      expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
    }
    expect(await page.locator('.channel button').count()).toBe(0);
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Beta Documentary', exact: true });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Sports', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(manage).toBeFocused();
    const changed = await canonicalRecords(page);
    expect(changed[0]).toEqual(original[0]);
    expect(JSON.parse(String(changed[1])).channelCategoryOverrides).toEqual([
      { channelId: id, category: 'Sports' },
    ]);
    await page.reload();
    if (await page.getByLabel('Viewing panel').isVisible())
      await page.getByLabel('Viewing panel').selectOption('channels');
    await manage.click();
    await expect(dialog.getByRole('button', { name: 'Sports', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await dialog
      .getByRole('button', { name: 'Use source category (Documentary)', exact: true })
      .click();
    await expect(dialog).not.toBeVisible();
    expect(JSON.parse(String((await canonicalRecords(page))[1])).channelCategoryOverrides).toEqual(
      [],
    );
    await expect(manage).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(favorite).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(manage).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(play).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(
      page.locator('.channel').filter({ has: page.locator('strong', { hasText: /^Channel 00$/ }) }),
    ).toBeFocused();
    await page.keyboard.press('End');
    await expect(page.locator('.channel strong').last()).toHaveText('Channel 76');
    expect(await page.locator('.channel-row').count()).toBeLessThan(30);
    await page.keyboard.press('ArrowRight');
    await expect(
      page.getByRole('button', { name: 'Manage Channel 76', exact: true }),
    ).toBeFocused();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(
      page.getByRole('button', { name: 'Manage Channel 76', exact: true }),
    ).toBeFocused();
    await expect(page.locator('#video')).toHaveJSProperty('paused', true);
    expect(acquired()).toBe(0);
  });
}
