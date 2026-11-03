// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { captureSportsScope } from '../../src/search/sports';
import { fixture, useTimelineBrowser, remoteBundle } from './timeline-browser.fixture';

useTimelineBrowser();

async function sportsFixture() {
  const page = await fixture(false);
  const sports = captureSportsScope(
    'NFL',
    { sport: 'american-football', league: 'nfl' },
    Date.UTC(2026, 9, 11, 12),
  )!;
  await page.evaluate((sports) => {
    const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    w.channels = [
      {
        id: 'c0',
        sourceId: 's',
        name: 'NFL regular',
        category: 'Sports',
        originalCategory: 'US | NFL',
        guideSourceId: 'g',
        xmltvChannelId: 'x0',
        guideRevision: 1,
      },
      {
        id: 'c1',
        sourceId: 's',
        name: 'NFL PPV',
        category: 'Sports',
        ppv: true,
        guideSourceId: 'g',
        xmltvChannelId: 'x1',
        guideRevision: 1,
      },
      {
        id: 'c2',
        sourceId: 's',
        name: 'MLB PPV',
        category: 'Sports',
        ppv: true,
        guideSourceId: 'g',
        xmltvChannelId: 'x2',
        guideRevision: 1,
      },
      {
        id: 'c3',
        sourceId: 's',
        name: 'FOX local',
        category: 'News',
        guideSourceId: 'g',
        xmltvChannelId: 'x3',
        guideRevision: 1,
      },
    ];
    w.browseScope = { filter: 'sports', query: 'NFL', sports };
    w.host.browseScope = () => w.browseScope;
    w.membershipCalls = [];
    w.programCalls = [];
    w.host.listedChannels = async (
      start: number,
      end: number,
      signal: AbortSignal,
      search?: string,
      ppv?: boolean,
      scope?: { sport?: string },
    ) => {
      signal.throwIfAborted();
      w.membershipCalls.push({ start, end, search, ppv, sports: scope });
      const ids = ppv
        ? ['c1', 'c2']
        : scope?.sport === 'baseball'
          ? ['c2']
          : scope || search
            ? ['c0', 'c1', 'c3']
            : ['c0', 'c3'];
      return {
        catalogRevision: '1',
        databaseRevision: 1,
        viewRevision: '1',
        groupingPolicy: 'exact-ordered-endpoints-policy-v2',
        channels: w.channels
          .filter((c: { id: string }) => ids.includes(c.id))
          .map((c: { id: string; xmltvChannelId: string; ppv?: boolean }) => ({
            catalogSourceId: 's',
            appChannelId: c.id,
            guideSourceId: 'g',
            xmltvChannelId: c.xmltvChannelId,
            sourceRevision: 1,
            filterMask: c.ppv ? 12 : c.id === 'c3' ? 2 : 4,
          })),
      };
    };
    w.host.query = async (q: { appChannelIds: string[] }) => {
      w.programCalls.push(q);
      const c = w.channels.find((row: { id: string }) => row.id === q.appChannelIds[0]);
      return {
        programs: [
          {
            catalogSourceId: 's',
            appChannelId: c.id,
            guideSourceId: 'g',
            xmltvChannelId: c.xmltvChannelId,
            startMs: w.base,
            stopMs: w.base + 1800000,
            ordinal: 0,
            title:
              c.id === 'c2'
                ? 'MLB Cardinals at Cubs'
                : c.ppv
                  ? 'PPV Chicago Bears at Buffalo Bills'
                  : 'Chicago Bears at Buffalo Bills',
            description: null,
            categories: [{ text: c.id === 'c2' ? 'MLB' : 'NFL' }],
          },
        ],
        nextCursor: null,
        sourceRevision: 1,
        databaseRevision: 1,
      };
    };
  }, sports);
  await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
  return { page, sports };
}

