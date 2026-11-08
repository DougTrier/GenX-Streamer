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
import type { Channel } from '../../src/catalog/parser';
import type { FavoriteTeam } from '../../src/preferences/favorite-teams';
import { chooseSettingsSection } from './helpers/settings-section';

// Actual bundled main and preference owner. Controlled IPC proves frontend wiring only,
// not SQLite durability, native acquisition, or decoder behavior.
async function fixture(
  page: Page,
  streamHost = 'stream.fixture.invalid',
  sportsFavorites = false,
  listings?: (url: string) => string,
  platform: 'android' | 'windows' = 'android',
  teamFixture: {
    holdFirstSave?: boolean;
    channels?: Channel[];
    favoriteTeams?: FavoriteTeam[];
    isTelevision?: boolean;
  } = {},
) {
  let holdTeamWrite = teamFixture.holdFirstSave;
  const sources = ['first', 'second'].map((id) => ({
    id,
    name: id,
    kind: 'url',
    location: `https://${id}.fixture.invalid/catalog.m3u`,
  }));
  const channels = [
    {
      id: 'twin-first',
      sourceId: 'first',
      name: 'Shared name',
      category: 'News',
      urls: [`https://${streamHost}/first`],
    },
    {
      id: 'twin-second',
      sourceId: 'second',
      name: 'Shared name',
      category: 'News',
      urls: [`https://${streamHost}/second`],
    },
    {
      id: 'removed-favorite',
      sourceId: 'first',
      name: 'Removed favorite',
      category: 'Sports',
      urls: [`https://${streamHost}/removed`],
    },
  ];
  if (sportsFavorites)
    channels.push({
      id: 'favorite-sports',
      sourceId: 'first',
      name: 'Favorite sports station',
      category: 'Sports',
      urls: [`https://${streamHost}/favorite-sports`],
    });
  channels.push(...(teamFixture.channels ?? []));
  const catalog = JSON.stringify({ schemaVersion: 1, sources, channels });
  const scheduleStart = Math.floor(Date.now() / 1800000) * 1800000;
  const guideSource = {
    id: 'saved-guide',
    name: 'Saved fixture guide',
    kind: 'url',
    location: 'https://guide.fixture.invalid/guide',
    allowHttp: false,
    revision: 1,
    updatedMs: Date.now(),
  };
  const mappings = channels.map((c) => ({
    catalogSourceId: c.sourceId,
    appChannelId: c.id,
    guideSourceId: guideSource.id,
    xmltvChannelId: c.id,
  }));
  const programs = mappings.map((m, ordinal) => ({
    ...m,
    title: 'Saved fixture programme',
    description: null,
    categories: [],
    ordinal,
    startMs: scheduleStart,
    stopMs: scheduleStart + 3 * 60 * 60 * 1000,
  }));
  let preferences = JSON.stringify({
    schemaVersion: 1,
    ...(teamFixture.favoriteTeams ? { favoriteTeams: teamFixture.favoriteTeams } : {}),
    favorites: ['twin-first', 'removed-favorite', ...(sportsFavorites ? ['favorite-sports'] : [])],
    removedChannels: ['removed-favorite'],
    volume: 0.8,
    muted: false,
    panelWidth: 360,
    sources,
    automaticSourceRefresh: false,
    sourceRefreshCadence: 'off',
    automaticGuideUpdates: false,
    reviewedChannelProviders: [],
    reviewedGuideProviders: [],
    channelCategoryOverrides: [{ channelId: 'twin-second', category: 'Sports' }],
  });
  let release: (() => void) | null = null;
  let chooseExport: ((path: string) => void) | null = null;
  let viewRevision = '1';
  const calls: { command: string; args: Record<string, unknown> }[] = [],
    unknown: string[] = [];
  await page.exposeBinding(
    '__guideFavoriteInvoke',
    async (_binding, command: string, args: Record<string, unknown> = {}) => {
      calls.push({ command, args });
      if (listings && command === 'inspect_discovery_page') {
        const url = String(args.url);
        return { pageUrl: url, responseUrl: url, html: listings(url) };
      }
      if (listings && command === 'web_page')
        return { open: args.action !== 'close', url: args.url };
      if (command === 'plugin:dialog|save')
        return new Promise<string>((resolve) => {
          chooseExport = resolve;
        });
      if (command === 'plugin:fs|write_text_file') return;
      if (command === 'plugin:event|listen') return calls.length;
      if (['plugin:event|unlisten', 'cancel_catalog_query', 'cancel_playlist'].includes(command))
        return;
      if (command === 'renderer_recovery_bootstrap')
        return { schemaVersion: 1, recoveredRenderer: false };
      if (command === 'list_archive_downloads')
        return { schemaVersion: 1, revision: '0', entries: [] };
      if (command === 'list_iptv_accounts') return [];
      // The quiet saved-channel check reads its newest results at start-up.
      if (command === 'read_channel_checks')
        return { schemaVersion: 1, nowMs: Date.now(), checks: [] };
      if (command === 'channel_logos') {
        const request = args.request as { channelIds: string[]; expectedRevision: string };
        return {
          schemaVersion: 1,
          catalogRevision: request.expectedRevision,
          attemptedChannelIds: request.channelIds,
          images: [],
        };
      }
      if (command === 'runtime_info') return { platform, dataMode: 'application' };
      if (command === 'plugin:app|version') return '0.1.0';
      if (command === 'app_identity')
        return {
          version: '0.1.32',
          versionCode: 1032,
          platform: 'Android',
          architecture: 'arm',
          build: 'release',
          signers: [],
        };
      if (command === 'playback_trace')
        return {
          schemaVersion: 1,
          version: '0.1.30',
          build: 1030,
          platform: 'android',
          active: false,
          startedAtMs: 1000,
          untilMs: 0,
          droppedEvents: 0,
          records: [],
        };
      if (command === 'device_capabilities')
        return { isTelevision: teamFixture.isTelevision ?? platform === 'android' };
      if (command === 'set_viewing_active')
        return {
          schemaVersion: 1,
          adapterVersion: 'viewing-wake-v1',
          requestedActive: args.active,
          foreground: true,
          platform: 'android',
          windowKeepScreenOn: args.active,
          webViewKeepScreenOn: args.active,
          decorKeepScreenOn: args.active,
        };
      if (command === 'read_record_pair')
        return { catalog, preferences, health: null, catalogRevision: '1', healthRevision: '0' };
      if (command === 'read_record') {
        expect(args.name).toBe('preferences');
        return preferences;
      }
      if (command === 'write_record_receipt' && args.name === 'preferences') {
        const next = JSON.parse(String(args.contents));
        if (Array.isArray(next.favoriteTeams)) {
          if (holdTeamWrite) {
            holdTeamWrite = false;
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            release = null;
          }
          preferences = JSON.stringify(next);
          return { committed: true, catalogRevision: '1', healthRevision: '0' };
        }
      }
      if (command === 'read_guide_capture') return { catalog, preferences, catalogRevision: '1' };
      if (command === 'read_scan_checkpoint_summary')
        return {
          schemaVersion: 1,
          checkpointStatus: 'absent',
          storedVersion: null,
          total: 0,
          checked: 0,
          responded: 0,
          published: 0,
          unfinished: false,
          catalogRevision: '1',
          checkpointRevision: '0',
        };
      if (command === 'guide_refresh_plan') return { nowMs: Date.now(), sources: [] };
      if (command === 'guide_sources') return [guideSource];
      if (command === 'guide_mappings') return mappings;
      if (command === 'guide_listed_channels') {
        const q = args.query as { startMs: number; endMs: number };
        const prefs = JSON.parse(preferences);
        const removed = prefs.removedChannels as string[];
        return {
          startMs: q.startMs,
          endMs: q.endMs,
          rootGeneration: 1,
          catalogRevision: '1',
          databaseRevision: 1,
          viewRevision,
          groupingPolicy: 'exact-ordered-endpoints-policy-v2',
          channels: programs
            .filter(
              (p) =>
                !removed.includes(p.appChannelId) && p.startMs < q.endMs && p.stopMs > q.startMs,
            )
            .map((p) => {
              const saved = channels.find(
                (c) => c.id === p.appChannelId && c.sourceId === p.catalogSourceId,
              )!;
              const category = (
                prefs.channelCategoryOverrides.find(
                  (o: { channelId: string }) => o.channelId === saved.id,
                )?.category ?? saved.category
              )
                .normalize('NFKC')
                .toLowerCase();
              return {
                catalogSourceId: p.catalogSourceId,
                appChannelId: p.appChannelId,
                guideSourceId: p.guideSourceId,
                xmltvChannelId: p.xmltvChannelId,
                sourceRevision: 1,
                filterMask:
                  Number(prefs.favorites.includes(saved.id)) +
                  2 * Number(category.includes('news')) +
                  4 * Number(category.includes('sports')),
              };
            })
            .sort(
              (a, b) =>
                a.catalogSourceId.localeCompare(b.catalogSourceId) ||
                a.appChannelId.localeCompare(b.appChannelId),
            ),
          nextCursor: null,
        };
      }
      if (command === 'guide_programs') {
        const q = args.query as {
          appChannelIds: string[];
          search: string;
          windowStartMs: number;
          windowEndMs: number;
        };
        if (listings && q.search === 'Wisconsin Badgers') {
          expect(q.windowEndMs - q.windowStartMs).toBeLessThanOrEqual(7 * 86_400_000);
          const slot = {
            ...programs[0],
            startMs: Date.parse('2026-11-07T21:15:00Z'),
            stopMs: null,
          };
          return {
            sourceRevision: 0,
            databaseRevision: 1,
            nextCursor: null,
            programs: [
              { ...slot, title: 'College Football', description: 'Wisconsin Badgers highlights' },
              { ...slot, title: 'American Football: Wisconsin Badgers vs. Nebraska' },
            ],
          };
        }
        return {
          sourceRevision: 1,
          databaseRevision: 1,
          nextCursor: null,
          programs: programs.filter(
            (p) =>
              q.appChannelIds.includes(p.appChannelId) &&
              p.startMs < q.windowEndMs &&
              p.stopMs > q.windowStartMs,
          ),
        };
      }
      if (command === 'guide_visible_summaries' || command === 'guide_selected_summary')
        throw 'controlled-summary-unavailable';
      if (command === 'query_catalog_page') {
        const q = args.query as {
          requestId: string;
          startIndex?: number;
          pageSize: number;
          filter: string;
          favoritesOnly?: boolean;
          sports?: unknown;
        };
        const prefs = JSON.parse(preferences);
        const rows = channels
          .filter(
            (c) =>
              !prefs.removedChannels.includes(c.id) &&
              (!(q.filter === 'favorites' || q.favoritesOnly) || prefs.favorites.includes(c.id)),
          )
          .map((c) => ({
            id: c.id,
            sourceId: c.sourceId,
            name: c.name,
            category:
              prefs.channelCategoryOverrides.find(
                (o: { channelId: string }) => o.channelId === c.id,
              )?.category ?? c.category,
            favorite: prefs.favorites.includes(c.id),
          }))
          .filter((row) => q.filter !== 'sports' || row.category === 'Sports');
        return {
          schemaVersion: 1,
          requestId: q.requestId,
          catalogRevision: '1',
          viewRevision,
          ...(q.sports ? { guideRevision: '1' } : {}),
          queryVersion: 'v1-' + 'a'.repeat(64),
          totalCount: rows.length,
          startIndex: q.startIndex ?? 0,
          anchorIndex: null,
          rows: rows.slice(q.startIndex ?? 0, (q.startIndex ?? 0) + q.pageSize),
          after:
            (q.startIndex ?? 0) + q.pageSize < rows.length
              ? {
                  schemaVersion: 1,
                  queryKey: 'a'.repeat(64),
                  catalogRevision: '1',
                  viewRevision,
                  sortKey: '',
                  id: rows[(q.startIndex ?? 0) + q.pageSize - 1]!.id,
                }
              : null,
        };
      }
      if (command === 'mutate_catalog_group') {
        const request = args.request as {
          schemaVersion: number;
          requestId: string;
          channelId: string;
          expectedCatalogRevision: string;
          expectedViewRevision: string;
          action: { kind: string; value: boolean };
        };
        expect(request).toMatchObject({
          schemaVersion: 1,
          channelId: 'twin-second',
          expectedCatalogRevision: '1',
          expectedViewRevision: viewRevision,
          action: { kind: 'favorite', value: true },
        });
        expect(request.requestId).toEqual(expect.any(String));
        const next = JSON.parse(preferences);
        next.favorites = [...next.favorites, request.channelId];
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        preferences = JSON.stringify(next);
        viewRevision = '2';
        release = null;
        return {
          schemaVersion: 1,
          committed: true,
          catalogRevision: '1',
          viewRevision,
          affectedCount: 1,
        };
      }
      if (command === 'append_diagnostic_event')
        return {
          schemaVersion: 1,
          id: String(calls.length),
          timestampMs: Date.now(),
          ...(args.event as object),
        };
      // Stored viewing choices at their defaults (adult hidden, no account buffers).
      if (command === 'read_viewing_settings')
        return { schemaVersion: 1, hideAdult: true, accountBuffers: {} };
      // The header's VPN shield: no VPN on this controlled device.
      if (command === 'vpn_status') return { connected: false };
      // Share links: GenX was not opened with a link.
      if (command === 'take_incoming_link') return null;
      unknown.push(command);
      throw new Error('controlled-command-unavailable');
    },
  );
  await page.addInitScript(() => {
    let id = 0;
    Reflect.set(window, 'isTauri', true);
    Reflect.set(window, '__TAURI_INTERNALS__', {
      invoke: (command: string, args?: unknown) =>
        Reflect.get(window, '__guideFavoriteInvoke')(command, args),
      transformCallback: () => ++id,
      unregisterCallback: () => undefined,
    });
    Reflect.set(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', {
      unregisterListener: () => undefined,
    });
  });
  let acquisitions = 0;
  await page.route(`https://${streamHost}/**`, (route) => {
    acquisitions++;
    return route.abort();
  });
  await page.goto('/');
  await expect(page.locator('#app')).toHaveAttribute('data-ready', 'true');
  return {
    calls,
    unknown,
    acquisitions: () => acquisitions,
    held: () => release !== null,
    ack: () => {
      if (!release) throw new Error('No held write');
      release();
    },
    preferences: () => JSON.parse(preferences),
    pickingExport: () => chooseExport !== null,
    finishExportPicker: () => chooseExport?.('content://fixture/favorites.json'),
  };
}

