// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { invoke, isTauri } from '@tauri-apps/api/core';
import { validatePage, validatePageUrl } from '../../discovery/page-input';
import type { DiscoveryPage } from '../../discovery/candidates';
import { nativeGuide } from '../../guide/native';
import { queryCatalogPage, type CatalogRow } from '../../platform/catalog-query';
import type { FavoriteTeam } from '../../preferences/favorite-teams';
import {
  captureSportsScope,
  programmeSportsFacts,
  sportsFacts,
  sports,
  type SportsFacet,
} from '../../search/sports';
import {
  btnListingUrls,
  collegeFootballSchedule,
  gamePageUrl,
  matchesTeamSport,
  matchesTeamTitle,
  nfhsPlayoffPages,
  nfhsTournamentUrls,
  parseTeamGameListings,
  type TeamGameListing,
} from '../../search/team-game-listings';
import {
  favoriteSchool,
  findIllinoisTeams,
  ILLINOIS_CONFERENCE_DIRECTORY,
  readIllinoisSchools,
  teamSearchKey,
} from '../../search/team-directory';
import {
  matchupKey,
  searchPublisherLinks,
  teamSearchUrls,
  type GameSearchTarget,
} from '../../search/team-web-search';
import { findAwihlYoutubeGame } from '../../search/youtube-games';
import { nflGameDate, nflReplayQuery, type ReplayListing } from '../../search/replay-dates';

const DAY_MS = 86_400_000;
const WINDOW_MS = 14 * DAY_MS;
const DEFAULT_SOURCES: Readonly<Record<string, { schedule?: string; broadcaster?: string }>> = {
  'college-bradley-mens-basketball': { schedule: 'https://bradleybraves.com/coverage' },
  'college-bradley-womens-basketball': { schedule: 'https://bradleybraves.com/coverage' },
};

export interface TeamGamesResult {
  games: { title: string; startMs: number; listings: TeamGameListing[] }[];
  channels?: CatalogRow[];
  unavailable: number;
  webSearch?: 'checked' | 'unavailable';
}

async function readPage(raw: string, signal: AbortSignal) {
  const url = validatePageUrl(raw, false);
  signal.throwIfAborted();
  const requestId = `team-listing-${crypto.randomUUID()}`;
  let canceled: Promise<unknown> | undefined;
  const cancel = () => {
    canceled = invoke('cancel_playlist', { requestId }).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const response = await invoke<DiscoveryPage>('inspect_discovery_page', {
      url,
      allowHttp: false,
      publicListing: true,
      requestId,
    });
    signal.throwIfAborted();
    const page = validatePage(response, url, false);
    const responseUrl = gamePageUrl(page.responseUrl);
    if (responseUrl?.origin !== new URL(url).origin)
      throw new Error('The listing redirected to another publisher.');
    return { html: page.html, responseUrl: responseUrl.href };
  } finally {
    signal.removeEventListener('abort', cancel);
    await canceled;
  }
}

// Cache public game dates only and cap requests independently of guide reads.
const replayCache = new Map<string, { game?: ReturnType<typeof nflGameDate>; until: number }>();
export async function lookupReplayDates(
  listings: readonly ReplayListing[],
  signal: AbortSignal,
): Promise<(string | undefined)[]> {
  const queries = listings.map(nflReplayQuery);
  if (!isTauri() || !queries.some(Boolean)) return queries.map(() => undefined);
  const key = (query: NonNullable<ReturnType<typeof nflReplayQuery>>) =>
    `${query.season}:${query.week}:${query.matchup}`;
  const now = Date.now();
  const missing = [
    ...new Map(
      queries.flatMap((query) =>
        query && (replayCache.get(key(query))?.until ?? 0) <= now
          ? [[key(query), query] as const]
          : [],
      ),
    ),
  ].slice(0, 4);
  const request = new AbortController();
  const cancel = () => request.abort();
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  const deadline = setTimeout(cancel, 8_000);
  try {
    await Promise.allSettled(
      missing.map(async ([id, query]) => {
        let game: ReturnType<typeof nflGameDate>;
        for (const url of query.urls) {
          request.signal.throwIfAborted();
          try {
            const page = await readPage(url, request.signal);
            if (page.responseUrl === url) game = nflGameDate(page.html, url, query);
          } catch {
            /* Try the other home/away order if available. */
          }
          if (game) break;
        }
        if (signal.aborted) return;
        replayCache.set(id, { game, until: now + (game ? DAY_MS : 10 * 60_000) });
        if (replayCache.size > 64) replayCache.delete(replayCache.keys().next().value!);
      }),
    );
    signal.throwIfAborted();
    return queries.map((query, index) => {
      const game = query && replayCache.get(key(query))?.game;
      return game && game.startMs < listings[index]!.startMs && game.startMs < now
        ? game.day
        : undefined;
    });
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', cancel);
  }
}

