import { beforeAll, afterAll, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, expect as browserExpect, type Browser } from '@playwright/test';
let browser: Browser, bundle: string;
beforeAll(async () => {
  const built = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      lib: { entry: 'tests/catalog/fixtures/archive-date.ts', name: 'Dates', formats: ['iife'] },
    },
  });
  const output = Array.isArray(built) ? built[0] : built;
  if (!output || !('output' in output)) throw Error('No fixture output');
  const code = output.output.find((value) => value.type === 'chunk');
  if (!code || code.type !== 'chunk') throw Error('No fixture chunk');
  bundle = code.code;
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
it('explicit Clear filters keeps Favorites, restores a source2020 title, and performs no writes/discovery/autoplay', async () => {
  const page = await browser.newPage();
  try {
    await page.setContent('<input id="search"><div id="library"></div>');
    await page.addScriptTag({ content: bundle });
    await page.evaluate(async () => {
      const D = Reflect.get(window, 'Dates');
      const input = document.getElementById('search') as HTMLInputElement;
      input.value = 'Cartoon';
      let options = { decade: 1970 as number | null, favoritesOnly: true, contentType: 'all' };
      const calls = {
        queries: [] as unknown[],
        clears: 0,
        selected: 0,
        favoriteWrites: 0,
        discoveries: 0,
      };
      const title = D.validateArchiveTitle({
        titleRef: 'a'.repeat(64),
        title: 'A-The Six Million Dollar Man (Special Numbers)',
        kind: 'movie',
        releaseYear: 2020,
        curated: false,
        favorite: true,
        titleProvenance: 'provider-item',
        contentType: 'unknown',
        contentTypeProvenance: 'unknown',
        providerLanguages: ['English'],
        languageProvenance: 'provider-item',
        fileCount: 34,
        durationSeconds: null,
        rights: null,
        rank: 1,
        quality: 'metadata-h264',
        observedMs: 1,
      });
      const original = JSON.stringify(title);
      const ui = D.mountArchiveSearch(document.getElementById('library'), {
        input,
        readyScope: () => 'root',
        queryOptions: () => options,
        onSelect: async () => {
          calls.selected++;
        },
        onFavorite: async () => {
          calls.favoriteWrites++;
          throw Error('Unexpected favorite mutation');
        },
        discover: async () => {
          calls.discoveries++;
          throw Error('Unexpected discovery');
        },
        clearFilters: () => {
          calls.clears++;
          options = { decade: null, favoritesOnly: true, contentType: 'all' };
          input.value = '';
          void ui.query('');
        },
        catalog: {
          query: async (q: {
            query: string;
            decade?: number | null;
            contentType?: string;
            languageMode?: string;
            offset: number;
          }) => {
            calls.queries.push({ ...q });
            const hidden =
              q.query !== '' ||
              q.decade != null ||
              q.contentType !== 'all' ||
              q.languageMode === 'unlisted';
            return {
              schemaVersion: 1,
              revision: '1',
              totalCount: hidden ? 0 : 1,
              offset: q.offset,
              more: false,
              items: hidden ? [] : [title],
            };
          },
          files: async () => {
            throw Error('Unexpected file selection');
          },
        },
      });
      await ui.resume(input.value);
      Reflect.set(window, 'favoritesFixture', {
        calls,
        ui,
        unchanged: () => JSON.stringify(title) === original,
      });
    });
    const clear = page.getByRole('button', {
      name: 'Clear GenXtra filters and keep Favorites',
      exact: true,
    });
    await browserExpect(page.locator('.gx-archive-status')).toHaveText(
      'No favorite titles match the current search and filters.',
    );
    await browserExpect(clear).toBeVisible();
    await browserExpect(page.locator('.gx-archive-result-summary')).toHaveText(
      'Results for “Cartoon” · 0 matches',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'favoritesFixture').calls.clears)).toBe(0);
    await page.locator('.gx-archive-filter-toggle').click();
    await page.getByLabel('Browse video languages').selectOption('unlisted');
    await browserExpect(page.locator('.gx-archive-status')).toHaveText(
      'No favorite titles match the current search and filters.',
    );
    await clear.focus();
    await page.keyboard.press('Enter');
    await browserExpect(page.locator('.gx-archive-title-button')).toContainText(
      'Six Million Dollar Man',
    );
    await browserExpect(page.getByLabel('Browse video languages')).toHaveValue('all');
    await browserExpect(page.locator('#search')).toHaveValue('');
    await browserExpect(clear).toBeHidden();
    await browserExpect(page.locator('.gx-archive-result-summary')).toHaveText(
      'Favorites · 1 match',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'favoritesFixture').calls)).toMatchObject({
      clears: 1,
      selected: 0,
      discoveries: 0,
      favoriteWrites: 0,
    });
    expect(
      await page.evaluate(() => Reflect.get(window, 'favoritesFixture').calls.queries.at(-1)),
    ).toMatchObject({
      favoritesOnly: true,
      decade: null,
      contentType: 'all',
      languageMode: 'all',
      query: '',
    });
    expect(await page.evaluate(() => Reflect.get(window, 'favoritesFixture').unchanged())).toBe(
      true,
    );
    await page.evaluate(() => Reflect.get(window, 'favoritesFixture').ui.dispose());
  } finally {
    await page.close();
  }
});