test('My Teams confirms BTN airtime and opens a local event page outside the lineup on TV', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-11-07T21:30:00Z'));
  const event = {
    '@type': 'SportsEvent',
    name: 'Wisconsin Badgers vs. Central State',
    sport: 'American Football',
    startDate: '2026-11-09T00:30:00Z',
  };
  const f = await fixture(page, undefined, false, (address) => {
    const url = new URL(address);
    const structured = (value: unknown) =>
      `<html><script type="application/ld+json">${JSON.stringify(value)}</script></html>`;
    if (url.hostname === 'school.fixture.invalid')
      return structured([
        event,
        { ...event, name: 'Wisconsin Badgers vs. Canceled Team', eventStatus: 'EventCancelled' },
      ]);
    if (url.hostname === 'station.fixture.invalid')
      return structured([
        {
          ...event,
          url: '/sports/central-state-badgers',
          subjectOf: {
            '@type': 'VideoObject',
            embedUrl: '/embed/central-state-badgers',
            publication: {
              '@type': 'BroadcastEvent',
              isLiveBroadcast: true,
              startDate: event.startDate,
            },
          },
        },
        {
          ...event,
          name: 'Wisconsin Badgers vs. Radio Team',
          url: '/live',
          subjectOf: {
            '@type': 'AudioObject',
            contentUrl: '/audio/radio-team',
          },
        },
      ]);
    if (url.hostname === 'bigten.org') {
      const day = url.searchParams.get('date');
      const slot = (title: string) =>
        `<div class="item"><div class="item-time">4:15 PM</div>
          <span class="item-title">${title}</span><span class="pill-live">Live</span></div>`;
      return `<html><div class="btn-schedule"><input id="btnDate" value="${day}">
        <select id="btnTimeZone"><option value="Eastern Standard Time" selected>ET</option></select>
        ${
          day === '2026-11-07'
            ? slot('B1G Football: Rutgers at Wisconsin') +
              slot('B1G Live: Football Postgame') +
              slot('B1G Football: Rutgers at Washington')
            : ''
        }
        </div></html>`;
    }
    if (url.hostname === 'www.ncaa.com') {
      return `<html><script type="application/ld+json">
        {"url": "${address}", "datePublished": "2026-11-07T13:00:00-05:00"}</script>
        <div class="article-body"><div><p><em>All times Eastern.</em></p><h3>Week 10 schedule, scores</h3>
        <p><strong>Saturday, Nov. 7</strong></p>
        <p><a href="/game/1234">No. 19 Rutgers at Wisconsin | 4:15 p.m. | BTN</a></p>
        <p><a href="/game/5678">Rutgers at Wisconsin State | 4:15 p.m. | BTN</a></p>
        </div></div></html>`;
    }
    throw new Error('Unexpected listing request');
  });
  await page.getByRole('button', { name: 'Open settings' }).click();
  await chooseSettingsSection(page, 'favorite-teams');
  await page.getByRole('button', { name: 'Add team manually' }).click();
  await page.getByLabel('Team, school or club name').fill('Wisconsin Badgers');
  await page.getByRole('textbox', { name: 'Sport', exact: true }).fill('American Football');
  await page.getByLabel('City or region').fill('Madison, WI');
  await page.getByLabel('League or conference').fill('Big Ten');
  await page
    .getByLabel('Official schedule URL (optional)')
    .fill('https://school.fixture.invalid/games');
  await page
    .getByLabel('Official station or broadcaster listings URL (optional)')
    .fill('https://station.fixture.invalid/sports');
  await page.getByRole('button', { name: 'Save team' }).click();
  await expect(page.getByRole('list', { name: 'Followed teams' })).toContainText(
    'Wisconsin Badgers',
  );
  await page.getByRole('button', { name: 'View My Teams' }).click();
  const dialog = page.getByRole('dialog', { name: 'My Teams', exact: true });
  const find = dialog.getByRole('button', { name: /^Find games for Wisconsin Badgers/ });
  await find.focus();
  await page.keyboard.press('Enter');
  const games = dialog.getByRole('list', { name: 'Games found' });
  await expect(games.getByRole('listitem')).toHaveCount(4);
  await expect(
    games.getByRole('listitem').filter({ hasText: 'Rutgers at Wisconsin' }),
  ).toContainText('Big Ten Network · TV listing');
  await expect(
    games.getByRole('listitem').filter({ hasText: 'Rutgers at Wisconsin' }),
  ).toContainText('NCAA.com · BTN (TV listing)');
  await expect(games.getByText('school.fixture.invalid')).toBeVisible();
  await expect(
    games.getByRole('listitem').filter({ hasText: 'Wisconsin Badgers vs. Nebraska' }),
  ).toContainText('Saved Guide');
  await expect(games.getByText('College Football', { exact: true })).toHaveCount(0);
  await expect(find).toBeFocused();
  const watch = games.getByRole('button', { name: /Open .* in Web Viewer/ });
  await expect(watch).toHaveCount(1);
  expect(
    f.calls.some(
      ({ command, args }) =>
        command === 'inspect_discovery_page' && String(args.url).includes('duckduckgo.com'),
    ),
  ).toBe(false);
  await watch.focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toBeHidden();
  await expect
    .poll(
      () =>
        f.calls.find((call) => call.command === 'web_page' && call.args.action === 'open')?.args
          .url,
    )
    .toBe('https://station.fixture.invalid/sports/central-state-badgers');
});

