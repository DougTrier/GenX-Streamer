// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { fixture, fullCss, shellBundle, useTimelineBrowser } from './timeline-browser.fixture';
useTimelineBrowser();

for (const size of [
  { width: 832, height: 397, kind: 'personal' },
  { width: 854, height: 432, kind: 'personal' },
  { width: 960, height: 540, kind: 'tv' },
]) {
  it(`Guide remains usable at ${size.width}x${size.height} on ${size.kind}`, async () => {
    const page = await fixture(true, false, 480);
    try {
      await page.setViewportSize(size);
      await page.addStyleTag({ content: fullCss });
      await page.addScriptTag({ content: shellBundle });
      await page.evaluate(async ({ kind }) => {
        const timeline = document.querySelector('.gx-timeline')!;
        Reflect.get(window, 'Shell').createShell(document.getElementById('app'));
        const app = document.getElementById('app')!;
        app.dataset.deviceKind = kind;
        app.dataset.guidePanel = 'open';
        app.dataset.playerIdle = 'true';
        document.querySelector<HTMLElement>('#compact-view')!.hidden = true;
        const host = document.getElementById('primary-view-host')!;
        host.hidden = false;
        const dialog = document.createElement('dialog');
        dialog.className = 'guide-dialog guide-with-timeline guide-compact-page';
        dialog.dataset.primaryPage = 'guide';
        dialog.innerHTML =
          '<div class="guide-body"><section class="guide-panel guide-timeline-panel"></section></div>';
        host.append(dialog);
        dialog.querySelector('.guide-timeline-panel')!.append(timeline);
        const toolbar = timeline.querySelector('.gx-timeline-toolbar')!;
        const feedback = document.createElement('div');
        feedback.className = 'guide-feedback';
        feedback.textContent = '100 channels with listings';
        toolbar.append(feedback);
        for (const label of ['Find', 'Close']) {
          const button = document.createElement('button');
          button.textContent = label;
          if (label === 'Close') button.onclick = () => dialog.close();
          toolbar.append(button);
        }
        dialog.show();
        await Reflect.get(window, 'owner').refresh();
      }, size);
      await expect
        .poll(() => page.locator('.gx-timeline').getAttribute('data-layout'))
        .toBe('timeline');
      const guide = await page.locator('.guide-dialog').boundingBox();
      expect(guide).not.toBeNull();
      if (size.kind === 'personal') {
        expect(guide!.width).toBeGreaterThan(size.width * 0.95);
        expect(await page.locator('.browser').isVisible()).toBe(false);
        const grid = await page.locator('.gx-timeline-viewport').boundingBox();
        expect(grid!.height).toBeGreaterThanOrEqual(3 * 44);
        const row = await page.locator('.gx-timeline-channel').first().boundingBox();
        expect(row!.height).toBeGreaterThanOrEqual(44);
        expect(row!.height).toBeLessThan(64);
      } else {
        expect(await page.locator('.browser').isVisible()).toBe(true);
        expect(guide!.width).toBeLessThan(size.width - 200);
      }
      const close = page
        .locator('.gx-timeline-toolbar')
        .getByRole('button', { name: 'Close', exact: true });
      if (size.kind === 'personal') {
        // The short-landscape preview shares the top strip with a bounded
        // toolbar rail. Reach Close through its owned remote order; focusing
        // or clicking Close directly would conceal a missing reveal step.
        const toolbar = page.locator('.gx-timeline-toolbar');
        const outer = await page.evaluate(() => [scrollX, scrollY]);
        await toolbar.getByRole('button', { name: 'All channels', exact: true }).focus();
        const count = await toolbar
          .locator('button:visible, input:visible, select:visible')
          .count();
        for (let step = 0; step < count; step++) {
          if (await close.evaluate((node) => node === document.activeElement)) break;
          await page.keyboard.press('ArrowRight');
        }
        expect(await close.evaluate((node) => node === document.activeElement)).toBe(true);
        expect(
          await close.evaluate((node) => {
            const toolbar = node.closest<HTMLElement>('.gx-timeline-toolbar')!;
            const r = node.getBoundingClientRect(),
              frame = toolbar.getBoundingClientRect();
            const left = frame.left + toolbar.clientLeft,
              top = frame.top + toolbar.clientTop;
            return (
              r.width >= 44 &&
              r.height >= 44 &&
              r.left >= left - 1 &&
              r.right <= left + toolbar.clientWidth + 1 &&
              r.top >= top - 1 &&
              r.bottom <= top + toolbar.clientHeight + 1 &&
              node.scrollWidth <= node.clientWidth + 1 &&
              node.scrollHeight <= node.clientHeight + 1
            );
          }),
        ).toBe(true);
        expect(await page.evaluate(() => [scrollX, scrollY])).toEqual(outer);
      }
      expect(
        await close.evaluate((node) => {
          const r = node.getBoundingClientRect();
          const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
          return (
            r.left >= 0 &&
            r.right <= innerWidth &&
            r.top >= 0 &&
            r.bottom <= innerHeight &&
            !!hit &&
            node.contains(hit)
          );
        }),
      ).toBe(true);
      await page.locator('.gx-timeline-channel').first().focus();
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() => page.evaluate(() => document.activeElement?.textContent))
        .toContain('Channel 1');
      await page.locator('.gx-timeline-cell').first().click();
      await page.getByRole('button', { name: 'Back to timeline', exact: true }).click();
      await expect.poll(() => page.locator('.gx-timeline-viewport').isVisible()).toBe(true);
      await mkdir('artifacts/fire-tv-testing/guide-layout', { recursive: true });
      await page.screenshot({
        path: `artifacts/fire-tv-testing/guide-layout/${size.kind}-${size.width}x${size.height}.png`,
      });
      await close.click();
      expect(await page.locator('.guide-dialog').isVisible()).toBe(false);
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    } finally {
      await page.close();
    }
  });
}
