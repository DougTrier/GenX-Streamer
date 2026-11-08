// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { sportsFacts, sportsMatchupTitle } from './sports';

export interface ReplayDates {
  originalAirDate: string | null;
  previousAirDate: string | null;
}
export interface ReplayListing {
  title: string;
  description?: string | null;
  startMs: number;
  categories?: readonly { text: string }[];
  replay?: ReplayDates;
  gameDate?: string;
}
export function validReplayDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const ms = Date.parse(value);
  return (
    Number.isFinite(ms) &&
    value >= '1900-01-01' &&
    new Date(ms).toISOString().slice(0, 10) === value
  );
}

export function originalReplayDate(listing: ReplayListing): string | undefined {
  const supplied = listing.replay?.originalAirDate;
  if (supplied) return supplied;
  for (const text of [listing.title, listing.description ?? '']) {
    const day = /\b(?:originally aired|original air date)\s*[:–-]?\s*(\d{4}-\d{2}-\d{2})\b/iu.exec(
      text,
    )?.[1];
    if (validReplayDay(day) && Date.parse(day) <= listing.startMs) return day;
  }
}

export const isReplay = (listing: ReplayListing) =>
  !!listing.replay || /\b(?:replay|rerun|rebroadcast|encore)\b/iu.test(listing.title);

export function replayDateLabel(listing: ReplayListing): string | undefined {
  const original = originalReplayDate(listing);
  const day = original ?? listing.gameDate ?? listing.replay?.previousAirDate;
  if (!validReplayDay(day)) return;
  const date = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeZone: 'UTC' }).format(
    Date.parse(day),
  );
  const label = original
    ? 'Originally aired'
    : listing.gameDate
      ? 'Game played'
      : 'Previously aired';
  return `${label} · ${date}${!original && listing.gameDate ? ' (NFL schedule)' : ''}`;
}

function nflTeams(title: string): string[] | undefined {
  const expanded = sportsMatchupTitle(title, sportsFacts(['NFL']));
  if (!expanded) return;
  const teams = [...sportsFacts([expanded]).teams];
  if (teams.length === 2) return teams;
}

export function nflReplayQuery(listing: ReplayListing) {
  if (
    !isReplay(listing) ||
    originalReplayDate(listing) ||
    /\b(?:preseason|postseason|playoffs?|super bowl|wild card|divisional)\b/iu.test(listing.title)
  )
    return;
  const titleFacts = sportsFacts([
    listing.title,
    ...(listing.categories ?? []).map(({ text }) => text),
  ]);
  if (!titleFacts.leagues.has('nfl') || titleFacts.leagues.size !== 1) return;
  const seasons = [...new Set(listing.title.match(/\b20\d{2}\b/gu))];
  const weeks = [
    ...new Set([...listing.title.matchAll(/\bweek\s+(\d{1,2})\b/giu)].map((m) => Number(m[1]))),
  ];
  if (seasons.length !== 1 || weeks.length !== 1) return;
  const season = Number(seasons[0]),
    week = weeks[0]!;
  const teams = nflTeams(listing.title);
  if (
    !teams ||
    season < 2002 ||
    season > new Date(listing.startMs).getUTCFullYear() ||
    week < 1 ||
    week > (season < 2021 ? 17 : 18)
  )
    return;
  const [first, second] = teams.map((id) => id.split('-').at(-1));
  const url = (away: string | undefined, home: string | undefined) =>
    `https://www.nfl.com/games/${away}-at-${home}-${season}-reg-${week}`;
  return {
    season,
    week,
    matchup: teams.sort().join('|'),
    urls: [url(first, second), url(second, first)],
  };
}

export function nflGameDate(
  html: string,
  url: string,
  query: NonNullable<ReturnType<typeof nflReplayQuery>>,
): { day: string; startMs: number } | undefined {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const { season, week, matchup } = query;
  if (
    doc.querySelector('link[rel="canonical"]')?.getAttribute('href') !== url ||
    !doc.title.endsWith(` ${season} REG ${week} - Game Center`) ||
    nflTeams(doc.title)?.sort().join('|') !== matchup
  )
    return;
  // Read the page's own Game Center state. Score strips and replay cards
  // also contain FINAL, for unrelated games.
  const completed = [...doc.scripts].some((script) => {
    if (!script.textContent?.includes('window.utag_data')) return false;
    const text = script.textContent.replace(/\\+"/gu, '"');
    return /window\.utag_data\s*=\s*\{(?=[^}]{0,500}"gameState"\s*:\s*"FINAL")(?=[^}]{0,500}"siteSubsection"\s*:\s*"gamecenter")[^}]{1,500}\}/u.test(
      text,
    );
  });
  if (!completed) return;
  const dates = doc.querySelectorAll(
    '[data-testid^="MatchupBanner-"] time[data-testid="game-date"]',
  );
  const time = dates.length === 1 ? dates[0]?.getAttribute('datetime') : undefined;
  if (!time || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u.test(time)) return;
  const ms = Date.parse(time);
  if (!Number.isFinite(ms)) return;
  const day = new Intl.DateTimeFormat('sv-SE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    timeZone: 'America/New_York',
  }).format(ms);
  if (validReplayDay(day) && day >= `${season}-09-01` && day <= `${season + 1}-01-31`)
    return { day, startMs: ms };
}
