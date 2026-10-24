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
import type {
  ArchiveLanguageMode,
  ArchiveFileProgress,
  ArchiveQuery,
  ArchiveSelection,
  ArchiveArtworkRequest,
} from '../../src/platform/archive-catalog';

/** Static metadata and deliberately held originals; no upstream URLs or native decoder claims. */
async function mount(
  page: Page,
  count = 1,
  hold = false,
  artworkMode: 'valid' | 'hold' | 'invalid' | 'absent' | null = null,
): Promise<void> {
  await page.route('**/archive-navigation-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><body></body>',
    }),
  );
  await page.goto('/archive-navigation-fixture');
  await page.evaluate(
    async ({ count, hold, artworkMode }) => {
      const modulePath = '/src/ui/archive-search.ts';
      const { mountArchiveSearch } = await import(modulePath);
      const stylesheetPath = '/src/ui/media-results.css';
      const genxtraStylesheetPath = '/src/ui/genxtra.css';
      const tvDensityStylesheetPath = '/src/ui/tv-density.css';
      await import(genxtraStylesheetPath);
      await import(stylesheetPath);
      await import(tvDensityStylesheetPath);
      // Match the application's global sizing rule without importing its full shell layout.
      const sizing = document.createElement('style');
      sizing.textContent = '*,*::before,*::after{box-sizing:border-box}';
      document.head.append(sizing);
      document.body.style.cssText = 'height:500px;margin:8px;overflow:hidden';
      const input = document.createElement('input');
      input.value = 'Q';
      const container = document.createElement('div');
      container.id = 'genxtra-library';
      container.style.cssText = 'width:340px;height:410px;display:flex;flex-direction:column';
      const details = document.createElement('div');
      details.id = 'archive-details';
      details.style.cssText = 'width:480px;height:410px;overflow:auto';
      const layout = document.createElement('div');
      layout.id = 'app';
      layout.dataset.contentLibrary = 'genxtra';
      layout.dataset.deviceKind = 'desktop';
      layout.style.cssText = 'display:flex;gap:16px';
      layout.append(container, details);
      document.body.append(input, layout);
      const titles = ['a'.repeat(64), 'c'.repeat(64)].map((titleRef, i) => ({
        titleRef,
        title: `Title ${i + 1}`,
        kind: 'tv',
        contentType: 'tv',
        contentTypeProvenance: 'provider-item',
        releaseYear: 1972,
        curated: true,
        titleProvenance: 'provider-item',
        fileCount: count,
        durationSeconds: 120,
        rights: null,
        rank: i + 1,
        quality: 'metadata-h264',
        observedMs: 1,
        favorite: false,
      }));
      const files = Array.from({ length: count }, (_, i) => ({
        fileRef: i < 2 ? (i ? 'd' : 'b').repeat(64) : (1000 + i).toString(16).padStart(64, '0'),
        title: `Video ${i + 1}`,
        fileName: `video${i + 1}.mp4`,
        itemId: 'fixture',
        format: 'h.264',
        durationSeconds: 120,
        sizeBytes: '1024',
        availability: 'unverified',
        observedMs: 1,
      }));
      const fixture = {
        titles,
        files,
        pendingItems: [] as ArchiveFileProgress[],
        pendingTotal: 0,
        loadFileCalls: 0,
        input,
        container,
        details,
        playbackActive: false,
        titleSelectedCalls: 0,
        favoriteCalls: 0,
        revision: '1',
        hold,
        filesStarted: false,
        fileCalls: 0,
        fileRequests: [] as Array<{
          titleRef: string;
          expectedRevision?: string;
          offset: number;
          pageSize: number;
        }>,
        contentType: undefined as ArchiveQuery['contentType'],
        artworkMode,
        artworkRequests: [] as ArchiveArtworkRequest[],
        artworkSignals: [] as AbortSignal[],
        artworkReleases: [] as Array<() => void>,
        artworkActive: 0,
        maxArtworkActive: 0,
        scope: 'ready',
        outcome: 'partial',
        matches: 2,
        selections: [] as string[],
        selectionSignals: [] as AbortSignal[],
        selectionRequests: [] as ArchiveSelection[],
        selectionError: null as
          'resume-cancel' | 'resume-watchagain' | 'failure' | 'cleanup' | null,
        holdSelection: false,
        selectionReleases: [] as Array<() => void>,
        failAfterResume: false,
        releases: [] as Array<() => void>,
        signals: [] as AbortSignal[],
        querySignals: [] as AbortSignal[],
        queryRequests: [] as ArchiveQuery[],
        pendingRequests: [] as Array<{
          expectedRevision: string;
          offset: number;
          query: string;
          languageMode?: ArchiveLanguageMode;
          contentType?: ArchiveQuery['contentType'];
        }>,
        holdQuery: false,
        holdOffset: null as number | null,
        queryFailureOffset: null as number | null,
        queryCalls: 0,
        querySettled: 0,
        discoveryCalls: 0,
        discoveryViews: [] as unknown[],
        discoveryIntents: [] as unknown[],
      };
      const ui = mountArchiveSearch(container, {
        input,
        detailsContainer: details,
        playbackActive: () => fixture.playbackActive,
        onTitleSelected: () => {
          fixture.titleSelectedCalls++;
        },
        readyScope: () => fixture.scope,
        queryOptions: () => ({
          decade: 1970,
          favoritesOnly: false,
          ...(fixture.contentType === undefined ? {} : { contentType: fixture.contentType }),
        }),
        artwork:
          artworkMode === null
            ? undefined
            : async (request: ArchiveArtworkRequest, signal: AbortSignal) => {
                fixture.artworkRequests.push({ ...request });
                fixture.artworkSignals.push(signal);
                fixture.artworkActive++;
                fixture.maxArtworkActive = Math.max(
                  fixture.maxArtworkActive,
                  fixture.artworkActive,
                );
                const mode = fixture.artworkMode;
                try {
                  if (mode === 'hold')
                    await new Promise<void>((resolve) => fixture.artworkReleases.push(resolve));
                  if (mode === 'absent') return null;
                  const canvas = document.createElement('canvas');
                  canvas.width = 1;
                  canvas.height = 1;
                  const context = canvas.getContext('2d')!;
                  context.fillStyle = `#${request.titleRef.slice(-6)}`;
                  context.fillRect(0, 0, 1, 1);
                  const dataUrl = canvas.toDataURL('image/png');
                  const encoded = dataUrl.split(',')[1];
                  return {
                    schemaVersion: 1,
                    titleRef: request.titleRef,
                    revision: request.expectedRevision,
                    artworkRef: request.titleRef,
                    mimeType: 'image/png',
                    width: 1,
                    height: 1,
                    byteLength: atob(encoded).length,
                    dataUrl:
                      mode === 'invalid' ? 'https://invalid.example/not-authorized.png' : dataUrl,
                  };
                } finally {
                  fixture.artworkActive--;
                }
              },
        catalog: {
          query: async (request: ArchiveQuery, signal: AbortSignal) => {
            fixture.queryCalls++;
            fixture.queryRequests.push({ ...request });
            fixture.querySignals.push(signal);
            if (fixture.queryFailureOffset === request.offset)
              throw new Error('Controlled local continuation failure');
            const matches = fixture.matches;
            const items = matches
              ? titles
                  .slice(request.offset, request.offset + request.pageSize)
                  .map((title) => ({ ...title }))
              : [];
            if (fixture.holdQuery || fixture.holdOffset === request.offset)
              await new Promise<void>((resolve) => fixture.releases.push(resolve));
            fixture.querySettled++;
            return {
              schemaVersion: 1,
              revision: fixture.revision,
              totalCount: matches,
              offset: request.offset,
              items,
              more: request.offset + items.length < matches,
            };
          },
          files: async (
            request: {
              titleRef: string;
              expectedRevision?: string;
              offset: number;
              pageSize: number;
            },
            signal: AbortSignal,
          ) => {
            fixture.filesStarted = true;
            fixture.fileCalls++;
            fixture.fileRequests.push({ ...request });
            fixture.signals.push(signal);
            if (fixture.hold) await new Promise<void>((resolve) => fixture.releases.push(resolve));
            return {
              schemaVersion: 1,
              revision: fixture.revision,
              titleRef: request.titleRef,
              totalCount: files.length,
              offset: request.offset,
              files: files.slice(request.offset, request.offset + request.pageSize),
              more: request.offset + request.pageSize < files.length,
            };
          },
        },
        pendingFiles: async (
          expectedRevision: string,
          offset: number,
          query: string,
          _signal: AbortSignal,
          languageMode?: ArchiveLanguageMode,
          contentType?: ArchiveQuery['contentType'],
        ) => {
          fixture.pendingRequests.push({
            expectedRevision,
            offset,
            query,
            languageMode,
            ...(contentType === undefined ? {} : { contentType }),
          });
          return {
            schemaVersion: 1,
            revision: expectedRevision,
            totalCount: fixture.pendingTotal,
            offset,
            items: fixture.pendingItems.map((item) => ({ ...item })),
            more: fixture.pendingTotal > offset + fixture.pendingItems.length,
          };
        },
        loadFiles: async (progress: ArchiveFileProgress, expectedRevision: string) => {
          fixture.loadFileCalls++;
          const updated = fixture.pendingItems.find((item) => item.titleRef === progress.titleRef)!;
          updated.nextOffset += 5;
          updated.availableFileCount++;
          fixture.revision = String(BigInt(expectedRevision) + 1n);
          return {
            schemaVersion: 1,
            committed: true,
            revision: fixture.revision,
            admitted: 1,
            confirmedDead: 0,
            progress: { ...updated },
          };
        },
        onSelect: async (selection: ArchiveSelection, signal: AbortSignal) => {
          fixture.selectionSignals.push(signal);
          fixture.selectionRequests.push({ ...selection });
          if (
            fixture.selectionError === 'resume-cancel' ||
            fixture.selectionError === 'resume-watchagain'
          ) {
            const resumePath = '/src/ui/archive-resume.ts';
            const { chooseArchiveResume } = await import(resumePath);
            const choice = await chooseArchiveResume(
              selection.title,
              12500,
              signal,
              fixture.selectionError === 'resume-watchagain',
            );
            if (choice === 'cancel')
              throw new DOMException('Archive selection was canceled.', 'AbortError');
          }
          if (fixture.holdSelection)
            await new Promise<void>((resolve) => fixture.selectionReleases.push(resolve));
          if (fixture.failAfterResume)
            throw new Error('Controlled failure after the resume choice.');
          if (fixture.selectionError === 'failure')
            throw new Error('Private controlled fixture detail');
          if (fixture.selectionError === 'cleanup') {
            const playerPath = '/src/application/archive-player.ts';
            const { ArchivePlayerCleanupError } = await import(playerPath);
            throw new ArchivePlayerCleanupError();
          }
          fixture.selections.push(selection.fileRef);
        },
        onFavorite: async (
          title: { titleRef: string },
          expectedRevision: string,
          value: boolean,
        ) => {
          fixture.favoriteCalls++;
          fixture.titles.find((item) => item.titleRef === title.titleRef)!.favorite = value;
          fixture.revision = String(BigInt(expectedRevision) + 1n);
          return {
            schemaVersion: 1,
            committed: true,
            revision: fixture.revision,
            titleRef: title.titleRef,
            favorite: value,
          };
        },
        onRemove: async () => {
          throw new Error('Unexpected remove fixture action');
        },
        discover: async (_query: string, _signal: AbortSignal, _intent: string, view: unknown) => {
          fixture.discoveryCalls++;
          fixture.discoveryIntents.push(_intent);
          fixture.discoveryViews.push(structuredClone(view));
          return { revision: '1', outcome: fixture.outcome, examined: 60, admitted: 0 };
        },
      });
      Reflect.set(window, 'archiveFixture', { ...fixture, ui });
      // Preserve one mutable owner object for the host closures and test controls.
      Object.assign(fixture, { ui });
      Reflect.set(window, 'archiveFixture', fixture);
      await ui.resume('Q');
    },
    { count, hold, artworkMode },
  );
}

