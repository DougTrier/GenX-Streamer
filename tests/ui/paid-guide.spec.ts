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

import { expect, test, type Page } from '@playwright/test';

test('replay dates distinguish a provider air date from an exact completed NFL game', async ({
  page,
}) => {
  await page.route('**/replay-date-fixture', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Replay dates</title>' }),
  );
  await page.goto('/replay-date-fixture');
  const result = await page.evaluate(async () => {
    const { nflGameDate, nflReplayQuery, replayDateLabel } = await import(
      '/src/search/replay-dates.ts' as string
    );
    const listing = {
      title: 'NFL Replay: Cowboys at Eagles · 2025 Week 1',
      startMs: Date.UTC(2026, 10, 7),
    };
    const query = nflReplayQuery(listing);
    const url = 'https://www.nfl.com/games/cowboys-at-eagles-2025-reg-1';
    const html = `<title>Dallas Cowboys at Philadelphia Eagles 2025 REG 1 - Game Center</title>
      <link rel="canonical" href="${url}">
      <section data-testid="MatchupBanner-2"><time data-testid="game-date" datetime="2025-09-05T00:20:00Z"></time></section>
      <script>window.utag_data = {"gameState":"FINAL","siteSubsection":"gamecenter"};</script>`;
    const replay = { originalAirDate: '2025-09-04', previousAirDate: '2025-09-06' };
    return {
      url: query?.urls[0],
      official: nflGameDate(html, url, query)?.day,
      future: nflGameDate(html.replace('FINAL', 'PREGAME'), url, query),
      wrongTeams: nflGameDate(html.replace('Philadelphia Eagles', 'Detroit Lions'), url, query),
      missingWeek: nflReplayQuery({ ...listing, title: 'NFL Replay: Cowboys at Eagles · 2025' }),
      provider: replayDateLabel({ ...listing, replay }),
      previous: replayDateLabel({ ...listing, replay: { ...replay, originalAirDate: null } }),
      skipLookup: nflReplayQuery({ ...listing, replay }),
    };
  });
  expect(result.url).toBe('https://www.nfl.com/games/cowboys-at-eagles-2025-reg-1');
  expect(result.official).toBe('2025-09-04');
  expect(result.future).toBeUndefined();
  expect(result.wrongTeams).toBeUndefined();
  expect(result.missingWeek).toBeUndefined();
  expect(result.provider).toMatch(/^Originally aired · /u);
  expect(result.previous).toMatch(/^Previously aired · /u);
  expect(result.skipLookup).toBeUndefined();
});

