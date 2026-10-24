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

import { mountSeriesSuggestions, type SeriesLookup } from './archive-series-suggestions';
import { mountArchiveDownloads } from './archive-downloads';

import type { ArchiveDownloads } from '../application/archive-downloads';
import type { ArchiveDownloadEntry } from '../platform/archive-downloads';

import {
  createArchiveCatalog,
  type ArchiveArtworkRequest,
  type ArchiveArtworkResponse,
  type ArchiveTitle,
  type ArchivePage,
  type ArchiveFilesPage,
  type ArchiveSelection,
  type ArchiveQuery,
  type ArchiveFavoriteReceipt,
  type ArchiveFileProgress,
  type ArchiveFileProgressPage,
  type ArchiveItemFilesReceipt,
  type ArchiveRemovalTarget,
  type ArchiveRemovalReceipt,
  type ArchiveLanguageMode,
  type ArchiveDiscoveryView,
} from '../platform/archive-catalog';

import './archive-search.css';
import { createArchiveSearchApi } from './archive-search-api';
import { createSharedContext } from '../application/shared-context';
import { createArchiveSearchNavigation } from './archive-search-navigation';
import { createArchiveSearchActions } from './archive-search-actions';
import { createArchiveSearchRender } from './archive-search-render';
import { createArchiveSearchRemoval } from './archive-search-removal';
import { createArchiveSearchArtwork } from './archive-search-artwork';
import { type ArtworkJob } from './archive-search-artwork';

export interface ArchiveSearchHost {
  /** Independent retained download owner; browsing suspension never cancels its transfer. */
  downloads?: ArchiveDownloads;
  onPlaySaved?(
    entry: ArchiveDownloadEntry,
    downloadRevision: string,
    signal: AbortSignal,
  ): Promise<void>;

  input: HTMLInputElement;

  catalog?: Pick<ReturnType<typeof createArchiveCatalog>, 'query' | 'files'>;

  /** Null means inactive/not ready; captured identity must remain exact through completion. */

  readyScope(): string | null;

  onSelect(selection: ArchiveSelection, signal: AbortSignal): Promise<void>;

  managementContainer?: HTMLElement;
  detailsContainer?: HTMLElement;
  playbackActive?(): boolean;
  onTitleSelected?(): void;
  artwork?(
    request: ArchiveArtworkRequest,
    signal: AbortSignal,
  ): Promise<ArchiveArtworkResponse | null>;

  onRemove?(
    target: ArchiveRemovalTarget,
    expectedRevision: string,
    signal: AbortSignal,
  ): Promise<ArchiveRemovalReceipt>;

  queryOptions?(): Pick<ArchiveQuery, 'decade' | 'favoritesOnly' | 'contentType'>;

  /** Optional show identity suggestions for an explicit online Search. */
  seriesLookup?: SeriesLookup;

  /** Explicit action only; host dispatches its owned filter transition, preserving Favorites. */
  clearFilters?(): void;

  onFavorite?(
    title: ArchiveTitle,

    expectedRevision: string,

    value: boolean,

    signal: AbortSignal,
  ): Promise<ArchiveFavoriteReceipt>;

  pendingFiles?(
    expectedRevision: string,

    offset: number,

    query: string,

    signal: AbortSignal,
    languageMode?: ArchiveLanguageMode,
    contentType?: ArchiveQuery['contentType'],
  ): Promise<ArchiveFileProgressPage>;

  loadFiles?(
    progress: ArchiveFileProgress,

    expectedRevision: string,

    signal: AbortSignal,
  ): Promise<ArchiveItemFilesReceipt>;

  /** Explicit magnifier action only. Host owns bounded native discovery/continuation. */

  discover?(
    query: string,

    signal: AbortSignal,

    intent?: 'search' | 'continue',
    view?: ArchiveDiscoveryView,
  ): Promise<{ revision: string; outcome?: string; examined?: number; admitted?: number }>;
}