async function releaseFiles(page: Page): Promise<void> {
  await page.evaluate(() =>
    Reflect.get(window, 'archiveFixture').releases.forEach((release: () => void) => release()),
  );
}

async function savedTitles(page: Page, count: number): Promise<void> {
  await page.evaluate(async (count) => {
    const f = Reflect.get(window, 'archiveFixture');
    const template = f.titles[0];
    for (let index = 2; index < count; index++)
      f.titles.push({
        ...template,
        titleRef: index.toString(16).padStart(64, '0'),
        title: `Saved title ${index + 1}`,
        rank: index + 1,
      });
    f.matches = count;
    await f.ui.resume('Q');
  }, count);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.route('**/*', (route) => {
    expect(new URL(route.request().url()).hostname).toBe('127.0.0.1');
    return route.continue();
  });
});
test.afterEach(async ({ page }) => {
  await page.evaluate(async () => {
    const fixture = Reflect.get(window, 'archiveFixture');
    if (fixture) {
      fixture.releases.forEach((release: () => void) => release());
      fixture.selectionReleases.forEach((release: () => void) => release());
      fixture.artworkReleases.forEach((release: () => void) => release());
      await fixture.ui.dispose();
      Reflect.get(window, 'queryFocusRemoteDispose')?.();
    }
  });
});

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

test('title overview and compact video rows preserve safe metadata and independent favorite authority', async ({
  page,
}) => {
  await mount(page, 2);
  await page.evaluate(async () => {
    const f = Reflect.get(window, 'archiveFixture');
    Object.assign(f.titles[0], {
      kind: 'movie',
      contentType: 'unknown',
      contentTypeProvenance: 'unknown',
      providerDescription: '<img src=x onerror=alert(1)> Real supplied synopsis.',
      providerSeries: '<b>Supplied series</b>',
      rights: 'Supplied rights claim',
    });
    await f.ui.resume('Q');
  });
  await page.locator('.gx-archive-title-button').first().click();
  const details = page.locator('#archive-details');
  await expect(details.locator('.gx-archive-detail-artwork')).toHaveAttribute(
    'data-artwork',
    'fallback',
  );
  await expect(details.locator('.gx-archive-detail-artwork')).toHaveAttribute(
    'aria-label',
    'Artwork not available',
  );
  await expect(details.locator('.gx-archive-detail-title')).toHaveText('Title 1');
  await expect(details.locator('.gx-archive-metadata')).toHaveText(
    'Video · Source year 1972 · 2 videos',
  );
  await expect(details.locator('.gx-archive-synopsis')).toHaveText(
    '<img src=x onerror=alert(1)> Real supplied synopsis.',
  );
  await expect(details.locator('img')).toHaveCount(0);
  await expect(details.locator('.gx-archive-files,.gx-archive-videos-heading')).toHaveCount(0);
  const inline = page.locator('.gx-archive-inline-videos:not([hidden])');
  await expect(inline.locator('.gx-archive-videos-heading')).toHaveText('Available videos');
  const row = inline.locator('.gx-archive-file-row').first();
  const geometry = await row.evaluate((node) => ({
    height: node.getBoundingClientRect().height,
    overflow: node.scrollWidth > node.clientWidth + 1,
    play: node.querySelector('button')!.getBoundingClientRect().height,
    more: node.querySelector('summary')!.getBoundingClientRect().height,
    name: node.querySelector('.gx-archive-file-name')!.textContent,
    children: [...node.children].map((child) => child.className),
  }));
  expect(geometry.height).toBeGreaterThanOrEqual(56);
  expect(geometry.height).toBeLessThanOrEqual(76);
  expect(geometry).toMatchObject({
    overflow: false,
    name: 'Video 1',
    children: ['gx-archive-file-copy', 'gx-archive-file-button', 'gx-archive-file-details'],
  });
  expect(geometry.play).toBeGreaterThanOrEqual(44);
  expect(geometry.more).toBeGreaterThanOrEqual(44);
  await expect(row.locator('.gx-archive-file-button')).toHaveText('Play');
  await expect(row.locator('.gx-archive-file-metadata')).toHaveText('2:00');
  await expect(row.locator('.gx-archive-file-details')).not.toHaveAttribute('open');
  await expect(row.locator('.gx-archive-file-details p').first()).toBeHidden();
  await details.getByText('More info', { exact: true }).click();
  await expect(details.locator('.gx-archive-title-info')).toContainText(
    'Original release year: Unknown',
  );
  await expect(details.locator('.gx-archive-full-synopsis')).toHaveText(
    '<img src=x onerror=alert(1)> Real supplied synopsis.',
  );
  await expect(details.locator('.gx-archive-series')).toHaveText(
    'Provider series: <b>Supplied series</b>',
  );
  await expect(details.locator('.gx-archive-rights')).toHaveText(
    'Uploader rights statement: Supplied rights claim',
  );
  await details.locator('.gx-archive-detail-favorite').click();
  await expect(details.locator('.gx-archive-detail-favorite')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(
    page.locator('.gx-archive-result-row').first().locator('.gx-archive-favorite'),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(details.locator('.gx-archive-detail-title')).toHaveText('Title 1');
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        selections: f.selections,
        discovery: f.discoveryCalls,
        revision: f.fileRequests.at(-1).expectedRevision,
      };
    }),
  ).toEqual({ selections: [], discovery: 0, revision: '2' });
  await inline.getByRole('button', { name: 'Play Video 2' }).click();
  await expect
    .poll(() =>
      page.evaluate(
        () => Reflect.get(window, 'archiveFixture').selectionRequests.at(-1)?.expectedRevision,
      ),
    )
    .toBe('2');
});

test('resolved artwork uses validated data only and shares the bounded cache between row and hero', async ({
  page,
}) => {
  await mount(page, 1, false, 'valid');
  await expect(page.locator('.gx-archive-result-artwork[data-artwork="resolved"]')).toHaveCount(2);
  await page.locator('.gx-archive-title-button').first().click();
  const hero = page.locator('.gx-archive-detail-artwork');
  await expect(hero).toHaveAttribute('data-artwork', 'resolved');
  expect(
    await hero.locator('img').evaluate((image: HTMLImageElement) => ({
      inline: image.src.startsWith('data:image/png;base64,'),
      width: image.naturalWidth,
      height: image.naturalHeight,
    })),
  ).toEqual({ inline: true, width: 1, height: 1 });
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        requests: f.artworkRequests.length,
        selections: f.selections,
        discovery: f.discoveryCalls,
      };
    }),
  ).toEqual({ requests: 2, selections: [], discovery: 0 });
  expect(
    await page.evaluate(() => Reflect.get(window, 'archiveFixture').maxArtworkActive),
  ).toBeLessThanOrEqual(2);
});

test('scrolling beyond eight distinct images releases old row bindings and keeps the selected hero within the shared budget', async ({
  page,
}) => {
  await mount(page, 1, false, 'valid');
  await savedTitles(page, 30);
  await page.locator('.gx-archive-title-button').first().click();
  const hero = page.locator('.gx-archive-detail-artwork');
  await expect(hero).toHaveAttribute('data-artwork', 'resolved');
  const firstKey = await page
    .locator('.gx-archive-title-button')
    .first()
    .getAttribute('data-archive-ref');
  const list = page.locator('.gx-archive-results');
  for (let index = 0; index < 3; index++) {
    const before = await page.evaluate(
      () => Reflect.get(window, 'archiveFixture').artworkRequests.length,
    );
    await list.hover();
    await page.mouse.wheel(0, 360);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').artworkRequests.length))
      .toBeGreaterThan(before);
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').artworkActive))
      .toBe(0);
  }
  await expect(page.locator('.gx-archive-result-artwork').first().locator('img')).toHaveCount(0);
  await expect(hero).toHaveAttribute('data-artwork', 'resolved');
  const resources = await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    return {
      snapshot: f.ui.artworkSnapshot(),
      distinct: new Set(f.artworkRequests.map((request: ArchiveArtworkRequest) => request.titleRef))
        .size,
      imageBindings: document.querySelectorAll(
        '.gx-archive-result-artwork img,.gx-archive-detail-artwork img',
      ).length,
    };
  });
  expect(resources.distinct).toBeGreaterThan(8);
  expect(resources.snapshot.retainedImageBound).toBeLessThanOrEqual(8);
  expect(resources.snapshot.retainedCompressedByteBound).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(resources.snapshot.active).toBeLessThanOrEqual(2);
  expect(resources.snapshot.offscreenRowBindings).toBe(0);
  expect(
    resources.snapshot.cacheKeys.some((key: { titleRef: string }) => key.titleRef === firstKey),
  ).toBe(true);
  expect(resources.imageBindings).toBeLessThanOrEqual(8);
  await page.evaluate(() => {
    Reflect.get(window, 'archiveFixture').artworkMode = 'hold';
  });
  await list.hover();
  await page.mouse.wheel(0, 360);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').artworkActive))
    .toBe(2);
  const inFlight = await page.evaluate(() =>
    Reflect.get(window, 'archiveFixture').ui.artworkSnapshot(),
  );
  expect(inFlight.retainedImageBound).toBeLessThanOrEqual(8);
  expect(inFlight.retainedCompressedByteBound).toBeLessThanOrEqual(4 * 1024 * 1024);
  expect(inFlight.cacheEntries).toBeLessThanOrEqual(6);
  expect(inFlight.cacheKeys.some((key: { titleRef: string }) => key.titleRef === firstKey)).toBe(
    true,
  );
  await test.info().attach('artwork-resources', {
    body: JSON.stringify({ ...resources, inFlight }, null, 2),
    contentType: 'application/json',
  });
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.artworkMode = 'valid';
    f.artworkReleases.forEach((release: () => void) => release());
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').artworkActive))
    .toBe(0);
  await page.evaluate(async () => {
    await Reflect.get(window, 'archiveFixture').ui.dispose();
  });
  expect(
    await page.evaluate(() => Reflect.get(window, 'archiveFixture').ui.artworkSnapshot()),
  ).toMatchObject({ cacheEntries: 0, compressedBytes: 0, active: 0, queued: 0, bindings: 0 });
});

