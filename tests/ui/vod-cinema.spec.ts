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

/** The real shell, VOD screen and TV remote navigation, with a controlled provider. */
async function mount(page: Page): Promise<void> {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.route('**/vod-cinema-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div></body></html>',
    }),
  );
  await page.goto('/vod-cinema-fixture');
  await page.evaluate(async () => {
    for (const sheet of [
      'style',
      'management',
      'guide',
      'responsive',
      'in-app-select',
      'modal-viewport',
      'media-results',
      'tv-density',
      'account-vod',
    ]) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = `/src/ui/${sheet}.css`;
      document.head.append(link);
      await new Promise<void>((resolve, reject) => {
        link.onload = () => resolve();
        link.onerror = () => reject(new Error(sheet));
      });
    }
    const { createShell } = await import('/src/ui/shell/shell.ts' as string);
    const { installRemoteNavigation } = await import(
      '/src/ui/shell/remote-navigation.ts' as string
    );
    const { mountAccountVod } = await import('/src/ui/accounts/account-vod.ts' as string);
    const app = document.querySelector<HTMLElement>('#app')!;
    createShell(app);
    app.dataset.deviceKind = 'tv';
    app.dataset.compactView = 'watch';
    app.dataset.contentLibrary = 'live';
    document.getElementById('channel-rows')!.innerHTML =
      '<button class="channel">Paid channel</button>';
    document.getElementById('list-empty')!.hidden = true;
    const titles = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, i) => ({
        id: `${prefix.length}${i + 1}`,
        name: `${prefix} ${i + 1}`,
        year: '2026',
        rating: '7.5',
      }));
    const categories = [
      { id: '1', name: 'Top Movies', items: titles('Movie', 60) },
      { id: '2', name: 'Action', items: titles('Act', 12) },
      { id: '3', name: 'Kids', items: titles('Kids', 3) },
    ];
    const log: string[] = [];
    const vod = mountAccountVod(
      {
        play: async (title: { name: string }) => {
          log.push(`play:${title.name}`);
        },
        run: (work: Promise<void>) => void work.catch(() => undefined),
      },
      {
        row: document.querySelector<HTMLElement>('.sidehead')!,
        list: document.querySelector<HTMLElement>('#channel-list')!,
        stage: document.querySelector<HTMLElement>('#screen')!,
      },
      {
        list: async (_a: unknown, _s: string, id: string | null) =>
          id === null
            ? {
                categories: categories.map(({ id, name }) => ({ id, name })),
                items: [],
                skipped: 0,
              }
            : { categories: [], items: categories.find((c) => c.id === id)!.items, skipped: 0 },
        episodes: async () => [],
        details: async (_a: unknown, _s: string, id: string) => {
          log.push(`details:${id}`);
          return { plot: `The story of title ${id}.`, genre: 'Drama', durationSeconds: 5400 };
        },
      },
    );
    vod.present({ id: 'a'.repeat(32), revision: '1' });
    installRemoteNavigation();
    Reflect.set(window, 'vod', vod);
    Reflect.set(window, 'log', log);
  });
}
const focused = (page: Page) =>
  page.evaluate(() => {
    const node = document.activeElement as HTMLElement | null;
    return node?.dataset.vodItem ?? node?.dataset.category ?? node?.textContent?.trim() ?? '';
  });
const press = async (page: Page, ...keys: string[]) => {
  for (const key of keys) await page.keyboard.press(key);
};
async function openVod(page: Page) {
  await page.locator('#vod-button').click();
  await expect(page.locator('.vod-title').first()).toBeVisible();
}

const rowCards = (page: Page, row: number) =>
  page.locator('.vod-row').nth(row).locator('.vod-title');

test('VOD fills the screen with a slim rail, a banner and category rows of six posters', async ({
  page,
}) => {
  await mount(page);
  await openVod(page);
  await expect(page.locator('#app')).toHaveAttribute('data-vod', 'open');
  // Channel search, filters, the account picker and the player bar step aside.
  for (const hidden of ['.search-controls', '.browse-options', '.watch-card > .dock'])
    await expect(page.locator(hidden)).toBeHidden();
  await expect(page.getByRole('button', { name: 'Back to channels', exact: true })).toBeVisible();
  await expect(page.locator('.vod-categories button')).toHaveCount(3);
  // One row per category, each named, the first ones loaded.
  await expect(page.locator('.vod-row h5')).toHaveText(['Top Movies', 'Action', 'Kids']);
  await expect(rowCards(page, 1).first()).toBeVisible();
  const visible = await page
    .locator('.vod-row')
    .first()
    .evaluate((row) => {
      const strip = row.querySelector('.vod-strip')!.getBoundingClientRect();
      return [...row.querySelectorAll('.vod-title')].filter((card) => {
        const r = card.getBoundingClientRect();
        return r.left >= strip.left - 1 && r.right <= strip.right + 1;
      }).length;
    });
  expect(visible).toBe(6);
  // Forty titles, then a card for the rest of the category.
  await expect(rowCards(page, 0)).toHaveCount(40);
  await expect(page.locator('.vod-row').first().locator('.vod-see-all')).toHaveText('See all (60)');
  // The rows span the whole right side, not just the old picture area.
  const [gallery, view] = await Promise.all([
    page.locator('#vod-gallery').boundingBox(),
    page.locator('.view').boundingBox(),
  ]);
  expect(gallery!.height).toBeGreaterThan(view!.height - 40);
});

