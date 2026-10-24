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

/** Actual Local module with a controlled host. Browser only: no native page view, network or decoder claims. */
const saved = {
  area: '309',
  found: {
    schemaVersion: 1,
    areaCode: '309',
    places: [{ name: 'Peoria', state: 'Illinois' }],
    tv: [
      {
        name: 'Fixture 31',
        callSign: 'WFIX',
        website: 'https://tv.fixture.invalid/',
        place: 'Peoria',
        distanceKm: 3,
      },
    ],
    radio: [
      {
        id: 'r1',
        name: 'Fixture FM',
        stream: 'http://radio.fixture.invalid/live',
        codec: 'MP3',
        bitrate: 128,
        homepage: null,
        area: 'Peoria',
      },
    ],
  },
};
/** Test fixture: an in-memory stand-in for the native favorites and scan commands. */
const elsewhere = {
  schemaVersion: 1,
  areaCode: '217',
  places: [{ name: 'Springfield', state: 'Illinois' }],
  tv: [],
  radio: [
    {
      id: 'r9',
      name: 'Other FM',
      stream: 'https://other.fixture.invalid/live',
      codec: 'MP3',
      bitrate: 64,
      homepage: null,
      area: 'Springfield',
    },
  ],
};
async function mount(page: Page, stored: unknown, native = false): Promise<void> {
  await page.route('**/local-streams-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body><nav><button id="free" aria-pressed="true">Free TV</button><button id="extra">GenXtra</button></nav><div id="list">channels</div><div id="screen" style="position:relative;width:640px;height:360px"></div></body></html>',
    }),
  );
  await page.goto('/local-streams-fixture');
  await page.evaluate(
    async ({ stored, native, elsewhere }) => {
      if (native) {
        let file = { schemaVersion: 1, stations: [], areas: [] };
        const calls: string[] = [];
        Reflect.set(window, 'calls', calls);
        Reflect.set(window, 'isTauri', true);
        Reflect.set(window, '__TAURI_INTERNALS__', {
          invoke: async (command: string, args: Record<string, unknown>) => {
            calls.push(command);
            if (command === 'local_favorites_read') return structuredClone(file);
            if (command === 'local_favorites_save')
              return structuredClone((file = args.favorites as typeof file));
            if (command === 'local_streams_scan') return structuredClone(elsewhere);
            if (command === 'web_page') {
              const request = args as { action: string; url?: string | null };
              calls.push(`web_page:${request.action}:${request.url ?? ''}`);
              if (request.action === 'status')
                return {
                  open: !Reflect.get(window, 'pageGone'),
                  url: 'https://news.fixture.invalid/story',
                  title: 'Fixture Story',
                };
              return { schemaVersion: 1 };
            }
            throw new Error(`unexpected ${command}`);
          },
        });
      }
      if (stored) localStorage.setItem('genx-local-streams-v1', JSON.stringify(stored));
      else localStorage.removeItem('genx-local-streams-v1');
      const path = '/src/ui/local-streams.ts';
      const { mountLocalStreams } = await import(path);
      const log: string[] = [];
      const pending: Promise<void>[] = [];
      const local = mountLocalStreams(
        {
          showLive: async () => void log.push('live'),
          playRadio: async (radio: { id: string; url: string }) =>
            void log.push(`radio:${radio.id}:${radio.url}`),
          stopPlayback: async () => void log.push('stop'),
          run: (work: Promise<void>) => void pending.push(work),
        },
        {
          after: document.getElementById('extra')!,
          leave: [document.getElementById('free')!, document.getElementById('extra')!],
          list: document.getElementById('list')!,
          stage: document.getElementById('screen')!,
        },
      );
      Reflect.set(window, 'log', log);
      Reflect.set(window, 'local', local);
      Reflect.set(window, 'settle', () => Promise.allSettled(pending));
    },
    { stored, native, elsewhere },
  );
}
const log = (page: Page) => page.evaluate(() => Reflect.get(window, 'log') as string[]);
const settle = (page: Page) =>
  page.evaluate(() => (Reflect.get(window, 'settle') as () => Promise<unknown>)());

