// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import type { FavoriteTeam } from '../preferences/favorite-teams';
import { favoriteSchool, teamSearchKey } from './team-directory';
import { matchesSportsFacet, sportsFacts, type SportsFacet } from './sports';

export interface TeamGameListing {
  title: string;
  startMs: number;
  source: string;
  sportEvidence?: string[];
  broadcast?: { startMs: number; endMs: number };
  listingUrl?: string;
  watchUrl?: string;
  watchOnYouTube?: boolean;
  guideChannel?: { id: string; sourceId: string; stopMs: number | null };
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const hasType = (node: Record<string, unknown> | undefined, type: string): boolean =>
  [node?.['@type']]
    .flat()
    .some((value) => value === type || value === `https://schema.org/${type}`);
const includesWords = (label: string, query: string): boolean => {
  const key = teamSearchKey(query);
  return !!key && ` ${teamSearchKey(label)} `.includes(` ${key} `);
};

export function matchesTeamTitle(title: string, team: FavoriteTeam): boolean {
  return includesWords(title, team.name);
}

export function matchesTeamSport(label: string, team: FavoriteTeam): boolean {
  return includesWords(label, team.sport);
}

function absoluteTime(value: unknown): number {
  const date = text(value);
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/u.test(date)
    ? Date.parse(date)
    : NaN;
}

export function gamePageUrl(value: unknown, base?: string): URL | undefined {
  const address = text(value);
  if (!address || address.length > 2048 || /[\s\\]|%(?![0-9a-f]{2})/iu.test(address)) return;
  try {
    const url = new URL(address, base);
    if (url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.')) {
      url.hash = '';
      return url;
    }
  } catch {
    return;
  }
}

function structuredListings(
  doc: DocumentFragment,
  page: URL,
  team: FavoriteTeam,
): TeamGameListing[] {
  const nodes: unknown[] = [];
  for (const script of [...doc.querySelectorAll('script[type="application/ld+json"]')].slice(
    0,
    24,
  )) {
    const body = script.textContent ?? '';
    if (body.length > 256_000) continue;
    try {
      nodes.push(JSON.parse(body) as unknown);
    } catch {
      // Other publisher blocks can still contain usable metadata.
    }
  }
  const listings: TeamGameListing[] = [];
  // Only recognized containers are traversed. The page never executes and
  // embedded JSON-LD context URLs are never loaded.
  for (let index = 0; index < nodes.length && index < 500; index++) {
    const value = nodes[index];
    if (Array.isArray(value)) {
      nodes.push(...value.slice(0, 100));
      continue;
    }
    const node = record(value);
    if (!node) continue;
    for (const key of ['@graph', 'itemListElement', 'item', 'mainEntity', 'subEvent'])
      if (node[key] !== undefined) nodes.push(node[key]);
    if (!hasType(node, 'SportsEvent')) continue;
    const title = text(node.name);
    const startMs = absoluteTime(node.startDate);
    if (!title || title.length > 256 || !Number.isFinite(startMs)) continue;
    if (/Event(?:Cancelled|Postponed)$/u.test(text(node.eventStatus))) continue;
    const participant = [node.homeTeam, node.awayTeam, node.competitor]
      .flat()
      .some(
        (value) =>
          teamSearchKey(text(record(value)?.name) || text(value)) === teamSearchKey(team.name),
      );
    if (
      !(participant || matchesTeamTitle(title, team)) ||
      (team.sport && ![title, text(node.sport)].some((value) => includesWords(value, team.sport)))
    )
      continue;
    const eventUrl = gamePageUrl(node.url, page.href);
    let broadcastWindow: TeamGameListing['broadcast'];
    const hasBroadcast = [node.subjectOf].flat().some((value) => {
      const media = record(value);
      if (
        !hasType(media, 'VideoObject') ||
        !gamePageUrl(media?.embedUrl ?? media?.contentUrl, page.href)
      )
        return false;
      const publication = [media?.publication].flat();
      return publication.some((entry) => {
        const broadcast = record(entry);
        const airtime = absoluteTime(broadcast?.startDate);
        if (
          !hasType(broadcast, 'BroadcastEvent') ||
          broadcast?.isLiveBroadcast !== true ||
          !Number.isFinite(airtime) ||
          Math.abs(airtime - startMs) > 90 * 60_000
        )
          return false;
        const endMs = absoluteTime(broadcast.endDate);
        if (endMs > airtime && endMs - airtime <= 12 * 60 * 60_000)
          broadcastWindow = { startMs: airtime, endMs };
        return true;
      });
    });
    // A publisher's event URL and explicit broadcast metadata must agree.
    // General site players and cross-origin URLs embedded in metadata do not qualify.
    const watchUrl =
      hasBroadcast &&
      eventUrl?.origin === page.origin &&
      !/^\/(?:live|watch|stream|sports|schedule|video)?\/?$/iu.test(eventUrl.pathname)
        ? eventUrl.href
        : undefined;
    const sport = text(node.sport);
    const league = text(node.league);
    const declaredSport = sportsFacts([sport]).sports;
    const leagueAgrees = [...sportsFacts([league]).sports].every((id) => declaredSport.has(id));
    const sportEvidence =
      declaredSport.size && !leagueAgrees ? [sport] : [sport, league, ...(sport ? [] : [title])];
    listings.push({
      title,
      startMs,
      source: page.hostname,
      sportEvidence,
      ...(watchUrl ? { watchUrl, ...(broadcastWindow ? { broadcast: broadcastWindow } : {}) } : {}),
    });
  }
  return listings.map((listing) => {
    if (listing.watchUrl !== page.href || listings.length === 1) return listing;
    const schedule = { ...listing };
    delete schedule.watchUrl;
    delete schedule.broadcast;
    return schedule;
  });
}

const wallClock = (timeZone: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    hourCycle: 'h23',
  });
