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

import '../account-vod.css';
import {
  createAccountVod,
  type AccountVodCategory,
  type AccountVodDetails,
  type AccountVodEpisode,
  type AccountVodItem,
  type AccountVodSection,
} from '../../platform/account-vod';
import type { AccountVodTitle } from '../../application/accounts/account-player';
import { viewingSettings } from '../../platform/viewing-settings';
import { createAccountVodRows } from './account-vod-rows';
import { createSharedContext } from '../../application/shell/shared-context';

/**
 * Video On Demand for a Paid TV account ("GenX Cinema"): the provider's movies
 * and series. While open, a slim rail (Channels, search, Movies/TV Series,
 * categories) replaces the channel column, and the right side shows a banner
 * for the focused title above six posters per row. The remote moves by row and
 * column and never escapes to the player bar; Back steps out one level at a
 * time; returning restores the same section, category and title. Titles play
 * through the same account session as channels (one connection, credentials
 * stay native).
 */
export interface AccountVodHost {
  play(
    title: AccountVodTitle,
    account: { accountId: string; accountRevision: string },
  ): Promise<void>;
  run(work: Promise<void>): void;
  /** Re-measure TV menus after a select is shown or refilled. */
  changed?(): void;
}
export interface Account {
  id: string;
  revision: string;
}
const PAGE = 60;
/** Focus must rest this long on a title before its description is requested. */
const DETAIL_DELAY_MS = 350;
/** The same explicit adult markers as the channel lists. */
const ADULT = /adult|xxx|18\+|🔞|porn/iu;

