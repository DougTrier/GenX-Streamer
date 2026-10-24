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

import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { build } from 'vite';
import { chromium, type Browser, type Page } from '@playwright/test';

import { readStylesheet } from '../support/stylesheet';
let browser: Browser;
let browserCode: string;
let controlsCode: string;
async function bundle(entry: string, name: string): Promise<string> {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: { write: false, minify: false, lib: { entry, formats: ['iife'], name } },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing bundle');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing chunk');
  return chunk.code;
}
beforeAll(async () => {
  [browserCode, controlsCode] = await Promise.all([
    bundle('src/ui/channel-browser.ts', 'ChannelUI'),
    bundle('src/ui/geography-controls.ts', 'GeographyUI'),
  ]);
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture(preferredCountry?: string): Promise<Page> {
  const page = await browser.newPage();
  page.setDefaultTimeout(3000);
  await page.setContent(
    '<style>#channel-rows button{display:block;height:72px;width:200px}</style><div id="controls"></div><span id="channel-count"></span><p id="list-empty"></p><div id="list" tabindex="0" style="height:216px;overflow:auto;position:relative"><div id="channel-spacer"></div><div id="channel-rows" style="position:absolute;top:0"></div></div>',
  );
  await page.addStyleTag({ content: await readStylesheet('src/ui/style.css') });
  await page.addScriptTag({ content: browserCode });
  await page.addScriptTag({ content: controlsCode });
  await page.addScriptTag({
    content: `
    window.preferredCountry=${JSON.stringify(preferredCountry)};
    window.selected=[];window.filters=[];
    window.channels=[{id:'ca',sourceId:'s',name:'Canada Station',category:'News',geography:{country:'CA',region:'NORAM',state:'CA-ON'}},{id:'il',sourceId:'s',name:'FOX Chicago',category:'News',geography:{country:'US',region:'NORAM',state:'US-IL'}},{id:'tx',sourceId:'s',name:'Sports Texas',category:'Sports',geography:{country:'US',region:'NORAM',state:'US-TX'}},{id:'unknown',sourceId:'other',name:'Unknown Station',category:'News'}];
    window.browser=new ChannelUI.ChannelBrowser(document.getElementById('list'),id=>window.selected.push(id));
    window.browser.update(window.channels,['il'],'il');
    window.controls=GeographyUI.mountGeographyControls(document.getElementById('controls'),{channels:()=>window.channels,preferredCountry:()=>window.preferredCountry,apply:value=>{window.filters.push(structuredClone(value.filter));window.browser.setGeography(value.filter,value.sort,value.registry)}},{label:(field,code)=>field==='country'?({'US':'United States','CA':'Canada'}[code]):code});
  `,
  });
  return page;
}
async function cleanup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const state = window as unknown as {
      browser: { dispose(): void };
      controls: { dispose(): void };
    };
    state.browser.dispose();
    state.controls.dispose();
  });
  await page.close();
}
/** The country checklist's codes in display order. */
const countryCodes = (page: Page) =>
  page
    .locator('.geography-countries button[data-code]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.code));
/** Toggles one country (a click, as a finger or the remote's OK). */
const toggleCountry = (page: Page, code: string) =>
  page.locator(`.geography-countries button[data-code="${code}"]`).click();
const checkedCountries = (page: Page) =>
  page
    .locator('.geography-countries button[aria-checked="true"]')
    .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.code));