test('My Teams searches automatically and verifies the exact broadcaster event page on TV', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-11-07T19:00:00Z'));
  const schedule = 'https://athletics.westfield.edu/volleyball/schedule';
  const station = 'https://www.25newsnow.com/sports/local-games';
  const eventPage = 'https://www.25newsnow.com/sports/watch-tigers-eagles';
  const wrongPage = 'https://www.25newsnow.com/sports/watch-tigers-owls';
  const event = {
    '@type': 'SportsEvent',
    name: 'Westfield Tigers vs. Central Eagles',
    sport: 'Girls Volleyball',
    startDate: '2026-11-08T01:30:00Z',
  };
  const video = (url: string, matchup = event) => ({
    ...matchup,
    url,
    subjectOf: {
      '@type': 'VideoObject',
      embedUrl: '/embed/game',
      publication: {
        '@type': 'BroadcastEvent',
        isLiveBroadcast: true,
        startDate: matchup.startDate,
      },
    },
  });
  const wrongGame = { ...event, name: 'Westfield Tigers vs. Ridgeview Owls' };
  const f = await fixture(page, undefined, false, (address) => {
    const structured = (value: unknown) =>
      `<html><script type="application/ld+json">${JSON.stringify(value)}</script></html>`;
    if (address === schedule) return structured(event);
    if (address === station)
      return structured([
        video(eventPage),
        video(wrongPage, wrongGame),
        video('https://offsite.fixture.invalid/player', {
          ...event,
          name: 'Westfield Tigers Volleyball',
        }),
      ]);
    if (address === eventPage)
      return structured(video(eventPage, { ...event, name: 'Central Eagles at Westfield Tigers' }));
    if (address === wrongPage)
      return structured(video(wrongPage, { ...wrongGame, startDate: '2026-11-08T02:00:00Z' }));
    const url = new URL(address);
    if (url.origin === 'https://lite.duckduckgo.com') {
      const query = url.searchParams.get('q');
      expect(query).toContain('westfield tigers girls volleyball springfield il');
      const link = (target: string) =>
        `<a class="result-link" href="//duckduckgo.com/l/?uddg=${encodeURIComponent(target)}">Unverified snippet</a>`;
      return `<html>${link(query?.includes('schedule') ? schedule : station)}
        ${link('https://www.25newsnow.com.evil.example/sports/fake')}
        ${link('https://127.0.0.1/private')}</html>`;
    }
    throw new Error('Unexpected listing request');
  });
  await page.getByRole('button', { name: 'Open settings' }).click();
  await chooseSettingsSection(page, 'favorite-teams');
  await page.getByRole('button', { name: 'Add team manually' }).click();
  await page.getByLabel('Team, school or club name').fill('Westfield Tigers');
  await page.getByRole('textbox', { name: 'Sport', exact: true }).fill('Girls Volleyball');
  await page.getByLabel('City or region').fill('Springfield, IL');
  await page.getByRole('button', { name: 'Save team' }).click();
  await expect(page.getByRole('list', { name: 'Followed teams' })).toContainText(
    'Westfield Tigers',
  );
  await page.getByRole('button', { name: 'View My Teams' }).click();
  const dialog = page.getByRole('dialog', { name: 'My Teams', exact: true });
  await dialog.getByRole('button', { name: /^Find games for Westfield Tigers/ }).press('Enter');
  const games = dialog.getByRole('list', { name: 'Games found' });
  await expect(games.getByRole('listitem')).toHaveCount(2);
  const watch = games.getByRole('button', { name: /Open .* in Web Viewer/ });
  await expect(watch).toHaveCount(1);
  await expect(games.getByRole('listitem').filter({ hasText: 'Central Eagles' })).toContainText(
    'athletics.westfield.edu',
  );
  const requests = f.calls
    .filter(({ command }) => command === 'inspect_discovery_page')
    .map(({ args }) => String(args.url));
  expect(requests.filter((url) => url.startsWith('https://lite.duckduckgo.com/'))).toHaveLength(2);
  expect(requests).toEqual(expect.arrayContaining([schedule, station, eventPage, wrongPage]));
  expect(requests).toHaveLength(6);
  await watch.press('Enter');
  await expect
    .poll(
      () =>
        f.calls.find(({ command, args }) => command === 'web_page' && args.action === 'open')?.args
          .url,
    )
    .toBe(eventPage);
});

