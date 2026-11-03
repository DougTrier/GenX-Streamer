/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { expect as ui, type Page } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import { closePhonePage, preparePhoneFixture } from '../support/phone-surface-fixture';

let fixture: Awaited<ReturnType<typeof preparePhoneFixture>>;
const evidence = 'artifacts/phone-portrait-testing/guide-source-ime';
const phase = process.env.GENX_GUIDE_IME_PHASE ?? 'current';
if (!/^[a-z0-9-]+$/.test(phase)) throw new Error('Invalid Guide IME evidence phase');

beforeAll(async () => {
  fixture = await preparePhoneFixture();
  await mkdir(evidence, { recursive: true });
});
afterAll(async () => fixture?.close());

async function nativeKeyboard(page: Page, usableHeight: number, sequence: number) {
  await page.evaluate(
    ({ usableHeight, sequence }) => {
      const overlap = Math.max(0, innerHeight - usableHeight);
      window.dispatchEvent(
        new CustomEvent('native-ime-insets', {
          detail: {
            schemaVersion: 1,
            visible: overlap > 0,
            bottomPx: Math.round(overlap * devicePixelRatio),
            overlapPx: Math.round(overlap * devicePixelRatio),
            webViewHeightPx: Math.round(innerHeight * devicePixelRatio),
            sequence,
          },
        }),
      );
      return Reflect.get(window, 'fixture').settle();
    },
    { usableHeight, sequence },
  );
}