describe('actual Chromium geographic channel browsing', () => {
  it('puts the configured available country first without filtering or inventing options', async () => {
    const page = await fixture('CA');
    try {
      expect(await countryCodes(page)).toEqual(['CA', 'US', '?']);
      expect(
        await page.getByRole('button', { name: 'All countries (4)', exact: true }).count(),
      ).toBe(1);
      expect(await page.locator('#channel-count').textContent()).toBe('4 channels');
      await toggleCountry(page, 'CA');
      await page.evaluate(() => {
        Reflect.set(window, 'preferredCountry', 'JP');
        Reflect.get(window, 'controls').update();
      });
      expect(await checkedCountries(page)).toEqual(['CA']);
      // English-speaking order without a preference: United States, then Canada.
      expect(await countryCodes(page)).toEqual(['US', 'CA', '?']);
      expect(await page.locator('[data-channel]').getAttribute('data-channel')).toBe('ca');
      expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual([]);
    } finally {
      await cleanup(page);
    }
  });
  it('resets all country descendants while preserving search, category, sort and playback selection', async () => {
    const page = await fixture('CA');
    try {
      await toggleCountry(page, 'US');
      await page.getByLabel('State / subdivision').selectOption('US-IL');
      await page.getByLabel('Channel sort').selectOption('name');
      await page.evaluate(() => {
        const browser = Reflect.get(window, 'browser');
        browser.setFilter('news');
        browser.search('Station');
      });
      expect(await page.locator('[data-channel]').count()).toBe(0);
      await page.getByRole('button', { name: /^All countries/ }).click();
      expect(await checkedCountries(page)).toEqual([]);
      // Region and state narrow a single chosen country; with all countries they step aside.
      await expect.poll(() => page.getByLabel('Region', { exact: true }).isHidden()).toBe(true);
      await expect.poll(() => page.getByLabel('State / subdivision').isHidden()).toBe(true);
      expect(await page.getByLabel('Channel sort').inputValue()).toBe('name');
      expect(
        await page
          .locator('[data-channel]')
          .evaluateAll((nodes) => nodes.map((node) => (node as HTMLElement).dataset.channel)),
      ).toEqual(['ca', 'unknown']);
      expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual([]);
      await page.evaluate(() => {
        const browser = Reflect.get(window, 'browser');
        browser.setFilter('all');
        browser.search('');
      });
      expect(await page.locator('[data-channel="il"]').getAttribute('aria-current')).toBe('true');
    } finally {
      await cleanup(page);
    }
  });

  it('reuses normalized metadata for selection/favorites and invalidates mutated objects or reused IDs', async () => {
    const page = await fixture();
    try {
      const result = await page.evaluate(() => {
        const state = window as unknown as {
          channels: { id: string; name: string; category: string }[];
          browser: {
            update(
              channels: typeof state.channels,
              favorites: string[],
              selected: string | null,
            ): void;
            search(query: string): void;
            setFilter(filter: string): void;
          };
        };
        const original = String.prototype.normalize;
        let normalizations = 0;
        String.prototype.normalize = function (form) {
          if (String(this).startsWith('Cache ')) normalizations++;
          return original.call(this, form);
        };
        try {
          state.channels = [{ id: 'same', name: 'Cache Fox', category: 'News' }];
          state.browser.update(state.channels, [], null);
          const initial = normalizations;
          state.browser.update([...state.channels], ['same'], 'same');
          state.browser.setFilter('favorites');
          state.browser.search('Cache Fox');
          const reused = normalizations - initial - 1; // Only the query itself is normalized.
          const ids = () =>
            [...document.querySelectorAll<HTMLElement>('[data-channel]')].map(
              (node) => node.dataset.channel,
            );
          const favoriteMatch = ids();
          state.channels[0].name = 'Cache Bears';
          state.channels[0].category = 'Sports';
          state.browser.update(state.channels, ['same'], 'same');
          const oldNameMatches = ids();
          state.browser.search('Cache Bears');
          state.browser.setFilter('news');
          const oldCategoryMatches = ids();
          state.browser.setFilter('sports');
          const changedMatch = ids();
          state.channels = [{ id: 'same', name: 'Cache Hockey', category: 'News' }];
          state.browser.update(state.channels, [], null);
          state.browser.setFilter('all');
          const reusedIdOldName = ids();
          state.browser.search('Cache Hockey');
          return {
            initial,
            reused,
            favoriteMatch,
            oldNameMatches,
            oldCategoryMatches,
            changedMatch,
            reusedIdOldName,
            newName: ids(),
          };
        } finally {
          String.prototype.normalize = original;
        }
      });
      expect(result.initial).toBeGreaterThan(0);
      expect(result.reused).toBe(0);
      expect(result.favoriteMatch).toEqual(['same']);
      expect(result.oldNameMatches).toEqual([]);
      expect(result.oldCategoryMatches).toEqual([]);
      expect(result.changedMatch).toEqual(['same']);
      expect(result.reusedIdOldName).toEqual([]);
      expect(result.newName).toEqual(['same']);
    } finally {
      await cleanup(page);
    }
  });
  it('uses deterministic Unicode substring matching without changing query order or tuning', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        const state = window as unknown as {
          channels: unknown[];
          browser: {
            update(channels: unknown[], favorites: string[], selected: null): void;
            search(query: string): void;
            setFilter(filter: string): void;
          };
        };
        state.channels = [
          { id: 'fullwidth', name: 'ＦＯＸ Chicago Bears', category: 'Ｎｅｗｓ' },
          { id: 'accent', name: 'Cafe\u0301 TV', category: 'Sports' },
          { id: 'safe', name: '<img src=x>', category: 'News' },
        ];
        state.browser.update(state.channels, [], null);
        state.browser.setFilter('news');
        state.browser.search(' fox Chicago ');
      });
      expect(await page.locator('[data-channel]').count()).toBe(1);
      expect(await page.locator('[data-channel]').getAttribute('data-channel')).toBe('fullwidth');
      await page.evaluate(() => Reflect.get(window, 'browser').search('Bears Chicago'));
      expect(await page.locator('[data-channel]').count()).toBe(0);
      await page.evaluate(() => {
        const browser = Reflect.get(window, 'browser');
        browser.setFilter('all');
        browser.search('CAFÉ');
      });
      expect(await page.locator('[data-channel]').getAttribute('data-channel')).toBe('accent');
      await page.evaluate(() => Reflect.get(window, 'browser').search('<img'));
      expect(await page.locator('#channel-rows img').count()).toBe(0);
      expect(await page.locator('[data-channel]').getAttribute('data-channel')).toBe('safe');
      expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual([]);
    } finally {
      await cleanup(page);
    }
  });
  it('keeps favorites first and preserves source order within each group after sorting', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        const state = window as unknown as {
          channels: unknown[];
          browser: { update(channels: unknown[], favorites: string[], selected: string): void };
          controls: { update(): void };
        };
        state.channels.reverse();
        state.browser.update(state.channels, ['il'], 'il');
        state.controls.update();
      });
      expect(await page.getByLabel('Channel sort').inputValue()).toBe('source');
      const ids = () =>
        page
          .locator('[data-channel]')
          .evaluateAll((elements) =>
            elements.map((element) => (element as HTMLElement).dataset.channel),
          );
      expect(await ids()).toEqual(['il', 'unknown', 'tx', 'ca']);
      expect((await ids())[0]).toBe('il'); // Favorite priority applies independently of source order.
      await page.getByLabel('Channel sort').selectOption('geography');
      expect(await ids()).toEqual(['il', 'ca', 'tx', 'unknown']);
      await page.getByLabel('Channel sort').selectOption('source');
      expect(await ids()).toEqual(['il', 'unknown', 'tx', 'ca']);
      expect(
        await page.evaluate(() => (window as unknown as { selected: string[] }).selected),
      ).toEqual([]);
    } finally {
      await cleanup(page);
    }
  });
  it('filters parents, resets child selections, distinguishes Unknown and never tunes', async () => {
    const page = await fixture();
    try {
      await toggleCountry(page, 'US');
      expect(await page.locator('#channel-count').textContent()).toBe('2 channels');
      await page.getByLabel('State / subdivision').selectOption('US-IL');
      expect(await page.locator('#channel-count').textContent()).toBe('1 channel');
      await toggleCountry(page, 'US');
      await toggleCountry(page, 'CA');
      expect(await page.getByLabel('State / subdivision').inputValue()).toBe('');
      expect(await page.locator('#channel-rows').textContent()).toContain('Canada Station');
      await toggleCountry(page, '?');
      // Unknown is chosen alone.
      expect(await checkedCountries(page)).toEqual(['?']);
      expect(await page.locator('#channel-rows').textContent()).toContain('Unknown Station');
      expect(
        await page.evaluate(() => (window as unknown as { selected: string[] }).selected),
      ).toEqual([]);
    } finally {
      await cleanup(page);
    }
  });
  it('composes geography with favorites, search and stable name sort while preserving selection', async () => {
    const page = await fixture();
    try {
      await toggleCountry(page, 'US');
      await page.evaluate(() => {
        const state = window as unknown as {
          browser: { setFilter(value: string): void; search(value: string): void };
        };
        state.browser.setFilter('favorites');
        state.browser.search('FOX');
      });
      expect(await page.locator('[data-channel="il"]').getAttribute('aria-current')).toBe('true');
      await page.getByLabel('Channel sort').selectOption('name');
      expect(await page.locator('#channel-count').textContent()).toBe('1 channel');
      await page.locator('[data-channel="il"]').click();
      expect(
        await page.evaluate(() => (window as unknown as { selected: string[] }).selected),
      ).toEqual(['il']);
    } finally {
      await cleanup(page);
    }
  });
  it('keeps rendering bounded and allows keyboard navigation through a large geographic catalog', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        const state = window as unknown as {
          channels: unknown[];
          browser: { update(channels: unknown[], favorites: string[], selected: null): void };
          controls: { update(): void };
        };
        state.channels = Array.from({ length: 5001 }, (_, index) => ({
          id: String(index),
          sourceId: 'source',
          name: 'Station ' + String(index).padStart(5, '0'),
          category: 'News',
          geography: { country: 'US', state: 'US-IL' },
        }));
        state.browser.update(state.channels, [], null);
        state.controls.update();
      });
      expect(await page.locator('[data-channel]').count()).toBeLessThan(20);
      await page.locator('#list').focus();
      await page.keyboard.press('End');
      await page.waitForFunction(
        () => (document.activeElement as HTMLElement)?.dataset.channel === '5000',
      );
      expect(
        await page.evaluate(() => (document.activeElement as HTMLElement)?.dataset.channel),
      ).toBe('5000');
      expect(await page.locator('[data-channel]').count()).toBeLessThan(20);
      expect(
        await page.evaluate(() => (window as unknown as { selected: string[] }).selected),
      ).toEqual([]);
    } finally {
      await cleanup(page);
    }
  });
});

