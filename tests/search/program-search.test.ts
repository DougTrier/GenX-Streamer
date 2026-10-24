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

import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdir } from 'node:fs/promises';
import { build } from 'vite';
import { chromium, type Browser } from '@playwright/test';
import {
  groupSearchPrograms,
  matchedSearchChannels,
  searchProgramWatchable,
  type ProgramSearchSnapshot,
} from '../../src/ui/guide/program-search';
import type { MappedProgram, SelectedGuideSummary } from '../../src/guide/native';
import { readStylesheet } from '../support/stylesheet';
const at = 1_000_000;
const channel = { id: 'one', sourceId: 'catalog', name: 'Néws—HD', category: 'Local' };
const mapping = {
  catalogSourceId: 'catalog',
  appChannelId: 'one',
  guideSourceId: 'guide',
  xmltvChannelId: 'provider',
};
const snapshot: ProgramSearchSnapshot = {
  revision: 'scope-1',
  catalogRevision: '1',
  channels: [channel],
  mappings: [mapping],
};
const program: MappedProgram = {
  ...mapping,
  startMs: at - 1000,
  stopMs: at + 60_000,
  title: 'Now <script>',
  description: 'Safe description',
  ordinal: 1,
};
const summary = (overrides: Partial<SelectedGuideSummary> = {}): SelectedGuideSummary => ({
  ...mapping,
  catalogRevision: '1',
  databaseRevision: 1,
  atMs: at,
  requestId: 'request',
  mappingStatus: 'mapped',
  mapping,
  sourceRevision: 1,
  publishedRevision: 1,
  updatedMs: at,
  coverage: { startMs: at - 1000, endMs: at + 60_000 },
  cacheStatus: 'current',
  currentStatus: 'current',
  nextStatus: 'none',
  current: { title: program.title, startMs: program.startMs, stopMs: program.stopMs },
  next: null,
  ...overrides,
});
it('uses normalized Unicode word tokens rather than requiring punctuation in channel names', () => {
  expect(matchedSearchChannels([channel], 'ＮÉWS / local')).toEqual([channel]);
  expect(matchedSearchChannels([channel], 'sports')).toEqual([]);
});
it('classifies known current, upcoming and unknown-end listings independently of decoder state', () => {
  expect(
    groupSearchPrograms(
      [
        program,
        { ...program, startMs: at + 1000, stopMs: at + 2000 },
        { ...program, stopMs: null },
      ],
      snapshot,
      at,
    ).map((entry) => entry.timing),
  ).toEqual(['now', 'upcoming', 'unknown']);
});
it('refuses foreign mappings, repeated identities, ended and out-of-window listings', () => {
  expect(() =>
    groupSearchPrograms([{ ...program, xmltvChannelId: 'other' }], snapshot, at),
  ).toThrow();
  expect(() =>
    groupSearchPrograms([program], { ...snapshot, mappings: [mapping, mapping] }, at),
  ).toThrow();
  expect(() => groupSearchPrograms([{ ...program, stopMs: at }], snapshot, at)).toThrow();
  expect(() =>
    groupSearchPrograms([{ ...program, startMs: at + 7 * 86400000, stopMs: null }], snapshot, at),
  ).toThrow();
  expect(() =>
    groupSearchPrograms(
      Array.from({ length: 51 }, () => program),
      snapshot,
      at,
    ),
  ).toThrow();
});
it('allows program Watch only with fresh exact current catalog/mapping/title/time evidence', () => {
  const entry = groupSearchPrograms([program], snapshot, at)[0];
  expect(searchProgramWatchable(entry, summary(), snapshot, at)).toBe(true);
  for (const value of [
    summary({ cacheStatus: 'stale' }),
    summary({ catalogRevision: '2' }),
    summary({ appChannelId: 'other' }),
    summary({ current: { ...summary().current!, title: 'Other' } }),
  ])
    expect(searchProgramWatchable(entry, value, snapshot, at)).toBe(false);
  expect(searchProgramWatchable(entry, summary(), snapshot, at + 60_000)).toBe(false);
});
it('omits absent saved channels and their ambiguous mappings without poisoning an admitted listing', () => {
  const absentMapping = { ...mapping, appChannelId: 'removed' };
  const entries = groupSearchPrograms(
    [program, { ...program, appChannelId: 'removed' }],
    { ...snapshot, mappings: [mapping, absentMapping, absentMapping] },
    at,
  );
  expect(entries).toHaveLength(1);
  expect(entries[0].channel.id).toBe(channel.id);
  expect(
    searchProgramWatchable(entries[0], summary({ appChannelId: 'removed' }), snapshot, at),
  ).toBe(false);
});