for (const [width, height, usableHeight] of [
  [833, 397, 183],
  [390, 844, 280],
]) {
  it(`keeps the actual advanced Guide source form reachable above the native keyboard at ${width}x${height}`, async () => {
    const page = await fixture.mountPage(width, height, { playing: true });
    try {
      // Reuse the real Guide owner after a normal timeline, as on Thor. Its
      // header, view selector, return action and feedback must all participate.
      await page.locator('#guide-button').click();
      const normal = page.locator('.guide-dialog[open]');
      await ui(normal).toHaveAttribute('data-primary-page', 'guide');
      if (width === 833) {
        await ui(normal.locator('.gx-timeline-row').first()).toBeVisible();
        expect(
          await normal.locator('.gx-timeline-viewport').evaluate((node) => {
            const r = node.getBoundingClientRect();
            return [...node.querySelectorAll('.gx-timeline-row')].filter((row) => {
              const box = row.getBoundingClientRect();
              return box.top >= r.top && box.bottom <= r.bottom;
            }).length;
          }),
        ).toBeGreaterThanOrEqual(3);
      }
      const controls = normal.getByRole('button', { name: 'Guide controls', exact: true });
      if (await controls.isVisible()) await controls.click();
      await normal.getByRole('button', { name: 'Close guide', exact: true }).click();
      await page.evaluate(() => Reflect.get(window, 'fixture').views.guide.openAdvanced());
      const dialog = page.locator('.guide-dialog[open]');
      await ui(dialog).not.toHaveAttribute('data-primary-page');
      await ui(dialog).toHaveAttribute('data-guide-owner', 'app');
      // Advanced Guide is portalled outside the shell for modal presentation.
      expect(await dialog.evaluate((node) => document.getElementById('app')!.contains(node))).toBe(
        false,
      );
      await dialog.getByText('Add guide link or file', { exact: true }).click();
      await dialog.getByLabel('Guide source name', { exact: true }).fill('Offline reviewed guide');
      const address = dialog.getByLabel('Online XMLTV URL', { exact: true });
      await address.fill('https://fixture.invalid/not-fetched');
      await nativeKeyboard(page, usableHeight, 1);
      await ui(page.locator('html')).toHaveClass(/viewport-keyboard-open/);

      // Follow the form's own keyboard order, rather than injecting focus or
      // changing scroll styles to make the submit button appear reachable.
      const save = dialog.getByRole('button', { name: 'Save source and preview', exact: true });
      for (let step = 0; step < 8; step++) {
        if (await save.evaluate((node) => node === document.activeElement)) break;
        await page.keyboard.press('Tab');
      }
      await ui(save).toBeFocused();
      await page.evaluate(() => Reflect.get(window, 'fixture').settle());
      const geometry = await save.evaluate((node) => {
        const r = node.getBoundingClientRect();
        const modal = node.closest<HTMLDialogElement>('.guide-dialog')!;
        const bounds = modal.getBoundingClientRect();
        const body = modal.querySelector<HTMLElement>('.guide-body')!;
        const feedback = modal.querySelector<HTMLElement>('.guide-feedback')!;
        return {
          button: [r.x, r.y, r.width, r.height],
          modal: [bounds.x, bounds.y, bounds.width, bounds.height],
          modalScroll: [modal.scrollTop, modal.clientHeight, modal.scrollHeight],
          body: [body.clientHeight, body.scrollHeight],
          feedback: [feedback.getBoundingClientRect().y, feedback.clientHeight],
          inside:
            r.top >= bounds.top + modal.clientTop &&
            r.bottom <= bounds.top + modal.clientTop + modal.clientHeight &&
            r.left >= 0 &&
            r.right <= innerWidth,
          hits: [
            [r.x + r.width / 2, r.y + r.height / 2],
            [r.x + 2, r.y + r.height / 2],
            [r.right - 2, r.y + r.height / 2],
            [r.x + r.width / 2, r.y + 2],
            [r.x + r.width / 2, r.bottom - 2],
          ].map(([x, y]) => node.contains(document.elementFromPoint(x, y))),
        };
      });
      await writeFile(
        `${evidence}/${phase}-${width}x${height}.json`,
        JSON.stringify(geometry, null, 2),
      );
      await page.screenshot({ path: `${evidence}/${phase}-${width}x${height}.png` });
      expect(geometry.modal[3]).toBeLessThanOrEqual(usableHeight - 16 + 0.5);
      expect(geometry.button[2]).toBeGreaterThanOrEqual(44);
      expect(geometry.button[3]).toBeGreaterThanOrEqual(44);
      expect(geometry.inside).toBe(true);
      expect(geometry.hits).toEqual([true, true, true, true, true]);

      await page.keyboard.press('ArrowUp');
      await page.evaluate(() => Reflect.get(window, 'fixture').settle());
      const next = await dialog.evaluate((modal) => {
        const focused = document.activeElement as HTMLElement;
        const r = focused.getBoundingClientRect(),
          bounds = modal.getBoundingClientRect();
        return {
          owned: modal.contains(focused),
          submit: focused.textContent === 'Save source and preview',
          inside: r.top >= bounds.top && r.bottom <= bounds.bottom,
          centerOwn: focused.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          ),
        };
      });
      expect(next.owned).toBe(true);
      expect(next.submit).toBe(false);
      expect(next.inside).toBe(true);
      expect(next.centerOwn).toBe(true);
      for (let step = 0; step < 8; step++) {
        if (await save.evaluate((node) => node === document.activeElement)) break;
        await page.keyboard.press('Tab');
      }
      await ui(save).toBeFocused();

      await nativeKeyboard(page, height, 2);
      await ui(page.locator('html')).not.toHaveClass(/viewport-keyboard-open/);
      await ui(save).toBeFocused();
      const afterHide = await save.evaluate((node) => {
        const r = node.getBoundingClientRect();
        const modal = node.closest<HTMLDialogElement>('.guide-dialog')!;
        const bounds = modal.getBoundingClientRect();
        return {
          button: [r.x, r.y, r.width, r.height],
          modal: [bounds.x, bounds.y, bounds.width, bounds.height],
          bodyScroll: modal.querySelector('.guide-body')!.scrollTop,
          inside: r.top >= bounds.top && r.bottom <= bounds.bottom,
          centerOwn: node.contains(
            document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2),
          ),
        };
      });
      await writeFile(
        `${evidence}/${phase}-${width}x${height}-after-hide.json`,
        JSON.stringify(afterHide, null, 2),
      );
      expect(afterHide.inside).toBe(true);
      expect(afterHide.centerOwn).toBe(true);
      await save.click();
      // The local fixture intentionally refuses acquisition. This confirms the
      // real Guide handler received the click; it is not a network/adapter test.
      await ui(dialog.getByRole('alert')).toContainText('Guide action failed');

      await ui(dialog.getByRole('button', { name: 'Close guide', exact: true })).toBeVisible();
      await dialog.getByRole('button', { name: 'Close guide', exact: true }).click();
      await ui(dialog).toBeHidden();
      await ui(page.locator('#channel-list')).toBeVisible();
    } finally {
      await closePhonePage(page);
    }
  });
}
