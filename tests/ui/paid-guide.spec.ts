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

/** The real Paid TV guide panel and timeline with a controlled guide host (no native, no network). */
async function mount(
  page: Page,
  options: { stored: 'none' | 'fresh' | 'old'; download: 'ok' | 'fail' },
): Promise<void> {
  await page.route('**/paid-guide-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body style="margin:0"><div id="host" style="display:flex;width:1100px;height:640px"></div></body></html>',
    }),
  );
  await page.goto('/paid-guide-fixture');
  await page.evaluate(async (options) => {
    await import('/src/ui/guide-timeline.css' as string);
    await import('/src/ui/guide-panel.css' as string);
    const { mountPaidGuide } = await import('/src/ui/paid-guide.ts' as string);
    const hour = 3_600_000;
    const now = Math.floor(Date.now() / (30 * 60_000)) * 30 * 60_000;
    const accountId = 'a'.repeat(32);
    const channel = {
      id: `account-${accountId}-${'f'.repeat(64)}`,
      name: 'FOX 32 Chicago',
      category: 'US| LOCALS',
      epgId: 'fox32.us',
      providerId: '32',
      streamReference: 'b'.repeat(32),
      favorite: false,
    };
    const status = (fetchedMs: number, revision: number) => ({
      revision,
      fetchedMs,
      programs: 1,
      channels: 1,
      skipped: 2,
    });
    let stored =
      options.stored === 'none'
        ? null
        : status(options.stored === 'fresh' ? now - hour : now - 24 * hour, 1);
    const log: string[] = [];
    const guide = {
      status: async () => stored,
      refresh: async () => {
        log.push('download');
        if (options.download === 'fail') throw new Error('account-guide-not-offered');
        stored = status(now, (stored?.revision ?? 0) + 1);
        return stored;
      },
      channels: async () => (stored ? [channel] : []),
      listed: async () => ({ revision: stored!.revision, epgIds: ['fox32.us'] }),
      programs: async (_a: unknown, epgId: string) => ({
        revision: stored!.revision,
        programs: [
          {
            epgId,
            startMs: now,
            stopMs: now + 3 * hour,
            ordinal: 0,
            title: 'NFL Football: Bears at Saints',
            description: 'Chicago and New Orleans meet.',
            categories: [],
          },
        ],
      }),
    };
    const panel = mountPaidGuide(document.getElementById('host')!, {
      guide,
      watch: async (row: { name: string }) => {
        log.push(`watch:${row.name}`);
      },
      close: () => log.push('close'),
      now: () => Date.now(),
      formatTime: (ms: number) => new Date(ms).toISOString(),
    });
    Reflect.set(window, 'log', log);
    await panel.show({
      schemaVersion: 1,
      id: accountId,
      name: 'Provider',
      kind: 'xtream',
      serverOrigin: 'https://provider.invalid',
      allowHttp: false,
      revision: '1',
      requiresSignIn: false,
    });
  }, options);
}
const log = (page: Page) => page.evaluate(() => Reflect.get(window, 'log') as string[]);

test('opening the Paid TV guide downloads the provider guide and lists its channels', async ({
  page,
}) => {
  await mount(page, { stored: 'none', download: 'ok' });
  await expect(page.getByRole('heading', { name: 'Paid TV guide · Provider' })).toBeVisible();
  await expect(page.locator('.paid-guide-status')).toContainText('1 channel with listings');
  await expect(page.locator('.paid-guide-status')).toContainText('2 unusable listings left out');
  await expect(page.getByRole('button', { name: 'FOX 32 Chicago' })).toBeVisible();
  await expect(page.getByRole('button', { name: /NFL Football: Bears at Saints/ })).toBeVisible();
  expect(await log(page)).toEqual(['download']);
  // Title and status share one line, so the grid keeps its rows.
  const title = await page.locator('.paid-guide-head h2').boundingBox();
  const status = await page.locator('.paid-guide-status').boundingBox();
  expect(Math.abs(title!.y + title!.height / 2 - (status!.y + status!.height / 2))).toBeLessThan(
    12,
  );
  await expect(page.locator('.paid-guide')).not.toContainText('seven days');
  await page.getByRole('button', { name: 'FOX 32 Chicago' }).click();
  await expect.poll(() => log(page)).toEqual(['download', 'watch:FOX 32 Chicago']);
  await page.getByRole('button', { name: 'Close guide' }).click();
  await expect.poll(async () => (await log(page)).at(-1)).toBe('close');
});

test('a guide downloaded recently opens without downloading again', async ({ page }) => {
  await mount(page, { stored: 'fresh', download: 'ok' });
  await expect(page.getByRole('button', { name: 'FOX 32 Chicago' })).toBeVisible();
  expect(await log(page)).toEqual([]);
  await page.getByRole('button', { name: 'Update guide' }).click();
  await expect.poll(() => log(page)).toEqual(['download']);
});

test('a failed download keeps the last good guide and says why', async ({ page }) => {
  await mount(page, { stored: 'old', download: 'fail' });
  await expect(page.locator('.paid-guide-status')).toContainText(
    "Your provider doesn't offer a program guide for this account.",
  );
  await expect(page.locator('.paid-guide-status')).toContainText('Showing the guide from');
  await expect(page.getByRole('button', { name: 'FOX 32 Chicago' })).toBeVisible();
});

test('a failed first download shows the reason and no borrowed listings', async ({ page }) => {
  await mount(page, { stored: 'none', download: 'fail' });
  await expect(page.locator('.paid-guide-status')).toContainText(
    "Your provider doesn't offer a program guide for this account. Use Update guide to try again.",
  );
  await expect(page.locator('.gx-timeline-row')).toHaveCount(0);
});