const central = wallClock('America/Chicago');
const eastern = wallClock('America/New_York');

function localTime(date: string, time: string, zone: Intl.DateTimeFormat): number {
  const day = /^(\d{4})-(\d{1,2})-(\d{1,2})$/u.exec(date);
  const clock = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/iu.exec(time);
  if (!day || !clock || +clock[1]! < 1 || +clock[1]! > 12 || +clock[2]! > 59) return NaN;
  const hour = (+clock[1]! % 12) + (clock[3]!.toUpperCase() === 'PM' ? 12 : 0);
  const desired = Date.UTC(+day[1]!, +day[2]! - 1, +day[3]!, hour, +clock[2]!);
  const calendar = new Date(desired);
  if (calendar.getUTCMonth() !== +day[2]! - 1 || calendar.getUTCDate() !== +day[3]!) return NaN;
  const wallTime = (instant: number) => {
    const parts = Object.fromEntries(
      zone.formatToParts(instant).map(({ type, value }) => [type, +value]),
    );
    return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!);
  };
  const candidate = desired + (desired - wallTime(desired));
  return wallTime(candidate) === desired ? candidate : NaN;
}

function bradleyListings(doc: DocumentFragment, team: FavoriteTeam): TeamGameListing[] {
  const listings: TeamGameListing[] = [];
  let date = '';
  for (const row of doc.querySelectorAll('.sidearm-coverage tr')) {
    const heading = row.querySelector('th[scope="colgroup"] .hide-on-large');
    if (heading)
      date = text(heading.textContent).replace(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/u, '$3-$1-$2');
    if (!row.classList.contains('sidearm-coverage-event')) continue;
    const sport = text(row.querySelector('td:nth-child(2)')?.textContent);
    const opponent = text(row.querySelector('.sidearm-coverage-event-opponent')?.textContent);
    const relation = text(row.querySelector('.sidearm-coverage-event-atvs')?.textContent);
    const startMs = localTime(date, text(row.querySelector('td')?.textContent), central);
    if (
      !includesWords(sport, team.sport) ||
      !opponent ||
      opponent.length > 90 ||
      !/^(at|vs\.?|versus)$/iu.test(relation) ||
      !Number.isFinite(startMs)
    )
      continue;
    const video = row.querySelector('.sidearm-coverage-streaming-media-video a');
    const url = gamePageUrl(video?.getAttribute('href'));
    // This reviewed publisher uses event-specific ESPN player pages. Ignore
    // radio, scores, ticket links and generic streaming-service landing pages.
    const watchUrl =
      url?.origin === 'https://www.espn.com' &&
      /^\/watch\/player\/_\/(?:id|eventCalendarId)\/[a-z\d-]+\/?$/iu.test(url.pathname)
        ? url.href
        : undefined;
    listings.push({
      title: `${team.name} ${relation} ${opponent}`,
      startMs,
      source: 'Bradley Athletics',
      sportEvidence: [sport],
      ...(watchUrl ? { watchUrl } : {}),
    });
  }
  return listings;
}

