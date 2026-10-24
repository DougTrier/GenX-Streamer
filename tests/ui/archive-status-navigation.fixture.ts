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
 * What the GenXtra search navigation specs share: mounting the real search
 * component with a scripted catalog, and helpers. Each
 * archive-status-navigation*.spec.ts file calls useArchiveStatusNavigation() once.
 */
import { expect, test, type Page } from '@playwright/test';
import {
  type ArchiveArtworkRequest,
  type ArchiveFileProgress,
  type ArchiveLanguageMode,
  type ArchiveQuery,
  type ArchiveSelection,
} from '../../src/platform/archive-catalog';

/** Static metadata and deliberately held originals; no upstream URLs or native decoder claims. */
export async function mount(
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
            const playerPath = '/src/application/genxtra/archive-player.ts';
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

export async function releaseFiles(page: Page): Promise<void> {
  await page.evaluate(() =>
    Reflect.get(window, 'archiveFixture').releases.forEach((release: () => void) => release()),
  );
}

export async function savedTitles(page: Page, count: number): Promise<void> {
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

export async function watchAgainWithRemote(page: Page, hold: boolean, count = 1): Promise<void> {
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

/** Actual mount/query owner is held; no mirrored disabled or fake result DOM. */
export async function holdQueryAtCancel(page: Page, matches = 2): Promise<void> {
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

export async function finishHeldLocalQuery(page: Page): Promise<void> {
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

export async function noQuerySideEffects(page: Page): Promise<void> {
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

export async function scrollExpandedTitleAbovePane(page: Page): Promise<number> {
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

/** The hooks every test file of this suite needs; call once at the top of the file. */
export function useArchiveStatusNavigation(): void {
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
}