for (const platform of ['android', 'windows'] as const) {
  test(`${platform} channel search opens the exact verified game and leaves schedule-only results as listings`, async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-11-08T02:00:00Z'));
    const schedule = 'https://www.25newsnow.com/sports/game-list';
    const exact = 'https://www.25newsnow.com/sports/player/tigers-eagles';
    const different = 'https://www.25newsnow.com/sports/player/tigers-eagles-next';
    const title = 'Westfield Tigers vs. Central Eagles';
    const first = '2026-11-08T01:30:00Z';
    const second = '2026-11-09T01:30:00Z';
    const event = (url: string, startDate: string, name = title) => ({
      '@type': 'SportsEvent',
      name,
      sport: 'American Football',
      url,
      startDate,
      subjectOf: {
        '@type': 'VideoObject',
        embedUrl: '/embed/game',
        publication: {
          '@type': 'BroadcastEvent',
          isLiveBroadcast: true,
          startDate,
          endDate: new Date(Date.parse(startDate) + 3 * 60 * 60_000).toISOString(),
        },
      },
    });
    const f = await fixture(
      page,
      undefined,
      false,
      (address) => {
        const structured = (value: unknown) =>
          `<script type="application/ld+json">${JSON.stringify(value)}</script>`;
        if (address === schedule)
          return structured([
            event(different, second),
            event(exact, first),
            { ...event(schedule, '2026-11-08T03:00:00Z'), sport: 'Basketball' },
          ]);
        if (address === exact)
          return structured(event(exact, first, 'Central Eagles at Westfield Tigers'));
        if (address === different) return structured(event(different, first));
        const url = new URL(address);
        if (url.origin === 'https://www.ncaa.com') return '<html></html>';
        if (url.origin === 'https://lite.duckduckgo.com') {
          expect(url.searchParams.get('q')).toContain('westfield tigers vs central eagles');
          return `<a class="result-link" href="${schedule}">Schedule</a>
        <a class="result-link" href="https://www.25newsnow.com.attacker.example/fake">Fake</a>`;
        }
        throw new Error('Unexpected listing request');
      },
      platform,
    );
    await page.locator('#category-button').press('Enter');
    await page.locator('.filters button[data-filter="sports"]').press('Enter');
    await page
      .locator('#sports-filters select')
      .first()
      .evaluate((element) => {
        const select = element as HTMLSelectElement;
        select.value = 'american-football';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      });
    const search = page.getByRole('searchbox', { name: 'Search channels and programs' });
    await search.fill(title);
    expect(f.calls.filter(({ command }) => command === 'inspect_discovery_page')).toHaveLength(0);
    if (platform === 'android') await search.press('Enter');
    else await page.getByRole('button', { name: 'Find channels online' }).click();
    const panel = page.getByRole('region', { name: 'Game search results' });
    await expect(panel.getByRole('button', { name: /^View listing/ })).toHaveCount(1);
    const watch = panel.getByRole('button', { name: /^Watch/ });
    await expect(watch).toHaveCount(1);
    await expect(panel.getByRole('listitem').first()).toContainText('Scheduled to air now');
    await watch.press('Enter');
    await expect
      .poll(
        () =>
          f.calls.find(({ command, args }) => command === 'web_page' && args.action === 'open')
            ?.args.url,
      )
      .toBe(exact);
    expect(f.calls.some(({ args }) => String(args.url).includes('attacker.example'))).toBe(false);
  });
}

