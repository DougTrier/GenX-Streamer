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

import { canonicalRecords, openPlaylistImport } from './helpers/source-scan';
import { chooseCategory } from './helpers/category';
import { saveReviewedSource } from './helpers/source-scan';
import { chooseSettingsSection } from './helpers/settings-section';
import { expect, test, type Page } from '@playwright/test';

const playlist = (newsName = 'World News', streamSuffix = 'one'): string =>
  `\uFEFF#EXTM3U\r\n#EXTINF:-1 tvg-id="news" group-title="News, World",${newsName}\r\nhttps://media.invalid/${streamSuffix}\r\n#EXTINF:-1 tvg-id="sports" group-title="Sports",Arena Sports\r\nhttps://media.invalid/sports\r\n#EXTINF:-1 tvg-id="film" group-title="Movies",Film, Classics\r\nhttps://media.invalid/film\r\n`;
async function importFile(
  page: Page,
  text = playlist(),
  name = 'fixture.m3u',
  fileCandidates?: number,
  updateSourceId?: string,
): Promise<void> {
  await openPlaylistImport(page, updateSourceId);
  await page
    .locator('#playlist-file')
    .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
  await saveReviewedSource(page, fileCandidates);
  await expect(page.locator('#import-dialog')).not.toBeVisible({ timeout: 30_000 });
}
async function noHorizontalOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
}

test.beforeEach(async ({ page }) => {
  await page.route('https://media.invalid/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#storage-status')).toContainText('Browser development preview');
});

test('worker file import, filters, search, and metadata render as text', async ({ page }) => {
  await importFile(page);
  const sourceId = JSON.parse((await canonicalRecords(page))[0] as string).sources[0].id;
  await expect(page.locator('#channel-count')).toHaveText('3 channels');
  await chooseCategory(page, 'Sports');
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await expect(page.locator('.channel strong')).toHaveText('Arena Sports');
  await chooseCategory(page, 'News');
  await expect(page.locator('.channel strong')).toHaveText('World News');
  await chooseCategory(page, 'All');
  await page.getByRole('searchbox', { name: 'Search channels' }).fill('classics');
  await expect(page.locator('.channel strong')).toHaveText('Film, Classics');
  await page.getByRole('searchbox', { name: 'Search channels' }).fill('does not exist');
  await expect(page.locator('#list-empty')).toHaveText(
    'No channels here. Try another filter or search.',
  );
  await page.getByRole('searchbox', { name: 'Search channels' }).fill('');
  await importFile(
    page,
    playlist('<img src=x onerror="window.injected=true">'),
    'fixture.m3u',
    undefined,
    sourceId,
  );
  await expect(page.locator('.channel strong').first()).toHaveText(
    '<img src=x onerror="window.injected=true">',
  );
  expect(await page.evaluate(() => Reflect.get(window, 'injected'))).toBeUndefined();
  await expect(page.locator('#channel-rows img')).toHaveCount(0);
});

test('favorites survive an explicit file playlist update and browser restart', async ({ page }) => {
  await importFile(page);
  const sourceId = JSON.parse((await canonicalRecords(page))[0] as string).sources[0].id;
  await page.locator('.channel').first().click();
  await expect(page.locator('#favorite-button')).toBeEnabled();
  const firstIdentity = await page.locator('.channel').first().getAttribute('data-channel');
  await page.locator('#favorite-button').click();
  await expect(page.locator('#favorite-button')).toHaveAttribute('aria-pressed', 'true');
  await importFile(page, playlist('Renamed News', 'changed'), 'fixture.m3u', undefined, sourceId);
  await expect(page.locator('.channel').first()).toHaveAttribute('data-channel', firstIdentity!);
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await expect(page.locator('.channel strong')).toHaveText('Renamed News');
  await page.reload();
  await expect(page.locator('#channel-count')).toHaveText('3 channels');
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.locator('.channel strong')).toHaveText('Renamed News');
  await expect(page.locator('#source-status')).toHaveText('1 playlist saved');
});

