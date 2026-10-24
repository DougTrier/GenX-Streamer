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
 * GenXtra search navigation: directional browsing, TV rows, suggestions,
 * details and Resume.
 */
import { expect, test } from '@playwright/test';
import {
  useArchiveStatusNavigation,
  mount,
  savedTitles,
  watchAgainWithRemote,
} from './archive-status-navigation.fixture';

useArchiveStatusNavigation();

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