test('artwork with an external URL is rejected and retains a truthful fallback', async ({
  page,
}) => {
  await mount(page, 1, false, 'invalid');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').artworkRequests.length))
    .toBe(2);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').artworkActive))
    .toBe(0);
  await expect(page.locator('.gx-archive-result-artwork img')).toHaveCount(0);
  await expect(page.locator('.gx-archive-result-artwork[data-artwork="fallback"]')).toHaveCount(2);
});

test('changing language aborts and joins original artwork reads before a fresh query and cannot bind late images', async ({
  page,
}) => {
  await mount(page, 1, false, 'hold');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').artworkRequests.length))
    .toBe(2);
  await page.evaluate(() => {
    Reflect.get(window, 'archiveFixture').artworkMode = 'absent';
  });
  await page.getByText('Filters', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Browse video languages' }).selectOption('english');
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        queries: f.queryCalls,
        active: f.artworkActive,
        aborted: f.artworkSignals.slice(0, 2).every((signal: AbortSignal) => signal.aborted),
      };
    }),
  ).toEqual({ queries: 1, active: 2, aborted: true });
  await page.evaluate(() => {
    Reflect.get(window, 'archiveFixture').artworkReleases.forEach((release: () => void) =>
      release(),
    );
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').queryCalls))
    .toBe(2);
  await expect(page.locator('.gx-archive-result-row')).toHaveCount(2);
  await expect(page.locator('.gx-archive-result-artwork img')).toHaveCount(0);
  expect(
    await page.evaluate(() => Reflect.get(window, 'archiveFixture').maxArtworkActive),
  ).toBeLessThanOrEqual(2);
});

test('disposal joins the original artwork owners before removing the library', async ({ page }) => {
  await mount(page, 1, false, 'hold');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').artworkRequests.length))
    .toBe(2);
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.disposed = false;
    void f.ui.dispose().then(() => {
      f.disposed = true;
    });
  });
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        disposed: f.disposed,
        active: f.artworkActive,
        aborted: f.artworkSignals.every((signal: AbortSignal) => signal.aborted),
      };
    }),
  ).toEqual({ disposed: false, active: 2, aborted: true });
  await page.evaluate(() => {
    Reflect.get(window, 'archiveFixture').artworkReleases.forEach((release: () => void) =>
      release(),
    );
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').disposed))
    .toBe(true);
  await expect(page.locator('.gx-archive-search')).toHaveCount(0);
});

test('content type scope is forwarded to saved titles, pending suggestions and the captured explicit discovery view', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const f = Reflect.get(window, 'archiveFixture');
    f.contentType = 'movie';
    await f.ui.query('Q');
    await f.ui.searchOnline();
  });
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        query: f.queryRequests.at(-1).contentType,
        pending: f.pendingRequests.at(-1).contentType,
        view: f.discoveryViews.at(-1).contentType,
        selections: f.selections,
      };
    }),
  ).toEqual({ query: 'movie', pending: 'movie', view: 'movie', selections: [] });
});

test('scrolling appends one bounded saved page without changing selected details or playback', async ({
  page,
}) => {
  await mount(page);
  await savedTitles(page, 120);
  await expect(page.locator('.gx-archive-result-row')).toHaveCount(50);
  const footer = page.locator('.gx-archive-result-footer');
  await expect(footer).toHaveText('50 of 120 loaded');
  await expect(footer.locator('button')).toHaveCount(0);
  await page.locator('.gx-archive-title-button').first().click();
  await page.getByRole('button', { name: 'Play Video 1' }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').selections.length))
    .toBe(1);
  await page.getByText('More info', { exact: true }).click();
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.playbackActive = true;
    f.ui.syncDetails();
    f.detailsBeforeAppend = f.details.firstElementChild;
    f.fileRefBeforeAppend = f.container.querySelector('.gx-archive-file-button').dataset.archiveRef;
  });
  const list = page.locator('.gx-archive-results');
  await list.hover();
  await page.mouse.wheel(0, 10000);
  await expect(page.locator('.gx-archive-result-row')).toHaveCount(100);
  await expect(footer).toHaveText('100 of 120 loaded');
  expect(await list.evaluate((node) => node.scrollTop)).toBeGreaterThan(2500);
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        sameDetails: f.detailsBeforeAppend === f.details.firstElementChild,
        samePlay:
          f.fileRefBeforeAppend ===
          f.container.querySelector('.gx-archive-file-button').dataset.archiveRef,
        aboutOpen: f.details.querySelector('.gx-archive-title-info').open,
        selections: f.selections,
        discovery: f.discoveryCalls,
        query: f.input.value,
        calls: f.queryRequests.map((request: ArchiveQuery) => ({
          offset: request.offset,
          pageSize: request.pageSize,
          expectedRevision: request.expectedRevision,
        })),
      };
    }),
  ).toEqual({
    sameDetails: true,
    samePlay: true,
    aboutOpen: true,
    selections: ['b'.repeat(64)],
    discovery: 0,
    query: 'Q',
    calls: [
      { offset: 0, pageSize: 50, expectedRevision: null },
      { offset: 0, pageSize: 50, expectedRevision: null },
      { offset: 50, pageSize: 50, expectedRevision: '1' },
    ],
  });
  await expect(page.locator('#archive-details')).toHaveAttribute('data-playback-active', 'true');
  await expect(page.locator('.gx-archive-result-row').first()).toHaveAttribute(
    'data-selected',
    'true',
  );
  // The existing known catalog ceiling is not an excuse to read every page eagerly.
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').queryCalls))
    .toBe(3);
  await page.evaluate(async () => {
    const f = Reflect.get(window, 'archiveFixture');
    f.scrollBeforeResume = f.container.querySelector('.gx-archive-results').scrollTop;
    await f.ui.suspend({ preserveSelection: true });
    await f.ui.resume('Q');
  });
  await expect(page.locator('.gx-archive-result-row')).toHaveCount(100);
  await expect(footer).toHaveText('100 of 120 loaded');
  expect(await list.evaluate((node) => node.scrollTop)).toBe(
    await page.evaluate(() => Reflect.get(window, 'archiveFixture').scrollBeforeResume),
  );
});

test('a changed query aborts and joins a held incremental page before rendering its new result', async ({
  page,
}) => {
  await mount(page);
  await savedTitles(page, 120);
  await page.evaluate(() => {
    Reflect.get(window, 'archiveFixture').holdOffset = 50;
  });
  await page.locator('.gx-archive-results').hover();
  await page.mouse.wheel(0, 10000);
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, 'archiveFixture').queryRequests.at(-1).offset),
    )
    .toBe(50);
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.matches = 0;
    f.holdOffset = null;
  });
  await page.locator('input').fill('Replacement');
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return { aborted: f.querySignals.at(-1).aborted, calls: f.queryCalls };
    }),
  ).toEqual({ aborted: true, calls: 3 });
  await releaseFiles(page);
  await expect(page.locator('.gx-archive-result-row')).toHaveCount(0);
  await expect(page.locator('.gx-archive-result-summary')).toHaveText(
    'Results for “Replacement” · 0 saved',
  );
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, 'archiveFixture').queryRequests.at(-1).query),
    )
    .toBe('Replacement');
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return { calls: f.queryCalls, discovery: f.discoveryCalls, selections: f.selections };
    }),
  ).toEqual({ calls: 4, discovery: 0, selections: [] });
});

test('directional browsing reaches the next saved page without title selection or acquisition', async ({
  page,
}) => {
  await mount(page);
  await savedTitles(page, 120);
  await page.locator('input').click();
  await page.keyboard.press('Tab');
  await expect(page.getByText('Filters', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.gx-archive-title-button').first()).toBeFocused();
  for (let index = 0; index < 50; index++) await page.keyboard.press('ArrowDown');
  await expect(page.locator('.gx-archive-title-button').nth(50)).toBeFocused();
  await expect(page.locator('.gx-archive-result-row')).toHaveCount(100);
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return { files: f.fileCalls, discovery: f.discoveryCalls, selections: f.selections };
    }),
  ).toEqual({ files: 0, discovery: 0, selections: [] });
});

test('a saved-page failure retains loaded rows and visible recovery guidance without scroll retries', async ({
  page,
}) => {
  await mount(page);
  await savedTitles(page, 120);
  await page.evaluate(() => {
    Reflect.get(window, 'archiveFixture').queryFailureOffset = 50;
  });
  const list = page.locator('.gx-archive-results');
  await list.hover();
  await page.mouse.wheel(0, 10000);
  await expect(page.locator('.gx-archive-status')).toHaveText(
    'More saved titles could not load. Change the search to retry.',
  );
  await expect(page.locator('.gx-archive-status')).toHaveAttribute('data-passive', 'false');
  await expect(page.locator('.gx-archive-status')).toBeVisible();
  await expect(list).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.gx-archive-result-row')).toHaveCount(50);
  await expect(page.locator('.gx-archive-result-footer')).toHaveText('50 of 120 loaded');
  await page.mouse.wheel(0, -10000);
  await page.mouse.wheel(0, 10000);
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').queryCalls)).toBe(3);
});

