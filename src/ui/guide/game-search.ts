// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import type { searchGamePages } from '../../application/guide/team-games';
import { matchupKey, type GameSearchTarget } from '../../search/team-web-search';

interface GameSearchHost {
  search: (target: GameSearchTarget, signal: AbortSignal) => ReturnType<typeof searchGamePages>;
  open(url: string, title: string): void;
}

export function mountGameSearch(before: HTMLElement, host: GameSearchHost) {
  const doc = before.ownerDocument;
  const panel = doc.createElement('section');
  panel.className = 'game-search-results team-game-results';
  panel.setAttribute('aria-label', 'Game search results');
  panel.hidden = true;
  panel.tabIndex = -1;
  const status = doc.createElement('p');
  status.setAttribute('role', 'status');
  const list = doc.createElement('ul');
  list.setAttribute('aria-label', 'Matching games');
  const time = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  panel.append(status, list);
  before.before(panel);
  let active: AbortController | undefined;

  function close(): boolean {
    active?.abort();
    active = undefined;
    if (panel.hidden) return false;
    panel.hidden = true;
    list.replaceChildren();
    return true;
  }

  async function start(target: GameSearchTarget): Promise<void> {
    close();
    const request = new AbortController();
    active = request;
    panel.hidden = false;
    status.textContent = 'Checking official game listings…';
    panel.focus({ preventScroll: true });
    try {
      const result = await host.search(target, request.signal);
      if (active !== request) return;
      const now = Date.now();
      const airing = ({ broadcast }: (typeof result.entries)[number]['listing']) =>
        !!broadcast && broadcast.startMs <= now && now < broadcast.endMs;
      const rank = ({ listing }: (typeof result.entries)[number]) =>
        listing.watchOnYouTube || airing(listing) ? 0 : listing.startMs >= now ? 1 : 2;
      const games = new Map<string, (typeof result.entries)[number]>();
      for (const entry of result.entries) {
        const { listing } = entry;
        const key = `${listing.startMs}:${matchupKey(listing.title)}`;
        const prior = games.get(key);
        if (!prior || rank(entry) === 0 || (!prior.listing.watchUrl && listing.watchUrl))
          games.set(key, entry);
      }
      for (const { listing, pageUrl } of [...games.values()]
        .sort((a, b) => rank(a) - rank(b) || a.listing.startMs - b.listing.startMs)
        .slice(0, 8)) {
        const row = doc.createElement('li');
        const title = doc.createElement('strong');
        title.textContent = listing.title;
        const details = doc.createElement('span');
        details.textContent = `${airing(listing) ? 'Scheduled to air now · ' : ''}${time.format(listing.startMs)} · ${listing.source}`;
        const button = doc.createElement('button');
        button.type = 'button';
        button.textContent = listing.watchOnYouTube
          ? 'Watch on YouTube'
          : listing.watchUrl
            ? 'Watch'
            : 'View listing';
        button.setAttribute('aria-label', `${button.textContent} ${listing.title}`);
        button.addEventListener('click', () => {
          if (active !== request) return;
          close();
          host.open(listing.watchUrl ?? listing.listingUrl ?? pageUrl, listing.title);
        });
        row.append(title, details, button);
        list.append(row);
      }
      status.textContent = games.size
        ? 'Matching games'
        : result.unavailable
          ? 'Game listings could not be checked right now.'
          : 'No matching game was found in the listings checked.';
    } catch {
      if (active === request) status.textContent = 'Game listings could not be checked right now.';
    }
  }
  return { start, close };
}