/** The real Paid TV guide panel and timeline with a controlled guide host (no native, no network). */
async function mount(
  page: Page,
  options: {
    stored: 'none' | 'fresh' | 'old';
    download: 'ok' | 'fail';
    locations?: boolean;
    ageMs?: number;
    ppv?: boolean;
    sharedEpg?: boolean;
    sports?: boolean;
    history?: boolean;
    replay?: boolean;
    laterMatch?: boolean;
  },
): Promise<void> {
  await page.route('**/paid-guide-fixture', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><html><body style="margin:0"><div id="host" style="display:flex;width:1100px;height:640px"></div></body></html>',
    }),
  );
  await page.goto('/paid-guide-fixture');
  await page.evaluate(async (options) => {
    await import('/src/ui/guide-timeline.css' as string);
    await import('/src/ui/sports-filters.css' as string);
    await import('/src/ui/guide-panel.css' as string);
    const { mountPaidGuide } = await import('/src/ui/guide/paid-guide.ts' as string);
    const hour = 3_600_000;
    const now = Math.floor(Date.now() / (30 * 60_000)) * 30 * 60_000;
    const accountId = 'a'.repeat(32);
    const channel = {
      id: `account-${accountId}-${'f'.repeat(64)}`,
      name: 'FOX 32 Chicago',
      category: 'US| LOCALS',
      epgId: 'fox32.us',
      providerId: '32',
      streamReference: 'b'.repeat(32),
      favorite: false,
      country: 'US',
    };
    const rows = options.ppv
      ? [
          { ...channel, name: 'ESPN Finals', category: 'Sports', favorite: true },
          {
            ...channel,
            id: `account-${accountId}-${'e'.repeat(64)}`,
            epgId: 'event.ppv',
            name: 'Event 1',
            category: 'Sports',
            ppv: true,
            favorite: true,
          },
        ]
      : options.locations
        ? [
            { ...channel, category: 'Sports' },
            {
              ...channel,
              id: `account-${accountId}-${'e'.repeat(64)}`,
              name: 'Canada Sports',
              category: 'Sports',
              country: 'CA',
              epgId: 'sports.ca',
            },
            {
              ...channel,
              id: `account-${accountId}-${'d'.repeat(64)}`,
              name: 'Unknown News',
              category: 'News',
              country: null,
              epgId: 'unknown',
            },
          ]
        : [channel];
    if (options.sports) {
      rows[0]!.name = 'NFL regular';
      rows[0]!.category = 'US | NFL';
      rows[1]!.name = 'NFL PPV';
      rows[1]!.category = 'US | NFL PPV';
      rows.push({
        ...channel,
        id: `account-${accountId}-${'c'.repeat(64)}`,
        name: 'MLB PPV',
        category: 'US | MLB PPV',
        epgId: 'baseball',
        ppv: true,
      });
    }
    if (options.history) {
      rows.push(
        {
          ...channel,
          id: `account-${accountId}-${'d'.repeat(64)}`,
          name: 'Unwatched same EPG',
          epgId: channel.epgId,
        },
        {
          ...channel,
          id: `account-${accountId}-${'c'.repeat(64)}`,
          name: 'Watched hidden adult',
          category: 'ＡＤＵＬＴ',
          epgId: 'adult',
        },
        {
          ...channel,
          id: `account-${accountId}-${'1'.repeat(64)}`,
          name: 'Watched Canada',
          country: 'CA',
          epgId: 'canada',
        },
      );
      Reflect.set(window, 'paidBrowseScope', {
        filter: 'watched',
        query: '',
        history: { ids: [rows[1]!.id, rows[0]!.id, rows[3]!.id, rows[4]!.id], hideAdult: true },
      });
    }
    Reflect.set(
      window,
      'guideLocation',
      options.locations || options.history ? { country: 'US' } : {},
    );
    if (options.sharedEpg)
      rows.forEach((row) => {
        row.epgId = channel.epgId;
      });
    const status = (fetchedMs: number, revision: number) => ({
      revision,
      fetchedMs,
      programs: 1,
      channels: 1,
      skipped: 2,
    });
    let stored =
      options.stored === 'none'
        ? null
        : status(
            options.ageMs === undefined
              ? options.stored === 'fresh'
                ? now - hour
                : now - 24 * hour
              : now - options.ageMs,
            1,
          );
    const log: string[] = [];
    const guide = {
      status: async () => stored,
      refresh: async () => {
        log.push('download');
        if (options.download === 'fail') throw new Error('account-guide-not-offered');
        stored = status(now, (stored?.revision ?? 0) + 1);
        return stored;
      },
      channels: async () => (stored ? rows : []),
      listed: async (
        _a: unknown,
        _from: number,
        _to: number,
        search: string,
        _signal?: AbortSignal,
        ppv = false,
        sports?: { sport?: string; league?: string; includePpv?: boolean },
        history?: { ids: readonly string[]; hideAdult: boolean },
      ) => {
        Reflect.set(window, 'lastListedSports', sports);
        Reflect.set(window, 'lastListedHistory', history);
        Reflect.set(window, 'lastListedWindow', [_from, _to]);
        const matched = rows
          .filter((row) => !history || history.ids.includes(row.id))
          .filter((row) => !options.sharedEpg || ('ppv' in row && row.ppv === true) === ppv)
          .filter(
            (row) =>
              !options.ppv || history || ppv || sports?.includePpv || !('ppv' in row && row.ppv),
          )
          .filter(
            (row) =>
              !options.sports ||
              !sports?.sport ||
              row.category.includes(sports.sport === 'american-football' ? 'NFL' : 'MLB'),
          )
          .filter(
            (row) =>
              !search ||
              (options.laterMatch &&
                search.toLowerCase() === 'football' &&
                _from <= now + 5 * hour &&
                now + 5 * hour < _to) ||
              (options.ppv && ppv && search.toLowerCase() === 'championship') ||
              `${row.name} ${row.category}`.toLowerCase().includes(search.toLowerCase()),
          );
        return {
          revision: stored!.revision,
          epgIds: matched.map((row) => row.epgId),
          channelIds: matched.map((row) => row.id),
          ...(options.laterMatch ? { firstStartsMs: matched.map(() => now + 5 * hour) } : {}),
          ppvChannelIds: matched
            .filter((row) => ppv || ('ppv' in row && row.ppv))
            .map((row) => row.id),
        };
      },
      programs: async (
        _a: unknown,
        epgId: string,
        _from: number,
        _to: number,
        _after: unknown,
        _limit: number,
        _signal?: AbortSignal,
        ppv = false,
        channelId?: string,
        sports?: unknown,
        search?: string,
        history?: { ids: readonly string[]; hideAdult: boolean },
      ) => {
        Reflect.set(window, 'lastProgramChannelId', channelId);
        Reflect.set(window, 'lastProgramScope', { sports, search, channelId, history });
        const currentRow = rows.find((row) => row.id === channelId);
        const watchedPpv =
          !!history && !!currentRow && 'ppv' in currentRow && currentRow.ppv === true;
        return {
          revision: stored!.revision,
          programs: [
            {
              epgId,
              startMs: options.laterMatch ? now + 5 * hour : now,
              stopMs: now + (options.laterMatch ? 8 : 3) * hour,
              ordinal: 0,
              title: options.sports
                ? rows.find((row) => row.id === channelId)?.category.includes('MLB')
                  ? 'PPV MLB Cardinals at Cubs'
                  : 'NFL Chicago Bears at Buffalo Bills'
                : options.ppv
                  ? ppv || watchedPpv
                    ? 'PPV Championship'
                    : 'Sports roundup'
                  : 'NFL Football: Bears at Saints',
              description: 'Chicago and New Orleans meet.',
              categories: [],
              ...(options.replay
                ? { replay: { originalAirDate: '2025-09-04', previousAirDate: '2025-09-06' } }
                : {}),
            },
          ],
        };
      },
    };
    const panel = mountPaidGuide(document.getElementById('host')!, {
      ...(options.history ? { browseScope: () => Reflect.get(window, 'paidBrowseScope') } : {}),
      cachedChanged: () =>
        Reflect.set(window, 'publishedGuides', (Reflect.get(window, 'publishedGuides') ?? 0) + 1),
      guide,
      geography: () => Reflect.get(window, 'guideLocation'),
      watch: async (row: { name: string }) => {
        log.push(`watch:${row.name}`);
      },
      close: () => log.push('close'),
      now: () => Date.now(),
      formatTime: (ms: number) => new Date(ms).toISOString(),
    });
    Reflect.set(window, 'log', log);
    Reflect.set(window, 'paidPanel', panel);
    await panel.show({
      schemaVersion: 1,
      id: accountId,
      name: 'Provider',
      kind: 'xtream',
      serverOrigin: 'https://provider.invalid',
      allowHttp: false,
      revision: '1',
      requiresSignIn: false,
    });
  }, options);
}
const log = (page: Page) => page.evaluate(() => Reflect.get(window, 'log') as string[]);

