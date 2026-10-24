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

import { expect, type Page } from '@playwright/test';
import { openPlaylistImport, saveReviewedSource } from './source-scan';
import { chooseSettingsSection } from './settings-section';

/** User-imported saved channels: typing/Enter must filter without online acquisition. */
export async function seedSavedSearchChannels(page: Page): Promise<void> {
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'saved-search.m3u',
    mimeType: 'text/plain',
    buffer: Buffer.from(
      '#EXTM3U\n#EXTINF:-1 tvg-id="bears" group-title="Sports",Chicago Bears TV\nhttps://search.fixture.invalid/bears\n#EXTINF:-1 tvg-id="news" group-title="News",Metro News\nhttps://search.fixture.invalid/news\n',
    ),
  });
  await saveReviewedSource(page, 2);
  if (await page.getByLabel('Viewing panel', { exact: true }).isVisible())
    await page.getByLabel('Viewing panel', { exact: true }).selectOption('channels');
  await expect(page.locator('#channel-count')).toHaveText('2 channels');
}

/** Program search uses the existing Guide workflow, never a removed Search page. */
export async function openGuideProgramSearch(page: Page, query: string) {
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'advanced');
  await page.locator('#advanced-guide-button').click();
  const guide = page.getByRole('dialog', { name: 'Program guide', exact: true });
  await expect(guide).toBeVisible();
  await guide.getByRole('button', { name: 'Guide view', exact: true }).click();
  await guide.getByRole('option', { name: 'Search programs', exact: true }).click();
  const details = guide.locator('.guide-search-options');
  if (!(await details.evaluate((node) => (node as HTMLDetailsElement).open)))
    await details.getByText('Change program search', { exact: true }).click();
  const input = guide.getByRole('searchbox', { name: 'Find a program', exact: true });
  await expect(input).toBeVisible();
  await input.fill(query);
  await guide.getByRole('button', { name: 'Search programs', exact: true }).click();
  return { guide, input };
}
