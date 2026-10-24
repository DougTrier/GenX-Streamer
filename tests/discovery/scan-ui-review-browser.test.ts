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
 * Scan screen in a real browser: reviewing checks, history, budgets and
 * publication.
 */
import { describe, expect, it } from 'vitest';
import { readStylesheet } from '../support/stylesheet';
import {
  useScanUiBrowser,
  fixture,
  applicationStyles,
  assertScanActionsReachable,
  scan,
  selectAction,
} from './scan-ui-browser.fixture';

useScanUiBrowser();

describe('actual Chromium scan review component', () => {
  for (const keyboard of [false, true])
    it(`initial Scan is content sized with the full application cascade, keyboard owner ${keyboard}`, async () => {
      const page = await fixture();
      try {
        await page.setViewportSize({ width: 960, height: 540 });
        await page.addStyleTag({ content: await applicationStyles() });
        if (keyboard)
          await page.evaluate(() => {
            document.documentElement.classList.add('viewport-keyboard-open');
            document.documentElement.style.setProperty('--visible-viewport-height', '540px');
          });
        const geometry = await page.locator('.source-scan-dialog').evaluate((node) => {
          const rect = node.getBoundingClientRect(),
            body = node.querySelector('.scan-body')!,
            setup = node.querySelector('.scan-setup')!;
          return {
            state: (node as HTMLElement).dataset.scanState,
            height: rect.height,
            width: rect.width,
            body: body.getBoundingClientRect().height,
            setup: setup.getBoundingClientRect().height,
            insets: [getComputedStyle(node).top, getComputedStyle(node).bottom],
            bodyFlex: getComputedStyle(body).flex,
          };
        });
        expect(geometry.state).toBe('start');
        expect(geometry.width).toBeLessThanOrEqual(560);
        expect(geometry.height).toBeLessThanOrEqual(320);
        expect(Math.abs(geometry.body - geometry.setup)).toBeLessThanOrEqual(4);
        await assertScanActionsReachable(page, 540);
        await page.locator('.scan-options').evaluate((node) => {
          (node as HTMLDetailsElement).open = true;
        });
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLElement>('.source-scan-dialog')?.dataset.scanState ===
            'results',
        );
        expect(
          await page
            .locator('.source-scan-dialog')
            .evaluate((node) => node.getBoundingClientRect().height),
        ).toBeGreaterThan(geometry.height);
      } finally {
        await page.close();
      }
    });
  for (const viewport of [
    { width: 960, height: 540, visual: 300, textScale: 1 },
    { width: 320, height: 640, visual: 640, textScale: 2 },
    { width: 640, height: 360, visual: 360, textScale: 2 },
  ])
    it(`initial Scan keeps actions inside visual height ${viewport.visual}, width ${viewport.width}, text ${viewport.textScale}`, async () => {
      const page = await fixture();
      try {
        await page.setViewportSize({ width: viewport.width, height: viewport.height });
        await page.addStyleTag({ content: await applicationStyles() });
        await page.evaluate(({ visual, textScale }) => {
          document.documentElement.classList.add('viewport-keyboard-open');
          document.documentElement.style.setProperty('--visible-viewport-height', `${visual}px`);
          if (textScale !== 1) {
            const nodes = [
              ...document.querySelectorAll<HTMLElement>(
                '.source-scan-dialog,.source-scan-dialog *',
              ),
            ].map((node) => ({ node, size: parseFloat(getComputedStyle(node).fontSize) }));
            for (const { node, size } of nodes) node.style.fontSize = `${size * textScale}px`;
          }
        }, viewport);
        await assertScanActionsReachable(page, viewport.visual);
        const bounds = await page.locator('dialog').boundingBox();
        expect(bounds!.y).toBeGreaterThanOrEqual(0);
        expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.visual);
        expect(
          await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
        ).toBe(true);
      } finally {
        await page.close();
      }
    });
  it('captures the actual check budget/profile and never relabels it after dropdown changes', async () => {
    const page = await fixture(true, true, true);
    try {
      await page.evaluate(() => Reflect.set(window, 'budgetProfile', true));
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await selectAction(page, 'options');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page
        .locator('.scan-options')
        .evaluate((el) => ((el as HTMLDetailsElement).open = true));
      await page.getByLabel('Channel check time').selectOption('60000');
      await selectAction(page, 'check');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.getByText(/channels responded\./).waitFor();
      await page.getByLabel('Channel check time').selectOption('20000');
      await selectAction(page, 'options');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Selected channels saved.', { exact: true }).waitFor();
      const saved = await page.evaluate(() => Reflect.get(window, 'commits')[0].health);
      expect(saved.budgetMs).toBe(60000);
      expect(saved.observerProfile).toBe('inspection-v1@60000');
      await selectAction(page, 'options');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.getByLabel('Channel check time').selectOption('45000');
      await selectAction(page, 'history');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.getByLabel('Saved checks', { exact: true }).locator('li').first().waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'historyBudgets'))).toEqual([45000]);
    } finally {
      await page.close();
    }
  });
  it('explains a different observer profile without implying a new playback result', async () => {
    const page = await fixture(false, false, true);
    try {
      await page.evaluate(() => Reflect.set(window, 'historyFreshness', 'different-profile'));
      await selectAction(page, 'history');
      await page.getByRole('button', { name: 'Run action' }).click();
      const first = page.getByLabel('Saved checks', { exact: true }).locator('li').first();
      await first.waitFor();
      expect(await first.locator('p').textContent()).toBe(
        'Stream responded · Different check settings · Imported historical check',
      );
      expect(await first.locator('p').textContent()).not.toContain('playable');
      expect(await first.locator('p').textContent()).not.toContain('different-profile');
      await first.getByText('Check details', { exact: true }).click();
      expect(await first.locator('dl').textContent()).toContain(
        'Check settingsreachability-v1/native-http-v1',
      );
    } finally {
      await page.close();
    }
  });
  it('loads saved checks explicitly with bounded pages and restores the unsaved review', async () => {
    const page = await fixture(false, false, true);
    try {
      expect(await page.evaluate(() => Reflect.get(window, 'historyCalls').length)).toBe(0);
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await selectAction(page, 'history');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.getByLabel('Saved checks', { exact: true }).locator('li').first().waitFor();
      expect(await page.getByLabel('Saved checks', { exact: true }).locator('li').count()).toBe(50);
      const first = page.getByLabel('Saved checks', { exact: true }).locator('li').first();
      expect(await first.locator('strong').textContent()).toBe('Saved 0');
      expect(await first.locator('details').getAttribute('open')).toBeNull();
      expect(await first.locator('dl').isVisible()).toBe(false);
      expect(await first.locator('time').getAttribute('datetime')).toBe('2023-11-14T22:13:20.000Z');
      expect(await first.locator('time').textContent()).not.toContain('T22:13');
      expect(await first.locator('span').textContent()).toBe(' · Windows');
      expect(await page.getByLabel('Search saved checks').getAttribute('placeholder')).toBe(
        'Channel, category or source',
      );
      await first.getByText('Check details', { exact: true }).click();
      expect(await first.locator('dl').isVisible()).toBe(true);
      expect(await first.locator('dl').textContent()).toContain('HTTP 200');
      expect(await first.locator('dl').textContent()).toContain('playback was not tested');
      expect(await first.locator('dl').textContent()).toContain('Alternate stream 2');
      expect(await first.locator('dl').textContent()).not.toContain('https://');
      expect(
        await page.getByLabel('Saved checks', { exact: true }).locator('li').first().textContent(),
      ).toContain('Stream responded · Older check · Imported historical check');
      expect(await page.locator('img').count()).toBe(0);
      await selectAction(page, 'next');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page
        .getByLabel('Saved checks', { exact: true })
        .locator('li')
        .filter({ hasText: 'Saved 50' })
        .waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'historyCalls')[1])).toEqual({
        offset: 50,
        query: '',
        revision: '2:3',
      });
      await page.getByLabel('Search saved checks').fill('Bears');
      await page
        .getByLabel('Saved checks', { exact: true })
        .locator('li')
        .filter({ hasText: 'Bears' })
        .waitFor();
      expect(await page.getByLabel('Saved checks', { exact: true }).locator('li').count()).toBe(1);
      await selectAction(page, 'review');
      await page.getByRole('button', { name: 'Run action' }).click();
      expect(
        await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).isChecked(),
      ).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('rejects mixed-revision history pages and permits explicit first-page retry', async () => {
    const page = await fixture(false, false, true);
    try {
      await selectAction(page, 'history');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.getByLabel('Saved checks', { exact: true }).locator('li').first().waitFor();
      await page.evaluate(() => Reflect.set(window, 'historyMode', 'changed'));
      await selectAction(page, 'next');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: 'Saved checks changed. Start from the first page.' })
        .waitFor();
      expect(await page.getByLabel('Saved checks', { exact: true }).locator('li').count()).toBe(0);
      await page.evaluate(() => Reflect.set(window, 'historyMode', 'normal'));
      await selectAction(page, 'history');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.getByLabel('Saved checks', { exact: true }).locator('li').first().waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'historyCalls').at(-1))).toEqual({
        offset: 0,
        query: '',
      });
    } finally {
      await page.close();
    }
  });
  it('waits for owned history reads on close and ignores their late completion', async () => {
    const page = await fixture(false, false, true);
    try {
      await page.evaluate(() => Reflect.set(window, 'historyMode', 'blocked'));
      await selectAction(page, 'history');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.getByText('Loading saved checks…').waitFor();
      await page.getByRole('button', { name: 'Close scan review' }).click();
      await page.waitForFunction(() => !document.querySelector('dialog')?.open);
      expect(await page.evaluate(() => Reflect.get(window, 'historySettled'))).toBe(1);
      expect(await page.getByLabel('Saved checks', { exact: true }).locator('li').count()).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('saves only selected checked health with immutable review identity and profile', async () => {
    const page = await fixture(true, true);
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Select Alpha 1', exact: true }).check();
      await selectAction(page, 'check');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.getByText(/channels responded\./).waitFor();
      await page.getByRole('checkbox', { name: 'Select Alpha 1', exact: true }).uncheck();
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      const health = await page.evaluate(() => Reflect.get(window, 'commits')[0].health);
      expect(health.platform).toBe('Fixture');
      expect(health.observerProfile).toBe('inspection-v1');
      expect(health.candidates).toHaveLength(1);
      expect(health.candidates[0].channel.name).toBe('Alpha 0');
      expect(health.observations).toHaveLength(1);
      expect(health.observations[0].verdict).toBe('Reachable');
      expect(health.observations[0].channelId).toBe(health.candidates[0].key);
    } finally {
      await page.close();
    }
  });
  it('refuses to relabel checked observations after the observer profile changes', async () => {
    const page = await fixture(true, true);
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await selectAction(page, 'check');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.getByText(/channels responded\./).waitFor();
      await page.evaluate(() => {
        Reflect.set(window, 'profile', 'inspection-v2');
      });
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page
        .getByRole('alert')
        .filter({ hasText: /Selection was not saved/ })
        .waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('displays completed health from a canceled batch while keeping Save fenced', async () => {
    const page = await fixture(true, true);
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await page.getByRole('checkbox', { name: 'Select Alpha 1', exact: true }).check();
      await page.evaluate(() => {
        Reflect.set(window, 'probeMode', 'partial');
      });
      await selectAction(page, 'check');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page.waitForFunction(() => Reflect.get(window, 'probes').length === 2);
      await selectAction(page, 'cancel');
      await page.getByRole('button', { name: 'Run action', exact: true }).click();
      await page
        .getByLabel('Candidate channels')
        .locator('li')
        .filter({ hasText: 'Alpha 0' })
        .filter({ hasText: 'Responded' })
        .waitFor();
      expect(await page.getByRole('button', { name: 'Save selected channels' }).isDisabled()).toBe(
        true,
      );
      expect(await page.evaluate(() => Reflect.get(window, 'commits').length)).toBe(0);
    } finally {
      await page.close();
    }
  });
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 640, height: 360 },
  ])
    it(`saved checks remain bounded and navigable at ${viewport.width}x${viewport.height} with 200% text`, async () => {
      const page = await fixture(false, false, true);
      try {
        await page.setViewportSize(viewport);
        await page.addStyleTag({
          content:
            (await readStylesheet('src/ui/style.css')) +
            '\n' +
            (await readStylesheet('src/ui/guide.css')),
        });
        await selectAction(page, 'history');
        await page.getByRole('button', { name: 'Run action' }).click();
        await page.getByLabel('Saved checks', { exact: true }).locator('li').first().waitFor();
        await page
          .getByLabel('Saved checks', { exact: true })
          .locator('li')
          .first()
          .getByText('Check details', { exact: true })
          .click();
        await page.locator('dialog').evaluate((root) => {
          const sizes = [...root.querySelectorAll<HTMLElement>('*')].map((node) => ({
            node,
            size: parseFloat(getComputedStyle(node).fontSize),
          }));
          for (const { node, size } of sizes) node.style.fontSize = `${size * 2}px`;
        });
        await page.addStyleTag({ content: '.scan-candidates li {font-size:32px !important}' });
        expect(
          await page
            .getByLabel('Saved checks', { exact: true })
            .evaluate((node) => node.scrollWidth <= node.clientWidth),
        ).toBe(true);
        expect(
          await page
            .getByLabel('Saved checks', { exact: true })
            .locator('li')
            .first()
            .locator('dl')
            .isVisible(),
        ).toBe(true);
        expect(
          await page
            .getByLabel('Saved checks', { exact: true })
            .evaluate((node) => node.scrollHeight > node.clientHeight),
        ).toBe(true);
        await selectAction(page, 'next');
        await page.getByRole('button', { name: 'Run action' }).click();
        await page
          .getByLabel('Saved checks', { exact: true })
          .locator('li')
          .filter({ hasText: 'Saved 50' })
          .waitFor();
        const box = await page.getByRole('button', { name: 'Close scan review' }).boundingBox();
        expect(box).not.toBeNull();
        expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
        await page.getByRole('button', { name: 'Close scan review' }).click();
        expect(await page.locator('dialog').isVisible()).toBe(false);
      } finally {
        await page.close();
      }
    });
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 640, height: 360 },
  ])
    it(`review selection and paging remain clickable at ${viewport.width}x${viewport.height} with 200% text`, async () => {
      const page = await fixture();
      try {
        await page.setViewportSize(viewport);
        await page.addStyleTag({
          content:
            (await readStylesheet('src/ui/style.css')) +
            '\n' +
            (await readStylesheet('src/ui/guide.css')),
        });
        await scan(page);
        await page.locator('dialog').evaluate((root) => {
          const sizes = [...root.querySelectorAll<HTMLElement>('*')].map((node) => ({
            node,
            size: parseFloat(getComputedStyle(node).fontSize),
          }));
          for (const { node, size } of sizes) node.style.fontSize = `${size * 2}px`;
        });
        await page.addStyleTag({ content: '.scan-candidates label {font-size:24px !important}' });
        await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
        await selectAction(page, 'next');
        await page.getByRole('button', { name: 'Run action' }).click();
        await page.getByRole('checkbox', { name: 'Select Alpha 50', exact: true }).check();
        await selectAction(page, 'previous');
        await page.getByRole('button', { name: 'Run action' }).click();
        expect(
          await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).isChecked(),
        ).toBe(true);
        await page.getByRole('button', { name: 'Close scan review' }).click();
        expect(await page.locator('dialog').isVisible()).toBe(false);
      } finally {
        await page.close();
      }
    });
  it('uses the chosen check budget only for explicit selected checks and freezes it while busy', async () => {
    const page = await fixture(true);
    try {
      await scan(page);
      await selectAction(page, 'options');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page
        .locator('.scan-options')
        .evaluate((el) => ((el as HTMLDetailsElement).open = true));
      await page.getByLabel('Channel check time', { exact: true }).selectOption('60000');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      expect(
        await page.evaluate(() => (window as unknown as { probeBudgets: number[] }).probeBudgets),
      ).toEqual([]);
      await page.evaluate(() => {
        (window as unknown as { probeMode: string }).probeMode = 'blocked';
      });
      await selectAction(page, 'check');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.waitForFunction(
        () => (window as unknown as { probeBudgets: number[] }).probeBudgets.length === 1,
      );
      expect(await page.getByLabel('Channel check time', { exact: true }).isDisabled()).toBe(true);
      expect(
        await page.evaluate(() => (window as unknown as { probeBudgets: number[] }).probeBudgets),
      ).toEqual([60000]);
      await selectAction(page, 'cancel');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.waitForFunction(
        () => (window as unknown as { closedProbes: number }).closedProbes === 1,
      );
      expect(await page.getByLabel('Select Alpha 0', { exact: true }).isChecked()).toBe(true);
      expect(
        await page.evaluate(() => (window as unknown as { commits: unknown[] }).commits),
      ).toEqual([]);
    } finally {
      await page.close();
    }
  });
  it('rejects a changed selected candidate before any probe or guide enrichment', async () => {
    const page = await fixture(true);
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await page.evaluate(() => {
        (window as unknown as { collectMode: string }).collectMode = 'shift';
      });
      await selectAction(page, 'guides');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (button) =>
            button.getAttribute('aria-label') === 'Scan configured sources' && !button.disabled,
        ),
      );
      expect(await page.evaluate(() => (window as unknown as { probes: string[] }).probes)).toEqual(
        [],
      );
      expect(await page.getByRole('button', { name: 'Save selected channels' }).isDisabled()).toBe(
        true,
      );
      expect(await page.locator('[aria-label="Candidate channels"]').textContent()).toContain(
        'Alpha 0',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'guideReviews').length)).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('automatic checks do not publish; optional selected guide suggestions require review', async () => {
    const page = await fixture(true);
    try {
      await scan(page);
      expect(await page.evaluate(() => (window as unknown as { probes: string[] }).probes)).toEqual(
        [],
      );
      await page.getByRole('checkbox', { name: 'Select Alpha 2', exact: true }).check();
      await selectAction(page, 'guides');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.getByRole('button', { name: 'Review guide mapping' }).first().waitFor();
      expect(await page.locator('[aria-label="Candidate channels"]').textContent()).toContain(
        'Responded',
      );
      expect(await page.locator('[aria-label="Candidate channels"]').textContent()).not.toContain(
        'PlayedHere',
      );
      expect(await page.locator('[aria-label="Candidate channels"]').textContent()).toContain(
        'no mapping saved',
      );
      expect(
        await page.evaluate(() => (window as unknown as { commits: unknown[] }).commits),
      ).toEqual([]);
      await page.getByRole('button', { name: 'Review guide mapping' }).first().click();
      expect(
        await page.evaluate(
          () => (window as unknown as { guideReviews: string[] }).guideReviews.length,
        ),
      ).toBe(1);
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Selected channels saved.', { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });
  it('cancels owned pipeline probes, waits for their cleanup and gates publication', async () => {
    const page = await fixture(true);
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 2', exact: true }).check();
      await page.evaluate(() => {
        (window as unknown as { probeMode: string }).probeMode = 'blocked';
      });
      await selectAction(page, 'check');
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.waitForFunction(
        () => (window as unknown as { probes: string[] }).probes.length === 1,
      );
      await page.getByRole('button', { name: 'Run action' }).click();
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (button) =>
            button.getAttribute('aria-label') === 'Scan configured sources' && !button.disabled,
        ),
      );
      expect(
        await page.evaluate(() => (window as unknown as { closedProbes: number }).closedProbes),
      ).toBe(1);
      expect(await page.getByRole('button', { name: 'Save selected channels' }).isDisabled()).toBe(
        true,
      );
      expect(await page.locator('[aria-label="Candidate channels"]').textContent()).toContain(
        'Responded',
      );
    } finally {
      await page.close();
    }
  });
  it('reviews an unpersisted draft without importing all of its candidates', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        (window as unknown as { scan: { open(sources: unknown[]): void } }).scan.open([
          {
            source: {
              id: 'draft',
              name: 'New source',
              kind: 'url',
              location: 'https://fixture.invalid/draft',
            },
            fingerprint: 'draft-revision',
          },
        ]);
      });
      await scan(page);
      expect(
        await page.evaluate(() => (window as unknown as { commits: unknown[] }).commits.length),
      ).toBe(0);
      expect(await page.locator('[aria-label="Candidate channels"]').textContent()).toContain(
        'Not checked',
      );
      expect(await page.getByRole('button', { name: 'Check selected channels' }).isVisible()).toBe(
        false,
      );
      await page.getByRole('checkbox', { name: 'Select Alpha 2', exact: true }).check();
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Selected channels saved.', { exact: true }).waitFor();
      const saved = await page.evaluate(
        () =>
          (
            window as unknown as {
              commits: Array<{
                staged: { sources: Array<{ sourceId: string; candidates: unknown[] }> };
              }>;
            }
          ).commits[0].staged.sources,
      );
      expect(saved.map((entry) => entry.sourceId)).toEqual(['draft']);
      expect(saved[0].candidates).toHaveLength(1);
    } finally {
      await page.close();
    }
  });
  it('bounds results, renders source data inertly and saves only selected source provenance', async () => {
    const page = await fixture();
    try {
      await scan(page);
      expect(await page.locator('[aria-label="Candidate channels"] li').count()).toBe(50);
      expect(await page.locator('img').count()).toBe(0);
      await page.getByRole('checkbox', { name: 'Select Alpha 1', exact: true }).check();
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Selected channels saved.', { exact: true }).waitFor();
      const records = await page.evaluate(
        () =>
          (
            window as unknown as {
              commits: Array<{
                staged: {
                  sources: Array<{ sourceId: string; candidates: Array<{ name: string }> }>;
                  failedSourceIds: string[];
                };
              }>;
            }
          ).commits,
      );
      expect(records[0].staged.sources[0].sourceId).toBe('a');
      expect(records[0].staged.sources[0].candidates.map((entry) => entry.name)).toEqual([
        'Alpha 1',
      ]);
      expect(records[0].staged.failedSourceIds).toEqual(['b']);
    } finally {
      await page.close();
    }
  });
  it('cancellation waits for readers and refuses a canceled review save', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        (window as unknown as { collectMode: string }).collectMode = 'blocked';
      });
      await page.getByRole('button', { name: 'Scan configured sources' }).click();
      await page.getByRole('button', { name: 'Cancel operation', exact: true }).click();
      await page.getByText('Scan canceled. Existing channels retained.', { exact: true }).waitFor();
      expect(
        await page.evaluate(() => (window as unknown as { closedReaders: number }).closedReaders),
      ).toBe(2);
      expect(await page.getByRole('button', { name: 'Save selected channels' }).isDisabled()).toBe(
        true,
      );
    } finally {
      await page.close();
    }
  });
  it('failed durable publication retains chosen preview and permits retry', async () => {
    const page = await fixture();
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await page.evaluate(() => {
        (window as unknown as { commitMode: string }).commitMode = 'fail';
      });
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Review retained.', { exact: true }).waitFor();
      expect(
        await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).isChecked(),
      ).toBe(true);
      expect(await page.getByRole('button', { name: 'Save selected channels' }).isDisabled()).toBe(
        false,
      );
      await page.evaluate(() => {
        (window as unknown as { commitMode: string }).commitMode = 'normal';
      });
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Selected channels saved.', { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });
  it('stale catalog revisions fail before commit without clearing preview', async () => {
    const page = await fixture();
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await page.evaluate(() => {
        (window as unknown as { revision: string }).revision = 'newer-review';
      });
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Review retained.', { exact: true }).waitFor();
      expect(
        await page.evaluate(() => (window as unknown as { commits: unknown[] }).commits.length),
      ).toBe(0);
    } finally {
      await page.close();
    }
  });
  it('acknowledged commit is owned until settlement and Escape cannot undo it', async () => {
    const page = await fixture();
    try {
      await scan(page);
      await page.getByRole('checkbox', { name: 'Select Alpha 0', exact: true }).check();
      await page.evaluate(() => {
        (window as unknown as { commitMode: string }).commitMode = 'blocked';
      });
      await page.getByRole('button', { name: 'Save selected channels' }).click();
      await page.getByText('Saving reviewed selection…', { exact: true }).waitFor();
      expect(await page.getByRole('button', { name: 'Run action' }).isDisabled()).toBe(true);
      await page.keyboard.press('Escape');
      expect(await page.getByRole('dialog', { name: 'Review source scan' }).isVisible()).toBe(true);
      await page.evaluate(() =>
        (window as unknown as { resolveCommit: () => void }).resolveCommit(),
      );
      await page.getByText('Selected channels saved.', { exact: true }).waitFor();
    } finally {
      await page.close();
    }
  });
});
