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
 * Timeline guide in a real browser: the agenda view.
 */
import { expect, it } from 'vitest';
import { type ProgramQuery } from '../../src/guide/native';
import { type TimelineChannel } from '../../src/ui/guide/guide-timeline-model';
import {
  useTimelineBrowser,
  narrowAgenda,
  captureDirectory,
  remoteBundle,
} from './timeline-browser.fixture';

useTimelineBrowser();

for (const size of [
  { width: 320, height: 640, font: 16 },
  { width: 360, height: 640, font: 16 },
  { width: 640, height: 360, font: 16 },
  { width: 320, height: 640, font: 32 },
  { width: 360, height: 640, font: 32 },
  { width: 640, height: 360, font: 32 },
])
  it(`real shell readable agenda ${size.width}x${size.height} font${size.font}`, async () => {
    const page = await narrowAgenda(size, true);
    try {
      const listing = page.getByRole('button', {
        name: 'Live championship: complete teams, venue and match information',
        exact: true,
      });
      await listing.scrollIntoViewIfNeeded();
      expect(await listing.getAttribute('aria-label')).toBe(
        'Live championship: complete teams, venue and match information',
      );
      expect(
        await page
          .getByRole('button', {
            name: 'Browse guide channel: Sports channel with its full regional identity',
            exact: true,
          })
          .getAttribute('title'),
      ).toBe('Sports channel with its full regional identity');
      expect(await page.locator('.gx-timeline-axis').isVisible()).toBe(false);
      expect(await page.locator('.gx-agenda-listing').count()).toBe(2);
      expect(
        await page.locator('.gx-timeline-viewport').evaluate((n) => n.clientHeight),
      ).toBeGreaterThanOrEqual(44);
      expect(
        await listing.evaluate((n) => {
          const r = n.getBoundingClientRect(),
            v = n.closest('.gx-timeline-viewport')!.getBoundingClientRect();
          return (
            r.height >= 44 &&
            r.width >= 44 &&
            r.left >= v.left &&
            r.right <= v.right &&
            Math.min(r.bottom, v.bottom) - Math.max(r.top, v.top) >= 44 &&
            n.scrollWidth <= n.clientWidth
          );
        }),
      ).toBe(true);
      const toggle = page.getByRole('button', { name: 'Guide controls', exact: true });
      if (await toggle.isVisible()) {
        const geometry = await listing.evaluate((n) => {
          const r = n.getBoundingClientRect(),
            v = n.closest('.gx-timeline-viewport')!.getBoundingClientRect();
          return {
            listing: r.height,
            viewport: v.height,
            root: document.querySelector('.gx-timeline')!.getBoundingClientRect().height,
            toolbar: document.querySelector('.gx-timeline-toolbar')!.getBoundingClientRect().height,
            header: document.querySelector('.gx-agenda-header')!.getBoundingClientRect().height,
            statusParent: document.querySelector('.gx-timeline-status')!.parentElement!.className,
            time: getComputedStyle(n.querySelector('.gx-agenda-time')!).fontSize,
          };
        });
        await page.screenshot({
          path: `${captureDirectory}/short-agenda-before-controls-font${size.font}.png`,
        });
        expect(geometry.listing <= geometry.viewport, JSON.stringify(geometry)).toBe(true);
        await toggle.click();
      }
      for (const name of ['Previous 3 hours', 'Now', 'Next 3 hours', 'Previous day', 'Next day']) {
        const control = page.getByRole('button', { name, exact: true });
        await control.scrollIntoViewIfNeeded();
        expect(
          await control.evaluate((n) => {
            const r = n.getBoundingClientRect();
            return (
              r.height >= 44 &&
              r.width >= 44 &&
              r.left >= 0 &&
              r.right <= innerWidth &&
              r.top >= 0 &&
              r.bottom <= innerHeight
            );
          }),
        ).toBe(true);
      }
      if (await toggle.isVisible()) await toggle.click();
      await listing.click();
      await page.getByRole('button', { name: 'Watch current channel', exact: true }).waitFor();
      expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
      await page.getByRole('button', { name: 'Back to timeline', exact: true }).click();
      expect(await listing.evaluate((n) => document.activeElement === n)).toBe(true);
      expect(
        await page.evaluate(
          () =>
            document.documentElement.scrollWidth <= innerWidth &&
            document.documentElement.scrollHeight <= innerHeight,
        ),
      ).toBe(true);
      await page.screenshot({
        path: `${captureDirectory}/agenda-${size.width}x${size.height}-font${size.font}.png`,
      });
    } finally {
      await page.evaluate(() => Reflect.get(window, 'owner').dispose());
      await page.close();
    }
  });
