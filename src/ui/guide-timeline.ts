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

import { GUIDE_GROUPING_POLICY } from '../guide/listed-channels';
import { prepareRemoteFocus } from './remote-navigation';
import { describeGuideAvailability } from '../guide/summary-reason';
import type {
  MappedProgram,
  ProgramPage,
  ProgramQuery,
  SelectedGuideSummary,
} from '../guide/native';
import { guideCategoryKey, validateGuideCategories } from '../guide/categories';
import { programCountdown } from '../guide/program-countdown';
import { describeChannelCoverage } from '../guide/coverage-presentation';
import { ChannelCoverageCleanupError } from '../guide/native';
import {
  validateChannelCoverageReply,
  type ChannelCoverageRequest,
  type ChannelCoverageReply,
} from '../guide/channel-coverage';

export interface TimelineChannel {
  id: string;
  sourceId: string;
  providerId?: string;
  name: string;
  category?: string;
  favorite?: boolean;
  guideSourceId: string | null;
  xmltvChannelId: string | null;
  guideRevision?: number;
}
export interface TimelineHost {
  /** Null is pending; failed distinguishes refusal from a completed empty result. */
  listedCount?(
    count: number | null,
    windowStartMs: number,
    windowEndMs: number,
    failed?: boolean,
  ): void;
  /** With search, keeps channels whose name or a program in the window has every word. */
  listedChannels?(
    windowStartMs: number,
    windowEndMs: number,
    signal: AbortSignal,
    search?: string,
  ): Promise<{
    catalogRevision: string;
    databaseRevision: number;
    /** Omitted only by legacy/browser hosts; native bridge always declares both. */
    viewRevision?: string;
    groupingPolicy?: string;
    channels: readonly {
      catalogSourceId: string;
      appChannelId: string;
      guideSourceId: string;
      xmltvChannelId: string;
      sourceRevision: number;
      filterMask?: number;
    }[];
  }>;
  logos?: {
    get(channel: TimelineChannel): string | null;
    visible(channels: readonly TimelineChannel[]): void;
    rejected(channel: TimelineChannel): void;
    suspend(): Promise<void>;
  };
  initiallyForeground?: boolean;
  channels(): readonly TimelineChannel[];
  catalogRevision(): string;
  query(query: ProgramQuery, signal: AbortSignal): Promise<ProgramPage>;
  summary?(
    channel: TimelineChannel,
    atMs: number,
    signal: AbortSignal,
  ): Promise<SelectedGuideSummary>;
  channelCoverage?(
    query: ChannelCoverageRequest,
    signal: AbortSignal,
  ): Promise<ChannelCoverageReply>;
  watch(channel: TimelineChannel, signal: AbortSignal): Promise<void>;
  channelActivate?(channel: TimelineChannel): void;
  mapChannel?(channel: TimelineChannel): Promise<void> | void;
  now(): number;
  formatTime(ms: number): string;
  formatAxisTime?(ms: number): string;
  /** Below this width the one-channel agenda replaces the grid (default 650). */
  agendaWidth?: number | (() => number);
}
const HALF = 1_800_000,
  WINDOW = 6 * HALF,
  WEEK = 7 * 86_400_000,
  ROW = 64,
  /** Rows the right-panel Guide shows at once on a TV or desktop. */
  GUIDE_ROWS = 12,
  MAX_ROWS = 32,
  MAX_CELLS = MAX_ROWS * 50;
/** Listing pages kept for reuse while scrolling (each at most 50 programmes). */
const PROGRAM_PAGES = 600;
/** Runs at most `limit` of the given tasks at once, in the order asked. */
function limitConcurrency(limit: number) {
  let running = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (running >= limit) return;
    const start = queue.shift();
    if (start) start();
  };
  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      queue.push(() => {
        running++;
        let result: Promise<T>;
        try {
          result = task();
        } catch (error) {
          result = Promise.reject(error);
        }
        result.then(resolve, reject).finally(() => {
          running--;
          next();
        });
      });
      next();
    });
}
/** The right-panel Guide keeps the grid down to 480 px (a TV's panel is ~600 px);
 * phones, where the guide spans the screen, keep the usual 650 px agenda. */
export const PANEL_AGENDA_WIDTH = (): number =>
  (globalThis.innerWidth ?? 1000) <= 700 ? 650 : 480;
export type TimelineCategory = 'all' | 'favorites' | 'news' | 'sports';
/** Search words folded like the native guide search text. */
export const guideSearchWords = (value: string) =>
  value.normalize('NFKC').toLowerCase().split(/\s+/u).filter(Boolean);
