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
 * GenXtra search navigation: title overviews, artwork, language changes and
 * saved pages.
 */
import { expect, test } from '@playwright/test';
import { type ArchiveArtworkRequest, type ArchiveQuery } from '../../src/platform/archive-catalog';
import {
  useArchiveStatusNavigation,
  mount,
  savedTitles,
  releaseFiles,
} from './archive-status-navigation.fixture';

useArchiveStatusNavigation();

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
