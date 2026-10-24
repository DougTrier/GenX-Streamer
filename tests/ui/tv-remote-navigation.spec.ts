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

import { openPlaylistImport } from './helpers/source-scan';
import { saveReviewedSource } from './helpers/source-scan';
import { chooseSettingsSection } from './helpers/settings-section';
import { expect, test, type Page } from '@playwright/test';

const playlist = `#EXTM3U
#EXTINF:-1 tvg-id="news" group-title="News",Remote News
https://media.invalid/news
#EXTINF:-1 tvg-id="sports" group-title="Sports",Remote Sports
https://media.invalid/sports
#EXTINF:-1 tvg-id="film" group-title="Movies",Remote Film
https://media.invalid/film
`;

// Fixture preparation uses the real worker/file import. All subsequent navigation
// uses remote keys; no focus(), click(), Tab or synthetic DOM activation.
async function prepare(page: Page): Promise<void> {
  await openPlaylistImport(page);
  await page.locator('#playlist-file').setInputFiles({
    name: 'remote-fixture.m3u',
    mimeType: 'text/plain',
    buffer: Buffer.from(playlist),
  });
  await saveReviewedSource(page);
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await page.reload();
  await expect(page.locator('.channel')).toHaveCount(3);
}

async function validFocus(page: Page): Promise<void> {
  expect(
    await page.evaluate(() => {
      const node = document.activeElement;
      return (
        node instanceof HTMLElement &&
        node !== document.body &&
        node.isConnected &&
        node.checkVisibility() &&
        !node.matches(':disabled')
      );
    }),
  ).toBe(true);
}

// Seek using observed focus geometry and actual remote presses, with a finite
// budget. A navigation dead end fails rather than falling back to DOM focus.
async function reach(page: Page, selector: string): Promise<void> {
  const visited = new Map<string, number>();
  for (let step = 0; step < 36; step++) {
    if (
      await page
        .locator(selector)
        .evaluate((node) =>
          node.id === 'channel-list'
            ? node.contains(document.activeElement)
            : node === document.activeElement,
        )
    )
      return;
    const next = await page.locator(selector).evaluate((target) => {
      const active = document.activeElement as HTMLElement;
      const a = active.getBoundingClientRect(),
        b = target.getBoundingClientRect();
      const dx = b.x + b.width / 2 - a.x - a.width / 2;
      const dy = b.y + b.height / 2 - a.y - a.height / 2;
      return {
        key: active.id || active.dataset.channel || active.textContent?.trim() || 'none',
        horizontal: dx > 0 ? 'ArrowRight' : 'ArrowLeft',
        vertical: dy > 0 ? 'ArrowDown' : 'ArrowUp',
        horizontalFirst: Math.abs(dx) > Math.abs(dy),
      };
    });
    const repeats = visited.get(next.key) ?? 0;
    visited.set(next.key, repeats + 1);
    const primary = next.horizontalFirst ? next.horizontal : next.vertical;
    const secondary = next.horizontalFirst ? next.vertical : next.horizontal;
    await page.keyboard.press(repeats % 2 ? secondary : primary);
    await validFocus(page);
  }
  await expect(page.locator(selector)).toBeFocused();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.route('https://media.invalid/**', (route) => route.abort());
  await page.goto('/');
  await expect(page.locator('#storage-status')).toContainText('Browser development preview');
});

test('native Back closes a modal then remains on the main screen without exiting', async ({
  page,
}) => {
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await openPlaylistImport(page);
  await expect(page.locator('#import-dialog')).toBeVisible();
  // Install after browser startup: the real bundled handler now takes its native
  // branch, without replacing startup/storage adapters or invoking native Exit.
  await page.evaluate(() => {
    const calls: { command: string; requestId: unknown }[] = [];
    Object.assign(window, {
      isTauri: true,
      __BACK_TEST_CALLS__: calls,
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args?: { requestId?: unknown }) => {
          calls.push({ command, requestId: args?.requestId });
          // Closing the modal can wake independent guide planning. This fixture
          // has no guides; explicitly model the read rather than acquiring data.
          if (command === 'guide_refresh_plan') return { nowMs: Date.now(), sources: [] };
        },
      },
    });
  });
  for (let index = 1; index <= 5; index++) {
    await page.evaluate((requestId) => {
      window.dispatchEvent(new CustomEvent('native-back-requested', { detail: { requestId } }));
    }, `back-${index}`);
    await expect(page.locator('#import-dialog')).not.toBeVisible();
  }
  const calls: { command: string; requestId: unknown }[] = await page.evaluate(() =>
    Reflect.get(window, '__BACK_TEST_CALLS__'),
  );
  expect(
    calls.every(({ command }) => ['acknowledge_back', 'guide_refresh_plan'].includes(command)),
  ).toBe(true);
  expect(calls.filter(({ command }) => command === 'acknowledge_back')).toEqual(
    Array.from({ length: 5 }, (_, index) => ({
      command: 'acknowledge_back',
      requestId: `back-${index + 1}`,
    })),
  );
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  await expect(page.locator('#search-programs')).toBeVisible();
  await expect(page.locator('#settings-button')).toBeFocused();
});