test('the banner describes the focused title and Play starts it', async ({ page }) => {
  await mount(page);
  await openVod(page);
  await rowCards(page, 0).nth(2).focus();
  const banner = page.locator('.vod-banner');
  await expect(banner).toContainText('Movie 3');
  await expect(banner).toContainText('The story of title 53.');
  await expect(banner).toContainText('Drama');
  await expect(banner).toContainText('1 h 30 min');
  await banner.getByRole('button', { name: 'Play', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'log')))
    .toContain('play:Movie 3');
});

test('Right and Left scroll along a row; Up and Down move between rows; nothing escapes', async ({
  page,
}) => {
  await mount(page);
  await openVod(page);
  await rowCards(page, 0).first().focus();
  await press(page, 'ArrowRight');
  expect(await focused(page)).toBe('52');
  await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('32'); // Action row, same position
  await press(page, 'ArrowUp');
  expect(await focused(page)).toBe('52');
  await press(page, 'ArrowUp');
  // Above the first row: the banner's Play, then nothing further up.
  expect(await focused(page)).toBe('Play');
  await press(page, 'ArrowUp');
  expect(await focused(page)).toBe('Play');
  await press(page, 'ArrowDown');
  expect(await focused(page)).toBe('52');
  await press(page, 'ArrowLeft', 'ArrowLeft');
  // Left of a row's first title: the rail, on that row's category.
  expect(await focused(page)).toBe('1');
  await press(page, 'ArrowRight');
  expect(await focused(page)).toBe('51');
  // Right keeps going past the screen edge: the row scrolls, ending at "See all".
  for (let i = 0; i < 45; i++) await press(page, 'ArrowRight');
  expect(await focused(page)).toBe('See all (60)');
  expect(
    await page
      .locator('.vod-row')
      .first()
      .locator('.vod-strip')
      .evaluate((n) => n.scrollLeft),
  ).toBeGreaterThan(0);
  // Down past the last row stays among the titles.
  for (let i = 0; i < 4; i++) await press(page, 'ArrowDown');
  expect(await page.evaluate(() => !!document.activeElement?.closest('#vod-gallery'))).toBe(true);
  expect(await page.evaluate(() => !!document.activeElement?.closest('.dock, .top-actions'))).toBe(
    false,
  );
});

test('See all opens the full category; Back returns to its row', async ({ page }) => {
  await mount(page);
  await openVod(page);
  await page.locator('.vod-row').first().locator('.vod-see-all').click();
  await expect(page.locator('.vod-results .vod-title')).toHaveCount(60);
  const perRow = await page.locator('.vod-results .vod-title').evaluateAll((cards) => {
    const top = cards[0]!.getBoundingClientRect().top;
    return cards.filter((card) => Math.abs(card.getBoundingClientRect().top - top) < 2).length;
  });
  expect(perRow).toBe(6);
  await page.locator('.vod-results .vod-title').nth(50).focus();
  expect(await page.evaluate(() => Reflect.get(window, 'vod').back())).toBe(true);
  await expect(page.locator('.vod-rows')).toBeVisible();
  expect(await page.evaluate(() => !!document.activeElement?.closest('.vod-row'))).toBe(true);
});

test('Back steps out: titles, then the rail, then out of VOD to the VOD button', async ({
  page,
}) => {
  await mount(page);
  await openVod(page);
  await rowCards(page, 1).nth(2).focus();
  expect(await page.evaluate(() => Reflect.get(window, 'vod').back())).toBe(true);
  expect(await focused(page)).toBe('2');
  expect(await page.evaluate(() => Reflect.get(window, 'vod').back())).toBe(true);
  await expect(page.locator('#app')).toHaveAttribute('data-vod', 'closed');
  expect(await page.evaluate(() => document.activeElement?.id)).toBe('vod-button');
  await expect(page.locator('#channel-list')).toBeVisible();
  // Nothing open: Back is not VOD's to handle.
  expect(await page.evaluate(() => Reflect.get(window, 'vod').back())).toBe(false);
});

test('a rail category jumps to its row; Channels leaves; coming back lands on the same title', async ({
  page,
}) => {
  await mount(page);
  await openVod(page);
  await page.locator('.vod-categories button').nth(1).click();
  await expect.poll(() => focused(page)).toBe('31');
  await press(page, ...Array.from({ length: 7 }, () => 'ArrowRight'));
  expect(await focused(page)).toBe('38');
  await page.getByRole('button', { name: 'Back to channels', exact: true }).click();
  await expect(page.locator('#app')).toHaveAttribute('data-vod', 'closed');
  await expect(page.locator('#channel-list')).toBeVisible();
  await openVod(page);
  await expect(page.locator('.vod-categories button[aria-pressed="true"]')).toHaveText('Action');
  await expect.poll(() => focused(page)).toBe('38');
});

test('after a movie stops, VOD shows the titles again on the same poster', async ({ page }) => {
  await mount(page);
  await openVod(page);
  await rowCards(page, 1).nth(4).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'log'))).toContain('play:Act 5');
  // Playing: the titles step aside for the picture.
  await expect(page.locator('#vod-gallery')).toBeHidden();
  await page.evaluate(() => Reflect.get(window, 'vod').showTitles());
  await expect(page.locator('#vod-gallery')).toBeVisible();
  expect(await focused(page)).toBe('35');
});

test('opening VOD puts the remote on the first title', async ({ page }) => {
  await mount(page);
  await page.locator('#vod-button').focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => focused(page)).toBe('51');
});
