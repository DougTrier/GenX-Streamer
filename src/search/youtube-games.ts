// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { gamePageUrl, type TeamGameListing } from './team-game-listings';
import { teamSearchKey } from './team-directory';
import { matchupKey, type GameSearchTarget } from './team-web-search';

export function youtubeWatchUrl(value: unknown): string | undefined {
  const url = gamePageUrl(value);
  if (!url || url.port) return;
  const id =
    url.hostname === 'youtu.be'
      ? /^\/([\w-]{11})$/u.exec(url.pathname)?.[1]
      : ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(
            url.hostname,
          )
        ? url.pathname === '/watch' && url.searchParams.getAll('v').length === 1
          ? url.searchParams.get('v')
          : /^\/(?:live|embed)\/([\w-]{11})$/u.exec(url.pathname)?.[1]
        : undefined;
  if (id && /^[\w-]{11}$/u.test(id)) return `https://www.youtube.com/watch?v=${id}`;
}

const schedule = 'https://stats.iha.org.au/leagues/schedules.cfm?leagueID=25754&clientID=6104';
const links = 'https://thesportscommons.com/league/awihl-australia/';
const officialChannel = 'https://www.youtube.com/@AWIHLTV';
const zones = new Map([
  ['perth inferno', 'Australia/Perth'],
  ['sydney sirens', 'Australia/Sydney'],
  ['melbourne ducks', 'Australia/Melbourne'],
  ['melbourne ice', 'Australia/Melbourne'],
  ['brisbane lightning', 'Australia/Brisbane'],
  ['adelaide rush', 'Australia/Adelaide'],
]);
const minutes = 60_000;

function publisherDocument(html: string): DocumentFragment {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content;
}

function awihlMatchup(value: string): string | undefined {
  const title = /^Week \d+ \| (.+) v (.+) Game \d+ \| AWIHL \d{4}\/\d{2} Season$/iu.exec(
    value.trim(),
  );
  return title ? matchupKey(`${title[1]} vs ${title[2]}`) : undefined;
}

export async function findAwihlYoutubeGame(
  target: GameSearchTarget,
  readPage: (url: string, signal: AbortSignal) => Promise<{ html: string; responseUrl: string }>,
  signal: AbortSignal,
  now: number,
): Promise<TeamGameListing[]> {
  if (
    !target.matchup ||
    (target.facet?.sport && target.facet.sport !== 'hockey') ||
    target.facet?.league ||
    !matchupKey(target.matchup)
      ?.split('|')
      .every((team) => zones.has(team))
  )
    return [];

  const [official, directory] = await Promise.all([
    readPage(schedule, signal),
    readPage(links, signal).catch(() => undefined),
  ]);
  if (official.responseUrl !== schedule) return [];
  const doc = publisherDocument(official.html);
  const games = [...doc.querySelectorAll('.scoreboard-box')].flatMap((card) => {
    const status = card.querySelector<HTMLAnchorElement>('a.scoreboardLink');
    if (status?.textContent?.trim() !== 'IN PROGRESS') return [];
    const boxScore = gamePageUrl(status.getAttribute('href'), schedule);
    if (
      boxScore?.origin !== new URL(schedule).origin ||
      boxScore.pathname !== '/leagues/hockey_boxscores.cfm'
    )
      return [];
    const rows = [...card.querySelectorAll('.row.font-weight-bold .col span')];
    const away = rows[0]?.textContent?.trim();
    const home = rows[1]?.textContent?.trim();
    const zone =
      home &&
      zones.get(
        teamSearchKey(home) === 'brisbane light' ? 'brisbane lightning' : teamSearchKey(home),
      );
    if (!away || !home || !zone) return [];
    const title = `${away === 'BRISBANE LIGHT.' ? 'Brisbane Lightning' : away} at ${home === 'BRISBANE LIGHT.' ? 'Brisbane Lightning' : home}`;
    if (!target.matches(title)) return [];
    const clock = card
      .querySelector(':scope > .row > .col > .row:first-child > .col')
      ?.textContent?.trim();
    const formatter = new Intl.DateTimeFormat('en-AU', {
      timeZone: zone,
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
    // The scoreboard shows venue-local wall time without a year. Resolve only
    // against the last five hours, including when the venue passed midnight.
    for (
      let startMs = Math.floor(now / minutes) * minutes;
      startMs >= now - 300 * minutes;
      startMs -= minutes
    ) {
      const parts = Object.fromEntries(
        formatter.formatToParts(startMs).map(({ type, value }) => [type, value]),
      );
      if (
        `${parts.weekday} ${parts.day} ${parts.month}. at ${parts.hour}:${parts.minute}${parts.dayPeriod}`.toUpperCase() ===
        clock?.toUpperCase()
      )
        return [
          {
            title,
            startMs,
            listingUrl: boxScore.href,
            source: 'Ice Hockey Australia · AWIHL (In progress)',
          },
        ];
    }
    return [];
  });
  const [game] = games;
  if (!game || games.length !== 1) return [];
  if (directory?.responseUrl !== links) return [game];
  const candidates = new Map<string, string>();
  // The directory supplies leads only. Ice Hockey Australia owns the game
  // state and YouTube's oEmbed response owns the uploader and video title.
  for (const card of [...publisherDocument(directory.html).querySelectorAll('article')].slice(
    0,
    60,
  )) {
    const stream = youtubeWatchUrl(card.querySelector('.btn-watch')?.getAttribute('href'));
    const start = Date.parse(card.querySelector('.live-since')?.getAttribute('data-start') ?? '');
    const title = card.querySelector('.card-title')?.textContent?.trim() ?? '';
    if (
      stream &&
      Math.abs(start - game.startMs) <= 30 * minutes &&
      awihlMatchup(title) === matchupKey(game.title)
    )
      candidates.set(stream, title);
  }
  const [candidate] = candidates;
  if (!candidate || candidates.size !== 1) return [game];
  const [watchUrl, title] = candidate;
  const metadata = new URL('https://www.youtube.com/oembed');
  metadata.searchParams.set('url', watchUrl);
  metadata.searchParams.set('format', 'json');
  const response = await fetch(metadata, {
    signal,
    redirect: 'error',
    credentials: 'omit',
    referrerPolicy: 'no-referrer',
  }).catch(() => undefined);
  if (!response?.ok) return [game];
  const data: unknown = await response.json().catch(() => undefined);
  if (
    !data ||
    typeof data !== 'object' ||
    !('author_url' in data) ||
    data.author_url !== officialChannel ||
    !('title' in data) ||
    data.title !== title
  )
    return [game];
  return [
    {
      ...game,
      watchUrl,
      watchOnYouTube: true,
    },
  ];
}