test('Paid History Guide inherits exact ordered current-account IDs including PPV and intersects country/adult before rows', async ({
  page,
}) => {
  await mount(page, { stored: 'fresh', download: 'ok', ppv: true, history: true });
  const titles = page.locator('.gx-timeline-channel .media-result-title');
  await expect(titles).toHaveText(['Event 1', 'ESPN Finals']);
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.locator('.gx-timeline-cell').first()).toContainText('PPV Championship');
  const scope = await page.evaluate(() => ({
    listed: Reflect.get(window, 'lastListedHistory'),
    program: Reflect.get(window, 'lastProgramScope'),
  }));
  expect(scope.listed.ids).toHaveLength(4);
  expect(scope.program.history).toEqual(scope.listed);
  expect(scope.listed.ids).toContain(scope.program.channelId);
  expect(await log(page)).toEqual([]);
  await page.getByRole('button', { name: 'PPV', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => Reflect.get(window, 'lastListedHistory')))
    .toBeUndefined();
  expect(
    (await page.evaluate(() => Reflect.get(window, 'lastProgramScope'))).history,
  ).toBeUndefined();
  await page.getByRole('button', { name: 'All channels', exact: true }).click();
  await expect(titles).toContainText(['Unwatched same EPG']);
  await page.evaluate(async () => {
    Reflect.get(window, 'paidBrowseScope').history.ids = [];
    await Reflect.get(window, 'paidPanel').locationChanged();
  });
  await expect(titles).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('Paid Guide PPV is explicit, keeps Favorites/search separate, and leaves ordinary sports available', async ({
  page,
}) => {
  await mount(page, { stored: 'fresh', download: 'ok', ppv: true });
  const rows = page.locator('.gx-timeline-channel .media-result-title');
  await expect(rows).toHaveText(['ESPN Finals']);
  await page.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect(rows).toHaveText(['ESPN Finals']);
  const search = page.getByRole('searchbox', { name: 'Search guide channels and programs' });
  await search.fill('Championship');
  await search.press('Enter');
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: 'PPV', exact: true }).click();
  await expect(rows).toHaveText(['ESPN Finals', 'Event 1']);
  await expect(page.locator('.gx-timeline-cell')).toHaveText([
    'PPV Championship PPV',
    'PPV Championship PPV',
  ]);
  await expect(page.locator('.gx-timeline-cell .ppv-badge')).toHaveCount(2);
  await search.fill('');
  await search.press('Enter');
  await page.getByRole('button', { name: 'Sports', exact: true }).click();
  await expect(rows).toHaveText(['ESPN Finals']);
  expect(await log(page)).toEqual([]);
});

