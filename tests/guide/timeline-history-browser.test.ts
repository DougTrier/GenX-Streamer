/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { expect, it } from 'vitest';
import { fixture, useTimelineBrowser } from './timeline-browser.fixture';

useTimelineBrowser();

async function historyFixture(ids = ['c1', 'b', 'adult']) {
  const page = await fixture(false);
  await page.evaluate((ids) => {
    const host = Reflect.get(window, 'host');
    const source = [
      { id: 'a', name: 'Unwatched representative', category: 'News' },
      { id: 'b', name: 'Exact watched alias', category: 'News' },
      { id: 'c1', name: 'Watched PPV event', category: 'Sports', ppv: true },
      {
        id: 'adult',
        name: 'Hidden original group',
        category: 'News',
        originalCategory: 'ＡＤＵＬＴ',
      },
    ].map((row) => ({
      ...row,
      sourceId: 's',
      guideSourceId: 'g',
      xmltvChannelId: 'x' + row.id,
      guideRevision: 1,
    }));
    Reflect.set(window, 'channels', source);
    Reflect.set(window, 'browseScope', {
      filter: 'watched',
      query: '',
      history: { ids, hideAdult: true },
    });
    Reflect.set(window, 'historyMembership', []);
    Reflect.set(window, 'historyPrograms', []);
    host.browseScope = () => Reflect.get(window, 'browseScope');
    host.listedChannels = async (
      _start: number,
      _end: number,
      signal: AbortSignal,
      _search?: string,
      ppv = false,
      _sports?: unknown,
      history?: { ids: string[] },
    ) => {
      Reflect.get(window, 'historyMembership').push({
        ppv,
        history: history && structuredClone(history),
      });
      if (Reflect.get(window, 'holdHistory')) {
        Reflect.set(window, 'holdHistory', false);
        await new Promise<void>((resolve) => Reflect.set(window, 'releaseHistory', resolve));
      }
      signal.throwIfAborted();
      return {
        catalogRevision: '1',
        databaseRevision: 1,
        viewRevision: '1',
        groupingPolicy: 'exact-ordered-endpoints-policy-v2',
        // Deliberately returns extra inventory: the timeline must still intersect exact IDs/adult policy before virtualization.
        channels: source
          .filter((row) => history || (row.ppv === true) === ppv)
          .map((row) => ({
            catalogSourceId: 's',
            appChannelId: row.id,
            guideSourceId: 'g',
            xmltvChannelId: row.xmltvChannelId,
            sourceRevision: 1,
            filterMask: row.ppv ? 8 : 0,
          })),
      };
    };
    host.query = async (query: { appChannelIds: string[]; historyIds?: string[] }) => {
      Reflect.get(window, 'historyPrograms').push(structuredClone(query));
      const channel = source.find((row) => row.id === query.appChannelIds[0])!;
      return {
        programs: [
          {
            catalogSourceId: 's',
            appChannelId: channel.id,
            guideSourceId: 'g',
            xmltvChannelId: channel.xmltvChannelId,
            startMs: Reflect.get(window, 'base'),
            stopMs: Reflect.get(window, 'base') + 1800000,
            ordinal: 0,
            title: channel.ppv ? 'PPV actual watched programme' : 'Ordinary watched programme',
            description: null,
            categories: [],
          },
        ],
        nextCursor: null,
        sourceRevision: 1,
        databaseRevision: 1,
      };
    };
  }, ids);
  await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
  return page;
}

const names = (page: Awaited<ReturnType<typeof historyFixture>>) =>
  page.locator('.gx-timeline-channel .media-result-title').allTextContents();
async function close(page: Awaited<ReturnType<typeof historyFixture>>) {
  try {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
  } finally {
    await page.close();
  }
}

it('inherits exact ordered History before virtual paging, keeps watched PPV and blocks original adult aliases', async () => {
  const page = await historyFixture();
  try {
    expect(await names(page)).toEqual(['Watched PPV event', 'Exact watched alias']);
    expect(
      await page.getByRole('button', { name: 'History', exact: true }).getAttribute('aria-pressed'),
    ).toBe('true');
    expect(await page.locator('.gx-timeline-cell').first().textContent()).toContain(
      'PPV actual watched programme',
    );
    expect(await page.locator('.gx-timeline-channel .ppv-badge').count()).toBe(1);
    const calls = await page.evaluate(() => ({
      listed: Reflect.get(window, 'historyMembership'),
      programs: Reflect.get(window, 'historyPrograms'),
    }));
    expect(calls.listed[0]).toEqual({
      ppv: false,
      history: { ids: ['c1', 'b', 'adult'], hideAdult: true },
    });
    expect(
      calls.programs.map((query: { appChannelIds: string[] }) => query.appChannelIds[0]),
    ).toEqual(['c1', 'b']);
    for (const query of calls.programs) {
      expect(query.historyIds).toEqual(['c1', 'b', 'adult']);
      expect(query.hideAdult).toBe(true);
      expect(query.ppv).toBeUndefined();
    }
  } finally {
    await close(page);
  }
});

it('keeps empty History empty and exits its ID scope on explicit local PPV/All choices', async () => {
  const page = await historyFixture([]);
  try {
    expect(await names(page)).toEqual([]);
    await page.getByRole('button', { name: 'PPV', exact: true }).click();
    await expect.poll(() => names(page)).toEqual(['Watched PPV event']);
    expect(await page.evaluate(() => Reflect.get(window, 'historyMembership').at(-1))).toEqual({
      ppv: true,
      history: undefined,
    });
    expect(
      (await page.evaluate(() => Reflect.get(window, 'historyPrograms').at(-1))).historyIds,
    ).toBeUndefined();
    await page.getByRole('button', { name: 'All channels', exact: true }).click();
    await expect.poll(() => names(page)).toContain('Unwatched representative');
    expect(await page.evaluate(() => Reflect.get(window, 'historyMembership').at(-1))).toEqual({
      ppv: false,
      history: undefined,
    });
    await page.getByRole('button', { name: 'History', exact: true }).click();
    await expect.poll(() => names(page)).toEqual([]);
  } finally {
    await close(page);
  }
});

it('revokes displayed rows and old in-flight History membership on a changed active-scope ID snapshot', async () => {
  const page = await historyFixture();
  try {
    await page.evaluate(() => {
      Reflect.set(window, 'holdHistory', true);
      Reflect.set(window, 'heldRefresh', Reflect.get(window, 'owner').refresh());
    });
    await expect
      .poll(() => page.evaluate(() => typeof Reflect.get(window, 'releaseHistory')))
      .toBe('function');
    await page.evaluate(() => {
      Reflect.set(window, 'browseScope', {
        filter: 'watched',
        query: '',
        history: { ids: ['b'], hideAdult: true },
      });
      Reflect.set(window, 'replacementRefresh', Reflect.get(window, 'owner').refresh());
    });
    expect(await names(page)).toEqual([]);
    await page.evaluate(async () => {
      Reflect.get(window, 'releaseHistory')();
      await Reflect.get(window, 'replacementRefresh');
    });
    expect(await names(page)).toEqual(['Exact watched alias']);
    expect(
      (await page.evaluate(() => Reflect.get(window, 'historyPrograms').at(-1))).historyIds,
    ).toEqual(['b']);
    await page.evaluate(async () => {
      Reflect.set(window, 'browseScope', {
        filter: 'watched',
        query: '',
        history: { ids: [], hideAdult: true },
      });
      await Reflect.get(window, 'owner').refresh();
    });
    expect(await names(page)).toEqual([]);
  } finally {
    await close(page);
  }
});