let illinoisSchools: ReturnType<typeof readIllinoisSchools> | undefined;

export async function lookupIllinoisTeams(query: string, signal: AbortSignal) {
  signal.throwIfAborted();
  if (!illinoisSchools) {
    const page = await readPage(ILLINOIS_CONFERENCE_DIRECTORY, signal);
    if (page.responseUrl !== ILLINOIS_CONFERENCE_DIRECTORY)
      throw new Error('Unexpected Illinois directory page.');
    illinoisSchools = readIllinoisSchools(page.html);
  }
  return findIllinoisTeams(query, illinoisSchools);
}

async function readPublisher(
  url: string,
  team: FavoriteTeam,
  signal: AbortSignal,
  facet?: SportsFacet,
) {
  const page = await readPage(url, signal);
  const playoffs = nfhsPlayoffPages(page.html, page.responseUrl, team);
  const pages = playoffs.length
    ? (await Promise.allSettled(playoffs.map((event) => readPage(event, signal)))).flatMap(
        (result) => (result.status === 'fulfilled' ? [result.value] : []),
      )
    : [page];
  return pages.flatMap(({ html, responseUrl }) =>
    parseTeamGameListings(html, responseUrl, team, facet).map((listing) => ({
      listing,
      pageUrl: responseUrl,
    })),
  );
}

async function searchListings(
  team: FavoriteTeam,
  known: readonly string[],
  stationSites: readonly string[],
  matches: (listing: TeamGameListing) => boolean,
  signal: AbortSignal,
  matchup?: string,
  facet?: SportsFacet,
) {
  const results = await Promise.allSettled(
    teamSearchUrls(team, matchup).map(async (url) => {
      const page = await readPage(url, signal);
      if (new URL(page.responseUrl).pathname !== '/lite/') throw new Error('Invalid search page.');
      return searchPublisherLinks(page.html, [...known, ...stationSites]);
    }),
  );
  const seen = new Set(known.map((url) => gamePageUrl(url)?.href));
  const successful = results.flatMap((result) =>
    result.status === 'fulfilled' ? [result.value.filter((url) => !seen.has(url))] : [],
  );
  // Reserve room for the station query even when the athletics query has many hits.
  const firstHits = successful.flatMap((links) => links.slice(0, 3));
  const candidates = [...new Set([...firstHits, ...successful.flat()])].slice(0, 6);
  const pages = await Promise.allSettled(
    candidates.map(async (url) => {
      return (await readPublisher(url, team, signal, facet)).filter(
        ({ listing }) => matches(listing) && matchupKey(listing.title),
      );
    }),
  );
  const found = pages.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
  return {
    entries: await verifyEventPages(found, team, signal, facet),
    unavailable:
      !successful.length ||
      (candidates.length > 0 && pages.every((page) => page.status === 'rejected')),
  };
}

type PublisherEntry = { listing: TeamGameListing; pageUrl: string };

async function verifyEventPages(
  found: PublisherEntry[],
  team: FavoriteTeam,
  signal: AbortSignal,
  facet?: SportsFacet,
): Promise<PublisherEntry[]> {
  // A search result is only a lead. If it was a listing, check the separate
  // event page for the same matchup, exact start time and its own video evidence.
  const watchPages = [
    ...new Set(
      found.flatMap(({ listing, pageUrl }) =>
        listing.watchUrl &&
        listing.watchUrl !== pageUrl &&
        new URL(listing.watchUrl).origin === new URL(pageUrl).origin
          ? [listing.watchUrl]
          : [],
      ),
    ),
  ].slice(0, 2);
  const verified = await Promise.allSettled(
    watchPages.map(async (url) => {
      const page = await readPage(url, signal);
      if (page.responseUrl !== url) return [];
      return parseTeamGameListings(page.html, page.responseUrl, team, facet).filter(
        (listing) => listing.watchUrl === url,
      );
    }),
  );
  const eventPages = verified.flatMap((result) =>
    result.status === 'fulfilled' ? result.value : [],
  );
  return found.map(({ listing, pageUrl }) => {
    const { watchUrl, broadcast, ...game } = listing;
    const matchup = matchupKey(game.title);
    const event = matchup
      ? eventPages.find(
          (entry) =>
            entry.watchUrl === watchUrl &&
            entry.startMs === game.startMs &&
            matchupKey(entry.title) === matchup,
        )
      : undefined;
    const verified =
      watchUrl &&
      (watchUrl === pageUrl ||
        // The reviewed Bradley adapter binds an exact ESPN player to its
        // official event row before exposing it as a watch target.
        pageUrl === 'https://bradleybraves.com/coverage' ||
        event)
        ? { ...game, watchUrl, broadcast: watchUrl === pageUrl ? broadcast : event?.broadcast }
        : game;
    return { listing: verified, pageUrl };
  });
}

