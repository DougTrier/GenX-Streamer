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
 * GenXtra search navigation: held queries, file carets, Cancel and focus.
 */
import { expect, test } from '@playwright/test';
import {
  useArchiveStatusNavigation,
  mount,
  holdQueryAtCancel,
  finishHeldLocalQuery,
  noQuerySideEffects,
  scrollExpandedTitleAbovePane,
} from './archive-status-navigation.fixture';

useArchiveStatusNavigation();

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
