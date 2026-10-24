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
 * Guide screen in a real browser: background suspension, cleanup receipts,
 * summaries and the foreground clock.
 */
import { describe, expect, it } from 'vitest';
import { useGuideUiBrowser, fixture, open, chooseGuide, dispose } from './guide-ui-browser.fixture';

useGuideUiBrowser();

describe('guide background suspension ownership', () => {
  it('aborts and drains a preview fetch, discarding a late ticket', async () => {
    const page = await fixture();
    try {
      await open(page);
      await chooseGuide(page, 'Guide view', 'sources');
      await page.getByLabel('Guide source name', { exact: true }).fill('New guide');
      await page.evaluate(() => {
        (window as unknown as { previewMode: string }).previewMode = 'blocked';
      });
      await page.getByRole('button', { name: 'Save source and preview' }).click();
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { resolvePreview?: () => void }).resolvePreview ===
          'function',
      );
      await page.evaluate(() => {
        const f = window as unknown as { guide: { suspend(): Promise<void> }; suspended?: boolean };
        f.suspended = false;
        void f.guide.suspend().then(() => {
          f.suspended = true;
        });
      });
      expect(
        await page.evaluate(
          () => (window as unknown as { previewSignal: AbortSignal }).previewSignal.aborted,
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() => (window as unknown as { suspended: boolean }).suspended),
      ).toBe(false);
      await page.evaluate(() => (window as unknown as { resolvePreview(): void }).resolvePreview());
      await page.waitForFunction(() => (window as unknown as { suspended: boolean }).suspended);
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { discard: string[] } }).calls.discard,
        ),
      ).toEqual(['ticket']);
      await chooseGuide(page, 'Guide source task', 'preview');
      expect(await page.getByRole('button', { name: 'Save reviewed schedule' }).isDisabled()).toBe(
        true,
      );
      expect(await page.locator('dialog').textContent()).toContain('Retry when ready');
    } finally {
      await dispose(page);
    }
  });
  it('drains a late query without rendering it or automatically restarting', async () => {
    const page = await fixture();
    try {
      await open(page);
      await page.evaluate(() => {
        const f = window as unknown as { mode: string; guide: { open(query?: string): void } };
        f.mode = 'blocked';
        f.guide.open('suspend-only-result');
      });
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { resolveQuery?: () => void }).resolveQuery === 'function',
      );
      await page.evaluate(() => {
        const f = window as unknown as { guide: { suspend(): Promise<void> }; suspended?: boolean };
        f.suspended = false;
        void f.guide.suspend().then(() => {
          f.suspended = true;
        });
      });
      expect(
        await page.evaluate(() => (window as unknown as { suspended: boolean }).suspended),
      ).toBe(false);
      const before = await page.evaluate(
        () => (window as unknown as { calls: { queries: unknown[] } }).calls.queries.length,
      );
      await page.evaluate(() => (window as unknown as { resolveQuery(): void }).resolveQuery());
      await page.waitForFunction(() => (window as unknown as { suspended: boolean }).suspended);
      expect(await page.locator('dialog').textContent()).toContain('Retry when ready');
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { queries: unknown[] } }).calls.queries.length,
        ),
      ).toBe(before);
      await page.evaluate(() => {
        const f = window as unknown as { mode: string; guide: { open(): void } };
        f.mode = 'normal';
        void Reflect.get(window, 'guide')
          .setForeground(true)
          .then(() => f.guide.open());
      });
      await page.waitForFunction(
        (count) =>
          (window as unknown as { calls: { queries: unknown[] } }).calls.queries.length > count,
        before,
      );
    } finally {
      await dispose(page);
    }
  });
  it('retains a reviewed preview and waits crossed publication without aborting it', async () => {
    const page = await fixture();
    try {
      await open(page);
      await chooseGuide(page, 'Guide view', 'sources');
      await page.getByLabel('Guide source name', { exact: true }).fill('Reviewed guide');
      await page.getByRole('button', { name: 'Save source and preview' }).click();
      await chooseGuide(page, 'Guide source task', 'preview');
      await page.waitForFunction(() =>
        [...document.querySelectorAll('button')].some(
          (b) => b.textContent === 'Save reviewed schedule' && !b.disabled,
        ),
      );
      await page.evaluate(() =>
        (window as unknown as { guide: { suspend(): Promise<void> } }).guide.suspend(),
      );
      expect(await page.getByRole('button', { name: 'Save reviewed schedule' }).isEnabled()).toBe(
        true,
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { discard: string[] } }).calls.discard.length,
        ),
      ).toBe(0);
      await page.evaluate(() => {
        (window as unknown as { commitMode: string }).commitMode = 'blocked';
        return Reflect.get(window, 'guide').setForeground(true);
      });
      await page.getByRole('button', { name: 'Save reviewed schedule' }).click();
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { resolveCommit?: () => void }).resolveCommit === 'function',
      );
      const before = await page.evaluate(
        () => (window as unknown as { calls: { sources: number } }).calls.sources,
      );
      await page.evaluate(() => {
        const f = window as unknown as { guide: { suspend(): Promise<void> }; suspended?: boolean };
        f.suspended = false;
        void f.guide.suspend().then(() => {
          f.suspended = true;
        });
      });
      expect(
        await page.evaluate(() => (window as unknown as { suspended: boolean }).suspended),
      ).toBe(false);
      await page.evaluate(() => (window as unknown as { resolveCommit(): void }).resolveCommit());
      await page.waitForFunction(() => (window as unknown as { suspended: boolean }).suspended);
      expect(await page.locator('dialog').textContent()).toContain(
        'Reviewed guide schedule saved.',
      );
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { sources: number } }).calls.sources,
        ),
      ).toBe(before);
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { commits: string[] } }).calls.commits,
        ),
      ).toEqual(['ticket']);
    } finally {
      await dispose(page);
    }
  });
});
describe('guide terminal cleanup receipt', () => {
  it('retains an unconfirmed preview and waits retried discard before removing its dialog', async () => {
    const page = await fixture();
    try {
      await open(page);
      await chooseGuide(page, 'Guide view', 'sources');
      await page.getByLabel('Guide source name', { exact: true }).fill('Owned preview');
      await page.getByRole('button', { name: 'Save source and preview' }).click();
      await chooseGuide(page, 'Guide source task', 'preview');
      await expect
        .poll(() => page.getByRole('button', { name: 'Save reviewed schedule' }).isEnabled())
        .toBe(true);
      await page.evaluate(() => {
        const f = window as unknown as {
          discardMode: string;
          failed: boolean;
          guide: { dispose(): Promise<void> };
        };
        f.discardMode = 'fail';
        f.failed = false;
        void f.guide.dispose().catch(() => {
          f.failed = true;
        });
      });
      await page.waitForFunction(() => (window as unknown as { failed: boolean }).failed);
      expect(await page.locator('dialog').count()).toBe(1);
      expect(await page.locator('dialog').textContent()).toContain('2 guide channels');
      await page.evaluate(() => {
        const f = window as unknown as {
          discardMode: string;
          finished: boolean;
          samePromise: boolean;
          guide: { dispose(): Promise<void>; open(): void };
        };
        f.discardMode = 'blocked';
        f.finished = false;
        const work = f.guide.dispose();
        f.samePromise = work === f.guide.dispose();
        void work.then(() => {
          f.finished = true;
        });
        f.guide.open();
      });
      await page.waitForFunction(
        () =>
          typeof (window as unknown as { resolveDiscard?: () => void }).resolveDiscard ===
          'function',
      );
      expect(await page.evaluate(() => (window as unknown as { finished: boolean }).finished)).toBe(
        false,
      );
      expect(
        await page.evaluate(() => (window as unknown as { samePromise: boolean }).samePromise),
      ).toBe(true);
      expect(await page.locator('dialog').count()).toBe(1);
      await page.evaluate(() => (window as unknown as { resolveDiscard(): void }).resolveDiscard());
      await page.waitForFunction(() => (window as unknown as { finished: boolean }).finished);
      expect(await page.locator('dialog').count()).toBe(0);
      expect(
        await page.evaluate(
          () => (window as unknown as { calls: { discard: string[] } }).calls.discard,
        ),
      ).toEqual(['ticket', 'ticket']);
    } finally {
      await page.close();
    }
  });
});
it('foreground return joins pending background cleanup then restores the open timeline', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => Reflect.set(window, 'mode', 'blocked'));
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    await page.waitForFunction(() => typeof Reflect.get(window, 'resolveQuery') === 'function');
    await page.evaluate(() => {
      const guide = Reflect.get(window, 'guide');
      Reflect.set(window, 'resumed', false);
      void guide.suspend();
      const first = guide.setForeground(true);
      Reflect.set(window, 'sameResume', first === guide.setForeground(true));
      void first.then(() => Reflect.set(window, 'resumed', true));
      guide.open();
    });
    expect(await page.evaluate(() => Reflect.get(window, 'resumed'))).toBe(false);
    expect(await page.evaluate(() => Reflect.get(window, 'sameResume'))).toBe(true);
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'normal');
      Reflect.get(window, 'resolveQuery')();
    });
    await page.waitForFunction(() => Reflect.get(window, 'resumed'));
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(1);
    expect(await page.locator('.guide-feedback').textContent()).not.toContain(
      'paused in the background',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
    await page.getByRole('button', { name: 'FOX Chicago', exact: true }).click();
    await expect.poll(() => page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(1);
  } finally {
    await dispose(page);
  }
});
it('a renewed background signal while cleanup is pending prevents a queued Guide resume', async () => {
  const page = await fixture(false, true);
  try {
    await page.evaluate(() => Reflect.set(window, 'mode', 'blocked'));
    await page.evaluate(() => Reflect.get(window, 'guide').open());
    await page.waitForFunction(() => typeof Reflect.get(window, 'resolveQuery') === 'function');
    await page.evaluate(() => {
      const guide = Reflect.get(window, 'guide');
      void guide.suspend();
      Reflect.set(window, 'resumed', false);
      void guide.setForeground(true).then(() => Reflect.set(window, 'resumed', true));
      void guide.setForeground(false);
      Reflect.set(window, 'mode', 'normal');
      Reflect.get(window, 'resolveQuery')();
    });
    await page.waitForFunction(() => Reflect.get(window, 'resumed'));
    expect(await page.locator('.gx-timeline-row').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').queries.length)).toBe(1);
    await page.evaluate(() => Reflect.get(window, 'guide').setForeground(true));
    await expect.poll(() => page.locator('.gx-timeline-row').count()).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'calls').watch.length)).toBe(0);
  } finally {
    await dispose(page);
  }
});
describe('complete Guide summary and foreground clock ownership', () => {
  it('uses complete overlap status instead of fifty duplicate page entries, and missing adapters never infer Now', async () => {
    const page = await fixture();
    try {
      await page.evaluate(() => {
        Reflect.set(window, 'summaryMode', 'overlap');
        const owner = Reflect.get(window, 'host');
        owner.query = async () => ({
          programs: Array.from({ length: 50 }, () => ({
            catalogSourceId: 'catalog',
            appChannelId: 'fox',
            guideSourceId: 'guide',
            xmltvChannelId: 'wfld',
            startMs: 1699999999000,
            stopMs: 1700000100000,
            title: 'Current <img src=x>',
            description: 'Same duplicate',
            ordinal: 0,
          })),
          nextCursor: null,
          sourceRevision: 1,
          databaseRevision: 1,
        });
      });
      await open(page);
      await expect
        .poll(() => page.locator('.guide-coverage:not(.guide-search-options)').textContent())
        .toContain('Current listings overlap');
      await page
        .getByRole('button', { name: /Current <img/ })
        .first()
        .click();
      expect(await page.getByRole('button', { name: 'Watch channel' }).count()).toBe(0);
      await page.keyboard.press('Escape');
      await page.evaluate(() => {
        Reflect.get(window, 'host').summary = undefined;
        Reflect.get(window, 'guide').catalogChanged(true);
      });
      await expect
        .poll(() => page.locator('.guide-coverage:not(.guide-search-options)').textContent())
        .toContain('Current / next unavailable');
      expect(
        await page.locator('.guide-coverage:not(.guide-search-options)').textContent(),
      ).not.toContain('Now:');
    } finally {
      await dispose(page);
    }
  });
  it('updates live labels/detail eligibility at boundaries, preserves focus, and Back returns details before closing', async () => {
    const page = await fixture(true);
    try {
      await open(page);
      await expect
        .poll(() => page.locator('.guide-coverage:not(.guide-search-options)').textContent())
        .toContain('Now: Current');
      const queries = await page.evaluate(() => Reflect.get(window, 'calls').queries.length);
      await page.getByRole('button', { name: /Current <img/ }).click();
      await page.getByRole('button', { name: 'Watch channel' }).focus();
      await page.evaluate(() => Reflect.get(window, 'advanceClock')(100000));
      await expect
        .poll(() => page.locator('.guide-detail-panel').textContent())
        .toContain('This listing has ended');
      expect(await page.getByRole('button', { name: 'Watch channel' }).isDisabled()).toBe(true);
      expect(
        await page
          .getByRole('button', { name: 'Back to programs' })
          .evaluate((button) => button === document.activeElement),
      ).toBe(true);
      await page.keyboard.press('Escape');
      expect(
        await page.locator('dialog').evaluate((dialog) => (dialog as HTMLDialogElement).open),
      ).toBe(true);
      expect(
        await page
          .getByRole('button', { name: /Current <img/ })
          .evaluate((button) => button === document.activeElement),
      ).toBe(true);
      await page.getByRole('button', { name: /Chicago Bears/ }).click();
      expect(await page.getByRole('button', { name: 'Watch channel' }).count()).toBe(0);
      await page.evaluate(() => Reflect.get(window, 'advanceClock')(100000));
      await expect.poll(() => page.getByRole('button', { name: 'Watch channel' }).count()).toBe(1);
      expect(await page.getByRole('button', { name: 'Watch channel' }).isEnabled()).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'calls').watch)).toEqual([]);
      expect(await page.evaluate(() => Reflect.get(window, 'calls').queries.length)).toBe(queries);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expect
        .poll(() => page.locator('dialog').evaluate((dialog) => (dialog as HTMLDialogElement).open))
        .toBe(false);
    } finally {
      await dispose(page);
    }
  });
  it('keeps search timing a snapshot while current-event details obtain their own exact channel summary', async () => {
    const page = await fixture(true);
    try {
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        host.channels = () => [
          { id: 'fox', sourceId: 'catalog', name: 'FOX Chicago' },
          { id: 'other', sourceId: 'catalog2', name: 'Other channel' },
        ];
        const mappings = host.mappings;
        host.mappings = async (signal: AbortSignal) => [
          ...(await mappings(signal)),
          {
            catalogSourceId: 'catalog2',
            appChannelId: 'other',
            guideSourceId: 'guide',
            xmltvChannelId: 'wfld',
          },
        ];
        host.query = async () => ({
          programs: [
            {
              catalogSourceId: 'catalog2',
              appChannelId: 'other',
              guideSourceId: 'guide',
              xmltvChannelId: 'wfld',
              startMs: 1699999999000,
              stopMs: 1700000100000,
              title: 'Current <img src=x>',
              description: 'Search current',
              ordinal: 0,
            },
          ],
          nextCursor: null,
          sourceRevision: 1,
          databaseRevision: 1,
        });
      });
      await open(page, 'current');
      expect(await page.getByRole('button', { name: /Current <img/ }).textContent()).toContain(
        'As of',
      );
      await page.getByRole('button', { name: /Current <img/ }).click();
      await expect.poll(() => page.getByRole('button', { name: 'Watch channel' }).count()).toBe(1);
      const before = await page.evaluate(() => Reflect.get(window, 'summaryCalls').length);
      await page.evaluate(() => Reflect.get(window, 'guide').catalogChanged());
      expect(
        await page
          .getByRole('button', { name: 'Watch channel' })
          .evaluate((button) => !(button as HTMLButtonElement).hidden),
      ).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'summaryCalls').length)).toBe(before);
      await page.getByRole('button', { name: 'Watch channel' }).click();
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'calls').watch.length))
        .toBe(1);
      expect(await page.evaluate(() => Reflect.get(window, 'calls').watch[0].id)).toBe('other');
    } finally {
      await dispose(page);
    }
  });
  it('joins canceled summary work, resumes once with fresh metadata, and never publishes a late old summary', async () => {
    const page = await fixture(true);
    try {
      await page.evaluate(() => Reflect.set(window, 'summaryMode', 'blocked'));
      await open(page);
      await page.waitForFunction(() => !!Reflect.get(window, 'resolveSummary'));
      await page.evaluate(() => {
        Reflect.set(window, 'suspended', false);
        void Reflect.get(window, 'guide')
          .setForeground(false)
          .then(() => Reflect.set(window, 'suspended', true));
      });
      expect(await page.evaluate(() => Reflect.get(window, 'summarySignal').aborted)).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'suspended'))).toBe(false);
      const before = await page.evaluate(() => Reflect.get(window, 'summaryCalls').length);
      await page.evaluate(() => Reflect.get(window, 'resolveSummary')());
      await page.waitForFunction(() => Reflect.get(window, 'suspended'));
      expect(
        await page.locator('.guide-coverage:not(.guide-search-options)').textContent(),
      ).not.toContain('Now:');
      await page.evaluate(() => {
        Reflect.set(window, 'summaryMode', 'normal');
        return Reflect.get(window, 'guide').setForeground(true);
      });
      await expect
        .poll(() => page.locator('.guide-coverage:not(.guide-search-options)').textContent())
        .toContain('Now: Current');
      expect(await page.evaluate(() => Reflect.get(window, 'summaryCalls').length)).toBe(
        before + 1,
      );
      await page.evaluate(() => Reflect.get(window, 'guide').setForeground(true));
      expect(await page.evaluate(() => Reflect.get(window, 'summaryCalls').length)).toBe(
        before + 1,
      );
    } finally {
      await dispose(page);
    }
  });
});
it('suppresses delayed pre-remap metadata under an unchanged catalog revision and refreshes only the new exact mapping', async () => {
  const page = await fixture(true);
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'summaryMode', 'blocked');
      Reflect.set(window, 'summaryTitle', 'Old regional');
      Reflect.set(window, 'xmltvId', 'wfld');
      const host = Reflect.get(window, 'host'),
        original = host.summary;
      host.summary = async (query: unknown, signal: AbortSignal) => {
        const title = Reflect.get(window, 'summaryTitle'),
          xmltv = Reflect.get(window, 'xmltvId');
        const value = await original(query, signal);
        return {
          ...value,
          mapping: { ...value.mapping, xmltvChannelId: xmltv },
          current: { ...value.current, title },
        };
      };
    });
    await open(page);
    await page.waitForFunction(() => !!Reflect.get(window, 'resolveSummary'));
    await page.evaluate(() => {
      Reflect.set(window, 'summaryMode', 'normal');
      Reflect.set(window, 'summaryTitle', 'New regional');
      Reflect.set(window, 'xmltvId', 'wfld2');
      const host = Reflect.get(window, 'host');
      host.mappings = async () => [
        {
          catalogSourceId: 'catalog',
          appChannelId: 'fox',
          guideSourceId: 'guide',
          xmltvChannelId: 'wfld2',
        },
      ];
      const original = host.query;
      host.query = async (query: unknown, signal: AbortSignal) => {
        const value = await original(query, signal);
        return {
          ...value,
          programs: value.programs.map((p: Record<string, unknown>) => ({
            ...p,
            xmltvChannelId: 'wfld2',
          })),
        };
      };
      Reflect.get(window, 'guide').catalogChanged(true);
    });
    expect(await page.evaluate(() => Reflect.get(window, 'summarySignal').aborted)).toBe(true);
    expect(
      await page.locator('.guide-coverage:not(.guide-search-options)').textContent(),
    ).not.toContain('Old regional');
    await page.evaluate(() => Reflect.get(window, 'resolveSummary')());
    await expect
      .poll(() => page.locator('.guide-coverage:not(.guide-search-options)').textContent())
      .toContain('Now: New regional');
    expect(
      await page.locator('.guide-coverage:not(.guide-search-options)').textContent(),
    ).not.toContain('Old regional');
  } finally {
    await dispose(page);
  }
});
it('refuses false summary cleanup acknowledgment and retries the retained cancellation before terminal disposal', async () => {
  const page = await fixture(true);
  try {
    await page.evaluate(() => {
      const host = Reflect.get(window, 'host');
      host.summary = async (_query: unknown, signal: AbortSignal) => {
        await new Promise((resolve) => Reflect.set(window, 'resolveSummary', resolve));
        if (signal.aborted) throw new Error('Unconfirmed cancellation fixture');
        throw new Error('No fixture response');
      };
      Reflect.set(window, 'cancelFail', true);
    });
    await open(page);
    await page.waitForFunction(() => !!Reflect.get(window, 'resolveSummary'));
    await page.evaluate(() => {
      Reflect.set(window, 'drainResult', 'pending');
      void Reflect.get(window, 'guide')
        .suspend()
        .then(
          () => Reflect.set(window, 'drainResult', 'passed'),
          () => Reflect.set(window, 'drainResult', 'failed'),
        );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'drainResult'))).toBe('pending');
    await page.evaluate(() => Reflect.get(window, 'resolveSummary')());
    await page.waitForFunction(() => Reflect.get(window, 'drainResult') === 'failed');
    const refused = await page.evaluate(async () => {
      try {
        await Reflect.get(window, 'guide').dispose();
        return false;
      } catch {
        return true;
      }
    });
    expect(refused).toBe(true);
    expect(await page.locator('dialog').count()).toBe(1);
    expect(await page.evaluate(() => Reflect.get(window, 'cancelCalls').length)).toBeGreaterThan(0);
    await page.evaluate(() => {
      Reflect.set(window, 'cancelFail', false);
      return Reflect.get(window, 'guide').dispose();
    });
    expect(await page.locator('dialog').count()).toBe(0);
  } finally {
    await dispose(page);
  }
});