test('first D-pad press seeds visible focus without selecting a channel', async ({ page }) => {
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#search-programs')).toBeFocused();
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await prepare(page);
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('.channel').first()).toBeFocused();
  await expect(page.locator('#watch-title')).toHaveText('Make yourself comfortable.');
});

test('channel list exits horizontally to player controls and returns using remote keys', async ({
  page,
}) => {
  await prepare(page);
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.channel').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-channel-action="manage"]').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('[data-channel-action="favorite"]').nth(1)).toBeFocused();
  await page.keyboard.press('ArrowRight');
  expect(await page.evaluate(() => !!document.activeElement?.closest('#channel-list'))).toBe(false);
  await reach(page, '#mute-button');
  await page.keyboard.press('Enter');
  await expect(page.locator('#mute-button')).toHaveAttribute('aria-pressed', 'true');
  await reach(page, '#channel-list');
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => !!document.activeElement?.closest('#channel-list'))).toBe(true);
});

test('divider preserves resizing but vertical D-pad escapes the separator', async ({ page }) => {
  await prepare(page);
  await page.keyboard.press('ArrowDown');
  await reach(page, '#divider');
  const initial = Number(await page.locator('#divider').getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowRight');
  await expect(page.locator('#divider')).toBeFocused();
  await expect(page.locator('#divider')).toHaveAttribute('aria-valuenow', String(initial + 20));
  await page.keyboard.press('ArrowDown');
  await validFocus(page);
  await expect(page.locator('#divider')).not.toBeFocused();
});

test('modal D-pad stays inside its owner and Escape restores its invoker', async ({ page }) => {
  await page.keyboard.press('ArrowDown');
  await reach(page, '#settings-button');
  await page.keyboard.press('Enter');
  await expect(page.locator('#settings-dialog')).toBeVisible();
  for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'ArrowDown']) {
    await page.keyboard.press(key);
    expect(await page.evaluate(() => document.activeElement?.closest('dialog')?.id)).toBe(
      'settings-dialog',
    );
  }
  await page.keyboard.press('Escape');
  await expect(page.locator('#settings-dialog')).not.toBeVisible();
  await expect(page.locator('#settings-button')).toBeFocused();
});