test('Free TV verifies the live AWIHL matchup and opens its exact YouTube video', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-11-08T04:00:00Z'));
  const watchUrl = 'https://www.youtube.com/watch?v=0jWEV8BhwH8';
  let gameStatus = 'FINAL';
  let author = 'https://www.youtube.com/@unverified';
  let lookups = 0;
  await page.route('https://www.youtube.com/oembed?**', async (route) => {
    lookups++;
    expect(new URL(route.request().url()).searchParams.get('url')).toBe(watchUrl);
    await route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: {
        author_url: author,
        title: 'Week 1 | Perth Inferno v Sydney Sirens Game 2 | AWIHL 2026/27 Season',
      },
    });
  });
  const fixtureApp = await fixture(page, undefined, false, (address) => {
    const url = new URL(address);
    if (url.hostname === 'stats.iha.org.au')
      return `<div class="scoreboard-box"><div class="row"><div class="col">
        <div class="row"><div class="col">SUN 8 NOV. at 10:30AM</div></div>
        <div class="row font-weight-bold"><div class="col"><span>SYDNEY SIRENS</span></div></div>
        <div class="row font-weight-bold"><div class="col"><span>PERTH INFERNO</span></div></div>
        <a class="scoreboardLink" href="hockey_boxscores.cfm?clientid=6104&leagueid=25754&gameid=2595403">${gameStatus}</a>
      </div></div></div>`;
    if (url.hostname === 'thesportscommons.com')
      return `<article><h3 class="card-title">Week 1 | Perth Inferno v Sydney Sirens Game 2 | AWIHL 2026/27 Season</h3>
        <time class="live-since" data-start="2026-11-08T02:16:01+00:00"></time>
        <a class="btn-watch" href="${watchUrl}&utm_source=example">Watch</a></article>`;
    return '<html></html>';
  });
  const search = page.getByRole('searchbox', { name: 'Search channels and programs' });
  const panel = page.getByRole('region', { name: 'Game search results' });
  const watch = panel.getByRole('button', { name: /^Watch on YouTube/ });
  await search.fill('Perth Inferno vs Sydney Sirens');
  await search.press('Enter');
  await expect(
    panel.getByText('No matching game was found in the listings checked.'),
  ).toBeVisible();
  expect(lookups).toBe(0);
  gameStatus = 'IN PROGRESS';
  await search.press('Enter');
  await expect.poll(() => lookups).toBe(1);
  await expect(panel.getByRole('button', { name: /^View listing/ })).toBeVisible();
  await expect(watch).toHaveCount(0);
  author = 'https://www.youtube.com/@AWIHLTV';
  await search.press('Enter');
  await expect(watch).toBeVisible();
  await watch.press('Enter');
  await expect
    .poll(
      () =>
        fixtureApp.calls.find(
          ({ command, args }) => command === 'web_page' && args.action === 'open',
        )?.args.url,
    )
    .toBe(watchUrl);
});

test('bundled Guide uses saved category and exact favorite identity only after preference ACK', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const f = await fixture(page);
  const title = await page.locator('#watch-title').textContent();
  await page.locator('#guide-button').click();
  const guide = page.getByRole('dialog', { name: 'Program guide', exact: true });
  const filters = guide.getByRole('group', { name: 'Guide channel categories', exact: true });
  const identities = () =>
    guide
      .locator('.gx-timeline-row')
      .evaluateAll((rows) =>
        rows.map((row) => JSON.parse((row as HTMLElement).dataset.channelKey!)[0]),
      );
  await filters.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect.poll(identities).toEqual(['twin-first']);
  await expect(guide.getByText('Removed favorite', { exact: true })).toHaveCount(0);
  await filters.getByRole('button', { name: 'Sports', exact: true }).click();
  await expect.poll(identities).toEqual(['twin-second']);
  await expect(guide.locator('.gx-timeline-channel .media-result-title')).toHaveText([
    'Shared name',
  ]);
  await guide.getByRole('button', { name: 'Close guide', exact: true }).click();
  const second = page
    .locator('.channel-row')
    .filter({ has: page.locator('[data-channel="twin-second"]') });
  // Exact saved ID scopes the action despite duplicate display names.
  const star = second.getByRole('button', { name: 'Favorite Shared name', exact: true });
  await star.focus();
  await page.keyboard.press('Enter');
  await expect(star).toHaveAttribute('aria-busy', 'true');
  await expect(star).toHaveText('★');
  await expect(star).toBeFocused();
  await expect.poll(f.held).toBe(true);
  await page.keyboard.press('Enter');
  await expect(star).toHaveAttribute('aria-pressed', 'false');
  await page.keyboard.press('Enter');
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(star).toBeFocused();
  expect(f.calls.filter((c) => c.command === 'mutate_catalog_group')).toHaveLength(1);
  expect(f.calls.some((c) => c.command === 'write_record_receipt')).toBe(false);
  expect(f.preferences().favorites).toEqual(['twin-first', 'removed-favorite']);
  await page.locator('#guide-button').click();
  await filters.getByRole('button', { name: 'Favorites', exact: true }).click();
  await expect.poll(identities).toEqual(['twin-first']);
  f.ack();
  await expect.poll(() => f.preferences().favorites).toContain('twin-second');
  await expect.poll(identities).toEqual(['twin-first', 'twin-second']);
  await expect(guide.locator('.gx-timeline-channel .media-result-title')).toHaveText([
    'Shared name',
    'Shared name',
  ]);
  await guide.getByRole('button', { name: 'Close guide', exact: true }).click();
  await expect(star).toHaveAttribute('aria-pressed', 'true');
  await expect(star).not.toHaveAttribute('aria-busy', 'true');
  expect(f.calls.filter((c) => c.command === 'mutate_catalog_group')).toHaveLength(1);
  expect(await page.locator('#watch-title').textContent()).toBe(title);
  await expect(page.locator('#video')).toHaveJSProperty('paused', true);
  expect(
    f.calls.filter((c) =>
      /^(inspect_|guide_preview|guide_commit|guide_save_source)/.test(c.command),
    ),
  ).toEqual([]);
  expect(f.acquisitions()).toBe(0);
  expect(f.unknown).toEqual([]);
});