test('TV compact rows keep readable type and compact actions while passive guidance leaves room for results', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    document.getElementById('app')!.dataset.deviceKind = 'tv';
  });
  await savedTitles(page, 120);
  const geometry = await page
    .locator('.gx-archive-result-row')
    .first()
    .evaluate((row) => {
      const button = row.querySelector('.gx-archive-title-button')!;
      const favorite = row.querySelector('.gx-archive-favorite')!;
      const list = document.querySelector('.gx-archive-results')!;
      return {
        rowHeight: row.getBoundingClientRect().height,
        titleSize: parseFloat(
          getComputedStyle(row.querySelector('.gx-archive-result-name')!).fontSize,
        ),
        subtitleSize: parseFloat(
          getComputedStyle(row.querySelector('.gx-archive-result-subtitle')!).fontSize,
        ),
        mainHeight: button.getBoundingClientRect().height,
        favoriteWidth: favorite.getBoundingClientRect().width,
        favoriteHeight: favorite.getBoundingClientRect().height,
        listHeight: list.getBoundingClientRect().height,
      };
    });
  expect(geometry.rowHeight).toBeGreaterThanOrEqual(48);
  expect(geometry.rowHeight).toBeLessThanOrEqual(56);
  expect(geometry).toMatchObject({ titleSize: 17, subtitleSize: 13.5 });
  expect(geometry.mainHeight).toBeGreaterThanOrEqual(44);
  expect(geometry.favoriteWidth).toBeGreaterThanOrEqual(32);
  expect(geometry.favoriteHeight).toBeGreaterThanOrEqual(32);
  expect(geometry.listHeight).toBeGreaterThan(250);
  await expect(page.locator('.gx-archive-status')).toHaveAttribute('data-passive', 'true');
  await expect(page.locator('.gx-archive-result-footer').locator('button')).toHaveCount(0);
  await page.evaluate(() => {
    Reflect.get(window, 'archiveFixture').matches = 0;
  });
  await page.locator('input').fill('No match');
  await expect(page.locator('.gx-archive-status')).toHaveAttribute('data-passive', 'false');
  await expect(page.locator('.gx-archive-status')).toBeVisible();
});

test('pending suggestions stay compact until explicitly opened and retain truthful progress and actions', async ({
  page,
}) => {
  await mount(page);
  const initialHeight = await page
    .locator('.gx-archive-results')
    .evaluate((node) => node.getBoundingClientRect().height);
  await page.evaluate(async () => {
    const f = Reflect.get(window, 'archiveFixture');
    f.pendingTotal = 7;
    f.pendingItems.push({
      titleRef: f.titles[1].titleRef,
      title: 'A real saved suggestion',
      kind: 'tv',
      originalYear: 1972,
      providerFileCount: 100,
      nextOffset: 10,
      availableFileCount: 2,
      complete: false,
      capacityReached: false,
    });
    await f.ui.resume('Q');
  });
  const pending = page.locator('.gx-archive-pending');
  const summary = pending.locator(':scope > summary');
  const content = pending.locator('.gx-archive-pending-content');
  await expect(summary).toHaveText('More to explore · 7 titles');
  await expect(pending).not.toHaveAttribute('open');
  await expect(content).toBeHidden();
  await expect(pending.getByText('Manage title', { exact: true })).toBeHidden();
  const collapsedHeight = await page
    .locator('.gx-archive-results')
    .evaluate((node) => node.getBoundingClientRect().height);
  expect(initialHeight - collapsedHeight).toBeLessThanOrEqual(56);
  await summary.click();
  await expect(content).toBeVisible();
  await expect(content.locator('small')).toHaveText('2 saved · 10/100 listed files checked');
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return { loads: f.loadFileCalls, discovery: f.discoveryCalls, selections: f.selections };
    }),
  ).toEqual({ loads: 0, discovery: 0, selections: [] });
  await pending.getByRole('button', { name: 'Find episodes' }).click();
  await expect(content.locator('small')).toHaveText('3 saved · 15/100 listed files checked');
  await expect(pending).toHaveAttribute('open');
  await expect(summary).toHaveText('More to explore · 7 titles');
  await expect(page.locator('.gx-archive-status')).toHaveText(
    '1 files saved. Choose a title to see its available files.',
  );
  await summary.click();
  await expect(content).toBeHidden();
  await page.keyboard.press('Enter');
  await expect(content).toBeVisible();
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return { loads: f.loadFileCalls, discovery: f.discoveryCalls, selections: f.selections };
    }),
  ).toEqual({ loads: 1, discovery: 0, selections: [] });
});

test('Play labels preserve supplied episode words safely while opaque filenames remain generic', async ({
  page,
}) => {
  await mount(page, 5);
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    const names = [
      '01x01_Night_of_the_Lizard.mp4',
      '1.mp4',
      `${'a'.repeat(64)}.mp4`,
      '0004.mp4',
      '<img_src=x_onerror=alert(1)>.mp4',
    ];
    f.files.forEach((file: { title: string; fileName: string }, index: number) => {
      file.fileName = names[index];
      file.title = index === 1 ? 'The provider’s episode title' : names[index];
    });
  });
  await page.locator('.gx-archive-title-button').first().click();
  const plays = page.locator('.gx-archive-file-button');
  expect(
    await plays.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('aria-label'))),
  ).toEqual([
    'Play 01x01 Night of the Lizard',
    'Play The provider’s episode title',
    'Play Video 3',
    'Play Video 4',
    'Play <img src=x onerror=alert(1)>',
  ]);
  await expect(page.locator('#archive-details img')).toHaveCount(0);
  const evidence = page.locator('.gx-archive-file-details').first();
  const filename = evidence
    .locator('dt')
    .filter({ hasText: /^Filename$/ })
    .locator('+ dd');
  await expect(filename).toBeHidden();
  await evidence.locator('summary').click();
  await expect(filename).toHaveText('01x01_Night_of_the_Lizard.mp4');
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').selections)).toEqual([]);
  await plays.first().click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').selections))
    .toEqual(['b'.repeat(64)]);
});

test('browsing another title during playback changes only the separate details and keeps filters', async ({
  page,
}) => {
  await mount(page);
  await page.locator('.gx-archive-title-button').first().click();
  await expect(page.getByRole('button', { name: 'Play Video 1' })).toBeFocused();
  await page.getByRole('button', { name: 'Play Video 1' }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').selections.length))
    .toBe(1);
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.playbackActive = true;
    f.beforeSync = f.details.firstElementChild;
    f.ui.syncDetails();
  });
  await expect(page.locator('#archive-details')).toHaveAttribute('data-playback-active', 'true');
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return f.beforeSync === f.details.firstElementChild;
    }),
  ).toBe(true);
  await page.locator('.gx-archive-title-button').nth(1).click();
  await expect(page.locator('#archive-details .gx-archive-detail-title')).toHaveText('Title 2');
  await expect(page.getByRole('button', { name: 'Play Video 1' })).toBeEnabled();
  await expect(page.locator('.gx-archive-result-row').nth(1)).toHaveAttribute(
    'data-selected',
    'true',
  );
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        selections: f.selections,
        query: f.input.value,
        options: f.queryRequests.at(-1),
        titleSelected: f.titleSelectedCalls,
      };
    }),
  ).toMatchObject({
    selections: ['b'.repeat(64)],
    query: 'Q',
    options: { languageMode: 'english-first', decade: 1970, favoritesOnly: false },
    titleSelected: 2,
  });
});

test('row arrows retain the same action across rows and details Left returns to selected result without autoplay', async ({
  page,
}) => {
  await mount(page);
  await page.locator('input').click();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Find more', exact: true })).toHaveCount(0);
  await expect(page.getByText('Filters', { exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.locator('.gx-archive-title-button').first()).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.gx-archive-favorite').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.gx-archive-favorite').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.gx-archive-title-button').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('.gx-archive-title-button').first()).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').filesStarted)).toBe(false);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('button', { name: 'Play Video 1' })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.gx-archive-title-button').first()).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').selections)).toEqual([]);
});

test('explicit online search passes the current captured display view without local row selection', async ({
  page,
}) => {
  await mount(page);
  await page.getByText('Filters', { exact: true }).click();
  await page.getByRole('combobox', { name: 'Browse video languages' }).selectOption('english');
  await expect
    .poll(() =>
      page.evaluate(() => Reflect.get(window, 'archiveFixture').queryRequests.at(-1).languageMode),
    )
    .toBe('english');
  await page.evaluate(async () => {
    await Reflect.get(window, 'archiveFixture').ui.searchOnline();
  });
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        views: f.discoveryViews,
        titleSelected: f.titleSelectedCalls,
        selections: f.selections,
      };
    }),
  ).toEqual({
    views: [
      { schemaVersion: 1, languageMode: 'english', favoritesOnly: false, curatedOnly: false },
    ],
    titleSelected: 0,
    selections: [],
  });
});

test('revealing details and keyboard returning preserve the scrolled result window and query', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const f = Reflect.get(window, 'archiveFixture');
    const template = f.titles[0];
    for (let index = 2; index < 32; index++)
      f.titles.push({
        ...template,
        titleRef: index.toString(16).padStart(64, '0'),
        title: `Title ${index + 1}`,
        rank: index + 1,
      });
    f.matches = f.titles.length;
    await f.ui.resume('Q');
    const list = f.container.querySelector('.gx-archive-results');
    list.scrollTop = 500;
    f.container.querySelectorAll('.gx-archive-title-button')[8].addEventListener(
      'click',
      () => {
        f.scrollBeforeDetails = list.scrollTop;
      },
      { once: true, capture: true },
    );
  });
  await page.locator('.gx-archive-title-button').nth(8).click();
  await expect(page.getByRole('button', { name: 'Play Video 1' })).toBeFocused();
  const before = await page.evaluate(
    () => Reflect.get(window, 'archiveFixture').scrollBeforeDetails,
  );
  expect(before).toBeGreaterThan(0);
  expect(await page.locator('.gx-archive-results').evaluate((list) => list.scrollTop)).toBe(before);
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.gx-archive-title-button').nth(8)).toBeFocused();
  expect(await page.locator('.gx-archive-results').evaluate((list) => list.scrollTop)).toBe(before);
  await expect(page.locator('input')).toHaveValue('Q');
  await expect(page.locator('#genxtra-language')).toHaveValue('english-first');
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').selections)).toEqual([]);
});

