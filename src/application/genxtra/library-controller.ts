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
/**
 * Switching between the live channel list and GenXtra (the public archive):
 * showing a library, restoring its pane, remembering the choice, GenXtra's
 * discovery results and filters. Moved out of main.ts; main.ts passes the
 * shared state it owns through the environment.
 */
import { createArchiveDiscovery, type ArchiveDiscoverySnapshot } from './archive-discovery';
import { archiveDiscoveryStatus } from '../../ui/genxtra/archive-discovery-status';
import { mountArchiveSearch } from '../../ui/genxtra/archive-search';
import { lookupSeriesIdentity } from '../../platform/series-identity';
import { type ArchiveSelection, type createArchiveCatalog } from '../../platform/archive-catalog';
import { ArchiveFileRemovedError, type createArchivePlayer } from './archive-player';
import { type ContentLibrary } from './content-library';
import { type createLibraryState } from './library-state';
import { type createDiagnostics } from '../../diagnostics/native';
import { type installVODDock } from '../../ui/player/vod-dock';
import { type installCategoryMenu } from '../../ui/channels/category-menu';
import { type createPageState } from '../shell/page-state';
import { type mountGuide } from '../../ui/guide/guide';
import { type createScanController } from '../discovery/scan-controller';
import { type createArchiveDownloads } from './archive-downloads';
import { type PlaybackController } from '../../playback/controller';
import { type installInAppSelects } from '../../ui/shell/in-app-select';
import { type PrimaryPage } from '../shell/primary-page';
import { type createChannelLogos } from '../catalog/channel-logos';
import { type ChannelBrowser } from '../../ui/channels/channel-browser';
import { type Preferences, type SerializedPreferencesStore } from '../../preferences';

const libraryOperationNames = [
  'guide',
  'archive-search',
  'archive-discovery',
  'source-entry',
  'source-scan',
  'live-browse',
  'archive-read',
  'source-resume',
] as const;
export type LibraryOperationName = (typeof libraryOperationNames)[number];

/** What this area reads from, and writes back to, the rest of the application. */
export interface LibraryEnvironment {
  readonly archiveRuntimeScope: () => string | null;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  archiveSearch: ReturnType<typeof mountArchiveSearch> | undefined;
  readonly archiveCatalog: ReturnType<typeof createArchiveCatalog>;
  readonly diagnostics: ReturnType<typeof createDiagnostics>;
  readonly archiveDownloads: ReturnType<typeof createArchiveDownloads> | undefined;
  readonly clearArchiveResume: () => void;
  readonly archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
  readonly player: PlaybackController;
  readonly archiveActiveScope: () => string | null;
  readonly playbackAction: (work: Promise<unknown>) => void;
  readonly libraryQueries: Record<ContentLibrary, string>;
  readonly vodDock: ReturnType<typeof installVODDock>;
  readonly categoryMenu: ReturnType<typeof installCategoryMenu>;
  readonly televisionSelects: ReturnType<typeof installInAppSelects> | undefined;
  readonly presentPrimaryPage: (page: PrimaryPage) => void;
  readonly pageState: ReturnType<typeof createPageState>;
  readonly liveBrowseJobs: Map<AbortController, Promise<unknown>>;
  readonly channelLogos: ReturnType<typeof createChannelLogos> | undefined;
  readonly applicationClosing: boolean;
  readonly nativeViewingForeground: boolean;
  readonly backgroundSuspension: Promise<void> | null;
  readonly renderCatalog: () => void;
  readonly browser: ChannelBrowser;
  readonly preferences: SerializedPreferencesStore;
  readonly transferBusy: boolean;
  settings: Preferences;
  readonly notice: (message: string) => void;
  readonly guide: ReturnType<typeof mountGuide>;
  readonly sourceScan: ReturnType<typeof createScanController>['sourceScan'];
}