const NFHS = 'https://www.nfhsnetwork.com';
const NFHS_EVENT = /^\/events\/[a-z0-9-]+\/(?:gam|evt)[a-z0-9]+$/u;
const NFHS_TOURNAMENT = /^\/tournaments\/[a-z0-9-]+\/(?:boys|girls|coed)\/[a-z0-9-]+\/?$/u;

function nfhsTeamNames(team: FavoriteTeam): Set<string> {
  return new Set([team.name, ...(favoriteSchool(team)?.aliases ?? [])].map(teamSearchKey));
}

function nfhsMatchup(title: string, names: ReadonlySet<string>): boolean {
  const sides = title.split(/\s+(?:at|vs\.?|versus|@)\s+/iu).map(teamSearchKey);
  return (
    sides.length === 2 &&
    sides.every((side) => side && side !== 'tbd') &&
    sides.some((side) => names.has(side))
  );
}

function nfhsSport(team: FavoriteTeam, label: string, discipline?: string): boolean {
  const sport = teamSearchKey(team.sport).replace(/^american /u, '');
  if (!sport) return !!discipline?.trim();
  const gender = /^(boys|girls|mens|womens) /u.exec(sport)?.[1];
  const base = gender ? sport.slice(gender.length + 1) : sport;
  if (gender && !includesWords(label, gender)) return false;
  if (base === 'football' && includesWords(discipline ?? label, 'flag football')) return false;
  return discipline ? teamSearchKey(discipline) === base : includesWords(label, base);
}

export function nfhsTournamentUrls(team: FavoriteTeam): string[] {
  if (
    teamSearchKey(team.level ?? '') !== 'high school' ||
    !/(?:^| )(?:il|illinois)$/u.test(teamSearchKey(team.location))
  )
    return [];
  const sport = teamSearchKey(team.sport).replace(/^american /u, '');
  const gender = /^(boys|girls) /u.exec(sport)?.[1];
  const discipline = (gender ? sport.slice(gender.length + 1) : sport).replace(/ /gu, '-');
  if (
    ![
      'football',
      'flag-football',
      'basketball',
      'volleyball',
      'soccer',
      'wrestling',
      'baseball',
      'softball',
      'lacrosse',
      'field-hockey',
      'water-polo',
      'tennis',
      'track-and-field',
    ].includes(discipline)
  )
    return [];
  const genders = gender
    ? [gender]
    : ['football', 'baseball'].includes(discipline)
      ? ['boys']
      : ['flag-football', 'softball', 'field-hockey'].includes(discipline)
        ? ['girls']
        : ['boys', 'girls'];
  return genders.map((group) => `${NFHS}/tournaments/ihsa/${group}/${discipline}`);
}

export function nfhsPlayoffPages(html: string, responseUrl: string, team: FavoriteTeam): string[] {
  const page = gamePageUrl(responseUrl);
  if (page?.origin !== NFHS || !NFHS_TOURNAMENT.test(page.pathname)) return [];
  const template = document.createElement('template');
  template.innerHTML = html;
  const names = nfhsTeamNames(team);
  const urls = new Set<string>();
  for (const link of template.content.querySelectorAll('article a[href^="/events/"]')) {
    if (!nfhsMatchup(text(link.textContent), names)) continue;
    const event = gamePageUrl(link.getAttribute('href'), page.href);
    if (event?.origin === NFHS && NFHS_EVENT.test(event.pathname)) urls.add(event.href);
    if (urls.size >= 4) break;
  }
  return [...urls];
}