for (const platform of ['android', 'windows'] as const) {
  test(`the ${platform} Guide keeps the browser Favorites scope across categories`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await fixture(page, undefined, true, undefined, platform);
    const guideButton = page.getByRole('button', { name: 'Free TV guide' });
    const favorites = page.getByRole('button', { name: 'Favorites', exact: true });
    const guide = page.getByRole('dialog', { name: 'Program guide', exact: true });
    const categories = guide.getByRole('group', { name: 'Guide channel categories', exact: true });
    const identities = () =>
      guide
        .locator('.gx-timeline-row')
        .evaluateAll((rows) =>
          rows.map((row) => JSON.parse((row as HTMLElement).dataset.channelKey!)[0]).sort(),
        );

    await favorites.click();
    await page.locator('#category-button').click();
    await page.locator('.filters button[data-filter="sports"]').click();
    await guideButton.click();
    await expect(categories.getByRole('button', { name: 'Sports', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect.poll(identities).toEqual(['favorite-sports']);
    await categories.getByRole('button', { name: 'All channels', exact: true }).click();
    await expect.poll(identities).toEqual(['favorite-sports', 'twin-first']);
    await guide.getByRole('button', { name: 'Close guide', exact: true }).click();

    await favorites.click();
    await guideButton.click();
    await expect.poll(identities).toEqual(['favorite-sports', 'twin-second']);
  });
}

test('Android favorites export survives the save picker temporarily backgrounding the app', async ({
  page,
}) => {
  const f = await fixture(page, 'stream.fixture.example.com');
  await page.locator('#settings-button').click();
  await page.locator('#send-app-button').click();
  const panel = page.locator('.send-app-favorites');
  await panel.getByRole('button', { name: 'Export favorites' }).click();
  await expect.poll(f.pickingExport).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('native-app-background')));
  f.finishExportPicker();
  await expect(panel.getByRole('status')).toContainText('Exported 1 favorite.');
  expect(f.calls.filter(({ command }) => command === 'plugin:fs|write_text_file')).toHaveLength(1);
  expect(f.acquisitions()).toBe(0);
});

test('TV remote sorting keeps the saved Favorites query scoped to starred channels', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const f = await fixture(page);
  const favorites = page.getByRole('button', { name: 'Favorites', exact: true });
  await favorites.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await expect(page.locator('#category-button')).toHaveAccessibleName(
    'Channel category: Favorites, 1 channel',
  );
  const location = page.getByRole('button', { name: 'Location and sort', exact: true });
  await location.focus();
  await page.keyboard.press('Enter');
  const sort = page.getByRole('button', { name: 'Channel sort', exact: true });
  await expect(sort).toBeFocused();
  await expect(page.locator('#geography-controls label').filter({ has: sort })).toContainText(
    'Sort favorites',
  );
  await page.keyboard.press('Enter');
  const options = page.getByRole('listbox', { name: 'Channel sort choices' });
  await expect(options.getByRole('option', { name: 'Source order' })).toBeFocused();
  const previous = f.calls.length;
  const recentQueries = () =>
    f.calls.slice(previous).filter((call) => call.command === 'query_catalog_page');
  for (const [name, order] of [
    ['Country, region, state', 'geography'],
    ['Channel name', 'name'],
  ]) {
    await page.keyboard.press('ArrowDown');
    await expect(options.getByRole('option', { name, exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect
      .poll(() => recentQueries().map((call) => call.args.query))
      .toContainEqual(expect.objectContaining({ filter: 'favorites', sort: order }));
    await expect(sort).toBeFocused();
    if (order === 'geography') await page.keyboard.press('Enter');
  }
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(favorites).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#channel-count')).toHaveText('1 channel');
  await expect(page.locator('#channel-list [data-channel]')).toHaveAttribute(
    'data-channel',
    'twin-first',
  );
  expect(
    recentQueries().every((call) => (call.args.query as { filter: string }).filter === 'favorites'),
  ).toBe(true);
});

test('TV Sports and Favorites can be applied in either order', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 720 });
  const f = await fixture(page, undefined, true);
  const favorites = page.getByRole('button', { name: 'Favorites', exact: true });
  const category = page.locator('#category-button');
  const rows = page.locator('#channel-list [data-channel]');
  const choose = async (filter: 'all' | 'sports') => {
    await category.click();
    await page.locator(`.filters button[data-filter="${filter}"]`).click();
  };
  const expectFavoriteSports = async () => {
    await expect(favorites).toHaveAttribute('aria-pressed', 'true');
    await expect(category).toHaveAccessibleName('Channel category: Sports, 1 channel');
    await expect(rows).toHaveAttribute('data-channel', 'favorite-sports');
  };

  await favorites.click();
  await expect(rows).toHaveCount(2);
  await choose('sports');
  await expectFavoriteSports();
  await favorites.click();
  await expect(rows).toHaveCount(2);
  await choose('all');
  await expect(rows).toHaveCount(3);
  await choose('sports');
  await expect(rows).toHaveCount(2);
  await favorites.click();
  await expectFavoriteSports();
  expect(f.calls.map((call) => call.args.query)).toContainEqual(
    expect.objectContaining({ filter: 'sports', favoritesOnly: true }),
  );
});