it('continuous agenda channel chooser stays bounded through31 keys and browses without tuning', async () => {
  const page = await narrowAgenda({ width: 360, height: 640, font: 16 });
  try {
    await page.addScriptTag({ content: remoteBundle });
    await page.evaluate(() =>
      Reflect.set(window, 'remote', Reflect.get(window, 'Remote').installRemoteNavigation()),
    );
    await page
      .getByRole('button', {
        name: 'Browse guide channel: Sports channel with its full regional identity',
        exact: true,
      })
      .click();
    expect(await page.getByRole('button', { name: 'More channels', exact: true }).count()).toBe(0);
    for (let i = 0; i < 31; i++) {
      await page.keyboard.press('ArrowDown');
      expect(await page.locator('.gx-agenda-channel-option').count()).toBeLessThanOrEqual(8);
    }
    expect(
      await page.evaluate(() => document.activeElement?.getAttribute('data-channel-index')),
    ).toBe('31');
    await page.keyboard.press('Enter');
    await expect
      .poll(() => page.locator('.gx-agenda-channel .media-result-title').textContent())
      .toBe('Channel 31');
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    const listing = page.getByRole('button', {
      name: 'Live championship: complete teams, venue and match information',
      exact: true,
    });
    await listing.focus();
    await page.keyboard.press('ArrowDown');
    expect(
      await page
        .getByRole('button', { name: 'Future listing', exact: true })
        .evaluate((n) => n === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Back to timeline', exact: true }).waitFor();
    expect(
      await page.getByRole('button', { name: 'Watch current channel', exact: true }).count(),
    ).toBe(0);
    await page.keyboard.press('Escape');
    expect(
      await page
        .getByRole('button', { name: 'Future listing', exact: true })
        .evaluate((n) => n === document.activeElement),
    ).toBe(true);
    await page.getByRole('button', { name: 'Now', exact: true }).click();
    await listing.click();
    await page.getByRole('button', { name: 'Watch current channel', exact: true }).click();
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(1);
  } finally {
    await page.evaluate(() => {
      Reflect.get(window, 'remote')();
      return Reflect.get(window, 'owner').dispose();
    });
    await page.close();
  }
});
it('agenda pages are bounded, use exact channel scope and never report loaded rows as total coverage', async () => {
  const page = await narrowAgenda({ width: 360, height: 640, font: 16 });
  try {
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'host');
      const base = Reflect.get(window, 'base');
      Reflect.set(window, 'agendaQueries', []);
      host.query = async (q: Record<string, unknown>) => {
        Reflect.get(window, 'agendaQueries').push(q);
        const start = q.cursor ? 50 : 0;
        return {
          sourceRevision: 1,
          databaseRevision: 1,
          programs: Array.from({ length: 50 }, (_, j) => ({
            catalogSourceId: 's',
            appChannelId: q.appChannelIds instanceof Array ? q.appChannelIds[0] : '',
            guideSourceId: 'g',
            xmltvChannelId: 'x0',
            startMs: base + (start + j) * 1000,
            stopMs: base + (start + j + 1) * 1000,
            ordinal: start + j,
            title: 'Listing ' + (start + j),
            description: 'Full detail',
            categories: [],
          })),
          nextCursor: q.cursor ? null : { startMs: base + 49000, ordinal: 49, appChannelId: 'c0' },
        };
      };
      await Reflect.get(window, 'owner').refresh();
    });
    expect(await page.locator('.gx-agenda-listing').count()).toBe(50);
    expect(await page.locator('.gx-timeline-status').textContent()).toContain('50 listings shown');
    expect(await page.locator('.gx-timeline-status').textContent()).toContain(
      'More listings available',
    );
    await page.getByRole('button', { name: 'More listings', exact: true }).click();
    await page.getByRole('button', { name: 'Listing 99', exact: true }).waitFor();
    expect(await page.locator('.gx-agenda-listing').count()).toBe(50);
    expect(await page.getByRole('button', { name: 'More listings', exact: true }).count()).toBe(0);
    const queries = await page.evaluate(() => Reflect.get(window, 'agendaQueries'));
    expect(queries).toHaveLength(2);
    expect(queries[0]).toMatchObject({
      guideSourceId: 'g',
      appChannelIds: ['c0'],
      search: '',
      pageSize: 50,
      cursor: null,
    });
    expect(queries[1].contextAtMs).toBe(queries[0].contextAtMs);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    await page.getByRole('button', { name: 'First listings', exact: true }).click();
    await page.getByRole('button', { name: 'Listing 0', exact: true }).waitFor();
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('agenda native cursor scope survives paging and resets cache scope without switching saved channels', async () => {
  const page = await narrowAgenda({ width: 360, height: 640, font: 16 });
  try {
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'host');
      Reflect.set(window, 'cursorQueries', []);
      Reflect.set(window, 'dbRevision', 1);
      Reflect.set(window, 'rejectContinued', false);
      host.query = async (q: ProgramQuery) => {
        Reflect.get(window, 'cursorQueries').push(structuredClone(q));
        const channel = Reflect.get(window, 'channels').find(
          (c: TimelineChannel) => c.id === q.appChannelIds[0],
        );
        const sourceRevision = channel.guideRevision ?? 1;
        const databaseRevision = Reflect.get(window, 'dbRevision');
        const key = JSON.stringify([
          q.guideSourceId,
          q.appChannelIds,
          q.windowStartMs,
          q.windowEndMs,
          q.contextAtMs ?? null,
          q.search,
        ]);
        if (
          q.cursor &&
          (q.cursor.queryKey !== key ||
            q.cursor.sourceRevision !== sourceRevision ||
            q.cursor.databaseRevision !== databaseRevision ||
            Reflect.get(window, 'rejectContinued'))
        )
          throw new Error('guide-stale-cursor');
        if (Reflect.get(window, 'holdCursorRead')) {
          Reflect.set(window, 'holdCursorRead', false);
          await new Promise<void>((resolve) => Reflect.set(window, 'releaseCursorRead', resolve));
        }
        return {
          sourceRevision,
          databaseRevision,
          programs: [
            {
              catalogSourceId: channel.sourceId,
              appChannelId: channel.id,
              guideSourceId: channel.guideSourceId,
              xmltvChannelId: channel.xmltvChannelId,
              startMs: q.windowStartMs,
              stopMs: q.windowStartMs + 60000,
              ordinal: q.cursor ? 1 : 0,
              title: q.cursor ? 'Continued fresh listing' : 'First fresh listing',
              description: null,
              categories: [],
            },
          ],
          nextCursor: q.cursor
            ? null
            : {
                queryKey: key,
                guideSourceId: channel.guideSourceId,
                sourceRevision,
                databaseRevision,
                startMs: q.windowStartMs,
                ordinal: 0,
                appChannelId: channel.id,
              },
        };
      };
      await Reflect.get(window, 'owner').refresh();
    });
    await page.getByRole('button', { name: 'Next guide channel', exact: true }).click();
    await expect
      .poll(() => page.locator('.gx-agenda-channel .media-result-title').textContent())
      .toBe('Channel 1');
    await page.getByRole('button', { name: 'More listings', exact: true }).click();
    await page.getByRole('button', { name: 'Continued fresh listing', exact: true }).waitFor();
    await page.evaluate(() => {
      Reflect.set(window, 'holdCursorRead', true);
      Reflect.set(window, 'heldCursorWork', Reflect.get(window, 'owner').refresh());
    });
    await expect
      .poll(() => page.evaluate(() => typeof Reflect.get(window, 'releaseCursorRead')))
      .toBe('function');
    await page.evaluate(() => {
      const channels = Reflect.get(window, 'channels');
      Reflect.set(
        window,
        'channels',
        channels.map((c: TimelineChannel) =>
          c.id === 'c1' ? { ...c, guideRevision: 2, xmltvChannelId: 'fresh-x1' } : c,
        ),
      );
      Reflect.set(window, 'dbRevision', 2);
      Reflect.set(window, 'cacheReloadDone', false);
      Reflect.set(
        window,
        'cacheReload',
        Reflect.get(window, 'owner')
          .setForeground(true)
          .then(() => Reflect.set(window, 'cacheReloadDone', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'cacheReloadDone'))).toBe(false);
    await page.evaluate(async () => {
      Reflect.get(window, 'releaseCursorRead')();
      await Reflect.get(window, 'heldCursorWork');
      await Reflect.get(window, 'cacheReload');
    });
    expect(await page.locator('.gx-agenda-channel .media-result-title').textContent()).toBe(
      'Channel 1',
    );
    expect(
      await page.getByRole('button', { name: 'Continued fresh listing', exact: true }).count(),
    ).toBe(0);
    await page.getByRole('button', { name: 'First fresh listing', exact: true }).waitFor();
    expect(await page.evaluate(() => Reflect.get(window, 'cursorQueries').at(-1))).toMatchObject({
      appChannelIds: ['c1'],
      cursor: null,
    });
    await page.getByRole('button', { name: 'More listings', exact: true }).click();
    await page.getByRole('button', { name: 'Continued fresh listing', exact: true }).waitFor();
    await page.evaluate(async () => {
      Reflect.set(window, 'dbRevision', 3); // Another feed changed, selected source stays revision 2.
      await Reflect.get(window, 'owner').setForeground(true);
    });
    expect(await page.locator('.gx-agenda-channel .media-result-title').textContent()).toBe(
      'Channel 1',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'cursorQueries').at(-1))).toMatchObject({
      appChannelIds: ['c1'],
      cursor: null,
    });
    await page.evaluate(() => Reflect.set(window, 'rejectContinued', true));
    await page.getByRole('button', { name: 'More listings', exact: true }).click();
    await page.getByRole('button', { name: 'First listings', exact: true }).waitFor();
    expect(await page.locator('.gx-timeline-status').textContent()).toContain('could not refresh');
    expect(await page.locator('.gx-agenda-listing').count()).toBe(0);
    await page.getByRole('button', { name: 'First listings', exact: true }).click();
    await page.getByRole('button', { name: 'First fresh listing', exact: true }).waitFor();
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('agenda Favorites excludes nonfavorites, resets paged scope after metadata changes and recovers empty through All', async () => {
  const page = await narrowAgenda({ width: 360, height: 640, font: 16 });
  try {
    await page.evaluate(async () => {
      const channels = Reflect.get(window, 'channels');
      Reflect.set(
        window,
        'channels',
        channels.slice(0, 3).map((c: TimelineChannel, i: number) => ({
          ...c,
          name: 'Duplicate name',
          favorite: i === 1,
        })),
      );
      const host = Reflect.get(window, 'host');
      const original = host.query;
      Reflect.set(window, 'favoriteQueries', []);
      host.query = async (q: ProgramQuery, signal: AbortSignal) => {
        Reflect.get(window, 'favoriteQueries').push(structuredClone(q));
        return {
          ...(await original(q, signal)),
          nextCursor: q.cursor
            ? null
            : {
                queryKey: 'fixture',
                guideSourceId: 'g',
                sourceRevision: 1,
                databaseRevision: 1,
                startMs: q.windowStartMs,
                ordinal: 1,
                appChannelId: q.appChannelIds[0],
              },
        };
      };
      await Reflect.get(window, 'owner').setForeground(true);
    });
    await page.getByRole('button', { name: 'Favorites', exact: true }).click();
    await page.getByRole('button', { name: 'More listings', exact: true }).waitFor();
    expect(
      await page.evaluate(() => Reflect.get(window, 'favoriteQueries').at(-1).appChannelIds),
    ).toEqual(['c1']);
    await page.getByRole('button', { name: 'More listings', exact: true }).click();
    await page.getByRole('button', { name: 'First listings', exact: true }).waitFor();
    await page.evaluate(async () => {
      Reflect.set(
        window,
        'channels',
        Reflect.get(window, 'channels').map((c: TimelineChannel) => ({
          ...c,
          favorite: c.id === 'c2',
        })),
      );
      await Reflect.get(window, 'owner').setForeground(true);
    });
    expect(await page.evaluate(() => Reflect.get(window, 'favoriteQueries').at(-1))).toMatchObject({
      appChannelIds: ['c2'],
      cursor: null,
    });
    const beforeEmptyQueries = await page.evaluate(
      () => Reflect.get(window, 'favoriteQueries').length,
    );
    await page.evaluate(async () => {
      Reflect.set(
        window,
        'channels',
        Reflect.get(window, 'channels').filter((c: TimelineChannel) => c.id !== 'c2'),
      );
      await Reflect.get(window, 'owner').setForeground(true);
    });
    expect(await page.locator('.gx-agenda-listing').count()).toBe(0);
    expect(await page.locator('.gx-timeline-status').textContent()).toBe(
      'No favorite channels. Choose All to browse saved channels.',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'favoriteQueries').length)).toBe(
      beforeEmptyQueries,
    );
    await page.getByRole('button', { name: 'All channels', exact: true }).click();
    await page
      .getByRole('button', {
        name: 'Live championship: complete teams, venue and match information',
        exact: true,
      })
      .waitFor();
    expect(await page.locator('.gx-timeline-status').textContent()).not.toContain(
      'No favorite channels',
    );
    expect(await page.evaluate(() => Reflect.get(window, 'favoriteQueries').length)).toBe(
      beforeEmptyQueries + 1,
    );
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('agenda held refresh joins suspension and cannot append stale programmes or escape focus', async () => {
  const page = await narrowAgenda({ width: 360, height: 640, font: 16 }, false);
  try {
    await page.getByRole('button', { name: 'Future listing', exact: true }).focus();
    await page.evaluate(() => {
      Reflect.set(window, 'mode', 'blocked');
      Reflect.set(window, 'pendingAgenda', Reflect.get(window, 'owner').refresh());
    });
    await page.keyboard.press('ArrowDown');
    expect(
      await page.locator('.gx-timeline-viewport').evaluate((n) => n === document.activeElement),
    ).toBe(true);
    await page.evaluate(() => {
      Reflect.set(window, 'agendaSuspended', false);
      Reflect.set(
        window,
        'suspendAgenda',
        Reflect.get(window, 'owner')
          .suspend()
          .then(() => Reflect.set(window, 'agendaSuspended', true)),
      );
    });
    expect(await page.evaluate(() => Reflect.get(window, 'agendaSuspended'))).toBe(false);
    await page.evaluate(async () => {
      Reflect.get(window, 'release')();
      await Reflect.get(window, 'pendingAgenda');
      await Reflect.get(window, 'suspendAgenda');
    });
    expect(await page.locator('.gx-agenda-listing').count()).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    await page.evaluate(async () => {
      Reflect.set(window, 'mode', 'normal');
      await Reflect.get(window, 'owner').setForeground(true);
    });
    expect(await page.locator('.gx-agenda-listing').count()).toBe(2);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
it('agenda unknown ends never imply current Watch and invalid programme times are refused', async () => {
  const page = await narrowAgenda({ width: 360, height: 640, font: 16 });
  try {
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'host'),
        query = host.query;
      Reflect.set(window, 'agendaOriginalQuery', query);
      host.query = async (q: unknown, signal: AbortSignal) => {
        const reply = await query(q, signal);
        reply.programs = [{ ...reply.programs[0], title: 'End is unknown', stopMs: null }];
        return reply;
      };
      await Reflect.get(window, 'owner').refresh();
    });
    expect(await page.locator('.gx-agenda-time').textContent()).toContain('End time unknown');
    await page.getByRole('button', { name: 'End is unknown', exact: true }).click();
    await page.getByRole('button', { name: 'Back to timeline', exact: true }).waitFor();
    expect(
      await page.getByRole('button', { name: 'Watch current channel', exact: true }).count(),
    ).toBe(0);
    expect(await page.evaluate(() => Reflect.get(window, 'watches'))).toBe(0);
    await page.keyboard.press('Escape');
    await page.evaluate(async () => {
      const host = Reflect.get(window, 'host'),
        query = Reflect.get(window, 'agendaOriginalQuery');
      host.query = async (q: unknown, signal: AbortSignal) => {
        const reply = await query(q, signal);
        reply.programs[0].startMs = NaN;
        return reply;
      };
      await Reflect.get(window, 'owner').refresh();
    });
    expect(await page.locator('.gx-agenda-listing').count()).toBe(0);
    expect(await page.locator('.gx-timeline-status').textContent()).toContain(
      'Guide could not refresh',
    );
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
