import { mountSeriesSuggestions, type SeriesLookup } from './archive-series-suggestions';
import { mountArchiveDownloads } from './archive-downloads';
import { archiveFavoriteEmptyState } from './archive-empty-state';
import type { ArchiveDownloads } from '../application/archive-downloads';
import type { ArchiveDownloadEntry } from '../platform/archive-downloads';
import { archivePlayerFailureGuidance } from '../application/archive-player';
import { archiveLanguageSummary } from './archive-language';
import {
  archiveCompactYearLabel,
  archiveItemDateFacts,
  archiveTitleYearLabel,
} from './archive-date';
import { publicArchiveProviderName } from '../platform/archive-public-providers';
import {
  createArchiveCatalog,
  archiveRevision,
  validateArchiveArtworkResponse,
  type ArchiveArtworkRequest,
  type ArchiveArtworkResponse,
  type ArchiveTitle,
  type ArchiveFile,
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

function fileLabel(file: ArchiveFile, fallback: string): string {
  const stem = file.fileName
    .split('/')
    .at(-1)!
    .replace(/\.[^.]+$/u, '');
  const providerTitle = file.title.trim();
  if (providerTitle && providerTitle !== file.fileName && providerTitle !== stem)
    return providerTitle;

  // Present only words actually supplied by the file name; no episode identity inference.
  const label = stem.replace(/_+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return /\p{L}{2}/u.test(label) &&
    !/^[a-f\d-]{24,}$/iu.test(label) &&
    !/^(?:video|movie|file|clip|track|part)[ .-]*\d*$/iu.test(label)
    ? label
    : fallback;
}

function titleType(title: ArchiveTitle): string {
  if (title.contentTypeProvenance !== 'provider-item') return 'Video';
  return title.contentType === 'tv'
    ? 'TV show'
    : title.contentType === 'movie'
      ? 'Movie'
      : title.contentType === 'short'
        ? 'Short video'
        : 'Video';
}

/** Separate on-demand mode. Reuses the host input and never opens a modal or changes its query after selection. */

export function mountArchiveSearch(container: HTMLElement, host: ArchiveSearchHost) {
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

  type ArtworkJob = {
    key: string;
    title: ArchiveTitle;
    request: ArchiveArtworkRequest;
    scope: string;
    epoch: number;
    nodes: Set<HTMLElement>;
    controller: AbortController;
    work?: Promise<void>;
  };
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
  const artworkObserver = readArtwork
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const node = entry.target as HTMLElement;
          const view = artworkNodes.get(node);
          if (!view || !enabled || closed || view.epoch !== artworkEpoch) continue;
          if (!entry.isIntersecting && !view.hero) {
            artworkVisible.delete(node);
            releaseArtworkBinding(node, view.title);
            for (const job of [...artworkActive.values(), ...artworkQueue.values()]) {
              job.nodes.delete(node);
              if (!job.nodes.size) {
                job.controller.abort();
                if (artworkQueue.get(job.key) === job) artworkQueue.delete(job.key);
              }
            }
            continue;
          }
          artworkVisible.add(node);
          const key = JSON.stringify([
            view.scope,
            view.request.expectedRevision,
            view.request.titleRef,
          ]);
          if (artworkCache.has(key)) {
            const value = artworkCache.get(key) ?? null;
            artworkCache.delete(key);
            artworkCache.set(key, value);
            bindArtwork(node, view.title, value, key);
            continue;
          }
          const active = artworkActive.get(key);
          let job =
            active?.epoch === artworkEpoch && !active.controller.signal.aborted
              ? active
              : artworkQueue.get(key);
          if (!job) {
            if (artworkQueue.size >= 24) continue;
            job = { key, ...view, nodes: new Set(), controller: new AbortController() };
            artworkQueue.set(key, job);
          }
          for (const previous of job.nodes) if (!previous.isConnected) job.nodes.delete(previous);
          job.nodes.add(node);
        }
        pumpArtwork();
      })
    : null;

  function bindArtwork(
    node: HTMLElement,
    title: ArchiveTitle,
    value: ArchiveArtworkResponse | null,
    key: string,
  ): void {
    if (!value || !node.isConnected || !artworkVisible.has(node)) return;
    releaseArtworkBinding(node, title);
    const img = doc.createElement('img');
    img.alt = `Provider artwork for ${title.title}`;
    img.decoding = 'async';
    img.width = value.width;
    img.height = value.height;
    img.onerror = () => {
      if (node.contains(img)) {
        releaseArtworkBinding(node, title);
      }
    };
    img.src = value.dataUrl;
    node.replaceChildren(img);
    node.dataset.artwork = 'resolved';
    node.removeAttribute('aria-label');
    const bindings = artworkBindings.get(key) ?? new Map<HTMLElement, ArchiveTitle>();
    bindings.set(node, title);
    artworkBindings.set(key, bindings);
  }

  function releaseArtworkBinding(node: HTMLElement, title: ArchiveTitle): void {
    for (const [key, bindings] of artworkBindings) {
      bindings.delete(node);
      if (!bindings.size) artworkBindings.delete(key);
    }
    for (const img of node.querySelectorAll('img')) img.removeAttribute('src');
    node.replaceChildren(
      doc.createTextNode(Array.from(title.title.trim()).slice(0, 2).join('').toUpperCase()),
    );
    node.dataset.artwork = 'fallback';
    if (node.matches('.gx-archive-detail-artwork'))
      node.setAttribute('aria-label', 'Artwork not available');
  }

  function reserveArtworkBudget(inFlight: number, incomingBytes = 0, incomingEntries = 0): void {
    while (
      artworkCache.size + inFlight + incomingEntries > 8 ||
      artworkBytes + inFlight * 524288 + incomingBytes > 4 * 1024 * 1024
    ) {
      const oldest = [...artworkCache.keys()].find(
        (key) =>
          ![...(artworkBindings.get(key) ?? [])].some(
            ([node, title]) =>
              node.isConnected &&
              node.matches('.gx-archive-detail-artwork') &&
              title.titleRef === expanded,
          ),
      );
      if (oldest === undefined) break;
      for (const [node, title] of [...(artworkBindings.get(oldest) ?? [])])
        releaseArtworkBinding(node, title);
      artworkBytes -= artworkCache.get(oldest)?.byteLength ?? 0;
      artworkCache.delete(oldest);
    }
  }

  function pumpArtwork(): void {
    if (!readArtwork || closed || !enabled) return;
    while (artworkActive.size < 2 && artworkQueue.size) {
      const job = artworkQueue.values().next().value!;
      artworkQueue.delete(job.key);
      if (job.epoch !== artworkEpoch || ![...job.nodes].some((node) => node.isConnected)) continue;
      reserveArtworkBudget(artworkActive.size + 1);
      artworkActive.set(job.key, job);
      job.work = Promise.resolve().then(async () => {
        try {
          const raw = await readArtwork(job.request, job.controller.signal);
          if (
            closed ||
            !enabled ||
            job.controller.signal.aborted ||
            job.epoch !== artworkEpoch ||
            host.readyScope() !== job.scope ||
            revision !== job.request.expectedRevision
          )
            return;
          const value = raw === null ? null : validateArchiveArtworkResponse(raw, job.request);
          artworkBytes -= artworkCache.get(job.key)?.byteLength ?? 0;
          artworkCache.delete(job.key);
          reserveArtworkBudget(artworkActive.size - 1, value?.byteLength ?? 0, 1);
          artworkCache.set(job.key, value);
          artworkBytes += value?.byteLength ?? 0;
          for (const node of job.nodes)
            if (node.isConnected) bindArtwork(node, job.title, value, job.key);
        } catch (error) {
          if (job.controller.signal.aborted && !isAbort(error)) cleanupFailed = true;
          // Artwork failure leaves a truthful fallback and never changes playback/status.
        } finally {
          if (artworkActive.get(job.key) === job) artworkActive.delete(job.key);
          pumpArtwork();
        }
      });
    }
  }

  function cancelArtwork(): Promise<void> {
    artworkEpoch++;
    artworkObserver?.disconnect();
    artworkVisible.clear();
    for (const bindings of [...artworkBindings.values()])
      for (const [node, title] of [...bindings]) releaseArtworkBinding(node, title);
    artworkQueue.clear();
    for (const job of artworkActive.values()) job.controller.abort();
    artworkJoin = Promise.all([...artworkActive.values()].map((job) => job.work)).then(
      () => undefined,
    );
    return artworkJoin;
  }

  function syncArtworkContext(): Promise<void> {
    const next = JSON.stringify([continuationKey(), host.readyScope()]);
    if (next !== artworkContext) {
      artworkContext = next;
      return cancelArtwork();
    }
    return artworkJoin;
  }

  function observeArtwork(node: HTMLElement, title: ArchiveTitle): void {
    const scope = host.readyScope();
    if (!artworkObserver || !revision || scope === null || closed || !enabled) return;
    artworkNodes.set(node, {
      title,
      request: { schemaVersion: 1, titleRef: title.titleRef, expectedRevision: revision },
      scope,
      epoch: artworkEpoch,
      hero: node.matches('.gx-archive-detail-artwork'),
    });
    artworkObserver.observe(node);
  }

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

  function removeMatches(target: ArchiveRemovalTarget, selected: ArchiveSelection): boolean {
    return (
      target.kind === 'library' ||
      (target.titleRef === selected.titleRef &&
        (target.kind === 'title' || target.fileRef === selected.fileRef))
    );
  }

  function removalControls(
    target: ArchiveRemovalTarget,
    label: string,
    identity: string,
  ): HTMLElement {
    const group = doc.createElement('div');

    group.className = 'gx-archive-remove-confirmation';

    if (confirmation === identity) {
      const prompt = doc.createElement('p');

      prompt.textContent =
        target.kind === 'library' ? 'Clear your GenXtra library?' : `Remove ${label} from GenXtra?`;

      const yes = button(
        target.kind === 'library' ? 'Clear GenXtra' : 'Remove',
        () => {
          void remove(target);
        },
        `${identity}-confirm`,
      );

      const no = button(
        'Keep',
        () => {
          confirmation = null;
          render();
          if (target.kind === 'file')
            list
              .querySelector<HTMLElement>(`[data-archive-ref="${target.fileRef}-details"]`)
              ?.focus();
        },
        `${identity}-keep`,
      );

      yes.disabled = no.disabled = removalBusy;

      group.append(prompt, yes, no);
    } else {
      const ask = button(
        target.kind === 'library' ? 'Clear GenXtra library' : 'Remove from GenXtra',
        () => {
          confirmation = identity;
          render();

          const parent =
            target.kind === 'library' ? management : target.kind === 'file' ? list : detailPane;

          parent
            .querySelector<HTMLButtonElement>(`[data-archive-ref="${identity}-confirm"]`)
            ?.focus();
        },
        identity,
      );

      ask.disabled = removalBusy || revision === null || !enabled;

      group.append(ask);
    }

    return group;
  }

  async function remove(target: ArchiveRemovalTarget): Promise<void> {
    if (!host.onRemove || removalBusy || revision === null) return;

    const expectedRevision = revision;

    removalBusy = true;

    render();

    try {
      await run(async (signal, owner, scope) => {
        if (selectionIdentity && removeMatches(target, selectionIdentity)) {
          selectionAbort?.abort();

          await selecting;
        }

        if (!current(owner, scope, signal)) return;

        const receipt = await host.onRemove!(target, expectedRevision, signal);

        // Durable receipt is authoritative even when the caller aborted at COMMIT.

        revision = receipt.revision;

        confirmation = null;

        const message = receipt.cleanupPending
          ? 'Removed. Playback cleanup needs retry.'
          : target.kind === 'library'
            ? 'GenXtra library cleared.'
            : 'Removed from GenXtra.';

        managementStatus.textContent = message;

        if (!current(owner, scope, signal)) return;

        const result = await catalog.query(
          {
            schemaVersion: 1,
            query: savedQuery,
            expectedRevision: receipt.revision,

            offset: 0,
            pageSize: 50,
            ...browseOptions(),
          },
          signal,
        );

        const suggestions = await host.pendingFiles?.(
          receipt.revision,
          0,
          savedQuery,
          signal,
          browseOptions().languageMode,
          browseOptions().contentType,
        );

        if (!current(owner, scope, signal)) return;

        page = result;
        pendingPage = suggestions ?? null;
        expanded = null;
        files = null;

        status.textContent = message;
      }, 'Removing from GenXtra…');
    } finally {
      removalBusy = false;

      if (!closed) render();
    }
  }

  function render(preserveDetailDOM = false) {
    const view = browseOptions();
    const empty =
      page &&
      archiveFavoriteEmptyState({
        ...view,
        query: savedQuery,
        totalCount: page.totalCount,
        pendingCount: pendingPage?.totalCount,
      });
    clearFilters.hidden = !(empty?.filtered && host.clearFilters);

    void syncArtworkContext();
    artworkObserver?.disconnect();
    resultSummary.textContent = [
      savedQuery.trim()
        ? `Results for “${savedQuery}”`
        : view.favoritesOnly
          ? 'Favorites'
          : 'Saved titles',
      page
        ? `${page.totalCount} ${view.favoritesOnly ? (page.totalCount === 1 ? 'match' : 'matches') : 'saved'}`
        : null,
    ]
      .filter((value) => value !== null)
      .join(' · ');
    resultSummary.title = resultSummary.textContent;
    managementActions.replaceChildren();

    if (host.onRemove)
      managementActions.append(
        removalControls({ kind: 'library' }, 'your GenXtra library', 'archive-clear'),
      );

    renderPending();

    const focus = selectedFocus();
    const scrollTop = list.scrollTop;

    list.replaceChildren();
    if (!preserveDetailDOM) {
      detailPane.replaceChildren();
      detailPane.hidden = true;
      syncDetailsHost();
    }

    if (!page) {
      paging.hidden = true;

      return;
    }

    paging.hidden = page.totalCount === 0;

    position.textContent = page.totalCount
      ? `${page.items.length} of ${page.totalCount} loaded`
      : '';

    for (const [titleIndex, title] of page.items.entries()) {
      const article = doc.createElement('article');

      article.className = 'gx-archive-title';
      article.classList.add('gx-archive-result-row');
      article.dataset.selected = String(expanded === title.titleRef);

      const toggle = button(
        title.title,

        () => {
          host.onTitleSelected?.();
          if (
            expanded === title.titleRef &&
            (files?.titleRef === title.titleRef || abort !== null)
          ) {
            episodesOpen = !episodesOpen;
            render();
          } else void filesAt(title, 0);
        },

        title.titleRef,
      );

      toggle.className = 'gx-archive-title-button';

      const inlineId = `genxtra-inline-videos-${titleIndex}`;
      toggle.setAttribute('aria-expanded', String(expanded === title.titleRef && episodesOpen));
      toggle.setAttribute('aria-controls', inlineId);
      toggle.setAttribute('aria-current', String(expanded === title.titleRef));
      toggle.setAttribute('aria-label', `Show videos for ${title.title}`);
      toggle.title = title.title;

      const tile = doc.createElement('span');
      tile.className = 'gx-archive-result-artwork';
      tile.dataset.artwork = 'fallback';
      tile.setAttribute('aria-hidden', 'true');
      tile.textContent = Array.from(title.title.trim()).slice(0, 2).join('').toUpperCase();
      observeArtwork(tile, title);
      const copy = doc.createElement('span');
      copy.className = 'gx-archive-result-copy';
      const name = doc.createElement('strong');
      name.className = 'gx-archive-result-name';
      name.textContent = title.title;
      const subtitle = doc.createElement('small');
      subtitle.className = 'gx-archive-result-subtitle';
      subtitle.textContent = [
        archiveCompactYearLabel(title),
        titleType(title),
        `${title.fileCount} ${title.providerId ? (title.fileCount === 1 ? 'file' : 'files') : title.fileCount === 1 ? 'video' : 'videos'}`,
      ]
        .filter((value) => value !== null)
        .join(' · ');
      copy.append(name, subtitle);
      toggle.replaceChildren(tile, copy);
      article.append(toggle);
      const inline = doc.createElement('section');
      inline.className = 'gx-archive-inline-videos';
      inline.id = inlineId;
      inline.hidden = expanded !== title.titleRef || !episodesOpen;
      inline.setAttribute('aria-label', `${title.title} videos`);

      const detail = doc.createElement('section');
      detail.className = 'gx-archive-selected-title';
      const hero = doc.createElement('div');
      hero.className = 'gx-archive-detail-hero';
      const artwork = doc.createElement('div');
      artwork.className = 'gx-archive-detail-artwork';
      artwork.dataset.artwork = 'fallback';
      artwork.setAttribute('aria-label', 'Artwork not available');
      artwork.textContent = Array.from(title.title.trim()).slice(0, 2).join('').toUpperCase();
      if (expanded === title.titleRef && !preserveDetailDOM) observeArtwork(artwork, title);
      const overview = doc.createElement('div');
      overview.className = 'gx-archive-detail-overview';
      const detailActions = doc.createElement('div');
      detailActions.className = 'gx-archive-detail-actions';
      hero.append(artwork, overview, detailActions);
      detail.append(hero);
      const detailHeading = doc.createElement('h3');
      detailHeading.className = 'gx-archive-detail-title';
      detailHeading.textContent = title.title;
      overview.append(detailHeading);
      const about = doc.createElement('details');
      about.className = 'gx-archive-title-info';
      const aboutSummary = doc.createElement('summary');
      aboutSummary.textContent = 'More info';
      about.append(aboutSummary);

      const metadata = doc.createElement('p');

      metadata.className = 'gx-archive-metadata';

      metadata.textContent = `${titleType(title)} · ${archiveTitleYearLabel(title)} · ${title.fileCount} ${title.providerId ? (title.fileCount === 1 ? 'file' : 'files') : title.fileCount === 1 ? 'video' : 'videos'}`;

      overview.append(metadata);
      detailActions.append(about);

      const context = doc.createElement('p');
      context.className = 'gx-archive-context';
      const language = archiveLanguageSummary(title.providerLanguages);
      const basis = title.matchBasis;
      const match =
        basis === 'series'
          ? 'Series match'
          : basis === 'genre'
            ? 'Animation category'
            : basis === 'subject'
              ? 'Subject match'
              : basis === 'file'
                ? 'Video filename match'
                : basis === 'legacy-metadata'
                  ? 'Older metadata match'
                  : null;
      context.textContent = [language, match].filter(Boolean).join(' · ');
      context.title =
        'Language is reported by the source and has not been verified from the audio.';
      about.append(context);
      for (const [label, value] of archiveItemDateFacts(title)) {
        const claim = doc.createElement('p');
        claim.textContent = `${label}: ${value}`;
        about.append(claim);
      }
      if (title.providerSeries) {
        const series = doc.createElement('p');
        series.className = 'gx-archive-series';
        series.textContent = `Provider series: ${title.providerSeries}`;
        about.append(series);
      }

      if (title.providerSubjects?.length) {
        const subjects = doc.createElement('p');
        subjects.className = 'gx-archive-subjects';
        subjects.textContent = title.providerSubjects.slice(0, 3).join(' · ');
        about.append(subjects);
      }
      if (title.providerDescription) {
        const synopsis = doc.createElement('p');
        synopsis.className = 'gx-archive-synopsis';
        synopsis.textContent = title.providerDescription;
        overview.append(synopsis);
        const fullSynopsis = doc.createElement('p');
        fullSynopsis.className = 'gx-archive-full-synopsis';
        fullSynopsis.textContent = title.providerDescription;
        about.append(fullSynopsis);
      }

      if (host.onFavorite) {
        const heart = button(
          title.favorite ? '★' : '☆',

          () => {
            void favorite(title);
          },

          `${title.titleRef}-favorite`,
        );

        heart.className = 'gx-archive-favorite';

        heart.setAttribute(
          'aria-label',

          `${title.favorite ? 'Unfavorite' : 'Favorite'} ${title.title}`,
        );

        heart.setAttribute('aria-pressed', String(title.favorite));

        heart.disabled = favoriteBusy;

        article.append(heart);
        const detailHeart = button(
          title.favorite ? '★ Favorited' : '☆ Favorite',
          () => {
            void favorite(title);
          },
          `${title.titleRef}-detail-favorite`,
        );
        detailHeart.className = 'gx-archive-detail-favorite';
        detailHeart.setAttribute(
          'aria-label',
          `${title.favorite ? 'Unfavorite' : 'Favorite'} ${title.title}`,
        );
        detailHeart.setAttribute('aria-pressed', String(title.favorite));
        detailHeart.disabled = favoriteBusy;
        detailActions.insertBefore(detailHeart, about);
      }

      if (host.onRemove) {
        const manageTitle = doc.createElement('details');

        manageTitle.className = 'gx-archive-title-management';

        manageTitle.open = confirmation === `${title.titleRef}-remove`;

        const summary = doc.createElement('summary');
        summary.textContent = 'Manage title';

        manageTitle.append(
          summary,
          removalControls(
            { kind: 'title', titleRef: title.titleRef },
            title.title,
            `${title.titleRef}-remove`,
          ),
        );

        about.append(manageTitle);
      }

      if (expanded === title.titleRef) {
        const choices = doc.createElement('div');

        choices.className = 'gx-archive-files';

        choices.setAttribute('aria-label', `${title.title} videos to choose from`);
        const videosHeading = doc.createElement('h4');
        videosHeading.className = 'gx-archive-videos-heading';
        videosHeading.textContent = title.providerId ? 'Available files' : 'Available videos';
        inline.append(videosHeading, choices);

        if (title.rights) {
          const rights = doc.createElement('p');

          rights.className = 'gx-archive-rights';

          rights.textContent = `${title.providerId ? 'Source' : 'Uploader'} rights statement: ${title.rights}`;

          about.append(rights);
        }

        if (files?.titleRef === title.titleRef) {
          for (const file of files.files) {
            const fileName = fileLabel(
              file,
              title.fileCount === 1
                ? 'Video'
                : `Video ${files.offset + files.files.indexOf(file) + 1}`,
            );
            const fileRow = doc.createElement('div');
            fileRow.className = 'gx-archive-file-row';
            const fileCopy = doc.createElement('div');
            fileCopy.className = 'gx-archive-file-copy';
            const fileHeading = doc.createElement('strong');
            fileHeading.className = 'gx-archive-file-name';
            fileHeading.textContent = fileName;
            const row = button(
              'Play',

              () => {
                void choose(title, file);
              },

              file.fileRef,
            );

            row.className = 'gx-archive-file-button';
            row.setAttribute('aria-label', `Play ${fileName}`);

            // The active command coalesces repeat Play. Keep its logical opener
            // eligible while Resume closes ahead of a slow native handoff.
            const activePlay =
              selecting !== null &&
              selectionIdentity?.titleRef === title.titleRef &&
              selectionIdentity.fileRef === file.fileRef &&
              selectionIdentity.expectedRevision === revision &&
              files.revision === revision;
            row.disabled =
              file.availability === 'dead' ||
              file.providerFacts?.playbackCandidate === false ||
              (selecting !== null && !activePlay);
            row.setAttribute('aria-busy', String(activePlay));

            const info = doc.createElement('span');

            info.className = 'gx-archive-file-metadata';

            info.textContent = duration(file.durationSeconds);

            if (file.availability === 'dead') info.textContent += ' · Unavailable';
            else if (file.providerFacts?.playbackCandidate === false)
              info.textContent += ' · Details only';

            fileCopy.append(fileHeading, info);

            const details = doc.createElement('details');

            details.className = 'gx-archive-file-details';

            details.open = confirmation === `${file.fileRef}-remove`;

            const summary = doc.createElement('summary');

            summary.textContent = '⌄';
            summary.setAttribute('aria-label', `Video details for ${fileName}`);
            summary.dataset.archiveRef = `${file.fileRef}-details`;

            const facts = doc.createElement('dl');
            facts.className = 'gx-archive-file-facts';
            const fact = (label: string, value: string) => {
              const term = doc.createElement('dt'),
                description = doc.createElement('dd');
              term.textContent = label;
              description.textContent = value;
              facts.append(term, description);
            };
            fact('Title label', file.title.trim() || 'Not listed');
            fact('Filename', file.fileName);
            fact('Listed format', file.format === 'h.264' ? 'H.264' : file.format || 'Not listed');
            fact(
              'Listed duration',
              file.durationSeconds !== null &&
                Number.isFinite(file.durationSeconds) &&
                file.durationSeconds > 0
                ? duration(file.durationSeconds)
                : 'Not listed',
            );
            fact('Listed size', fileSize(file.sizeBytes));
            fact(
              'Source item',
              `${file.providerFacts ? publicArchiveProviderName(file.providerFacts.providerId) : 'Internet Archive'} · ${file.itemId}`,
            );
            fact('Episode / edition', 'Not verified');
            fact('Resolution', 'Not yet inspected');
            fact('Audio tracks', 'Not yet inspected');
            if (!file.providerFacts) {
              for (const [label, value] of archiveItemDateFacts(title)) fact(label, value);
            }
            if (file.providerFacts) {
              const f = file.providerFacts;
              fact('Source record', f.sourceUrl);
              if (f.providerId === 'nasa') {
                fact('Original release year', 'Unknown');
                fact(
                  'NASA provider-created date',
                  f.dateClaims?.providerCreated.value ?? 'Not listed',
                );
                if (f.dateClaims) fact('Date provenance', 'NASA search record · date_created');
              }
              fact('Listed media type', f.mimeType ?? 'Not listed');
              fact('Listed video codec', f.videoCodec ?? 'Not listed');
              fact('Listed audio codec', f.audioCodec ?? 'Not listed');
              fact(
                'Listed resolution',
                f.width && f.height ? `${f.width} × ${f.height}` : 'Not listed',
              );
              fact('Representation', f.representationRole ?? 'Not listed');
              fact('Content role', f.contentRole ?? 'Not verified');
              fact(
                'Playback',
                f.playbackCandidate
                  ? 'Format and availability checked when you select Play'
                  : (f.unsupportedReason ?? 'This file cannot be played by this app'),
              );
              fact(
                'Source access',
                f.accessRestricted === null
                  ? 'Not listed'
                  : f.accessRestricted
                    ? 'Restricted by source'
                    : 'Public access listed',
              );
              fact(
                'Source download offering',
                f.downloadAllowed === null
                  ? 'Not listed'
                  : f.downloadAllowed
                    ? 'Offered by source'
                    : 'Restricted by source',
              );
              fact('Download in GenXtra', 'Not available for this source yet');
              fact('Rights statement', f.rights ?? 'Not listed');
              fact('License', f.licenseUrl ?? 'Not listed');
              fact('Attribution', f.attribution ?? 'Not listed');
            }
            fact(
              'Past check',
              file.availability === 'played'
                ? 'Previously played'
                : file.availability === 'reachable'
                  ? 'Previously reachable'
                  : file.availability === 'dead'
                    ? 'Unavailable'
                    : 'Not checked',
            );
            details.append(summary);
            if (downloadsView && revision !== null && !file.providerFacts)
              details.append(
                downloadsView.fileControls(file.fileRef, revision, file.availability !== 'dead'),
              );
            details.append(facts);
            let revealAfterToggle = false;
            summary.addEventListener('click', () => {
              revealAfterToggle = true;
            });
            details.addEventListener('toggle', () => {
              // Observe the settled native toggle, not a click microtask (which
              // can run before the browser's default action). Reveal only this
              // file's action in our list; keep focus and playback unchanged.
              if (!revealAfterToggle) return;
              revealAfterToggle = false;
              if (closed || !enabled || !details.isConnected || !details.open) return;
              const action = details.querySelector<HTMLButtonElement>(
                '.gx-archive-file-downloads button:not([hidden]):not(:disabled)',
              );
              if (!action) return;
              const viewport = list.getBoundingClientRect(),
                button = action.getBoundingClientRect(),
                opener = summary.getBoundingClientRect();
              const top = Math.max(0, viewport.top + list.clientTop) + 4,
                bottom =
                  Math.min(innerHeight, viewport.top + list.clientTop + list.clientHeight) - 4;
              const pairTop = button.bottom - opener.top <= bottom - top ? opener.top : button.top;
              if (button.bottom > bottom) list.scrollTop += button.bottom - bottom;
              else if (pairTop < top) list.scrollTop += pairTop - top;
            });

            if (host.onRemove)
              details.append(
                removalControls(
                  { kind: 'file', titleRef: title.titleRef, fileRef: file.fileRef },
                  file.title,
                  `${file.fileRef}-remove`,
                ),
              );

            fileRow.append(fileCopy, row, details);
            choices.append(fileRow);
          }

          if (files.totalCount > files.files.length) {
            const filePaging = doc.createElement('nav');

            filePaging.className = 'gx-archive-paging';

            filePaging.setAttribute('aria-label', `${title.title} file pages`);

            const back = button('Previous files', () => {
              if (files) void filesAt(title, Math.max(0, files.offset - 50));
            });

            const forward = button('More files', () => {
              if (files) void filesAt(title, files.offset + files.files.length);
            });

            back.disabled = files.offset === 0;

            forward.disabled = !files.more;

            filePaging.append(back, forward);

            choices.append(filePaging);
          }

          if (files.totalCount === 0) {
            const empty = doc.createElement('p');

            empty.textContent = 'No selectable files are saved for this title.';

            choices.append(empty);
          }
        } else {
          const loading = doc.createElement('p');

          loading.textContent = 'Loading saved videos…';

          choices.append(loading);
        }

        if (!preserveDetailDOM) {
          detailPane.append(detail);
          detailPane.hidden = !enabled;
        }
      }

      article.append(inline);
      list.append(article);
    }

    list.scrollTop = scrollTop;
    for (const bindings of [...artworkBindings.values()])
      for (const [node, title] of [...bindings])
        if (!node.isConnected) releaseArtworkBinding(node, title);
    for (const node of artworkVisible) if (!node.isConnected) artworkVisible.delete(node);
    if (preserveDetailDOM) {
      const selected = page.items.find((title) => title.titleRef === expanded);
      const hero = detailPane.querySelector<HTMLElement>('.gx-archive-detail-artwork');
      if (selected && hero) observeArtwork(hero, selected);
    }
    syncDetailsHost();
    restoreFocus(focus);
  }

  function renderPending(): void {
    const focus = selectedFocus();

    pendingContent.replaceChildren();

    pending.hidden = !pendingPage?.items.length;

    if (!pendingPage || pending.hidden) {
      pending.open = false;
      return;
    }

    pendingSummary.textContent = `More to explore · ${pendingPage.totalCount} ${pendingPage.totalCount === 1 ? 'title' : 'titles'}`;

    for (const progress of pendingPage.items) {
      const row = doc.createElement('div');

      row.className = 'gx-archive-pending-row';

      const label = doc.createElement('span');

      label.textContent = `${progress.title}${progress.originalYear === null ? '' : ` · ${progress.originalYear}`}`;

      const note = doc.createElement('small');

      note.textContent = progress.capacityReached
        ? 'A saved limit was reached; other files may exist.'
        : progress.complete
          ? 'All listed files were checked; playback is unverified.'
          : progress.availableFileCount
            ? `${progress.availableFileCount} saved · ${progress.nextOffset}/${progress.providerFileCount} listed files checked`
            : 'More files have not been checked yet.';

      const load = button(
        progress.kind === 'tv' ? 'Find episodes' : 'Load more',

        () => {
          void loadPendingFiles(progress);
        },

        `${progress.titleRef}-more-files`,
      );

      load.disabled = progress.complete || progress.capacityReached || !host.loadFiles;

      row.append(label, note, load);

      if (host.onRemove) {
        const manage = doc.createElement('details');
        manage.className = 'gx-archive-title-management';
        manage.open = confirmation === `${progress.titleRef}-pending-remove`;
        const summary = doc.createElement('summary');
        summary.textContent = 'Manage title';
        manage.append(
          summary,
          removalControls(
            { kind: 'title', titleRef: progress.titleRef },
            progress.title,
            `${progress.titleRef}-pending-remove`,
          ),
        );
        row.append(manage);
      }

      pendingContent.append(row);
    }

    const nav = doc.createElement('nav');

    nav.className = 'gx-archive-pending-pages';

    const previousPending = button('Previous', () => {
      void pendingAt(Math.max(0, pendingPage!.offset - 5));
    });

    previousPending.disabled = pendingPage.offset === 0;

    const nextPending = button('More', () => {
      void pendingAt(pendingPage!.offset + 5);
    });

    nextPending.disabled = !pendingPage.more;

    nav.append(previousPending, nextPending);

    pendingContent.append(nav);

    restoreFocus(focus);
  }

  function pendingAt(offset: number): Promise<void> {
    if (!host.pendingFiles || pendingPage === null) return Promise.resolve();

    const expectedRevision = pendingPage.revision;

    return run(async (signal, owner, scope) => {
      const result = await host.pendingFiles!(
        expectedRevision,
        offset,
        savedQuery,
        signal,
        browseOptions().languageMode,
        browseOptions().contentType,
      );

      if (!current(owner, scope, signal)) return;

      pendingPage = result;

      render();
    }, 'Loading saved suggestions…');
  }

  function loadPendingFiles(progress: ArchiveFileProgress): Promise<void> {
    if (!host.loadFiles || pendingPage === null || progress.complete || progress.capacityReached)
      return Promise.resolve();

    const expectedRevision = pendingPage.revision;

    return run(async (signal, owner, scope) => {
      const receipt = await host.loadFiles!(progress, expectedRevision, signal);

      if (!current(owner, scope, signal)) return;

      const result = await catalog.query(
        {
          schemaVersion: 1,

          query: savedQuery,

          expectedRevision: receipt.revision,

          offset: page?.offset ?? 0,

          pageSize: 50,

          ...browseOptions(),
        },

        signal,
      );

      const suggestions = await host.pendingFiles?.(
        receipt.revision,
        0,
        savedQuery,
        signal,
        browseOptions().languageMode,
        browseOptions().contentType,
      );

      if (!current(owner, scope, signal)) return;

      revision = receipt.revision;

      page = result;

      pendingPage = suggestions ?? null;

      expanded = null;

      files = null;

      render();

      status.textContent = receipt.admitted
        ? `${receipt.admitted} files saved. Choose a title to see its available files.`
        : 'No suitable files in this checked page. More may remain; temporary failures do not prove removal.';
    }, 'Checking more files…');
  }

  function run(
    work: (signal: AbortSignal, owner: number, scope: string) => Promise<void>,

    message: string,
    failureGuidance = 'Archive request could not finish. Retry, or search online explicitly.',
  ): Promise<void> {
    if (closed || !enabled) return Promise.resolve();

    const scope = host.readyScope();
    const imagesSettled = syncArtworkContext();

    if (scope === null) {
      status.dataset.passive = 'false';
      status.textContent = 'Archive browsing is waiting for local storage.';

      return Promise.resolve();
    }

    const owner = ++generation;

    abort?.abort();

    const owned = new AbortController();

    abort = owned;

    status.textContent = message;
    status.dataset.passive = 'false';
    clearFilters.hidden = true;
    clearFilters.disabled = true;

    cancel.hidden = false;

    const operation = tail.then(async () => {
      if (!current(owner, scope, owned.signal)) return;

      try {
        await imagesSettled;
        if (!current(owner, scope, owned.signal)) return;
        if (cleanupFailed) throw new Error('Archive cleanup could not be confirmed.');
        await work(owned.signal, owner, scope);
      } catch (error) {
        if (owned.signal.aborted && !isAbort(error)) cleanupFailed = true;

        if (current(owner, scope, owned.signal) && !isAbort(error))
          status.textContent = failureGuidance;
      } finally {
        if (owner === generation) {
          hideCancel(scope);
          clearFilters.disabled = false;

          if (abort === owned) abort = null;
        }
      }
    });

    tail = operation.catch(() => {});

    return operation;
  }

  function queryAt(offset = 0, preserveDetails = false): Promise<void> {
    failedTitlePage = null;
    const retainedTitle = expanded,
      retainedFiles = files,
      retainedPage = page;

    return run(async (signal, owner, scope) => {
      const result = await catalog.query(
        {
          schemaVersion: 1,

          query: savedQuery,

          expectedRevision: offset === 0 ? null : revision,

          offset,

          pageSize: 50,

          ...browseOptions(),
        },

        signal,
      );

      if (!current(owner, scope, signal)) return;

      const suggestions = await host.pendingFiles?.(
        result.revision,
        0,
        savedQuery,
        signal,
        browseOptions().languageMode,
        browseOptions().contentType,
      );

      if (!current(owner, scope, signal)) return;

      pendingPage = suggestions ?? null;

      revision = result.revision;

      page =
        preserveDetails &&
        retainedPage?.revision === result.revision &&
        retainedPage.totalCount === result.totalCount &&
        retainedPage.offset === result.offset &&
        retainedPage.items.length > result.items.length
          ? {
              ...retainedPage,
              items: [...result.items, ...retainedPage.items.slice(result.items.length)],
            }
          : result;

      renderedOptions = JSON.stringify(browseOptions() ?? {});

      const retained =
        preserveDetails &&
        retainedFiles?.revision === result.revision &&
        page.items.some((item) => item.titleRef === retainedTitle);

      expanded = retained ? retainedTitle : null;

      files = retained ? retainedFiles : null;

      render();

      status.textContent =
        !result.totalCount && pendingPage?.totalCount
          ? 'No playable matches yet. Check the saved suggestions below.'
          : result.totalCount
            ? `${result.totalCount} saved ${result.totalCount === 1 ? 'title' : 'titles'}. Select one for episodes or files.`
            : language.value === 'english'
              ? 'No videos listed as English. Try All languages, or Search online.'
              : language.value === 'unlisted'
                ? 'No videos with an unlisted language. Try All languages.'
                : savedQuery.trim()
                  ? 'No saved Archive matches. Use the magnifier to search online.'
                  : 'No curated Archive titles yet. Use the magnifier to search online.';
      const empty = archiveFavoriteEmptyState({
        ...browseOptions(),
        query: savedQuery,
        totalCount: result.totalCount,
        pendingCount: pendingPage?.totalCount,
      });
      if (empty) status.textContent = empty.message;
      status.dataset.passive = String(result.totalCount > 0);
    }, 'Filtering saved Archive titles…');
  }

  function appendSavedTitles(): Promise<void> {
    const before = page;
    if (
      !before?.more ||
      before === failedTitlePage ||
      loadingTitles ||
      abort !== null ||
      !enabled ||
      closed ||
      before.items.length >= titleLimit
    )
      return Promise.resolve();
    const offset = before.offset + before.items.length;
    const query = savedQuery;
    const options = browseOptions();
    loadingTitles = true;
    list.setAttribute('aria-busy', 'true');
    return run(
      async (signal, owner, scope) => {
        let result: ArchivePage;
        try {
          result = await catalog.query(
            {
              schemaVersion: 1,
              query,
              expectedRevision: before.revision,
              offset,
              pageSize: 50,
              ...options,
            },
            signal,
          );
        } catch (error) {
          if (current(owner, scope, signal)) failedTitlePage = before;
          throw error;
        }
        if (!current(owner, scope, signal) || page !== before) return;
        if (
          result.revision !== before.revision ||
          result.offset !== offset ||
          result.totalCount !== before.totalCount ||
          !result.items.length ||
          before.items.length + result.items.length > titleLimit ||
          new Set([...before.items, ...result.items].map((item) => item.titleRef)).size !==
            before.items.length + result.items.length
        ) {
          failedTitlePage = before;
          throw new Error('Saved Archive title continuation changed.');
        }
        page = { ...result, offset: before.offset, items: [...before.items, ...result.items] };
        render(true);
        status.textContent = 'Scroll to browse saved titles. Select one to see its videos.';
        status.dataset.passive = 'true';
      },
      'Loading more saved titles…',
      'More saved titles could not load. Change the search to retry.',
    ).finally(() => {
      loadingTitles = false;
      list.setAttribute('aria-busy', 'false');
    });
  }

  function filesAt(title: ArchiveTitle, offset: number): Promise<void> {
    if (revision === null) return Promise.resolve();

    const expectedRevision = revision;

    expanded = title.titleRef;
    episodesOpen = true;

    files = null;

    render();

    return run(async (signal, owner, scope) => {
      const result = await catalog.files(
        { schemaVersion: 1, titleRef: title.titleRef, expectedRevision, offset, pageSize: 50 },

        signal,
      );

      if (!current(owner, scope, signal)) return;

      const focused = doc.activeElement;
      const titleStillFocused =
        focused instanceof HTMLElement &&
        focused.matches('.gx-archive-title-button') &&
        focused.dataset.archiveRef === title.titleRef;
      files = result;

      render();

      if (titleStillFocused && current(owner, scope, signal)) {
        const choice = list.querySelector<HTMLButtonElement>(
          '.gx-archive-inline-videos:not([hidden]) :is(.gx-archive-file-button:not(:disabled),.gx-archive-file-details > summary)',
        );
        choice?.focus({ preventScroll: true });
        if (choice && doc.activeElement === choice)
          choice.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      status.textContent = 'Choose a video to play.';
      status.dataset.passive = 'true';
    }, 'Loading saved videos…');
  }

  function favorite(title: ArchiveTitle): Promise<void> {
    if (
      !host.onFavorite ||
      favoriteBusy ||
      revision === null ||
      !page?.items.some((item) => item.titleRef === title.titleRef)
    )
      return Promise.resolve();

    const expectedRevision = revision;
    const retainedTitle = expanded;
    const retainedFiles = files;
    const retainedCount = page.items.length;

    favoriteBusy = true;

    render();

    return run(async (signal, owner, scope) => {
      const receipt = await host.onFavorite!(title, expectedRevision, !title.favorite, signal);

      if (!current(owner, scope, signal)) return;

      revision = receipt.revision;

      let result = await catalog.query(
        {
          schemaVersion: 1,

          query: savedQuery,

          expectedRevision: revision,

          offset: 0,

          pageSize: 50,

          ...browseOptions(),
        },

        signal,
      );

      if (!current(owner, scope, signal)) return;

      // Refresh only the already loaded extent after favorite ordering changes.
      while (result.more && result.items.length < retainedCount) {
        const next = await catalog.query(
          {
            schemaVersion: 1,
            query: savedQuery,
            expectedRevision: receipt.revision,
            offset: result.items.length,
            pageSize: 50,
            ...browseOptions(),
          },
          signal,
        );
        if (!current(owner, scope, signal)) return;
        result = { ...next, offset: 0, items: [...result.items, ...next.items] };
      }
      const selected = result.items.find((item) => item.titleRef === retainedTitle);
      const refreshedFiles =
        selected && retainedFiles?.titleRef === selected.titleRef
          ? await catalog.files(
              {
                schemaVersion: 1,
                titleRef: selected.titleRef,
                expectedRevision: receipt.revision,
                offset: retainedFiles.offset,
                pageSize: 50,
              },
              signal,
            )
          : null;
      if (!current(owner, scope, signal)) return;

      const suggestions = await host.pendingFiles?.(
        result.revision,
        0,
        savedQuery,
        signal,
        browseOptions().languageMode,
        browseOptions().contentType,
      );

      if (!current(owner, scope, signal)) return;

      pendingPage = suggestions ?? null;

      page = result;

      expanded = refreshedFiles?.titleRef ?? null;

      files = refreshedFiles;

      renderedOptions = JSON.stringify(browseOptions() ?? {});

      status.textContent = receipt.favorite
        ? 'Title saved to GenXtra favorites.'
        : 'Title removed from GenXtra favorites.';
    }, 'Saving GenXtra favorite…').finally(() => {
      favoriteBusy = false;

      if (!closed && enabled) render();
    });
  }

  function choose(title: ArchiveTitle, file: ArchiveFile): Promise<void> {
    if (
      selecting ||
      removalBusy ||
      closed ||
      !enabled ||
      !files ||
      files.revision !== revision ||
      files.titleRef !== title.titleRef ||
      file.availability === 'dead' ||
      file.providerFacts?.playbackCandidate === false
    )
      return selecting ?? Promise.resolve();

    const scope = host.readyScope();

    if (
      scope === null ||
      revision === null ||
      !files.files.some((entry) => entry.fileRef === file.fileRef)
    )
      return Promise.resolve();

    const owned = new AbortController();

    selectionAbort = owned;

    const expectedRevision = revision;
    const focusQuery = savedQuery;
    const focusOptions = JSON.stringify(browseOptions());
    const focusGeneration = generation;
    let returnFocus =
      doc.activeElement instanceof HTMLElement &&
      doc.activeElement.matches('.gx-archive-file-button') &&
      doc.activeElement.dataset.archiveRef === file.fileRef;
    const selectionInput = (event: Event) => {
      const target = event.target instanceof Element ? event.target : null;
      if (!target || target.closest('[inert]')) return;
      const modal = Array.from(doc.querySelectorAll<HTMLDialogElement>('dialog[open]')).at(-1);
      if (modal && !modal.contains(target)) return;
      if (target.closest('.archive-resume-dialog[open]')) return;
      returnFocus = false;
    };
    const focusInputs = ['pointerdown', 'keydown', 'wheel'] as const;
    for (const name of focusInputs) doc.addEventListener(name, selectionInput, true);

    selectionIdentity = {
      titleRef: title.titleRef,
      fileRef: file.fileRef,
      expectedRevision,
      title: title.title,
      fileTitle: file.title,
    };

    status.textContent = 'Opening selected Archive file…';
    status.dataset.passive = 'false';

    const work = Promise.resolve().then(async () => {
      try {
        if (closed || !enabled || owned.signal.aborted || host.readyScope() !== scope) return;
        await host.onSelect(
          {
            titleRef: title.titleRef,

            fileRef: file.fileRef,

            expectedRevision,

            title: title.title,

            fileTitle: file.title,
          },

          owned.signal,
        );

        if (!closed && enabled && !owned.signal.aborted && host.readyScope() === scope) {
          status.textContent = 'File selected. Keep browsing or search for another title.';
          status.dataset.passive = 'true';
        }
      } catch (error) {
        if (owned.signal.aborted && !isAbort(error)) cleanupFailed = true;

        if (!closed && enabled && !owned.signal.aborted && host.readyScope() === scope) {
          status.dataset.passive = 'false';
          status.textContent = isAbort(error)
            ? 'Playback canceled. Choose a video when ready.'
            : archivePlayerFailureGuidance(error);
        }
      } finally {
        for (const name of focusInputs) doc.removeEventListener(name, selectionInput, true);
        if (selecting === work) {
          selecting = null;

          selectionAbort = null;

          selectionIdentity = null;

          if (!closed && enabled) {
            render();
            if (
              returnFocus &&
              !doc.querySelector('dialog[open]') &&
              !owned.signal.aborted &&
              host.readyScope() === scope &&
              generation === focusGeneration &&
              revision === expectedRevision &&
              savedQuery === focusQuery &&
              JSON.stringify(browseOptions()) === focusOptions &&
              expanded === title.titleRef &&
              episodesOpen &&
              files?.titleRef === title.titleRef &&
              files.revision === expectedRevision
            ) {
              const target = Array.from(
                list.querySelectorAll<HTMLButtonElement>('.gx-archive-file-button:not(:disabled)'),
              ).find((button) => button.dataset.archiveRef === file.fileRef);
              if (target && !target.closest('[hidden],[inert]') && target.getClientRects().length) {
                target.focus({ preventScroll: true });
                target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
              }
            }
          }
        }
      }
    });

    selecting = work;

    render();

    return work;
  }

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

  const navigateControls: EventListener = (event) => {
    if (!(event instanceof KeyboardEvent)) return;
    const source = event.target instanceof HTMLElement ? event.target : null;
    const row = source?.closest<HTMLElement>('.gx-archive-result-row');
    const inline = source?.closest<HTMLElement>('.gx-archive-inline-videos');
    const fileRow = source?.closest<HTMLElement>('.gx-archive-file-row');
    const playColumn = source?.matches('.gx-archive-file-button');
    const moreColumn = source?.matches('.gx-archive-file-details > summary');
    if (source && inline && row && fileRow && (playColumn || moreColumn)) {
      let target: HTMLElement | null | undefined;
      if (playColumn && event.key === 'ArrowRight')
        target = fileRow.querySelector<HTMLElement>('.gx-archive-file-details > summary');
      else if (moreColumn && event.key === 'ArrowLeft')
        target =
          fileRow.querySelector<HTMLButtonElement>('.gx-archive-file-button:not(:disabled)') ??
          row.querySelector<HTMLButtonElement>('.gx-archive-title-button');
      else if (
        ['ArrowUp', 'ArrowDown'].includes(event.key) &&
        !(moreColumn && event.key === 'ArrowDown' && source.closest('details')?.open)
      ) {
        const fileRows = Array.from(inline.querySelectorAll<HTMLElement>('.gx-archive-file-row'));
        const step = event.key === 'ArrowDown' ? 1 : -1;
        for (
          let index = fileRows.indexOf(fileRow) + step;
          index >= 0 && index < fileRows.length;
          index += step
        ) {
          target = fileRows[index]?.querySelector<HTMLElement>(
            playColumn
              ? '.gx-archive-file-button:not(:disabled)'
              : '.gx-archive-file-details > summary',
          );
          if (target) break;
        }
        if (!target)
          target =
            step < 0
              ? row.querySelector<HTMLButtonElement>('.gx-archive-title-button')
              : (inline.querySelector<HTMLButtonElement>(
                  '.gx-archive-paging button:not(:disabled)',
                ) ??
                row.nextElementSibling?.querySelector<HTMLButtonElement>(
                  '.gx-archive-title-button',
                ));
        // The edge remains in the owned list; Left always returns to its title.
        event.preventDefault();
        event.stopPropagation();
        if (target) {
          target.focus({ preventScroll: true });
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        }
        return;
      }
      if (target) {
        event.preventDefault();
        event.stopPropagation();
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        return;
      }
    }
    if (inline && row && ['ArrowLeft', 'Escape'].includes(event.key)) {
      const titleButton = row.querySelector<HTMLButtonElement>('.gx-archive-title-button');
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        dismissEpisodes();
      } else revealResultTitle(titleButton);
      return;
    }
    if (
      row &&
      source?.matches('.gx-archive-title-button,.gx-archive-favorite') &&
      root.contains(row) &&
      ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)
    ) {
      let target: HTMLButtonElement | null | undefined;
      if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const rowControls = Array.from(
          row.querySelectorAll<HTMLButtonElement>('.gx-archive-title-button,.gx-archive-favorite'),
        );
        target =
          rowControls[
            rowControls.indexOf(source as HTMLButtonElement) + (event.key === 'ArrowRight' ? 1 : -1)
          ];
      } else {
        if (event.key === 'ArrowDown' && source.matches('.gx-archive-title-button')) {
          const firstPlay = row.querySelector<HTMLButtonElement>(
            '.gx-archive-inline-videos:not([hidden]) :is(.gx-archive-file-button:not(:disabled),.gx-archive-file-details > summary)',
          );
          if (firstPlay) {
            event.preventDefault();
            event.stopPropagation();
            firstPlay.focus({ preventScroll: true });
            firstPlay.scrollIntoView({ block: 'nearest', inline: 'nearest' });
            return;
          }
        }
        const rows = Array.from(list.querySelectorAll<HTMLElement>('.gx-archive-result-row'));
        const neighbor = rows[rows.indexOf(row) + (event.key === 'ArrowDown' ? 1 : -1)];
        if (!neighbor && event.key === 'ArrowDown' && page?.more && abort === null) {
          const identity = source?.dataset.archiveRef;
          const count = rows.length;
          const favorite = source?.matches('.gx-archive-favorite');
          event.preventDefault();
          event.stopPropagation();
          void appendSavedTitles().then(() => {
            if (
              !(doc.activeElement instanceof HTMLElement) ||
              doc.activeElement.dataset.archiveRef !== identity
            )
              return;
            const nextRow = list.querySelectorAll<HTMLElement>('.gx-archive-result-row')[count];
            const action = nextRow?.querySelector<HTMLButtonElement>(
              favorite ? '.gx-archive-favorite' : '.gx-archive-title-button',
            );
            action?.focus({ preventScroll: true });
            action?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          });
          return;
        }
        target = neighbor?.querySelector<HTMLButtonElement>(
          source?.matches('.gx-archive-favorite')
            ? '.gx-archive-favorite'
            : '.gx-archive-title-button',
        );
      }
      if (target && !target.disabled) {
        event.preventDefault();
        event.stopPropagation();
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return;
    }
    if (event.key === 'ArrowLeft' && source && detailPane.contains(source)) {
      const selected = list.querySelector<HTMLButtonElement>(
        '.gx-archive-title-button[aria-current="true"]',
      );
      if (selected) {
        event.preventDefault();
        event.stopPropagation();
        selected.focus({ preventScroll: true });
        selected.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return;
    }
    if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    const parent = inline ?? (event.currentTarget as HTMLElement);
    const controls = Array.from(parent.querySelectorAll<HTMLElement>('button, summary')).filter(
      (node) => {
        if (
          node.matches(':disabled, [aria-disabled="true"]') ||
          node.closest('[hidden], [inert]') ||
          !node.getClientRects().length
        )
          return false;
        const style = doc.defaultView!.getComputedStyle(node);
        if (
          style.display === 'none' ||
          style.visibility === 'hidden' ||
          style.visibility === 'collapse'
        )
          return false;
        let ancestor = node.parentElement;
        while (ancestor) {
          if (ancestor instanceof HTMLDetailsElement && !ancestor.open) {
            const summary = Array.from(ancestor.children).find(
              (child) => child.tagName === 'SUMMARY',
            );
            if (!summary?.contains(node)) return false;
          }
          // The event owner can itself be a closed disclosure (Settings
          // management). Its hidden children must not consume boundary keys.
          if (ancestor === parent) break;
          ancestor = ancestor.parentElement;
        }
        return true;
      },
    );
    const index = controls.indexOf(doc.activeElement as HTMLElement);
    if (index < 0) return;
    const nextIndex = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (inline && row && nextIndex < 0) {
      event.preventDefault();
      event.stopPropagation();
      revealResultTitle(row.querySelector<HTMLButtonElement>('.gx-archive-title-button'));
      return;
    }
    if (inline && row && nextIndex === controls.length) {
      const nextRow = row.nextElementSibling;
      const nextTitle = nextRow?.querySelector<HTMLButtonElement>('.gx-archive-title-button');
      if (nextTitle) {
        event.preventDefault();
        event.stopPropagation();
        nextTitle.focus({ preventScroll: true });
        nextTitle.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
      return;
    }
    if (nextIndex >= 0 && nextIndex < controls.length) {
      event.preventDefault();
      event.stopPropagation();
      const target = controls[nextIndex]!;
      target.focus({ preventScroll: true });
      if (doc.activeElement === target)
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  };
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

  const api = {
    dismissFilters,
    dismissEpisodes,
    get queryText() {
      return savedQuery;
    },

    get catalogRevision() {
      return revision;
    },

    query(query = host.input.value): Promise<void> {
      const changed =
        query !== savedQuery || renderedOptions !== JSON.stringify(browseOptions() ?? {});
      savedQuery = query;
      if (changed) {
        page = null;

        pendingPage = null;

        expanded = null;

        files = null;

        render();
      }

      return queryAt();
    },

    searchProgress(query: string, checked: number): void {
      if (
        !activeOnlineSearch ||
        activeOnlineSearch.intent !== onlineSearchIntent ||
        activeOnlineSearch.scope !== host.readyScope() ||
        activeOnlineSearch.query !== query ||
        query !== savedQuery ||
        !enabled ||
        closed ||
        abort?.signal.aborted ||
        !Number.isSafeInteger(checked) ||
        checked < 0
      )
        return;
      resultSummary.textContent = `Searching… ${checked} checked`;
    },
    async searchOnline(_intent?: 'search' | 'continue'): Promise<void> {
      const requested = ++onlineSearchIntent;
      const query = host.input.value;
      const rootScope = host.readyScope();
      const capturedOptions = JSON.stringify(browseOptions());
      // Search first exposes local results. Typing/resume use query() only and never discover.
      await api.query(query);
      if (
        requested !== onlineSearchIntent ||
        closed ||
        !enabled ||
        rootScope === null ||
        rootScope !== host.readyScope() ||
        savedQuery !== query ||
        host.input.value !== query ||
        JSON.stringify(browseOptions()) !== capturedOptions
      )
        return;

      if (!host.discover) {
        status.dataset.passive = 'false';
        if (enabled) status.textContent = 'Online Archive search is unavailable.';

        return Promise.resolve();
      }

      if (query.trim()) void series?.show(query.trim());
      else series?.clear();
      const options = browseOptions();
      const view: ArchiveDiscoveryView = {
        schemaVersion: 1,
        languageMode: options.languageMode,
        favoritesOnly: options.favoritesOnly ?? false,
        curatedOnly: false,
        ...(options.contentType === undefined ? {} : { contentType: options.contentType }),
      };

      const key = JSON.stringify([continuationKey(), rootScope]);
      const intent = continuationContext === key ? 'continue' : 'search';
      continuationContext = key;
      activeOnlineSearch = { intent: requested, scope: rootScope, query };
      resultSummary.textContent = 'Searching…';
      return run(async (signal, owner, scope) => {
        const receipt = await host.discover!(savedQuery, signal, intent, view);

        if (!archiveRevision(receipt.revision))
          throw new Error('Archive discovery receipt is invalid.');

        if (!current(owner, scope, signal)) return;

        revision = receipt.revision;

        const result = await catalog.query(
          {
            schemaVersion: 1,

            query: savedQuery,

            expectedRevision: revision,

            offset: 0,

            pageSize: 50,

            ...browseOptions(),
          },

          signal,
        );

        if (!current(owner, scope, signal)) return;

        const suggestions = await host.pendingFiles?.(
          result.revision,
          0,
          savedQuery,
          signal,
          browseOptions().languageMode,
          browseOptions().contentType,
        );

        if (!current(owner, scope, signal)) return;

        pendingPage = suggestions ?? null;

        page = result;

        renderedOptions = JSON.stringify(browseOptions() ?? {});

        expanded = null;

        files = null;

        render();

        if (Number.isSafeInteger(receipt.examined) && receipt.examined! >= 0)
          resultSummary.textContent += ` · ${receipt.examined} checked`;
        status.textContent =
          receipt.outcome === 'waiting'
            ? 'Search paused. Try Search later.'
            : receipt.outcome === 'capacity'
              ? 'Try a different search for more videos.'
              : receipt.outcome === 'canceled'
                ? 'Search canceled. Search again when ready.'
                : result.totalCount
                  ? 'Choose a title to see its videos.'
                  : pendingPage?.totalCount
                    ? 'More items remain to check.'
                    : receipt.outcome === 'partial'
                      ? 'No matching saved videos yet. Search again to continue.'
                      : 'No matching saved videos. Try another search.';
        status.dataset.passive = String(
          result.totalCount > 0 &&
            !['waiting', 'capacity', 'canceled'].includes(receipt.outcome ?? ''),
        );
      }, 'Searching…').finally(() => {
        if (activeOnlineSearch?.intent === requested) activeOnlineSearch = null;
      });
    },

    resume(query = savedQuery): Promise<void> {
      if (closed) return Promise.resolve();
      const preserve =
        query === savedQuery &&
        page !== null &&
        renderedOptions === JSON.stringify(browseOptions() ?? {});
      savedQuery = query;
      if (!preserve) {
        page = null;
        pendingPage = null;
        expanded = null;
        files = null;
      }
      enabled = true;
      root.hidden = false;
      render();

      return queryAt(preserve ? page!.offset : 0, preserve);
    },

    async suspend(options?: { preserveSelection?: boolean }): Promise<void> {
      dismissFilters(false);
      enabled = false;

      root.hidden = true;

      confirmation = null;

      render();

      await cancelWork(options?.preserveSelection === true);
      await downloadsView?.suspend(options?.preserveSelection === true);
    },

    cancel: cancelWork,

    syncDetails: syncDetailsHost,

    /** Bounded resource evidence only: opaque identities and counters, never encoded data or URLs. */
    artworkSnapshot() {
      const reserved = [...artworkActive.keys()].filter((key) => !artworkCache.has(key)).length;
      return Object.freeze({
        cacheEntries: artworkCache.size,
        compressedBytes: artworkBytes,
        active: artworkActive.size,
        queued: artworkQueue.size,
        reservedImages: reserved,
        retainedImageBound: artworkCache.size + reserved,
        retainedCompressedByteBound: artworkBytes + reserved * 524288,
        bindings: [...artworkBindings.values()].reduce((sum, nodes) => sum + nodes.size, 0),
        offscreenRowBindings: [...artworkBindings.values()]
          .flatMap((nodes) => [...nodes.keys()])
          .filter(
            (node) => !artworkVisible.has(node) && !node.matches('.gx-archive-detail-artwork'),
          ).length,
        cacheKeys: [...artworkCache].map(([key, value]) => {
          const [, revision, titleRef] = JSON.parse(key) as [string, string, string];
          return Object.freeze({ titleRef, revision, artworkRef: value?.artworkRef ?? null });
        }),
      });
    },

    dispose(): Promise<void> {
      if (disposePromise) return disposePromise;
      dismissFilters(false);

      closed = true;

      enabled = false;

      root.hidden = true;
      series?.dispose();

      disposePromise = (async () => {
        await cancelWork();
        await downloadsView?.dispose();

        for (const owner of controls)
          owner.node.removeEventListener(owner.type, owner.listener, owner.capture);

        controls.length = 0;

        root.remove();
        artworkObserver?.disconnect();
        artworkCache.clear();
        artworkBindings.clear();
        artworkVisible.clear();
        artworkBytes = 0;
        detailPane.remove();
        if (host.detailsContainer) host.detailsContainer.hidden = true;

        management.remove();
      })().catch((error: unknown) => {
        disposePromise = null;

        throw error;
      });

      return disposePromise;
    },
  };

  return api;
}