test('controlled URL source refresh retains favorite identities after stream changes', async ({
  page,
}) => {
  let revision = 0;
  await page.route('https://fixture.invalid/playlist.m3u', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      headers: { 'access-control-allow-origin': '*' },
      body: playlist(revision ? 'Refreshed News' : 'World News', String(revision)),
    }),
  );
  await openPlaylistImport(page);
  const respondingMedia = (route: import('@playwright/test').Route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/vnd.apple.mpegurl',
      body: '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n',
    });
  await page.route('https://media.invalid/**', respondingMedia);
  await page.locator('#playlist-url').fill('https://fixture.invalid/playlist.m3u');
  await page.locator('#load-button').click();
  await saveReviewedSource(page);
  await page.unroute('https://media.invalid/**', respondingMedia);
  await page.locator('.channel').first().click();
  await page.locator('#favorite-button').click();
  await expect(page.locator('#favorite-button')).toHaveAttribute('aria-pressed', 'true');
  revision++;
  await page.locator('#refresh-button').click();
  await expect(page.locator('.channel strong').first()).toHaveText('Refreshed News');
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(page.locator('.channel strong')).toHaveText('Refreshed News');
});

test('malformed playlist preserves saved catalog and gives actionable feedback', async ({
  page,
}) => {
  await importFile(page);
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'fixture.m3u',
    mimeType: 'text/plain',
    buffer: Buffer.from('#EXTM3U\n#EXTINF:-1,Missing URL'),
  });
  const review = page.getByRole('dialog', { name: 'Review source scan' });
  await expect(review.getByRole('alert')).toContainText('no stream URL');
  await expect(
    review.getByRole('button', { name: 'Save selected channels', includeHidden: true }),
  ).toBeDisabled();
  await review.getByRole('button', { name: 'Close scan review' }).click();
  await expect(page.locator('#channel-count')).toHaveText('3 channels');
  await page.reload();
  await expect(page.locator('#channel-count')).toHaveText('3 channels');
});

test('canceling a pending download retains cached channels and ignores its late response', async ({
  page,
}) => {
  await importFile(page);
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = false;
  await page.route('https://fixture.invalid/slow.m3u', async (route) => {
    entered = true;
    await pending;
    await route
      .fulfill({
        status: 200,
        contentType: 'text/plain',
        headers: { 'access-control-allow-origin': '*' },
        body: playlist('Late result'),
      })
      .catch(() => undefined);
  });
  await openPlaylistImport(page);
  await page.locator('#playlist-url').fill('https://fixture.invalid/slow.m3u');
  await page.locator('#load-button').click();
  await expect.poll(() => entered).toBe(true);
  const review = page.getByRole('dialog', { name: 'Review source scan' });
  await review.getByRole('button', { name: 'Cancel operation', exact: true }).click();
  await expect(review.getByRole('status')).toHaveText('Scan canceled. Existing channels retained.');
  release();
  await review.getByRole('button', { name: 'Close scan review', exact: true }).click();
  await page.reload();
  await expect(page.locator('#channel-count')).toHaveText('3 channels');
  await expect(page.locator('.channel strong').first()).toHaveText('World News');
  await expect(page.locator('#source-status')).toHaveText('1 playlist saved');
});

test('browser full screen toggles the workspace and exits cleanly', async ({ page }) => {
  await page.locator('#fullscreen-button').click();
  await expect(page.locator('#fullscreen-button')).toHaveAttribute('aria-pressed', 'true');
  expect(
    await page.evaluate(() => document.fullscreenElement?.classList.contains('workspace')),
  ).toBe(true);
  await page.locator('#fullscreen-button').click();
  await expect(page.locator('#fullscreen-button')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test('keyboard divider persists and expand gives the player more surface', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  const divider = page.getByRole('separator', { name: 'Resize channel panel' });
  await expect(divider).toHaveAttribute('aria-valuemax', '600');
  await divider.focus();
  await page.keyboard.press('End');
  await expect(divider).toHaveAttribute('aria-valuenow', '600');
  await page.keyboard.press('ArrowRight');
  await expect(divider).toHaveAttribute('aria-valuenow', '600');
  await page.keyboard.press('ArrowLeft');
  await expect(divider).toHaveAttribute('aria-valuenow', '580');
  await page.reload();
  await expect(divider).toHaveAttribute('aria-valuenow', '580');
  const before = await page.locator('#screen').boundingBox();
  await page.locator('#expand-button').click();
  await expect(page.locator('.browser')).not.toBeVisible();
  const after = await page.locator('#screen').boundingBox();
  expect(after!.width).toBeGreaterThan(before!.width);
  await page.locator('#expand-button').click();
  await expect(page.locator('.browser')).toBeVisible();
});

test('invalid settings import leaves existing saved audio preferences intact', async ({ page }) => {
  await page.locator('#mute-button').click();
  await expect(page.locator('#mute-button')).toHaveText('Unmute');
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'preferences');
  await page.locator('#settings-file').setInputFiles({
    name: 'invalid.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"schemaVersion":999}'),
  });
  await expect(page.locator('#notice')).toContainText('invalid preferences schema');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.locator('#mute-button')).toHaveText('Unmute');
  await page.reload();
  await expect(page.locator('#mute-button')).toHaveText('Unmute');
});