test('the globe opens Local in place of the channel list and another library leaves it', async ({
  page,
}) => {
  await mount(page, null);
  const globe = page.getByRole('button', { name: 'Local TV and radio' });
  await expect(globe).toHaveAttribute('aria-pressed', 'false');
  await globe.click();
  await settle(page);
  await expect(globe).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#list')).toBeHidden();
  await expect(page.locator('#local-streams')).toBeVisible();
  await expect(page.locator('#free')).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.local-stage-note')).toHaveText(
    'Enter an area code or ZIP, then Scan.',
  );
  expect(await log(page)).toEqual(['live']);
  await page.locator('#free').click();
  await expect(page.locator('#local-streams')).toBeHidden();
  await expect(page.locator('#list')).toBeVisible();
  await expect(globe).toHaveAttribute('aria-pressed', 'false');
});

test('the scan refuses a bad area and says plainly that it needs the app', async ({ page }) => {
  await mount(page, null);
  await page.getByRole('button', { name: 'Local TV and radio' }).click();
  await page.locator('#local-area').fill('12');
  await page.getByRole('button', { name: 'Scan' }).click();
  await settle(page);
  await expect(page.locator('.local-status')).toHaveText(
    'Enter a 3-digit area code or a 5-digit ZIP code.',
  );
  await page.locator('#local-area').fill('61602');
  await page.getByRole('button', { name: 'Scan' }).click();
  await settle(page);
  await expect(page.locator('.local-status')).toHaveText('Local streams need the GenX app.');
  await expect(page.locator('.local-status')).toHaveAttribute('data-error', '');
});

test('saved results list TV and radio; radio plays and HTTP is limited to listed streams', async ({
  page,
}) => {
  await mount(page, saved);
  await page.getByRole('button', { name: 'Local TV and radio' }).click();
  await settle(page);
  await expect(page.locator('#local-area')).toHaveValue('309');
  await expect(page.locator('.local-heading')).toHaveText(['Local TV · 1', 'Local radio · 1']);
  await expect(page.locator('.local-status')).toHaveText('2 found near Peoria.');
  const radio = page.locator('.local-item[data-kind="radio"]');
  await expect(radio).toContainText('Fixture FM');
  await radio.click();
  await settle(page);
  expect(await log(page)).toContain('radio:local-radio:r1:http://radio.fixture.invalid/live');
  await expect(radio).toHaveAttribute('aria-pressed', 'true');
  const allows = (url: string) =>
    page.evaluate(
      (u) => (Reflect.get(window, 'local') as { allowsHttp(url: string): boolean }).allowsHttp(u),
      url,
    );
  expect(await allows('http://radio.fixture.invalid/live')).toBe(true);
  expect(await allows('http://other.fixture.invalid/live')).toBe(false);
});

test('a TV station stops the player and reports when the page view is missing', async ({
  page,
}) => {
  await mount(page, saved);
  await page.getByRole('button', { name: 'Local TV and radio' }).click();
  await page.locator('.local-item[data-kind="tv"]').click();
  await settle(page);
  expect(await log(page)).toContain('stop');
  await expect(page.locator('.local-stage-note')).toHaveText(
    'This page could not open. Try another.',
  );
});

