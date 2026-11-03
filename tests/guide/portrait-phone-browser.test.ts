/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { expect as browserExpect, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { closePhonePage, preparePhoneFixture } from '../support/phone-surface-fixture';

let fixture: Awaited<ReturnType<typeof preparePhoneFixture>>;
beforeAll(async () => {
  fixture = await preparePhoneFixture();
  await mkdir('artifacts/phone-portrait-testing/core-green', { recursive: true });
});
afterAll(async () => fixture?.close());

async function reportedScope(page: Page) {
  // The saved scope is restored before a field owns focus, as on startup/tab return.
  await page.evaluate(() => {
    const current = Reflect.get(window, 'fixture');
    current.choose('sports');
    current.cb.setSportsFacet({ sport: 'american-football' });
    const search = document.getElementById('search') as HTMLInputElement;
    search.value = 'NFL';
    search.dispatchEvent(new Event('input'));
  });
  await page.locator('#channel-rows .channel').first().waitFor();
}
async function assertTwoCards(page: Page) {
  await browserExpect
    .poll(async () =>
      page.evaluate(() => {
        const list = document.getElementById('channel-list')!;
        const bounds = list.getBoundingClientRect();
        const footer = document.querySelector('.app-signoff')!.getBoundingClientRect();
        const first = [...list.querySelectorAll<HTMLElement>('#channel-rows .channel')].slice(0, 2);
        return (
          first.length === 2 &&
          bounds.bottom <= footer.top + 1 &&
          first.every((row) => {
            const box = row.getBoundingClientRect();
            return box.height > 0 && box.top >= bounds.top && box.bottom <= bounds.bottom;
          })
        );
      }),
    )
    .toBe(true);
}
for (const [width, height] of [
  [360, 640],
  [360, 780],
  [390, 844],
  [412, 915],
]) {
  it(`keeps two real NFL cards available before choosing a channel at ${width}x${height}`, async () => {
    const page = await fixture.mountPage(width, height);
    try {
      await reportedScope(page);
      await browserExpect(page.locator('#app')).toHaveAttribute('data-phone-view', 'browse');
      await browserExpect(page.locator('#app')).not.toHaveClass(/compact-content/);
      await browserExpect(page.locator('#compact-view')).toBeHidden();
      await browserExpect(page.locator('#phone-filter-summary')).toContainText('American Football');
      await browserExpect(page.locator('#phone-filter-summary')).toContainText(
        'Matching PPV included',
      );
      await assertTwoCards(page);
      expect(await page.locator('.view').evaluate((el) => el.getBoundingClientRect().height)).toBe(
        44,
      );
      await page.screenshot({
        path: `artifacts/phone-portrait-testing/core-green/${width}x${height}-restored-nfl.png`,
      });
      await page.evaluate(() => Reflect.get(window, 'fixture').select('fixture-1'));
      await assertTwoCards(page);
      await browserExpect(page.locator('#phone-pause-button')).toBeEnabled();
      const preview = await page.locator('#screen').boundingBox();
      expect(preview?.width).toBe(96);
      expect(preview?.height).toBe(54);
    } finally {
      await closePhonePage(page);
    }
  });
}

it('uses the actual filter sheet controls, closes with Back, and restores the same nodes and focus', async () => {
  const page = await fixture.mountPage(390, 844);
  try {
    await page.locator('#phone-filter-button').click();
    await browserExpect(page.locator('#phone-filter-dialog')).toBeVisible();
    await page.getByLabel('Channel category', { exact: true }).selectOption('sports');
    await page
      .locator('#phone-filter-dialog')
      .getByLabel('Sport', { exact: true })
      .selectOption('american-football');
    await page
      .locator('#phone-filter-dialog')
      .getByLabel('League', { exact: true })
      .selectOption('nfl');
    await browserExpect(
      page.locator('#phone-filter-dialog .sports-inclusion-status'),
    ).toContainText('Matching PPV included');
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('native-back-requested', { cancelable: true })),
    );
    await browserExpect(page.locator('#phone-filter-dialog')).toBeHidden();
    await browserExpect(page.locator('#phone-filter-button')).toBeFocused();
    await browserExpect(page.locator('.browser > .browse-options')).toHaveCount(1);
    await browserExpect(page.locator('#compact-filter')).toHaveCount(1);
    await browserExpect(page.locator('#phone-filter-summary')).toContainText('NFL');
    await assertTwoCards(page);
    await page.locator('#phone-filter-button').click();
    await page.locator('#phone-filter-close').click();
    await browserExpect(page.locator('#phone-filter-button')).toBeFocused();
  } finally {
    await closePhonePage(page);
  }
});

