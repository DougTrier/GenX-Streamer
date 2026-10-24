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
 * Timeline guide in a real browser: D-pad navigation, schedule details,
 * suspension and catalog changes.
 */
import { describe, expect, it } from 'vitest';
import {
  useTimelineBrowser,
  fixture,
  remoteBundle,
  rowCapacity,
  fullCss,
} from './timeline-browser.fixture';

useTimelineBrowser();

describe('actual timeline component', () => {
  it('rapid D-pad repeats remain owned while a row query is pending', async () => {
    const page = await fixture();
    try {
      await page.setViewportSize({ width: 960, height: 540 });
      await page.addScriptTag({ content: remoteBundle });
      await page.evaluate(() => Reflect.get(window, 'Remote').installRemoteNavigation());
      await page.getByRole('button', { name: 'Channel 0', exact: true }).focus();
      for (let index = 1; index <= 7; index++) {
        await page.keyboard.press('ArrowDown');
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.activeElement?.querySelector('.media-result-title')?.textContent ??
                document.activeElement?.textContent,
            ),
          )
          .toBe(`Channel ${index}`);
      }
      await page.evaluate(() => {
        Reflect.set(window, 'mode', 'blocked');
        Reflect.set(window, 'release', null);
      });
      // Overscan rows need no query; keep moving until a row beyond them does.
      let reached = 7;
      for (let press = 0; press < 40; press++) {
        await page.keyboard.press('ArrowDown');
        reached++;
        if ((await page.evaluate(() => typeof Reflect.get(window, 'release'))) === 'function')
          break;
        await expect
          .poll(() =>
            page.evaluate(
              () => document.activeElement?.querySelector('.media-result-title')?.textContent,
            ),
          )
          .toBe(`Channel ${reached}`);
      }
      await expect
        .poll(() => page.evaluate(() => typeof Reflect.get(window, 'release')))
        .toBe('function');
      const pendingCalls = await page.evaluate(() => Reflect.get(window, 'calls'));
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowUp');
      expect(
        await page.locator('.gx-timeline-viewport').evaluate((n) => n === document.activeElement),
      ).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(pendingCalls);
      await page.evaluate(() => {
        Reflect.set(window, 'mode', 'normal');
        Reflect.get(window, 'release')();
      });
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              document.activeElement?.querySelector('.media-result-title')?.textContent ??
              document.activeElement?.textContent,
          ),
        )
        .toBe(`Channel ${reached + 1}`);
      expect(await page.locator('.gx-timeline-row').count()).toBeLessThanOrEqual(
        await rowCapacity(page),
      );
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => {
        Reflect.set(window, 'mode', 'normal');
        Reflect.get(window, 'release')?.();
      });
      await page.close();
    }
  });
  it('D-pad preserves channel identity through more than eight rendered rows and details Back', async () => {
    const page = await fixture();
    try {
      await page.setViewportSize({ width: 960, height: 540 });
      await page.addStyleTag({ content: fullCss });
      await page.addScriptTag({ content: remoteBundle });
      await page.evaluate(async () => {
        Reflect.set(window, 'channels', Reflect.get(window, 'channels').slice(0, 40));
        await Reflect.get(window, 'owner').refresh();
        Reflect.get(window, 'Remote').installRemoteNavigation();
      });
      await page.getByRole('button', { name: 'Channel 0', exact: true }).focus();
      for (let index = 1; index <= 39; index++) {
        await page.keyboard.press('ArrowDown');
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.activeElement?.querySelector('.media-result-title')?.textContent ??
                document.activeElement?.textContent,
            ),
          )
          .toBe(`Channel ${index}`);
        expect(await page.locator('.gx-timeline-row').count()).toBeLessThanOrEqual(
          await rowCapacity(page),
        );
      }
      await page.keyboard.press('ArrowRight');
      expect(
        await page.evaluate(
          () =>
            document.activeElement
              ?.closest('.gx-timeline-row')
              ?.querySelector('.gx-timeline-channel .media-result-title')?.textContent,
        ),
      ).toBe('Channel 39');
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Back to timeline' }).waitFor();
      await page.keyboard.press('Escape');
      expect(
        await page.evaluate(
          () =>
            document.activeElement
              ?.closest('.gx-timeline-row')
              ?.querySelector('.gx-timeline-channel .media-result-title')?.textContent,
        ),
      ).toBe('Channel 39');
      await page.keyboard.press('ArrowLeft');
      for (let index = 38; index >= 0; index--) {
        await page.keyboard.press('ArrowUp');
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.activeElement?.querySelector('.media-result-title')?.textContent ??
                document.activeElement?.textContent,
            ),
          )
          .toBe(`Channel ${index}`);
        expect(await page.locator('.gx-timeline-row').count()).toBeLessThanOrEqual(
          await rowCapacity(page),
        );
      }
      await page.keyboard.press('ArrowRight');
      for (let index = 1; index <= 12; index++) {
        await page.keyboard.press('ArrowDown');
        await expect
          .poll(() =>
            page.evaluate(
              () =>
                document.activeElement
                  ?.closest('.gx-timeline-row')
                  ?.querySelector('.gx-timeline-channel .media-result-title')?.textContent,
            ),
          )
          .toBe(`Channel ${index}`);
        expect(
          await page.evaluate(() => document.activeElement?.classList.contains('gx-timeline-cell')),
        ).toBe(true);
      }
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Back to timeline' }).waitFor();
      await page.keyboard.press('Escape');
      expect(
        await page.evaluate(
          () =>
            document.activeElement
              ?.closest('.gx-timeline-row')
              ?.querySelector('.gx-timeline-channel .media-result-title')?.textContent,
        ),
      ).toBe('Channel 12');
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('closed-modal startup has no query; explicit foreground loads once and disposal refuses new work', async () => {
    const page = await fixture(false);
    try {
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      const loaded = await page.evaluate(() => Reflect.get(window, 'calls'));
      expect(loaded).toBe(await rowCapacity(page));
      await page.evaluate(async () => {
        await Reflect.get(window, 'owner').dispose();
        await Reflect.get(window, 'owner').setForeground(true);
        await Reflect.get(window, 'owner').refresh();
      });
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(loaded);
      expect(await page.locator('.gx-timeline').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('future details never tune; explicit Watch requires a fresh summary and Back restores the listing', async () => {
    const page = await fixture();
    try {
      const future = page.getByRole('button', { name: 'Future listing', exact: true }).first();
      await future.click();
      expect(await page.getByRole('button', { name: 'Watch current channel' }).count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      await page.getByRole('button', { name: 'Back to timeline' }).click();
      expect(await future.evaluate((node) => node === document.activeElement)).toBe(true);
      await page.getByRole('button', { name: 'Current listing', exact: true }).first().click();
      await page.getByRole('button', { name: 'Watch current channel' }).waitFor();
      await page.evaluate(() => Reflect.set(window, 'mode', 'stale'));
      await page.getByRole('button', { name: 'Watch current channel' }).click();
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'summaryCalls'))).toBe(3);
    } finally {
      await page.close();
    }
  });
  it('future schedule countdown crosses UTC boundaries without tuning and suspends its timer', async () => {
    const page = await fixture(true, true);
    try {
      await page.getByRole('button', { name: 'Future listing', exact: true }).first().click();
      const countdown = page.locator('.gx-timeline-countdown');
      await expect.poll(() => countdown.textContent()).toBe('Starts in 30m');
      expect(await page.evaluate(() => Reflect.get(window, 'timelineTimers').size)).toBe(1);
      expect(await page.locator('.gx-timeline-details p').first().textContent()).toContain(
        '2026-10-11T12:30:00.000Z',
      );
      const calls = await page.evaluate(() => Reflect.get(window, 'calls'));
      for (const [delta, label] of [
        [1799000, 'Starts in 1s'],
        [1800000, 'Scheduled now'],
        [3600000, 'Ended'],
        [0, 'Starts in 30m'],
      ] as const) {
        await page.evaluate(
          (value) => Reflect.set(window, 'time', Reflect.get(window, 'base') + value),
          delta,
        );
        await page.clock.runFor(1000);
        expect(await countdown.textContent()).toBe(label);
      }
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(calls);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      expect(await page.getByRole('button', { name: 'Watch current channel' }).count()).toBe(0);
      await page.evaluate(() => Reflect.get(window, 'owner').suspend());
      expect(await page.evaluate(() => Reflect.get(window, 'timelineTimers').size)).toBe(0);
      await page.clock.runFor(60000);
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(calls);
      expect(await countdown.count()).toBe(0);
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      expect(await page.evaluate(() => Reflect.get(window, 'timelineTimers').size)).toBe(0);
      await page.clock.runFor(60000);
      expect(await page.locator('.gx-timeline').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('stale or changed schedule identity never publishes a confirmed countdown', async () => {
    const page = await fixture(true, true);
    try {
      await page.evaluate(() => Reflect.set(window, 'mode', 'stale'));
      await page.getByRole('button', { name: 'Future listing', exact: true }).first().click();
      await expect
        .poll(() => page.locator('.gx-timeline-countdown').textContent())
        .toContain('Schedule may have changed');
      await page.getByRole('button', { name: 'Back to timeline' }).click();
      await page.evaluate(() => Reflect.set(window, 'mode', 'summaryBlocked'));
      await page.getByRole('button', { name: 'Future listing', exact: true }).first().click();
      await page.waitForFunction(() => Reflect.get(window, 'summaryCalls') === 2);
      await page.evaluate(() => {
        Reflect.set(window, 'revision', '2');
        Reflect.get(window, 'channels')[0].xmltvChannelId = 'replacement';
        Reflect.get(window, 'release')();
      });
      await page.clock.runFor(1000);
      expect(await page.locator('.gx-timeline-countdown').textContent()).not.toContain('Starts in');
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('overlap chooser preserves all bounded visible listing choices without covered sibling cells', async () => {
    const page = await fixture();
    try {
      await page.evaluate(async () => {
        Reflect.set(window, 'mode', 'dense');
        await Reflect.get(window, 'owner').refresh();
      });
      expect(await page.locator('.gx-timeline-row').count()).toBe(await rowCapacity(page));
      expect(await page.locator('.gx-timeline-cell').count()).toBe(await rowCapacity(page));
      // Overlaps show the first title and how many more, never a bare count.
      const overlap = page
        .getByRole('button', { name: 'Overlap 0 and 49 more listings', exact: true })
        .first();
      expect(await overlap.textContent()).toBe('Overlap 0 +49');
      await overlap.click();
      expect(await page.locator('.gx-timeline-choices button').count()).toBe(50);
      await page.getByRole('button', { name: /Overlap 49/ }).click();
      expect(await page.locator('.gx-timeline-details strong').textContent()).toBe('Overlap 49');
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('suspension joins a real pending query and fences its late rows; explicit resume is reusable', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        Reflect.set(window, 'mode', 'blocked');
        void Reflect.get(window, 'owner').refresh();
      });
      await page.getByRole('status').getByText('Loading visible listings…').waitFor();
      await page.evaluate(() => {
        Reflect.set(window, 'drained', false);
        void Reflect.get(window, 'owner')
          .suspend()
          .then(() => Reflect.set(window, 'drained', true));
      });
      expect(await page.evaluate(() => Reflect.get(window, 'drained'))).toBe(false);
      await page.evaluate(() => Reflect.get(window, 'release')());
      await page.waitForFunction(() => Reflect.get(window, 'drained') === true);
      expect(await page.locator('.gx-timeline-row').count()).toBe(0);
      await page.evaluate(async () => {
        Reflect.set(window, 'mode', 'normal');
        await Reflect.get(window, 'owner').setForeground(true);
      });
      expect(await page.locator('.gx-timeline-row').count()).toBe(await rowCapacity(page));
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      expect(await page.locator('.gx-timeline').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('catalog/mapping changes during summary acquisition cannot admit Watch', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => Reflect.set(window, 'mode', 'summaryBlocked'));
      await page.getByRole('button', { name: 'Current listing', exact: true }).first().click();
      await page.waitForFunction(() => Reflect.get(window, 'summaryCalls') === 1);
      await page.evaluate(() => {
        Reflect.set(window, 'revision', '2');
        Reflect.get(window, 'channels')[0].xmltvChannelId = 'different';
        Reflect.get(window, 'release')();
      });
      expect(await page.getByRole('button', { name: 'Watch current channel' }).count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  for (const size of [
    { width: 960, height: 540 },
    { width: 320, height: 640 },
  ])
    it(`bounded timeline geometry ${size.width}x${size.height} enlarged text`, async () => {
      const page = await fixture();
      try {
        await page.setViewportSize(size);
        await page.locator('.gx-timeline').evaluate((node) => {
          (node as HTMLElement).style.fontSize = '32px';
        });
        for (const name of ['Previous 3 hours', 'Now', 'Next 3 hours']) {
          const rect = await page.getByRole('button', { name, exact: true }).boundingBox();
          expect(rect!.height).toBeGreaterThanOrEqual(44);
          expect(rect!.x + rect!.width).toBeLessThanOrEqual(size.width);
          expect(rect!.y + rect!.height).toBeLessThan(size.height);
        }
        expect(
          await page.evaluate(
            () =>
              document.documentElement.scrollWidth <= innerWidth &&
              document.documentElement.scrollHeight <= innerHeight,
          ),
        ).toBe(true);
        expect(
          await page.locator('.gx-timeline-viewport').evaluate((node) => node.clientHeight),
        ).toBeGreaterThan(80);
        expect(await page.locator('video').count()).toBe(0);
      } finally {
        await page.close();
      }
    });
});
