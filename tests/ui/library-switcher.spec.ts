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

/** Actual switcher module with a controlled host. No native, network or decoder claims. */
async function mount(page: Page, accounts: unknown[]): Promise<void> {
  await page.route('**/library-switcher-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><button id="free">Free TV</button><button id="paid">Paid TV</button><button id="guide">Guide</button><div id="list"></div></body></html>',
    }),
  );
  await page.goto('/library-switcher-fixture');
  await page.evaluate(async (rows) => {
    const path = '/src/ui/library-switcher.ts';
    const { mountLibrarySwitcher } = await import(path);
    const log: string[] = [];
    let selected: { id: string } | null = null;
    const switcher = mountLibrarySwitcher(
      {
        list: async () => Reflect.get(window, 'rows'),
        ready: () => true,
        selected: () => selected,
        select: async (account: { id: string } | null) => {
          selected = account;
          log.push(`select:${account?.id ?? 'free'}`);
        },
        release: async (id: string) => {
          log.push(`release:${id}`);
        },
        showLive: async () => {
          log.push('live');
        },
        openAccounts: () => log.push('open-accounts'),
        run: (work: Promise<void>) => {
          void work;
        },
      },
      {
        free: document.getElementById('free')!,
        paid: document.getElementById('paid')!,
        list: document.getElementById('list')!,
        guide: document.getElementById('guide')!,
      },
    );
    Reflect.set(window, 'rows', rows);
    Reflect.set(window, 'log', log);
    Reflect.set(window, 'switcher', switcher);
    await switcher.reload();
  }, accounts);
}
const account = (id: string, name: string, requiresSignIn = false) => ({
  schemaVersion: 1,
  id: id.repeat(32),
  name,
  kind: 'xtream',
  serverOrigin: 'http://tv.fixture.invalid:8080',
  allowHttp: true,
  revision: '1',
  requiresSignIn,
});
const log = (page: Page) => page.evaluate(() => Reflect.get(window, 'log') as string[]);

test('Paid TV with no usable account opens the sign-in form instead of an empty list', async ({
  page,
}) => {
  await mount(page, [account('a', 'Expired', true)]);
  await page.locator('#paid').click();
  await expect.poll(() => log(page)).toEqual(['open-accounts']);
  await expect(page.locator('#paid')).toHaveAttribute('aria-pressed', 'false');
});

test('Free TV and Paid TV switch libraries and remember the last paid account', async ({
  page,
}) => {
  await mount(page, [account('a', 'Provider A'), account('b', 'Provider B')]);
  await expect(page.locator('#free')).toHaveAttribute('aria-pressed', 'true');
  await page.locator('#paid').click();
  await expect(page.locator('#paid')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#free')).toHaveAttribute('aria-pressed', 'false');
  // Two accounts: the picker appears only in Paid TV and switches between them.
  const picker = page.getByRole('combobox', { name: 'Paid TV account' });
  await expect(picker).toBeVisible();
  await picker.selectOption({ label: 'Provider B' });
  await page.locator('#free').click();
  await expect(page.locator('#free')).toHaveAttribute('aria-pressed', 'true');
  await expect(picker).toBeHidden();
  await page.locator('#paid').click();
  await expect
    .poll(() => log(page))
    .toEqual([
      'live',
      `select:${'a'.repeat(32)}`,
      `select:${'b'.repeat(32)}`,
      'live',
      'select:free',
      'live',
      `select:${'b'.repeat(32)}`,
    ]);
});

test('an account removed while in use is released and returns to Free TV', async ({ page }) => {
  await mount(page, [account('a', 'Provider A')]);
  await page.locator('#paid').click();
  await expect(page.locator('#paid')).toHaveAttribute('aria-pressed', 'true');
  await page.evaluate(async () => {
    Reflect.set(window, 'rows', []);
    await (Reflect.get(window, 'switcher') as { reload(): Promise<void> }).reload();
  });
  await expect(page.locator('#free')).toHaveAttribute('aria-pressed', 'true');
  expect((await log(page)).slice(-2)).toEqual([`release:${'a'.repeat(32)}`, 'select:free']);
  await page.locator('#paid').click();
  await expect.poll(async () => (await log(page)).at(-1)).toBe('open-accounts');
});

test('the Guide button belongs to the library it sits in, never mixing Free and Paid TV', async ({
  page,
}) => {
  await mount(page, [account('a', 'Provider A')]);
  const guide = page.locator('#guide');
  await expect(guide).toHaveAttribute('data-library', 'free');
  await expect(guide).toHaveAccessibleName('Free TV guide');
  await page.locator('#paid').click();
  await expect(guide).toHaveAttribute('data-library', 'paid');
  await expect(guide).toHaveAccessibleName('Paid TV guide');
  await expect(guide).toHaveText('Guide');
  await page.locator('#free').click();
  await expect(guide).toHaveAttribute('data-library', 'free');
});

test('Paid TV in the top bar leaves VOD and returns to the channel list', async ({ page }) => {
  await page.route('**/library-switcher-vod-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><div id="app"><button id="free">Free TV</button><button id="paid">Paid TV</button><div class="sidehead"><button class="row-filter" data-filter="favorites">Favs</button></div><div id="list" tabindex="0"></div><div id="screen"></div></div></body></html>',
    }),
  );
  await page.goto('/library-switcher-vod-fixture');
  await page.evaluate(async () => {
    const { mountLibrarySwitcher } = await import('/src/ui/library-switcher.ts' as string);
    let selected: { id: string; revision: string } | null = null;
    const account = {
      schemaVersion: 1,
      id: 'a'.repeat(32),
      name: 'Provider',
      kind: 'xtream',
      serverOrigin: 'http://tv.fixture.invalid:8080',
      allowHttp: true,
      revision: '1',
      requiresSignIn: false,
    };
    const switcher = mountLibrarySwitcher(
      {
        list: async () => [account],
        ready: () => true,
        selected: () => selected,
        select: async (next: typeof selected) => {
          selected = next;
        },
        release: async () => undefined,
        showLive: async () => undefined,
        openAccounts: () => undefined,
        run: (work: Promise<void>) => void work.catch(() => undefined),
        vod: { play: async () => undefined },
      },
      {
        free: document.getElementById('free')!,
        paid: document.getElementById('paid')!,
        list: document.getElementById('list')!,
        row: document.querySelector<HTMLElement>('.sidehead'),
      },
    );
    await switcher.reload();
    Reflect.set(window, 'switcher', switcher);
  });
  await page.locator('#paid').click();
  await page.locator('#vod-button').click();
  await expect(page.locator('#app')).toHaveAttribute('data-vod', 'open');
  // This bare fixture has no layout, so the VOD overlay covers its buttons;
  // in the app the top bar stays above VOD.
  await page.locator('#paid').dispatchEvent('click');
  await expect(page.locator('#app')).toHaveAttribute('data-vod', 'closed');
  expect(await page.locator('#list').evaluate((node) => (node as HTMLElement).hidden)).toBe(false);
  // Remote Back reaches VOD through the switcher; nothing open, nothing handled.
  expect(await page.evaluate(() => Reflect.get(window, 'switcher').vodBack())).toBe(false);
});