test('Paid Guide includes matching PPV for a specific sport and league, then restores the ordinary list', async ({
  page,
}) => {
  await mount(page, { stored: 'fresh', download: 'ok', ppv: true, sports: true });
  const rows = page.locator('.gx-timeline-channel .media-result-title');
  await page.getByRole('button', { name: 'Sports', exact: true }).click();
  await page.getByLabel('Sport', { exact: true }).selectOption('american-football');
  await page.getByLabel('League', { exact: true }).selectOption('nfl');
  await expect(rows).toHaveText(['NFL regular', 'NFL PPV']);
  await expect(page.locator('.sports-inclusion-status')).toBeVisible();
  await expect(page.locator('.gx-timeline-channel .ppv-badge')).toHaveCount(1);
  expect(await page.evaluate(() => Reflect.get(window, 'lastListedSports'))).toMatchObject({
    sport: 'american-football',
    league: 'nfl',
    includePpv: true,
  });
  expect(await page.evaluate(() => Reflect.get(window, 'lastProgramScope'))).toMatchObject({
    sports: { sport: 'american-football', league: 'nfl', includePpv: true },
    search: '',
  });
  await page.getByRole('button', { name: 'All channels', exact: true }).click();
  await expect(rows).toHaveText(['NFL regular']);
  await expect(page.locator('.sports-inclusion-status')).toBeHidden();
  expect(await log(page)).toEqual([]);
});

