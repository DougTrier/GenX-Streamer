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

/**
 * GenXtra search navigation: languages, Play, collections, inline files and
 * compact rows.
 */
import { expect, test } from '@playwright/test';
import { type ArchiveLanguageMode, type ArchiveQuery } from '../../src/platform/archive-catalog';
import {
  useArchiveStatusNavigation,
  mount,
  releaseFiles,
} from './archive-status-navigation.fixture';

useArchiveStatusNavigation();

test('local language browsing defaults to English first and forwards the pending-file scope', async ({
  page,
}) => {
  await mount(page);
  await expect(page.locator('#genxtra-language')).toHaveValue('english-first');
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        queries: f.queryRequests,
        pending: f.pendingRequests,
        discovery: f.discoveryCalls,
        selections: f.selections,
      };
    }),
  ).toEqual({
    queries: [
      {
        schemaVersion: 1,
        query: 'Q',
        expectedRevision: null,
        offset: 0,
        pageSize: 50,
        decade: 1970,
        favoritesOnly: false,
        languageMode: 'english-first',
      },
    ],
    pending: [{ expectedRevision: '1', offset: 0, query: 'Q', languageMode: 'english-first' }],
    discovery: 0,
    selections: [],
  });
});
test('language choices re-query only saved titles and suggestions with truthful empty guidance', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    Reflect.get(window, 'archiveFixture').matches = 0;
  });
  const choices = [
    ['all', 'No saved Archive matches. Use the magnifier to search online.'],
    ['english', 'No videos listed as English. Try All languages, or Search online.'],
    ['unlisted', 'No videos with an unlisted language. Try All languages.'],
  ];
  for (const [mode, guidance] of choices) {
    if (!(await page.getByRole('combobox', { name: 'Browse video languages' }).isVisible()))
      await page.getByText('Filters', { exact: true }).click();
    await page.getByRole('combobox', { name: 'Browse video languages' }).selectOption(mode!);
    await expect(page.locator('.gx-archive-status')).toHaveText(guidance!);
    await expect(page.locator('.gx-archive-title-button')).toHaveCount(0);
    expect(
      await page.evaluate(() => {
        const f = Reflect.get(window, 'archiveFixture');
        return {
          query: f.queryRequests.at(-1),
          pending: f.pendingRequests.at(-1),
          discovery: f.discoveryCalls,
          selections: f.selections,
          filesStarted: f.filesStarted,
        };
      }),
    ).toEqual({
      query: {
        schemaVersion: 1,
        query: 'Q',
        expectedRevision: null,
        offset: 0,
        pageSize: 50,
        decade: 1970,
        favoritesOnly: false,
        languageMode: mode,
      },
      pending: { expectedRevision: '1', offset: 0, query: 'Q', languageMode: mode },
      discovery: 0,
      selections: [],
      filesStarted: false,
    });
  }
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return [f.queryCalls, f.pendingRequests.length];
    }),
  ).toEqual([4, 4]);
});
test('a held obsolete language reply joins without publishing over a newer mode', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.holdQuery = true;
    f.titles[0].title = 'Obsolete all-language title';
    f.publishedTitles = [];
    f.observer = new MutationObserver(() => {
      for (const title of f.container.querySelectorAll('.gx-archive-title-button'))
        f.publishedTitles.push(title.textContent);
    });
    f.observer.observe(f.container, { childList: true, subtree: true });
  });
  await page.getByText('Filters', { exact: true }).click();
  const language = page.getByRole('combobox', { name: 'Browse video languages' });
  await language.selectOption('all');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').queryCalls))
    .toBe(2);
  await language.selectOption('english');
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        aborted: f.querySignals[1].aborted,
        queries: f.queryCalls,
        pending: f.pendingRequests.length,
      };
    }),
  ).toEqual({ aborted: true, queries: 2, pending: 1 });
  await expect(page.locator('.gx-archive-title-button')).toHaveCount(0);
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.matches = 0;
    f.holdQuery = false;
    f.releases.forEach((release: () => void) => release());
  });
  await expect(page.locator('.gx-archive-status')).toHaveText(
    'No videos listed as English. Try All languages, or Search online.',
  );
  await expect(language).toHaveValue('english');
  await expect(page.locator('.gx-archive-title-button')).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      f.observer.disconnect();
      return {
        queries: f.queryRequests.map((request: ArchiveQuery) => request.languageMode),
        pending: f.pendingRequests.map(
          (request: { languageMode: ArchiveLanguageMode }) => request.languageMode,
        ),
        stalePublished: f.publishedTitles.some((text: string) =>
          text.includes('Obsolete all-language title'),
        ),
        discovery: f.discoveryCalls,
        selections: f.selections,
      };
    }),
  ).toEqual({
    queries: ['english-first', 'all', 'english'],
    pending: ['english-first', 'english'],
    stalePublished: false,
    discovery: 0,
    selections: [],
  });
});
test('Play is visible first; keyboard skips closed/nested details and unavailable controls', async ({
  page,
}) => {
  await mount(page);
  await page.locator('.gx-archive-title-button').first().click();
  const play = page.getByRole('button', { name: 'Play Video 1' });
  await expect(play).toBeFocused();
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture'),
        b = document.activeElement!,
        l = f.container.querySelector('.gx-archive-results');
      const rect = b.getBoundingClientRect(),
        list = l.getBoundingClientRect();
      return {
        selected: f.selections.length,
        inline: f.container.querySelector('.gx-archive-inline-videos').contains(b),
        rightFiles: f.details.querySelectorAll('.gx-archive-files').length,
        visible: rect.top >= list.top - 1 && rect.bottom <= list.bottom + 1,
      };
    }),
  ).toEqual({ selected: 0, inline: true, rightFiles: 0, visible: true });
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    const nested = document.createElement('details');
    nested.open = true;
    const summary = document.createElement('summary');
    summary.textContent = 'Hidden nested summary';
    const action = document.createElement('button');
    action.textContent = 'Hidden nested action';
    nested.append(summary, action);
    f.container.querySelector('.gx-archive-file-details').append(nested);
    const disabled = document.createElement('button');
    disabled.textContent = 'Aria disabled';
    disabled.setAttribute('aria-disabled', 'true');
    const invisible = document.createElement('button');
    invisible.textContent = 'Invisible';
    invisible.style.visibility = 'hidden';
    f.container.querySelector('.gx-archive-files').append(disabled, invisible);
  });
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.gx-archive-file-details > summary')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(play).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.gx-archive-title-button').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(play).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.gx-archive-title-button').nth(1)).toBeFocused();
});
test('multi-file title requires explicit second Play choice without autoplay', async ({ page }) => {
  await mount(page, 2);
  await page.locator('.gx-archive-title-button').first().click();
  await expect(page.getByRole('button', { name: 'Play Video 1' })).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').selections)).toEqual([]);
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Play Video 2' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').selections))
    .toEqual(['d'.repeat(64)]);
});
test('episode arrows stay in the Play or More column and horizontal arrows reach the separate actions', async ({
  page,
}) => {
  await mount(page, 3);
  const title = page.locator('.gx-archive-title-button').first();
  const play = page.locator('.gx-archive-file-button');
  const more = page.locator('.gx-archive-file-details > summary');
  await title.click();
  await expect(play.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(play.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(play.nth(2)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(play.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(more.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(more.nth(2)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(more.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(play.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(title).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await expect(more.nth(0).locator('..')).toHaveAttribute('open', '');
  await page.keyboard.press('ArrowDown');
  await expect(
    page.getByRole('button', { name: 'Remove from GenXtra', exact: true }).first(),
  ).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(more.nth(0)).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').selections)).toEqual([]);
});
test('collection expands inline, collapses without losing selection, and reopens without refetch or autoplay', async ({
  page,
}) => {
  await mount(page, 2);
  const title = page.locator('.gx-archive-title-button').first();
  const list = page.locator('.gx-archive-results');
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  const controls = await title.getAttribute('aria-controls');
  await expect(page.locator(`#${controls}`)).toBeHidden();
  await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  await expect(list.getByRole('button', { name: 'Play Video 1' })).toBeFocused();
  await expect(page.locator('#archive-details .gx-archive-files')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator(`#${controls}`)).toBeHidden();
  await expect(page.locator('#archive-details .gx-archive-detail-title')).toHaveText('Title 1');
  await page.keyboard.press('Enter');
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('ArrowDown');
  await expect(list.getByRole('button', { name: 'Play Video 1' })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(list.locator('.gx-archive-file-details > summary').first()).toBeFocused();
  expect(
    await page.evaluate(() => Reflect.get(window, 'archiveFixture').ui.dismissEpisodes()),
  ).toBe(true);
  await expect(title).toBeFocused();
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  expect(
    await page.evaluate(() => Reflect.get(window, 'archiveFixture').ui.dismissEpisodes()),
  ).toBe(false);
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        calls: f.fileCalls,
        query: f.input.value,
        titles: f.container.querySelectorAll('.gx-archive-title-button').length,
        selections: f.selections,
      };
    }),
  ).toEqual({ calls: 1, query: 'Q', titles: 2, selections: [] });
});
test('collapsing a held file request does not reopen or move focus when the original settles', async ({
  page,
}) => {
  await mount(page, 2, true);
  const title = page.locator('.gx-archive-title-button').first();
  await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  await title.click();
  await expect(title).toHaveAttribute('aria-expanded', 'false');
  await releaseFiles(page);
  await expect(page.locator('.gx-archive-status')).toHaveText('Choose a video to play.');
  await expect(title).toBeFocused();
  await expect(page.locator('.gx-archive-inline-videos').first()).toBeHidden();
  await expect(page.locator('#archive-details .gx-archive-detail-title')).toHaveText('Title 1');
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return { calls: f.fileCalls, selections: f.selections, query: f.input.value };
    }),
  ).toEqual({ calls: 1, selections: [], query: 'Q' });
});
test('an unavailable inline video keeps safe More metadata keyboard reachable without Play', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    Reflect.get(window, 'archiveFixture').files[0].availability = 'dead';
  });
  await page.locator('.gx-archive-title-button').first().click();
  const inline = page.locator('.gx-archive-inline-videos:not([hidden])');
  await expect(inline.getByRole('button', { name: 'Play Video 1' })).toBeDisabled();
  await expect(inline.locator('summary')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(inline.locator('.gx-archive-file-details')).toHaveAttribute('open', '');
  await expect(inline.getByText('Internet Archive · fixture', { exact: true })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.gx-archive-title-button').first()).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').selections)).toEqual([]);
});
test('inline file paging remains bounded and preserves the title list and explicit Play', async ({
  page,
}) => {
  await mount(page, 51);
  const title = page.locator('.gx-archive-title-button').first();
  await title.click();
  const inline = page.locator('.gx-archive-inline-videos:not([hidden])');
  await expect(inline.locator('.gx-archive-file-row')).toHaveCount(50);
  await inline.getByRole('button', { name: 'More files', exact: true }).click();
  await expect(inline.locator('.gx-archive-file-row')).toHaveCount(1);
  await expect(inline.getByRole('button', { name: 'Play Video 51', exact: true })).toBeVisible();
  await expect(inline.getByRole('button', { name: 'More files', exact: true })).toBeDisabled();
  await expect(page.locator('.gx-archive-title-button')).toHaveCount(2);
  await expect(title).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('#archive-details .gx-archive-files')).toHaveCount(0);
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        pages: f.fileRequests.map((request: { offset: number; pageSize: number }) => [
          request.offset,
          request.pageSize,
        ]),
        selections: f.selections,
        query: f.input.value,
      };
    }),
  ).toEqual({
    pages: [
      [0, 50],
      [50, 50],
    ],
    selections: [],
    query: 'Q',
  });
});
test('compact real-data rows keep favorite and full safe details separate from explicit Play', async ({
  page,
}) => {
  await mount(page);
  const longTitle = 'A very long saved programme title '.repeat(6).trim();
  await page.evaluate(async (title) => {
    const f = Reflect.get(window, 'archiveFixture');
    f.titles[0].title = title;
    f.titles[0].providerDescription = '<img src=x onerror=alert(1)>';
    await f.ui.resume('Q');
  }, longTitle);
  const first = page.locator('.gx-archive-result-row').first();
  expect(
    await first.evaluate((row) => {
      const rect = row.getBoundingClientRect();
      const name = row.querySelector('.gx-archive-result-name')!;
      const subtitle = row.querySelector('.gx-archive-result-subtitle')!;
      return {
        height: rect.height,
        horizontalOverflow: row.scrollWidth > row.clientWidth + 1,
        titleSize: parseFloat(getComputedStyle(name).fontSize),
        subtitleSize: parseFloat(getComputedStyle(subtitle).fontSize),
      };
    }),
  ).toMatchObject({ horizontalOverflow: false, titleSize: 17, subtitleSize: 13.5 });
  const rowHeight = await first.evaluate((row) => row.getBoundingClientRect().height);
  expect(rowHeight).toBeGreaterThanOrEqual(64);
  expect(rowHeight).toBeLessThanOrEqual(76);
  await expect(page.locator('.gx-archive-result-summary')).toHaveText('Results for “Q” · 2 saved');
  await expect(first.locator('.gx-archive-result-name')).toHaveText(longTitle);
  await expect(first.locator('.gx-archive-result-artwork')).toHaveAttribute(
    'data-artwork',
    'fallback',
  );
  await expect(
    first.locator('img,.gx-archive-context,.gx-archive-synopsis,.gx-archive-files,details'),
  ).toHaveCount(0);
  await first.locator('.gx-archive-favorite').click();
  await expect(first.locator('.gx-archive-favorite')).toHaveAttribute('aria-pressed', 'true');
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        favorites: f.favoriteCalls,
        selections: f.selections,
        titleSelected: f.titleSelectedCalls,
      };
    }),
  ).toEqual({ favorites: 1, selections: [], titleSelected: 0 });
  await first.locator('.gx-archive-title-button').click();
  await expect(first).toHaveAttribute('data-selected', 'true');
  await expect(first.locator('.gx-archive-title-button')).toHaveAttribute('aria-current', 'true');
  await expect(page.locator('#archive-details .gx-archive-detail-title')).toHaveText(longTitle);
  await expect(page.getByRole('button', { name: 'Play Video 1' })).toBeFocused();
  await page.getByText('More info', { exact: true }).click();
  await expect(page.locator('#archive-details .gx-archive-synopsis')).toHaveText(
    '<img src=x onerror=alert(1)>',
  );
  await expect(page.locator('#archive-details img')).toHaveCount(0);
  await first.locator('.gx-archive-title-button').click();
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        files: f.fileCalls,
        selections: f.selections,
        titleSelected: f.titleSelectedCalls,
        query: f.input.value,
      };
    }),
  ).toEqual({ files: 1, selections: [], titleSelected: 2, query: 'Q' });
});
