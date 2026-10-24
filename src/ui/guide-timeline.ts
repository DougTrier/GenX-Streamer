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

import type { MappedProgram, ProgramPage, ProgramQuery } from '../guide/native';

import { programCountdown } from '../guide/program-countdown';

import { createTimelineKeys } from './guide-timeline-keys';
import { createSharedContext } from '../application/shell/shared-context';
import { createTimelineDetails } from './guide-timeline-details';
import { createTimelineRefresh } from './guide-timeline-refresh';
import { createTimelineChannels } from './guide-timeline-channels';
import {
  type TimelineHost,
  ROW,
  MAX_ROWS,
  GUIDE_ROWS,
  HALF,
  type TimelineChannel,
  type TimelineCategory,
  type ListedCache,
  limitConcurrency,
  channelKey,
  savedChannelKey,
  guideSearchMatches,
  timelineCategoryMatches,
  WINDOW,
  timelineWindowStart,
  aborted,
} from './guide-timeline-model';
export {
  type TimelineChannel,
  type TimelineHost,
  HALF,
  WINDOW,
  WEEK,
  ROW,
  GUIDE_ROWS,
  MAX_ROWS,
  MAX_CELLS,
  PANEL_AGENDA_WIDTH,
  type TimelineCategory,
  guideSearchWords,
  guideSearchMatches,
  timelineCategoryMatches,
  timelineWindowStart,
  cellBounds,
  timelineProgramKey,
  channelKey,
  savedChannelKey,
  aborted,
  type Listed,
  type ListedCache,
  clusterListings,
} from './guide-timeline-model';