test('favorites keep stations and areas across scans of other regions', async ({ page }) => {
  await mount(page, saved, true);
  await page.getByRole('button', { name: 'Local TV and radio' }).click();
  await settle(page);
  await page.getByRole('button', { name: 'Add Fixture FM to favorites' }).click();
  await settle(page);
  // Favorites have their own tab, so the scan's results stay in view.
  await expect(page.locator('.local-heading')).toHaveText(['Local TV · 1', 'Local radio · 1']);
  await expect(page.getByRole('button', { name: '★ Favorites · 1' })).toBeVisible();
  await page.getByRole('button', { name: '☆ Save area' }).click();
  await settle(page);
  await page.getByRole('button', { name: '★ Favorites · 1' }).click();
  await expect(page.locator('.local-heading')).toHaveText(['Radio · 1']);
  await expect(page.locator('.local-area-chip')).toHaveText('309 · Peoria');
  await expect(page.locator('.local-status')).toHaveText('1 favorite station · 1 saved area');
  // Another region: the favorite stays listed, playable and allowed over HTTP.
  await page.locator('#local-area').fill('217');
  await page.getByRole('button', { name: 'Scan', exact: true }).click();
  await settle(page);
  await expect(page.locator('.local-status')).toHaveText('1 found near Springfield.');
  await expect(page.locator('.local-heading')).toHaveText(['Local TV · 0', 'Local radio · 1']);
  const local = (call: string) =>
    page.evaluate((c) => {
      const api = Reflect.get(window, 'local') as {
        allowsHttp(url: string): boolean;
        channel(id: string): unknown;
      };
      return c === 'http'
        ? api.allowsHttp('http://radio.fixture.invalid/live')
        : api.channel('local-radio:r1');
    }, call);
  expect(await local('http')).toBe(true);
  expect(await local('channel')).toEqual({
    id: 'local-radio:r1',
    name: 'Fixture FM',
    urls: ['http://radio.fixture.invalid/live'],
  });
  // A saved area reruns its scan with one press, back on the Results tab.
  await page.getByRole('button', { name: '★ Favorites · 1' }).click();
  await page.locator('.local-area-chip').click();
  await settle(page);
  await expect(page.getByRole('button', { name: 'Results' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // Removing the star (from the Favorites tab) removes the favorite.
  await page.getByRole('button', { name: '★ Favorites · 1' }).click();
  await page.getByRole('button', { name: 'Remove Fixture FM from favorites' }).click();
  await settle(page);
  await expect(page.getByRole('button', { name: '★ Favorites · 0' })).toBeVisible();
  expect(await local('http')).toBe(false);
  const calls = await page.evaluate(() => Reflect.get(window, 'calls') as string[]);
  expect(calls.filter((c) => c === 'local_favorites_save')).toHaveLength(3);
  expect(calls.filter((c) => c === 'local_streams_scan')).toHaveLength(2);
});

test('the remote moves along the area row to Scan and down to the tabs', async ({ page }) => {
  await mount(page, saved, true);
  await page.getByRole('button', { name: 'Local TV and radio' }).click();
  await settle(page);
  await page.locator('#local-area').focus();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: 'Scan', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('button', { name: '☆ Save area' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#local-area')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Results' })).toBeFocused();
});

test('Websites opens an address or a search and saves the open page', async ({ page }) => {
  await mount(page, saved, true);
  await page.getByRole('button', { name: 'Local TV and radio' }).click();
  await settle(page);
  await page.getByRole('button', { name: 'Websites · 0' }).click();
  await expect(page.locator('#local-web')).toBeVisible();
  await expect(page.locator('#local-area')).toBeHidden();
  await page.locator('#local-web').fill('WMBD news');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await settle(page);
  await page.locator('#local-web').fill('wtvp.org/live');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await settle(page);
  const calls = () => page.evaluate(() => Reflect.get(window, 'calls') as string[]);
  expect(await calls()).toContain('web_page:open:https://duckduckgo.com/?q=WMBD%20news');
  expect(await calls()).toContain('web_page:open:https://wtvp.org/live');
  // The TV bar's Save (Android) arrives as an event with the page's address.
  await page.evaluate(() =>
    dispatchEvent(
      new CustomEvent('genx-page-save', {
        detail: { url: 'https://wtvp.org/live', title: 'WTVP Livestream' },
      }),
    ),
  );
  await settle(page);
  await expect(page.getByRole('button', { name: 'Websites · 1' })).toBeVisible();
  await expect(page.locator('.local-item[data-kind="site"]')).toContainText('WTVP Livestream');
  // Saving again removes it.
  await page.evaluate(() =>
    dispatchEvent(
      new CustomEvent('genx-page-save', {
        detail: { url: 'https://wtvp.org/live', title: 'WTVP Livestream' },
      }),
    ),
  );
  await settle(page);
  await expect(page.getByRole('button', { name: 'Websites · 0' })).toBeVisible();
});

test('a page the native side lost opens again when chosen again', async ({ page }) => {
  await mount(page, saved, true);
  await page.getByRole('button', { name: 'Local TV and radio' }).click();
  await settle(page);
  await page.getByRole('button', { name: 'Websites · 0' }).click();
  const go = async () => {
    await page.locator('#local-web').fill('wtvp.org/live');
    await page.getByRole('button', { name: 'Go', exact: true }).click();
    await settle(page);
  };
  const opens = () =>
    page.evaluate(
      () =>
        (Reflect.get(window, 'calls') as string[]).filter(
          (c) => c === 'web_page:open:https://wtvp.org/live',
        ).length,
    );
  await go();
  expect(await opens()).toBe(1);
  // Still open: choosing it again returns to it.
  await go();
  expect(await opens()).toBe(1);
  // Gone without GenX being told (a test harness or an engine that lost it).
  await page.evaluate(() => Reflect.set(window, 'pageGone', true));
  await go();
  expect(await opens()).toBe(2);
});

test('no page opens behind another library', async ({ page }) => {
  await mount(page, saved, true);
  await page.getByRole('button', { name: 'Local TV and radio' }).click();
  await settle(page);
  await page.getByRole('button', { name: 'Websites · 0' }).click();
  await page.locator('#local-web').fill('wtvp.org/live');
  // Local is left before a late voice result arrives.
  await page.locator('#free').click();
  await page.locator('#local-web').dispatchEvent('speech-search-final');
  await settle(page);
  const calls = await page.evaluate(() => Reflect.get(window, 'calls') as string[]);
  expect(calls.filter((c) => c.startsWith('web_page:open'))).toEqual([]);
});

test('W07: a hostile page title is stored and shown as plain, bounded text', async ({ page }) => {
  await mount(page, saved, true);
  await page.getByRole('button', { name: 'Local TV and radio' }).click();
  await settle(page);
  const title = `<img src=x onerror="window.pwned=1">${'A'.repeat(10_000)}`;
  await page.evaluate(
    (t) =>
      dispatchEvent(
        new CustomEvent('genx-page-save', {
          detail: { url: 'https://evil.fixture.invalid/', title: t },
        }),
      ),
    title,
  );
  await settle(page);
  await page.getByRole('button', { name: 'Websites · 1' }).click();
  const shown = page.locator('.local-item[data-kind="site"] strong');
  await expect(shown).toHaveText(title.slice(0, 160));
  expect(await page.locator('.local-results img').count()).toBe(0);
  expect(await page.evaluate(() => Reflect.get(window, 'pwned'))).toBeUndefined();
});

test('W16: Android has an APK sites tab, one press opens a site; Windows has no such tab', async ({
  browser,
  page,
}) => {
  const android = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (Linux; Android 14; TV) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  });
  const tv = await android.newPage();
  await mount(tv, saved, true);
  await tv.getByRole('button', { name: 'Local TV and radio' }).click();
  await settle(tv);
  // One row (owner request): Results | ★ Favorites ▾ | Websites; the middle
  // button lists Favorites and APK sites.
  const order = await tv.locator('.local-tabs > button:visible').allTextContents();
  expect(order.map((t) => t.split(' · ')[0])).toEqual(['Results', '★ Favorites', 'Websites']);
  const rows = await tv
    .locator('.local-tabs > button:visible')
    .evaluateAll(
      (nodes) => new Set(nodes.map((n) => Math.round(n.getBoundingClientRect().top))).size,
    );
  expect(rows).toBe(1);
  // Websites shows only the address box and saved websites.
  await tv.getByRole('button', { name: 'Websites · 0' }).click();
  await expect(tv.getByText(/Android app sites/)).toHaveCount(0);
  // The remote: OK opens the list, Down reaches APK sites, OK picks it.
  await tv.locator('.local-list-tab').focus();
  await tv.keyboard.press('Enter');
  await expect(tv.locator('.local-list-menu')).toBeVisible();
  await expect(tv.getByRole('menuitemradio', { name: /Favorites/ })).toBeFocused();
  await tv.keyboard.press('ArrowDown');
  await expect(tv.getByRole('menuitemradio', { name: 'APK sites' })).toBeFocused();
  await tv.keyboard.press('Enter');
  await expect(tv.locator('.local-list-menu')).toBeHidden();
  await expect(tv.locator('.local-list-tab')).toBeFocused();
  await expect(tv.locator('.local-list-tab')).toHaveText('APK sites ▾');
  await expect(tv.getByText('Android app sites · 10')).toBeVisible();
  // Escape (a keyboard's Back) closes the list and returns to its button;
  // Android's Back reaches it through GenX's Back owner (data-popup-open).
  await tv.keyboard.press('Enter');
  await expect(tv.locator('.local-list-menu')).toBeVisible();
  await expect(tv.locator('.local-list-menu')).toHaveAttribute('data-popup-open', 'true');
  await tv.keyboard.press('Escape');
  await expect(tv.locator('.local-list-menu')).toBeHidden();
  await expect(tv.locator('.local-list-tab')).toBeFocused();
  await expect(tv.getByText('Android app sites · 10')).toBeVisible();
  await expect(tv.locator('#local-web')).toBeHidden();
  await tv.getByRole('button', { name: /^F-Droid/ }).click();
  await settle(tv);
  const calls = await tv.evaluate(() => Reflect.get(window, 'calls') as string[]);
  expect(calls).toContain('web_page:open:https://f-droid.org/en/packages/');
  await android.close();
  // Windows does not install Android apps: no such tab.
  await mount(page, saved, true);
  await page.getByRole('button', { name: 'Local TV and radio' }).click();
  await settle(page);
  await expect(page.getByRole('button', { name: 'APK sites' })).toBeHidden();
  await page.getByRole('button', { name: 'Websites · 0' }).click();
  await expect(page.getByText(/Android app sites/)).toHaveCount(0);
});

test('Back from a page leaves the remote on the page area, so OK goes back in', async ({
  page,
}) => {
  await mount(page, saved, true);
  await page.getByRole('button', { name: 'Local TV and radio' }).click();
  await settle(page);
  await page.getByRole('button', { name: 'Websites · 0' }).click();
  await page.locator('#local-web').fill('wtvp.org/live');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await settle(page);
  // Android reports that Back left the page; focus elsewhere first (the header).
  await page.getByRole('button', { name: 'Local TV and radio' }).focus();
  await page.evaluate(() =>
    dispatchEvent(new CustomEvent('genx-page-left', { detail: { reason: 'Back' } })),
  );
  await expect(page.locator('.local-stage-enter')).toBeFocused();
  await expect(page.locator('#screen')).toHaveCSS('outline-style', 'solid');
  await expect(page.locator('.local-status, [role="status"]').first()).toContainText(
    'OK: back into the page',
  );
  const before = (await page.evaluate(() => Reflect.get(window, 'calls') as string[])).length;
  await page.keyboard.press('Enter');
  await settle(page);
  const after = (await page.evaluate(() => Reflect.get(window, 'calls') as string[])).slice(before);
  expect(after).toContain('web_page:enter:');
  // Address (the bar's button) leaves focus on the address box it opens.
  await page.locator('#local-web').focus();
  await page.evaluate(() =>
    dispatchEvent(new CustomEvent('genx-page-left', { detail: { reason: 'address' } })),
  );
  await expect(page.locator('#local-web')).toBeFocused();
});