test('text editing consumes Enter and first Escape, then navigation exits the field', async ({
  page,
}) => {
  await page.keyboard.press('ArrowDown');
  await reach(page, '#settings-button');
  await page.keyboard.press('Enter');
  await reach(page, '#import-button');
  await page.keyboard.press('Enter');
  await expect(page.locator('#import-dialog')).toBeVisible();
  await reach(page, '#playlist-url');
  await page.keyboard.press('Enter');
  await page.keyboard.type('https://example.invalid/channels');
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#playlist-url')).toBeFocused();
  expect(await page.locator('#playlist-url').inputValue()).toBe('https://example.invalid/channels');
  await expect(page.locator('#import-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#import-dialog')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#playlist-url')).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.locator('#settings-button')).toBeFocused();
});

test('filter changes and selected-channel removal retain usable remote focus', async ({ page }) => {
  await prepare(page);
  await page.keyboard.press('ArrowDown');
  // The categories are one list button in the channel row: OK opens it,
  // Down walks All, Movies, News, Sports, OK picks.
  await reach(page, '#category-button');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-filter="all"]')).toBeFocused();
  for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowDown');
  await expect(page.locator('[data-filter="sports"]')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.channel strong')).toHaveText('Remote Sports');
  await expect(page.locator('#category-button')).toBeFocused();
  await expect(page.locator('#category-button')).toContainText('Sports');
  await validFocus(page);
  await reach(page, '.channel');
  await page.keyboard.press('Enter');
  await expect(page.locator('#remove-channel')).toBeEnabled();
  await reach(page, '#remove-channel');
  await page.keyboard.press('Enter');
  await expect(page.locator('.channel')).toHaveCount(0);
  await expect(page.locator('#remove-channel')).toBeDisabled();
  await expect(page.locator('#mute-button')).toBeFocused();
  await validFocus(page);
  await page.keyboard.press('ArrowLeft');
  await validFocus(page);
});

test('remote-opened website autofocus stays navigable and restores the settings invoker', async ({
  page,
}) => {
  let requests = 0;
  await page.route('https://remote-website.invalid/**', (route) => {
    requests++;
    return route.fulfill({ status: 200, contentType: 'text/html', body: '<html></html>' });
  });
  // Prepare the secondary section with pointer/native select. Close before the
  // actual D-pad-only path: reopening must inherit remote modality, not pointer.
  await page.locator('#settings-button').click();
  await chooseSettingsSection(page, 'discovery');
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.keyboard.press('ArrowDown');
  await reach(page, '#settings-button');
  await page.keyboard.press('Enter');
  await expect(page.locator('#settings-dialog')).toBeVisible();
  const trigger = '[data-settings-panel="discovery"] button:has-text("Find sources")';
  await reach(page, trigger);
  await page.keyboard.press('Enter');
  const child = page.getByRole('dialog', { name: 'Find sources on a website', exact: true });
  await expect(child).toBeVisible();
  await expect(child.getByLabel('Website URL', { exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(child.getByLabel('Website URL', { exact: true })).not.toBeFocused();
  expect(
    await page.evaluate(() =>
      document.activeElement?.closest('dialog')?.classList.contains('website-discovery-dialog'),
    ),
  ).toBe(true);
  expect(requests).toBe(0);
  await page.keyboard.press('Escape');
  await expect(child).not.toBeVisible();
  await expect(page.locator('#settings-dialog')).toBeVisible();
  await expect(page.locator(trigger)).toBeFocused();
  expect(requests).toBe(0);
});

test('held remote OK enters text editing once without submitting on repeats', async ({ page }) => {
  let requests = 0;
  await page.route('https://remote-submit.invalid/**', (route) => {
    requests++;
    return route.fulfill({ status: 200, contentType: 'text/plain', body: playlist });
  });
  // A valid retained form value makes accidental submission observable; this is
  // preparation only. Remote movement, not forced focus, reaches the field.
  await openPlaylistImport(page);
  await page.locator('#playlist-url').fill('https://remote-submit.invalid/channels');
  await page.getByRole('button', { name: 'Close import', exact: true }).click();
  await page.keyboard.press('ArrowDown');
  await reach(page, '#settings-button');
  await page.keyboard.press('Enter');
  await reach(page, '#import-button');
  await page.keyboard.press('Enter');
  await reach(page, '#playlist-url');
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.down('Enter');
  await page.keyboard.up('Enter');
  await expect(page.locator('#playlist-url')).toBeFocused();
  await expect(page.locator('#import-dialog')).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#playlist-url')).toBeFocused();
  expect(requests).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#import-dialog')).toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('#playlist-url')).not.toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('#import-dialog')).not.toBeVisible();
  await expect(page.locator('#settings-button')).toBeFocused();
  expect(requests).toBe(0);
});

test('one channel row (Category ▾ | Favs | Loc & Sort | Guide): Down from search reaches it, Back closes the list, Up returns to the search row', async ({
  page,
}) => {
  await prepare(page);
  await page.keyboard.press('ArrowDown');
  await reach(page, '#search');
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.sidehead'))).toBe(true);
  await reach(page, '#category-button');
  // Right walks the row in order.
  for (const selector of [
    '.row-filter[data-filter="favorites"]',
    '.location-trigger',
    '#guide-button',
  ]) {
    await page.keyboard.press('ArrowRight');
    await expect(page.locator(selector)).toBeFocused();
  }
  for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowLeft');
  await expect(page.locator('#category-button')).toBeFocused();
  // The list keeps Up and Down; Escape (Back) closes it on its button.
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-filter="all"]')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.locator('.filters')).toBeHidden();
  await expect(page.locator('#category-button')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  expect(await page.evaluate(() => !!document.activeElement?.closest('#channel-list'))).toBe(true);
  await page.keyboard.press('ArrowUp');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.sidehead'))).toBe(true);
  await page.keyboard.press('ArrowUp');
  expect(await page.evaluate(() => !!document.activeElement?.closest('.search-controls'))).toBe(
    true,
  );
});

test('a focused control that becomes disabled hands focus to its nearest neighbour', async ({
  page,
}) => {
  await prepare(page);
  await page.keyboard.press('ArrowDown');
  await reach(page, '#mute-button');
  // The app disables a running action (for example Find program guides) while it is focused.
  await page.locator('#mute-button').evaluate((button) => {
    (button as HTMLButtonElement).disabled = true;
  });
  await page.keyboard.press('ArrowLeft');
  await validFocus(page);
  expect(await page.evaluate(() => !!document.activeElement?.closest('.dock, .controls'))).toBe(
    true,
  );
});