/** Foreground-only, bounded cached listings. This component never creates a decoder. */
export function mountGuideTimeline(container: HTMLElement, host: TimelineHost) {
  // What the parts of mountGuideTimeline in other modules share with it: each value
  // is read when a part uses it; the second list holds the ones parts assign.
  const shared = createSharedContext(
    {
      active: () => active,
      addWeekCoverage: () => addWeekCoverage,
      agendaChannel: () => agendaChannel,
      agendaChannelKey: () => agendaChannelKey,
      agendaCompact: () => agendaCompact,
      agendaControlsOpen: () => agendaControlsOpen,
      agendaCursor: () => agendaCursor,
      agendaFocusFirst: () => agendaFocusFirst,
      agendaHeader: () => agendaHeader,
      agendaLimit: () => agendaLimit,
      agendaMode: () => agendaMode,
      agendaProgramFocus: () => agendaProgramFocus,
      agendaRevision: () => agendaRevision,
      agendaScope: () => agendaScope,
      axis: () => axis,
      back: () => back,
      browseChannel: () => browseChannel,
      button: () => button,
      channelCard: () => channelCard,
      channelCards: () => channelCards,
      channelIndex: () => channelIndex,
      cleanupError: () => cleanupError,
      clock: () => clock,
      closed: () => closed,
      closeDetails: () => closeDetails,
      content: () => content,
      controller: () => controller,
      controlsToggle: () => controlsToggle,
      countdown: () => countdown,
      currentChannel: () => currentChannel,
      detailController: () => detailController,
      details: () => details,
      detailVersion: () => detailVersion,
      doc: () => doc,
      drain: () => drain,
      emptyCategoryStatus: () => emptyCategoryStatus,
      foreground: () => foreground,
      from: () => from,
      generation: () => generation,
      host: () => host,
      indexedChannels: () => indexedChannels,
      invalidate: () => invalidate,
      launch: () => launch,
      listedCache: () => listedCache,
      listingScope: () => listingScope,
      measuredRowHeight: () => measuredRowHeight,
      navigationState: () => navigationState,
      next: () => next,
      nextChannel: () => nextChannel,
      nextDay: () => nextDay,
      now: () => now,
      OVERSCAN: () => OVERSCAN,
      previousChannel: () => previousChannel,
      previousDay: () => previousDay,
      programMatches: () => programMatches,
      programPages: () => programPages,
      readLimit: () => readLimit,
      refresh: () => refresh,
      refreshWanted: () => refreshWanted,
      renderedCount: () => renderedCount,
      renderedCovers: () => renderedCovers,
      renderedLimit: () => renderedLimit,
      renderedStart: () => renderedStart,
      renderedTotal: () => renderedTotal,
      renderedViewportHeight: () => renderedViewportHeight,
      report: () => report,
      restoreRowFocus: () => restoreRowFocus,
      returnFocus: () => returnFocus,
      root: () => root,
      rowFocus: () => rowFocus,
      rowHeight: () => rowHeight,
      search: () => search,
      searchBox: () => searchBox,
      selectCell: () => selectCell,
      showChooser: () => showChooser,
      showDetail: () => showDetail,
      showEmptyDetail: () => showEmptyDetail,
      status: () => status,
      times: () => times,
      toolbar: () => toolbar,
      viewport: () => viewport,
      viewportRowLimit: () => viewportRowLimit,
      visibleArtwork: () => visibleArtwork,
      visibleChannels: () => visibleChannels,
      watchChannel: () => watchChannel,
    },
    {
      active: (value: typeof active) => (active = value),
      agendaChannelKey: (value: typeof agendaChannelKey) => (agendaChannelKey = value),
      agendaCompact: (value: typeof agendaCompact) => (agendaCompact = value),
      agendaCursor: (value: typeof agendaCursor) => (agendaCursor = value),
      agendaFocusFirst: (value: typeof agendaFocusFirst) => (agendaFocusFirst = value),
      agendaMode: (value: typeof agendaMode) => (agendaMode = value),
      agendaProgramFocus: (value: typeof agendaProgramFocus) => (agendaProgramFocus = value),
      agendaRevision: (value: typeof agendaRevision) => (agendaRevision = value),
      agendaScope: (value: typeof agendaScope) => (agendaScope = value),
      channelIndex: (value: typeof channelIndex) => (channelIndex = value),
      cleanupError: (value: typeof cleanupError) => (cleanupError = value),
      controller: (value: typeof controller) => (controller = value),
      countdown: (value: typeof countdown) => (countdown = value),
      detailController: (value: typeof detailController) => (detailController = value),
      detailVersion: (value: typeof detailVersion) => (detailVersion = value),
      indexedChannels: (value: typeof indexedChannels) => (indexedChannels = value),
      listedCache: (value: typeof listedCache) => (listedCache = value),
      refreshWanted: (value: typeof refreshWanted) => (refreshWanted = value),
      renderedCount: (value: typeof renderedCount) => (renderedCount = value),
      renderedLimit: (value: typeof renderedLimit) => (renderedLimit = value),
      renderedStart: (value: typeof renderedStart) => (renderedStart = value),
      renderedTotal: (value: typeof renderedTotal) => (renderedTotal = value),
      renderedViewportHeight: (value: typeof renderedViewportHeight) =>
        (renderedViewportHeight = value),
      returnFocus: (value: typeof returnFocus) => (returnFocus = value),
      rowFocus: (value: typeof rowFocus) => (rowFocus = value),
      rowHeight: (value: typeof rowHeight) => (rowHeight = value),
    },
  );
  const timelineRefresh = createTimelineRefresh(shared);
  const { refresh } = timelineRefresh;
  const timelineDetails = createTimelineDetails(shared);
  const { showDetail, showEmptyDetail, showChooser } = timelineDetails;

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
  const timelineChannels = createTimelineChannels(shared);
  const { addWeekCoverage, channelCard, currentChannel, visibleArtwork, refreshArtwork } =
    timelineChannels;
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
  const scroll = () => {
    visibleArtwork();
    if (!agendaMode && !renderedCovers()) void refresh().catch(report);
  };
  viewport.addEventListener('scroll', scroll);
  const timelineKeys = createTimelineKeys(shared);
  const { resize, key } = timelineKeys;
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