async function watchAgainWithRemote(page: Page, hold: boolean, count = 1): Promise<void> {
  await mount(page, count);
  await page.evaluate(async (hold) => {
    const f = Reflect.get(window, 'archiveFixture');
    f.selectionError = 'resume-watchagain';
    f.holdSelection = hold;
    const live = document.createElement('button');
    live.id = 'live-tv-button';
    live.textContent = 'Live TV';
    document.body.prepend(live);
    const path = '/src/ui/remote-navigation.ts';
    const { installRemoteNavigation } = await import(path);
    Reflect.set(window, 'resumeRemoteDispose', installRemoteNavigation());
    const originalAdd = document.addEventListener.bind(document),
      originalRemove = document.removeEventListener.bind(document);
    const listeners = new Map<EventListenerOrEventListenerObject, Set<string>>();
    Reflect.set(window, 'selectionInputListeners', listeners);
    document.addEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) => {
      if (['pointerdown', 'keydown', 'wheel'].includes(type)) {
        const types = listeners.get(listener) ?? new Set<string>();
        types.add(type);
        listeners.set(listener, types);
      }
      originalAdd(type, listener, options);
    }) as typeof document.addEventListener;
    document.removeEventListener = ((
      type: string,
      listener: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) => {
      listeners.get(listener)?.delete(type);
      if (!listeners.get(listener)?.size) listeners.delete(listener);
      originalRemove(type, listener, options);
    }) as typeof document.removeEventListener;
  }, hold);
  await page.locator('.gx-archive-title-button').first().click();
  await page.getByRole('button', { name: 'Play Video 1', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Resume this video' })).toBeVisible();
}

test('Resume returns to its active Play while the original native handoff remains pending and repeat OK coalesces', async ({
  page,
}, info) => {
  await watchAgainWithRemote(page, true, 2);
  await page.getByRole('button', { name: 'Watch again', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').selectionReleases.length))
    .toBe(1);
  const play = page.getByRole('button', { name: 'Play Video 1', exact: true });
  await expect(play).toBeFocused();
  await expect(play).toHaveAttribute('aria-busy', 'true');
  await expect(page.getByRole('button', { name: 'Play Video 2', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('pending-handoff-logical-play.png') });
  await page.keyboard.press('Enter');
  expect(
    await page.evaluate(() => Reflect.get(window, 'archiveFixture').selectionRequests.length),
  ).toBe(1);
  await page.evaluate(() => Reflect.get(window, 'archiveFixture').selectionReleases[0]());
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').selections.length))
    .toBe(1);
  await expect(play).toBeFocused();
  await expect(play).toHaveAttribute('aria-busy', 'false');
});

test('actual Watch again plus remote modal owner returns to the same logical Play after its DOM is replaced', async ({
  page,
}, info) => {
  await watchAgainWithRemote(page, false);
  await page.getByRole('button', { name: 'Watch again', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Play Video 1', exact: true })).toBeFocused();
  await expect(page.locator('#live-tv-button')).not.toBeFocused();
  await expect(page.locator('input')).toHaveValue('Q');
  await page.screenshot({ path: info.outputPath('logical-play-restored.png') });
  expect(
    await page.evaluate(() => ({
      selections: Reflect.get(window, 'archiveFixture').selections,
      listeners: Reflect.get(window, 'selectionInputListeners').size,
    })),
  ).toEqual({ selections: ['b'.repeat(64)], listeners: 0 });
});

for (const intent of ['pointer', 'keyboard', 'query'] as const)
  test(`late Watch again handoff preserves later ${intent} browsing focus and removes owned listeners`, async ({
    page,
  }) => {
    await watchAgainWithRemote(page, true);
    await page.getByRole('button', { name: 'Watch again', exact: true }).click();
    await expect
      .poll(() =>
        page.evaluate(() => Reflect.get(window, 'archiveFixture').selectionReleases.length),
      )
      .toBe(1);
    if (intent === 'query') await page.locator('input').fill('New query');
    else if (intent === 'pointer') await page.locator('input').click();
    else {
      await page.locator('#live-tv-button').focus();
      await page.keyboard.press('Tab');
    }
    await expect(page.locator('input')).toBeFocused();
    await page.evaluate(() => Reflect.get(window, 'archiveFixture').selectionReleases[0]());
    await expect
      .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').selections.length))
      .toBe(1);
    await expect(page.locator('input')).toBeFocused();
    await expect(page.locator('input')).toHaveValue(intent === 'query' ? 'New query' : 'Q');
    expect(await page.evaluate(() => Reflect.get(window, 'selectionInputListeners').size)).toBe(0);
  });

test('actual post-Resume failure and cancellation release the input fence with no late focus return', async ({
  page,
}) => {
  await watchAgainWithRemote(page, true);
  await page.getByRole('button', { name: 'Watch again', exact: true }).click();
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.failAfterResume = true;
    f.selectionReleases[0]();
  });
  await expect(page.locator('.gx-archive-status')).toContainText('could not');
  expect(await page.evaluate(() => Reflect.get(window, 'selectionInputListeners').size)).toBe(0);
  await watchAgainWithRemote(page, true);
  await page.getByRole('button', { name: 'Watch again', exact: true }).click();
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    Reflect.set(window, 'resumeDisposal', f.ui.dispose());
  });
  await page.evaluate(() => Reflect.get(window, 'archiveFixture').selectionReleases[0]());
  await page.evaluate(() => Reflect.get(window, 'resumeDisposal'));
  await expect(page.locator('.gx-archive-search')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'selectionInputListeners').size)).toBe(0);
});

test('Resume Cancel with a live selection signal shows neutral guidance and leaves Play available', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    Reflect.get(window, 'archiveFixture').selectionError = 'resume-cancel';
  });
  await page.locator('.gx-archive-title-button').first().click();
  const play = page.getByRole('button', { name: 'Play Video 1' });
  await play.click();
  await expect(page.locator('.archive-resume-dialog')).toBeVisible();
  await page.locator('.archive-resume-dialog [data-resume-choice="cancel"]').click();
  await expect(page.locator('.archive-resume-dialog')).toHaveCount(0);
  await expect(page.locator('.gx-archive-status')).toHaveText(
    'Playback canceled. Choose a video when ready.',
  );
  await expect(play).toBeEnabled();
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        aborted: f.selectionSignals[0].aborted,
        selections: f.selections,
        discovery: f.discoveryCalls,
      };
    }),
  ).toEqual({ aborted: false, selections: [], discovery: 0 });
});

for (const [outcome, guidance] of [
  ['failure', 'This Archive file could not open. Choose another file or retry.'],
  ['cleanup', 'Archive playback could not stop. Retry Stop before choosing another item.'],
] as const) {
  test(`actual ${outcome} after Play retains actionable failure guidance`, async ({ page }) => {
    await mount(page);
    await page.evaluate((error) => {
      Reflect.get(window, 'archiveFixture').selectionError = error;
    }, outcome);
    await page.locator('.gx-archive-title-button').first().click();
    await page.getByRole('button', { name: 'Play Video 1' }).click();
    await expect(page.locator('.gx-archive-status')).toHaveText(guidance);
    expect(
      await page.evaluate(() => {
        const f = Reflect.get(window, 'archiveFixture');
        return {
          aborted: f.selectionSignals[0].aborted,
          selections: f.selections,
          discovery: f.discoveryCalls,
        };
      }),
    ).toEqual({ aborted: false, selections: [], discovery: 0 });
  });
}

test('legacy result cards expose unknown language and an explicit video choice', async ({
  page,
}) => {
  await mount(page);
  await expect(page.locator('.gx-archive-results .gx-archive-context')).toHaveCount(0);
  await expect(page.locator('.gx-archive-result-name').first()).toHaveText('Title 1');
  await expect(page.locator('.gx-archive-result-subtitle').first()).toHaveText('TV show · 1 video');
  await page.locator('.gx-archive-title-button').first().click();
  await expect(page.getByRole('button', { name: 'Play Video 1' })).toBeFocused();
  await page.getByText('More info', { exact: true }).click();
  await expect(page.locator('.gx-archive-title-info')).toContainText(
    'Original release year: Unknown',
  );
  await expect(page.locator('.gx-archive-context').first()).toHaveText('Language not listed');
  await page.screenshot({
    path: 'artifacts/archive-bookmarks/2026-10-14/result-card-source-fixture.png',
  });
});

test('provider language and subjects distinguish a result before Play', async ({ page }) => {
  await mount(page);
  await page.evaluate(async () => {
    const fixture = Reflect.get(window, 'archiveFixture');
    Object.assign(fixture.titles[0], {
      providerLanguages: ['spa'],
      languageProvenance: 'provider-item',
      providerSubjects: ['Comedy', 'Television'],
      providerDescription: 'A dubbed television episode.',
      matchBasis: 'series',
    });
    await fixture.ui.resume('Q');
  });
  await page.locator('.gx-archive-title-button').first().click();
  await page.getByText('More info', { exact: true }).click();
  await expect(page.locator('.gx-archive-context').first()).toHaveText(
    'Language listed: Spanish · Series match',
  );
  await expect(page.locator('.gx-archive-subjects').first()).toHaveText('Comedy · Television');
  await expect(page.locator('.gx-archive-synopsis').first()).toHaveText(
    'A dubbed television episode.',
  );
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').selections.length)).toBe(
    0,
  );
});

test('held actual file reply preserves a later user favorite focus', async ({ page }) => {
  await mount(page, 1, true);
  await page.locator('.gx-archive-title-button').first().click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').filesStarted))
    .toBe(true);
  await page.keyboard.press('ArrowRight');
  const favorite = page.locator('.gx-archive-favorite').first();
  await expect(favorite).toBeFocused();
  await releaseFiles(page);
  await expect(page.locator('.gx-archive-file-button')).toHaveCount(1);
  await expect(favorite).toBeFocused();
});

