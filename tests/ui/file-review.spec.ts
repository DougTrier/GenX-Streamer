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
import { expect, test, type Page } from '@playwright/test';
import { canonicalRecords, saveReviewedSource } from './helpers/source-scan';

const playlist =
  '#EXTM3U\n#EXTINF:-1 tvg-id="local-one" tvg-logo="https://file-review.invalid/logo.png" group-title="Fixture",Local one\nhttps://file-review.invalid/one.m3u8\n#EXTINF:-1 tvg-id="local-two" group-title="Fixture",Local two\nhttps://file-review.invalid/two.m3u8\n';
async function chooseFile(page: Page, text = playlist, updateSourceId?: string) {
  await openPlaylistImport(page, updateSourceId);
  await page
    .locator('#playlist-file')
    .setInputFiles({ name: 'local-review.m3u', mimeType: 'text/plain', buffer: Buffer.from(text) });
  const review = page.getByRole('dialog', { name: 'Review source scan' });
  await expect(review.getByRole('status')).toContainText('channels ready for review', {
    timeout: 30000,
  });
  return review;
}

test('choosing and reviewing a real worker-parsed file makes no requests or durable writes', async ({
  page,
}) => {
  let requests = 0;
  await page.route('https://file-review.invalid/**', (route) => {
    requests++;
    return route.abort();
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const before = await canonicalRecords(page);
  const review = await chooseFile(page);
  await expect(review.locator('li label')).toHaveCount(2);
  await expect(review.locator('li label').first()).toContainText('Not checked');
  await expect(
    review.getByRole('button', { name: 'Save selected channels', exact: true }),
  ).toBeEnabled();
  expect(await canonicalRecords(page)).toEqual(before);
  expect(requests).toBe(0);
  await page.reload();
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  expect(await canonicalRecords(page)).toEqual(before);
  await expect(page.locator('.channel')).toHaveCount(0);
  expect(requests).toBe(0);
});

test('explicit saved file update preserves source identity, favorites and removals', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await chooseFile(page);
  await saveReviewedSource(page);
  await expect(page.locator('.channel')).toHaveCount(2);
  const first = await canonicalRecords(page);
  const catalog = JSON.parse(first[0] as string);
  const sourceId = catalog.sources[0].id;
  const channelId = catalog.channels.find(
    (channel: { providerId: string }) => channel.providerId === 'local-one',
  ).id;
  await page
    .locator('.channel')
    .filter({ has: page.locator('strong', { hasText: 'Local one' }) })
    .click();
  await page.locator('#favorite-button').click();
  await expect
    .poll(async () => JSON.parse((await canonicalRecords(page))[1] as string).favorites)
    .toContain(channelId);
  await page
    .locator('.channel')
    .filter({ has: page.locator('strong', { hasText: 'Local two' }) })
    .click();
  await page.locator('#remove-channel').click();
  await expect
    .poll(
      async () => JSON.parse((await canonicalRecords(page))[1] as string).removedChannels.length,
    )
    .toBe(1);
  const removed = JSON.parse((await canonicalRecords(page))[1] as string).removedChannels;
  await chooseFile(page, playlist.replace('Local one', 'Local renamed'), sourceId);
  await saveReviewedSource(page);
  const second = await canonicalRecords(page);
  const next = JSON.parse(second[0] as string);
  expect(next.sources).toHaveLength(1);
  expect(next.sources[0].id).toBe(sourceId);
  expect(
    next.channels.find((channel: { providerId: string }) => channel.providerId === 'local-one').id,
  ).toBe(channelId);
  expect(JSON.parse(second[1] as string).favorites).toContain(channelId);
  expect(JSON.parse(second[1] as string).removedChannels).toEqual(removed);
  await expect(page.locator('.channel')).toHaveCount(1);
  await expect(page.locator('.channel strong')).toHaveText('Local renamed');
  await page.reload();
  await expect(page.locator('.channel strong')).toHaveText('Local renamed');
  const restarted = await canonicalRecords(page);
  expect(JSON.parse(restarted[0] as string)).toEqual(next);
  expect(JSON.parse(restarted[1] as string).favorites).toContain(channelId);
  expect(JSON.parse(restarted[1] as string).removedChannels).toEqual(removed);
});

test('separate same-name file imports retain distinct sources and scoped user choices after reload', async ({
  page,
}) => {
  await page.route('https://file-review.invalid/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await chooseFile(page);
  await saveReviewedSource(page);
  await page.locator('.channel').first().click();
  await page.locator('#favorite-button').click();
  await expect(page.locator('#favorite-button')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.channel').last().click();
  await page.locator('#remove-channel').click();
  await expect(page.locator('.channel')).toHaveCount(1);
  const before = await canonicalRecords(page);
  const originalCatalog = JSON.parse(before[0] as string);
  const preferences = JSON.parse(before[1] as string);
  const originalSource = originalCatalog.sources[0];

  // Default Add a separate playlist must not infer update authority from its filename.
  await chooseFile(page);
  await saveReviewedSource(page);
  const after = await canonicalRecords(page);
  const next = JSON.parse(after[0] as string);
  expect(next.sources).toHaveLength(2);
  expect(next.sources.map((source: { name: string }) => source.name)).toEqual([
    'local-review.m3u',
    'local-review.m3u',
  ]);
  const addedSource = next.sources.find(
    (source: { id: string }) => source.id !== originalSource.id,
  );
  expect(addedSource).toBeDefined();
  expect(addedSource.location).not.toBe(originalSource.location);
  expect(next.channels).toHaveLength(4);
  expect(
    next.channels.filter((channel: { sourceId: string }) => channel.sourceId === originalSource.id),
  ).toEqual(originalCatalog.channels);
  expect(
    next.channels.filter((channel: { sourceId: string }) => channel.sourceId === addedSource.id),
  ).toHaveLength(2);
  expect(JSON.parse(after[1] as string).favorites).toEqual(preferences.favorites);
  expect(JSON.parse(after[1] as string).removedChannels).toEqual(preferences.removedChannels);
  await expect(page.locator('#channel-count')).toHaveText('3 channels');
  await page.reload();
  await expect(page.locator('#channel-count')).toHaveText('3 channels');
  const restarted = await canonicalRecords(page);
  expect(JSON.parse(restarted[0] as string)).toEqual(next);
  expect(JSON.parse(restarted[1] as string).favorites).toEqual(preferences.favorites);
  expect(JSON.parse(restarted[1] as string).removedChannels).toEqual(preferences.removedChannels);
});

test('Cancel owns a real delayed File.text until settlement and cannot publish its late result', async ({
  page,
}) => {
  await page.addInitScript(() => {
    const original = File.prototype.text;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    Object.defineProperty(window, '__releaseFileRead', { value: release });
    File.prototype.text = async function () {
      if (this.name === 'held-local.m3u') await held;
      return original.call(this);
    };
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const before = await canonicalRecords(page);
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'held-local.m3u',
    mimeType: 'text/plain',
    buffer: Buffer.from(playlist),
  });
  const review = page.getByRole('dialog', { name: 'Review source scan' });
  await expect(review.getByRole('status')).toHaveText('Reading your playlist file…');
  await review.getByRole('button', { name: 'Cancel operation', exact: true }).click();
  await expect(review.getByRole('status')).toHaveText('Reading your playlist file…');
  expect(await canonicalRecords(page)).toEqual(before);
  await page.evaluate(() =>
    (window as unknown as { __releaseFileRead(): void }).__releaseFileRead(),
  );
  await expect(review.getByRole('alert')).toContainText('File review canceled');
  await expect(
    review.getByRole('button', { name: 'Save selected channels', exact: true }),
  ).toBeHidden();
  expect(await canonicalRecords(page)).toEqual(before);
});

for (const kind of ['oversized', 'too-many'] as const) {
  test(`real ${kind} file refuses partial publication`, async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    const before = await canonicalRecords(page);
    await openPlaylistImport(page);
    const text =
      kind === 'oversized'
        ? 'x'.repeat(20 * 1024 * 1024 + 1)
        : '#EXTM3U\n' +
          Array.from(
            { length: 100001 },
            (_, index) =>
              `#EXTINF:-1 tvg-id="${index}",Channel ${index}\nhttps://file-review.invalid/${index}\n`,
          ).join('');
    await page
      .locator('#playlist-file')
      .setInputFiles({ name: `${kind}.m3u`, mimeType: 'text/plain', buffer: Buffer.from(text) });
    const review = page.getByRole('dialog', { name: 'Review source scan' });
    await expect(review.getByRole('alert')).toContainText(
      kind === 'oversized' ? '20 MiB' : '100,000',
      { timeout: 30000 },
    );
    await expect(
      review.getByRole('button', { name: 'Save selected channels', exact: true }),
    ).toBeHidden();
    expect(await canonicalRecords(page)).toEqual(before);
  });
}
