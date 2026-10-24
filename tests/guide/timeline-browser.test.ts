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
 * Timeline guide in a real browser: reused listings, search and listed
 * membership.
 */
import { describe, expect, it } from 'vitest';
import { type TimelineChannel } from '../../src/ui/guide-timeline-model';
import { type ProgramQuery } from '../../src/guide/native';
import {
  useTimelineBrowser,
  fixture,
  fullCss,
  captureDirectory,
  rowCapacity,
  remoteBundle,
  shellBundle,
} from './timeline-browser.fixture';

useTimelineBrowser();

for (const size of [
  { width: 960, height: 540, font: 16 },
  { width: 1280, height: 720, font: 16 },
  { width: 320, height: 640, font: 32 },
  { width: 640, height: 360, font: 32 },
])
  it(`full production Guide layout ${size.width}x${size.height} text ${size.font}`, async () => {
    const page = await fixture();
    try {
      await page.setViewportSize(size);
      await page.addStyleTag({ content: fullCss });
      await page.evaluate((font) => {
        document.body.style.fontSize = `${font}px`;
        const dialog = document.createElement('dialog');
        dialog.className = 'guide-dialog guide-with-timeline';
        dialog.innerHTML =
          '<header class="guide-header"><h2>Program guide</h2><button aria-label="Close guide">Close</button></header><div class="guide-dropdown"><button aria-label="Guide view">Channel guide</button></div><div class="guide-feedback"><p>No program guide connected yet.</p><p></p></div><button>Find program guides</button><div class="guide-body"><section class="guide-panel guide-timeline-panel"></section></div>';
        document.querySelector('#app')!.append(dialog);
        dialog
          .querySelector('.guide-timeline-panel')!
          .append(document.querySelector('.gx-timeline')!);
        dialog.showModal();
      }, size.font);
      await page.evaluate(async () => {
        Reflect.get(window, 'channels').forEach((c: TimelineChannel) => {
          c.guideSourceId = null;
          c.xmltvChannelId = null;
        });
        await Reflect.get(window, 'owner').refresh();
      });
      const completeRows = await page.locator('.gx-timeline-viewport').evaluate((node) => {
        const viewport = node.getBoundingClientRect();
        return [...node.querySelectorAll('.gx-timeline-row')].filter((row) => {
          const r = row.getBoundingClientRect();
          return r.top >= viewport.top && r.bottom <= viewport.bottom && r.height >= 44;
        }).length;
      });
      if (size.font === 16) expect(completeRows).toBeGreaterThanOrEqual(4);
      if (size.width === 960)
        await page.screenshot({ path: `${captureDirectory}/compact-960x540-unmapped.png` });
      if (await page.getByRole('button', { name: 'Guide controls', exact: true }).isVisible())
        await page.getByRole('button', { name: 'Guide controls', exact: true }).click();
      for (const name of [
        'Close guide',
        'Guide view',
        'Find program guides',
        'Previous 3 hours',
        'Now',
        'Next 3 hours',
      ]) {
        const control = page.getByRole('button', { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        expect(
          await control.evaluate((node) => {
            const r = node.getBoundingClientRect();
            return (
              r.height >= 44 &&
              r.x >= 0 &&
              r.right <= innerWidth &&
              r.y >= 0 &&
              r.bottom <= innerHeight &&
              node.scrollHeight <= node.clientHeight + 1 &&
              node.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2))
            );
          }),
          `${name}: ${JSON.stringify(
            await control.evaluate((n) => {
              const r = n.getBoundingClientRect();
              return {
                x: r.x,
                y: r.y,
                width: r.width,
                height: r.height,
                client: n.clientHeight,
                scroll: n.scrollHeight,
                bodyHeight: document.querySelector('.guide-body')!.clientHeight,
                bodyScroll: document.querySelector('.guide-body')!.scrollTop,
              };
            }),
          )}`,
        ).toBe(true);
      }
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollHeight <= innerHeight &&
            document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.evaluate(async () => {
        Reflect.get(window, 'channels').forEach((c: TimelineChannel, i: number) => {
          c.guideSourceId = 'g';
          c.xmltvChannelId = 'x' + i;
        });
        document.querySelector('.guide-feedback')!.replaceChildren();
        [...document.querySelectorAll('dialog>button')].forEach(
          (n) => ((n as HTMLElement).hidden = true),
        );
        await Reflect.get(window, 'owner').refresh();
      });
      if (size.width === 960)
        await page.screenshot({ path: `${captureDirectory}/compact-960x540-mapped.png` });
      let current = page.getByRole('button', { name: 'Current listing', exact: true }).first();
      const cluster = page
        .getByRole('button', { name: 'Current listing and 1 more listing', exact: true })
        .first();
      const focusReturn = (await cluster.count()) ? cluster : current;
      if (await cluster.count()) {
        await cluster.click();
        current = page
          .locator('.gx-timeline-choices button')
          .filter({ hasText: 'Current listing' })
          .first();
      }
      await current.scrollIntoViewIfNeeded();
      await current.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('button', { name: 'Watch current channel' }).waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      await page.getByRole('button', { name: 'Back to timeline' }).click();
      expect(await focusReturn.evaluate((n) => n === document.activeElement)).toBe(true);
      expect(await page.locator('.gx-timeline-row').count()).toBeLessThanOrEqual(
        await rowCapacity(page),
      );
    } finally {
      await page.close();
    }
  });
