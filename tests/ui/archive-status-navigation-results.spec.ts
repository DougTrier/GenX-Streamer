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
 * GenXtra search navigation: result cards, partial outcomes, the main TV
 * dropdown and local search.
 */
import { expect, test } from '@playwright/test';
import {
  useArchiveStatusNavigation,
  mount,
  releaseFiles,
} from './archive-status-navigation.fixture';

useArchiveStatusNavigation();

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
    const modulePath = '/src/ui/shell/in-app-select.ts';
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
  await page.route('**/src/application/genxtra/library-controller.ts*', async (route) => {
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