it('seeds only the active tab and admits a generic affiliate through native sport membership with visible PPV', async () => {
  const { page, sports } = await sportsFixture();
  try {
    expect(await page.getByLabel('Sport', { exact: true }).inputValue()).toBe('american-football');
    expect(await page.getByLabel('League', { exact: true }).inputValue()).toBe('nfl');
    expect(
      await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
    ).toEqual(['NFL regular', 'NFL PPV', 'FOX local']);
    expect(await page.locator('.sports-inclusion-status').isVisible()).toBe(true);
    expect(
      await page
        .locator('.gx-timeline-channel')
        .filter({ hasText: 'NFL PPV' })
        .locator('.ppv-badge')
        .count(),
    ).toBe(1);
    expect(
      await page
        .locator('.gx-timeline-channel')
        .filter({ hasText: 'FOX local' })
        .locator('.ppv-badge')
        .count(),
    ).toBe(0);
    const requests = await page.evaluate(() => ({
      listed: Reflect.get(window, 'membershipCalls'),
      programs: Reflect.get(window, 'programCalls'),
    }));
    expect(requests.listed[0]).toMatchObject({ search: 'NFL', sports });
    expect(requests.programs.length).toBeGreaterThan(0);
    for (const request of requests.programs) {
      expect(request).toMatchObject({ search: 'NFL', sports });
      expect(request.contextAtMs).toBeUndefined();
    }
    expect(await page.locator('.gx-timeline-cell.gx-timeline-match').count()).toBe(3);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('changes programme cache scope with the sport and restores ordinary PPV separation when cleared', async () => {
  const { page } = await sportsFixture();
  try {
    await page.getByLabel('Search guide channels and programs').fill('');
    await page.getByLabel('Search guide channels and programs').press('Enter');
    await page.getByLabel('Sport', { exact: true }).selectOption('baseball');
    await page.locator('.gx-timeline-channel').filter({ hasText: 'MLB PPV' }).waitFor();
    const last = await page.evaluate(() => Reflect.get(window, 'programCalls').at(-1));
    expect(last).toMatchObject({
      appChannelIds: ['c2'],
      search: '',
      sports: { sport: 'baseball', includePpv: true },
    });
    expect(last.sports.league).toBeUndefined();
    await page.getByRole('button', { name: 'All channels', exact: true }).click();
    await expect
      .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
      .toEqual(['NFL regular', 'FOX local']);
    expect(await page.locator('.sports-inclusion-status').isVisible()).toBe(false);
    expect(await page.locator('.gx-timeline-channel .ppv-badge').count()).toBe(0);
    expect(
      (await page.evaluate(() => Reflect.get(window, 'membershipCalls').at(-1))).sports,
    ).toBeUndefined();
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('reopens its own tab choices and replaces them only when that tab changes its main filters', async () => {
  const { page } = await sportsFixture();
  try {
    await page.getByRole('button', { name: 'News', exact: true }).click();
    await page.evaluate(async () => {
      const owner = Reflect.get(window, 'owner');
      await owner.setForeground(false);
      await owner.setForeground(true);
    });
    expect(
      await page.getByRole('button', { name: 'News', exact: true }).getAttribute('aria-pressed'),
    ).toBe('true');
    await page.evaluate(async () => {
      const owner = Reflect.get(window, 'owner');
      await owner.setForeground(false);
      Reflect.set(window, 'browseScope', { filter: 'all', query: '' });
      await owner.setForeground(true);
    });
    expect(
      await page
        .getByRole('button', { name: 'All channels', exact: true })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(await page.getByLabel('Search guide channels and programs').inputValue()).toBe('');
    expect(await page.locator('.sports-inclusion-status').isVisible()).toBe(false);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('keeps the Guide Sport and League controls reachable with remote arrows at handheld size', async () => {
  const { page } = await sportsFixture();
  try {
    await page.setViewportSize({ width: 832, height: 397 });
    await page.addStyleTag({
      content:
        'html{font-size:20px}body{font-size:20px}.sports-filter-controls label,.sports-filter-controls select{font-size:20px}',
    });
    await page.addScriptTag({ content: remoteBundle });
    await page.evaluate(() => Reflect.get(window, 'Remote').installRemoteNavigation());
    const sport = page.getByLabel('Sport', { exact: true });
    const league = page.getByLabel('League', { exact: true });
    await sport.focus();
    await page.keyboard.press('ArrowRight');
    expect(await league.evaluate((node) => node === document.activeElement)).toBe(true);
    await page.keyboard.press('ArrowLeft');
    expect(await sport.evaluate((node) => node === document.activeElement)).toBe(true);
    for (const control of [sport, league]) {
      expect(await control.evaluate((node) => parseFloat(getComputedStyle(node).fontSize))).toBe(
        20,
      );
      const bounds = await control.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(832);
      expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(397);
    }
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});

it('requires NFL evidence in the inherited American Football fallback instead of a literal substring', async () => {
  const page = await fixture(false);
  const sports = captureSportsScope(
    'NFL',
    { sport: 'american-football' },
    Date.UTC(2026, 9, 11, 12),
  )!;
  try {
    await page.evaluate((sports) => {
      const w = window as unknown as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
      w.channels = w.channels.slice(0, 3).map((channel: object, index: number) => ({
        ...channel,
        name: ['NFL Network', 'Conflict Channel', 'NFLive'][index],
        category: 'American Football',
      }));
      w.host.browseScope = () => ({
        filter: 'sports',
        query: 'NFL',
        sports,
      });
    }, sports);
    await page.evaluate(() => Reflect.get(window, 'owner').setForeground(true));
    expect(
      await page.locator('.gx-timeline-channel .media-result-title').allTextContents(),
    ).toEqual(['NFL Network']);
    await page.getByLabel('Search guide channels and programs').fill('Football');
    await page.getByLabel('Search guide channels and programs').press('Enter');
    await expect.poll(() => page.locator('.gx-timeline-channel').count()).toBe(3);
    await page.getByLabel('Search guide channels and programs').fill('NFLive');
    await page.getByLabel('Search guide channels and programs').press('Enter');
    await expect
      .poll(() => page.locator('.gx-timeline-channel .media-result-title').allTextContents())
      .toEqual(['NFLive']);
  } finally {
    await page.evaluate(() => Reflect.get(window, 'owner').dispose());
    await page.close();
  }
});