for (const width of [360, 768, 1280]) {
  test(`approved controls and channel navigation fit viewport ${width}`, async ({ page }) => {
    await page.setViewportSize({ width, height: 800 });
    await importFile(page);
    await noHorizontalOverflow(page);
    // Upright phones show the categories as one dropdown beside Favs and Guide.
    const categories = page
      .locator('#compact-filter, .in-app-select[data-native-select-id="compact-filter"]')
      .locator('visible=true');
    for (let selector of [
      '#mute-button',
      '#expand-button',
      '#fullscreen-button',
      '#search',
      '[data-filter="sports"]',
    ]) {
      if (selector === '[data-filter="sports"]' && (await categories.count()) > 0)
        selector =
          '#compact-filter, .in-app-select[data-native-select-id="compact-filter"] >> visible=true';
      // TV and Windows: the categories are one button in the channel row.
      else if (
        selector === '[data-filter="sports"]' &&
        (await page.locator('#category-button').isVisible())
      )
        selector = '#category-button';
      if (!(await page.locator(selector).first().isVisible())) {
        await expect(page.locator('#compact-view')).toBeVisible();
        await page.locator('#compact-view').selectOption('channels');
      }
      await expect(page.locator(selector).first()).toBeVisible();
      const box = await page.locator(selector).first().boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
    await page.locator('#settings-button').click();
    await noHorizontalOverflow(page);
    await page.getByRole('button', { name: 'Close settings' }).click();
    if (!(await page.locator('#expand-button').isVisible()))
      await page.locator('#compact-view').selectOption('watch');
    await page.locator('#expand-button').click();
    await noHorizontalOverflow(page);
  });
}

test('real worker imports 100,000 channels with bounded rendered DOM and working search', async ({
  page,
}) => {
  test.setTimeout(60_000);
  let text = '#EXTM3U\n';
  for (let i = 0; i < 100_000; i++) text += `#EXTINF:-1,Ch ${i}\nhttps://example.org/x\n`;
  await importFile(page, text, 'large.m3u', 100_000);
  await expect(page.locator('#channel-count')).toHaveText('100,000 channels');
  expect(await page.locator('.channel').count()).toBeLessThan(30);
  await page.locator('#channel-list').evaluate((list) => {
    list.scrollTop = list.scrollHeight;
  });
  await expect(page.locator('.channel strong').last()).toHaveText('Ch 99999');
  expect(await page.locator('.channel').count()).toBeLessThan(30);
  await page.locator('#search').fill('Ch 99999');
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await expect(page.locator('.channel strong')).toHaveText('Ch 99999');
});

test('before a stream starts the picture shows the GenX play screen, not the browser’s gray play icon', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  // Android WebView draws a big gray play icon on a video without a frame
  // unless the video has a poster: GenX's own play screen stands in.
  const poster = await page.locator('#video').getAttribute('poster');
  expect(poster).toMatch(/genx-play-display.*\.jpg$/);
  const size = await page.evaluate(
    (src) =>
      new Promise<[number, number]>((resolve, reject) => {
        const image = new Image();
        image.onload = () => resolve([image.naturalWidth, image.naturalHeight]);
        image.onerror = () => reject(new Error('play screen did not load'));
        image.src = src!;
      }),
    poster,
  );
  expect(size).toEqual([1280, 720]);
});