test('Paid Guide keeps an ordinary shared-EPG channel out of PPV and queries the exact admitted identity', async ({
  page,
}) => {
  await mount(page, { stored: 'fresh', download: 'ok', ppv: true, sharedEpg: true });
  const rows = page.locator('.gx-timeline-channel .media-result-title');
  await expect(rows).toHaveText(['ESPN Finals']);
  await page.getByRole('button', { name: 'PPV', exact: true }).click();
  await expect(rows).toHaveText(['Event 1']);
  expect(await page.evaluate(() => Reflect.get(window, 'lastProgramChannelId'))).toBe(
    `account-${'a'.repeat(32)}-${'e'.repeat(64)}`,
  );
  await page.getByRole('button', { name: 'All channels', exact: true }).click();
  await expect(rows).toHaveText(['ESPN Finals']);
});

test('Paid Guide inherits country choices, Unknown and category/search without downloading again', async ({
  page,
}) => {
  await mount(page, { stored: 'fresh', download: 'ok', locations: true });
  const rows = page.locator('.gx-timeline-channel .media-result-title');
  await expect(rows).toHaveText(['FOX 32 Chicago']);
  await page.getByRole('button', { name: 'Sports', exact: true }).click();
  const location = async (filter: Record<string, unknown>) => {
    await page.evaluate(async (filter) => {
      Reflect.set(window, 'guideLocation', filter);
      await Reflect.get(window, 'paidPanel').locationChanged();
    }, filter);
  };
  await location({ country: 'CA' });
  await expect(rows).toHaveText(['Canada Sports']);
  await location({ countries: ['US', 'CA'] });
  await expect(rows).toHaveText(['FOX 32 Chicago', 'Canada Sports']);
  const search = page.getByRole('searchbox', { name: 'Search guide channels and programs' });
  await search.fill('Canada');
  await search.press('Enter');
  await expect(rows).toHaveText(['Canada Sports']);
  await location({ country: 'US' });
  await expect(rows).toHaveCount(0);
  await search.fill('');
  await search.press('Enter');
  await expect(rows).toHaveText(['FOX 32 Chicago']);
  await location({ country: null });
  await expect(rows).toHaveCount(0);
  await page.getByRole('button', { name: 'All channels', exact: true }).click();
  await expect(rows).toHaveText(['Unknown News']);
  await location({});
  await expect(rows).toHaveText(['FOX 32 Chicago', 'Canada Sports', 'Unknown News']);
  expect(await log(page)).toEqual([]);
});

test('opening the Paid TV guide downloads the provider guide and lists its channels', async ({
  page,
}) => {
  await mount(page, { stored: 'none', download: 'ok' });
  await expect(page.getByRole('heading', { name: 'Paid TV guide · Provider' })).toBeVisible();
  await expect(page.locator('.paid-guide-status')).toContainText('1 channel with listings');
  await expect(page.locator('.paid-guide-status')).toContainText('2 unusable listings left out');
  await expect(page.getByRole('button', { name: 'FOX 32 Chicago' })).toBeVisible();
  await expect(page.getByRole('button', { name: /NFL Football: Bears at Saints/ })).toBeVisible();
  expect(await log(page)).toEqual(['download']);
  // Title and status share one line, so the grid keeps its rows.
  const title = await page.locator('.paid-guide-head h2').boundingBox();
  const status = await page.locator('.paid-guide-status').boundingBox();
  expect(Math.abs(title!.y + title!.height / 2 - (status!.y + status!.height / 2))).toBeLessThan(
    12,
  );
  await expect(page.locator('.paid-guide')).not.toContainText('seven days');
  await page.getByRole('button', { name: 'FOX 32 Chicago' }).click();
  await expect.poll(() => log(page)).toEqual(['download', 'watch:FOX 32 Chicago']);
  await page.getByRole('button', { name: 'Close guide' }).click();
  await expect.poll(async () => (await log(page)).at(-1)).toBe('close');
});