/** Every search word starts a word of the text, as in the native search ("nfl" is not "conflict"). */
export function guideSearchMatches(search: string, text: string): boolean {
  const words = text
    .normalize('NFKC')
    .toLowerCase()
    .split(/[\s([\-/:"#.]+/u);
  return guideSearchWords(search).every((term) => words.some((word) => word.startsWith(term)));
}
/** Filter only actual saved category metadata, using the existing channel filter vocabulary. */
export function timelineCategoryMatches(
  channel: TimelineChannel,
  filter: TimelineCategory,
): boolean {
  return (
    filter === 'all' ||
    (filter === 'favorites'
      ? channel.favorite === true
      : (channel.category ?? '').normalize('NFKC').toLowerCase().includes(filter))
  );
}
/** Navigation stays within the same bounded epoch window; this never claims feed coverage. */
export function timelineWindowStart(from: number, now: number, delta: number): number | null {
  if (![from, now, delta].every(Number.isSafeInteger)) throw new Error('Guide time invalid.');
  const first = Math.floor(now / HALF) * HALF,
    target = from + delta;
  return Number.isSafeInteger(target) && target >= first && target + WINDOW <= first + WEEK
    ? target
    : null;
}
export function cellBounds(
  start: number,
  stop: number | null,
  from: number,
): { left: number; width: number; unknown: boolean } | null {
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(from) ||
    (stop !== null && (!Number.isSafeInteger(stop) || stop <= start))
  )
    throw new Error('Guide listing invalid.');
  if (stop === null)
    return start >= from && start < from + WINDOW
      ? { left: ((start - from) / WINDOW) * 100, width: 0, unknown: true }
      : null;
  const lo = Math.max(start, from),
    hi = Math.min(stop, from + WINDOW);
  return hi > lo
    ? { left: ((lo - from) / WINDOW) * 100, width: ((hi - lo) / WINDOW) * 100, unknown: false }
    : null;
}
/** Semantic identity includes actual provider categories, not a guessed title genre. */
export function timelineProgramKey(p: MappedProgram): string {
  return JSON.stringify([
    p.catalogSourceId,
    p.appChannelId,
    p.guideSourceId,
    p.xmltvChannelId,
    p.startMs,
    p.stopMs,
    p.ordinal,
    p.title,
    p.description,
    guideCategoryKey(p.categories),
  ]);
}
const channelKey = (c: TimelineChannel) =>
  JSON.stringify([c.id, c.sourceId, c.guideSourceId, c.xmltvChannelId, c.guideRevision ?? null]);
const savedChannelKey = (c: TimelineChannel) => JSON.stringify([c.sourceId, c.id]);
const aborted = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

/** Foreground-only, bounded cached listings. This component never creates a decoder. */
export function mountGuideTimeline(container: HTMLElement, host: TimelineHost) {
  const doc = container.ownerDocument;
  const root = doc.createElement('section');
  root.className = 'gx-timeline';
  const agendaLimit = () =>
    typeof host.agendaWidth === 'function' ? host.agendaWidth() : (host.agendaWidth ?? 650);
  let rowHeight = ROW,
    renderedStart = 0,
    renderedLimit = 0,
    renderedCount = 0,
    renderedTotal = 0,
    renderedViewportHeight = 0,
    agendaMode = false,
    agendaCompact = false;
  let agendaControlsOpen = false;
  let agendaChannelKey: string | null = null,
    agendaProgramFocus: string | null = null;
  let agendaCursor: ProgramQuery['cursor'] = null;
  let agendaRevision: string | null = null;
  let agendaScope: string | null = null;
  let agendaFocusFirst = false;
  let fittedRow: { size: string; height: number } | null = null;
  const measuredRowHeight = () => {
    // The right-panel Guide on a TV or desktop lists many channels in thin
    // single-line rows, like a set-top guide; touch screens keep touch-size rows.
    const app = doc.getElementById('app');
    // Twelve rows fill the visible grid (owner request, October 19, 2026: 17
    // thin rows on the Sansui TV were too tight), never thinner than one line.
    if (app?.dataset.guidePanel === 'open' && app.dataset.deviceKind !== 'personal') {
      const line = Math.max(22, Math.ceil(parseFloat(getComputedStyle(root).fontSize) * 1.5 + 2));
      // Only a height the layout sets counts: where the viewport grows with its
      // rows (or sits at its own row cap), fitting to it would feed back.
      // Decided once per window size: the status line coming and going
      // changes the viewport's height, and refitting to it rebuilt the grid
      // over and over on the Sansui TV (October 19, 2026).
      const size = `${doc.defaultView?.innerWidth}x${doc.defaultView?.innerHeight}x${line}`;
      if (fittedRow?.size === size) return fittedRow.height;
      const shown = viewport.clientHeight;
      const laidOut =
        shown > 0 && viewport.scrollHeight > shown + 1 && shown < (MAX_ROWS - 1) * rowHeight - 1;
      if (!laidOut) return line;
      fittedRow = {
        size,
        height: Math.min(ROW, Math.max(line, Math.floor(shown / GUIDE_ROWS))),
      };
      return fittedRow.height;
    }
    const compactTV =
      doc.getElementById('app')?.dataset.deviceKind === 'tv' &&
      !!root.closest('.guide-compact-page') &&
      matchMedia('(min-width: 850px) and (min-height: 500px)').matches;
    return Math.max(
      compactTV ? 44 : ROW,
      Math.ceil(parseFloat(getComputedStyle(root).fontSize) * (compactTV ? 1.4 : 3.25) + 12),
    );
  };
  const viewportRowLimit = () =>
    Math.min(MAX_ROWS, Math.max(1, Math.ceil(viewport.clientHeight / rowHeight) + 1));
  // Rows drawn beyond the viewport, so remote scrolling moves through rows that
  // already exist; the grid redraws only when the view leaves the drawn range.
  const OVERSCAN = 8;
  const renderedCovers = () => {
    const top = Math.floor(viewport.scrollTop / rowHeight);
    const end = Math.min(
      renderedTotal,
      Math.ceil((viewport.scrollTop + viewport.clientHeight) / rowHeight),
    );
    return top >= renderedStart && end <= renderedStart + renderedCount;
  };
  root.setAttribute('aria-label', 'Program guide timeline');
  const toolbar = doc.createElement('nav');
  toolbar.setAttribute('aria-label', 'Timeline navigation');
  toolbar.className = 'gx-timeline-toolbar';
  const controlsToggle = doc.createElement('button');
  controlsToggle.type = 'button';
  controlsToggle.className = 'gx-agenda-controls-toggle';
  controlsToggle.textContent = 'Guide controls';
  controlsToggle.setAttribute('aria-label', 'Guide controls');
  controlsToggle.hidden = true;
  controlsToggle.setAttribute('aria-expanded', 'false');
  controlsToggle.addEventListener('click', () => {
    agendaControlsOpen = !agendaControlsOpen;
    toolbar.hidden = !agendaControlsOpen;
    controlsToggle.setAttribute('aria-expanded', String(agendaControlsOpen));
  });
  const status = doc.createElement('p');
  status.className = 'gx-timeline-status';
  status.setAttribute('role', 'status');
  const axis = doc.createElement('div');
  axis.className = 'gx-timeline-axis';
  const viewport = doc.createElement('div');
  viewport.className = 'gx-timeline-viewport';
  viewport.tabIndex = 0;
  viewport.setAttribute('aria-label', 'Guide channel rows');
  const content = doc.createElement('div');
  content.className = 'gx-timeline-content';
  viewport.append(content);
  const details = doc.createElement('section');
  details.className = 'gx-timeline-details';
  details.hidden = true;
  details.setAttribute('aria-label', 'Listing details');
  root.append(controlsToggle, toolbar, status, axis, viewport, details);
  const agendaHeader = doc.createElement('div');
  agendaHeader.className = 'gx-agenda-header';
  agendaHeader.hidden = true;
  const previousChannel = doc.createElement('button');
  previousChannel.type = 'button';
  previousChannel.textContent = '‹';
  previousChannel.setAttribute('aria-label', 'Previous guide channel');
  const browseChannel = doc.createElement('button');
  browseChannel.type = 'button';
  browseChannel.className = 'gx-agenda-channel';
  const nextChannel = doc.createElement('button');
  nextChannel.type = 'button';
  nextChannel.textContent = '›';
  nextChannel.setAttribute('aria-label', 'Next guide channel');
  const watchChannel = doc.createElement('button');
  watchChannel.type = 'button';
  watchChannel.className = 'gx-agenda-watch';
  watchChannel.textContent = 'Watch';
  watchChannel.hidden = !host.channelActivate;
  watchChannel.addEventListener('click', () => {
    const channel = agendaChannel();
    if (closed || !foreground || !channel || !currentChannel(channel)) return;
    host.channelActivate?.({ ...channel });
  });
  agendaHeader.append(previousChannel, browseChannel, nextChannel, watchChannel);
  root.insertBefore(agendaHeader, viewport);
  container.append(root);
  let closed = false,
    foreground = host.initiallyForeground ?? true,
    generation = 0,
    from = Math.floor(host.now() / HALF) * HALF;
  let controller: AbortController | null = null,
    detailController: AbortController | null = null,
    timer: ReturnType<typeof setTimeout> | null = null;
  let countdown: { node: HTMLElement; program: MappedProgram; valid(): boolean } | null = null;
  let active: Promise<void> | null = null,
    refreshWanted = false,
    detailVersion = 0,
    cleanupError: unknown = null;
  const jobs = new Set<Promise<void>>();
  let indexedChannels: readonly TimelineChannel[] | null = null;
  let channelIndex = new Map<string, TimelineChannel>();
  let returnFocus: HTMLElement | null = null;
  let filter: TimelineCategory = 'all';
  // Typed Guide search; matches look ahead a week so a game later on is found.
  let search = '';
  type Listed = Awaited<ReturnType<NonNullable<TimelineHost['listedChannels']>>>;
  type ListedCache = {
    anchor: number;
    catalogRevision: string;
    signature: string;
    databaseRevision: number;
    grouped: boolean;
    search: string;
    channels: Map<string, Listed['channels'][number]>;
  };
  let listedCache: ListedCache | null = null;
  /** Listings already read, newest last (see the row loop in refresh). */
  const programPages = new Map<string, ProgramPage>();
  const readLimit = limitConcurrency(4);
  let listedSignatureSource: readonly TimelineChannel[] | null = null;
  let listedSignature = '';
  const listingScope = (channels: readonly TimelineChannel[]) => {
    if (listedSignatureSource !== channels) {
      listedSignatureSource = channels;
      listedSignature = JSON.stringify(
        channels.map((c) => [channelKey(c), c.favorite === true, c.category ?? null]),
      );
    }
    return listedSignature;
  };
  const channelListed = (channel: TimelineChannel) => {
    if (!host.listedChannels) return true;
    if (
      !listedCache ||
      listedCache.anchor !== from ||
      listedCache.search !== search ||
      listedCache.catalogRevision !== host.catalogRevision()
    )
      return false;
    const member = listedCache.channels.get(savedChannelKey(channel));
    return (
      !!member &&
      member.guideSourceId === channel.guideSourceId &&
      member.xmltvChannelId === channel.xmltvChannelId &&
      (channel.guideRevision === undefined || member.sourceRevision === channel.guideRevision)
    );
  };
  // Native listings already apply the search (names and programs); without
  // them only saved channel names and categories can be matched.
  const searchMatches = (channel: TimelineChannel) =>
    !search ||
    !!host.listedChannels ||
    guideSearchMatches(search, `${channel.name} ${channel.category ?? ''}`);
  // Listings that match the search are highlighted so the schedule stands out.
  const programMatches = (program: {
    title: string;
    description?: string | null;
    categories?: readonly { text: string }[];
  }) =>
    !!search &&
    guideSearchMatches(
      search,
      `${program.title} ${program.description ?? ''} ${(program.categories ?? []).map((c) => c.text).join(' ')}`,
    );
  const categoryMatches = (channel: TimelineChannel) => {
    if (!listedCache?.grouped) return timelineCategoryMatches(channel, filter);
    const mask = listedCache.channels.get(savedChannelKey(channel))?.filterMask ?? 0;
    return filter === 'all' || (mask & { favorites: 1, news: 2, sports: 4 }[filter]) !== 0;
  };
  const emptyCategoryStatus = () =>
    search
      ? host.listedChannels
        ? `Nothing matches “${search}” in the next 7 days.`
        : `No saved channels match “${search}”.`
      : host.listedChannels && !host.channels().some(channelListed)
        ? 'No saved listings for this time. Find program guides or choose another time.'
        : filter === 'favorites'
          ? host.listedChannels
            ? 'No favorite channels have listings for this time. Choose All to browse saved listings.'
            : 'No favorite channels. Choose All to browse saved channels.'
          : filter === 'all'
            ? 'No saved channels.'
            : host.listedChannels
              ? 'No saved listings in this category for this time. Choose All to browse saved listings.'
              : 'No saved channels in this category. Choose All to browse saved channels.';
  let filteredSource: readonly TimelineChannel[] | null = null;
  let filteredCategory: TimelineCategory | null = null;
  let filteredSearch = '';
  let filteredMembership: ListedCache | null = null;
  let filteredChannels: readonly TimelineChannel[] = [];
  const visibleChannels = () => {
    const channels = host.channels();
    if (
      channels !== filteredSource ||
      filter !== filteredCategory ||
      search !== filteredSearch ||
      listedCache !== filteredMembership
    ) {
      filteredSource = channels;
      filteredCategory = filter;
      filteredSearch = search;
      filteredMembership = listedCache;
      filteredChannels = channels.filter(
        (c) => channelListed(c) && categoryMatches(c) && searchMatches(c),
      );
    }
    return filteredChannels;
  };
  const selectCell = (cell: HTMLButtonElement) => {
    for (const prior of content.querySelectorAll('.gx-timeline-selected')) {
      prior.classList.remove('gx-timeline-selected');
      prior.setAttribute('aria-pressed', 'false');
    }
    cell.classList.add('gx-timeline-selected');
    cell.setAttribute('aria-pressed', 'true');
  };
  let rowFocus: { key: string; column: number } | null = null;
  const rememberRowFocus = () => {
    const focused = doc.activeElement;
    const row =
      focused instanceof HTMLElement ? focused.closest<HTMLElement>('.gx-timeline-row') : null;
    if (focused instanceof HTMLElement && content.contains(focused) && focused.dataset.programKey)
      agendaProgramFocus = focused.dataset.programKey;
    if (row && content.contains(row)) {
      rowFocus = {
        key: row.dataset.channelKey!,
        column: [...row.querySelectorAll('button')].indexOf(focused as HTMLButtonElement),
      };
    }
  };
  const restoreRowFocus = () => {
    if (agendaMode) {
      if (
        doc.activeElement !== doc.body &&
        doc.activeElement !== viewport &&
        !content.contains(doc.activeElement)
      )
        return;
      const buttons = [...content.querySelectorAll<HTMLButtonElement>('.gx-agenda-listing')];
      const target =
        buttons.find((b) => b.dataset.programKey === agendaProgramFocus) ??
        (agendaFocusFirst ? buttons[0] : undefined);
      target?.focus({ preventScroll: true });
      target?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
      agendaFocusFirst = false;
      return;
    }
    if (
      !rowFocus ||
      (doc.activeElement !== doc.body &&
        doc.activeElement !== viewport &&
        !content.contains(doc.activeElement))
    )
      return;
    const row = [...content.querySelectorAll<HTMLElement>('.gx-timeline-row')].find(
      (r) => r.dataset.channelKey === rowFocus!.key,
    );
    const targets = row?.querySelectorAll<HTMLButtonElement>('button');
    if (targets?.length)
      targets[Math.min(Math.max(0, rowFocus.column), targets.length - 1)]!.focus({
        preventScroll: true,
      });
  };
  const button = (label: string, action: () => void) => {
    const el = doc.createElement('button');
    el.type = 'button';
    el.textContent = label;
    el.addEventListener('click', action);
    return el;
  };
  const launch = (job: Promise<void>) => {
    jobs.add(job);
    void job.finally(() => jobs.delete(job)).catch(() => undefined);
    return job;
  };
  const channelCards = new Map<HTMLButtonElement, TimelineChannel>();
  function channelArtwork(card: HTMLButtonElement, channel: TimelineChannel): void {
    const artwork = card.querySelector<HTMLElement>('.media-result-artwork');
    if (!artwork) return;
    const fallback =
      (channel.name.match(/[\p{L}\p{N}]+/gu) ?? [])
        .slice(0, 2)
        .map((word) => Array.from(word)[0])
        .join('')
        .toUpperCase() || 'TV';
    artwork.dataset.artwork = 'fallback';
    artwork.textContent = fallback;
    const logo = host.logos?.get(channel);
    // Artwork is supplied by the admitted native logo owner, never playlist URLs.
    if (
      !logo ||
      logo.length > 350000 ||
      !/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/.test(logo)
    )
      return;
    const image = doc.createElement('img');
    image.className = 'channel-logo-image';
    image.alt = '';
    image.decoding = 'async';
    image.addEventListener(
      'error',
      () => {
        if (
          closed ||
          !foreground ||
          !card.isConnected ||
          image.parentElement !== artwork ||
          channelCards.get(card) !== channel
        )
          return;
        host.logos?.rejected(channel);
        artwork.dataset.artwork = 'fallback';
        artwork.textContent = fallback;
      },
      { once: true },
    );
    image.src = logo;
    artwork.dataset.artwork = 'logo';
    artwork.replaceChildren(image);
  }
  function channelCard(
    card: HTMLButtonElement,
    channel: TimelineChannel,
    label = channel.name,
  ): void {
    card.setAttribute('aria-label', label);
    const artwork = doc.createElement('span');
    artwork.className = 'monogram media-result-artwork';
    artwork.setAttribute('aria-hidden', 'true');
    const category = (channel.category ?? '').toLowerCase();
    artwork.dataset.category =
      ['news', 'sports', 'movies', 'kids', 'nature', 'food', 'history'].find((c) =>
        category.includes(c),
      ) ?? 'other';
    const copy = doc.createElement('span');
    copy.className = 'media-result-copy';
    const name = doc.createElement('strong');
    name.className = 'media-result-title';
    name.textContent = channel.name;
    const meta = doc.createElement('small');
    meta.className = 'media-result-subtitle';
    meta.textContent = channel.category || 'Live channel';
    copy.append(name, meta);
    card.replaceChildren(artwork, copy);
    channelCards.set(card, channel);
    channelArtwork(card, channel);
  }
  function refreshArtwork(): void {
    if (closed || !foreground) return;
    for (const [card, channel] of channelCards)
      if (card.isConnected && currentChannel(channel)) channelArtwork(card, channel);
  }
  function visibleArtwork(): void {
    const bounds = viewport.getBoundingClientRect();
    const visible: TimelineChannel[] = [];
    if (
      !closed &&
      foreground &&
      viewport.getClientRects().length &&
      bounds.width > 0 &&
      bounds.height > 0
    )
      for (const [card, channel] of channelCards) {
        const box = card.getBoundingClientRect();
        const frame = card === browseChannel ? root.getBoundingClientRect() : bounds;
        if (
          card.isConnected &&
          box.bottom > Math.max(0, frame.top) &&
          box.top < Math.min(innerHeight, frame.bottom) &&
          box.right > frame.left &&
          box.left < frame.right
        )
          visible.push(channel);
      }
    host.logos?.visible(visible.slice(0, 32));
  }
  const currentChannel = (channel: TimelineChannel) => {
    const channels = host.channels();
    if (channels !== indexedChannels) {
      indexedChannels = channels;
      channelIndex = new Map(channels.map((c) => [JSON.stringify([c.sourceId, c.id]), c]));
    }
    const actual = channelIndex.get(JSON.stringify([channel.sourceId, channel.id]));
    return actual !== undefined && channelKey(actual) === channelKey(channel);
  };
  const addWeekCoverage = (
    channel: TimelineChannel,
    abort: AbortController,
    valid: () => boolean,
  ) => {
    if (
      !host.channelCoverage ||
      !channel.guideSourceId ||
      !channel.xmltvChannelId ||
      channel.guideRevision === undefined
    )
      return;
    const section = doc.createElement('details');
    const heading = doc.createElement('summary');
    heading.textContent = 'Next seven days';
    const result = doc.createElement('p');
    result.className = 'gx-timeline-week-coverage';
    result.textContent = 'Check this channel’s saved schedule. No guide download is started.';
    const check = button('Check next seven days', () => {
      if (!valid() || check.disabled) return;
      check.disabled = true;
      const start = host.now();
      result.textContent = 'Checking saved schedule…';
      void launch(
        (async () => {
          try {
            const query: ChannelCoverageRequest = {
              schemaVersion: 1,
              sourceId: channel.guideSourceId!,
              xmltvChannelId: channel.xmltvChannelId!,
              startMs: start,
              endMs: start + WEEK,
              expectedSourceRevision: channel.guideRevision!,
              expectedPublishedRevision: channel.guideRevision!,
            };
            const reply = validateChannelCoverageReply(
              await host.channelCoverage!(query, abort.signal),
              query,
            );
            if (valid())
              result.textContent = describeChannelCoverage(
                reply,
                host.formatTime,
                'the next seven days',
              );
          } catch (error) {
            if (
              error instanceof ChannelCoverageCleanupError ||
              (abort.signal.aborted && !aborted(error))
            ) {
              cleanupError = error;
              throw error;
            }
            if (valid())
              result.textContent =
                'Schedule could not be checked. Saved listings are retained; refresh Guide or review the mapping.';
          } finally {
            if (valid()) check.disabled = false;
          }
        })(),
      ).catch(report);
    });
    section.append(heading, result, check);
    details.append(section);
  };
  const back = button('Previous 3 hours', () => move(-WINDOW));
  const now = button('Now', () => {
    listedCache = null;
    from = Math.floor(host.now() / HALF) * HALF;
    agendaCursor = null;
    agendaProgramFocus = null;
    viewport.scrollTop = 0;
    void refresh().catch(report);
  });
  const next = button('Next 3 hours', () => move(WINDOW));
  const previousDay = button('Previous day', () => move(-86_400_000));
  const nextDay = button('Next day', () => move(86_400_000));
  for (const [control, text] of [
    [back, '-3h'],
    [next, '+3h'],
    [previousDay, '-Day'],
    [nextDay, '+Day'],
  ] as const) {
    control.setAttribute('aria-label', control.textContent!);
    control.textContent = text;
  }
  const date = doc.createElement('span');
  date.className = 'gx-timeline-date';
  date.setAttribute('aria-label', 'Guide date');
  const times = doc.createElement('div');
  times.className = 'gx-timeline-time-controls';
  times.append(previousDay, back, now, next, nextDay);
  const categories = doc.createElement('div');
  categories.className = 'gx-timeline-categories';
  categories.setAttribute('role', 'group');
  categories.setAttribute('aria-label', 'Guide channel categories');
  for (const value of ['all', 'favorites', 'news', 'sports'] as const) {
    const choice = button(
      value === 'all'
        ? 'All channels'
        : value === 'favorites'
          ? 'Favorites'
          : value === 'news'
            ? 'News'
            : 'Sports',
      () => {
        if (filter === value) return;
        filter = value;
        agendaCursor = null;
        agendaProgramFocus = null;
        rowFocus = null;
        viewport.scrollTop = 0;
        for (const item of categories.querySelectorAll('button'))
          item.setAttribute('aria-pressed', String(item === choice));
        void refresh().catch(report);
      },
    );
    choice.setAttribute('aria-label', choice.textContent!);
    if (value === 'all') choice.textContent = 'All';
    choice.setAttribute('aria-pressed', String(value === filter));
    categories.append(choice);
  }
  const searchBox = doc.createElement('input');
  searchBox.type = 'search';
  searchBox.className = 'gx-timeline-search';
  searchBox.placeholder = 'Search channels and programs';
  searchBox.setAttribute('aria-label', 'Search guide channels and programs');
  searchBox.maxLength = 120;
  searchBox.enterKeyHint = 'search';
  let searchTimer: ReturnType<typeof setTimeout> | undefined;
  const applySearch = () => {
    clearTimeout(searchTimer);
    const next = searchBox.value.trim().replace(/\s+/gu, ' ');
    if (closed || next === search) return;
    search = next;
    agendaCursor = null;
    agendaProgramFocus = null;
    rowFocus = null;
    viewport.scrollTop = 0;
    void refresh().catch(report);
  };
  // Filters as the user types, after a short pause.
  searchBox.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(applySearch, 250);
  });
  searchBox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') applySearch();
  });
  toolbar.append(categories, date, searchBox, times);
  const agendaChannel = () =>
    visibleChannels().find((c) => savedChannelKey(c) === agendaChannelKey);
  const chooseAgendaChannel = (channel: TimelineChannel) => {
    if (closed || !foreground || !currentChannel(channel)) return;
    agendaChannelKey = savedChannelKey(channel);
    agendaCursor = null;
    agendaProgramFocus = null;
    viewport.scrollTop = 0;
    closeDetails();
    void refresh().catch(report);
  };
  const moveAgendaChannel = (delta: number) => {
    const channels = visibleChannels(),
      index = channels.findIndex((c) => savedChannelKey(c) === agendaChannelKey);
    const next = channels[index + delta];
    if (next) chooseAgendaChannel(next);
  };
  previousChannel.addEventListener('click', () => moveAgendaChannel(-1));
  nextChannel.addEventListener('click', () => moveAgendaChannel(1));
  browseChannel.addEventListener('click', () => {
    if (closed || !foreground || !agendaMode) return;
    const channels = visibleChannels();
    if (!channels.length) return;
    closeDetails();
    returnFocus = browseChannel;
    details.hidden = false;
    root.classList.add('gx-timeline-has-details');
    const title = doc.createElement('strong');
    title.textContent = 'Choose a channel to browse';
    const list = doc.createElement('div');
    list.className = 'gx-agenda-channel-options';
    list.tabIndex = 0;
    list.setAttribute('aria-label', 'Guide channels');
    const options = doc.createElement('div');
    options.className = 'gx-agenda-channel-options-content';
    list.append(options);
    const pitch = Math.max(44, Math.ceil(parseFloat(getComputedStyle(root).fontSize) * 2.5 + 16));
    options.style.height = `${channels.length * pitch}px`;
    let focusedIndex = Math.max(
      0,
      channels.findIndex((c) => savedChannelKey(c) === agendaChannelKey),
    );
    const render = () => {
      if (closed || !foreground || details.hidden || !list.isConnected) return;
      const wasOwned = options.contains(doc.activeElement),
        start = Math.min(Math.floor(list.scrollTop / pitch), Math.max(0, channels.length - 1));
      options.replaceChildren();
      channels.slice(start, start + 8).forEach((channel, offset) => {
        const index = start + offset,
          choice = button(channel.name, () => chooseAgendaChannel(channel));
        choice.className = 'gx-agenda-channel-option';
        choice.dataset.channelIndex = String(index);
        choice.style.top = `${index * pitch}px`;
        choice.style.height = `${pitch}px`;
        choice.title = channel.name;
        choice.setAttribute('aria-pressed', String(savedChannelKey(channel) === agendaChannelKey));
        options.append(choice);
      });
      if (wasOwned) {
        const focus = options.querySelector<HTMLButtonElement>(
          `[data-channel-index="${focusedIndex}"]`,
        );
        if (focus) focus.focus({ preventScroll: true });
        else {
          focusedIndex = start;
          list.focus({ preventScroll: true });
        }
      }
    };
    list.addEventListener('scroll', render);
    list.addEventListener('keydown', (event) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      event.stopPropagation();
      const active =
        event.target instanceof HTMLElement ? event.target.dataset.channelIndex : undefined;
      if (active !== undefined) focusedIndex = Number(active);
      focusedIndex =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? channels.length - 1
            : Math.min(
                channels.length - 1,
                Math.max(0, focusedIndex + (event.key === 'ArrowDown' ? 1 : -1)),
              );
      const top = focusedIndex * pitch;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + pitch > list.scrollTop + list.clientHeight)
        list.scrollTop = top + pitch - list.clientHeight;
      render();
      options
        .querySelector<HTMLButtonElement>(`[data-channel-index="${focusedIndex}"]`)
        ?.focus({ preventScroll: true });
    });
    details.append(
      title,
      list,
      button('Back to agenda', () => closeDetails()),
    );
    list.scrollTop = focusedIndex * pitch;
    render();
    options
      .querySelector<HTMLButtonElement>(`[data-channel-index="${focusedIndex}"]`)
      ?.focus({ preventScroll: true });
  });
  function navigationState() {
    date.textContent = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    }).format(from);
    controlsToggle.textContent = `Guide controls · ${date.textContent}`;
    back.disabled = timelineWindowStart(from, host.now(), -WINDOW) === null;
    previousDay.disabled = timelineWindowStart(from, host.now(), -86_400_000) === null;
    next.disabled = timelineWindowStart(from, host.now(), WINDOW) === null;
    nextDay.disabled = timelineWindowStart(from, host.now(), 86_400_000) === null;
  }
  function report() {
    if (!closed) {
      delete status.dataset.state;
      status.textContent = 'Guide could not refresh. Choose Now to retry.';
      if (agendaMode && agendaCursor !== null && !content.querySelector('.gx-agenda-first')) {
        const first = button('First listings', () => {
          if (closed || !foreground) return;
          agendaCursor = null;
          agendaProgramFocus = null;
          agendaFocusFirst = true;
          void refresh().catch(report);
        });
        first.className = 'gx-agenda-first';
        content.append(first);
      }
    }
  }
  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }
  function closeDetails(): boolean {
    if (details.hidden) return false;
    ++detailVersion;
    detailController?.abort();
    details.hidden = true;
    root.classList.remove('gx-timeline-has-details');
    details.replaceChildren();
    countdown = null;
    if (returnFocus?.isConnected && !returnFocus.closest('[hidden],[inert]')) {
      returnFocus.focus({ preventScroll: true });
      returnFocus.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
    returnFocus = null;
    return true;
  }
  function clock() {
    clearTimer();
    if (closed || !foreground) return;
    const time = host.now(),
      line = content.querySelector<HTMLElement>('.gx-timeline-now');
    if (line) {
      line.hidden = time < from || time >= from + WINDOW;
      line.style.left = `calc(var(--gx-channel-width) + (100% - var(--gx-channel-width)) * ${(time - from) / WINDOW})`;
    }
    for (const watch of details.querySelectorAll<HTMLButtonElement>('[data-stop]'))
      if (time >= Number(watch.dataset.stop)) watch.disabled = true;
    if (countdown) {
      countdown.node.textContent = countdown.valid()
        ? programCountdown(countdown.program.startMs, countdown.program.stopMs, time).text
        : 'Schedule may have changed. Open the listing again to check.';
    }
    timer = setTimeout(clock, countdown && !details.hidden ? 1000 : 30_000);
  }
  function move(delta: number) {
    const target = timelineWindowStart(from, host.now(), delta);
    if (target === null) {
      delete status.dataset.state;
      status.textContent =
        'Choose a time within the next seven days. Actual listings may cover less.';
      return;
    }
    from = target;
    agendaCursor = null;
    agendaProgramFocus = null;
    viewport.scrollTop = 0;
    void refresh().catch(report);
  }
  function invalidate() {
    const rowOwnedFocus = content.contains(doc.activeElement);
    rememberRowFocus();
    generation++;
    controller?.abort();
    detailController?.abort();
    closeDetails();
    content.replaceChildren();
    if (rowOwnedFocus && foreground && !closed) viewport.focus({ preventScroll: true });
  }
  async function drain() {
    const results = await Promise.allSettled([...jobs]);
    const rejected = results.find(
      (r): r is PromiseRejectedResult => r.status === 'rejected' && !aborted(r.reason),
    );
    if (rejected) cleanupError = rejected.reason;
    if (cleanupError)
      throw new Error('Program guide cancellation could not finish. Retry closing.');
  }
  function refresh(): Promise<void> {
    if (closed || !foreground) return Promise.resolve();
    invalidate();
    refreshWanted = true;
    if (active) return active;
    const task = (async () => {
      while (refreshWanted && !closed && foreground) {
        refreshWanted = false;
        await drain();
        if (closed || !foreground) break;
        const mine = generation,
          abort = new AbortController();
        controller = abort;
        const revision = host.catalogRevision(),
          anchor = from;
        const valid = () =>
          !closed &&
          foreground &&
          !abort.signal.aborted &&
          mine === generation &&
          revision === host.catalogRevision();
        if (host.listedChannels) {
          const inventory = host.channels();
          const signature = listingScope(inventory);
          if (
            !listedCache ||
            listedCache.anchor !== anchor ||
            listedCache.search !== search ||
            listedCache.catalogRevision !== revision ||
            listedCache.signature !== signature
          ) {
            listedCache = null;
            channelCards.clear();
            if (agendaHeader.contains(doc.activeElement)) now.focus({ preventScroll: true });
            agendaHeader.hidden = true;
            content.style.height = '0px';
            delete status.dataset.state;
            status.textContent = 'Checking saved listings…';
            host.listedCount?.(null, anchor, anchor + WINDOW);
            root.insertBefore(status, axis);
            navigationState();
            let membership: Listed | undefined;
            const searched = search;
            try {
              await launch(
                (async () => {
                  membership = searched
                    ? await host.listedChannels!(anchor, anchor + WEEK, abort.signal, searched)
                    : await host.listedChannels!(anchor, anchor + WINDOW, abort.signal);
                })(),
              );
              if (searched !== search) continue;
              if (!valid()) continue;
              if (
                !membership ||
                membership.catalogRevision !== revision ||
                !Number.isSafeInteger(membership.databaseRevision) ||
                membership.databaseRevision < 0 ||
                !Array.isArray(membership.channels) ||
                membership.channels.length > 100000 ||
                signature !== listingScope(host.channels())
              )
                throw new Error('Guide listing scope changed.');
              const grouped = membership.groupingPolicy !== undefined;
              if (
                grouped &&
                (membership.groupingPolicy !== GUIDE_GROUPING_POLICY ||
                  typeof membership.viewRevision !== 'string' ||
                  !/^(0|[1-9]\d{0,18})$/.test(membership.viewRevision) ||
                  BigInt(membership.viewRevision) > 9223372036854775807n)
              )
                throw new Error('Guide grouping policy invalid.');
              const members = new Map<string, Listed['channels'][number]>();
              for (const member of membership.channels) {
                if (
                  !member ||
                  [
                    member.catalogSourceId,
                    member.appChannelId,
                    member.guideSourceId,
                    member.xmltvChannelId,
                  ].some((value) => typeof value !== 'string' || !value.length) ||
                  !Number.isSafeInteger(member.sourceRevision) ||
                  member.sourceRevision < 1 ||
                  (grouped &&
                    (!Number.isInteger(member.filterMask) ||
                      member.filterMask! < 0 ||
                      member.filterMask! > 7))
                )
                  throw new Error('Guide listing scope invalid.');
                const key = JSON.stringify([member.catalogSourceId, member.appChannelId]);
                if (members.has(key)) throw new Error('Guide listing scope duplicated.');
                members.set(key, member);
              }
              for (const channel of inventory) {
                const member = members.get(savedChannelKey(channel));
                if (
                  member &&
                  (member.guideSourceId !== channel.guideSourceId ||
                    member.xmltvChannelId !== channel.xmltvChannelId ||
                    (channel.guideRevision !== undefined &&
                      member.sourceRevision !== channel.guideRevision) ||
                    (grouped && (member.filterMask! & 1) !== Number(channel.favorite === true)))
                )
                  throw new Error('Guide listing mapping changed.');
              }
              listedCache = {
                anchor,
                catalogRevision: revision,
                signature,
                databaseRevision: membership.databaseRevision,
                grouped,
                search: searched,
                channels: members,
              };
            } catch (error) {
              if (abort.signal.aborted && !aborted(error)) {
                cleanupError = error;
                throw error;
              }
              if (valid()) {
                host.listedCount?.(null, anchor, anchor + WINDOW, true);
                report();
              }
              continue;
            }
          }
        }
        const channels = visibleChannels();
        if (host.listedChannels) host.listedCount?.(channels.length, anchor, anchor + WINDOW);
        const nextAgendaMode = root.clientWidth <= agendaLimit();
        if (nextAgendaMode !== agendaMode) {
          const focused = doc.activeElement;
          times.replaceChildren(
            ...(nextAgendaMode
              ? [back, now, next, previousDay, nextDay]
              : [previousDay, back, now, next, nextDay]),
          );
          if (focused instanceof HTMLElement && times.contains(focused))
            focused.focus({ preventScroll: true });
        }
        agendaMode = nextAgendaMode;
        agendaCompact =
          agendaMode &&
          ((doc.defaultView?.visualViewport?.height ?? doc.defaultView?.innerHeight ?? 1000) <
            500 ||
            (host.channelActivate !== undefined &&
              root.clientWidth <= 420 &&
              parseFloat(getComputedStyle(root).fontSize) >= 24));
        controlsToggle.hidden = !agendaCompact;
        toolbar.hidden = agendaCompact && !agendaControlsOpen;
        controlsToggle.setAttribute('aria-expanded', String(agendaCompact && agendaControlsOpen));
        root.dataset.layout = agendaMode ? 'agenda' : 'timeline';
        root.dataset.agendaCompact = String(agendaCompact);
        axis.hidden = agendaMode;
        agendaHeader.hidden = !agendaMode || (!!host.listedChannels && channels.length === 0);
        viewport.setAttribute(
          'aria-label',
          agendaMode ? 'Channel programme agenda' : 'Guide channel rows',
        );
        if (agendaMode && agendaRevision !== revision) {
          agendaCursor = null;
          agendaRevision = revision;
        }
        if (agendaMode && !channels.some((c) => savedChannelKey(c) === agendaChannelKey)) {
          const remembered = channels.find((c) => channelKey(c) === rowFocus?.key);
          agendaChannelKey = remembered
            ? savedChannelKey(remembered)
            : channels[0]
              ? savedChannelKey(channels[0])
              : null;
          agendaCursor = null;
          agendaProgramFocus = null;
        }
        if (agendaMode) {
          const selected = agendaChannel();
          const scope = selected ? channelKey(selected) : null;
          if (agendaScope !== scope) {
            agendaScope = scope;
            agendaCursor = null;
            agendaProgramFocus = null;
          }
        }
        navigationState();
        // Keep the axis/status in their final slots before measuring. Compact TV
        // removes a ready status from flow, so measure that settled geometry rather
        // than the loading line that will disappear after every completed query.
        const readyStatus = channels.length
          ? `${host.formatAxisTime?.(anchor) ?? host.formatTime(anchor)}`
          : emptyCategoryStatus();
        delete status.dataset.state;
        status.textContent = 'Loading visible listings…';
        if (!agendaMode) root.insertBefore(status, axis);
        axis.replaceChildren();
        for (let i = 0; i < 6; i++) {
          const tick = doc.createElement('span');
          tick.textContent =
            host.formatAxisTime?.(anchor + i * HALF) ?? host.formatTime(anchor + i * HALF);
          tick.title = host.formatTime(anchor + i * HALF);
          axis.append(tick);
        }
        rowHeight = measuredRowHeight();
        root.style.setProperty('--gx-row-height', `${rowHeight}px`);
        viewport.style.maxHeight = `${(MAX_ROWS - 1) * rowHeight}px`;
        if (!agendaMode) {
          status.textContent = readyStatus;
          status.dataset.state = 'ready';
        }
        renderedLimit = agendaMode
          ? viewportRowLimit()
          : Math.min(MAX_ROWS, viewportRowLimit() + 2 * OVERSCAN);
        renderedViewportHeight = viewport.clientHeight;
        // Restore truthful pending feedback synchronously before any asynchronous
        // work. ResizeObserver already ignores loading-only viewport height changes.
        delete status.dataset.state;
        status.textContent = 'Loading visible listings…';
        const top = Math.min(
            Math.floor(viewport.scrollTop / rowHeight),
            Math.max(0, channels.length - 1),
          ),
          // Overscan never pushes a visible row out of the bounded rendered range.
          start = agendaMode
            ? top
            : Math.max(0, top - OVERSCAN, top + viewportRowLimit() - renderedLimit),
          visible = channels.slice(start, start + renderedLimit).map((c) => ({ ...c }));
        renderedStart = start;
        renderedCount = visible.length;
        renderedTotal = channels.length;
        channelCards.clear();
        content.replaceChildren();
        content.style.height = agendaMode ? 'auto' : `${channels.length * rowHeight}px`;
        if (agendaMode) content.append(status);
        const job = (async () => {
          if (agendaMode) {
            const channel = agendaChannel();
            browseChannel.textContent = channel?.name ?? 'No channels in this category';
            browseChannel.setAttribute(
              'aria-label',
              channel ? `Browse guide channel: ${channel.name}` : 'No channels in this category',
            );
            browseChannel.title = channel?.name ?? '';
            if (channel)
              channelCard(browseChannel, channel, `Browse guide channel: ${channel.name}`);
            browseChannel.disabled = !channel;
            watchChannel.disabled = !channel || !host.channelActivate;
            watchChannel.setAttribute(
              'aria-label',
              channel ? `Watch channel: ${channel.name}` : 'Watch channel',
            );
            watchChannel.title = channel ? `Watch channel: ${channel.name}` : 'Watch channel';
            const channelIndex = channel
              ? channels.findIndex((c) => channelKey(c) === channelKey(channel))
              : -1;
            previousChannel.disabled = channelIndex <= 0;
            nextChannel.disabled = channelIndex < 0 || channelIndex >= channels.length - 1;
            if (!channel) {
              status.textContent = emptyCategoryStatus();
              status.dataset.state = 'ready';
              return;
            }
            const page =
              channel.guideSourceId && channel.xmltvChannelId
                ? await host.query(
                    {
                      guideSourceId: channel.guideSourceId,
                      appChannelIds: [channel.id],
                      windowStartMs: anchor,
                      windowEndMs: anchor + WINDOW,
                      search: '',
                      pageSize: 50,
                      cursor: agendaCursor,
                      contextAtMs: anchor,
                    },
                    abort.signal,
                  )
                : null;
            if (!valid() || !currentChannel(channel)) return;
            if (
              page &&
              (page.programs.length > 50 ||
                (host.listedChannels && page.databaseRevision !== listedCache?.databaseRevision) ||
                (channel.guideRevision !== undefined &&
                  page.sourceRevision !== channel.guideRevision) ||
                page.programs.some(
                  (p) =>
                    p.appChannelId !== channel.id ||
                    p.catalogSourceId !== channel.sourceId ||
                    p.guideSourceId !== channel.guideSourceId ||
                    p.xmltvChannelId !== channel.xmltvChannelId,
                ))
            )
              throw new Error('Guide scope mismatch.');
            for (const program of page?.programs ?? [])
              cellBounds(program.startMs, program.stopMs, anchor);
            const programs = [...(page?.programs ?? [])]
              .filter(
                (p) => p.startMs < anchor + WINDOW && (p.stopMs === null || p.stopMs > anchor),
              )
              .sort((a, b) => a.startMs - b.startMs || a.ordinal - b.ordinal);
            for (const program of programs) {
              const key = timelineProgramKey(program);
              const cell = button(program.title, () => {
                if (!valid() || !currentChannel(channel)) return;
                selectCell(cell);
                const job = showDetail(channel, program, cell, revision, mine);
                void launch(job).catch(report);
              });
              cell.className = 'gx-agenda-listing';
              if (programMatches(program)) cell.classList.add('gx-timeline-match');
              cell.dataset.programKey = key;
              cell.setAttribute('aria-label', program.title);
              cell.setAttribute('aria-pressed', 'false');
              cell.title = program.title;
              const title = doc.createElement('strong');
              title.textContent = program.title;
              const timing = doc.createElement('span');
              timing.className = 'gx-agenda-time';
              timing.id = `gx-agenda-time-${mine}-${program.ordinal}-${content.childElementCount}`;
              const absolute = doc.createElement('span');
              absolute.className = 'gx-agenda-absolute-time';
              absolute.id = timing.id;
              absolute.textContent = `${host.formatTime(program.startMs)}${program.stopMs === null ? ' · End time unknown' : ` – ${host.formatTime(program.stopMs)}`}`;
              timing.removeAttribute('id');
              timing.title = absolute.textContent;
              timing.textContent = `${host.formatAxisTime?.(program.startMs) ?? host.formatTime(program.startMs)}${program.stopMs === null ? ' · End time unknown' : ` – ${host.formatAxisTime?.(program.stopMs) ?? host.formatTime(program.stopMs)}`}`;
              timing.setAttribute('aria-hidden', 'true');
              cell.setAttribute('aria-describedby', absolute.id);
              cell.replaceChildren(title, timing, absolute);
              if (
                program.stopMs !== null &&
                program.startMs <= host.now() &&
                host.now() < program.stopMs
              )
                cell.classList.add('gx-timeline-current');
              content.append(cell);
            }
            if (!programs.length) {
              const note = doc.createElement('p');
              note.className = 'gx-timeline-note';
              note.textContent =
                channel.guideSourceId && channel.xmltvChannelId
                  ? 'No listings for this time'
                  : 'Guide not linked';
              content.append(note);
              const inspect = button('Schedule details', () => {
                if (valid() && currentChannel(channel))
                  void launch(showEmptyDetail(channel, inspect, revision, mine, anchor)).catch(
                    report,
                  );
              });
              inspect.className = 'gx-agenda-listing';
              content.append(inspect);
            }
            if (agendaCursor !== null)
              content.append(
                button('First listings', () => {
                  if (!valid()) return;
                  agendaCursor = null;
                  agendaProgramFocus = null;
                  agendaFocusFirst = true;
                  viewport.scrollTop = 0;
                  void refresh().catch(report);
                }),
              );
            if (page?.nextCursor) {
              const cursor = structuredClone(page.nextCursor);
              content.append(
                button('More listings', () => {
                  if (!valid()) return;
                  agendaCursor = cursor;
                  agendaProgramFocus = null;
                  agendaFocusFirst = true;
                  viewport.scrollTop = 0;
                  void refresh().catch(report);
                }),
              );
            }
            status.textContent = `${programs.length} listings shown for ${channel.name}${page?.nextCursor ? ' · More listings available' : ''}.`;
            status.dataset.state = 'ready';
            visibleArtwork();
            content.append(status);
            restoreRowFocus();
            clock();
            return;
          }
          let count = 0;
          // Rows ask for their listings four at a time, and listings already
          // read are reused: holding Down on the Sansui TV outran one-at-a-time
          // reads that started over at every jump (owner report, October 19,
          // 2026). Rows are still drawn in order, each checked as before.
          const signal = abort.signal;
          let stopped = false;
          const pages = visible.map((channel) =>
            readLimit(() => {
              if (stopped || !channel.guideSourceId || !channel.xmltvChannelId)
                return Promise.resolve(null);
              // Reused only for the same window and the same guide data.
              const key = host.listedChannels
                ? JSON.stringify([
                    channelKey(channel),
                    anchor,
                    channel.guideRevision ?? null,
                    listedCache?.databaseRevision ?? null,
                  ])
                : null;
              const known = key ? programPages.get(key) : undefined;
              if (known) {
                programPages.delete(key!);
                programPages.set(key!, known);
                return Promise.resolve(known);
              }
              signal.throwIfAborted();
              return host
                .query(
                  {
                    guideSourceId: channel.guideSourceId,
                    appChannelIds: [channel.id],
                    windowStartMs: anchor,
                    windowEndMs: anchor + WINDOW,
                    contextAtMs: host.listedChannels ? undefined : anchor,
                    search: '',
                    pageSize: 50,
                    cursor: null,
                  },
                  signal,
                )
                .then((page) => {
                  if (key) {
                    programPages.set(key, page);
                    while (programPages.size > PROGRAM_PAGES)
                      programPages.delete(programPages.keys().next().value!);
                  }
                  return page;
                });
            }),
          );
          // Rows abandoned by a newer refresh must not report failures.
          for (const pending of pages) pending.catch(() => undefined);
          try {
            for (let i = 0; i < visible.length; i++) {
              const channel = visible[i]!;
              const page: ProgramPage | null = await pages[i]!;
              if (!valid() || !currentChannel(channel)) return;
              if (
                page &&
                (page.programs.length > 50 ||
                  (host.listedChannels &&
                    page.databaseRevision !== listedCache?.databaseRevision) ||
                  (channel.guideRevision !== undefined &&
                    page.sourceRevision !== channel.guideRevision) ||
                  page.programs.some(
                    (p) =>
                      p.appChannelId !== channel.id ||
                      p.catalogSourceId !== channel.sourceId ||
                      p.guideSourceId !== channel.guideSourceId ||
                      p.xmltvChannelId !== channel.xmltvChannelId,
                  ))
              )
                throw new Error('Guide scope mismatch.');
              const row = doc.createElement('div');
              row.className = 'gx-timeline-row';
              row.dataset.channelKey = channelKey(channel);
              row.style.top = `${(start + i) * rowHeight}px`;
              // Alternating bands, so the eye can follow one channel across.
              row.dataset.band = (start + i) % 2 ? 'b' : 'a';
              const label = button(channel.name, () => {
                if (!valid() || !currentChannel(channel)) return;
                if (host.channelActivate) host.channelActivate({ ...channel });
                else status.textContent = `${channel.name}: choose a listing.`;
              });
              label.className = 'gx-timeline-channel';
              label.title = channel.name;
              channelCard(label, channel);
              const track = doc.createElement('div');
              track.className = 'gx-timeline-track';
              row.append(label, track);
              content.append(row);
              const programs = (page?.programs ?? []).filter(
                (p) => cellBounds(p.startMs, p.stopMs, anchor) !== null,
              );
              count += programs.length;
              if (count > MAX_CELLS) throw new Error('Guide visible cell limit.');
              for (const group of clusterListings(programs, anchor, track.clientWidth)) {
                const first = group[0]!,
                  bounds = cellBounds(first.startMs, first.stopMs, anchor)!;
                const end = Math.max(...group.map((p) => p.stopMs ?? p.startMs));
                const right = Math.min(anchor + WINDOW, end);
                // Overlapping listings show the first title and how many more,
                // never a bare count: the row stays readable.
                const more = group.length - 1;
                const cell = button(
                  group.length === 1
                    ? `${first.title}${first.stopMs === null ? ' · end unknown' : ''}`
                    : `${first.title} +${more}`,
                  () => {
                    if (!valid() || !currentChannel(channel)) return;
                    selectCell(cell);
                    if (group.length === 1)
                      void launch(showDetail(channel, first, cell, revision, mine)).catch(report);
                    else showChooser(channel, group, cell, revision, mine);
                  },
                );
                cell.className = 'gx-timeline-cell';
                cell.dataset.programKey = timelineProgramKey(first);
                cell.setAttribute('aria-pressed', 'false');
                const listingLabel = doc.createElement('span');
                listingLabel.className = 'gx-timeline-cell-label';
                listingLabel.textContent = cell.textContent;
                cell.replaceChildren(listingLabel);
                if (more)
                  cell.setAttribute(
                    'aria-label',
                    `${first.title} and ${more} more ${more === 1 ? 'listing' : 'listings'}`,
                  );
                const left = Math.min(bounds.left, Math.max(0, 100 - 4400 / track.clientWidth));
                const width = Math.min(
                  100 - left,
                  Math.max(
                    4400 / track.clientWidth,
                    bounds.width,
                    ((right - Math.max(anchor, first.startMs)) / WINDOW) * 100,
                  ),
                );
                cell.style.left = `${left}%`;
                cell.style.width = `${width}%`;
                cell.title = group
                  .map(
                    (p) =>
                      `${p.title} · ${host.formatTime(p.startMs)}${p.stopMs === null ? ' · end unknown' : ` – ${host.formatTime(p.stopMs)}`}`,
                  )
                  .join('\n');
                if (group.length > 1) cell.classList.add('gx-timeline-conflict');
                if (group.some(programMatches)) cell.classList.add('gx-timeline-match');
                if (
                  group.length === 1 &&
                  first.stopMs !== null &&
                  first.startMs <= host.now() &&
                  host.now() < first.stopMs
                )
                  cell.classList.add('gx-timeline-current');
                track.append(cell);
              }
              if (!programs.length || page?.nextCursor) {
                const note = doc.createElement('span');
                note.className = 'gx-timeline-note';
                note.textContent = page?.nextCursor
                  ? 'More listings available'
                  : channel.guideSourceId && channel.xmltvChannelId
                    ? 'No listings for this time'
                    : 'Guide not linked';
                label.setAttribute('aria-label', `${channel.name} · ${note.textContent}`);
                const openScheduleDetails = (event: Event) => {
                  event.preventDefault();
                  if (valid() && currentChannel(channel))
                    void launch(showEmptyDetail(channel, label, revision, mine, anchor)).catch(
                      report,
                    );
                };
                label.addEventListener('contextmenu', openScheduleDetails);
                label.addEventListener('keydown', (event) => {
                  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10'))
                    openScheduleDetails(event);
                });
                track.append(note);
              }
              content.append(row);
            }
            if (valid()) {
              status.textContent = readyStatus;
              status.dataset.state = 'ready';
              if (channels.length) {
                const line = doc.createElement('div');
                line.className = 'gx-timeline-now';
                content.append(line);
              }
              restoreRowFocus();
              visibleArtwork();
              clock();
            }
          } finally {
            // The job owns every read it started: nothing new starts, and
            // suspension or the next refresh waits for the ones in flight.
            stopped = true;
            await Promise.allSettled(pages);
          }
        })();
        try {
          await launch(job);
        } catch (error) {
          if (abort.signal.aborted && !aborted(error)) {
            cleanupError = error;
            throw error;
          }
          if (valid()) {
            if (host.listedChannels) {
              listedCache = null;
              content.replaceChildren();
              content.style.height = '0px';
              agendaHeader.hidden = true;
              host.listedCount?.(null, anchor, anchor + WINDOW, true);
            }
            report();
          }
        }
      }
    })();
    const settled = task.finally(() => {
      if (active === settled) active = null;
    });
    active = settled;
    return settled;
  }
  function showChooser(
    channel: TimelineChannel,
    programs: MappedProgram[],
    cell: HTMLButtonElement,
    revision: string,
    mine: number,
  ) {
    closeDetails();
    returnFocus = cell;
    details.hidden = false;
    root.classList.add('gx-timeline-has-details');
    const heading = doc.createElement('strong');
    heading.textContent = 'Choose a listing';
    const exit = button('Back to timeline', () => closeDetails());
    const list = doc.createElement('div');
    list.className = 'gx-timeline-choices';
    for (const program of programs) {
      list.append(
        button(
          `${program.title} · ${host.formatTime(program.startMs)}${program.categories?.length ? ` · ${program.categories.map((c) => c.text).join(' · ')}` : ''}`,
          () => {
            void launch(showDetail(channel, program, cell, revision, mine)).catch(report);
          },
        ),
      );
    }
    details.append(exit, heading, list);
    exit.focus();
  }
  async function confirmed(
    channel: TimelineChannel,
    program: MappedProgram,
    revision: string,
    signal: AbortSignal,
    requireCurrent = true,
  ): Promise<boolean> {
    if (
      !host.summary ||
      (!requireCurrent && channel.guideRevision === undefined) ||
      !currentChannel(channel) ||
      host.catalogRevision() !== revision ||
      signal.aborted
    )
      return false;
    const atMs = host.now(),
      summary = await host.summary(channel, atMs, signal);
    return (
      !signal.aborted &&
      currentChannel(channel) &&
      host.catalogRevision() === revision &&
      summary.catalogRevision === revision &&
      summary.atMs === atMs &&
      summary.appChannelId === channel.id &&
      summary.catalogSourceId === channel.sourceId &&
      summary.mappingStatus === 'mapped' &&
      summary.mapping?.guideSourceId === channel.guideSourceId &&
      summary.mapping.catalogSourceId === channel.sourceId &&
      summary.mapping.appChannelId === channel.id &&
      summary.mapping.xmltvChannelId === channel.xmltvChannelId &&
      summary.cacheStatus === 'current' &&
      (channel.guideRevision === undefined || summary.sourceRevision === channel.guideRevision) &&
      (!requireCurrent ||
        (summary.currentStatus === 'current' &&
          summary.current?.title === program.title &&
          summary.current.startMs === program.startMs &&
          summary.current.stopMs === program.stopMs &&
          program.stopMs !== null &&
          host.now() >= program.startMs &&
          host.now() < program.stopMs))
    );
  }
  async function showEmptyDetail(
    channel: TimelineChannel,
    cell: HTMLButtonElement,
    revision: string,
    mine: number,
    anchor: number,
  ) {
    channel = { ...channel };
    closeDetails();
    returnFocus = cell;
    const version = ++detailVersion,
      abort = new AbortController();
    detailController = abort;
    const valid = () =>
      !closed &&
      foreground &&
      !abort.signal.aborted &&
      generation === mine &&
      version === detailVersion &&
      host.catalogRevision() === revision &&
      currentChannel(channel);
    details.hidden = false;
    root.classList.add('gx-timeline-has-details');
    details.replaceChildren();
    const exit = button('Back to timeline', () => closeDetails());
    const title = doc.createElement('strong');
    title.textContent = channel.name;
    title.className = 'gx-timeline-detail-title';
    const timing = doc.createElement('p');
    timing.textContent = `${host.formatTime(anchor)} – ${host.formatTime(anchor + WINDOW)}`;
    const state = doc.createElement('p');
    state.textContent =
      channel.guideSourceId && channel.xmltvChannelId
        ? 'No listings in this window. Checking saved schedule…'
        : 'No program guide connected. You can still watch this channel.';
    const coverage = doc.createElement('p');
    coverage.className = 'gx-timeline-channel-coverage';
    coverage.textContent =
      'Schedule coverage not assessed. Schedule information does not confirm stream availability.';
    details.append(exit, title, timing, state, coverage);
    addWeekCoverage(channel, abort, valid);
    const watch = host.channelActivate
      ? button('Watch channel', () => {
          if (valid()) host.channelActivate!({ ...channel });
        })
      : null;
    if (watch) details.append(watch);
    exit.focus();
    try {
      if (host.summary) {
        const atMs = host.now(),
          summary = await host.summary(channel, atMs, abort.signal);
        if (!valid()) return;
        if (
          summary.catalogSourceId !== channel.sourceId ||
          summary.appChannelId !== channel.id ||
          summary.atMs !== atMs ||
          summary.catalogRevision !== revision
        )
          throw new Error('Guide scope mismatch.');
        if (summary.mappingStatus === 'channel-unavailable') {
          if (watch) watch.disabled = true;
          state.textContent = 'Channel is no longer available. Return to Guide to refresh.';
          return;
        }
        state.textContent = describeGuideAvailability(summary);
        if (
          summary.mappingStatus === 'mapped' &&
          (summary.mapping?.guideSourceId !== channel.guideSourceId ||
            summary.mapping.xmltvChannelId !== channel.xmltvChannelId ||
            summary.sourceRevision !== channel.guideRevision ||
            summary.publishedRevision !== channel.guideRevision)
        )
          throw new Error('Guide mapping changed.');
      }
      if (
        host.channelCoverage &&
        channel.guideSourceId &&
        channel.xmltvChannelId &&
        channel.guideRevision !== undefined
      ) {
        const query: ChannelCoverageRequest = {
          schemaVersion: 1,
          sourceId: channel.guideSourceId,
          xmltvChannelId: channel.xmltvChannelId,
          startMs: anchor,
          endMs: anchor + WINDOW,
          expectedSourceRevision: channel.guideRevision,
          expectedPublishedRevision: channel.guideRevision,
        };
        const assessment = validateChannelCoverageReply(
          await host.channelCoverage(query, abort.signal),
          query,
        );
        if (!valid()) return;
        coverage.textContent = describeChannelCoverage(assessment, (instant) =>
          host.formatTime(instant),
        );
      }
    } catch (error) {
      if (
        error instanceof ChannelCoverageCleanupError ||
        (abort.signal.aborted && !aborted(error))
      ) {
        cleanupError = error;
        throw error;
      }
      if (!valid()) return;
      state.textContent =
        'Schedule details could not be checked. Saved listings are retained; refresh Guide or review the mapping.';
    }
    if (valid() && host.mapChannel)
      details.append(
        button('Map guide', () => {
          if (!valid()) return;
          const selected = { ...channel };
          closeDetails();
          void launch(
            Promise.resolve().then(() => {
              if (
                closed ||
                !foreground ||
                generation !== mine ||
                detailVersion !== version + 1 ||
                host.catalogRevision() !== revision ||
                !currentChannel(selected)
              )
                return;
              return host.mapChannel!(selected);
            }),
          ).catch(report);
        }),
      );
  }
  async function showDetail(
    channel: TimelineChannel,
    program: MappedProgram,
    cell: HTMLButtonElement,
    revision: string,
    mine: number,
  ) {
    channel = { ...channel };
    closeDetails();
    returnFocus = cell;
    const version = ++detailVersion,
      abort = new AbortController();
    detailController = abort;
    const valid = () =>
      !closed &&
      foreground &&
      !abort.signal.aborted &&
      generation === mine &&
      version === detailVersion &&
      host.catalogRevision() === revision &&
      currentChannel(channel);
    details.hidden = false;
    root.classList.add('gx-timeline-has-details');
    details.replaceChildren();
    const exit = button('Back to timeline', () => closeDetails());
    const title = doc.createElement('strong');
    title.textContent = program.title;
    title.className = 'gx-timeline-detail-title';
    const channelName = doc.createElement('span');
    channelName.className = 'gx-timeline-detail-channel';
    channelName.textContent = channel.name;
    const timing = doc.createElement('p');
    timing.textContent = `${host.formatTime(program.startMs)} · ${program.stopMs === null ? 'End unknown' : host.formatTime(program.stopMs)}`;
    const scheduled = doc.createElement('p');
    scheduled.className = 'gx-timeline-countdown';
    scheduled.textContent = 'Checking schedule…';
    const description = doc.createElement('p');
    description.textContent = program.description ?? 'Description unavailable';
    const categories = doc.createElement('p');
    categories.textContent = validateGuideCategories(program.categories)
      .map((c) => c.text)
      .join(' · ');
    const coverage = doc.createElement('p');
    coverage.className = 'gx-timeline-channel-coverage';
    coverage.textContent =
      'Channel schedule coverage not assessed. Listings do not confirm stream availability.';
    details.append(exit, channelName, title, timing, scheduled, description, categories, coverage);
    addWeekCoverage(channel, abort, valid);
    exit.focus();
    const current =
      program.stopMs !== null && host.now() >= program.startMs && host.now() < program.stopMs;
    try {
      if (
        host.channelCoverage &&
        channel.guideSourceId &&
        channel.xmltvChannelId &&
        channel.guideRevision !== undefined
      ) {
        const query: ChannelCoverageRequest = {
          schemaVersion: 1,
          sourceId: channel.guideSourceId,
          xmltvChannelId: channel.xmltvChannelId,
          startMs: from,
          endMs: from + WINDOW,
          expectedSourceRevision: channel.guideRevision,
          expectedPublishedRevision: channel.guideRevision,
        };
        let assessment: ChannelCoverageReply | null = null;
        try {
          assessment = validateChannelCoverageReply(
            await host.channelCoverage(query, abort.signal),
            query,
          );
        } catch (error) {
          if (error instanceof ChannelCoverageCleanupError) throw error;
        }
        if (!valid()) return;
        if (assessment) coverage.textContent = describeChannelCoverage(assessment, host.formatTime);
      }
      if (!valid()) return;
      if (!(await confirmed(channel, program, revision, abort.signal, current)) || !valid()) {
        if (valid()) {
          scheduled.textContent = 'Schedule may have changed. Open the listing again to check.';
          if (current) timing.append(' · Current listing not confirmed');
        }
        return;
      }
      countdown = { node: scheduled, program: { ...program }, valid };
      clock();
      if (!current) return;
      const watch = button('Watch current channel', () => {
        if (!valid() || watch.disabled) return;
        watch.disabled = true;
        const job = (async () => {
          if (!(await confirmed(channel, program, revision, abort.signal)) || !valid()) return;
          await host.watch({ ...channel }, abort.signal);
        })();
        void launch(job)
          .catch((error: unknown) => {
            if (abort.signal.aborted && !aborted(error)) cleanupError = error;
            if (valid()) timing.textContent = 'Channel could not be opened.';
          })
          .finally(() => {
            if (valid() && host.now() < program.stopMs!) watch.disabled = false;
          });
      });
      watch.dataset.stop = String(program.stopMs);
      details.append(watch);
    } catch (error) {
      if (
        error instanceof ChannelCoverageCleanupError ||
        (abort.signal.aborted && !aborted(error))
      ) {
        cleanupError = error;
        throw error;
      }
      if (valid()) {
        scheduled.textContent = 'Schedule could not be checked.';
        timing.append(' · Current status unavailable');
      }
    }
  }
  const scroll = () => {
    visibleArtwork();
    if (!agendaMode && !renderedCovers()) void refresh().catch(report);
  };
  viewport.addEventListener('scroll', scroll);
  const key = (event: KeyboardEvent) => {
    // The toolbar is one ordered row for a remote: disabled buttons and the
    // date label must not send Left/Right down into the grid.
    // From the search field, Left/Right leave only at the edge of the text.
    const searchEdge =
      event.target === searchBox &&
      (event.key === 'ArrowLeft'
        ? searchBox.selectionStart === 0 && searchBox.selectionEnd === 0
        : searchBox.selectionStart === searchBox.value.length);
    if (
      !event.defaultPrevented &&
      (event.target instanceof HTMLButtonElement || searchEdge) &&
      toolbar.contains(event.target as Node) &&
      ['ArrowLeft', 'ArrowRight'].includes(event.key)
    ) {
      const controls = [
        ...toolbar.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button, input'),
      ].filter((control) => !control.disabled && control.getClientRects().length > 0);
      const index = controls.indexOf(event.target as HTMLButtonElement);
      const next = controls[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (index >= 0 && next) {
        event.preventDefault();
        event.stopPropagation();
        // The search field arrives in navigation mode (keyboard waits for OK).
        prepareRemoteFocus(next);
        next.focus({ preventScroll: true });
        return;
      }
    }
    if (!agendaMode && !event.defaultPrevented) {
      const target = event.target;
      const row =
        target instanceof HTMLElement ? target.closest<HTMLElement>('.gx-timeline-row') : null;
      if (target === viewport && ['ArrowDown', 'ArrowRight', 'Enter'].includes(event.key)) {
        const first = content.querySelector<HTMLButtonElement>('.gx-timeline-channel');
        if (first) {
          event.preventDefault();
          event.stopPropagation();
          first.focus({ preventScroll: true });
          return;
        }
      }
      if (row && content.contains(row) && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
        const controls = [...row.querySelectorAll<HTMLButtonElement>('button')];
        const index = controls.indexOf(target as HTMLButtonElement);
        const next = controls[index + (event.key === 'ArrowRight' ? 1 : -1)];
        event.preventDefault();
        event.stopPropagation();
        next?.focus({ preventScroll: true });
        return;
      }
      if (
        renderedStart === 0 &&
        row === content.querySelector('.gx-timeline-row') &&
        target instanceof HTMLElement &&
        event.key === 'ArrowUp'
      ) {
        const origin = target.getBoundingClientRect();
        const header =
          [...toolbar.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
            .filter((button) => button.getClientRects().length > 0)
            .sort((a, b) => {
              const centre = (r: DOMRect) =>
                Math.abs(r.x + r.width / 2 - (origin.x + origin.width / 2));
              return centre(a.getBoundingClientRect()) - centre(b.getBoundingClientRect());
            })[0] ?? null;
        if (header) {
          event.preventDefault();
          event.stopPropagation();
          header.focus({ preventScroll: true });
          return;
        }
      }
    }

    if (
      agendaMode &&
      active &&
      event.target === viewport &&
      ['ArrowDown', 'ArrowUp'].includes(event.key)
    ) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (
      agendaMode &&
      !event.defaultPrevented &&
      ['ArrowDown', 'ArrowUp'].includes(event.key) &&
      event.target instanceof HTMLElement &&
      content.contains(event.target)
    ) {
      const controls = [...content.querySelectorAll<HTMLButtonElement>('button')],
        index = controls.indexOf(event.target as HTMLButtonElement);
      if (index >= 0) {
        event.preventDefault();
        event.stopPropagation();
        const next = controls[index + (event.key === 'ArrowDown' ? 1 : -1)];
        const target = next ?? (event.key === 'ArrowUp' ? browseChannel : controls[index]);
        target?.focus({ preventScroll: true });
        target?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
        return;
      }
    }

    if (!event.defaultPrevented && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const target = event.target;
      const row =
        target instanceof HTMLElement ? target.closest<HTMLElement>('.gx-timeline-row') : null;
      const pendingFocus = target === viewport && active ? rowFocus : null;
      if ((row && content.contains(row)) || pendingFocus) {
        const channels = visibleChannels();
        const index = channels.findIndex(
          (c) => channelKey(c) === (row?.dataset.channelKey ?? pendingFocus!.key),
        );
        const nextIndex = index + (event.key === 'ArrowDown' ? 1 : -1);
        if (index >= 0 && nextIndex >= 0 && nextIndex < channels.length) {
          event.preventDefault();
          event.stopPropagation();
          const column = row
            ? [...row.querySelectorAll('button')].indexOf(target as HTMLButtonElement)
            : pendingFocus!.column;
          const desired = { key: channelKey(channels[nextIndex]!), column };
          const nextRow = [...content.querySelectorAll<HTMLElement>('.gx-timeline-row')].find(
            (r) => r.dataset.channelKey === desired.key,
          );
          const controls = nextRow?.querySelectorAll<HTMLButtonElement>('button');
          if (controls?.length) {
            controls[Math.min(Math.max(0, column), controls.length - 1)]!.focus({
              preventScroll: true,
            });
          }
          const top = nextIndex * rowHeight;
          if (top < viewport.scrollTop) viewport.scrollTop = top;
          else if (top + rowHeight > viewport.scrollTop + viewport.clientHeight)
            viewport.scrollTop = top + rowHeight - viewport.clientHeight;
          rowFocus = desired;
          if (!nextRow || !renderedCovers()) {
            // Capture explicitly requested identity after invalidate captures the old row.
            const pending = refresh();
            rowFocus = desired;
            void pending.catch(report);
          }
          return;
        }
      }
    }
    if (event.key === 'Escape' && closeDetails()) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  root.addEventListener('keydown', key);
  const resize = new ResizeObserver(() => {
    clock();
    if (
      !closed &&
      foreground &&
      (measuredRowHeight() !== rowHeight ||
        root.clientWidth <= agendaLimit() !== agendaMode ||
        (!agendaMode &&
          details.hidden &&
          status.dataset.state === 'ready' &&
          viewport.clientHeight > 0 &&
          viewport.clientHeight !== renderedViewportHeight))
    ) {
      const focused = doc.activeElement;
      const row =
        focused instanceof HTMLElement ? focused.closest<HTMLElement>('.gx-timeline-row') : null;
      if (row && content.contains(row) && viewport.clientHeight > 0) {
        const index = visibleChannels().findIndex(
          (channel) => channelKey(channel) === row.dataset.channelKey,
        );
        if (index >= 0) {
          const top = index * measuredRowHeight();
          if (top < viewport.scrollTop) viewport.scrollTop = top;
          else if (top + measuredRowHeight() > viewport.scrollTop + viewport.clientHeight)
            viewport.scrollTop = top + measuredRowHeight() - viewport.clientHeight;
        }
      }
      void refresh().catch(report);
    }
  });
  resize.observe(root);
  resize.observe(viewport);
  const initial = refresh();
  void initial.catch(report);
  async function suspend() {
    foreground = false;
    refreshWanted = false;
    invalidate();
    clearTimer();
    indexedChannels = null;
    filteredSource = null;
    filteredChannels = [];
    listedCache = null;
    listedSignatureSource = null;
    listedSignature = '';
    channelIndex.clear();
    const logos = Promise.resolve().then(() => host.logos?.suspend());
    const settled = await Promise.allSettled([...(active ? [active] : []), logos]);
    await drain();
    const artwork = settled.at(-1)!;
    if (artwork.status === 'rejected') throw artwork.reason;
  }
  return {
    refresh() {
      listedCache = null;
      return refresh();
    },
    refreshArtwork,
    closeDetails,
    async setForeground(value: boolean) {
      if (!value) return suspend();
      if (closed) return;
      foreground = true;
      // A cache reload may advance the global database revision through another feed.
      agendaCursor = null;
      agendaProgramFocus = null;
      await refresh();
      clock();
    },
    suspend,
    async dispose() {
      closed = true;
      await suspend();
      viewport.removeEventListener('scroll', scroll);
      root.removeEventListener('keydown', key);
      resize.disconnect();
      root.remove();
    },
  };
}

/** Clusters include the touch target width, so short/unknown cells cannot cover a sibling. */
export function clusterListings(
  programs: readonly MappedProgram[],
  from: number,
  trackWidth = 1000,
): MappedProgram[][] {
  const ordered = [...programs].sort(
    (a, b) =>
      a.startMs - b.startMs ||
      a.ordinal - b.ordinal ||
      (timelineProgramKey(a) < timelineProgramKey(b)
        ? -1
        : timelineProgramKey(a) > timelineProgramKey(b)
          ? 1
          : 0),
  );
  const groups: MappedProgram[][] = [];
  let right = -Infinity;
  for (const program of ordered) {
    const bounds = cellBounds(program.startMs, program.stopMs, from);
    if (!bounds) continue;
    const left = (bounds.left / 100) * trackWidth,
      end = left + Math.max(44, (bounds.width / 100) * trackWidth);
    if (groups.length && left < right) groups[groups.length - 1]!.push(program);
    else groups.push([program]);
    right = Math.max(right, end);
  }
  return groups;
}