it('opens Watch deliberately, returns to browsing without losing selection, and preserves wide/TV layout ownership', async () => {
  const page = await fixture.mountPage(390, 844, { playing: true });
  try {
    await page.locator('#phone-watch-button').click();
    await browserExpect(page.locator('#app')).toHaveAttribute('data-phone-view', 'watch');
    await browserExpect(page.locator('.browser')).toBeHidden();
    await browserExpect(page.locator('#phone-browse-button')).toBeVisible();
    await page.evaluate(() =>
      window.dispatchEvent(new CustomEvent('native-back-requested', { cancelable: true })),
    );
    await browserExpect(page.locator('.browser')).toBeVisible();
    await browserExpect(page.locator('#phone-watch-button')).toBeFocused();
    await page.locator('#phone-watch-button').click();
    await page.keyboard.press('Escape');
    await browserExpect(page.locator('.browser')).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, 'fixture').actions)).toEqual([]);
    await page.setViewportSize({ width: 833, height: 397 });
    await browserExpect(page.locator('#app')).toHaveAttribute('data-phone-portrait', 'true');
    await assertTwoCards(page);
    await browserExpect(page.locator('#phone-filter-button')).toBeVisible();
  } finally {
    await closePhonePage(page);
  }
  const tv = await fixture.mountPage(960, 540, { deviceKind: 'tv' });
  try {
    await browserExpect(tv.locator('#app')).not.toHaveAttribute('data-phone-portrait', 'true');
    await browserExpect(tv.locator('#phone-filter-button')).toBeHidden();
    await browserExpect(tv.locator('.sidehead #guide-button')).toHaveCount(1);
  } finally {
    await closePhonePage(tv);
  }
});

it('keeps the upright browsing owner through a real IME resize that flips CSS orientation', async () => {
  const page = await fixture.mountPage(360, 780);
  try {
    await reportedScope(page);
    await page.locator('#phone-filter-button').click();
    await page.locator('#search').focus();
    await page.setViewportSize({ width: 360, height: 330 });
    await browserExpect(page.locator('html')).toHaveClass(/viewport-keyboard-open/);
    await browserExpect(page.locator('#app')).toHaveAttribute('data-phone-portrait', 'true');
    await browserExpect(page.locator('.browser')).toBeVisible();
    await browserExpect(page.locator('#search')).toBeVisible();
    await browserExpect(page.locator('#phone-filter-dialog')).toBeVisible();
    const box = await page.locator('#search').boundingBox();
    expect(box && box.y + box.height <= 330).toBe(true);
    await page.setViewportSize({ width: 360, height: 780 });
    await page.locator('#search').press('Enter');
    await browserExpect(page.locator('#phone-filter-dialog')).toBeHidden();
    await browserExpect(page.locator('#phone-filter-button')).toBeFocused();
    await browserExpect(page.locator('#app')).not.toHaveClass(/keyboard-open/);
    await assertTwoCards(page);
  } finally {
    await closePhonePage(page);
  }
});

