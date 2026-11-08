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
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { canonicalRecords, openPlaylistImport, saveReviewedSource } from './helpers/source-scan';

test('Pass It Along previews and merges an imported favorites file, then exports it', async ({
  page,
}) => {
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  const channel = {
    name: 'Share Favorites Fixture',
    category: 'News',
    stream: 'https://public.example.com/channel.m3u8',
  };
  const { stream, ...label } = channel;
  const endpoint = createHash('sha256').update(`genx-favorites:endpoint:${stream}`).digest('hex');
  const bundle = {
    format: 'genx-free-tv-favorites',
    version: 1,
    channels: [{ ...label, endpoint }],
  };
  const unknown = {
    ...label,
    name: 'Untrusted unknown channel',
    endpoint: 'f'.repeat(64),
    stream: 'https://untrusted.example.com/redirect.m3u8',
  };
  let remoteRequests = 0;
  await page.route('https://untrusted.example.com/**', (route) => {
    remoteRequests++;
    return route.abort();
  });
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'saved.m3u',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      `#EXTM3U\n#EXTINF:-1 group-title="News",${channel.name}\n${channel.stream}\n`,
    ),
  });
  await saveReviewedSource(page, 1);
  const before = (await canonicalRecords(page))[0];
  await page.locator('#settings-button').click();
  await page.locator('#send-app-button').click();
  const panel = page.locator('.send-app-favorites');
  await expect(panel.getByRole('heading', { name: 'Share Favorites' })).toBeVisible();
  async function importFile() {
    const chooser = page.waitForEvent('filechooser');
    await panel.getByRole('button', { name: 'Import favorites' }).click();
    await (
      await chooser
    ).setFiles({
      name: 'genx-favorites.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          ...bundle,
          channels: [{ ...bundle.channels[0]!, name: 'Untrusted replacement name' }, unknown],
        }),
      ),
    });
  }
  await importFile();
  await expect(panel.getByRole('status')).toContainText('1 to add to favorites');
  await expect(panel.getByRole('status')).toContainText('1 missing from this device');
  await expect(panel.getByText(channel.name, { exact: true })).toBeVisible();
  await expect(panel.getByText('Untrusted replacement name', { exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Add favorites' }).click();
  await expect(panel.getByRole('status')).toContainText('Added 1 favorite.');
  expect((await canonicalRecords(page))[0]).toBe(before);
  expect(remoteRequests).toBe(0);

  await importFile();
  await expect(panel.getByRole('status')).toContainText('1 already saved');
  await expect(panel.getByRole('button', { name: 'Add favorites' })).toBeHidden();
  await panel.getByRole('button', { name: 'Cancel favorites transfer' }).click();

  const saving = page.waitForEvent('download');
  await panel.getByRole('button', { name: 'Export favorites' }).click();
  const download = await saving;
  expect(download.suggestedFilename()).toBe('genx-favorites.json');
  expect(JSON.parse(await readFile((await download.path())!, 'utf8'))).toEqual(bundle);
});