test('shows the original date separately from the replay slot in listing details', async ({
  page,
}) => {
  await mount(page, { stored: 'fresh', download: 'ok', replay: true });
  await page.getByRole('button', { name: /NFL Football: Bears at Saints/ }).click();
  await expect(page.getByText(/^Originally aired · /u)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Back to timeline' })).toBeVisible();
});

for (const narrow of [false, true]) {
  test(`Football searches the visible Paid Guide window and jumps to the next actual listing (narrow=${narrow})`, async ({
    page,
  }) => {
    await mount(page, { stored: 'fresh', download: 'ok', laterMatch: true });
    if (narrow) {
      await page.setViewportSize({ width: 430, height: 700 });
      await page.locator('#host').evaluate((host) => {
        host.style.width = '430px';
      });
      await expect(page.locator('.gx-timeline')).toHaveAttribute('data-layout', 'agenda');
    }
    const search = page.getByRole('searchbox', { name: 'Search guide channels and programs' });
    await search.fill('Football');
    await search.press('Enter');
    await expect(page.getByText('No matches for “Football” in these 3 hours.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'FOX 32 Chicago' })).toHaveCount(0);
    const firstWindow = await page.evaluate(
      () => Reflect.get(window, 'lastListedWindow') as number[],
    );
    expect(firstWindow[1]! - firstWindow[0]!).toBe(3 * 3_600_000);
    await page.getByRole('button', { name: 'Next match' }).click();
    await expect(page.getByRole('button', { name: /NFL Football: Bears at Saints/ })).toBeVisible();
    const laterWindow = await page.evaluate(
      () => Reflect.get(window, 'lastListedWindow') as number[],
    );
    expect(laterWindow[0]! - firstWindow[0]!).toBe(5 * 3_600_000);
  });
}

test('a guide downloaded recently opens without downloading again', async ({ page }) => {
  await mount(page, { stored: 'fresh', download: 'ok' });
  await expect(page.getByRole('button', { name: 'FOX 32 Chicago' })).toBeVisible();
  expect(await log(page)).toEqual([]);
  await page.getByRole('button', { name: 'Update guide' }).click();
  await expect.poll(() => log(page)).toEqual(['download']);
});

test('a failed download keeps the last good guide and says why', async ({ page }) => {
  await mount(page, { stored: 'old', download: 'fail' });
  await expect(page.locator('.paid-guide-status')).toContainText(
    "Your provider doesn't offer a program guide for this account.",
  );
  await expect(page.locator('.paid-guide-status')).toContainText('Showing the guide from');
  await expect(page.getByRole('button', { name: 'FOX 32 Chicago' })).toBeVisible();
});

test('a failed first download shows the reason and no borrowed listings', async ({ page }) => {
  await mount(page, { stored: 'none', download: 'fail' });
  await expect(page.locator('.paid-guide-status')).toContainText(
    "Your provider doesn't offer a program guide for this account. Use Update guide to try again.",
  );
  await expect(page.locator('.gx-timeline-row')).toHaveCount(0);
});

test('a saved Paid Guide renews at three hours and background receipts reload from storage only', async ({
  page,
}) => {
  await mount(page, { stored: 'fresh', download: 'ok', ageMs: 3 * 3600000 });
  expect(await log(page)).toEqual(['download']);
  await page.evaluate(() => Reflect.get(window, 'paidPanel').cacheChanged());
  expect(await log(page)).toEqual(['download']);
  await expect(page.locator('.gx-timeline-channel .media-result-title')).toHaveText([
    'FOX 32 Chicago',
  ]);
});

test('a changed committed Paid Guide snapshot publishes membership refresh once, including manual updates', async ({
  page,
}) => {
  await mount(page, { stored: 'fresh', download: 'ok' });
  expect(await page.evaluate(() => Reflect.get(window, 'publishedGuides'))).toBe(1);
  await page.getByRole('button', { name: 'Update guide', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'publishedGuides'))).toBe(2);
  await page.evaluate(() => Reflect.get(window, 'paidPanel').cacheChanged());
  expect(await page.evaluate(() => Reflect.get(window, 'publishedGuides'))).toBe(2);
  expect(await log(page)).toEqual(['download']);
});