test('Windows compact category changes and Clear filters leave Favorites on until toggled off', async ({
  page,
}) => {
  await page.setViewportSize({ width: 580, height: 730 });
  const f = await fixture(page, undefined, true, undefined, 'windows');
  const opener = page.locator('#phone-filter-button');
  const dialog = page.locator('#phone-filter-dialog');
  const favorites = dialog.getByRole('button', { name: 'Favorites', exact: true });
  const category = dialog.getByRole('combobox', { name: 'Channel category' });
  const rows = page.locator('#channel-list [data-channel]');
  await opener.click();
  await favorites.click();
  await category.selectOption('sports');
  await expect(favorites).toHaveAttribute('aria-pressed', 'true');
  await dialog.getByRole('button', { name: 'Show channels' }).click();
  await expect(rows).toHaveAttribute('data-channel', 'favorite-sports');
  await page.getByRole('button', { name: 'Clear filters', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await opener.click();
  await expect(favorites).toHaveAttribute('aria-pressed', 'true');
  await favorites.click();
  await category.selectOption('sports');
  await expect(favorites).toHaveAttribute('aria-pressed', 'false');
  await dialog.getByRole('button', { name: 'Show channels' }).click();
  await expect(rows).toHaveCount(2);
  expect(f.calls.map((call) => call.args.query)).toContainEqual(
    expect.objectContaining({ filter: 'sports', favoritesOnly: true }),
  );
});

test('Windows finds every Mid-Illini school and fills in an IHSA school from another conference', async ({
  page,
}) => {
  const directory = 'https://www.ihsa.org/data/school/conf.htm';
  const f = await fixture(
    page,
    undefined,
    false,
    (url) => {
      expect(url).toBe(directory);
      return `<h2>Central State Eight</h2>
      <p>Contact: <a href="/data/school/schools/0123.htm">Wrong School</a></p>
      <p><b>Member Schools</b></p>
      <p><a href="/data/school/schools/0456.htm">Chatham (Glenwood)</a>
         <a href="/data/school/schools/0457.htm">Rochester</a></p>
      <p><a href="https://fixture.invalid/data/school/schools/0789.htm">Fake School</a></p>
      <h2>Other Conference</h2><p><b>Member Schools</b></p>
      <p><a href="/data/school/schools/0456.htm">Chatham (Glenwood)</a></p>`;
    },
    'windows',
  );
  await page.getByRole('button', { name: 'Open settings' }).click();
  await chooseSettingsSection(page, 'favorite-teams');
  const search = page.getByLabel('Search teams');
  const results = page.getByRole('list', { name: 'Team search results' });
  for (const query of ['Mid-Illini', 'Mid-Illini football']) {
    await search.fill(query);
    for (const team of [
      'Canton Little Giants',
      'Dunlap Eagles',
      'East Peoria Raiders',
      'Limestone Rockets',
      'Metamora Redbirds',
      'Morton Potters',
      'Pekin Dragons',
      'Washington Panthers',
    ])
      await expect(results).toContainText(team);
  }
  await search.fill('Glenwood girls basketball');
  await expect(results.getByRole('listitem')).toHaveCount(1);
  await expect(results).toContainText(
    'Girls Basketball · Chatham, IL · High school · Central State Eight',
  );
  await results.getByRole('button', { name: /^Follow Chatham/ }).click();
  await expect
    .poll(() => f.preferences().favoriteTeams)
    .toEqual([
      {
        id: 'high-school-ihsa-0456-girls-basketball',
        name: 'Chatham (Glenwood)',
        sport: 'Girls Basketball',
        location: 'Chatham, IL',
        level: 'High school',
        league: 'Central State Eight',
      },
    ]);
  await search.fill('Central State Eight girls basketball');
  await expect(results.getByRole('listitem')).toHaveCount(2);
  await expect(results).toContainText('Rochester');
  await expect(results).toContainText('Chatham (Glenwood)');
  await search.fill('Fake School');
  await expect(page.getByText('No Illinois school matches.')).toBeVisible();
  await expect(results.getByRole('listitem')).toHaveCount(0);
  expect(f.calls.filter(({ command }) => command === 'inspect_discovery_page')).toHaveLength(1);
});

test('Android TV follows a directory team and adds a custom team using remote activation', async ({
  page,
}) => {
  await page.setViewportSize({ width: 960, height: 540 });
  const f = await fixture(page);
  const press = async (target: ReturnType<Page['locator']>) => {
    await target.focus();
    await page.keyboard.press('Enter');
  };
  await press(page.getByRole('button', { name: 'Open settings' }));
  await press(page.getByRole('button', { name: 'Settings section' }));
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await expect(page.locator('[data-settings-section="favorite-teams"]')).toBeFocused();
  await page.keyboard.press('Enter');
  const search = page.getByLabel('Search teams');
  await press(search);
  await page.keyboard.insertText('pekin football');
  await press(page.getByRole('button', { name: /^Follow Pekin Dragons/ }));
  await expect.poll(() => f.preferences().favoriteTeams?.length).toBe(1);
  await press(page.getByRole('button', { name: 'Add team manually' }));
  const name = page.getByLabel('Team, school or club name');
  await expect(name).toBeFocused();
  await name.fill('Central Eagles');
  await page.getByRole('textbox', { name: 'Sport', exact: true }).fill('Girls Volleyball');
  await page.getByLabel('City or region').fill('Springfield, IL');
  await page.getByLabel('Competition level').fill('High school');
  await press(page.getByRole('button', { name: 'Save team', exact: true }));
  await expect.poll(() => f.preferences().favoriteTeams?.length).toBe(2);
  await press(page.getByRole('button', { name: 'View My Teams' }));
  const view = page.getByRole('dialog', { name: 'My Teams', exact: true });
  await expect(view.locator('strong')).toHaveText(['Pekin Dragons', 'Central Eagles']);
  await page.keyboard.press('Escape');
  await expect(view).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'View My Teams' })).toBeFocused();
  expect(f.preferences().favorites).toEqual(['twin-first', 'removed-favorite']);
});