export function mountAccountVod(
  host: AccountVodHost,
  elements: { row: HTMLElement; list: HTMLElement; stage: HTMLElement },
  client: Pick<
    ReturnType<typeof createAccountVod>,
    'list' | 'episodes' | 'details'
  > = createAccountVod(),
) {
  // What the parts of mountAccountVod in other modules share with it: each value
  // is read when a part uses it; the second list holds the ones parts assign.
  const shared = createSharedContext(
    {
      account: () => account,
      card: () => card,
      categories: () => categories,
      channels: () => channels,
      client: () => client,
      feature: () => feature,
      featured: () => featured,
      host: () => host,
      key: () => key,
      lastPlace: () => lastPlace,
      lastTitle: () => lastTitle,
      loadCategory: () => loadCategory,
      make: () => make,
      markCategory: () => markCategory,
      meta: () => meta,
      mode: () => mode,
      openSeries: () => openSeries,
      playMovie: () => playMovie,
      results: () => results,
      rowItems: () => rowItems,
      rowLoads: () => rowLoads,
      rowObserver: () => rowObserver,
      rowOwner: () => rowOwner,
      rowQueue: () => rowQueue,
      rowsBox: () => rowsBox,
      rowState: () => rowState,
      rowWaiters: () => rowWaiters,
      section: () => section,
      sectionButtons: () => sectionButtons,
      setMode: () => setMode,
      showGallery: () => showGallery,
    },
    {
      rowLoads: (value: typeof rowLoads) => (rowLoads = value),
      rowObserver: (value: typeof rowObserver) => (rowObserver = value),
      rowOwner: (value: typeof rowOwner) => (rowOwner = value),
    },
  );

  const app = () => document.getElementById('app');
  const make = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    props: Partial<HTMLElementTagNameMap[K]> = {},
  ): HTMLElementTagNameMap[K] => Object.assign(document.createElement(tag), props);
  const button = make('button', {
    type: 'button',
    id: 'vod-button',
    className: 'row-filter',
    // Short label so the row fits beside Favorites and Location and sort.
    textContent: 'VOD',
    title: 'Video On Demand',
  });
  button.setAttribute('aria-label', 'Video On Demand');
  button.setAttribute('aria-pressed', 'false');
  button.hidden = true;
  const favorites = elements.row.querySelector('[data-filter="favorites"]');
  if (favorites) favorites.after(button);
  else elements.row.append(button);

  // Left: the rail.
  const panel = make('section', { id: 'account-vod', className: 'account-vod', hidden: true });
  panel.setAttribute('aria-label', 'Video On Demand filters');
  const channels = make('button', {
    type: 'button',
    className: 'vod-channels',
    textContent: '‹ Channels',
  });
  channels.setAttribute('aria-label', 'Back to channels');
  const sections = make('nav', { className: 'vod-sections' });
  sections.setAttribute('aria-label', 'On-demand type');
  const sectionButtons = (['movies', 'series'] as const).map((section) => {
    const node = make('button', {
      type: 'button',
      textContent: section === 'movies' ? 'Movies' : 'TV Series',
    });
    node.dataset.vodSection = section;
    node.setAttribute('aria-pressed', 'false');
    return node;
  });
  sections.append(...sectionButtons);
  const filter = make('input', {
    id: 'vod-filter',
    type: 'search',
    placeholder: 'Search this category…',
    autocomplete: 'off',
  });
  filter.setAttribute('aria-label', 'Filter on-demand titles');
  const reopen = make('button', {
    type: 'button',
    className: 'vod-reopen',
    textContent: 'Back to titles',
    hidden: true,
  });
  const categories = make('div', { className: 'vod-categories' });
  categories.setAttribute('role', 'list');
  categories.setAttribute('aria-label', 'Categories');
  const status = make('p', { className: 'vod-status' });
  status.setAttribute('role', 'status');
  const retry = make('button', {
    type: 'button',
    className: 'vod-retry',
    textContent: 'Retry',
    hidden: true,
  });
  const state = make('div', { className: 'vod-state' });
  state.append(status, retry);
  panel.append(channels, filter, sections, reopen, state, categories);
  elements.list.after(panel);

  // Right: the titles, over the viewing area until something plays.
  const gallery = make('section', { id: 'vod-gallery', className: 'vod-gallery', hidden: true });
  gallery.setAttribute('aria-label', 'On-demand titles');
  const head = make('div', { className: 'vod-head' });
  const back = make('button', { type: 'button', className: 'vod-back', hidden: true });
  const heading = make('h3');
  const count = make('small');
  const season = make('select', { id: 'vod-season', hidden: true });
  season.setAttribute('aria-label', 'Season');
  head.append(back, heading, season, count);
  // The focused title, described by the provider (nothing invented).
  const banner = make('section', { className: 'vod-banner' });
  banner.setAttribute('aria-label', 'Selected title');
  banner.setAttribute('aria-live', 'polite');
  const bannerArt = make('span', { className: 'vod-banner-art' });
  const bannerInfo = make('div', { className: 'vod-banner-info' });
  const bannerTitle = make('h4');
  const bannerMeta = make('p', { className: 'vod-banner-meta' });
  const bannerPlot = make('p', { className: 'vod-banner-plot' });
  const bannerCredits = make('p', { className: 'vod-banner-credits', hidden: true });
  const bannerActions = make('div', { className: 'vod-banner-actions' });
  const bannerPlay = make('button', { type: 'button', className: 'vod-play', textContent: 'Play' });
  const bannerDetails = make('button', { type: 'button', textContent: 'Details' });
  bannerDetails.setAttribute('aria-expanded', 'false');
  bannerActions.append(bannerPlay, bannerDetails);
  bannerInfo.append(bannerTitle, bannerMeta, bannerPlot, bannerCredits, bannerActions);
  banner.append(bannerArt, bannerInfo);
  banner.hidden = true;
  // Category rows (Left/Right along a row, Up/Down between rows).
  const rowsBox = make('div', { className: 'vod-rows' });
  rowsBox.setAttribute('aria-label', 'Categories');
  const results = make('div', { className: 'vod-results' });
  results.setAttribute('role', 'list');
  results.hidden = true;
  const more = make('button', { type: 'button', className: 'vod-more', hidden: true });
  results.append(more);
  gallery.append(head, banner, rowsBox, results);
  elements.stage.append(gallery);

  let account: Account | null = null;
  let section: AccountVodSection = 'movies';
  let categoryName = '';
  let items: AccountVodItem[] = [];
  let shown = 0;
  let episodes: AccountVodEpisode[] = [];
  let series: AccountVodItem | null = null;
  let owner: AbortController | null = null;
  let lastLoad: (() => Promise<void>) | null = null;
  const categoriesCache = new Map<string, AccountVodCategory[]>();
  const chosenCategory = new Map<string, string>();
  /** The title last focused per section, so returning lands on it. */
  const lastTitle = new Map<string, string>();
  let restoring = false;
  let featured: AccountVodItem | null = null;
  let detailTimer: ReturnType<typeof setTimeout> | null = null;
  let detailOwner: AbortController | null = null;
  const detailCache = new Map<string, AccountVodDetails>();
  /** rows: every category as a row; grid: one category in full; episodes: a series. */
  let mode: 'rows' | 'grid' | 'episodes' = 'rows';
  let seriesFrom: 'rows' | 'grid' = 'rows';
  let gridCategory = '';
  /** Where the viewer was, per section, so returning lands there. */
  const lastPlace = new Map<string, { mode: 'rows' | 'grid'; category: string; item: string }>();
  const rowItems = new Map<string, AccountVodItem[]>();
  const rowState = new Map<string, 'loading' | 'ready' | 'failed'>();
  const rowWaiters = new Map<string, Array<() => void>>();
  const rowQueue: string[] = [];
  let rowLoads = 0;
  let rowOwner = new AbortController();
  let rowObserver: IntersectionObserver | null = null;
  const key = () => `${account?.id}:${account?.revision}:${section}`;

  const say = (text: string, failed = false) => {
    status.textContent = text;
    status.toggleAttribute('data-error', failed);
    retry.hidden = !failed;
  };
  function showGallery(value: boolean): void {
    gallery.hidden = !value;
    reopen.hidden = value || panel.hidden;
    elements.stage.classList.toggle('vod-browsing', value);
    const root = app();
    if (root) root.dataset.vodBrowsing = String(value);
  }
  function open(value: boolean): void {
    panel.hidden = !value;
    elements.list.hidden = value;
    button.setAttribute('aria-pressed', String(value));
    const root = app();
    if (root) root.dataset.vod = value ? 'open' : 'closed';
    showGallery(value);
    if (!value) {
      owner?.abort();
      owner = null;
      detailOwner?.abort();
      if (detailTimer) clearTimeout(detailTimer);
    }
  }
  function setMode(next: 'rows' | 'grid' | 'episodes'): void {
    mode = next;
    rowsBox.hidden = next !== 'rows';
    results.hidden = next === 'rows';
    if (next === 'rows') {
      back.hidden = true;
      season.hidden = true;
      heading.textContent = section === 'movies' ? 'Movies' : 'TV Series';
      count.textContent = '';
    } else {
      back.hidden = false;
      back.textContent = next === 'grid' ? '‹ All categories' : '‹ Back';
    }
  }
  const categoryRows = createAccountVodRows(shared);
  const {
    titleCard,
    focusCard,
    cards,
    lastRowCard,
    rowButtons,
    rowNode,
    jumpToRow,
    buildRows,
    requestRow,
    columns,
    railTarget,
    lastCard,
  } = categoryRows;
  const minutes = (seconds: number) => {
    const total = Math.round(seconds / 60);
    const hours = Math.floor(total / 60);
    return hours ? `${hours} h ${total % 60} min` : `${total} min`;
  };
  function describe(item: AccountVodItem, details: AccountVodDetails | undefined): void {
    bannerTitle.textContent = item.name;
    bannerMeta.textContent = [
      details?.year ?? item.year,
      item.rating ? `★ ${Number(item.rating).toFixed(1)}` : '',
      details?.genre ?? '',
      details?.durationSeconds ? minutes(details.durationSeconds) : '',
    ]
      .filter(Boolean)
      .join(' · ');
    bannerPlot.textContent = details?.plot ?? (details ? 'No description from the provider.' : '');
    const credits = [
      details?.director ? `Director: ${details.director}` : '',
      details?.cast ? `Cast: ${details.cast}` : '',
    ].filter(Boolean);
    bannerCredits.textContent = credits.join(' · ');
    bannerDetails.hidden = !credits.length && !(details?.plot && details.plot.length > 180);
    const art = details?.backdrop ?? item.poster;
    banner.style.backgroundImage = details?.backdrop
      ? `linear-gradient(90deg, rgb(8 12 30 / 0.96) 35%, rgb(8 12 30 / 0.55)), url("${details.backdrop}")`
      : '';
    bannerArt.replaceChildren();
    bannerArt.textContent = item.name.slice(0, 1).toLocaleUpperCase();
    if (item.poster && art) {
      const image = make('img', { alt: '', decoding: 'async' });
      image.referrerPolicy = 'no-referrer';
      image.addEventListener('error', () => image.remove(), { once: true });
      image.src = item.poster;
      bannerArt.append(image);
    }
  }
  /** Show the focused title now; ask the provider for its description after a pause. */
  function feature(item: AccountVodItem | null): void {
    featured = item;
    banner.hidden = !item || !!series;
    bannerPlay.textContent = section === 'movies' ? 'Play' : 'Episodes';
    bannerDetails.setAttribute('aria-expanded', 'false');
    bannerCredits.hidden = true;
    banner.classList.remove('expanded');
    if (detailTimer) clearTimeout(detailTimer);
    detailOwner?.abort();
    if (!item || !account) return;
    const cacheKey = `${key()}:${item.id}`;
    describe(item, detailCache.get(cacheKey));
    if (detailCache.has(cacheKey)) return;
    const current = account;
    const currentSection = section;
    detailTimer = setTimeout(() => {
      const owned = new AbortController();
      detailOwner = owned;
      void client
        .details(current, currentSection, item.id, owned.signal)
        .then((details) => {
          if (detailCache.size > 300) detailCache.delete(detailCache.keys().next().value!);
          detailCache.set(cacheKey, details);
          if (!owned.signal.aborted && featured === item) describe(item, details);
        })
        .catch(() => {
          if (!owned.signal.aborted && featured === item) bannerPlot.textContent = '';
        });
    }, DETAIL_DELAY_MS);
  }
  /** One request at a time; a newer choice cancels the older one. */
  function load(work: (signal: AbortSignal) => Promise<void>): Promise<void> {
    owner?.abort();
    const owned = new AbortController();
    owner = owned;
    const attempt = async () => {
      say('Loading…');
      try {
        await work(owned.signal);
        if (!owned.signal.aborted && status.textContent === 'Loading…') say('');
      } catch (error) {
        if (owned.signal.aborted) return;
        say(error instanceof Error ? error.message : 'This list could not load.', true);
      }
    };
    lastLoad = attempt;
    return attempt();
  }
  const meta = (item: AccountVodItem) =>
    [item.year, item.rating ? `★ ${Number(item.rating).toFixed(1)}` : '']
      .filter(Boolean)
      .join(' · ');
  function card(
    label: string,
    detail: string,
    poster: string | undefined | null,
    action: () => void,
  ) {
    const node = make('button', { type: 'button', className: 'vod-title' });
    node.setAttribute('role', 'listitem');
    node.setAttribute('aria-label', detail ? `${label}, ${detail}` : label);
    if (poster !== null) {
      // Titles without usable artwork keep the same card shape.
      const art = make('span', { className: 'vod-art' });
      art.setAttribute('aria-hidden', 'true');
      art.textContent = label.slice(0, 1).toLocaleUpperCase();
      if (poster) {
        const image = make('img', { alt: '', loading: 'lazy', decoding: 'async' });
        image.referrerPolicy = 'no-referrer';
        image.addEventListener('error', () => image.remove(), { once: true });
        image.src = poster;
        art.append(image);
      }
      node.append(art);
    }
    const text = make('span', { className: 'vod-text' });
    text.append(make('strong', { textContent: label }));
    if (detail) text.append(make('small', { textContent: detail }));
    node.append(text);
    node.addEventListener('click', action);
    return node;
  }
  function matches(): AccountVodItem[] {
    const query = filter.value.trim().toLocaleLowerCase();
    return query ? items.filter((item) => item.name.toLocaleLowerCase().includes(query)) : items;
  }
  function renderTitles(reset = true): void {
    if (series || mode === 'rows') return;
    const list = matches();
    if (reset) {
      results.replaceChildren(more);
      results.classList.remove('episodes');
      results.scrollTop = 0;
      shown = 0;
      season.hidden = true;
      heading.textContent = categoryName;
    }
    const next = list.slice(shown, shown + PAGE);
    more.before(...next.map((item) => titleCard(item, gridCategory, false)));
    shown += next.length;
    more.hidden = shown >= list.length;
    more.textContent = `Show more (${(list.length - shown).toLocaleString()} left)`;
    count.textContent = list.length
      ? `${list.length.toLocaleString()} ${section === 'movies' ? 'movies' : 'series'}`
      : filter.value
        ? 'No titles match this filter.'
        : 'This category is empty.';
    if (reset) feature(list[0] ?? null);
  }
  /** Returning to VOD lands on the title last focused in this section. */
  function restorePlace(): void {
    if (!restoring || mode !== 'grid') return;
    restoring = false;
    const id = lastTitle.get(key());
    const list = matches();
    const index = id ? list.findIndex((item) => item.id === id) : -1;
    while (index >= shown && shown < list.length) renderTitles(false);
    if (index >= 0) focusCard(cards()[index]);
  }
  function play(title: AccountVodTitle): void {
    if (!account) return;
    const target = { accountId: account.id, accountRevision: account.revision };
    // The chosen title opens in the viewing area itself.
    showGallery(false);
    host.run(
      host.play(title, target).catch((error: unknown) => {
        say(error instanceof Error ? error.message : 'This title could not start.', true);
        throw error;
      }),
    );
  }
  function playMovie(item: AccountVodItem): void {
    // No guessed container (XC-021): native asks the provider or says it is unknown.
    play({ kind: 'movie', itemId: item.id, extension: item.extension ?? '', name: item.name });
  }
  /** Providers often repeat "Show - S01E02" as the title; show only what is new. */
  function episodeLabel(episode: AccountVodEpisode): string {
    let title = episode.title.trim();
    const name = series?.name.trim() ?? '';
    if (name && title.toLocaleLowerCase().startsWith(name.toLocaleLowerCase()))
      title = title.slice(name.length).replace(/^[\s:–—-]+/u, '');
    title = title.replace(/^S\d{1,3}\s*E\d{1,4}\b[\s:–—-]*/iu, '').trim();
    return title ? `${episode.episode}. ${title}` : `Episode ${episode.episode}`;
  }
  function renderEpisodes(): void {
    const chosen = Number(season.value);
    const list = episodes.filter((episode) => episode.season === chosen);
    results.classList.add('episodes');
    results.replaceChildren(
      ...list.map((episode) => {
        const minutes = episode.durationSeconds
          ? `${Math.round(episode.durationSeconds / 60)} min`
          : '';
        return card(episodeLabel(episode), minutes, null, () =>
          play({
            kind: 'episode',
            itemId: episode.id,
            extension: episode.extension ?? '',
            name: `${series?.name ?? ''} S${episode.season}E${episode.episode}`.trim(),
          }),
        );
      }),
    );
    results.scrollTop = 0;
    count.textContent = list.length ? `${list.length} episodes` : 'No episodes in this season.';
  }
  function openSeries(item: AccountVodItem): Promise<void> {
    return load(async (signal) => {
      const current = account!;
      const rows = await client.episodes(current, item.id, signal);
      if (signal.aborted) return;
      seriesFrom = mode === 'grid' ? 'grid' : 'rows';
      series = item;
      episodes = rows;
      banner.hidden = true;
      setMode('episodes');
      heading.textContent = item.name;
      const seasons = [...new Set(rows.map((episode) => episode.season))];
      season.replaceChildren(
        ...seasons.map((value) =>
          make('option', { value: String(value), textContent: `Season ${value}` }),
        ),
      );
      season.hidden = seasons.length < 2;
      host.changed?.();
      renderEpisodes();
      back.focus({ preventScroll: true });
    });
  }
  function closeSeries(): void {
    const opened = series;
    series = null;
    episodes = [];
    host.changed?.();
    if (seriesFrom === 'rows') {
      setMode('rows');
      banner.hidden = !featured;
      focusCard(lastRowCard());
      return;
    }
    setMode('grid');
    renderTitles();
    if (opened) {
      const index = matches().findIndex((item) => item.id === opened.id);
      while (index >= shown && shown < matches().length) renderTitles(false);
      focusCard(cards()[index]);
    }
  }
  /** Leave the full grid (or a filter) for the category rows. */
  function closeGrid(): void {
    const from = gridCategory;
    filter.value = '';
    setMode('rows');
    banner.hidden = !featured;
    const buttons = rowButtons(rowNode(from));
    if (!focusCard(buttons[0])) focusCard(lastRowCard());
  }
  function markCategory(id: string): void {
    for (const node of categories.querySelectorAll<HTMLElement>('[data-category]'))
      node.setAttribute('aria-pressed', String(node.dataset.category === id));
  }
  function loadCategory(id: string, name: string): Promise<void> {
    markCategory(id);
    showGallery(true);
    gridCategory = id;
    setMode('grid');
    return load(async (signal) => {
      const current = account!;
      const listing = await client.list(current, section, id, signal);
      if (signal.aborted) return;
      chosenCategory.set(key(), id);
      series = null;
      categoryName = name;
      items = listing.items;
      renderTitles();
      restorePlace();
    });
  }
  function showSection(next: AccountVodSection): Promise<void> {
    section = next;
    for (const node of sectionButtons)
      node.setAttribute('aria-pressed', String(node.dataset.vodSection === next));
    series = null;
    items = [];
    results.replaceChildren(more);
    more.hidden = true;
    heading.textContent = '';
    count.textContent = '';
    categories.replaceChildren();
    showGallery(true);
    return load(async (signal) => {
      const current = account!;
      let rows = categoriesCache.get(key());
      if (!rows) {
        rows = (await client.list(current, section, null, signal)).categories;
        if (signal.aborted) return;
        categoriesCache.set(key(), rows);
      }
      // Settings → Hide adult channels also hides adult on-demand categories.
      const shown = viewingSettings.current.hideAdult
        ? rows.filter((row) => !ADULT.test(row.name))
        : rows;
      categories.replaceChildren(
        ...shown.map((row) => {
          const node = make('button', { type: 'button', textContent: row.name });
          node.dataset.category = row.id;
          node.setAttribute('role', 'listitem');
          node.setAttribute('aria-pressed', 'false');
          node.addEventListener('click', () => host.run(jumpToRow(row.id)));
          return node;
        }),
      );
      if (!shown.length) {
        say(`This provider lists no ${section === 'movies' ? 'movies' : 'TV series'}.`);
        return;
      }
      setMode('rows');
      featured = null;
      buildRows(shown);
      const place = restoring ? lastPlace.get(key()) : undefined;
      if (place?.mode === 'grid') {
        const name = shown.find((row) => row.id === place.category)?.name;
        if (name) {
          await loadCategory(place.category, name);
          return;
        }
      }
      restoring = false;
      for (const row of shown.slice(0, 3)) void requestRow(row.id);
      if (place?.mode === 'rows' && shown.some((row) => row.id === place.category)) {
        markCategory(place.category);
        rowNode(place.category)?.scrollIntoView({ block: 'start' });
        await requestRow(place.category);
        focusCard(lastRowCard());
      } else {
        // Opening VOD lands on the first title (the VOD button itself hides).
        markCategory(shown[0]!.id);
        await requestRow(shown[0]!.id);
        const active = document.activeElement;
        if (
          !(active instanceof HTMLElement) ||
          (!panel.contains(active) && !gallery.contains(active))
        )
          focusCard(rowButtons(rowNode(shown[0]!.id))[0]);
      }
    });
  }
  const toggle = () => {
    if (!account) return;
    if (panel.hidden) {
      open(true);
      restoring = true;
      host.run(showSection(section));
    } else {
      open(false);
      elements.list.focus({ preventScroll: true });
    }
  };
  button.addEventListener('click', toggle);
  channels.addEventListener('click', () => {
    open(false);
    elements.list.focus({ preventScroll: true });
  });
  bannerPlay.addEventListener('click', () => {
    if (!featured) return;
    if (section === 'movies') playMovie(featured);
    else void openSeries(featured);
  });
  bannerDetails.addEventListener('click', () => {
    const expanded = bannerDetails.getAttribute('aria-expanded') !== 'true';
    bannerDetails.setAttribute('aria-expanded', String(expanded));
    banner.classList.toggle('expanded', expanded);
    bannerCredits.hidden = !expanded || !bannerCredits.textContent;
  });
  // The remote: rows and columns inside the posters; nothing escapes to the
  // player bar or the top bar. Left of the first column is the rail.
  results.addEventListener('keydown', (event) => {
    const list = cards();
    const at = list.indexOf(document.activeElement as HTMLElement);
    if (at < 0 || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    const across = columns(list);
    if (event.key === 'ArrowRight') focusCard(list[at + 1]);
    else if (event.key === 'ArrowLeft') {
      if (at % across === 0) railTarget().focus({ preventScroll: true });
      else focusCard(list[at - 1]);
    } else if (event.key === 'ArrowUp') {
      if (at >= across) focusCard(list[at - across]);
      else if (!banner.hidden) bannerPlay.focus({ preventScroll: true });
      else if (!back.hidden) back.focus({ preventScroll: true });
    } else {
      if (at + across >= list.length && !more.hidden) renderTitles(false);
      const next = cards();
      const below = Math.floor(at / across) + 1;
      // The same column one row down, or the last title of a shorter last row.
      if (below * across < next.length) focusCard(next[Math.min(at + across, next.length - 1)]);
    }
  });
  rowsBox.addEventListener('keydown', (event) => {
    const active = document.activeElement as HTMLElement | null;
    const row = active?.closest<HTMLElement>('.vod-row');
    if (!active || !row || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key))
      return;
    event.preventDefault();
    const buttons = rowButtons(row);
    const at = buttons.indexOf(active);
    if (event.key === 'ArrowRight') {
      focusCard(buttons[at + 1]);
      return;
    }
    if (event.key === 'ArrowLeft') {
      if (at > 0) focusCard(buttons[at - 1]);
      else {
        markCategory(row.dataset.category!);
        railTarget().focus({ preventScroll: true });
      }
      return;
    }
    const rows = [...rowsBox.querySelectorAll<HTMLElement>('.vod-row:not([data-empty])')];
    let index = rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1);
    if (index < 0) {
      if (!banner.hidden) bannerPlay.focus({ preventScroll: true });
      return;
    }
    const step = async () => {
      while (index >= 0 && index < rows.length) {
        const target = rows[index]!;
        await requestRow(target.dataset.category!);
        const next = rowButtons(target);
        if (next.length) {
          focusCard(next[Math.min(Math.max(at, 0), next.length - 1)]);
          return;
        }
        index += event.key === 'ArrowDown' ? 1 : -1;
      }
    };
    void step();
  });
  banner.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusCard(lastCard());
    } else if (event.key === 'ArrowUp') event.preventDefault();
    else if (event.key === 'ArrowLeft' && document.activeElement === bannerPlay) {
      event.preventDefault();
      railTarget().focus({ preventScroll: true });
    }
  });
  panel.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowRight' || document.activeElement === filter) return;
    if (gallery.hidden) return;
    event.preventDefault();
    if (!focusCard(lastCard())) bannerPlay.focus({ preventScroll: true });
  });
  for (const node of sectionButtons)
    node.addEventListener('click', () => {
      if (node.dataset.vodSection !== section || !rowsBox.childElementCount)
        host.run(showSection(node.dataset.vodSection as AccountVodSection));
      else showGallery(true);
    });
  // Searching narrows the chosen category, shown as its full grid.
  filter.addEventListener('input', () => {
    if (series) closeSeries();
    showGallery(true);
    if (mode === 'rows') {
      const chosen =
        categories.querySelector<HTMLElement>('[aria-pressed="true"]') ??
        categories.querySelector<HTMLElement>('[data-category]');
      if (chosen) host.run(loadCategory(chosen.dataset.category!, chosen.textContent ?? ''));
      return;
    }
    renderTitles();
  });
  more.addEventListener('click', () => renderTitles(false));
  // Scrolling near the end loads the next page; the button stays for the remote.
  results.addEventListener(
    'scroll',
    () => {
      if (!more.hidden && results.scrollTop + results.clientHeight > results.scrollHeight - 600)
        renderTitles(false);
    },
    { passive: true },
  );
  back.addEventListener('click', () => (mode === 'episodes' ? closeSeries() : closeGrid()));
  season.addEventListener('change', renderEpisodes);
  reopen.addEventListener('click', () => {
    showGallery(true);
    results.querySelector<HTMLElement>('.vod-title')?.focus({ preventScroll: true });
  });
  retry.addEventListener('click', () => {
    if (lastLoad) host.run(lastLoad());
  });
  let hideAdult = viewingSettings.current.hideAdult;
  const unsubscribe = viewingSettings.subscribe((settings) => {
    if (settings.hideAdult === hideAdult) return;
    hideAdult = settings.hideAdult;
    if (!panel.hidden) host.run(showSection(section));
  });

  return {
    /** Paid TV with a selected account shows the button; anything else closes the screen. */
    present(next: Account | null): void {
      const changed = next?.id !== account?.id || next?.revision !== account?.revision;
      account = next ? { id: next.id, revision: next.revision } : null;
      button.hidden = !account;
      if (!account || changed) {
        if (!panel.hidden) open(false);
        items = [];
        series = null;
        filter.value = '';
      }
    },
    get open(): boolean {
      return !panel.hidden;
    },
    /** Back to the titles after a movie stops, on the poster last chosen. */
    showTitles(): void {
      if (panel.hidden) return;
      showGallery(true);
      if (!focusCard(lastCard())) bannerPlay.focus({ preventScroll: true });
    },
    /** Remote Back: titles → rail → out of VOD. False when VOD is not open. */
    back(): boolean {
      if (panel.hidden) return false;
      const active = document.activeElement;
      if (series && active instanceof HTMLElement && gallery.contains(active)) {
        closeSeries();
        return true;
      }
      if (mode === 'grid' && active instanceof HTMLElement && gallery.contains(active)) {
        closeGrid();
        return true;
      }
      if (active instanceof HTMLElement && gallery.contains(active) && !gallery.hidden) {
        railTarget().focus({ preventScroll: true });
        return true;
      }
      if (gallery.hidden && !reopen.hidden) {
        showGallery(true);
        focusCard(lastCard());
        return true;
      }
      open(false);
      button.focus({ preventScroll: true });
      return true;
    },
    close(): void {
      if (!panel.hidden) open(false);
    },
    dispose(): void {
      owner?.abort();
      rowOwner.abort();
      rowObserver?.disconnect();
      unsubscribe();
      button.remove();
      panel.remove();
      gallery.remove();
      elements.stage.classList.remove('vod-browsing');
      elements.list.hidden = false;
    },
  };
}