export async function searchGamePages(
  target: GameSearchTarget,
  stationSites: readonly string[],
  signal: AbortSignal,
): Promise<{ entries: PublisherEntry[]; unavailable: boolean }> {
  if (!isTauri()) return { entries: [], unavailable: true };
  const { team, matchup, facet } = target;
  const defaults = Object.hasOwn(DEFAULT_SOURCES, team.id) ? DEFAULT_SOURCES[team.id] : undefined;
  const school = favoriteSchool(team);
  const known = [
    ...new Set(
      [
        team.scheduleUrl ?? defaults?.schedule,
        team.broadcasterUrl ?? defaults?.broadcaster,
        collegeFootballSchedule(team, facet),
        school && 'nfhs' in school
          ? `https://www.nfhsnetwork.com/schools/${school.nfhs}`
          : undefined,
      ].filter((url): url is string => !!url),
    ),
  ];
  const now = Date.now();
  const matches = (listing: TeamGameListing) =>
    listing.startMs >= now - 4 * 60 * 60_000 &&
    listing.startMs < now + WINDOW_MS &&
    target.matches(listing.title);
  const request = new AbortController();
  const cancel = () => request.abort();
  signal.throwIfAborted();
  signal.addEventListener('abort', cancel, { once: true });
  const deadline = setTimeout(cancel, 12_000);
  try {
    const [saved, youtube] = await Promise.all([
      Promise.allSettled(known.map((url) => readPublisher(url, team, request.signal, facet))),
      target.includeYouTube
        ? findAwihlYoutubeGame(target, readPage, request.signal, now).catch(() => [])
        : [],
    ]);
    const entries = await verifyEventPages(
      saved
        .flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
        .filter(({ listing }) => matches(listing)),
      team,
      request.signal,
      facet,
    );
    signal.throwIfAborted();
    for (const listing of youtube) entries.push({ listing, pageUrl: listing.listingUrl! });
    if (entries.some(({ listing }) => listing.watchUrl)) return { entries, unavailable: false };
    if (request.signal.aborted) return { entries, unavailable: true };
    const web = await searchListings(
      team,
      known,
      stationSites,
      matches,
      request.signal,
      matchup,
      facet,
    );
    signal.throwIfAborted();
    return {
      entries: [...entries, ...web.entries],
      unavailable: web.unavailable || request.signal.aborted,
    };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', cancel);
  }
}

async function readGuide(team: FavoriteTeam, start: number, end: number, signal: AbortSignal) {
  const page = await nativeGuide.programs({
    guideSourceId: '',
    appChannelIds: [],
    windowStartMs: start,
    windowEndMs: end,
    search: team.name,
    pageSize: 50,
    cursor: null,
    hideAdult: true,
  });
  signal.throwIfAborted();
  const knownSport = sports.find((sport) => matchesTeamSport(sport.label, team));
  return page.programs.flatMap((programme): TeamGameListing[] => {
    if (
      typeof programme.title !== 'string' ||
      programme.title.length > 256 ||
      !Number.isFinite(programme.startMs) ||
      !matchesTeamTitle(programme.title, team) ||
      /\b(?:pre[ -]?game|post[ -]?game|highlights|preview|recap|replay)\b/iu.test(programme.title)
    )
      return [];
    const exactSport = [
      programme.title,
      ...(programme.categories ?? []).map(({ text }) => text),
    ].some((value) => matchesTeamSport(value, team));
    if (
      !exactSport &&
      (!knownSport ||
        !programmeSportsFacts(programme, sportsFacts([]), { sport: knownSport.id }).sports.has(
          knownSport.id,
        ))
    )
      return [];
    return [
      {
        title: programme.title,
        startMs: programme.startMs,
        source: 'Saved Guide',
        guideChannel: {
          id: programme.appChannelId,
          sourceId: programme.catalogSourceId,
          stopMs: programme.stopMs,
        },
      },
    ];
  });
}