function nfhsEvent(doc: DocumentFragment, page: URL, team: FavoriteTeam): TeamGameListing[] {
  const raw = doc.querySelector(
    'script[type="application/ld+json"][data-hid="ld-event-detail"]',
  )?.textContent;
  if (!raw || raw.length > 128_000) return [];
  let graph: unknown;
  try {
    graph = record(JSON.parse(raw))?.['@graph'];
  } catch {
    return [];
  }
  if (!Array.isArray(graph) || graph.length > 16) return [];
  const nodes = graph.map(record);
  const event = nodes.find((node) => hasType(node, 'SportsEvent'));
  const title = text(event?.name);
  const startMs = absoluteTime(event?.startDate);
  if (
    !title ||
    title.length > 256 ||
    !Number.isFinite(startMs) ||
    /Event(?:Cancelled|Postponed)$/u.test(text(event?.eventStatus)) ||
    !nfhsSport(team, title, text(event?.sport))
  )
    return [];
  const sides = [record(event?.awayTeam)?.name, record(event?.homeTeam)?.name].map(text);
  const matchup = sides.join(' at ');
  if (!nfhsMatchup(matchup, nfhsTeamNames(team))) return [];
  const video = nodes.find(
    (node) =>
      hasType(node, 'VideoObject') &&
      gamePageUrl(node?.contentUrl)?.href === page.href &&
      text(node?.name) === title,
  );
  const broadcast = nodes.find((node) => {
    const event = record(node?.broadcastOfEvent);
    const watch = record(node?.potentialAction);
    return (
      hasType(node, 'BroadcastEvent') &&
      text(event?.name) === title &&
      absoluteTime(node?.startDate) === startMs &&
      absoluteTime(event?.startDate) === startMs &&
      hasType(watch, 'WatchAction') &&
      gamePageUrl(record(watch?.target)?.url)?.href === page.href
    );
  });
  return [
    {
      title: matchup,
      startMs,
      source: 'NFHS Network',
      sportEvidence: [text(event?.sport), title],
      ...(video && broadcast ? { watchUrl: page.href } : {}),
    },
  ];
}

function nfhsListings(doc: DocumentFragment, page: URL, team: FavoriteTeam): TeamGameListing[] {
  const listings: TeamGameListing[] = [];
  const names = nfhsTeamNames(team);
  const school = text(doc.querySelector('h1[data-test="organization-title"]')?.textContent);
  const schoolKey = teamSearchKey(school);
  if (names.has(schoolKey)) names.add(schoolKey.replace(/ high school$/u, ''));
  for (const link of doc.querySelectorAll('a[href^="/events/"][aria-label]')) {
    const title = text(link.getAttribute('aria-label'));
    const startMs = absoluteTime(link.querySelector('time[datetime]')?.getAttribute('datetime'));
    const route = gamePageUrl(link.getAttribute('href'), page.href);
    // The reviewed school page names the school in the URL and publishes exact
    // event pages with dated video cards for its own schedule.
    if (
      title.length > 0 &&
      title.length <= 256 &&
      Number.isFinite(startMs) &&
      nfhsMatchup(title, names) &&
      nfhsSport(team, text(link.textContent)) &&
      link.querySelector('[data-test="event-card"]') &&
      route?.origin === page.origin &&
      NFHS_EVENT.test(route.pathname)
    )
      listings.push({
        title,
        startMs,
        source: 'NFHS Network',
        sportEvidence: [text(link.textContent)],
        watchUrl: route.href,
      });
  }
  return listings;
}

const BTN_SCHEDULE = 'https://bigten.org/btn_schedule.aspx';
const NCAA_SCHEDULE =
  'https://www.ncaa.com/news/football/article/college-football-tv-schedule-game-times-preview';
const btnSchools = [
  ['Illinois', 'Illinois Fighting Illini'],
  ['Indiana', 'Indiana Hoosiers'],
  ['Iowa', 'Iowa Hawkeyes'],
  ['Maryland', 'Maryland Terrapins'],
  ['Michigan', 'Michigan Wolverines'],
  ['Michigan State', 'Michigan State Spartans'],
  ['Minnesota', 'Minnesota Golden Gophers'],
  ['Nebraska', 'Nebraska Cornhuskers'],
  ['Northwestern', 'Northwestern Wildcats'],
  ['Ohio State', 'Ohio State Buckeyes'],
  ['Oregon', 'Oregon Ducks'],
  ['Penn State', 'Penn State Nittany Lions'],
  ['Purdue', 'Purdue Boilermakers'],
  ['Rutgers', 'Rutgers Scarlet Knights'],
  ['UCLA', 'UCLA Bruins'],
  ['USC', 'USC Trojans'],
  ['Washington', 'Washington Huskies'],
  ['Wisconsin', 'Wisconsin Badgers'],
];
const btnSchool = (team: FavoriteTeam) =>
  btnSchools.find((names) =>
    names.some((name) => teamSearchKey(name) === teamSearchKey(team.name)),
  )?.[0];