test('Settings finds all games and the Sports shortcut finds channels and playoffs inline', async ({
  page,
}) => {
  await page.clock.setFixedTime(new Date('2026-11-07T19:00:00Z'));
  const morton = 'Morton High School - Morton';
  const title = `Glenwood High School vs ${morton} Girls Varsity Volleyball`;
  const startDate = '2026-11-08T01:30:00Z';
  const route = '/events/morton-high-school-morton-morton-il/gam19679822e9';
  const eventUrl = 'https://www.nfhsnetwork.com' + route;
  const game = {
    '@type': 'SportsEvent',
    name: title,
    startDate,
    sport: 'Volleyball',
    homeTeam: { name: morton },
    awayTeam: { name: 'Glenwood High School' },
  };
  const f = await fixture(
    page,
    undefined,
    false,
    (address) => {
      const url = new URL(address);
      if (address === eventUrl)
        return `<html><script type="application/ld+json" data-hid="ld-event-detail">${JSON.stringify(
          {
            '@graph': [
              game,
              {
                '@type': 'BroadcastEvent',
                startDate,
                broadcastOfEvent: game,
                potentialAction: { '@type': 'WatchAction', target: { url: eventUrl } },
              },
              { '@type': 'VideoObject', name: title, contentUrl: eventUrl },
            ],
          },
        )}</script></html>`;
      if (url.pathname === '/tournaments/ihsa/girls/volleyball')
        return `<html><article><a href="${route}">${morton} vs Glenwood</a>
        <a href="/events/wrong-town/gam42">Morton Grove Academy vs Glenwood</a></article></html>`;
      if (
        url.pathname.startsWith('/schools/') ||
        url.pathname.startsWith('/tournaments/') ||
        url.hostname === 'lite.duckduckgo.com'
      )
        return '<html></html>';
      throw new Error('Unexpected listing request');
    },
    'android',
    {
      holdFirstSave: true,
      channels: [
        {
          id: 'morton-volleyball',
          sourceId: 'first',
          name: 'Morton Potters Volleyball',
          category: 'Sports',
          urls: ['https://stream.fixture.invalid/morton-volleyball'],
        },
      ],
    },
  );
  await page.getByRole('button', { name: 'Open settings' }).click();
  await chooseSettingsSection(page, 'favorite-teams');
  const search = page.getByLabel('Search teams');
  for (const [query, expected] of [
    ['Illinois', 'Illinois Fighting Illini'],
    ['ISU', 'Illinois State Redbirds'],
    ['Illinois State University', 'Illinois State Redbirds'],
    ['Dunlap Eagles', 'Dunlap Eagles'],
  ]) {
    await search.fill(query);
    await expect(page.getByRole('list', { name: 'Team search results' })).toContainText(expected!);
  }
  await search.fill('Morton Potters girls volleyball');
  const followMorton = page.getByRole('button', { name: /^Follow Morton Potters/ });
  await followMorton.press('Enter');
  await expect(
    page.locator('[data-follow-team="high-school-morton-potters-girls-volleyball"]'),
  ).toHaveAttribute('aria-busy', 'true');
  await expect.poll(f.held).toBe(true);
  await search.fill('Pekin boys basketball');
  await page.getByRole('button', { name: /^Follow Pekin Dragons/ }).press('Enter');
  await expect(
    page.locator('[data-follow-team="high-school-pekin-dragons-boys-basketball"]'),
  ).toHaveAttribute('aria-busy', 'true');
  f.ack();
  await expect(
    page.getByRole('list', { name: 'Followed teams' }).getByRole('listitem'),
  ).toHaveCount(2);
  await page.getByRole('button', { name: 'View My Teams' }).click();
  const dialog = page.getByRole('dialog', { name: 'My Teams', exact: true });
  const heading = await dialog.getByRole('heading', { name: 'My Teams' }).boundingBox();
  const allButton = await dialog.getByRole('button', { name: 'Find all games' }).boundingBox();
  const close = await dialog.getByRole('button', { name: 'Close My Teams' }).boundingBox();
  expect(allButton!.x - heading!.x - heading!.width).toBeGreaterThanOrEqual(10);
  expect(close!.x - allButton!.x - allButton!.width).toBeGreaterThanOrEqual(10);
  await dialog
    .locator('.dialog-head')
    .getByRole('button', { name: 'Find all games' })
    .press('Enter');
  const games = dialog.getByRole('list', { name: 'Games found' });
  await expect(games.getByRole('listitem')).toHaveCount(1);
  await expect(games.getByText('NFHS Network')).toBeVisible();
  const requests = f.calls
    .filter(({ command }) => command === 'inspect_discovery_page')
    .map(({ args }) => String(args.url));
  expect(requests.some((url) => url.includes('/tournaments/ihsa/boys/basketball'))).toBe(true);
  expect(requests.some((url) => url.includes('wrong-town'))).toBe(false);
  await dialog.getByRole('button', { name: 'Close My Teams' }).click();
  await page.getByRole('button', { name: 'Close settings', exact: true }).click();
  await page.locator('#category-button').click();
  await page.locator('.filters button[data-filter="sports"]').click();
  const shortcut = page.getByRole('button', { name: 'My Teams', exact: true });
  await shortcut.press('Enter');
  await expect(dialog).toBeHidden();
  const inline = page.getByRole('region', { name: 'My Teams results', exact: true });
  await expect(
    inline.getByRole('button', { name: 'Tune Morton Potters Volleyball' }),
  ).toBeVisible();
  await expect(inline.getByRole('list', { name: 'Matching Free TV channels' })).toBeVisible();
  expect(
    f.calls.some(
      ({ command }) =>
        command === 'query_iptv_account_channels' || command.startsWith('read_iptv_account_guide_'),
    ),
  ).toBe(false);
  await expect(page.locator('#channel-list')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(inline).toBeHidden();
  await expect(shortcut).toBeFocused();
  await shortcut.press('Enter');
  await inline.getByRole('button', { name: /Open .* in Web Viewer/ }).press('Enter');
  await expect
    .poll(
      () =>
        f.calls.find(({ command, args }) => command === 'web_page' && args.action === 'open')?.args
          .url,
    )
    .toBe(eventUrl);
});

for (const viewport of [
  { width: 390, height: 844 },
  { width: 860, height: 480 },
]) {
  test(`My Teams fits a ${viewport.width} × ${viewport.height} screen and returns to channels`, async ({
    page,
  }) => {
    await page.setViewportSize(viewport);
    await fixture(page, undefined, false, () => '<html></html>', 'android', {
      isTelevision: false,
      favoriteTeams: [
        {
          id: 'high-school-pekin-dragons-boys-basketball',
          name: 'Pekin Dragons',
          sport: 'Boys Basketball',
          location: 'Pekin, IL',
          level: 'High school',
        },
      ],
      channels: [
        {
          id: 'pekin-basketball',
          sourceId: 'first',
          name: 'Pekin Dragons Basketball',
          category: 'Sports',
          urls: ['https://stream.fixture.invalid/pekin-basketball'],
        },
      ],
    });
    await page.locator('#phone-filter-button').click();
    const filters = page.locator('#phone-filter-dialog');
    await filters.getByRole('combobox', { name: 'Channel category' }).selectOption('sports');
    const sports = filters.getByRole('combobox', { name: 'Sport', exact: true });
    await sports.selectOption('basketball');
    const shortcut = filters.getByRole('button', { name: 'My Teams', exact: true });
    const button = await shortcut.boundingBox();
    const sport = await sports.boundingBox();
    expect(button!.height).toBeGreaterThanOrEqual(44);
    expect(button!.x + button!.width).toBeLessThanOrEqual(viewport.width);
    const horizontalGap = button!.x - sport!.x - sport!.width;
    const verticalGap = button!.y - sport!.y - sport!.height;
    expect(Math.max(horizontalGap, verticalGap)).toBeGreaterThanOrEqual(8);
    await shortcut.click();
    await expect(filters).toBeHidden();
    const results = page.getByRole('region', { name: 'My Teams results' });
    await expect(
      results.getByRole('button', { name: 'Tune Pekin Dragons Basketball' }),
    ).toBeVisible();
    await expect
      .poll(() => results.evaluate((node) => node.scrollWidth <= node.clientWidth))
      .toBe(true);
    await results.getByRole('button', { name: 'Back to channels' }).click();
    await expect(results).toBeHidden();
    await expect(page.locator('#channel-list')).toBeVisible();
  });
}

test('Advanced shows playlist hosts and distinguishes an older capture from the installed build', async ({
  page,
}) => {
  await fixture(page);
  await page.getByRole('button', { name: 'Open settings' }).click();
  await chooseSettingsSection(page, 'advanced');
  await expect(page.locator('#source-list')).toContainText('first.fixture.invalid');
  await expect(page.locator('#source-list')).toContainText('second.fixture.invalid');
  await expect(page.locator('#source-list')).not.toContainText('https://');
  await page.getByRole('button', { name: 'Playback diagnostics', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Playback diagnostics' });
  await expect(dialog.getByText('Installed version 0.1.32 · build 1032')).toBeVisible();
  await expect(dialog.getByLabel('Capture summary')).toContainText(
    'Capture version 0.1.30 · build 1030',
  );
});