test('superseded held file producer joins before new query and cannot publish or steal focus', async ({
  page,
}) => {
  await mount(page, 1, true);
  await page.locator('.gx-archive-title-button').first().click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').filesStarted))
    .toBe(true);
  await page.locator('input').fill('New query');
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').signals[0].aborted)).toBe(
    true,
  );
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').queryCalls)).toBe(1);
  await releaseFiles(page);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').queryCalls))
    .toBe(2);
  await expect(page.locator('.gx-archive-file-button')).toHaveCount(0);
  await expect(page.locator('input')).toBeFocused();
});

test('bounded empty partial and waiting outcomes continue only through another explicit Search', async ({
  page,
}) => {
  await mount(page);
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').discoveryCalls)).toBe(0);
  await page.evaluate(async () => {
    const f = Reflect.get(window, 'archiveFixture');
    f.matches = 0;
    await f.ui.query('');
    f.input.value = '';
    await f.ui.searchOnline();
  });
  await expect(page.locator('.gx-archive-status')).toHaveText(
    'No matching saved videos yet. Search again to continue.',
  );
  await expect(page.getByRole('button', { name: 'Find more', exact: true })).toHaveCount(0);
  await page.evaluate(async () => {
    const f = Reflect.get(window, 'archiveFixture');
    f.outcome = 'waiting';
    // A second Search owns continuation; typing/scrolling never auto-retries online.
  });
  await page.evaluate(() => Reflect.get(window, 'archiveFixture').ui.searchOnline());
  await expect(page.locator('.gx-archive-status')).toHaveText('Search paused. Try Search later.');
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').discoveryCalls)).toBe(2);
});

for (const query of ['', 'Saved query']) {
  for (const microphone of [false, true]) {
    test(`actual main GenXtra search row preserves remote actions and editing query=${Boolean(query)} microphone=${microphone}`, async ({
      page,
    }) => {
      await page.goto('/');
      await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
      await page.locator('#genxtra-button').click();
      await page.locator('#search').fill(query);
      await page.evaluate((microphone) => {
        document.querySelector<HTMLElement>('#app')!.dataset.deviceKind = 'tv';
        document.querySelector<HTMLButtonElement>('.speech-search-button')!.hidden = !microphone;
        const actions: string[] = [];
        const focusModes: { readOnly: boolean; inputMode: string }[] = [];
        Reflect.set(window, 'searchRowActions', actions);
        Reflect.set(window, 'searchRowFocusModes', focusModes);
        const search = document.querySelector<HTMLInputElement>('#search')!;
        search.addEventListener('focus', () =>
          focusModes.push({ readOnly: search.readOnly, inputMode: search.inputMode }),
        );
        for (const button of document.querySelectorAll<HTMLButtonElement>(
          '.search-controls button,.controls button',
        ))
          button.addEventListener('click', () => actions.push(button.id || button.className));
        document.querySelector<HTMLButtonElement>('#genxtra-button')!.focus();
      }, microphone);
      const search = page.locator('#search');
      const clear = page.locator('#clear-search');
      const voice = page.locator('.speech-search-button');
      const dock = page.locator('#mute-button');
      await page.keyboard.press('ArrowDown');
      await expect(search).toBeFocused();
      await expect(search).toHaveAttribute('readonly', '');
      await page.keyboard.press('ArrowRight');
      await expect(query ? clear : microphone ? voice : dock).toBeFocused();
      if (query) {
        await page.keyboard.press('ArrowRight');
        await expect(microphone ? voice : dock).toBeFocused();
      }
      if (microphone) {
        await page.keyboard.press('ArrowLeft');
        await expect(query ? clear : search).toBeFocused();
        await page.keyboard.press('ArrowRight');
        await expect(voice).toBeFocused();
        await page.keyboard.press('ArrowRight');
        await expect(dock).toBeFocused();
      }
      await expect(search).toHaveValue(query);
      expect(await page.evaluate(() => Reflect.get(window, 'searchRowActions'))).toEqual([]);

      // Return through the real region route, then explicitly activate native editing.
      await page.keyboard.press('ArrowUp');
      await expect(page.locator('#genxtra-button')).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('Enter');
      await expect(search).not.toHaveAttribute('readonly');
      await page.keyboard.press('End');
      await page.keyboard.press('ArrowLeft');
      await expect(search).toBeFocused();
      await page.keyboard.type('x');
      await expect(search).toHaveValue(query ? 'Saved querxy' : 'x');
      await page.keyboard.press('Escape');
      await expect(search).toHaveAttribute('readonly', '');
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('#search-programs')).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(search).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(clear).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(search).toHaveValue('');
      await expect(search).toBeFocused();
      // Suppress the native editor before focus, rather than after IME admission.
      expect(await page.evaluate(() => Reflect.get(window, 'searchRowFocusModes').at(-1))).toEqual({
        readOnly: true,
        inputMode: 'none',
      });
      await expect(search).toHaveAttribute('readonly', '');
      await expect(clear).toBeHidden();
      await page.keyboard.press('ArrowDown');
      await expect(page.locator('#genxtra-kind-select')).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await expect(search).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('#search-programs')).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(search).toBeFocused();
      await page.keyboard.press('Enter');
      await expect(search).not.toHaveAttribute('readonly');
      await page.keyboard.type('next');
      await expect(search).toHaveValue('next');
      await expect(page.locator('#app')).toHaveAttribute('data-content-library', 'genxtra');
      await expect(page.locator('#playback-status')).toHaveText('Ready when you are');
      expect(await page.evaluate(() => Reflect.get(window, 'searchRowActions'))).toEqual([
        'clear-search',
      ]);
      expect(
        await page.locator('video').evaluate((video) => (video as HTMLVideoElement).currentSrc),
      ).toBe('');
    });
  }
}

for (const library of ['live', 'genxtra'] as const) {
  test(`actual main Clear preserves ${library === 'live' ? 'TV Live list destination' : 'personal GenXtra text editing'}`, async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    if (library === 'genxtra') await page.locator('#genxtra-button').click();
    await page.evaluate((library) => {
      document.querySelector<HTMLElement>('#app')!.dataset.deviceKind =
        library === 'live' ? 'tv' : 'desktop';
    }, library);
    await page.locator('#search').fill('Clear this query');
    await page.locator('#clear-search').click();
    await expect(page.locator('#search')).toHaveValue('');
    await expect(page.locator('#clear-search')).toBeHidden();
    await expect(page.locator(library === 'live' ? '#channel-list' : '#search')).toBeFocused();
    await expect(page.locator('#search')).not.toHaveAttribute('readonly');
    await expect(page.locator('#app')).toHaveAttribute('data-content-library', library);
    if (library === 'genxtra') {
      await page.keyboard.type('Native text');
      await expect(page.locator('#search')).toHaveValue('Native text');
    }
    await expect(page.locator('#playback-status')).toHaveText('Ready when you are');
  });
}

for (const seek of ['enabled', 'forward-disabled', 'disabled', 'hidden'] as const) {
  test(`actual main TV GenXtra dock leaves only at the first eligible playback control seek=${seek}`, async ({
    page,
  }) => {
    await page.goto('/');
    await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
    await page.locator('#genxtra-button').click();
    await page.evaluate((seek) => {
      // Isolate navigation with the actual main handlers and production dock.
      // These capability flags do not claim a native decoder or active session.
      const app = document.querySelector<HTMLElement>('#app')!;
      app.dataset.deviceKind = 'tv';
      app.dataset.playMode = 'on-demand';
      document.querySelector<HTMLElement>('#vod-transport')!.hidden = seek === 'hidden';
      document.querySelector<HTMLButtonElement>('#vod-rewind')!.disabled = seek === 'disabled';
      document.querySelector<HTMLButtonElement>('#vod-forward')!.disabled =
        seek === 'disabled' || seek === 'forward-disabled';
      document.querySelector<HTMLButtonElement>('#pause-button')!.disabled = false;
      const actions: string[] = [];
      Reflect.set(window, 'dockNavigationActions', actions);
      for (const button of document.querySelectorAll<HTMLButtonElement>('.dock button'))
        button.addEventListener('click', () => actions.push(button.id));
      document.querySelector<HTMLButtonElement>('#pause-button')!.focus();
    }, seek);
    const pane = page.locator('.gx-archive-filter-toggle');
    const pause = page.locator('#pause-button');
    await expect(pause).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    if (seek === 'enabled') {
      await expect(page.locator('#vod-forward')).toBeFocused();
      await page.keyboard.press('ArrowRight');
      await expect(pause).toBeFocused();
      await page.keyboard.press('ArrowLeft');
      await expect(page.locator('#vod-forward')).toBeFocused();
      await page.keyboard.press('ArrowLeft');
    }
    if (seek === 'enabled' || seek === 'forward-disabled') {
      await expect(page.locator('#vod-rewind')).toBeFocused();
      await page.keyboard.press('ArrowLeft');
    }
    await expect(pane).toBeFocused();
    expect(await page.evaluate(() => Reflect.get(window, 'dockNavigationActions'))).toEqual([]);
    expect(
      await page.locator('video').evaluate((video) => (video as HTMLVideoElement).currentSrc),
    ).toBe('');
    await expect(page.locator('#app')).toHaveAttribute('data-content-library', 'genxtra');
  });
}

test('actual main TV dropdown routing reaches both selectors and toolbar while open menus consume arrows', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#genxtra-button').click();
  await page.locator('#search').fill('Q');
  await page.evaluate(async () => {
    document.querySelector<HTMLElement>('#app')!.dataset.deviceKind = 'tv';
    const modulePath = '/src/ui/in-app-select.ts';
    const { installInAppSelects } = await import(modulePath);
    Reflect.set(window, 'tvSelectFixtureOwner', installInAppSelects(document.body));
    document.querySelector<HTMLButtonElement>('#genxtra-button')!.focus();
  });
  const kind = page.locator('.in-app-select[data-native-select-id="genxtra-kind-select"] > button');
  const decade = page.locator(
    '.in-app-select[data-native-select-id="genxtra-decade-select"] > button',
  );
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#search')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(kind).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(decade).toBeFocused();
  await page.keyboard.press('ArrowDown');
  // Browser-only startup has no native catalog; Filters is the visible toolbar entry.
  await expect(page.locator('.gx-archive-filter-toggle')).toBeFocused();
  await decade.focus();
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#search')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(kind).toBeFocused();
  await page.keyboard.press('Enter');
  const menu = page.locator('.in-app-select-menu');
  const initial = menu.locator('[role="option"][aria-selected="true"]');
  await expect(initial).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(initial).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.locator('[role="option"]').nth(1)).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(kind).toBeFocused();
  await expect(page.locator('#app')).toHaveAttribute('data-content-library', 'genxtra');
  await expect(page.locator('#search')).toHaveValue('Q');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('#search')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#clear-search')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.speech-search-button')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#mute-button')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#expand-button')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#mute-button')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('.gx-archive-filter-toggle')).toBeFocused();
  await page.evaluate(() => Reflect.get(window, 'tvSelectFixtureOwner').dispose());
});