export function collegeFootballSchedule(
  team: FavoriteTeam,
  facet?: SportsFacet,
): string | undefined {
  if (
    facet?.league === 'college-football' ||
    (facet?.sport === 'american-football' && !facet.league)
  )
    return NCAA_SCHEDULE;
  const sport = teamSearchKey(team.sport);
  if (
    ['american football', 'football'].includes(sport) &&
    (teamSearchKey(team.level ?? '') === 'college' ||
      btnSchool(team) ||
      /^(?:ncaa|fbs|fcs|big ten|b1g)$/u.test(teamSearchKey(team.league ?? '')))
  )
    return NCAA_SCHEDULE;
}

export function btnListingUrls(team: FavoriteTeam, now: number): string[] {
  if (
    !['big ten', 'big ten conference', 'big 10', 'b1g'].includes(
      teamSearchKey(team.league ?? ''),
    ) ||
    !btnSchool(team)
  )
    return [];
  const parts = Object.fromEntries(
    eastern.formatToParts(now).map(({ type, value }) => [type, +value]),
  );
  return [0, 1].map((days) => {
    const date = new Date(Date.UTC(parts.year!, parts.month! - 1, parts.day! + days));
    const url = new URL(BTN_SCHEDULE);
    url.searchParams.set('date', date.toISOString().slice(0, 10));
    url.searchParams.set('tz', 'Eastern Standard Time');
    return url.href;
  });
}

function btnListings(doc: DocumentFragment, page: URL, team: FavoriteTeam): TeamGameListing[] {
  const school = btnSchool(team);
  if (!school) return [];
  const date = doc.querySelector('input#btnDate')?.getAttribute('value');
  const zone = doc.querySelector('#btnTimeZone option[selected]')?.getAttribute('value');
  if (
    !date ||
    (page.searchParams.has('date') && date !== page.searchParams.get('date')) ||
    zone !== 'Eastern Standard Time'
  )
    return [];
  const sport = teamSearchKey(team.sport) === 'american football' ? 'Football' : team.sport;
  return [...doc.querySelectorAll('.btn-schedule .item:has(.pill-live)')].flatMap((item) => {
    const label = text(item.querySelector('.item-title')?.textContent);
    const match = /^B1G ([^:]+): (.{1,80}?) (?:at|vs\.?) (.{1,80})$/iu.exec(label);
    const startMs = localTime(date, text(item.querySelector('.item-time')?.textContent), eastern);
    if (
      !match ||
      !includesWords(match[1]!, sport) ||
      !Number.isFinite(startMs) ||
      !match.slice(2).some((name) => teamSearchKey(name) === teamSearchKey(school))
    )
      return [];
    return [
      {
        title: label.replace(/^B1G [^:]+: /iu, ''),
        startMs,
        source: 'Big Ten Network · TV listing',
        sportEvidence: [teamSearchKey(match[1]!) === 'football' ? 'College Football' : match[1]!],
      },
    ];
  });
}