it('All geography removes own filter keys while Unknown remains explicit null', async () => {
  const page = await fixture();
  try {
    await toggleCountry(page, 'US');
    await toggleCountry(page, 'US');
    expect(await page.evaluate(() => Reflect.get(window, 'filters').at(-1))).toEqual({});
    await toggleCountry(page, '?');
    expect(await page.evaluate(() => Reflect.get(window, 'filters').at(-1))).toEqual({
      country: null,
    });
    expect(await page.locator('#channel-count').textContent()).toBe('1 channel');
    expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual([]);
  } finally {
    await cleanup(page);
  }
});

it('several countries combine: USA, Canada and the UK each add their channels', async () => {
  const page = await fixture();
  try {
    await page.evaluate(() => {
      const channels = Reflect.get(window, 'channels') as unknown[];
      channels.push(
        {
          id: 'uk',
          sourceId: 's',
          name: 'London Live',
          category: 'News',
          geography: { country: 'UK' },
        },
        {
          id: 'fr',
          sourceId: 's',
          name: 'Paris Info',
          category: 'News',
          geography: { country: 'FR' },
        },
      );
      Reflect.get(window, 'browser').update(channels, [], null);
      Reflect.get(window, 'controls').update();
    });
    // English-speaking countries first (US, CA, UK), then the rest, then Unknown.
    expect(await countryCodes(page)).toEqual(['US', 'CA', 'UK', 'FR', '?']);
    expect(await page.locator('.geography-countries-group').allTextContents()).toEqual([
      'English-speaking',
      'Other countries',
    ]);
    for (const code of ['US', 'CA', 'UK']) await toggleCountry(page, code);
    expect(await checkedCountries(page)).toEqual(['US', 'CA', 'UK']);
    expect(await page.evaluate(() => Reflect.get(window, 'filters').at(-1))).toEqual({
      countries: ['US', 'CA', 'UK'],
    });
    expect(await page.locator('#channel-count').textContent()).toBe('4 channels');
    expect(await page.locator('#channel-rows').textContent()).not.toContain('Paris Info');
    // Region and state need exactly one country.
    expect(await page.getByLabel('Region', { exact: true }).isHidden()).toBe(true);
    // Unchecking one leaves the others.
    await toggleCountry(page, 'CA');
    expect(await page.evaluate(() => Reflect.get(window, 'filters').at(-1))).toEqual({
      countries: ['US', 'UK'],
    });
    expect(await page.locator('#channel-count').textContent()).toBe('3 channels');
    expect(await page.evaluate(() => Reflect.get(window, 'selected'))).toEqual([]);
  } finally {
    await cleanup(page);
  }
});