export async function discoverTeamGames(
  team: FavoriteTeam,
  signal: AbortSignal,
  stationSites: readonly string[] = [],
  includeChannels = false,
): Promise<TeamGamesResult> {
  if (!isTauri()) throw new Error('Game lookup requires the installed app.');
  const now = Date.now();
  const start = now - 4 * 60 * 60_000;
  const end = now + WINDOW_MS;
  const defaults = Object.hasOwn(DEFAULT_SOURCES, team.id) ? DEFAULT_SOURCES[team.id] : undefined;
  const school = favoriteSchool(team);
  const schoolPage =
    school && 'nfhs' in school ? `https://www.nfhsnetwork.com/schools/${school.nfhs}` : undefined;
  const urls = [
    ...new Set([
      team.scheduleUrl ?? defaults?.schedule,
      team.broadcasterUrl ?? defaults?.broadcaster,
      schoolPage,
      ...nfhsTournamentUrls(team),
      collegeFootballSchedule(team),
      ...btnListingUrls(team, now),
    ]),
  ].filter((url): url is string => !!url);
  const request = new AbortController();
  const abort = () => request.abort();
  signal.addEventListener('abort', abort, { once: true });
  if (signal.aborted) abort();
  let deadline = setTimeout(abort, 12_000);
  try {
    request.signal.throwIfAborted();
    // Merge publisher results even when some games are in the guide. An
    // affiliate absent from the channel lineup can still publish a game page.
    const sport = [...sportsFacts([team.sport]).sports][0];
    const scope = captureSportsScope(team.name, sport ? { sport } : {}, now);
    const [results, channels] = await Promise.all([
      Promise.allSettled([
        readGuide(team, start, start + 7 * DAY_MS, request.signal),
        ...urls.map(async (url) =>
          (await readPublisher(url, team, request.signal)).map(({ listing }) => listing),
        ),
      ]),
      includeChannels
        ? queryCatalogPage(
            {
              schemaVersion: 1,
              filter: 'sports',
              query: team.name,
              sort: 'name',
              pageSize: 12,
              hideAdult: true,
              ...(scope ? { sports: scope } : {}),
            },
            request.signal,
          ).then(
            (page) => page.rows.filter((row) => matchesTeamTitle(row.name, team)),
            () => undefined,
          )
        : undefined,
    ]);
    signal.throwIfAborted();
    const games = new Map<string, TeamGamesResult['games'][number]>();
    const inWindow = (listing: TeamGameListing) =>
      listing.startMs >= start && listing.startMs < end;
    const add = (listings: readonly TeamGameListing[]) => {
      for (const listing of listings) {
        if (!inWindow(listing)) continue;
        const key = `${listing.startMs}:${matchupKey(listing.title) ?? teamSearchKey(listing.title)}`;
        const game = games.get(key) ?? {
          title: listing.title,
          startMs: listing.startMs,
          listings: [],
        };
        if (
          !game.listings.some(
            (item) =>
              item.source === listing.source &&
              item.watchUrl === listing.watchUrl &&
              item.guideChannel?.id === listing.guideChannel?.id &&
              item.guideChannel?.sourceId === listing.guideChannel?.sourceId,
          )
        )
          game.listings.push(listing);
        games.set(key, game);
      }
    };
    for (const result of results) {
      if (result.status === 'fulfilled') add(result.value);
    }
    const chronological = () => [...games.values()].sort((a, b) => a.startMs - b.startMs);
    const ordered = chronological();
    const next = ordered.find((game) => game.startMs >= now) ?? ordered.at(-1);
    let webSearch: TeamGamesResult['webSearch'];
    if (!next?.listings.some((listing) => listing.watchUrl)) {
      clearTimeout(deadline);
      const search = new AbortController();
      const cancel = () => search.abort();
      signal.addEventListener('abort', cancel, { once: true });
      if (signal.aborted) cancel();
      deadline = setTimeout(cancel, 10_000);
      try {
        const fallback = await searchListings(team, urls, stationSites, inWindow, search.signal);
        signal.throwIfAborted();
        add(fallback.entries.map(({ listing }) => listing));
        webSearch = fallback.unavailable ? 'unavailable' : 'checked';
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    }
    return {
      games: chronological().slice(0, 30),
      ...(channels ? { channels } : {}),
      unavailable:
        results.filter((result) => result.status === 'rejected').length +
        Number(includeChannels && !channels),
      webSearch,
    };
  } finally {
    clearTimeout(deadline);
    signal.removeEventListener('abort', abort);
  }
}