it('owns Enter before the application search shortcut and leaves composing text in the sheet', async () => {
  const page = await fixture.mountPage(390, 844);
  try {
    await page.locator('#phone-filter-button').click();
    await page.locator('#search').fill('NFL');
    await page.evaluate(() => {
      Reflect.set(window, 'applicationSearchSubmissions', 0);
      document.getElementById('search')!.addEventListener('keydown', (event) => {
        if ((event as KeyboardEvent).key === 'Enter')
          Reflect.set(
            window,
            'applicationSearchSubmissions',
            Reflect.get(window, 'applicationSearchSubmissions') + 1,
          );
      });
      document.getElementById('search')!.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          isComposing: true,
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    await browserExpect(page.locator('#phone-filter-dialog')).toBeVisible();
    expect(await page.evaluate(() => Reflect.get(window, 'applicationSearchSubmissions'))).toBe(0);
    await page.locator('#search').press('Enter');
    await browserExpect(page.locator('#phone-filter-dialog')).toBeHidden();
    expect(await page.evaluate(() => Reflect.get(window, 'applicationSearchSubmissions'))).toBe(0);
    await browserExpect(page.locator('#phone-filter-summary')).toContainText('NFL');
  } finally {
    await closePhonePage(page);
  }
});

async function nativeIme(page: Page, visible: boolean, sequence: number) {
  await page.evaluate(
    ({ visible, sequence }) => {
      const dpr = window.devicePixelRatio;
      window.dispatchEvent(
        new CustomEvent('native-ime-insets', {
          detail: {
            schemaVersion: 1,
            visible,
            bottomPx: visible ? Math.round(300 * dpr) : 0,
            overlapPx: visible ? Math.round(300 * dpr) : 0,
            webViewHeightPx: Math.round(innerHeight * dpr),
            sequence,
          },
        }),
      );
      return Reflect.get(window, 'fixture').settle();
    },
    { visible, sequence },
  );
}

async function expectRestoredSheetOpener(page: Page) {
  // Join the viewport RAF; the original native defect appeared after close/focus.
  await page.evaluate(() => Reflect.get(window, 'fixture').settle());
  await browserExpect(page.locator('#phone-filter-dialog')).toBeHidden();
  await browserExpect(page.locator('#app')).not.toHaveClass(/keyboard-open/);
  await browserExpect(page.locator('#phone-filter-button')).toBeFocused();
  expect(
    await page.locator('#phone-filter-button').evaluate((button) => {
      const r = button.getBoundingClientRect();
      return (
        r.height >= 44 &&
        r.width >= 44 &&
        r.top >= 0 &&
        r.bottom <= innerHeight &&
        button.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
      );
    }),
  ).toBe(true);
}

it('keeps a closed sheet IME session off the main layout through late native updates and reopen', async () => {
  const page = await fixture.mountPage(390, 844, { playing: true });
  try {
    const picture = await page.locator('#screen').boundingBox();
    await page.locator('#phone-filter-button').click();
    await page.locator('#search').focus();
    await nativeIme(page, true, 20);
    await browserExpect(page.locator('html')).toHaveClass(/viewport-keyboard-open/);
    await browserExpect(page.locator('#app')).not.toHaveClass(/keyboard-open/);
    expect(
      await page.evaluate(() =>
        parseFloat(
          document.documentElement.style.getPropertyValue('--modal-visible-viewport-height'),
        ),
      ),
    ).toBe(544);
    await page.locator('#phone-filter-close').click();
    await nativeIme(page, true, 21);
    await expectRestoredSheetOpener(page);
    expect(await page.locator('#screen').boundingBox()).toEqual(picture);
    await nativeIme(page, false, 19); // Stale hide cannot complete the current native session.
    await browserExpect(page.locator('html')).toHaveClass(/viewport-keyboard-open/);
    await expectRestoredSheetOpener(page);
    await nativeIme(page, false, 22);
    await browserExpect(page.locator('html')).not.toHaveClass(/viewport-keyboard-open/);
    await expectRestoredSheetOpener(page);
    await page.locator('#phone-filter-button').click();
    await page.locator('#search').focus();
    await nativeIme(page, true, 23);
    await page.locator('#search').press('Enter');
    await nativeIme(page, true, 24);
    await expectRestoredSheetOpener(page);
    expect(await page.locator('#screen').boundingBox()).toEqual(picture);
    await nativeIme(page, false, 25);
    await browserExpect(page.locator('html')).not.toHaveClass(/viewport-keyboard-open/);
  } finally {
    await closePhonePage(page);
  }
});

it('opens the Web browse controls when entering from portrait Watch', async () => {
  const page = await fixture.mountPage(390, 844, { playing: true });
  try {
    await page.locator('#phone-watch-button').click();
    await browserExpect(page.locator('#app')).toHaveAttribute('data-phone-view', 'watch');
    await page.locator('#local-button').click();
    await browserExpect(page.locator('#app')).toHaveAttribute('data-phone-view', 'browse');
    await browserExpect(page.locator('#local-streams')).toBeVisible();
  } finally {
    await closePhonePage(page);
  }
});

it('remembers modal editing before the first native-visible update and transfers only to a real main editor', async () => {
  const page = await fixture.mountPage(390, 844, { playing: true });
  try {
    await page.locator('#phone-filter-button').click();
    await page.locator('#search').focus();
    await nativeIme(page, false, 30); // Initial hidden snapshot, not the end of an observed IME.
    await page.locator('#phone-filter-close').click();
    await nativeIme(page, true, 31); // Android can publish its first visible inset after close.
    await browserExpect(page.locator('html')).toHaveClass(/viewport-keyboard-open/);
    await expectRestoredSheetOpener(page);
    await page.locator('#local-button').click();
    await page
      .locator('#local-streams')
      .getByRole('button', { name: 'Websites', exact: true })
      .click();
    const address = page.getByRole('textbox', { name: 'Website address or search', exact: true });
    await address.focus();
    await nativeIme(page, true, 32);
    await browserExpect(address).toBeFocused();
    await browserExpect(page.locator('#app')).toHaveClass(/keyboard-open/);
    expect(await page.locator('#app').evaluate((app) => app.style.height)).toBe('544px');
    await nativeIme(page, false, 33);
    await browserExpect(page.locator('#app')).not.toHaveClass(/keyboard-open/);
    await browserExpect(address).toBeFocused();
  } finally {
    await closePhonePage(page);
  }
});

it('preserves a newer modal edit session when the previous keyboard finishes hiding', async () => {
  const page = await fixture.mountPage(390, 844, { playing: true });
  try {
    const picture = await page.locator('#screen').boundingBox();
    await page.locator('#phone-filter-button').click();
    await page.locator('#search').focus();
    await nativeIme(page, true, 40);
    await page.evaluate(() => {
      // A second real top-layer dialog takes edit focus before the first one
      // closes. This isolates native viewport ownership from either form's fields.
      const next = document.createElement('dialog');
      next.id = 'next-ime-dialog';
      next.innerHTML = '<input aria-label="Next modal editor"><button>Done</button>';
      document.body.append(next);
      next.showModal();
      next.querySelector('input')!.focus();
      (document.getElementById('phone-filter-dialog') as HTMLDialogElement).close();
    });
    await browserExpect(page.getByRole('textbox', { name: 'Next modal editor' })).toBeFocused();
    await nativeIme(page, false, 41);
    await browserExpect(page.locator('html')).not.toHaveClass(/viewport-keyboard-open/);
    await page.evaluate(() => {
      (document.getElementById('next-ime-dialog') as HTMLDialogElement).close();
      document.getElementById('phone-filter-button')!.focus();
    });
    await nativeIme(page, true, 42);
    await browserExpect(page.locator('html')).toHaveClass(/viewport-keyboard-open/);
    await expectRestoredSheetOpener(page);
    expect(await page.locator('#screen').boundingBox()).toEqual(picture);
    await nativeIme(page, false, 43);
    await browserExpect(page.locator('html')).not.toHaveClass(/viewport-keyboard-open/);
    await page.evaluate(() => {
      const notice = document.createElement('dialog');
      notice.id = 'ime-notice-dialog';
      notice.innerHTML = '<button autofocus>Continue</button>';
      document.body.append(notice);
      notice.showModal();
    });
    await nativeIme(page, true, 44);
    await page.evaluate(() => {
      (document.getElementById('ime-notice-dialog') as HTMLDialogElement).close();
      document.getElementById('phone-filter-button')!.focus();
    });
    await nativeIme(page, true, 45);
    // Native visibility from a nonediting modal is not evidence of a main editor.
    await expectRestoredSheetOpener(page);
    expect(await page.locator('#screen').boundingBox()).toEqual(picture);
    await nativeIme(page, false, 46);
    await browserExpect(page.locator('html')).not.toHaveClass(/viewport-keyboard-open/);
  } finally {
    await closePhonePage(page);
  }
});
