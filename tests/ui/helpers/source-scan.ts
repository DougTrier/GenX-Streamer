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
import { chooseSettingsSection } from './settings-section';

/** Secondary playlist import remains available through the ordinary Settings route. */
export async function openPlaylistImport(page: Page, updateSourceId?: string): Promise<void> {
  if (!(await page.locator('#settings-dialog').isVisible()))
    await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'sources');
  await page.locator('#import-button').click();
  await expect(page.locator('#import-dialog')).toBeVisible();
  await expect(page.locator('#custom-source-options')).toHaveAttribute('open', '');
  if (updateSourceId !== undefined)
    await page
      .getByRole('combobox', { name: 'Add or update a file playlist', exact: true })
      .selectOption(updateSourceId);
}

/** Explicit controlled source configuration; this fixture does not claim all suggested providers. */
export async function configureControlledDiscoveryProviders(page: Page): Promise<void> {
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'advanced');
  const details = page.locator('details').filter({ has: page.locator('#provider-configuration') });
  if (!(await details.evaluate((element) => (element as HTMLDetailsElement).open)))
    await details.locator(':scope > summary').click();
  const editor = page.locator('#provider-configuration');
  const configuration = JSON.parse(await editor.inputValue());
  configuration.reviewedChannelProviders = [
    {
      id: 'iptv-org-global',
      name: 'Controlled global catalog',
      location: 'https://iptv-org.github.io/iptv/index.m3u',
      provenance: 'https://github.com/iptv-org/iptv',
      allowHttp: true,
    },
    {
      id: 'free-tv-public',
      name: 'Controlled Free-TV catalog',
      location: 'https://raw.githubusercontent.com/Free-TV/IPTV/master/playlist.m3u8',
      provenance: 'https://github.com/Free-TV/IPTV',
      allowHttp: true,
    },
  ];
  await editor.fill(JSON.stringify(configuration));
  await page.locator('#save-provider-configuration').click();
  await expect(page.locator('#provider-configuration-status')).toHaveText(
    'Discovery providers saved. Your existing channels are preserved.',
  );
  await page.locator('[data-close="settings-dialog"]').click();
}

/** Publish only through the ordinary scan review's explicit Save action. */
export async function saveReviewedSource(page: Page, fileCandidates?: number): Promise<void> {
  const review = page.getByRole('dialog', { name: 'Review source scan' });
  await expect(review).toBeVisible();
  if (fileCandidates !== undefined) {
    await expect(review.getByRole('status')).toHaveText(
      `${fileCandidates} channels ready for review. Streams have not been checked. Save to add the selected channels.`,
    );
    await expect(review.locator('input[type="checkbox"][aria-label^="Select "]')).toHaveCount(
      Math.min(fileCandidates, 50),
    );
  }
  const save = review.getByRole('button', { name: 'Save selected channels', exact: true });
  await expect(save).toBeEnabled();
  await save.click();
  await expect(review.getByRole('status')).toHaveText('Selected channels saved.');
  await review.getByRole('button', { name: 'Close scan review', exact: true }).click();
  await expect(review).not.toBeVisible();
}

/** Compare actual durable records/revisions, not just the currently rendered list. */
export async function canonicalRecords(page: Page): Promise<unknown[]> {
  return page.evaluate(async () => {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('tmg-tv', 1);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(new Error('Fixture storage could not open.'));
    });
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const transaction = database.transaction('records', 'readonly');
        const store = transaction.objectStore('records');
        const reads = ['catalog', 'preferences', 'health', 'catalogRevision', 'healthRevision'].map(
          (key) => store.get(key),
        );
        transaction.oncomplete = () => resolve(reads.map((read) => read.result ?? null));
        transaction.onabort = () => reject(new Error('Fixture storage read aborted.'));
        transaction.onerror = () => reject(new Error('Fixture storage read failed.'));
      });
    } finally {
      database.close();
    }
  });
}
