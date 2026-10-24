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
 * Timeline guide in a real browser: widths, week coverage and long titles.
 */
import { describe, expect, it } from 'vitest';
import { type TimelineChannel } from '../../src/ui/guide-timeline-model';
import {
  useTimelineBrowser,
  emptyFixture,
  coverageFixture,
  fixture,
  fullCss,
  captureDirectory,
} from './timeline-browser.fixture';

useTimelineBrowser();

describe('actual timeline component', () => {
  for (const width of [1280, 360]) {
    it.each([false, true])(
      `row schedule reason uses exact link metadata at ${width}px, unlinked=%s`,
      async (unmapped) => {
        const page = await emptyFixture(unmapped);
        try {
          await page.setViewportSize({ width, height: 640 });
          await page.evaluate(() => Reflect.get(window, 'owner').refresh());
          const note = page.locator('.gx-timeline-note').first();
          expect(await note.textContent()).toBe(
            unmapped ? 'Guide not linked' : 'No listings for this time',
          );
          const before = await page.evaluate(() => Reflect.get(window, 'calls'));
          await page.evaluate(() => {
            const host = Reflect.get(window, 'host');
            host.query = async () => {
              Reflect.set(window, 'calls', Reflect.get(window, 'calls') + 1);
              throw new Error('private fixture query failure');
            };
          });
          await page.evaluate(() => Reflect.get(window, 'owner').refresh());
          if (unmapped) {
            expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(before);
            expect(await note.textContent()).toBe('Guide not linked');
          } else {
            expect(await page.locator('.gx-timeline-status').textContent()).toBe(
              'Guide could not refresh. Choose Now to retry.',
            );
            expect(await page.locator('.gx-timeline-note').count()).toBe(0);
            expect(await page.locator('.gx-timeline-status').getAttribute('data-state')).not.toBe(
              'ready',
            );
            expect(await page.getByRole('button', { name: 'Now', exact: true }).isEnabled()).toBe(
              true,
            );
          }
          expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
        } finally {
          await page.evaluate(() => Reflect.get(window, 'owner').dispose());
          await page.close();
        }
      },
    );
  }
  it.each([false, true])(
    'empty schedule details preserve channel Watch and explicit contextual mapping, unmapped=%s',
    async (unmapped) => {
      const page = await emptyFixture(unmapped);
      try {
        const empty = page.locator('.gx-timeline-channel').first();
        expect(await page.locator('button.gx-timeline-note').count()).toBe(0);
        expect(await page.locator('.gx-timeline-note').first().textContent()).toBe(
          unmapped ? 'Guide not linked' : 'No listings for this time',
        );
        await empty.dispatchEvent('contextmenu');
        await page.getByRole('button', { name: 'Map guide', exact: true }).waitFor();
        const text = await page.locator('.gx-timeline-details').textContent();
        expect(text).toContain(
          unmapped ? 'This channel has not been matched to a saved guide' : 'No listings available',
        );
        expect(await page.evaluate(() => Reflect.get(window, 'coverageQueries').length)).toBe(
          unmapped ? 0 : 1,
        );
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
        await page.getByRole('button', { name: 'Watch channel', exact: true }).click();
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
        await page.keyboard.press('Escape');
        expect(await empty.evaluate((n) => n === document.activeElement)).toBe(true);
        await empty.dispatchEvent('contextmenu');
        await page.getByRole('button', { name: 'Map guide', exact: true }).click();
        await expect
          .poll(() => page.evaluate(() => Reflect.get(window, 'mappedChannel')))
          .toEqual({ id: 'c0', sourceId: 's' });
      } finally {
        await page.evaluate(() => Reflect.get(window, 'owner').dispose());
        await page.close();
      }
    },
  );
  it('empty schedule details in narrow agenda preserve contextual actions without a new toolbar', async () => {
    const page = await emptyFixture(true);
    try {
      await page.setViewportSize({ width: 360, height: 640 });
      await page.getByRole('button', { name: 'Schedule details', exact: true }).click();
      await page.getByRole('button', { name: 'Map guide', exact: true }).waitFor();
      expect(await page.locator('.gx-timeline-details').textContent()).toContain(
        'This channel has not been matched to a saved guide',
      );
      await page.getByRole('button', { name: 'Watch channel', exact: true }).click();
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('empty schedule details join held coverage on background and suppress stale remapping', async () => {
    const page = await emptyFixture();
    try {
      await page.evaluate(() => Reflect.set(window, 'holdEmptyCoverage', true));
      await page.locator('.gx-timeline-channel').first().dispatchEvent('contextmenu');
      await page.waitForFunction(() => !!Reflect.get(window, 'releaseEmptyCoverage'));
      await page.evaluate(() => {
        Reflect.set(window, 'emptyDrained', false);
        void Reflect.get(window, 'owner')
          .suspend()
          .then(() => Reflect.set(window, 'emptyDrained', true));
      });
      expect(await page.evaluate(() => Reflect.get(window, 'coverageSignal').aborted)).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'emptyDrained'))).toBe(false);
      await page.evaluate(() => Reflect.get(window, 'releaseEmptyCoverage')());
      await expect.poll(() => page.evaluate(() => Reflect.get(window, 'emptyDrained'))).toBe(true);
      expect(await page.getByRole('button', { name: 'Map guide', exact: true }).count()).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => {
        Reflect.get(window, 'releaseEmptyCoverage')?.();
        return Reflect.get(window, 'owner').dispose();
      });
      await page.close();
    }
  });
  it.each(['expired', 'changed', 'failure'])(
    'empty schedule details report %s without inventing coverage or blocking live Watch',
    async (mode) => {
      const page = await emptyFixture();
      try {
        await page.evaluate((mode) => {
          const host = Reflect.get(window, 'host');
          if (mode === 'expired') {
            const read = host.summary;
            host.summary = async (...args: unknown[]) => ({
              ...(await read(...args)),
              cacheStatus: 'stale',
            });
          }
          if (mode === 'changed')
            host.channelCoverage = async (q: { startMs: number; endMs: number }) => ({
              schemaVersion: 1,
              startMs: q.startMs,
              endMs: q.endMs,
              status: 'not-assessed',
              reason: 'source-stale',
              sourceRevision: 2,
              publishedRevision: 1,
              coveredMs: null,
              gapCount: null,
              unknownEndCount: null,
              gaps: [],
              gapsComplete: false,
            });
          if (mode === 'failure')
            host.channelCoverage = async () => {
              throw new Error('private source URL diagnostic');
            };
        }, mode);
        await page.locator('.gx-timeline-channel').first().dispatchEvent('contextmenu');
        await page.getByRole('button', { name: 'Map guide', exact: true }).waitFor();
        const text = await page.locator('.gx-timeline-details').textContent();
        expect(text).toContain(
          mode === 'expired'
            ? 'out of date'
            : mode === 'changed'
              ? 'Guide changed'
              : 'could not be checked',
        );
        expect(text).not.toContain('private source');
        await page.getByRole('button', { name: 'Watch channel', exact: true }).click();
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
      } finally {
        await page.evaluate(() => Reflect.get(window, 'owner').dispose());
        await page.close();
      }
    },
  );
  it.each(['remap', 'remove'])(
    'empty schedule details refuse stale channel actions after %s while retaining actual query ownership',
    async (action) => {
      const page = await emptyFixture();
      try {
        await page.evaluate(() => Reflect.set(window, 'holdEmptyCoverage', true));
        await page.locator('.gx-timeline-channel').first().dispatchEvent('contextmenu');
        await page.waitForFunction(() => !!Reflect.get(window, 'releaseEmptyCoverage'));
        await page.evaluate((action) => {
          const channels = Reflect.get(window, 'channels') as TimelineChannel[];
          Reflect.set(
            window,
            'channels',
            action === 'remove'
              ? channels.filter((c) => c.id !== 'c0')
              : channels.map((c) => (c.id === 'c0' ? { ...c, xmltvChannelId: 'replacement' } : c)),
          );
        }, action);
        await page.getByRole('button', { name: 'Watch channel', exact: true }).click();
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
        await page.evaluate(() => Reflect.get(window, 'releaseEmptyCoverage')());
        expect(await page.getByRole('button', { name: 'Map guide', exact: true }).count()).toBe(0);
      } finally {
        await page.evaluate(() => {
          Reflect.get(window, 'releaseEmptyCoverage')?.();
          return Reflect.get(window, 'owner').dispose();
        });
        await page.close();
      }
    },
  );
  it('explicit next-week check measures exact channel intervals without downloading or claiming feed-wide coverage', async () => {
    const page = await emptyFixture();
    try {
      await page.locator('.gx-timeline-channel').first().dispatchEvent('contextmenu');
      await page.getByRole('button', { name: 'Map guide', exact: true }).waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'coverageQueries').length)).toBe(1);
      await page.evaluate(() => {
        Reflect.get(window, 'host').channelCoverage = async (q: {
          startMs: number;
          endMs: number;
        }) => {
          Reflect.get(window, 'coverageQueries').push(q);
          const through = q.startMs + 86400000;
          return {
            schemaVersion: 1,
            startMs: q.startMs,
            endMs: q.endMs,
            status: 'assessed',
            reason: null,
            sourceRevision: 1,
            publishedRevision: 1,
            coveredMs: 86400000,
            gapCount: 1,
            unknownEndCount: 0,
            gaps: [{ startMs: through, endMs: q.endMs }],
            gapsComplete: true,
          };
        };
      });
      // Details initially focuses Back; the new disclosure and check remain
      // reachable with ordinary keyboard navigation and native activation.
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () =>
            document.activeElement?.querySelector('.media-result-title')?.textContent ??
            document.activeElement?.textContent,
        ),
      ).toBe('Next seven days');
      expect(
        await page
          .locator('.gx-timeline-details summary')
          .evaluate((node) => node.getBoundingClientRect().height),
      ).toBeGreaterThanOrEqual(44);
      await page.keyboard.press('Enter');
      await page.keyboard.press('Tab');
      expect(
        await page.evaluate(
          () =>
            document.activeElement?.querySelector('.media-result-title')?.textContent ??
            document.activeElement?.textContent,
        ),
      ).toBe('Check next seven days');
      await page.keyboard.press('Enter');
      await expect
        .poll(() => page.locator('.gx-timeline-week-coverage').textContent())
        .toContain('Schedule available through');
      const queries = await page.evaluate(() => Reflect.get(window, 'coverageQueries'));
      expect(queries).toHaveLength(2);
      expect(queries[1]).toMatchObject({
        sourceId: 'g',
        xmltvChannelId: 'x0',
        expectedSourceRevision: 1,
        expectedPublishedRevision: 1,
      });
      expect(queries[1].endMs - queries[1].startMs).toBe(7 * 86400000);
      expect(await page.locator('.gx-timeline-week-coverage').textContent()).toContain(
        '1 gap in the next seven days',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      await page.getByRole('button', { name: 'Map guide', exact: true }).click();
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'mappedChannel')))
        .toEqual({ id: 'c0', sourceId: 's' });
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it.each(['back', 'remap', 'suspend'])(
    'held next-week assessment retains ownership and suppresses stale results after %s',
    async (action) => {
      const page = await emptyFixture();
      try {
        await page.locator('.gx-timeline-channel').first().dispatchEvent('contextmenu');
        await page.getByRole('button', { name: 'Map guide', exact: true }).waitFor();
        await page.evaluate(() => Reflect.set(window, 'holdEmptyCoverage', true));
        await page.locator('.gx-timeline-details summary').click();
        await page.getByRole('button', { name: 'Check next seven days', exact: true }).click();
        await page.waitForFunction(() => !!Reflect.get(window, 'releaseEmptyCoverage'));
        if (action === 'back')
          await page.getByRole('button', { name: 'Back to timeline', exact: true }).click();
        if (action === 'remap')
          await page.evaluate(() => {
            Reflect.get(window, 'channels')[0].xmltvChannelId = 'changed';
          });
        if (action === 'suspend') {
          await page.evaluate(() => {
            Reflect.set(window, 'weekDrained', false);
            void Reflect.get(window, 'owner')
              .suspend()
              .then(() => Reflect.set(window, 'weekDrained', true));
          });
          expect(await page.evaluate(() => Reflect.get(window, 'weekDrained'))).toBe(false);
        }
        if (action !== 'remap')
          expect(await page.evaluate(() => Reflect.get(window, 'coverageSignal').aborted)).toBe(
            true,
          );
        await page.evaluate(() => Reflect.get(window, 'releaseEmptyCoverage')());
        if (action === 'suspend')
          await page.waitForFunction(() => Reflect.get(window, 'weekDrained'));
        expect(
          (await page.locator('.gx-timeline-week-coverage').allTextContents()).join(''),
        ).not.toContain('No listings available');
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      } finally {
        await page.evaluate(() => {
          Reflect.get(window, 'releaseEmptyCoverage')?.();
          return Reflect.get(window, 'owner').dispose();
        });
        await page.close();
      }
    },
  );
  it('assesses only explicitly selected channels in the actual three-hour window, not shared feed extrema', async () => {
    const page = await coverageFixture();
    try {
      expect(await page.evaluate(() => Reflect.get(window, 'coverageQueries').length)).toBe(0);
      for (const [index, label] of [
        [0, 'No schedule gaps in this window'],
        [1, 'Schedule has 1 gap in this window'],
        [2, '1 program end time unknown'],
      ] as const) {
        await page
          .locator('.gx-timeline-row')
          .nth(index)
          .getByRole('button', { name: 'Current listing', exact: true })
          .click();
        await expect
          .poll(() => page.locator('.gx-timeline-channel-coverage').textContent())
          .toContain(label);
        expect(await page.locator('.gx-timeline-channel-coverage').textContent()).not.toContain(
          'programme accuracy',
        );
        await page.getByRole('button', { name: 'Back to timeline', exact: true }).click();
      }
      expect(await page.evaluate(() => Reflect.get(window, 'coverageQueries'))).toEqual(
        [0, 1, 2].map((i) => ({
          schemaVersion: 1,
          sourceId: 'g',
          xmltvChannelId: 'x' + i,
          startMs: Date.UTC(2026, 9, 11, 12),
          endMs: Date.UTC(2026, 9, 11, 15),
          expectedSourceRevision: 1,
          expectedPublishedRevision: 1,
        })),
      );
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it.each(['failure', 'stale', 'absent'])(
    'keeps listing details truthful when coverage is %s',
    async (mode) => {
      const page = await coverageFixture();
      try {
        await page.evaluate((mode) => {
          Reflect.set(window, 'coverageMode', mode);
          if (mode === 'absent') Reflect.get(window, 'host').channelCoverage = undefined;
        }, mode);
        await page.getByRole('button', { name: 'Current listing', exact: true }).first().click();
        await page.getByRole('button', { name: 'Watch current channel', exact: true }).waitFor();
        expect(await page.locator('.gx-timeline-channel-coverage').textContent()).toContain(
          mode === 'stale' ? 'Guide changed' : 'Channel schedule coverage not assessed',
        );
        expect(await page.locator('.gx-timeline-details').textContent()).toContain(
          'Fixture description',
        );
        expect(await page.locator('.gx-timeline-details').textContent()).not.toContain(
          'private source diagnostic',
        );
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      } finally {
        await page.evaluate(() => Reflect.get(window, 'owner').dispose());
        await page.close();
      }
    },
  );
  it.each(['back', 'window', 'remap', 'suspend'])(
    'joins held coverage and suppresses obsolete results after %s',
    async (action) => {
      const page = await coverageFixture();
      try {
        await page.evaluate(() => Reflect.set(window, 'coverageMode', 'held'));
        await page.getByRole('button', { name: 'Current listing', exact: true }).first().click();
        await page.waitForFunction(() => !!Reflect.get(window, 'releaseCoverage'));
        if (action === 'back')
          await page.getByRole('button', { name: 'Back to timeline', exact: true }).click();
        if (action === 'window')
          await page.getByRole('button', { name: 'Next 3 hours', exact: true }).click();
        if (action === 'remap')
          await page.evaluate(() => {
            Reflect.get(window, 'channels')[0].xmltvChannelId = 'changed';
          });
        if (action === 'suspend')
          await page.evaluate(() => {
            Reflect.set(window, 'coverageDrained', false);
            void Reflect.get(window, 'owner')
              .suspend()
              .then(() => Reflect.set(window, 'coverageDrained', true));
          });
        if (action !== 'remap')
          expect(await page.evaluate(() => Reflect.get(window, 'coverageSignal').aborted)).toBe(
            true,
          );
        if (action === 'suspend')
          expect(await page.evaluate(() => Reflect.get(window, 'coverageDrained'))).toBe(false);
        await page.evaluate(() => Reflect.get(window, 'releaseCoverage')());
        if (action === 'suspend')
          await page.waitForFunction(() => Reflect.get(window, 'coverageDrained'));
        await expect
          .poll(() =>
            page.getByRole('button', { name: 'Watch current channel', exact: true }).count(),
          )
          .toBe(0);
        expect(await page.locator('.gx-timeline-channel-coverage').allTextContents()).not.toContain(
          'No schedule gaps in this window. Listings do not confirm stream availability.',
        );
        expect(await page.evaluate(() => Reflect.get(window, 'summaryCalls'))).toBe(0);
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      } finally {
        await page.evaluate(() => Reflect.get(window, 'owner').dispose());
        await page.close();
      }
    },
  );
  it('long titles use two readable lines with complete accessible details and four TV rows', async () => {
    const page = await fixture();
    const title =
      'A very long live championship listing with complete teams, venue and programme details available after opening this listing';
    try {
      await page.setViewportSize({ width: 960, height: 540 });
      await page.addStyleTag({ content: fullCss });
      await page.evaluate(async (text) => {
        Reflect.set(window, 'longTitle', text);
        Reflect.set(
          window,
          'channels',
          Reflect.get(window, 'channels')
            .slice(0, 30)
            .map((c: TimelineChannel, i: number) => ({
              ...c,
              guideSourceId: i < 3 ? 'g' : null,
              xmltvChannelId: i < 3 ? 'x' + i : null,
            })),
        );
        const dialog = document.createElement('dialog');
        dialog.className = 'guide-dialog guide-with-timeline';
        dialog.innerHTML =
          '<header class="guide-header"><h2>Program guide</h2><button aria-label="Close guide">Close</button></header><div class="guide-dropdown"><button aria-label="Guide view">Channel guide</button></div><div class="guide-feedback"><p>3 of 30 channels connected to program guides.</p><p></p></div><button>Find program guides</button><div class="guide-body"><section class="guide-panel guide-timeline-panel"></section></div>';
        document.querySelector('#app')!.append(dialog);
        dialog
          .querySelector('.guide-timeline-panel')!
          .append(document.querySelector('.gx-timeline')!);
        dialog.showModal();
        await Reflect.get(window, 'owner').refresh();
      }, title);
      const cell = page.getByRole('button', { name: title, exact: true }).first();
      const metrics = await cell.locator('.gx-timeline-cell-label').evaluate((n) => {
        const style = getComputedStyle(n),
          r = n.getBoundingClientRect();
        return {
          clamp: style.webkitLineClamp,
          font: parseFloat(style.fontSize),
          height: r.height,
          line: parseFloat(style.lineHeight),
          fullText: n.textContent,
        };
      });
      expect(metrics.clamp).toBe('2');
      expect(metrics.font).toBeGreaterThanOrEqual(16);
      expect(metrics.height).toBeLessThanOrEqual(metrics.line * 2 + 1);
      expect(metrics.fullText).toBe(title);
      expect(
        await page.locator('.gx-timeline-viewport').evaluate((n) => {
          const v = n.getBoundingClientRect();
          return [...n.querySelectorAll('.gx-timeline-row')].filter((r) => {
            const b = r.getBoundingClientRect();
            return b.top >= v.top && b.bottom <= v.bottom && b.height === 64;
          }).length;
        }),
      ).toBeGreaterThanOrEqual(4);
      expect(await cell.evaluate((n) => n.getBoundingClientRect().height)).toBeGreaterThanOrEqual(
        44,
      );
      await page.screenshot({ path: `${captureDirectory}/long-title-960x540.png` });
      await cell.click();
      await expect
        .poll(() => page.locator('.gx-timeline-details strong').first().textContent())
        .toBe(title);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      await page.keyboard.press('Escape');
      expect(await cell.evaluate((n) => n === document.activeElement)).toBe(true);
    } finally {
      await page.close();
    }
  });
});