describe('actual timeline component', () => {
  it('listings already read are reused when scrolling back, and rows read four at a time', async () => {
    // Owner report, October 19, 2026: holding Down in the Sansui TV's guide
    // outran one-at-a-time reads that started over at every jump.
    const page = await fixture(false);
    try {
      await page.setViewportSize({ width: 960, height: 540 });
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        const saved = Reflect.get(window, 'channels');
        host.listedChannels = async () => ({
          catalogRevision: '1',
          databaseRevision: 1,
          channels: saved.map((c: TimelineChannel) => ({
            catalogSourceId: c.sourceId,
            appChannelId: c.id,
            guideSourceId: c.guideSourceId,
            xmltvChannelId: c.xmltvChannelId,
            sourceRevision: 1,
          })),
        });
        // Counts reads in flight at once.
        const query = host.query;
        Reflect.set(window, 'inFlight', 0);
        Reflect.set(window, 'mostInFlight', 0);
        host.query = async (...args: unknown[]) => {
          Reflect.set(window, 'inFlight', Reflect.get(window, 'inFlight') + 1);
          Reflect.set(
            window,
            'mostInFlight',
            Math.max(Reflect.get(window, 'mostInFlight'), Reflect.get(window, 'inFlight')),
          );
          await new Promise((resolve) => setTimeout(resolve, 20));
          try {
            return await query(...args);
          } finally {
            Reflect.set(window, 'inFlight', Reflect.get(window, 'inFlight') - 1);
          }
        };
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      await page
        .getByRole('status')
        .getByText('Loading visible listings…')
        .waitFor({ state: 'detached' })
        .catch(() => undefined);
      await expect.poll(() => page.locator('.gx-timeline-cell').count()).toBeGreaterThan(0);
      const atTop = await page.evaluate(() => Reflect.get(window, 'calls'));
      const drawn = (first: string) =>
        expect
          .poll(() =>
            page.evaluate(
              (name) =>
                [...document.querySelectorAll('.gx-timeline-channel')].some(
                  (row) =>
                    row.textContent?.includes(name) &&
                    row.closest('.gx-timeline-row')?.querySelector('.gx-timeline-cell'),
                ),
              first,
            ),
          )
          .toBe(true);
      await page.locator('.gx-timeline-viewport').evaluate((node) => {
        node.scrollTop = node.scrollHeight;
      });
      await drawn('Channel 99');
      const atBottom = await page.evaluate(() => Reflect.get(window, 'calls'));
      expect(atBottom).toBeGreaterThan(atTop);
      await page.locator('.gx-timeline-viewport').evaluate((node) => {
        node.scrollTop = 0;
      });
      await drawn('Channel 0');
      // Back at the top: every row there was read before, so nothing is asked again.
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(atBottom);
      expect(await page.evaluate(() => Reflect.get(window, 'mostInFlight'))).toBe(4);
    } finally {
      await page.close();
    }
  });
  it('listed membership hides unlinked and mapped-empty channels before virtualization and caches scroll/category work', async () => {
    const page = await fixture(false);
    try {
      await page.setViewportSize({ width: 960, height: 540 });
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        const saved = Reflect.get(window, 'channels');
        saved[0].guideSourceId = null;
        saved[0].xmltvChannelId = null;
        saved[20].favorite = true;
        saved[20].category = 'Sports';
        Reflect.set(window, 'listedCalls', []);
        host.listedChannels = async (start: number, end: number) => {
          Reflect.get(window, 'listedCalls').push([start, end]);
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: saved
              .slice(20, 40)
              .reverse()
              .map((c: TimelineChannel) => ({
                catalogSourceId: c.sourceId,
                appChannelId: c.id,
                guideSourceId: c.guideSourceId,
                xmltvChannelId: c.xmltvChannelId,
                sourceRevision: 1,
              })),
          };
        };
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(
        await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
      ).toEqual(
        Array.from(
          { length: Math.min(20, await rowCapacity(page)) },
          (_, i) => `Channel ${20 + i}`,
        ),
      );
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls').length)).toBe(1);
      await page.locator('.gx-timeline-viewport').evaluate((node) => {
        node.scrollTop = 600;
      });
      // The scrolled-to row is drawn (from overscan or a redraw) without a membership query.
      await expect
        .poll(() =>
          page.locator('.gx-timeline-viewport').evaluate((node) => {
            const v = node.getBoundingClientRect();
            return [...node.querySelectorAll('.gx-timeline-row')].some((row) => {
              const r = row.getBoundingClientRect();
              return r.top <= v.top + 1 && r.bottom > v.top + 1;
            });
          }),
        )
        .toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls').length)).toBe(1);
      await page.getByRole('button', { name: 'Favorites', exact: true }).click();
      await expect
        .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
        .toEqual(['Channel 20']);
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls').length)).toBe(1);
      await page.getByRole('button', { name: 'All channels', exact: true }).click();
      await expect
        .poll(() => page.locator('.gx-timeline-channel').count())
        .toBe(Math.min(20, await rowCapacity(page)));
      await page.addScriptTag({ content: remoteBundle });
      await page.evaluate(() => Reflect.get(window, 'Remote').installRemoteNavigation());
      await page.getByRole('button', { name: 'Channel 20', exact: true }).focus();
      for (let i = 1; i <= 12; i++) {
        await page.keyboard.press('ArrowDown');
        await expect
          .poll(() =>
            page.evaluate(
              () => document.activeElement?.querySelector('.media-result-title')?.textContent,
            ),
          )
          .toBe(`Channel ${20 + i}`);
      }
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls').length)).toBe(1);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('Guide search filters listed channels as you type, looking a week ahead, and Clear restores the window', async () => {
    const page = await fixture(false);
    try {
      await page.setViewportSize({ width: 1280, height: 720 });
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        const saved = Reflect.get(window, 'channels');
        Reflect.set(window, 'listedCalls', []);
        // Stands in for the native query, which also matches program text.
        host.listedChannels = async (
          start: number,
          end: number,
          _signal: AbortSignal,
          search?: string,
        ) => {
          Reflect.get(window, 'listedCalls').push([end - start, search ?? null]);
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: saved
              .slice(0, 40)
              .filter(
                (c: TimelineChannel) =>
                  !search ||
                  search === 'current listing' ||
                  c.name.toLowerCase().includes(search.toLowerCase()),
              )
              .map((c: TimelineChannel) => ({
                catalogSourceId: c.sourceId,
                appChannelId: c.id,
                guideSourceId: c.guideSourceId,
                xmltvChannelId: c.xmltvChannelId,
                sourceRevision: 1,
              })),
          };
        };
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      const box = page.getByRole('searchbox', { name: 'Search guide channels and programs' });
      expect(await box.isVisible()).toBe(true);
      await box.fill('channel 3');
      await expect
        .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
        .toEqual(['Channel 3', ...Array.from({ length: 10 }, (_, i) => `Channel ${30 + i}`)]);
      const calls = await page.evaluate(() => Reflect.get(window, 'listedCalls'));
      expect(calls.at(-1)).toEqual([7 * 86_400_000, 'channel 3']);
      // Typing pauses are coalesced: one query for the final text.
      expect(calls.filter((call: unknown[]) => call[1] !== null)).toHaveLength(1);
      // Matching listings are highlighted in the grid.
      await box.fill('current listing');
      await expect
        .poll(() => page.locator('.gx-timeline-cell.gx-timeline-match').count())
        .toBeGreaterThan(0);
      expect(await page.locator('.gx-timeline-cell.gx-timeline-match').allTextContents()).toEqual(
        expect.arrayContaining([expect.stringContaining('Current listing')]),
      );
      expect(
        (await page.locator('.gx-timeline-cell.gx-timeline-match').allTextContents()).every((t) =>
          t.includes('Current listing'),
        ),
      ).toBe(true);
      await box.fill('nothing like this');
      await expect
        .poll(() => page.locator('.gx-timeline-status').textContent())
        .toContain('Nothing matches “nothing like this” in the next 7 days.');
      await box.fill('');
      await expect
        .poll(() => page.evaluate(() => Reflect.get(window, 'listedCalls').at(-1)))
        .toEqual([3 * 3_600_000, null]);
      await expect
        .poll(() => page.locator('.gx-timeline-channel .media-result-title').first().textContent())
        .toBe('Channel 0');
      // A remote leaves the empty field with Left/Right like any toolbar control.
      await box.focus();
      await page.keyboard.press('ArrowRight');
      // The first enabled time control (earlier times are disabled at the current time).
      expect(await page.evaluate(() => document.activeElement?.textContent)).toBe('Now');
      await page.keyboard.press('ArrowLeft');
      expect(await box.evaluate((node) => node === document.activeElement)).toBe(true);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('compact TV listed membership settles final ready geometry without rebuilding rows or losing D-pad focus', async () => {
    // The right-panel Guide keeps its grid down to PANEL_AGENDA_WIDTH.
    const page = await fixture(false, false, 480);
    try {
      await page.setViewportSize({ width: 960, height: 540 });
      await page.addStyleTag({ content: fullCss });
      await page.addScriptTag({ content: shellBundle });
      await page.addScriptTag({ content: remoteBundle });
      await page.evaluate(() => {
        const timeline = document.querySelector('.gx-timeline')!;
        Reflect.get(window, 'Shell').createShell(document.querySelector('#app'));
        document.querySelector<HTMLElement>('#app')!.dataset.deviceKind = 'tv';
        // The Guide opens in the right panel beside the channel list.
        document.getElementById('app')!.dataset.guidePanel = 'open';
        document.querySelector<HTMLElement>('#compact-view')!.hidden = true;
        const primary = document.querySelector<HTMLElement>('#primary-view-host')!;
        primary.hidden = false;
        const dialog = document.createElement('dialog');
        dialog.className = 'guide-dialog guide-with-timeline guide-compact-page';
        dialog.dataset.primaryPage = 'guide';
        dialog.innerHTML =
          '<div class="guide-body"><section class="guide-panel guide-timeline-panel"></section></div>';
        primary.append(dialog);
        dialog.querySelector('.guide-timeline-panel')!.append(timeline);
        dialog.show();
        const channels = Reflect.get(window, 'channels').slice(20, 26);
        Reflect.set(window, 'channels', channels);
        Reflect.set(window, 'listedCalls', 0);
        Reflect.set(window, 'queryPendingStates', []);
        const host = Reflect.get(window, 'host');
        host.listedChannels = async () => {
          Reflect.set(window, 'listedCalls', Reflect.get(window, 'listedCalls') + 1);
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: channels.map((c: TimelineChannel) => ({
              catalogSourceId: c.sourceId,
              appChannelId: c.id,
              guideSourceId: c.guideSourceId,
              xmltvChannelId: c.xmltvChannelId,
              sourceRevision: 1,
            })),
          };
        };
        const query = host.query;
        host.query = async (request: ProgramQuery, signal: AbortSignal) => {
          // Real IPC settles in a later task, allowing layout/ResizeObserver between row replies.
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
          signal.throwIfAborted();
          const status = document.querySelector<HTMLElement>('.gx-timeline-status')!;
          Reflect.get(window, 'queryPendingStates').push({
            state: status.dataset.state ?? null,
            text: status.textContent,
          });
          return query(request, signal);
        };
        Reflect.get(window, 'Remote').installRemoteNavigation();
        Reflect.set(window, 'readyWork', Reflect.get(window, 'owner').setForeground(true));
      });
      await page
        .locator('.gx-timeline-status[data-state="ready"]')
        .waitFor({ state: 'attached' })
        .catch(async (error) => {
          console.log(
            'compact-ready-state',
            await page.evaluate(() => ({
              queries: Reflect.get(window, 'calls'),
              membership: Reflect.get(window, 'listedCalls'),
              status: document.querySelector('.gx-timeline-status')?.textContent,
              rows: document.querySelectorAll('.gx-timeline-row').length,
              viewport: document.querySelector('.gx-timeline-viewport')?.clientHeight,
            })),
          );
          throw error;
        });
      await page.getByRole('button', { name: 'Channel 20', exact: true }).focus();
      await page.keyboard.press('ArrowDown');
      expect(
        await page
          .getByRole('button', { name: 'Channel 21', exact: true })
          .evaluate((n) => n === document.activeElement),
      ).toBe(true);
      const settled = await page.evaluate(async () => {
        const focused = document.activeElement;
        const before = Reflect.get(window, 'calls');
        for (let frame = 0; frame < 24; frame++)
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const viewport = document.querySelector('.gx-timeline-viewport')!;
        const rect = focused!.getBoundingClientRect(),
          clip = viewport.getBoundingClientRect();
        return {
          before,
          after: Reflect.get(window, 'calls'),
          membership: Reflect.get(window, 'listedCalls'),
          state: document.querySelector<HTMLElement>('.gx-timeline-status')!.dataset.state ?? null,
          focusRetained: focused === document.activeElement && focused!.isConnected,
          visible: rect.top >= clip.top && rect.bottom <= clip.bottom,
          rows: document.querySelectorAll('.gx-timeline-row').length,
          watches: Reflect.get(window, 'watches'),
        };
      });
      expect(settled).toEqual({
        before: 6,
        after: 6,
        membership: 1,
        state: 'ready',
        focusRetained: true,
        visible: true,
        rows: 6,
        watches: 0,
      });
      expect(await page.evaluate(() => Reflect.get(window, 'queryPendingStates'))).toEqual(
        Array.from({ length: 6 }, () => ({ state: null, text: 'Loading visible listings…' })),
      );
      await page.keyboard.press('ArrowDown');
      expect(
        await page
          .getByRole('button', { name: 'Channel 22', exact: true })
          .evaluate((n) => n === document.activeElement),
      ).toBe(true);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('listed membership empty result shows a truthful zero state without querying dead rows', async () => {
    const page = await fixture(false, true);
    try {
      await page.evaluate(() => {
        Reflect.get(window, 'host').listedChannels = async () => ({
          catalogRevision: '1',
          databaseRevision: 1,
          channels: [],
        });
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(await page.locator('.gx-timeline-channel').count()).toBe(0);
      expect(await page.locator('.gx-timeline-status').textContent()).toBe(
        'No saved listings for this time. Find program guides or choose another time.',
      );
      expect(await page.evaluate(() => Reflect.get(window, 'calls'))).toBe(0);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it.each([6, 12])(
    'listed membership uses viewport-sized rows through tall-window D-pad navigation and a shorter resize (%s channels)',
    async (count) => {
      const page = await fixture(false);
      try {
        await page.setViewportSize({ width: 1280, height: 960 });
        await page.addStyleTag({ content: fullCss });
        await page.evaluate((count) => {
          const saved = Reflect.get(window, 'channels').slice(20, 20 + count);
          Reflect.set(window, 'channels', saved);
          Reflect.set(window, 'listedCalls', 0);
          Reflect.get(window, 'host').listedChannels = async () => {
            Reflect.set(window, 'listedCalls', Reflect.get(window, 'listedCalls') + 1);
            return {
              catalogRevision: '1',
              databaseRevision: 1,
              channels: saved.map((c: TimelineChannel) => ({
                catalogSourceId: c.sourceId,
                appChannelId: c.id,
                guideSourceId: c.guideSourceId,
                xmltvChannelId: c.xmltvChannelId,
                sourceRevision: 1,
              })),
            };
          };
        }, count);
        await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
        expect(await page.locator('.gx-timeline-channel').count()).toBe(count);
        await page.addScriptTag({ content: remoteBundle });
        await page.evaluate(() => Reflect.get(window, 'Remote').installRemoteNavigation());
        await page.getByRole('button', { name: 'Channel 20', exact: true }).focus();
        const last = 19 + count;
        for (let index = 21; index <= last; index++) {
          await page.keyboard.press('ArrowDown');
          await expect
            .poll(() =>
              page.evaluate(
                () => document.activeElement?.querySelector('.media-result-title')?.textContent,
              ),
            )
            .toBe(`Channel ${index}`);
        }
        await page.setViewportSize({ width: 960, height: 540 });
        await expect
          .poll(() =>
            page.evaluate(() => {
              const active = document.activeElement,
                clip = document.querySelector('.gx-timeline-viewport')!;
              if (!(active instanceof HTMLElement)) return { label: null, visible: false };
              const a = active.getBoundingClientRect(),
                v = clip.getBoundingClientRect();
              return {
                label: active.querySelector('.media-result-title')?.textContent ?? null,
                visible: a.top >= v.top && a.bottom <= v.bottom,
              };
            }),
          )
          .toEqual({ label: `Channel ${last}`, visible: true })
          .catch(async (error) => {
            console.log(
              'tall-resize-geometry',
              await page.evaluate(() => {
                const active = document.activeElement as HTMLElement,
                  clip = document.querySelector('.gx-timeline-viewport') as HTMLElement;
                const a = active.getBoundingClientRect(),
                  v = clip.getBoundingClientRect();
                return {
                  activeTop: a.top,
                  activeBottom: a.bottom,
                  viewportTop: v.top,
                  viewportBottom: v.bottom,
                  scrollTop: clip.scrollTop,
                  clientHeight: clip.clientHeight,
                  rowHeight: document
                    .querySelector<HTMLElement>('.gx-timeline')
                    ?.style.getPropertyValue('--gx-row-height'),
                };
              }),
            );
            throw error;
          });
        for (let index = last - 1; index >= 20; index--) {
          await page.keyboard.press('ArrowUp');
          await expect
            .poll(() =>
              page.evaluate(
                () => document.activeElement?.querySelector('.media-result-title')?.textContent,
              ),
            )
            .toBe(`Channel ${index}`);
        }
        expect(await page.evaluate(() => Reflect.get(window, 'listedCalls'))).toBe(1);
        expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      } finally {
        await page.evaluate(() => Reflect.get(window, 'owner').dispose());
        await page.close();
      }
    },
  );
  it('listed membership bounds a very tall viewport to 32 intersecting rows and 1600 complete listing choices', async () => {
    const page = await fixture(false);
    try {
      await page.setViewportSize({ width: 1280, height: 3000 });
      await page.addStyleTag({ content: fullCss });
      await page.evaluate(() => {
        Reflect.set(window, 'mode', 'dense');
        Reflect.set(window, 'listedCalls', 0);
        Reflect.get(window, 'host').listedChannels = async () => {
          Reflect.set(window, 'listedCalls', Reflect.get(window, 'listedCalls') + 1);
          return {
            catalogRevision: '1',
            databaseRevision: 1,
            channels: Reflect.get(window, 'channels').map((c: TimelineChannel) => ({
              catalogSourceId: c.sourceId,
              appChannelId: c.id,
              guideSourceId: c.guideSourceId,
              xmltvChannelId: c.xmltvChannelId,
              sourceRevision: 1,
            })),
          };
        };
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(await page.locator('.gx-timeline-row').count()).toBe(32);
      expect(await page.locator('.gx-timeline-cell').count()).toBe(32);
      await page.locator('.gx-timeline-viewport').evaluate((node) => {
        const pitch = parseFloat(
          getComputedStyle(node.closest('.gx-timeline')!).getPropertyValue('--gx-row-height'),
        );
        node.scrollTop = pitch / 2;
      });
      expect(
        await page.locator('.gx-timeline-viewport').evaluate((node) => {
          const v = node.getBoundingClientRect(),
            pitch = parseFloat(
              getComputedStyle(node.closest('.gx-timeline')!).getPropertyValue('--gx-row-height'),
            );
          return {
            bounded: node.clientHeight <= 31 * pitch,
            intersections: [...node.querySelectorAll('.gx-timeline-row')].filter((row) => {
              const r = row.getBoundingClientRect();
              return r.top < v.bottom && r.bottom > v.top;
            }).length,
          };
        }),
      ).toEqual({ bounded: true, intersections: 32 });
      await page.addScriptTag({ content: remoteBundle });
      await page.evaluate(() => Reflect.get(window, 'Remote').installRemoteNavigation());
      await page
        .getByRole('button', { name: 'Channel 31', exact: true })
        .evaluate((node) => (node as HTMLElement).focus({ preventScroll: true }));
      await page.keyboard.press('ArrowDown');
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.querySelector('.media-result-title')?.textContent,
          ),
        )
        .toBe('Channel 32');
      expect(await page.evaluate(() => Reflect.get(window, 'listedCalls'))).toBe(1);
      await page.keyboard.press('ArrowRight');
      await page.keyboard.press('Enter');
      expect(await page.locator('.gx-timeline-choices button').count()).toBe(50);
      await page.getByRole('button', { name: /Overlap 49/ }).click();
      expect(await page.locator('.gx-timeline-details strong').textContent()).toBe('Overlap 49');
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('listed membership grid queries drawable-only programmes instead of paging historical unknown-end context ahead of them', async () => {
    const page = await fixture(false);
    try {
      await page.evaluate(() => {
        const host = Reflect.get(window, 'host');
        host.listedChannels = async () => ({
          catalogRevision: '1',
          databaseRevision: 1,
          channels: [
            {
              catalogSourceId: 's',
              appChannelId: 'c20',
              guideSourceId: 'g',
              xmltvChannelId: 'x20',
              sourceRevision: 1,
            },
          ],
        });
        host.query = async (q: ProgramQuery) => {
          Reflect.set(window, 'listedQuery', q);
          const identity = {
            catalogSourceId: 's',
            appChannelId: 'c20',
            guideSourceId: 'g',
            xmltvChannelId: 'x20',
            description: null,
          };
          const programmes =
            q.contextAtMs === undefined
              ? [
                  {
                    ...identity,
                    startMs: q.windowStartMs + 1000,
                    stopMs: null,
                    title: 'Actual in-window unknown end',
                    ordinal: 100,
                  },
                ]
              : Array.from({ length: 50 }, (_, ordinal) => ({
                  ...identity,
                  startMs: q.windowStartMs - 1000,
                  stopMs: null,
                  title: 'Historical unknown ' + ordinal,
                  ordinal,
                }));
          return { programs: programmes, nextCursor: null, sourceRevision: 1, databaseRevision: 1 };
        };
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      expect(
        await page
          .getByRole('button', { name: 'Actual in-window unknown end · end unknown', exact: true })
          .count(),
      ).toBe(1);
      expect(
        await page.evaluate(() => Reflect.get(window, 'listedQuery').contextAtMs),
      ).toBeUndefined();
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
  it('listed membership scopes the narrow chooser to real listings and preserves channel order without tuning', async () => {
    const page = await fixture(false, true);
    try {
      await page.setViewportSize({ width: 320, height: 640 });
      await page.evaluate(() => {
        Reflect.get(window, 'host').listedChannels = async () => ({
          catalogRevision: '1',
          databaseRevision: 1,
          channels: [9, 4].map((i) => ({
            catalogSourceId: 's',
            appChannelId: 'c' + i,
            guideSourceId: 'g',
            xmltvChannelId: 'x' + i,
            sourceRevision: 1,
          })),
        });
      });
      await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
      await page
        .getByRole('button', { name: 'Browse guide channel: Channel 4', exact: true })
        .click();
      expect(await page.locator('.gx-agenda-channel-option').allTextContents()).toEqual([
        'Channel 4',
        'Channel 9',
      ]);
      await page.getByRole('button', { name: 'Channel 9', exact: true }).click();
      await expect
        .poll(() => page.locator('.gx-agenda-channel').getAttribute('aria-label'))
        .toBe('Browse guide channel: Channel 9');
      expect(
        await page.getByRole('button', { name: 'Next guide channel', exact: true }).isDisabled(),
      ).toBe(true);
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
});