/** Separate on-demand mode. Reuses the host input and never opens a modal or changes its query after selection. */

export function mountArchiveSearch(container: HTMLElement, host: ArchiveSearchHost) {
  // What the parts of mountArchiveSearch in other modules share with it: each value
  // is read when a part uses it; the second list holds the ones parts assign.
  const shared = createSharedContext(
    {
      abort: () => abort,
      activeOnlineSearch: () => activeOnlineSearch,
      appendSavedTitles: () => appendSavedTitles,
      artworkActive: () => artworkActive,
      artworkBindings: () => artworkBindings,
      artworkBytes: () => artworkBytes,
      artworkCache: () => artworkCache,
      artworkContext: () => artworkContext,
      artworkEpoch: () => artworkEpoch,
      artworkJoin: () => artworkJoin,
      artworkNodes: () => artworkNodes,
      artworkObserver: () => artworkObserver,
      artworkQueue: () => artworkQueue,
      artworkVisible: () => artworkVisible,
      browseOptions: () => browseOptions,
      button: () => button,
      cancel: () => cancel,
      cancelWork: () => cancelWork,
      catalog: () => catalog,
      choose: () => choose,
      cleanupFailed: () => cleanupFailed,
      clearFilters: () => clearFilters,
      closed: () => closed,
      confirmation: () => confirmation,
      continuationContext: () => continuationContext,
      continuationKey: () => continuationKey,
      controls: () => controls,
      current: () => current,
      detailPane: () => detailPane,
      dismissEpisodes: () => dismissEpisodes,
      dismissFilters: () => dismissFilters,
      disposePromise: () => disposePromise,
      doc: () => doc,
      downloadsView: () => downloadsView,
      duration: () => duration,
      enabled: () => enabled,
      episodesOpen: () => episodesOpen,
      expanded: () => expanded,
      failedTitlePage: () => failedTitlePage,
      favorite: () => favorite,
      favoriteBusy: () => favoriteBusy,
      files: () => files,
      filesAt: () => filesAt,
      fileSize: () => fileSize,
      generation: () => generation,
      hideCancel: () => hideCancel,
      host: () => host,
      isAbort: () => isAbort,
      language: () => language,
      list: () => list,
      loadingTitles: () => loadingTitles,
      loadPendingFiles: () => loadPendingFiles,
      management: () => management,
      managementActions: () => managementActions,
      managementStatus: () => managementStatus,
      observeArtwork: () => observeArtwork,
      onlineSearchIntent: () => onlineSearchIntent,
      page: () => page,
      paging: () => paging,
      pending: () => pending,
      pendingContent: () => pendingContent,
      pendingPage: () => pendingPage,
      pendingSummary: () => pendingSummary,
      position: () => position,
      queryAt: () => queryAt,
      readArtwork: () => readArtwork,
      releaseArtworkBinding: () => releaseArtworkBinding,
      removalBusy: () => removalBusy,
      removalControls: () => removalControls,
      render: () => render,
      renderedOptions: () => renderedOptions,
      restoreFocus: () => restoreFocus,
      resultSummary: () => resultSummary,
      revealResultTitle: () => revealResultTitle,
      revision: () => revision,
      root: () => root,
      run: () => run,
      savedQuery: () => savedQuery,
      selectedFocus: () => selectedFocus,
      selecting: () => selecting,
      selectionAbort: () => selectionAbort,
      selectionIdentity: () => selectionIdentity,
      series: () => series,
      status: () => status,
      syncArtworkContext: () => syncArtworkContext,
      syncDetailsHost: () => syncDetailsHost,
      tail: () => tail,
      titleLimit: () => titleLimit,
    },
    {
      abort: (value: typeof abort) => (abort = value),
      activeOnlineSearch: (value: typeof activeOnlineSearch) => (activeOnlineSearch = value),
      artworkBytes: (value: typeof artworkBytes) => (artworkBytes = value),
      artworkContext: (value: typeof artworkContext) => (artworkContext = value),
      artworkEpoch: (value: typeof artworkEpoch) => (artworkEpoch = value),
      artworkJoin: (value: typeof artworkJoin) => (artworkJoin = value),
      cleanupFailed: (value: typeof cleanupFailed) => (cleanupFailed = value),
      closed: (value: typeof closed) => (closed = value),
      confirmation: (value: typeof confirmation) => (confirmation = value),
      continuationContext: (value: typeof continuationContext) => (continuationContext = value),
      disposePromise: (value: typeof disposePromise) => (disposePromise = value),
      enabled: (value: typeof enabled) => (enabled = value),
      episodesOpen: (value: typeof episodesOpen) => (episodesOpen = value),
      expanded: (value: typeof expanded) => (expanded = value),
      failedTitlePage: (value: typeof failedTitlePage) => (failedTitlePage = value),
      favoriteBusy: (value: typeof favoriteBusy) => (favoriteBusy = value),
      files: (value: typeof files) => (files = value),
      generation: (value: typeof generation) => (generation = value),
      loadingTitles: (value: typeof loadingTitles) => (loadingTitles = value),
      onlineSearchIntent: (value: typeof onlineSearchIntent) => (onlineSearchIntent = value),
      page: (value: typeof page) => (page = value),
      pendingPage: (value: typeof pendingPage) => (pendingPage = value),
      removalBusy: (value: typeof removalBusy) => (removalBusy = value),
      renderedOptions: (value: typeof renderedOptions) => (renderedOptions = value),
      revision: (value: typeof revision) => (revision = value),
      savedQuery: (value: typeof savedQuery) => (savedQuery = value),
      selecting: (value: typeof selecting) => (selecting = value),
      selectionAbort: (value: typeof selectionAbort) => (selectionAbort = value),
      selectionIdentity: (value: typeof selectionIdentity) => (selectionIdentity = value),
      tail: (value: typeof tail) => (tail = value),
    },
  );
  const archiveSearchRemoval = createArchiveSearchRemoval(shared);
  const { removalControls } = archiveSearchRemoval;
  const archiveSearchRender = createArchiveSearchRender(shared);
  const { render } = archiveSearchRender;
  const archiveSearchActions = createArchiveSearchActions(shared);
  const { appendSavedTitles, queryAt, run, filesAt, favorite, choose, loadPendingFiles } =
    archiveSearchActions;

  const doc = container.ownerDocument;

  const catalog = host.catalog ?? createArchiveCatalog();
  const readArtwork =
    host.artwork ??
    (!host.catalog ? (catalog as ReturnType<typeof createArchiveCatalog>).artwork : undefined);

  const root = doc.createElement('section');

  root.className = 'gx-archive-search';

  root.setAttribute('aria-label', 'GenXtra shows and movies');

  root.hidden = true;

  const heading = doc.createElement('h2');

  heading.textContent = 'GenXtra';

  const language = doc.createElement('select');
  language.id = 'genxtra-language';
  language.className = 'gx-archive-language';
  language.setAttribute('aria-label', 'Browse video languages');
  language.title =
    'Filters use source metadata, not verified audio. Search looks online across languages.';
  for (const [value, label] of [
    ['english-first', 'English first'],
    ['all', 'All languages'],
    ['english', 'English listed'],
    ['unlisted', 'Language not listed'],
  ]) {
    const option = doc.createElement('option');
    option.value = value!;
    option.textContent = label!;
    language.append(option);
  }
  const baseQueryOptions = host.queryOptions;
  const browseOptions = () => ({
    ...baseQueryOptions?.(),
    languageMode: language.value as ArchiveLanguageMode,
  });

  const status = doc.createElement('p');

  status.className = 'gx-archive-status';

  status.setAttribute('role', 'status');

  status.setAttribute('aria-live', 'polite');
  status.dataset.passive = 'false';

  const resultSummary = doc.createElement('p');
  resultSummary.className = 'gx-archive-result-summary';

  const list = doc.createElement('div');

  list.className = 'gx-archive-results';
  list.setAttribute('aria-busy', 'false');

  const paging = doc.createElement('nav');

  paging.className = 'gx-archive-result-footer';

  paging.setAttribute('aria-label', 'Archive title pages');
  const footer = doc.createElement('div');
  footer.className = 'gx-archive-footer-band';
  footer.append(paging);

  const position = doc.createElement('span');

  const cancel = doc.createElement('button');

  cancel.type = 'button';

  cancel.textContent = 'Cancel request';

  cancel.hidden = true;

  const tools = doc.createElement('div');
  tools.className = 'gx-archive-tools';
  const filters = doc.createElement('details');
  filters.className = 'gx-archive-filter-options';
  const filtersToggle = doc.createElement('summary');
  filtersToggle.className = 'gx-archive-filter-toggle';
  filtersToggle.textContent = 'Filters';
  filtersToggle.setAttribute('aria-controls', 'genxtra-language-options');
  filtersToggle.setAttribute('aria-expanded', 'false');
  const filtersPanel = doc.createElement('div');
  filtersPanel.id = 'genxtra-language-options';
  filtersPanel.className = 'gx-archive-filter-panel';
  const languageLabel = doc.createElement('label');
  languageLabel.htmlFor = language.id;
  languageLabel.textContent = 'Language';
  const languageHelp = doc.createElement('p');
  languageHelp.textContent = 'Source metadata, not verified audio. Search looks across languages.';
  filtersPanel.append(languageLabel, language, languageHelp);
  filters.append(filtersToggle, filtersPanel);
  tools.append(resultSummary);
  const clearFilters = doc.createElement('button');
  clearFilters.type = 'button';
  clearFilters.textContent = 'Clear filters';
  clearFilters.setAttribute('aria-label', 'Clear GenXtra filters and keep Favorites');
  clearFilters.hidden = true;
  const series = host.seriesLookup
    ? mountSeriesSuggestions(doc, {
        lookup: host.seriesLookup,
        choose: (title) => {
          host.input.value = title;
          host.input.dispatchEvent(new Event('input', { bubbles: true }));
          void api.searchOnline().catch(() => undefined);
        },
      })
    : null;
  root.append(heading, tools, status, clearFilters, cancel);
  if (series) root.append(series.element);
  root.append(list, footer);

  container.append(root);
  const downloadsView =
    host.downloads && host.onPlaySaved
      ? mountArchiveDownloads(footer, {
          downloads: host.downloads,
          play: host.onPlaySaved,
          compactSummary: true,
          emptyFocusTarget: () => footerReturnTarget(),
        })
      : null;

  const detailPane = doc.createElement('section');
  detailPane.className = 'gx-archive-detail-pane';
  detailPane.id = 'genxtra-title-details';
  detailPane.setAttribute('aria-label', 'Selected title details');
  detailPane.hidden = true;
  (host.detailsContainer ?? root).append(detailPane);
  const syncDetailsHost = () => {
    const active = String(host.playbackActive?.() ?? false);
    detailPane.dataset.playbackActive = active;
    if (host.detailsContainer) {
      host.detailsContainer.hidden = detailPane.hidden;
      host.detailsContainer.dataset.playbackActive = active;
    }
  };
  syncDetailsHost();

  let enabled = false,
    closed = false,
    generation = 0;

  let savedQuery = '',
    revision: string | null = null;

  let page: ArchivePage | null = null;
  let loadingTitles = false;
  let failedTitlePage: ArchivePage | null = null;
  // The native catalog contract admits at most 1,400 saved titles (400 curated).
  // Each local read remains at most 50; never fetch the whole catalog eagerly.
  const titleLimit = 1400;

  let expanded: string | null = null;
  let episodesOpen = false;

  let files: ArchiveFilesPage | null = null;

  let abort: AbortController | null = null;

  let tail: Promise<void> = Promise.resolve();

  let selectionAbort: AbortController | null = null;

  let selecting: Promise<void> | null = null;

  let disposePromise: Promise<void> | null = null;

  let cleanupFailed = false;

  let favoriteBusy = false;

  let removalBusy = false;

  let confirmation: string | null = null;

  let selectionIdentity: ArchiveSelection | null = null;

  const management = doc.createElement('details');

  management.className = 'gx-archive-management';

  const managementHeading = doc.createElement('summary');

  managementHeading.textContent = 'GenXtra library';

  const managementHelp = doc.createElement('p');

  managementHelp.textContent =
    'Clear saved GenXtra videos, favorites and search progress. Live TV, accounts and the program guide are preserved.';

  const managementStatus = doc.createElement('p');

  managementStatus.setAttribute('role', 'status');

  const managementActions = doc.createElement('div');

  management.append(managementHeading, managementHelp, managementActions, managementStatus);

  if (host.onRemove) host.managementContainer?.append(management);

  let renderedOptions = '';
  let continuationContext: string | null = null;
  let onlineSearchIntent = 0;
  let activeOnlineSearch: { intent: number; scope: string; query: string } | null = null;
  const continuationKey = () => JSON.stringify([savedQuery.trim(), browseOptions() ?? {}]);

  let pendingPage: ArchiveFileProgressPage | null = null;

  const pending = doc.createElement('details');

  pending.className = 'gx-archive-pending';

  pending.setAttribute('aria-label', 'More to explore');

  pending.hidden = true;

  const pendingSummary = doc.createElement('summary');
  pendingSummary.className = 'gx-archive-pending-summary';
  const pendingContent = doc.createElement('div');
  pendingContent.className = 'gx-archive-pending-content';
  pending.append(pendingSummary, pendingContent);

  footer.insertBefore(pending, paging);

  const controls: Array<{
    node: EventTarget;
    type: string;
    listener: EventListener;
    capture: boolean;
  }> = [];

  const listen = (node: EventTarget, type: string, listener: EventListener, capture = false) => {
    node.addEventListener(type, listener, capture);

    controls.push({ node, type, listener, capture });
  };
  listen(clearFilters, 'click', () => {
    if (closed || !enabled || abort !== null || !host.clearFilters || host.readyScope() === null)
      return;
    language.value = 'all';
    host.clearFilters();
  });
  let footerReturn: { ref: string; scope: string | null } | null = null;
  function footerReturnTarget(): HTMLElement | null {
    const scope = host.readyScope();
    if (!canReturnLocalFocus(scope) || (footerReturn && footerReturn.scope !== scope)) return null;
    const retained =
      footerReturn &&
      Array.from(list.querySelectorAll<HTMLElement>('[data-archive-ref]')).find(
        (node) =>
          node.dataset.archiveRef === footerReturn?.ref &&
          !node.matches(':disabled') &&
          !node.closest('[hidden],[inert]') &&
          node.checkVisibility({ visibilityProperty: true }),
      );
    return (
      retained ||
      (list.querySelector<HTMLElement>('.gx-archive-title-button[aria-current="true"]') ??
        list.querySelector<HTMLElement>('.gx-archive-title-button'))
    );
  }
  listen(footer, 'focusin', (event) => {
    if (
      event instanceof FocusEvent &&
      event.relatedTarget instanceof HTMLElement &&
      list.contains(event.relatedTarget) &&
      event.relatedTarget.dataset.archiveRef
    )
      footerReturn = { ref: event.relatedTarget.dataset.archiveRef, scope: host.readyScope() };
  });
  listen(doc, 'focusin', (event) => {
    if (!(event.target instanceof Node) || footer.contains(event.target)) return;
    // Returning to the list or another control retires our overlays without moving focus.
    for (const disclosure of footer.querySelectorAll<HTMLDetailsElement>('details[open]'))
      disclosure.open = false;
  });
  if (doc.defaultView)
    listen(
      doc.defaultView,
      'native-back-requested',
      (event) => {
        if (event.defaultPrevented || !canReturnLocalFocus(host.readyScope())) return;
        const disclosure = footer.querySelector<HTMLDetailsElement>('details[open]');
        if (!disclosure) return;
        disclosure.open = false;
        disclosure.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true });
        // Main still observes the event and acknowledges the native Back request.
        event.preventDefault();
      },
      true,
    );
  listen(footer, 'keydown', (event) => {
    if (!(event instanceof KeyboardEvent) || event.defaultPrevented) return;
    const source = event.target instanceof HTMLElement ? event.target : null;
    if (!source) return;
    const disclosure = source.closest<HTMLDetailsElement>('details[open]');
    if (
      disclosure &&
      footer.contains(disclosure) &&
      ['Escape', 'BrowserBack'].includes(event.key)
    ) {
      disclosure.open = false;
      disclosure.querySelector<HTMLElement>(':scope > summary')?.focus({ preventScroll: true });
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const topControls = Array.from(
      footer.querySelectorAll<HTMLElement>(
        ':scope > details > summary, :scope > .gx-archive-downloads > details > summary, :scope > .gx-archive-downloads > button',
      ),
    ).filter(
      (node) =>
        !node.matches(':disabled') &&
        !node.closest('[hidden],[inert]') &&
        node.checkVisibility({ visibilityProperty: true }),
    );
    const index = topControls.indexOf(source);
    if (index < 0) return;
    const target =
      event.key === 'ArrowUp'
        ? footerReturnTarget()
        : event.key === 'ArrowLeft'
          ? topControls[index - 1]
          : event.key === 'ArrowRight'
            ? topControls[index + 1]
            : null;
    if (target) {
      event.preventDefault();
      event.stopPropagation();
      target.focus({ preventScroll: true });
      if (list.contains(target)) revealInResultList(target);
    }
  });
  for (const disclosure of footer.querySelectorAll<HTMLDetailsElement>('details')) {
    listen(disclosure, 'toggle', () => {
      if (disclosure.open) {
        for (const other of footer.querySelectorAll<HTMLDetailsElement>('details[open]'))
          if (other !== disclosure) other.open = false;
      }
      disclosure
        .querySelector(':scope > summary')
        ?.setAttribute('aria-expanded', String(disclosure.open));
    });
  }

  const isAbort = (error: unknown) => error instanceof DOMException && error.name === 'AbortError';

  const artworkCache = new Map<string, ArchiveArtworkResponse | null>();
  const artworkQueue = new Map<string, ArtworkJob>();
  const artworkActive = new Map<string, ArtworkJob>();
  const artworkBindings = new Map<string, Map<HTMLElement, ArchiveTitle>>();
  const artworkVisible = new Set<HTMLElement>();
  const artworkNodes = new WeakMap<
    HTMLElement,
    {
      title: ArchiveTitle;
      request: ArchiveArtworkRequest;
      scope: string;
      epoch: number;
      hero: boolean;
    }
  >();
  let artworkBytes = 0,
    artworkEpoch = 0,
    artworkContext = '';
  let artworkJoin: Promise<void> = Promise.resolve();
  const archiveSearchArtwork = createArchiveSearchArtwork(shared);
  const {
    artworkObserver,
    observeArtwork,
    releaseArtworkBinding,
    syncArtworkContext,
    cancelArtwork,
  } = archiveSearchArtwork;

  const current = (owner: number, scope: string, signal: AbortSignal) =>
    !closed && enabled && owner === generation && !signal.aborted && host.readyScope() === scope;

  const canReturnLocalFocus = (scope: string | null) =>
    scope !== null &&
    host.readyScope() === scope &&
    !closed &&
    enabled &&
    !doc.hidden &&
    !doc.querySelector('dialog[open]') &&
    !root.closest('[hidden],[inert]') &&
    root.checkVisibility({ visibilityProperty: true });

  function revealInResultList(target: HTMLElement): void {
    const viewport = list.getBoundingClientRect();
    const box = target.getBoundingClientRect();
    const top = Math.max(0, viewport.top + list.clientTop) + 4;
    const bottom =
      Math.min(doc.defaultView!.innerHeight, viewport.top + list.clientTop + list.clientHeight) - 4;
    if (box.top < top || box.height > bottom - top) list.scrollTop += box.top - top;
    else if (box.bottom > bottom) list.scrollTop += box.bottom - bottom;
  }

  function hideCancel(scope: string | null): void {
    // Hand off before hiding: otherwise the browser drops this focused action to BODY.
    // Only its current focus is ours; later browsing/editing/modal focus stays untouched.
    if (doc.activeElement === cancel && canReturnLocalFocus(scope)) {
      const target = [
        list.querySelector<HTMLButtonElement>('.gx-archive-title-button[aria-current="true"]'),
        ...list.querySelectorAll<HTMLButtonElement>('.gx-archive-title-button'),
        filtersToggle,
        host.input,
      ].find(
        (node): node is HTMLElement =>
          node !== null &&
          node.isConnected &&
          !node.matches(':disabled,[aria-disabled="true"]') &&
          !node.closest('[hidden],[inert]') &&
          node.checkVisibility({ visibilityProperty: true }),
      );
      target?.focus({ preventScroll: true });
    }
    cancel.hidden = true;
  }

  const button = (label: string, action: () => void, identity?: string) => {
    const node = doc.createElement('button');

    node.type = 'button';

    node.textContent = label;

    if (identity) node.dataset.archiveRef = identity;

    // Delegated listeners on root own dynamic rows; no retained per-row handlers.

    actions.set(node, action);

    return node;
  };

  const actions = new WeakMap<HTMLButtonElement, () => void>();

  tools.append(filters);

  const dismissFilters = (restoreFocus = true) => {
    if (!filters.open) return false;
    filters.open = false;
    filtersToggle.setAttribute('aria-expanded', 'false');
    if (restoreFocus) filtersToggle.focus({ preventScroll: true });
    return true;
  };
  listen(filters, 'toggle', () => {
    filtersToggle.setAttribute('aria-expanded', String(filters.open));
  });
  listen(root, 'keydown', (event) => {
    if (
      event instanceof KeyboardEvent &&
      !event.defaultPrevented &&
      ['Escape', 'BrowserBack'].includes(event.key) &&
      dismissFilters()
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  });

  paging.append(position);
  paging.setAttribute('aria-label', 'Saved titles loaded');
  listen(list, 'scroll', () => {
    if (list.scrollHeight - list.clientHeight - list.scrollTop <= 120) void appendSavedTitles();
  });

  const duration = (seconds: number | null) =>
    seconds === null
      ? ''
      : `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

  const fileSize = (value: string | null) => {
    if (value === null || !/^[1-9][0-9]{0,10}$/u.test(value) || BigInt(value) > 68719476736n)
      return 'Not listed';
    const bytes = Number(value),
      units = ['bytes', 'KiB', 'MiB', 'GiB'];
    let scaled = bytes,
      index = 0;
    while (scaled >= 1024 && index < 3) {
      scaled /= 1024;
      index++;
    }
    return index === 0
      ? `${bytes} bytes`
      : `${scaled.toFixed(1)} ${units[index]} (${bytes.toLocaleString('en-US')} bytes)`;
  };
  const selectedFocus = () => {
    const active = doc.activeElement;

    return active instanceof HTMLElement && (root.contains(active) || detailPane.contains(active))
      ? (active.dataset.archiveRef ?? null)
      : null;
  };

  const restoreFocus = (identity: string | null) => {
    if (!identity) return;

    const target = Array.from(
      new Set([
        ...root.querySelectorAll<HTMLButtonElement>('[data-archive-ref]'),
        ...detailPane.querySelectorAll<HTMLButtonElement>('[data-archive-ref]'),
      ]),
    ).find((node) => node.dataset.archiveRef === identity && !node.disabled);

    target?.focus({ preventScroll: true });
  };

  async function cancelWork(preserveSelection = false): Promise<void> {
    const scope = host.readyScope();
    const owner = ++generation;

    abort?.abort();

    if (!preserveSelection) selectionAbort?.abort();

    // Browsing mode changes retain the chosen startup here and in ArchivePlayer.

    // Background/Exit use the default abort and join both original owners.

    await Promise.all([tail, preserveSelection ? null : selecting, cancelArtwork()]);

    if (owner === generation) hideCancel(scope);

    if (cleanupFailed) throw new Error('Archive cleanup could not be confirmed.');
  }

  const actionClick: EventListener = (event) => {
    const target = event.target;

    if (!(target instanceof Element)) return;

    const control = target.closest('button');

    if (
      control instanceof HTMLButtonElement &&
      (root.contains(control) || detailPane.contains(control) || management.contains(control)) &&
      !control.disabled
    )
      actions.get(control)?.();
  };

  listen(root, 'click', actionClick);
  if (host.detailsContainer) listen(detailPane, 'click', actionClick);

  listen(management, 'click', actionClick);

  listen(cancel, 'click', () => {
    status.dataset.passive = 'false';
    const canceled = cancelWork();
    const owner = generation;
    void canceled
      .then(() => {
        if (enabled && owner === generation) status.textContent = 'Archive request canceled.';
      })

      .catch(() => {
        if (owner === generation) status.textContent = 'Archive cleanup could not be confirmed.';
      });
  });

  listen(host.input, 'input', () => {
    if (!enabled || closed || host.readyScope() === null) return;

    savedQuery = host.input.value;

    expanded = null;

    files = null;

    page = null;

    pendingPage = null;

    render();

    void queryAt();
  });

  function revealResultTitle(title: HTMLButtonElement | null): void {
    title?.focus({ preventScroll: true });
    if (title && doc.activeElement === title) revealInResultList(title);
  }

  listen(list, 'focusin', (event) => {
    if (!(event instanceof FocusEvent)) return;
    const target = event.target;
    const previous = event.relatedTarget;
    if (
      target instanceof HTMLElement &&
      target.matches('.gx-archive-title-button,.gx-archive-favorite') &&
      previous instanceof HTMLElement &&
      previous.isConnected &&
      previous !== doc.body &&
      previous !== doc.documentElement &&
      !list.contains(previous) &&
      canReturnLocalFocus(host.readyScope())
    ) {
      // External dock/toolbar focus arrivals reveal only our scroll owner. A
      // detached row restored after render is not a new user navigation route.
      revealInResultList(target);
    }
  });

  function dismissEpisodes(): boolean {
    if (!episodesOpen || expanded === null) return false;
    const title = list.querySelector<HTMLButtonElement>(
      '.gx-archive-title-button[aria-current="true"]',
    );
    const inline = title
      ?.closest('.gx-archive-result-row')
      ?.querySelector('.gx-archive-inline-videos');
    if (!title || (doc.activeElement !== title && !inline?.contains(doc.activeElement)))
      return false;
    episodesOpen = false;
    render();
    revealResultTitle(
      list.querySelector<HTMLButtonElement>('.gx-archive-title-button[aria-current="true"]'),
    );
    return true;
  }
  const archiveSearchNavigation = createArchiveSearchNavigation(shared);
  const { navigateControls } = archiveSearchNavigation;
  listen(root, 'keydown', navigateControls);
  if (host.detailsContainer) listen(detailPane, 'keydown', navigateControls);
  listen(management, 'keydown', navigateControls);

  listen(language, 'change', () => {
    if (!enabled || closed || host.readyScope() === null) return;
    page = null;
    pendingPage = null;
    expanded = null;
    files = null;
    render();
    void queryAt();
  });
  const archiveSearchApi = createArchiveSearchApi(shared);
  const { api } = archiveSearchApi;

  return api;
}