export function createLibraryController(env: LibraryEnvironment) {
  function recordArchiveRevision(revision: string): void {
    if (
      env.archiveRuntimeScope() !== null &&
      (env.library.archiveIndexRevision === null ||
        BigInt(revision) >= BigInt(env.library.archiveIndexRevision))
    )
      env.library.archiveIndexRevision = revision;
  }
  function renderArchiveDiscovery(snapshot: Readonly<ArchiveDiscoverySnapshot>): void {
    const status = env.element('genxtra-discovery-progress');
    const presentation = archiveDiscoveryStatus(snapshot, { nowEpochMs: Date.now() });
    status.hidden =
      env.library.contentLibrary !== 'genxtra' ||
      snapshot.query !== env.element<HTMLInputElement>('search').value.trim() ||
      snapshot.decade !== env.library.archiveDecade ||
      presentation.hidden;
    status.textContent = status.hidden ? '' : presentation.text;
    // Full counters remain optional metadata, rather than a second visible status block.
    status.dataset.discoveryDetails = status.hidden ? '' : presentation.details;
    if (!status.hidden) env.archiveSearch?.searchProgress(snapshot.query, snapshot.examined);
  }
  const publicProviderDiagnosticStates = new Map<string, string>();
  const archiveDiscovery = createArchiveDiscovery({
    catalog: env.archiveCatalog,
    readyScope: env.archiveRuntimeScope,
    progress: renderArchiveDiscovery,
    committed: (receipt) => recordArchiveRevision(receipt.revision),
    publicCommitted: (receipt) => {
      recordArchiveRevision(receipt.revision);
      const unavailableCodes = {
        loc: 'application-archive-loc-unavailable',
        nasa: 'application-archive-nasa-unavailable',
        commons: 'application-archive-commons-unavailable',
      } as const;
      for (const provider of receipt.providers) {
        const state = `${provider.state}:${provider.reason ?? ''}`;
        const previous = publicProviderDiagnosticStates.get(provider.providerId);
        publicProviderDiagnosticStates.set(provider.providerId, state);
        if (previous === state) continue;
        if (provider.state === 'configuration-required' && provider.providerId === 'commons')
          void env.diagnostics.emit({
            operation: 'application',
            level: 'warning',
            code: 'application-archive-commons-identification-required',
          });
        else if (provider.state === 'failed' || provider.state === 'waiting')
          void env.diagnostics.emit({
            operation: 'application',
            level: 'warning',
            code: unavailableCodes[provider.providerId],
          });
      }
    },
  });
  env.archiveSearch = mountArchiveSearch(env.element('genxtra-library'), {
    downloads: env.archiveDownloads,
    seriesLookup: lookupSeriesIdentity,
    onPlaySaved: async (entry, revision, signal) => {
      env.clearArchiveResume();
      await env.archivePlayer!.selectSaved(entry, revision, signal);
    },
    detailsContainer: env.element('archive-details'),
    playbackActive: () =>
      env.player.snapshot.selection !== null &&
      env.player.snapshot.state !== 'idle' &&
      env.player.snapshot.state !== 'disposed',
    onTitleSelected: () => {
      if (env.element('app').classList.contains('compact-content')) {
        env.element<HTMLSelectElement>('compact-view').value = 'watch';
        env.element('compact-view').dispatchEvent(new Event('change'));
      }
    },
    managementContainer:
      document.querySelector<HTMLElement>('[data-settings-panel="sources"]') ?? undefined,
    onRemove: async (target, expectedRevision, signal) => {
      const scope = env.archiveRuntimeScope();
      const check = () => {
        signal.throwIfAborted();
        if (scope === null || env.archiveRuntimeScope() !== scope)
          throw new DOMException('Canceled', 'AbortError');
      };
      check();
      // Join discovery originals, including late durable receipts, before mutation.
      // If discovery advanced the revision, native CAS refuses this stale choice.
      await archiveDiscovery.suspend();
      check();
      const matches = (choice: ArchiveSelection) =>
        !choice.downloadRef &&
        (target.kind === 'library' ||
          (choice.titleRef === target.titleRef &&
            (target.kind === 'title' || choice.fileRef === target.fileRef)));
      const selected = env.archivePlayer!.selection;
      if (selected && matches(selected)) await env.archivePlayer!.stop();
      if (env.library.archiveResumeChoice && matches(env.library.archiveResumeChoice))
        env.clearArchiveResume();
      check();
      const receipt = await env.archiveCatalog.remove(
        target,
        { schemaVersion: 1, expectedRevision, explicitAction: true },
        signal,
      );
      // COMMIT truth survives a late abort, but never crosses a replaced storage root.
      if (env.archiveRuntimeScope() === scope) recordArchiveRevision(receipt.revision);
      return receipt;
    },
    input: env.element<HTMLInputElement>('search'),
    catalog: env.archiveCatalog,
    readyScope: env.archiveActiveScope,
    queryOptions: () => ({
      decade: env.library.archiveDecade,
      favoritesOnly: env.library.archiveFavoritesOnly,
      contentType: env.library.archiveContentType,
    }),
    clearFilters: () =>
      env.playbackAction(
        changeArchiveFilter(() => {
          env.library.archiveDecade = null;
          env.library.archiveContentType = 'all';
          env.libraryQueries.genxtra = '';
          env.element<HTMLInputElement>('search').value = '';
          env.element('clear-search').hidden = true;
        }),
      ),
    artwork: (request, signal) => env.archiveCatalog.artwork(request, signal),
    pendingFiles: (expectedRevision, offset, query, signal, languageMode, contentType) =>
      env.archiveCatalog.itemFilesProgress(
        {
          schemaVersion: 1,
          expectedRevision,
          offset,
          pageSize: 5,
          query,
          decade: env.library.archiveDecade,
          favoritesOnly: env.library.archiveFavoritesOnly,
          languageMode,
          contentType: contentType ?? env.library.archiveContentType,
        },
        signal,
      ),
    loadFiles: async (progress, expectedRevision, signal) => {
      const receipt = await env.archiveCatalog.itemFilesStep(
        {
          schemaVersion: 1,
          titleRef: progress.titleRef,
          expectedRevision,
          expectedOffset: progress.nextOffset,
          explicitAction: true,
        },
        signal,
      );
      recordArchiveRevision(receipt.revision);
      return receipt;
    },
    onSelect: async (selection, signal) => {
      recordArchiveRevision(selection.expectedRevision);
      env.clearArchiveResume();
      try {
        await env.archivePlayer!.select(selection, signal);
      } catch (error) {
        if (error instanceof ArchiveFileRemovedError) {
          recordArchiveRevision(error.receipt.revision);
          throw new Error(
            'This file was confirmed unavailable and removed from playable results.',
            {
              cause: error,
            },
          );
        }
        throw error;
      }
    },
    onFavorite: async (title, expectedRevision, value, signal) => {
      const receipt = await env.archiveCatalog.setFavorite(
        { schemaVersion: 1, titleRef: title.titleRef, expectedRevision, value },
        signal,
      );
      recordArchiveRevision(receipt.revision);
      return receipt;
    },
    discover: async (query, signal, intent, view) => {
      const result = await archiveDiscovery.discover(
        query,
        signal,
        intent ?? 'search',
        env.library.archiveDecade,
        view,
      );
      recordArchiveRevision(result.revision);
      return result;
    },
  });
  Object.defineProperty(window, '__GENX_ARCHIVE_ARTWORK__', {
    get: () => env.archiveSearch?.artworkSnapshot() ?? null,
  });
  function presentLibrary(): void {
    const extra = env.library.contentLibrary === 'genxtra';
    env.element('app').dataset.contentLibrary = env.library.contentLibrary;
    env.vodDock.render(
      env.player.snapshot.selection
        ? env.player.snapshot.selection.playMode === 'on-demand'
        : extra,
    );
    env.element('genxtra-library').hidden = !extra;
    env.archiveSearch?.syncDetails();
    if (!extra) env.element('archive-details').hidden = true;
    env.element('genxtra-browse-filters').hidden = !extra;
    env.element('genxtra-filter-status').hidden = !extra;
    env.element('genxtra-discovery-progress').hidden =
      !extra || archiveDiscovery.snapshot.state === 'idle';
    const liveFilters = env
      .element('channel-list')
      .parentElement?.querySelector<HTMLElement>('.browse-options .filters');
    if (liveFilters) {
      // The category list (category-menu.ts) owns hidden on TV and Windows.
      liveFilters.dataset.libraryHidden = String(extra);
      if (env.categoryMenu) env.categoryMenu.sync();
      else liveFilters.hidden = extra;
    }
    env
      .element('search')
      .setAttribute(
        'aria-label',
        extra ? 'Search saved GenXtra shows and movies' : 'Search channels and programs',
      );
    env.element('search-programs').title = extra
      ? 'Search shows and movies online'
      : 'Find channels online';
    env.element<HTMLInputElement>('search').placeholder = extra
      ? 'Search shows and movies'
      : 'Search channels or programs';
    env
      .element('search-programs')
      .setAttribute('aria-label', extra ? 'Search GenXtra online' : 'Find channels online');
    env.element('genxtra-filter-status').textContent =
      `${env.library.archiveDecade === 2020 ? '20s+' : env.library.archiveDecade ? `${String(env.library.archiveDecade).slice(2)}s` : 'All years'}${env.library.archiveFavoritesOnly ? ' · Favorites' : ''} · Source-listed years`;
    env.element<HTMLSelectElement>('genxtra-kind-select').value = env.library.archiveFavoritesOnly
      ? 'favorites'
      : env.library.archiveContentType;
    env.element<HTMLSelectElement>('genxtra-decade-select').value =
      env.library.archiveDecade === null ? 'all' : String(env.library.archiveDecade);
    env.televisionSelects?.refresh();
    env.presentPrimaryPage(env.pageState.primaryPage);
    if (
      env.player.snapshot.state === 'idle' &&
      !env.player.snapshot.selection &&
      !env.library.archiveBackgroundPaused
    ) {
      env.element('overlay-title').textContent = extra
        ? 'Your next favorite show.'
        : 'Your next favorite channel.';
      env.element('overlay-message').textContent = extra
        ? 'Browse a decade, or search for shows and movies.'
        : 'Choose a channel, or use channel search to discover more.';
    }
    renderArchiveDiscovery(archiveDiscovery.snapshot);
  }
  async function joinLiveBrowse(): Promise<void> {
    for (const owner of env.liveBrowseJobs.keys()) owner.abort();
    const results = await Promise.allSettled([
      ...env.liveBrowseJobs.values(),
      env.channelLogos?.suspend(),
    ]);
    if (
      results.some(
        (result) =>
          result.status === 'rejected' &&
          !(result.reason instanceof DOMException && result.reason.name === 'AbortError'),
      )
    )
      throw new Error('Channel browsing cleanup could not be confirmed.');
  }
  let libraryTransitionStage:
    | 'idle'
    | 'queued'
    | 'draining'
    | 'opening'
    | 'saving'
    | 'restoring'
    | 'completed'
    | 'refused'
    | 'failed' = 'idle';
  let libraryTransitionActive = 0,
    libraryTransitionPending = 0,
    libraryTransitionErrors = 0,
    libraryTransitionRevision = 0;
  const libraryPendingDrains = new Set<LibraryOperationName>(),
    libraryFailedDrains = new Set<LibraryOperationName>();
  function observeLibrary(stage: typeof libraryTransitionStage): void {
    libraryTransitionStage = stage;
    libraryTransitionRevision = Math.min(Number.MAX_SAFE_INTEGER, libraryTransitionRevision + 1);
  }
  function trackLibraryOperation(
    name: LibraryOperationName,
    task: () => Promise<unknown> | void,
  ): Promise<void> {
    libraryPendingDrains.add(name);
    libraryTransitionRevision = Math.min(Number.MAX_SAFE_INTEGER, libraryTransitionRevision + 1);
    return Promise.resolve()
      .then(task)
      .then(
        () => undefined,
        (error) => {
          libraryFailedDrains.add(name);
          throw error;
        },
      )
      .finally(() => {
        libraryPendingDrains.delete(name);
        libraryTransitionRevision = Math.min(
          Number.MAX_SAFE_INTEGER,
          libraryTransitionRevision + 1,
        );
      });
  }
  Object.defineProperty(window, '__GENX_LIBRARY_TRANSITION__', {
    configurable: false,
    get: () =>
      Object.freeze({
        schemaVersion: 1,
        generation: env.library.libraryIntent,
        revision: libraryTransitionRevision,
        stage: libraryTransitionStage,
        active: libraryTransitionActive !== 0,
        activeIntent: libraryTransitionActive,
        pending: libraryTransitionPending > 0,
        queued: libraryTransitionPending > (libraryTransitionActive ? 1 : 0),
        errorCount: libraryTransitionErrors,
        pendingPreferenceWrites: libraryPersistenceJobs.size,
        activePreferenceWrites: libraryPersistenceActive,
        preferenceErrorCount: libraryPersistenceErrors,
        unsavedLibraryChoice: libraryPersistenceUnsaved,
        pendingDrains: Object.freeze(
          libraryOperationNames.filter((name) => libraryPendingDrains.has(name)),
        ),
        failedDrains: Object.freeze(
          libraryOperationNames.filter((name) => libraryFailedDrains.has(name)),
        ),
      }),
  });
  async function restoreLibraryPane(previous: ContentLibrary, intent: number): Promise<void> {
    if (intent !== env.library.libraryIntent || env.applicationClosing) return;
    env.library.contentLibrary = previous;
    const active =
      env.element('app').dataset.ready === 'true' &&
      !document.hidden &&
      env.nativeViewingForeground &&
      !env.backgroundSuspension;
    env.library.liveBrowseSuspended = previous !== 'live' || !active;
    document.querySelector<HTMLElement>('.browser')!.inert = !active;
    env.presentPrimaryPage('watch');
    env.element<HTMLInputElement>('search').value = env.libraryQueries[previous];
    env.element('clear-search').hidden = !env.libraryQueries[previous];
    presentLibrary();
    if (!active) return;
    if (previous === 'live') {
      env.renderCatalog();
      env.browser.search(env.libraryQueries.live);
      env.element('channel-list').scrollTop = env.library.liveLibraryScroll;
    } else
      await trackLibraryOperation('archive-read', () =>
        env.archiveSearch!.resume(env.libraryQueries.genxtra),
      );
  }
  // Presentation and durable settings have distinct owners. A SQLite backup may
  // take time; its actual write remains retained without occupying navigation.
  let libraryPersistenceChoice = 0;
  let libraryPersistenceActive = 0;
  let libraryPersistenceErrors = 0;
  let libraryPersistenceUnsaved = false;
  const libraryPersistenceJobs = new Set<Promise<void>>();
  function persistLibraryChoice(next: ContentLibrary): void {
    const choice = ++libraryPersistenceChoice;
    const epoch = env.library.archiveStorageEpoch;
    libraryPersistenceUnsaved = true;
    let admitted = false;
    const work = env.preferences
      .update(
        (draft) => {
          draft.contentLibrary = next;
        },
        async () => {
          if (
            choice !== libraryPersistenceChoice ||
            epoch !== env.library.archiveStorageEpoch ||
            env.transferBusy
          )
            return false;
          admitted = true;
          libraryPersistenceActive++;
          return true;
        },
      )
      .then((saved) => {
        // A late COMMIT is durable truth. Updating metadata must never re-present
        // an obsolete pane or run applySettings behind a newer user selection.
        if (epoch === env.library.archiveStorageEpoch) env.settings = saved;
        if (choice === libraryPersistenceChoice && epoch === env.library.archiveStorageEpoch)
          libraryPersistenceUnsaved = false;
      })
      .catch((error: unknown) => {
        if (
          error instanceof DOMException &&
          error.name === 'AbortError' &&
          (choice !== libraryPersistenceChoice || epoch !== env.library.archiveStorageEpoch)
        )
          return;
        libraryPersistenceErrors = Math.min(Number.MAX_SAFE_INTEGER, libraryPersistenceErrors + 1);
        void env.diagnostics.emit({ operation: 'storage', level: 'error', code: 'storage-failed' });
        if (
          choice === libraryPersistenceChoice &&
          epoch === env.library.archiveStorageEpoch &&
          !env.applicationClosing
        )
          env.notice(
            'Your library choice wasn’t saved. Both tabs remain available; switch tabs to retry saving.',
          );
      })
      .finally(() => {
        if (admitted) libraryPersistenceActive--;
        libraryPersistenceJobs.delete(work);
        libraryTransitionRevision = Math.min(
          Number.MAX_SAFE_INTEGER,
          libraryTransitionRevision + 1,
        );
      });
    libraryPersistenceJobs.add(work);
    libraryTransitionRevision = Math.min(Number.MAX_SAFE_INTEGER, libraryTransitionRevision + 1);
  }
  async function joinLibraryPersistence(): Promise<void> {
    // Queued latest choices are owned too. Neither background nor Exit abandons
    // the original settings invoke or its native backup/publication work.
    while (libraryPersistenceJobs.size) await Promise.allSettled([...libraryPersistenceJobs]);
  }
  function switchLibrary(next: ContentLibrary, persist = true, focus = true): Promise<void> {
    if (
      next === env.library.contentLibrary &&
      env.pageState.primaryPage === 'watch' &&
      !libraryTransitionActive &&
      libraryTransitionPending === 0 &&
      !env.applicationClosing &&
      env.element('app').dataset.ready === 'true' &&
      !env.element('app').inert &&
      !document.querySelector<HTMLElement>('.browser')!.inert
    )
      return Promise.resolve();
    const opener = document.activeElement,
      intent = ++env.library.libraryIntent;
    env.library.liveBrowseSuspended = true;
    document.querySelector<HTMLElement>('.browser')!.inert = true;
    env.pageState.primaryIntent++;
    libraryTransitionPending++;
    if (!libraryTransitionActive) observeLibrary('queued');
    const work = env.pageState.primaryTransitions.then(async () => {
      libraryTransitionActive = intent;
      libraryFailedDrains.clear();
      const previous = env.library.contentLibrary;
      try {
        if (env.applicationClosing || env.element('app').dataset.ready !== 'true') {
          observeLibrary('refused');
          await restoreLibraryPane(previous, intent);
          return;
        }
        env.libraryQueries[previous] = env.element<HTMLInputElement>('search').value;
        if (previous === 'live')
          env.library.liveLibraryScroll = env.element('channel-list').scrollTop;
        observeLibrary('draining');
        // Every admitted drain settles before refusal/failure can restore a pane.
        const drains = await Promise.allSettled([
          trackLibraryOperation('guide', () => env.guide.close()),
          trackLibraryOperation('archive-search', () =>
            env.archiveSearch!.suspend({ preserveSelection: true }),
          ),
          trackLibraryOperation('archive-discovery', () => archiveDiscovery.suspend()),
          // Channel discovery and scans are background work: they keep running across
          // page switches (they never use the player) and pause only when the app does.
          trackLibraryOperation('live-browse', () => joinLiveBrowse()),
        ]);
        if (drains.some((result) => result.status === 'rejected'))
          throw new Error('Library cleanup failed.');
        if (
          intent !== env.library.libraryIntent ||
          env.applicationClosing ||
          document.hidden ||
          !env.nativeViewingForeground
        ) {
          observeLibrary('refused');
          await restoreLibraryPane(previous, intent);
          return;
        }
        observeLibrary('opening');
        env.library.contentLibrary = next;
        env.library.liveBrowseSuspended = next !== 'live';
        document.querySelector<HTMLElement>('.browser')!.inert = false;
        env.presentPrimaryPage('watch');
        env.element<HTMLInputElement>('search').value = env.libraryQueries[next];
        env.element('clear-search').hidden = !env.libraryQueries[next];
        presentLibrary();
        if (next === 'genxtra')
          await trackLibraryOperation('archive-read', () =>
            env.archiveSearch!.resume(env.libraryQueries.genxtra),
          );
        else {
          env.renderCatalog();
          env.browser.search(env.libraryQueries.live);
          env.element('channel-list').scrollTop = env.library.liveLibraryScroll;
          await trackLibraryOperation('source-resume', () => env.sourceScan.resume());
        }
        if (intent !== env.library.libraryIntent || env.applicationClosing) {
          observeLibrary('refused');
          await restoreLibraryPane(previous, intent);
          return;
        }
        if (persist) persistLibraryChoice(next);
        if (focus && document.activeElement === opener)
          env.element(next === 'genxtra' ? 'genxtra-button' : 'live-tv-button').focus({
            preventScroll: true,
          });
        observeLibrary('completed');
      } catch {
        libraryTransitionErrors = Math.min(Number.MAX_SAFE_INTEGER, libraryTransitionErrors + 1);
        observeLibrary('restoring');
        try {
          await restoreLibraryPane(previous, intent);
        } finally {
          observeLibrary('failed');
        }
        throw new Error(
          'The library switch could not finish. Your previous library is available; select the tab again to retry.',
        );
      } finally {
        libraryTransitionPending--;
        libraryTransitionActive = 0;
      }
    });
    env.pageState.primaryTransitions = work.catch(() => undefined);
    return work;
  }
  async function changeArchiveFilter(change: () => void): Promise<void> {
    if (env.library.contentLibrary !== 'genxtra' || env.applicationClosing) return;
    change();
    env.library.archiveFilterGeneration++;
    await archiveDiscovery.suspend();
    if (env.library.contentLibrary !== 'genxtra' || env.applicationClosing) return;
    presentLibrary();
    await env.archiveSearch!.query(env.libraryQueries.genxtra);
  }
  return {
    recordArchiveRevision,
    switchLibrary,
    archiveDiscovery,
    changeArchiveFilter,
    renderArchiveDiscovery,
    joinLiveBrowse,
    joinLibraryPersistence,
    presentLibrary,
  };
}
