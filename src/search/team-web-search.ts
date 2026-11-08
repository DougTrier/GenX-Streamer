// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import type { FavoriteTeam } from '../preferences/favorite-teams';
import { favoriteSchool, findTeams, teamSearchKey } from './team-directory';
import { gamePageUrl } from './team-game-listings';
import type { SportsFacet } from './sports';

const SEARCH_URL = 'https://lite.duckduckgo.com/lite/';
const PUBLISHERS = new Set([
  // Reviewed league, athletics, school and local broadcaster domains.
  'nfl.com',
  'mlb.com',
  'nba.com',
  'nhl.com',
  'wnba.com',
  'ncaa.com',
  'bigten.org',
  'bradleybraves.com',
  'uwbadgers.com',
  'hawkeyesports.com',
  'nusports.com',
  'fightingillini.com',
  'goredbirds.com',
  'pekinhigh.net',
  'ihsa.org',
  'beta.ihsa.org',
  'nfhsnetwork.com',
  '25newsnow.com',
  'centralillinoisproud.com',
  'foxsports.com',
  'espn.com',
]);
const hostKey = (host: string) => host.replace(/^www\./u, '');

export function teamSearchUrls(team: FavoriteTeam, matchup?: string): string[] {
  const identity = [matchup ?? team.name, team.sport, team.location]
    .map((value) => teamSearchKey(value).slice(0, 160))
    .filter(Boolean)
    .join(' ');
  const listing =
    teamSearchKey(team.level ?? '') === 'high school'
      ? 'NFHS playoffs athletic schedule'
      : 'athletics official game schedule';
  return [listing, 'local TV station watch live game'].map((terms) => {
    const url = new URL(SEARCH_URL);
    url.searchParams.set('q', `${identity} ${terms}`);
    return url.href;
  });
}

export function searchPublisherLinks(html: string, known: readonly string[]): string[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  if (template.content.querySelector('#challenge-form, #anomaly-modal'))
    throw new Error('Web search is temporarily unavailable.');
  const trusted = new Set(known.map((value) => gamePageUrl(value)?.origin));
  const candidates = new Set<string>();
  for (const link of [...template.content.querySelectorAll('a.result-link[href]')].slice(0, 24)) {
    const result = gamePageUrl(link.getAttribute('href'), SEARCH_URL);
    const wrapped =
      (result?.origin === 'https://duckduckgo.com' ||
        result?.origin === 'https://lite.duckduckgo.com') &&
      result.pathname === '/l/';
    const url = wrapped ? gamePageUrl(result.searchParams.get('uddg')) : result;
    if (
      !url ||
      url.port ||
      url.pathname === '/' ||
      /(?:^|\/)(?:users?|~[^/]+)(?:\/|$)/iu.test(url.pathname)
    )
      continue;
    const host = hostKey(url.hostname);
    const educational =
      /^[a-z\d-]+\.(?:edu|k12\.[a-z]{2}\.us)$/u.test(host) ||
      /^(?:athletics|sports)\.[a-z\d-]+\.edu$/u.test(host);
    if (trusted.has(url.origin) || PUBLISHERS.has(host) || educational) candidates.add(url.href);
  }
  return [...candidates];
}

function matchupSides(title: string): string[] | undefined {
  if (/\b(?:pre[ -]?game|post[ -]?game|highlights|preview|recap|replay)\b/iu.test(title)) return;
  const matchup = title.split(/\s+(?:at|vs\.?|versus|@)\s+/iu);
  if (matchup.length !== 2) return;
  const sides = matchup.map((side) => teamSearchKey(side.split(': ').at(-1) ?? ''));
  if (sides.every((side) => side.length >= 2 && /\p{L}/u.test(side)) && sides[0] !== sides[1])
    return sides;
}

export function matchupKey(title: string): string | undefined {
  return matchupSides(title)?.sort().join('|');
}

export interface GameSearchTarget {
  team: FavoriteTeam;
  matchup?: string;
  includeYouTube?: boolean;
  facet?: SportsFacet;
  matches(title: string): boolean;
}

/** Admit only a team name or a two-sided matchup to the publisher search. */
export function gameSearchTarget(
  raw: string,
  saved: readonly FavoriteTeam[],
  facet: SportsFacet = {},
): GameSearchTarget | undefined {
  const query = raw.trim();
  if (
    query.length > 160 ||
    query.includes('://') ||
    [...query].some((c) => c < ' ' || c === '\x7f')
  )
    return;
  const sides = matchupSides(query);
  const name = sides?.[0] ?? teamSearchKey(query);
  if (!name) return;
  const teams = findTeams(name, saved).filter((team) =>
    [team.name, ...(favoriteSchool(team)?.aliases ?? [])].some(
      (label) => teamSearchKey(label) === name,
    ),
  );
  if (!sides && !teams.length) return;
  const team =
    teams.length === 1 ? teams[0]! : { id: 'game-search', name, sport: '', location: '' };
  return {
    team,
    ...(facet.sport || facet.league ? { facet } : {}),
    ...(sides ? { matchup: query } : {}),
    matches(title) {
      const actual = matchupSides(title);
      if (!actual) return false;
      const sameSide = (expected: string, observed: string) =>
        expected === observed || observed.startsWith(`${expected} `);
      if (!sides) return actual.some((side) => sameSide(name, side));
      return actual.some(
        (side, index) => sameSide(sides[0]!, side) && sameSide(sides[1]!, actual[1 - index]!),
      );
    },
  };
}