test('actual main status retains optional counters and immediately hides previous-query progress', async ({
  page,
}) => {
  // The archive status renderer lives in the library controller (moved out of main.ts).
  await page.route('**/src/application/library-controller.ts*', async (route) => {
    const response = await route.fetch();
    const code = await response.text();
    const marker = 'const archiveDiscovery = createArchiveDiscovery({';
    expect(code).toContain(marker);
    await route.fulfill({
      response,
      body: code.replace(
        marker,
        'Reflect.set(window, "renderArchiveStatusFixture", renderArchiveDiscovery);\n' + marker,
      ),
    });
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await page.locator('#genxtra-button').click();
  await expect(page.locator('#app')).toHaveAttribute('data-content-library', 'genxtra');
  await page.locator('#search').fill('Q');
  await page.evaluate(() => {
    const snapshot = {
      state: 'discovering',
      generation: 1,
      query: 'Q',
      decade: null,
      year: null,
      page: 2,
      revision: '1',
      examined: 40,
      admitted: 7,
      excludedUnknownYear: 8,
      unavailable: 3,
      transientFailures: 2,
      confirmedDead: 0,
      titleCount: 1400,
      yearsChecked: 0,
      yearsTotal: 0,
      yearsComplete: 0,
      yearsPending: 0,
      capacityReached: false,
      retryAfterMs: null,
      message: 'private provider text',
      pendingFilePages: [],
    };
    Reflect.set(window, 'statusFixtureSnapshot', snapshot);
    Reflect.get(window, 'renderArchiveStatusFixture')(snapshot);
  });
  const status = page.locator('#genxtra-discovery-progress');
  await expect(status).toHaveText('Checking… 40 items checked.');
  await expect(status).toHaveAttribute('data-discovery-details', /Admitted candidates: 7/);
  await page.locator('#search').fill('New query');
  await expect(status).toBeHidden();
  await page.evaluate(() =>
    Reflect.get(window, 'renderArchiveStatusFixture')(Reflect.get(window, 'statusFixtureSnapshot')),
  );
  await expect(status).toBeHidden();
});

test('one explicit Search looks up local rows first and repeats the exact scope as bounded continuation', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(async () => {
    const f = Reflect.get(window, 'archiveFixture');
    f.input.value = 'fresh phrase';
    await f.ui.query(f.input.value);
  });
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').discoveryCalls)).toBe(0);
  await page.evaluate(() => Reflect.get(window, 'archiveFixture').ui.searchOnline());
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return { query: f.queryRequests.at(-1).query, intents: f.discoveryIntents };
    }),
  ).toEqual({ query: 'fresh phrase', intents: ['search'] });
  await expect(page.locator('.gx-archive-result-summary')).toContainText('60 checked');
  await page.evaluate(() => Reflect.get(window, 'archiveFixture').ui.searchOnline());
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').discoveryIntents)).toEqual(
    ['search', 'continue'],
  );
  await page.evaluate(async () => {
    const f = Reflect.get(window, 'archiveFixture');
    f.contentType = 'movie';
    await f.ui.searchOnline();
  });
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').discoveryIntents)).toEqual(
    ['search', 'continue', 'search'],
  );
  await expect(page.getByRole('button', { name: 'Find more', exact: true })).toHaveCount(0);
});
test('a changed query during the held local-first Search prevents obsolete online dispatch', async ({
  page,
}) => {
  await mount(page);
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.holdQuery = true;
    Reflect.set(window, 'heldSearch', f.ui.searchOnline());
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').releases.length))
    .toBeGreaterThan(0);
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.input.value = 'new phrase';
    f.holdQuery = false;
    Reflect.set(window, 'newLocal', f.ui.query('new phrase'));
    for (const release of f.releases.splice(0)) release();
  });
  await page.evaluate(async () => {
    await Reflect.get(window, 'heldSearch');
    await Reflect.get(window, 'newLocal');
  });
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').discoveryCalls)).toBe(0);
  await expect(page.locator('input')).toHaveValue('new phrase');
});

test('chosen file caret discloses actual listed facts and unknown identity/audio without adding collapsed-card clutter', async ({
  page,
}) => {
  await mount(page, 2);
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.files[0].fileName = 'Twilight Zone_D1.mp4';
    f.files[0].title = 'Provider file label';
    f.files[0].sizeBytes = '143804114';
    f.files[0].durationSeconds = 1460.52;
    f.files[0].itemId = 'twilight-zone-season-one-DVD';
    f.files[1].durationSeconds = null;
  });
  await page.locator('.gx-archive-title-button').first().click();
  const details = page.locator('.gx-archive-file-details').first();
  await expect(details.locator('.gx-archive-file-facts')).toBeHidden();
  await expect(page.locator('.gx-archive-file-copy').first()).not.toContainText('Audio tracks');
  await details.locator('summary').click();
  const facts = await details
    .locator('.gx-archive-file-facts')
    .evaluate((n) =>
      Object.fromEntries(
        [...n.querySelectorAll('dt')].map((dt) => [
          dt.textContent,
          dt.nextElementSibling?.textContent,
        ]),
      ),
    );
  expect(facts).toMatchObject({
    'Title label': 'Provider file label',
    Filename: 'Twilight Zone_D1.mp4',
    'Listed format': 'H.264',
    'Listed duration': '24:20',
    'Listed size': '137.1 MiB (143,804,114 bytes)',
    'Source item': 'Internet Archive · twilight-zone-season-one-DVD',
    'Episode / edition': 'Not verified',
    Resolution: 'Not yet inspected',
    'Audio tracks': 'Not yet inspected',
  });
  expect(await details.textContent()).not.toMatch(/S1E1|commentary|one audio|HD verified/i);
  await page.locator('.gx-archive-file-details').nth(1).locator('summary').click();
  await expect(page.locator('.gx-archive-file-details').nth(1).locator('dd').nth(3)).toHaveText(
    'Not listed',
  );
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').selections)).toEqual([]);
  await details.locator('summary').click();
  await page.locator('.gx-archive-file-button').first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.gx-archive-file-button').nth(1)).toBeFocused();
});

test('opening a file caret reveals its action inside a short results list without moving focus or starting media', async ({
  page,
}) => {
  await mount(page);
  await page.locator('.gx-archive-title-button').first().click();
  await page.evaluate(() => {
    const container = document.querySelector<HTMLElement>('#genxtra-library')!;
    container.style.height = '240px';
    const details = document.querySelector<HTMLDetailsElement>('.gx-archive-file-details')!;
    // An inert action fixture isolates the real disclosure/scroll owner from
    // transfer I/O; the actual download controls have separate component tests.
    const actions = document.createElement('div'),
      action = document.createElement('button');
    actions.className = 'gx-archive-file-downloads';
    action.textContent = 'Download fixture';
    actions.append(action);
    details.insertBefore(actions, details.querySelector('.gx-archive-file-facts'));
  });
  const summary = page.locator('.gx-archive-file-details > summary').first();
  await summary.click();
  await expect
    .poll(() =>
      page.evaluate(() => {
        const list = document.querySelector<HTMLElement>('.gx-archive-results')!,
          action = document.querySelector<HTMLElement>('.gx-archive-file-downloads button')!,
          summary = document.querySelector<HTMLElement>('.gx-archive-file-details > summary')!;
        const box = action.getBoundingClientRect(),
          clip = list.getBoundingClientRect();
        return {
          actionVisible: box.height > 0 && box.top >= clip.top && box.bottom <= clip.bottom,
          focusRetained: document.activeElement === summary,
          documentTop: document.scrollingElement?.scrollTop ?? 0,
        };
      }),
    )
    .toEqual({ actionVisible: true, focusRetained: true, documentTop: 0 });
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').selections)).toEqual([]);
});

/** Actual mount/query owner is held; no mirrored disabled or fake result DOM. */
async function holdQueryAtCancel(page: Page, matches = 2): Promise<void> {
  await mount(page);
  await page.evaluate((matches) => {
    const f = Reflect.get(window, 'archiveFixture');
    f.holdQuery = true;
    f.matches = matches;
    f.input.style.cssText = 'width:340px;height:44px';
    document.getElementById('app')!.dataset.deviceKind = 'tv';
  }, matches);
  // Real input listener admits the actual local catalog query, leaving acquisition untouched.
  await page.locator('input').fill('Spacecraft');
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').releases.length))
    .toBe(1);
  await page.evaluate(async () => {
    const path = '/src/ui/remote-navigation.ts';
    const { installRemoteNavigation, createRemoteEditMode } = await import(path);
    const editMode = createRemoteEditMode();
    Reflect.set(window, 'queryFocusRemoteDispose', installRemoteNavigation({ editMode }));
    const input = Reflect.get(window, 'archiveFixture').input;
    editMode.navigate(input);
    input.focus();
  });
  // Native Tab reaches the toolbar in this component fixture; its owned Down reaches Cancel.
  await page.keyboard.press('Tab');
  await expect(page.locator('.gx-archive-filter-toggle')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').querySettled)).toBe(1);
}

async function finishHeldLocalQuery(page: Page): Promise<void> {
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.holdQuery = false;
    for (const release of f.releases.splice(0)) release();
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').querySettled))
    .toBe(2);
  await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeHidden();
}

async function noQuerySideEffects(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        query: f.queryCalls,
        files: f.fileCalls,
        discovery: f.discoveryCalls,
        selected: f.selections,
        titlesOpened: f.titleSelectedCalls,
      };
    }),
  ).toEqual({ query: 2, files: 0, discovery: 0, selected: [], titlesOpened: 0 });
}

test('held local query retires focused Cancel into the actual visible title without autoplay', async ({
  page,
}) => {
  await holdQueryAtCancel(page);
  await finishHeldLocalQuery(page);
  const first = page.locator('.gx-archive-title-button').first();
  await expect(first).toBeFocused();
  expect(
    await first.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return (
        node.isConnected &&
        !node.closest('[hidden],[inert]') &&
        r.width > 0 &&
        r.height > 0 &&
        r.top >= 0 &&
        r.bottom <= innerHeight &&
        (hit === node || (!!hit && node.contains(hit)))
      );
    }),
  ).toBe(true);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.gx-archive-favorite').first()).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(first).toBeFocused();
  await noQuerySideEffects(page);
});