function ncaaListings(
  doc: DocumentFragment,
  team: FavoriteTeam,
  facet?: SportsFacet,
): TeamGameListing[] {
  if (!collegeFootballSchedule(team, facet)) return [];
  const body = doc.querySelector('.article-body');
  if (
    !body ||
    ![...body.querySelectorAll('p em')].some((element) =>
      /^all times eastern\b/iu.test(text(element.textContent)),
    )
  )
    return [];
  let published = NaN;
  for (const script of [...doc.querySelectorAll('script[type="application/ld+json"]')].slice(
    0,
    12,
  )) {
    const value = text(script.textContent);
    if (value.length > 32_000) continue;
    try {
      const node = record(JSON.parse(value));
      if (node?.url === NCAA_SCHEDULE) published = absoluteTime(node.datePublished);
      if (Number.isFinite(published)) break;
    } catch {
      // An unrelated metadata block may be invalid.
    }
  }
  if (!Number.isFinite(published)) return [];
  const months = 'jan feb mar apr may jun jul aug sep oct nov dec'.split(' ');
  const year = new Date(published).getUTCFullYear();
  const names = [btnSchool(team), team.name].flatMap((name) => (name ? [teamSearchKey(name)] : []));
  let week = false;
  let date = '';
  const listings: TeamGameListing[] = [];
  for (const item of body.querySelectorAll('h3, p')) {
    if (item.tagName === 'H3') {
      if (week) break;
      week = /^week \d+ schedule/iu.test(text(item.textContent));
      continue;
    }
    if (!week) continue;
    const heading = /^[a-z]+day, ([a-z]+)\.? (\d{1,2})$/iu.exec(text(item.textContent));
    if (heading) {
      const month = months.indexOf(heading[1]!.slice(0, 3).toLowerCase()) + 1;
      date =
        [year - 1, year, year + 1]
          .map((candidate) => `${candidate}-${month}-${heading[2]}`)
          .find(
            (candidate) =>
              Math.abs(localTime(candidate, '12:00 PM', eastern) - published) < 8 * 86_400_000,
          ) ?? '';
    }
    if (!date) continue;
    for (const link of item.querySelectorAll('a[href]')) {
      const url = gamePageUrl(link.getAttribute('href'), NCAA_SCHEDULE);
      if (url?.origin !== 'https://www.ncaa.com' || !/^\/game\/\d+$/u.test(url.pathname)) continue;
      const [label, clock, network] = text(link.textContent).split(/\s*\|\s*/u);
      const match = /^(.{2,80}?) (?:at|vs\.?) (.{2,80})$/iu.exec(label ?? '');
      const time = /^(\d{1,2})(?::(\d{2}))?\s*([ap])\.?m\.?$/iu.exec(clock ?? '');
      if (!match || !time || !network || network.length > 48) continue;
      const sides = match.slice(1).map((name) => name.replace(/^No\. \d+ /iu, ''));
      if (!sides.some((name) => names.includes(teamSearchKey(name)))) continue;
      const startMs = localTime(date, `${time[1]}:${time[2] ?? '00'} ${time[3]}M`, eastern);
      if (Number.isFinite(startMs))
        listings.push({
          title: sides.join(' at '),
          startMs,
          source: `NCAA.com · ${network} (TV listing)`,
          sportEvidence: ['College Football'],
          listingUrl: url.href,
        });
    }
  }
  return listings;
}

export function parseTeamGameListings(
  html: string,
  responseUrl: string,
  team: FavoriteTeam,
  facet?: SportsFacet,
): TeamGameListing[] {
  const page = gamePageUrl(responseUrl);
  if (!page) return [];
  // Template content stays inert and is never attached to the document.
  const template = document.createElement('template');
  template.innerHTML = html;
  const listings = publisherListings(template.content, page, team, facet);
  if (!facet?.sport && !facet?.league) return listings;
  return listings.filter(({ sportEvidence = [] }) =>
    matchesSportsFacet(sportsFacts(sportEvidence), facet),
  );
}

function publisherListings(
  doc: DocumentFragment,
  page: URL,
  team: FavoriteTeam,
  facet?: SportsFacet,
): TeamGameListing[] {
  if (`${page.origin}${page.pathname}` === NCAA_SCHEDULE) return ncaaListings(doc, team, facet);
  if (`${page.origin}${page.pathname}` === BTN_SCHEDULE) return btnListings(doc, page, team);
  if (
    page.origin === 'https://bradleybraves.com' &&
    page.pathname === '/coverage' &&
    team.id.startsWith('college-bradley-')
  )
    return bradleyListings(doc, team);
  if (
    page.origin === NFHS &&
    /^\/schools\/[a-z0-9-]+(?:\/[a-z0-9-]+){0,3}\/?$/u.test(page.pathname)
  )
    return nfhsListings(doc, page, team);
  if (page.origin === NFHS && NFHS_EVENT.test(page.pathname)) return nfhsEvent(doc, page, team);
  return structuredListings(doc, page, team);
}
