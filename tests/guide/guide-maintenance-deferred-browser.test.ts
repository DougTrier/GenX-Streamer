/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { dispose, fixture, useGuideUiBrowser } from './guide-ui-browser.fixture';
import type { GuideHost } from '../../src/ui/guide/guide-model';
import type { mountGuide } from '../../src/ui/guide/guide';

interface FixtureWindow {
  guide: ReturnType<typeof mountGuide>;
  host: GuideHost;
  GuideUI: { mountGuide: typeof mountGuide };
  calls: { sources: number };
  buildCalls: number;
  sourceReads: number;
  retainedRow: Element | null;
}

useGuideUiBrowser();
for (const action of ['Find button', 'public build action']) {
  it(`keeps saved rows and controls when ${action} queues work until idle`, async () => {
    const page = await fixture(false, true, true);
    try {
      await page.evaluate(async () => {
        const w = window as unknown as FixtureWindow;
        await w.guide.dispose();
        w.host.presentation = 'page';
        w.host.buildForChannels = async () => {
          w.buildCalls = (w.buildCalls ?? 0) + 1;
          return {
            connected: 0,
            unmatched: 0,
            checked: 0,
            failed: 0,
            skipped: 0,
            maintenance: 'deferred',
            deferred: true,
          };
        };
        w.guide = w.GuideUI.mountGuide(document.getElementById('guide')!, w.host);
        await w.guide.open();
      });
      const row = page.locator('.gx-timeline-channel').first();
      await row.waitFor({ state: 'visible' });
      await row.focus();
      await page.evaluate(() => {
        const w = window as unknown as FixtureWindow;
        w.retainedRow = document.querySelector('.gx-timeline-row');
        w.sourceReads = w.calls.sources;
      });
      if (action === 'Find button') {
        await page
          .getByRole('button', { name: 'Find program guides', exact: true })
          .first()
          .focus();
        await page.keyboard.press('Enter');
      } else {
        await page.evaluate(() => (window as unknown as FixtureWindow).guide.buildForChannels());
      }
      await page
        .getByText(
          'Guide update queued until playback and browsing stop. Previous schedules remain available.',
          { exact: true },
        )
        .waitFor();
      expect(
        await page.evaluate(() => {
          const w = window as unknown as FixtureWindow;
          return (
            w.retainedRow === document.querySelector('.gx-timeline-row') &&
            w.retainedRow?.isConnected &&
            w.calls.sources === w.sourceReads &&
            w.buildCalls === 1
          );
        }),
      ).toBe(true);
      expect(await page.getByRole('button', { name: 'Close guide', exact: true }).isEnabled()).toBe(
        true,
      );
      if (action === 'public build action')
        await expect.poll(() => row.evaluate((el) => el === document.activeElement)).toBe(true);
      await page.getByRole('button', { name: 'Close guide', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect.poll(() => page.locator('dialog[open]').count()).toBe(0);
    } finally {
      await dispose(page);
    }
  });
}

for (const hidden of [false, true]) {
  it(`retires failed automatic work ${hidden ? 'while closed before reopening' : 'without replacing saved rows'}`, async () => {
    const page = await fixture(false, true, true);
    try {
      await page.evaluate(async () => {
        const w = window as unknown as FixtureWindow;
        await w.guide.dispose();
        w.host.presentation = 'page';
        w.host.buildForChannels = async () => {
          throw new Error('Unexpected build');
        };
        w.guide = w.GuideUI.mountGuide(document.getElementById('guide')!, w.host);
        await w.guide.open();
      });
      const row = page.locator('.gx-timeline-channel').first();
      await row.waitFor({ state: 'visible' });
      const savedName = await row.textContent();
      await row.focus();
      await page.evaluate(() => {
        const w = window as unknown as FixtureWindow;
        w.retainedRow = document.querySelector('.gx-timeline-row');
        w.sourceReads = w.calls.sources;
        w.guide.presentAutomaticProgress({
          phase: 'capturing',
          total: 0,
          attempted: 0,
          connected: 0,
          unmatched: 0,
          checked: 0,
          failed: 0,
          skipped: 0,
        });
      });
      await page.getByText('Preparing guide check', { exact: true }).waitFor();
      if (hidden) await page.evaluate(() => (window as unknown as FixtureWindow).guide.close());
      await page.evaluate(() =>
        (window as unknown as FixtureWindow).guide.presentAutomaticFailure(),
      );
      if (hidden) await page.evaluate(() => (window as unknown as FixtureWindow).guide.open());
      await page
        .getByText(
          'Program guide work could not finish. Previous schedules remain available. Review guide sources or try Find again.',
          { exact: true },
        )
        .waitFor();
      expect(
        await page
          .getByRole('button', { name: 'Find program guides', exact: true })
          .first()
          .isEnabled(),
      ).toBe(true);
      expect(await row.textContent()).toBe(savedName);
      if (!hidden)
        expect(
          await page.evaluate(() => {
            const w = window as unknown as FixtureWindow;
            return (
              w.retainedRow === document.querySelector('.gx-timeline-row') &&
              w.retainedRow?.isConnected &&
              w.calls.sources === w.sourceReads &&
              document.activeElement === document.querySelector('.gx-timeline-channel')
            );
          }),
        ).toBe(true);
    } finally {
      await dispose(page);
    }
  });
}