let browser: Browser, bundle: string, css: string;
beforeAll(async () => {
  const output = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry: 'src/ui/guide/program-search.ts', formats: ['iife'], name: 'SearchUI' },
    },
  });
  const result = Array.isArray(output) ? output[0] : output;
  if (!result || !('output' in result)) throw new Error('Missing bundle');
  const chunk = result.output.find((entry) => entry.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error('Missing chunk');
  bundle = chunk.code;
  css = (
    await Promise.all(
      [
        'style',
        'management',
        'program-search',
        'guide',
        'guide-timeline',
        'responsive',
        'in-app-select',
        'modal-viewport',
      ].map((name) => readStylesheet(`src/ui/${name}.css`)),
    )
  ).join('\n');
  browser = await chromium.launch({
    headless: true,
    executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  });
});
afterAll(async () => {
  await browser?.close();
});
async function fixture(
  width = 960,
  height = 540,
  held = false,
  presentation: 'modal' | 'page' = 'modal',
  heldWatch = false,
  autoOpen = true,
) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.route('http://localhost/**', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<button id="open">Search opener</button><main id="mount"></main>',
    }),
  );
  await page.goto('http://localhost/search-fixture');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(
    ({ snapshot, program, at, held, presentation, heldWatch, autoOpen }) => {
      const scope = window as unknown as {
        SearchUI: typeof import('../../src/ui/guide/program-search');
        owner: ReturnType<typeof import('../../src/ui/guide/program-search').mountProgramSearch>;
        queries: number;
        activeQueries: number;
        peak: number;
        watches: number;
        voiceReturns: number;
        release(): void;
        closeSettled: boolean;
        closeWork: Promise<void>;
        revision: string;
        cancelCalls: number;
        failClosed?: boolean;
        holdClosed?: boolean;
        releaseClosed?: () => void;
      };
      scope.queries = scope.activeQueries = scope.peak = scope.watches = scope.voiceReturns = 0;
      scope.cancelCalls = 0;
      scope.revision = snapshot.revision;
      let release!: () => void;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      scope.release = release;
      scope.owner = scope.SearchUI.mountProgramSearch(document.querySelector('#mount')!, {
        presentation,
        snapshot: async () => snapshot,
        current: (captured) => captured.revision === scope.revision,
        now: () => at,
        formatTime: (ms) => new Date(ms).toLocaleTimeString(),
        query: async (query, signal) => {
          // Native context queries require one channel, one feed and no text search.
          if (query.contextAtMs !== undefined) throw new Error('guide-invalid-context-scope');
          if (query.guideSourceId !== '' || query.appChannelIds.length !== 0)
            throw new Error('Unexpected grouped search scope');
          scope.queries++;
          scope.activeQueries++;
          scope.peak = Math.max(scope.peak, scope.activeQueries);
          try {
            if (held) await pending;
            signal.throwIfAborted();
            return {
              programs: [
                program,
                {
                  ...program,
                  title: 'Future listing',
                  startMs: at + 3600000,
                  stopMs: at + 7200000,
                },
              ],
              nextCursor: null,
              sourceRevision: 1,
              databaseRevision: 1,
            };
          } finally {
            scope.activeQueries--;
          }
        },
        summary: async (query) => ({
          ...query,
          catalogRevision: '1',
          databaseRevision: 1,
          mappingStatus: 'mapped',
          mapping: snapshot.mappings[0],
          sourceRevision: 1,
          publishedRevision: 1,
          updatedMs: at,
          coverage: { startMs: program.startMs, endMs: program.stopMs },
          cacheStatus: 'current',
          currentStatus: 'current',
          nextStatus: 'none',
          current: { title: program.title, startMs: program.startMs, stopMs: program.stopMs },
          next: null,
        }),
        watch: async () => {
          scope.watches++;
          if (heldWatch) await pending;
        },
        opened: async ({ voiceSlot }) => {
          const button = document.createElement('button');
          button.setAttribute('aria-label', 'Voice search');
          button.title = 'Voice search';
          button.style.cssText = 'width:44px;height:44px;padding:10px;flex:none';
          button.innerHTML =
            '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3" fill="currentColor"/><path d="M5 10v2a7 7 0 0014 0v-2M12 19v3M8 22h8" fill="none" stroke="currentColor" stroke-width="2"/></svg>';
          voiceSlot.append(button);
        },
        closed: async () => {
          scope.voiceReturns++;
          if (scope.failClosed) throw new Error('controlled close acknowledgment failure');
          if (scope.holdClosed)
            await new Promise<void>((resolve) => {
              scope.releaseClosed = resolve;
            });
        },
        cancelVoice: async () => {
          scope.cancelCalls++;
        },
      });
      document.querySelector<HTMLElement>('#open')!.focus();
      if (autoOpen) scope.owner.open();
    },
    { snapshot, program, at, held, presentation, heldWatch, autoOpen },
  );
  return page;
}
it('never-opened Close drains cancellation without retargeting speech or starting queries', async () => {
  const page = await fixture(960, 540, false, 'page', false, false);
  try {
    await page.evaluate(async () => {
      const owner = Reflect.get(window, 'owner');
      await owner.close();
      await owner.close();
    });
    expect(await page.evaluate(() => Reflect.get(window, 'voiceReturns'))).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'cancelCalls'))).toBe(2);
    expect(await page.evaluate(() => Reflect.get(window, 'queries'))).toBe(0);
    expect(
      await page.locator('.gx-program-search').evaluate((node) => (node as HTMLDialogElement).open),
    ).toBe(false);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('one presentation acknowledges close once across repeated Close and disposal', async () => {
  const page = await fixture(960, 540, false, 'page');
  try {
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'queries'))).toBe(1);
    await page.evaluate(async () => {
      const owner = Reflect.get(window, 'owner');
      await Promise.all([owner.close(), owner.close()]);
      await owner.close();
      await owner.dispose();
    });
    expect(await page.evaluate(() => Reflect.get(window, 'voiceReturns'))).toBe(1);
    expect(await page.locator('.gx-program-search').count()).toBe(0);
  } finally {
    await page.close();
  }
});
it('failed close acknowledgment stays retryable and a held retry prevents new presentation', async () => {
  const page = await fixture(960, 540, false, 'page');
  try {
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'queries'))).toBe(1);
    const failed = await page.evaluate(async () => {
      Reflect.set(window, 'failClosed', true);
      try {
        await Reflect.get(window, 'owner').close();
        return false;
      } catch {
        return true;
      }
    });
    expect(failed).toBe(true);
    expect(
      await page.locator('.gx-program-search').evaluate((node) => (node as HTMLDialogElement).open),
    ).toBe(true);
    await page.evaluate(() => {
      Reflect.set(window, 'failClosed', false);
      Reflect.set(window, 'holdClosed', true);
      Reflect.set(window, 'closeSettled', false);
      Reflect.set(
        window,
        'closeWork',
        Reflect.get(window, 'owner')
          .close()
          .then(() => Reflect.set(window, 'closeSettled', true)),
      );
    });
    await page.waitForFunction(() => typeof Reflect.get(window, 'releaseClosed') === 'function');
    await page.evaluate(() => Reflect.get(window, 'owner').open('must not restart'));
    expect(await page.evaluate(() => Reflect.get(window, 'queries'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'closeSettled'))).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'releaseClosed')());
    await page.evaluate(() => Reflect.get(window, 'closeWork'));
    await page.evaluate(() => Reflect.get(window, 'owner').close());
    expect(await page.evaluate(() => Reflect.get(window, 'voiceReturns'))).toBe(2);
    expect(
      await page.locator('.gx-program-search').evaluate((node) => (node as HTMLDialogElement).open),
    ).toBe(false);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('renders safe grouped loaded counts and future details cannot tune; Back returns the result focus', async () => {
  const page = await fixture();
  try {
    await expect.poll(() => page.getByRole('status').textContent()).toContain('2 listings loaded');
    expect(await page.locator('.gx-program-search script').count()).toBe(0);
    await page.getByRole('button', { name: /Future listing/ }).click();
    expect(
      await page.getByRole('button', { name: 'Watch channel', exact: true }).isDisabled(),
    ).toBe(true);
    await page.keyboard.press('Escape');
    expect(
      await page
        .getByRole('button', { name: /Future listing/ })
        .evaluate((node) => document.activeElement === node),
    ).toBe(true);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    await page.getByRole('button', { name: /Now <script>/ }).click();
    await mkdir('Screenshot/0.1.0/browser-program-search', { recursive: true });
    await page.screenshot({
      path: 'Screenshot/0.1.0/browser-program-search/fixture-wide-selected.png',
    });
    await page.getByRole('button', { name: 'Watch channel', exact: true }).click();
    await expect.poll(() => page.locator('.gx-program-search').isVisible()).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'voiceReturns'))).toBe(1);
  } finally {
    await page.close();
  }
});
it('page presentation keeps the outer navigation focusable and Close joins its actual query', async () => {
  const page = await fixture(960, 540, true, 'page');
  try {
    await page.waitForFunction(() => Reflect.get(window, 'queries') === 1);
    expect(await page.locator('#mount > dialog[data-primary-page="search"]').count()).toBe(1);
    await page.locator('#open').focus();
    expect(await page.locator('#open').evaluate((node) => document.activeElement === node)).toBe(
      true,
    );
    await page.evaluate(() => {
      Reflect.set(window, 'closeSettled', false);
      Reflect.set(
        window,
        'closeWork',
        Reflect.get(window, 'owner')
          .close()
          .then(() => Reflect.set(window, 'closeSettled', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'closeSettled'))).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'release')());
    await page.evaluate(() => Reflect.get(window, 'closeWork'));
    expect(await page.locator('.gx-program-search').isVisible()).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'voiceReturns'))).toBe(1);
  } finally {
    await page.close();
  }
});
it('a late accepted Watch cannot return the voice owner or close Search after detail Back', async () => {
  const page = await fixture(960, 540, false, 'page', true);
  try {
    await expect.poll(() => page.getByRole('status').textContent()).toContain('listings loaded');
    await page.getByRole('button', { name: /Now <script>/ }).click();
    await page.getByRole('button', { name: 'Watch channel', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
    await page.keyboard.press('Escape');
    await page.evaluate(() => Reflect.get(window, 'release')());
    await page.evaluate(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await page.evaluate(() => Reflect.get(window, 'voiceReturns'))).toBe(0);
    expect(await page.locator('.gx-program-search').isVisible()).toBe(true);
    expect(await page.locator('.gx-program-search-detail').isVisible()).toBe(false);
    await page.evaluate(() => Reflect.get(window, 'owner').close());
    expect(await page.evaluate(() => Reflect.get(window, 'voiceReturns'))).toBe(1);
  } finally {
    await page.close();
  }
});
it('joins held actual query on Close and serialized rapid searches never overlap', async () => {
  const page = await fixture(960, 540, true);
  try {
    await page.waitForFunction(() => Reflect.get(window, 'queries') === 1);
    await page.evaluate(() => {
      const owner = Reflect.get(window, 'owner');
      owner.search();
      owner.search();
      owner.search();
      Reflect.set(window, 'closeSettled', false);
      Reflect.set(
        window,
        'closeWork',
        owner.close().then(() => Reflect.set(window, 'closeSettled', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'closeSettled'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'queries'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'voiceReturns'))).toBe(0);
    await page.evaluate(() => Reflect.get(window, 'release')());
    await page.evaluate(() => Reflect.get(window, 'closeWork'));
    expect(await page.evaluate(() => Reflect.get(window, 'peak'))).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'activeQueries'))).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'voiceReturns'))).toBe(1);
    expect(await page.locator('#open').evaluate((node) => document.activeElement === node)).toBe(
      true,
    );
  } finally {
    await page.close();
  }
});
it('typing does not query on each key; final speech event searches once and suspend closes', async () => {
  const page = await fixture();
  try {
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'queries'))).toBe(1);
    await page.getByRole('searchbox').fill('news');
    expect(await page.evaluate(() => Reflect.get(window, 'queries'))).toBe(1);
    await page.getByRole('searchbox').dispatchEvent('speech-search-final');
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'queries'))).toBe(2);
    await page.evaluate(() => Reflect.get(window, 'owner').suspend());
    expect(await page.locator('.gx-program-search').isVisible()).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'voiceReturns'))).toBe(1);
  } finally {
    await page.close();
  }
});
for (const [width, height, scale] of [
  [960, 540, 1],
  [320, 640, 2],
  [640, 360, 2],
  [960, 300, 1],
] as const) {
  it(`all search controls stay visible with 44px targets at ${width}x${height} text ${scale}`, async () => {
    const page = await fixture(width, height);
    try {
      await expect.poll(() => page.getByRole('status').textContent()).toContain('listings loaded');
      await page.addStyleTag({ content: `html{font-size:${16 * scale}px}` });
      const metrics = await page.locator('.gx-program-search').evaluate((dialog) => {
        const r = dialog.getBoundingClientRect();
        const controls = [...dialog.querySelectorAll('header button,form button,form input')]
          .filter((node) => !node.closest('[hidden]'))
          .map((node) => {
            const rect = node.getBoundingClientRect();
            return {
              width: rect.width,
              height: rect.height,
              visible:
                rect.top >= 0 &&
                rect.bottom <= innerHeight &&
                rect.left >= 0 &&
                rect.right <= innerWidth,
            };
          });
        return {
          inBounds: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth,
          controls,
        };
      });
      expect(metrics.inBounds).toBe(true);
      for (const control of metrics.controls) {
        expect(control.width).toBeGreaterThanOrEqual(44);
        expect(control.height).toBeGreaterThanOrEqual(44);
        expect(control.visible, JSON.stringify(control)).toBe(true);
      }
      if (height <= 400)
        await page.locator('.gx-program-search-groups section button').first().focus();
      const rowMetrics = await page.locator('.gx-program-search-groups').evaluate((groups) => {
        const viewport = groups.getBoundingClientRect();
        const row = groups.querySelector('section button')!;
        const r = row.getBoundingClientRect();
        return {
          height: groups.clientHeight,
          rowTop: r.top - viewport.top,
          rowHeight: r.height,
          rowVisible: r.top >= viewport.top && r.bottom <= viewport.bottom,
          rowHit: row.contains(
            document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2),
          ),
        };
      });
      expect(rowMetrics.height).toBeGreaterThanOrEqual(44);
      expect(rowMetrics.rowVisible, JSON.stringify(rowMetrics)).toBe(true);
      expect(rowMetrics.rowHit).toBe(true);
      if (width === 320 && scale === 2) {
        await mkdir('Screenshot/0.1.0/browser-program-search', { recursive: true });
        await page.screenshot({
          path: 'Screenshot/0.1.0/browser-program-search/fixture-narrow-200.png',
        });
      }
    } finally {
      await page.close();
    }
  });
}