test('held empty local query retires focused Cancel to the existing Filters control', async ({
  page,
}) => {
  await holdQueryAtCancel(page, 0);
  await finishHeldLocalQuery(page);
  await expect(page.locator('.gx-archive-title-button')).toHaveCount(0);
  await expect(page.locator('.gx-archive-filter-toggle')).toBeFocused();
  await noQuerySideEffects(page);
});

test('explicit Cancel joins the original held query then keeps local focus reachable', async ({
  page,
}) => {
  await holdQueryAtCancel(page);
  await page.keyboard.press('Enter');
  expect(
    await page.evaluate(() => Reflect.get(window, 'archiveFixture').querySignals[1].aborted),
  ).toBe(true);
  await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeVisible();
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').querySettled)).toBe(1);
  await finishHeldLocalQuery(page);
  await expect(page.locator('.gx-archive-filter-toggle')).toBeFocused();
  await expect(page.locator('.gx-archive-status')).toHaveText('Archive request canceled.');
  await expect(page.locator('.gx-archive-title-button')).toHaveCount(0);
  await noQuerySideEffects(page);
});

for (const destination of ['filters', 'editor', 'modal', 'background', 'inert'] as const) {
  test(`held local query completion preserves later ${destination} focus ownership`, async ({
    page,
  }) => {
    await holdQueryAtCancel(page);
    if (destination === 'filters') {
      await page.locator('.gx-archive-filter-toggle').click();
      await expect(page.locator('.gx-archive-filter-toggle')).toBeFocused();
    } else if (destination === 'editor') {
      // Pointer entry remains personal/native editing; completion cannot reclaim it.
      await page.evaluate(() => {
        const editor = document.createElement('input');
        editor.id = 'later-personal-query-editor';
        document.body.prepend(editor);
      });
      await page.locator('#later-personal-query-editor').click();
      await page.locator('#later-personal-query-editor').fill('Personal query');
    } else {
      await page.evaluate((destination) => {
        const f = Reflect.get(window, 'archiveFixture');
        const button = document.createElement('button');
        button.id = 'later-query-owner';
        button.textContent = 'Later action';
        document.body.prepend(button);
        if (destination === 'modal') {
          const dialog = document.createElement('dialog');
          dialog.id = 'later-query-modal';
          const close = document.createElement('button');
          close.id = 'later-query-modal-close';
          close.textContent = 'Close';
          dialog.append(close);
          document.body.append(dialog);
          button.addEventListener('click', () => dialog.showModal());
        } else if (destination === 'background') {
          button.addEventListener('click', () => {
            Reflect.set(window, 'queryFocusSuspended', false);
            Reflect.set(
              window,
              'queryFocusSuspension',
              f.ui.suspend().then(() => Reflect.set(window, 'queryFocusSuspended', true)),
            );
          });
        } else
          button.addEventListener('click', () => (document.getElementById('app')!.inert = true));
      }, destination);
      await page.locator('#later-query-owner').click();
    }
    if (destination === 'background') {
      expect(await page.evaluate(() => Reflect.get(window, 'queryFocusSuspended'))).toBe(false);
      expect(
        await page.evaluate(() => Reflect.get(window, 'archiveFixture').querySignals[1].aborted),
      ).toBe(true);
    }
    await finishHeldLocalQuery(page);
    if (destination === 'filters')
      await expect(page.locator('.gx-archive-filter-toggle')).toBeFocused();
    else if (destination === 'editor') {
      await expect(page.locator('#later-personal-query-editor')).toBeFocused();
      await expect(page.locator('#later-personal-query-editor')).toHaveValue('Personal query');
      await expect(page.locator('#later-personal-query-editor')).toHaveJSProperty(
        'readOnly',
        false,
      );
    } else if (destination === 'modal')
      await expect(page.locator('#later-query-modal-close')).toBeFocused();
    else await expect(page.locator('#later-query-owner')).toBeFocused();
    if (destination === 'background') {
      await page.evaluate(() => Reflect.get(window, 'queryFocusSuspension'));
      expect(await page.evaluate(() => Reflect.get(window, 'queryFocusSuspended'))).toBe(true);
      await expect(page.locator('.gx-archive-search')).toBeHidden();
    }
    await noQuerySideEffects(page);
  });
}

async function scrollExpandedTitleAbovePane(page: Page): Promise<number> {
  await mount(page, 32);
  await page.locator('.gx-archive-title-button').first().click();
  await expect(page.locator('.gx-archive-file-button')).toHaveCount(32);
  const top = await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.container.style.height = '240px';
    const player = document.createElement('button');
    player.id = 'external-playback-focus';
    player.textContent = 'Playback control';
    document.body.prepend(player);
    const list = document.querySelector<HTMLElement>('.gx-archive-results')!;
    list.scrollTop = 300;
    return list.scrollTop;
  });
  expect(top).toBeGreaterThan(0);
  expect(
    await page
      .locator('.gx-archive-title-button')
      .first()
      .evaluate((title) => {
        const list = title.closest('.gx-archive-results')!;
        return title.getBoundingClientRect().bottom < list.getBoundingClientRect().top;
      }),
  ).toBe(true);
  await page.locator('#external-playback-focus').click();
  return top;
}

test('external focus arrival reveals the selected title inside its owned clip without document jump', async ({
  page,
}, testInfo) => {
  await scrollExpandedTitleAbovePane(page);
  const title = page.locator('.gx-archive-title-button[aria-current="true"]');
  // Actual native focusin arrival, matching preventScroll used by the real main dock route.
  // This isolates the component scroll owner, not a simulated decoder or main handler.
  await title.evaluate((node) => node.focus({ preventScroll: true }));
  await expect(title).toBeFocused();
  expect(
    await title.evaluate((node) => {
      const r = node.getBoundingClientRect();
      const list = node.closest<HTMLElement>('.gx-archive-results')!;
      const clip = list.getBoundingClientRect();
      const top = Math.max(0, clip.top + list.clientTop) + 3;
      const bottom = Math.min(innerHeight, clip.top + list.clientTop + list.clientHeight) - 3;
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return {
        fullyVisible:
          r.top >= top && r.bottom <= bottom && (hit === node || (!!hit && node.contains(hit))),
        documentTop: document.scrollingElement?.scrollTop ?? 0,
        active: document.activeElement === node,
      };
    }),
  ).toEqual({ fullyVisible: true, documentTop: 0, active: true });
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return { discovery: f.discoveryCalls, selections: f.selections, files: f.fileCalls };
    }),
  ).toEqual({ discovery: 0, selections: [], files: 1 });
  await testInfo.attach('owned-title-focus-geometry', {
    body: JSON.stringify(
      await title.evaluate((node) => {
        const list = node.closest<HTMLElement>('.gx-archive-results')!;
        return {
          title: node.getBoundingClientRect().toJSON(),
          clip: list.getBoundingClientRect().toJSON(),
          clientHeight: list.clientHeight,
          scrollTop: list.scrollTop,
          documentTop: document.scrollingElement?.scrollTop ?? 0,
          focused: document.activeElement === node,
        };
      }),
    ),
    contentType: 'application/json',
  });
  await testInfo.attach('owned-title-focus-visible', {
    body: await page.screenshot(),
    contentType: 'image/png',
  });
});

test('manual list scroll survives preserved-details rerender without a new external focus arrival', async ({
  page,
}) => {
  await scrollExpandedTitleAbovePane(page);
  const title = page.locator('.gx-archive-title-button[aria-current="true"]');
  await title.evaluate((node) => node.focus({ preventScroll: true }));
  const before = await page.locator('.gx-archive-results').evaluate((list) => {
    list.scrollTop = 300;
    return list.scrollTop;
  });
  await page.evaluate(() => Reflect.get(window, 'archiveFixture').ui.resume('Q'));
  expect(await page.locator('.gx-archive-results').evaluate((list) => list.scrollTop)).toBe(before);
  await expect(title).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').selections)).toEqual([]);
  expect(await page.evaluate(() => document.scrollingElement?.scrollTop ?? 0)).toBe(0);
});

test('obsolete Cancel cannot hide or move focus from a later same-scope held query', async ({
  page,
}) => {
  await holdQueryAtCancel(page);
  await page.keyboard.press('Enter');
  expect(
    await page.evaluate(() => Reflect.get(window, 'archiveFixture').querySignals[1].aborted),
  ).toBe(true);
  // Actual later input admits a distinct same-scope query, queued behind the canceled original.
  await page.locator('input').click();
  await page.locator('input').fill('Later query');
  await page.keyboard.press('Tab');
  await expect(page.locator('.gx-archive-filter-toggle')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const cancel = page.getByRole('button', { name: 'Cancel request', exact: true });
  await expect(cancel).toBeFocused();
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').queryCalls)).toBe(2);
  await page.evaluate(() => Reflect.get(window, 'archiveFixture').releases.shift()());
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').queryCalls))
    .toBe(3);
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').querySettled))
    .toBe(2);
  expect(await page.evaluate(() => Reflect.get(window, 'archiveFixture').releases.length)).toBe(1);
  // The old cancellation has joined; the new actual query remains held and owns this action.
  await expect(cancel).toBeVisible();
  await expect(cancel).toBeFocused();
  await expect(page.locator('.gx-archive-status')).toHaveText('Filtering saved Archive titles…');
  await page.evaluate(() => {
    const f = Reflect.get(window, 'archiveFixture');
    f.holdQuery = false;
    f.releases.shift()();
  });
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'archiveFixture').querySettled))
    .toBe(3);
  await expect(cancel).toBeHidden();
  await expect(page.locator('.gx-archive-title-button').first()).toBeFocused();
  await expect(page.locator('input')).toHaveValue('Later query');
  expect(
    await page.evaluate(() => {
      const f = Reflect.get(window, 'archiveFixture');
      return {
        files: f.fileCalls,
        discovery: f.discoveryCalls,
        selected: f.selections,
        titlesOpened: f.titleSelectedCalls,
      };
    }),
  ).toEqual({ files: 0, discovery: 0, selected: [], titlesOpened: 0 });
});
