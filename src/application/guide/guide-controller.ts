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
 * The program guide's automatic side: which guide sources are allowed and
 * discovered, connecting saved guide caches to channels, and the automatic
 * guide builder that runs after scans and refreshes. Moved out of main.ts;
 * main.ts passes the shared state it owns through the environment.
 */
import { type CatalogRecord, type Source } from '../../catalog';
import {
  createAutomaticGuidePermissions,
  previewPermittedAutomaticGuide,
  type AutomaticGuidePermission,
} from '../../guide/automatic-permissions';
import { automaticGuidePreferenceKey } from './automatic-guide-capture';
import { discoverPlaylistGuides } from '../../guide/discovery';
import { createGuideHost } from './guide-host';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { inspectSource, readGuideCaptureSnapshot } from '../../platform/records';
import {
  createChannelCategoryResolver,
  type Preferences,
  type SerializedPreferencesStore,
} from '../../preferences';
import { nativeGuide } from '../../guide/native';
import { captureAutomaticGuideInWorker } from './automatic-guide-capture-service';
import { createAutomaticGuideBuilder } from '../../guide/automatic-build';
import { readPackSuggestions } from '../../guide/pack-suggestions';
import { prioritizeGuideProviders } from '../../guide/provider-order';
import { createGuideAcquisitionAllowed, createGuideCacheReady } from './guide-cache';
import { createGuideMaintenance } from './guide-maintenance';
import { type mountGuide } from '../../ui/guide';
import { type createSharingHost } from '../sharing/sharing-host';
import { type createDiagnostics } from '../../diagnostics/native';
import { type createRendererRecoveryPolicy } from '../shell/renderer-recovery-policy';
import { type createScanController } from '../discovery/scan-controller';
import { type createVisibleGuideOwner } from './visible-guide';
import { type PlaybackController } from '../../playback/controller';

/** What this area reads from, and writes back to, the rest of the application. */
export interface GuideEnvironment {
  readonly settings: Preferences;
  readonly catalog: CatalogRecord;
  readonly visibleGuide: ReturnType<typeof createVisibleGuideOwner> | null;
  readonly guide: ReturnType<typeof mountGuide>;
  readonly wakeDailyRefresh: () => void;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly applicationClosing: boolean;
  readonly persistedCatalogRevision: string;
  readonly player: PlaybackController;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  readonly catalogWrites: Promise<unknown>;
  readonly preferences: SerializedPreferencesStore;
  readonly diagnostics: ReturnType<typeof createDiagnostics>;
  readonly rendererRecoveryPolicy: ReturnType<typeof createRendererRecoveryPolicy>;
  readonly nativeViewingForeground: boolean;
  readonly scanController: ReturnType<typeof createScanController>;
  readonly sourceScan: ReturnType<typeof createScanController>['sourceScan'];
}

export function createGuideController(env: GuideEnvironment) {
  let automaticGuidePreferenceSnapshot = '';
  let automaticGuideSourceSnapshot = '';
  const automaticGuideSourceKey = (sources: readonly Source[]) =>
    JSON.stringify(
      sources.map((source) => [
        source.id,
        source.kind,
        source.location,
        source.allowHttp === true,
        source.contentKind ?? null,
      ]),
    );
  let automaticGuideControlPending = 0;
  let automaticGuideRemovedSnapshot: readonly string[] = [];
  let automaticGuidePermissions: ReadonlyMap<string, AutomaticGuidePermission> = new Map();
  const automaticGuideScopeCurrent = () =>
    automaticGuidePreferenceSnapshot === automaticGuidePreferenceKey(env.settings) &&
    automaticGuideSourceSnapshot === automaticGuideSourceKey(env.catalog.sources) &&
    automaticGuideRemovedSnapshot.length === env.settings.removedChannels.length &&
    automaticGuideRemovedSnapshot.every((id, index) => id === env.settings.removedChannels[index]);
  let automaticGuideDiscovery: {
    key: string;
    result: Awaited<ReturnType<typeof discoverPlaylistGuides>>;
    retryAtMs: number;
  } | null = null;
  function guideChanged(): void {
    void env.visibleGuide?.refresh().catch(() => undefined);
    env.guide.catalogChanged(true);
    queueMicrotask(env.wakeDailyRefresh);
  }
  const guideHost = createGuideHost({
    enableTimeline: isTauri(),
    discover: (signal) =>
      discoverPlaylistGuides(
        structuredClone(env.catalog.sources),
        (url, allowHttp, ownedSignal) => inspectSource(url, allowHttp, ownedSignal),
        signal,
        { registry: env.settings.reviewedGuideProviders },
      ),
    catalogRevision: () =>
      env.element('app').dataset.ready === 'true' && !env.applicationClosing
        ? env.persistedCatalogRevision
        : null,
    onChanged: guideChanged,
    channels: () => {
      const removed = new Set(env.settings.removedChannels);
      const favorites = new Set(env.settings.favorites);
      const category = createChannelCategoryResolver(env.settings);
      return env.catalog.channels
        .filter((channel) => !removed.has(channel.id))
        .map((channel) => ({
          ...channel,
          category: category(channel),
          favorite: favorites.has(channel.id),
        }));
    },
    selectedChannel: () =>
      env.catalog.channels.find((channel) => channel.id === env.player.snapshot.selection?.id) ??
      null,
    watch: async (channel, signal) => {
      signal.throwIfAborted();
      const current = env.catalog.channels.find(
        (entry) => entry.id === channel.id && entry.sourceId === channel.sourceId,
      );
      if (!current || env.settings.removedChannels.includes(current.id))
        throw new Error('This channel is no longer available.');
      await env.sharingBridge.select({ id: current.id, name: current.name, url: current.urls[0] });
    },
  });
  let lastCachedGuideConnection: {
    key: string;
    receipt: Awaited<ReturnType<typeof nativeGuide.connectCached>>;
  } | null = null;
  async function connectSavedGuideCaches(signal: AbortSignal, cacheOnly: boolean) {
    await env.catalogWrites;
    await env.preferences.settledSnapshot();
    signal.throwIfAborted();
    const capturedRemoved = [...env.settings.removedChannels];
    const saved = await readGuideCaptureSnapshot(signal);
    const fresh = await captureAutomaticGuideInWorker(
      {
        catalog: saved.catalog,
        preferences: saved.preferences,
        catalogRevision: saved.catalogRevision,
      },
      signal,
    );
    const scopeCurrent = () =>
      fresh.preferenceKey === automaticGuidePreferenceKey(env.settings) &&
      automaticGuideSourceKey(fresh.sources) === automaticGuideSourceKey(env.catalog.sources) &&
      capturedRemoved.length === env.settings.removedChannels.length &&
      capturedRemoved.every((id, index) => id === env.settings.removedChannels[index]);
    if (
      !scopeCurrent() ||
      (cacheOnly && !fresh.automaticGuideUpdates) ||
      (!cacheOnly &&
        (fresh.preferenceKey !== automaticGuidePreferenceSnapshot ||
          automaticGuideSourceKey(fresh.sources) !== automaticGuideSourceSnapshot))
    )
      throw new DOMException('Guide configuration changed.', 'AbortError');
    const sources = await nativeGuide.sources();
    const freshDiscoveryKey = JSON.stringify([
      fresh.preferenceKey,
      fresh.sources.map((source) => [source.id, source.kind, source.location, source.allowHttp]),
    ]);
    const permittedLocations = new Set([
      ...sources.filter((source) => source.kind === 'url').map((source) => source.location),
      ...fresh.registry.map((provider) => provider.location),
      ...(automaticGuideDiscovery?.key === freshDiscoveryKey
        ? automaticGuideDiscovery.result.candidates.map((candidate) => candidate.location)
        : []),
    ]);
    const currentPermissions = createAutomaticGuidePermissions(sources);
    const admitted = sources.filter(
      (source) =>
        source.kind === 'url' &&
        permittedLocations.has(source.location) &&
        currentPermissions.forLocation(source.location).status === 'configured',
    );
    const caches: {
      id: string;
      location: string;
      expectedSourceRevision: number;
      expectedPublishedRevision: number;
    }[] = [];
    for (const source of admitted) {
      signal.throwIfAborted();
      const coverage = await nativeGuide.coverage(source.id);
      if (
        coverage.publishedRevision === source.revision &&
        coverage.sourceRevision === source.revision &&
        coverage.channelCount > 0
      )
        caches.push({
          id: source.id,
          location: source.location,
          expectedSourceRevision: source.revision,
          expectedPublishedRevision: coverage.publishedRevision,
        });
    }
    signal.throwIfAborted();
    if (!scopeCurrent()) throw new DOMException('Guide configuration changed.', 'AbortError');
    const scopeKey = JSON.stringify([
      fresh.catalogRevision,
      fresh.preferenceKey,
      capturedRemoved,
      caches.map((cache) => [
        cache.id,
        cache.expectedSourceRevision,
        cache.expectedPublishedRevision,
      ]),
    ]);
    // Retain only a bounded successful scope. Oversized scopes remain admitted
    // and simply cannot use this optional no-op cache; failures are never cached.
    const boundedScopeKey = scopeKey.length * 2 <= 2 * 1024 * 1024 ? scopeKey : null;
    if (cacheOnly && boundedScopeKey !== null && lastCachedGuideConnection?.key === boundedScopeKey)
      return lastCachedGuideConnection.receipt;
    const requestId = crypto.randomUUID();
    let cancellation: Promise<unknown> | null = null;
    let cancellationFailed = false;
    let completedResult: Awaited<ReturnType<typeof nativeGuide.connectCached>> | null = null;
    const cancel = () => {
      cancellation = invoke('cancel_playlist', { requestId }).catch(() => {
        cancellationFailed = true;
      });
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      signal.throwIfAborted();
      if (!scopeCurrent() || (!cacheOnly && !automaticGuideScopeCurrent()))
        throw new DOMException('Guide configuration changed.', 'AbortError');
      const result = await nativeGuide.connectCached(
        fresh.catalogRevision,
        caches,
        fresh.aliases.filter((alias) =>
          caches.some((cache) => cache.location === alias.guideLocation),
        ),
        requestId,
        cacheOnly,
      );
      if (
        result.catalogRevision !== fresh.catalogRevision ||
        ![
          result.matched,
          result.unmatched,
          result.ambiguous,
          result.preservedMappings,
          result.checkedSources,
        ].every((count) => Number.isSafeInteger(count) && count >= 0 && count <= 100000)
      )
        throw new Error('The guide connection receipt is invalid.');
      if (result.reviewedCrosswalk?.status === 'unavailable')
        void env.diagnostics.emit({
          operation: 'guide',
          level: 'warning',
          code: 'guide-identity-unavailable',
        });
      void env.visibleGuide?.refresh().catch(() => undefined);
      env.guide.catalogChanged(true);
      completedResult = result;
      return result;
    } finally {
      signal.removeEventListener('abort', cancel);
      await Promise.resolve(cancellation).then(() => {
        if (cancellationFailed)
          throw new Error('Program guide cancellation could not be confirmed.');
      });
      if (completedResult && boundedScopeKey !== null && !signal.aborted && scopeCurrent())
        lastCachedGuideConnection = { key: boundedScopeKey, receipt: completedResult };
    }
  }
  const automaticGuides = createAutomaticGuideBuilder({
    canRequest: () =>
      env.rendererRecoveryPolicy.allowAutomaticWork() &&
      env.settings.automaticGuideUpdates !== false &&
      !automaticGuideControlPending,
    canRun: () =>
      isTauri() &&
      !env.applicationClosing &&
      env.nativeViewingForeground &&
      env.element('app').dataset.ready === 'true',
    isCurrent: (revision) =>
      revision === env.persistedCatalogRevision &&
      automaticGuidePreferenceSnapshot === automaticGuidePreferenceKey(env.settings) &&
      automaticGuideRemovedSnapshot.length === env.settings.removedChannels.length &&
      automaticGuideRemovedSnapshot.every(
        (id, index) => id === env.settings.removedChannels[index],
      ),
    isScopeCurrent: automaticGuideScopeCurrent,
    capture: async (signal, reportPhase) => {
      await env.catalogWrites;
      await env.preferences.settledSnapshot();
      signal.throwIfAborted();
      automaticGuideRemovedSnapshot = [...env.settings.removedChannels];
      const saved = await readGuideCaptureSnapshot(signal);
      signal.throwIfAborted();
      const captured = await captureAutomaticGuideInWorker(
        {
          catalog: saved.catalog,
          preferences: saved.preferences,
          catalogRevision: saved.catalogRevision,
        },
        signal,
      );
      automaticGuidePreferenceSnapshot = captured.preferenceKey;
      automaticGuideSourceSnapshot = automaticGuideSourceKey(captured.sources);
      const discoveryKey = JSON.stringify([
        captured.preferenceKey,
        captured.sources.map((source) => [
          source.id,
          source.kind,
          source.location,
          source.allowHttp,
        ]),
      ]);
      reportPhase?.('reading-playlists');
      const discovered =
        automaticGuideDiscovery?.key === discoveryKey &&
        automaticGuideDiscovery.retryAtMs > Date.now()
          ? automaticGuideDiscovery.result
          : await discoverPlaylistGuides(
              [...captured.sources],
              (url, allowHttp, ownedSignal) => inspectSource(url, allowHttp, ownedSignal),
              signal,
              { registry: [...captured.registry] },
            );
      signal.throwIfAborted();
      automaticGuideDiscovery = {
        key: discoveryKey,
        result: discovered,
        retryAtMs: discovered.outcomes.some((outcome) => outcome.status === 'failed')
          ? Date.now() + 90_000
          : Number.POSITIVE_INFINITY,
      };
      const configuredGuides = await nativeGuide.sources();
      const savedGuidePermissions = createAutomaticGuidePermissions(configuredGuides);
      signal.throwIfAborted();
      const providerLocations = new Map(
        discovered.candidates.map((candidate) => [
          candidate.location,
          { name: candidate.name, location: candidate.location },
        ]),
      );
      for (const pack of await readPackSuggestions(nativeGuide.packSuggestions, signal))
        if (!providerLocations.has(pack.location)) providerLocations.set(pack.location, pack);
      for (const source of configuredGuides) {
        if (
          source.kind === 'url' &&
          savedGuidePermissions.forLocation(source.location).status === 'configured'
        )
          providerLocations.set(source.location, { name: source.name, location: source.location });
      }
      const permissions = new Map(
        [...providerLocations.values()].map((candidate) => [
          candidate.location,
          savedGuidePermissions.forLocation(candidate.location),
        ]),
      );
      automaticGuidePermissions = permissions;
      return {
        catalogRevision: captured.catalogRevision,
        channelCount: captured.channelCount,
        discoveryFailed: discovered.outcomes.filter((outcome) => outcome.status === 'failed')
          .length,
        catalogCountries: captured.catalogCountries,
        providers: prioritizeGuideProviders(
          [...providerLocations.values()].map((candidate) => ({
            name: candidate.name,
            location: candidate.location,
            allowHttp: permissions.get(candidate.location)!.allowHttp,
            aliases: captured.aliases.find(
              (aliases) => aliases.guideLocation === candidate.location,
            ),
          })),
          captured.preferredRegion?.country,
          new Set(
            discovered.candidates
              .filter((candidate) => candidate.playlistNames.length > 0)
              .map((candidate) => candidate.location),
          ),
        ),
      };
    },
    preview: (provider, signal) => {
      const permission = automaticGuidePermissions.get(provider.location);
      if (!permission) throw new Error('Automatic program guide permission is unavailable.');
      return previewPermittedAutomaticGuide(
        permission,
        provider.name,
        {
          sources: nativeGuide.sources,
          previewSource: (sourceId, ownedSignal) => guideHost.preview({ sourceId }, ownedSignal),
          previewProposedSource: (location, name, ownedSignal) =>
            guideHost.previewProposedSource(location, name, ownedSignal),
        },
        signal,
      );
    },
    cacheReady: createGuideCacheReady(nativeGuide),
    acquisitionAllowed: createGuideAcquisitionAllowed(nativeGuide),
    publishCache: async (preview, _provider, signal) => {
      if (automaticGuidePreferenceSnapshot !== automaticGuidePreferenceKey(env.settings))
        throw new DOMException('Guide configuration changed.', 'AbortError');
      await guideHost.publishCachedPreview(preview.ticket, preview.sourceRevision, signal);
    },
    connectScopeLatest: (signal) => connectSavedGuideCaches(signal, false),
    connectCacheOnly: (signal) => connectSavedGuideCaches(signal, true),
    maintain: createGuideMaintenance({
      scanning: () => env.scanController.automaticScanActive || env.sourceScan.snapshot().busy,
      scopeCurrent: automaticGuideScopeCurrent,
      changed: guideChanged,
    }),
    commitMatched: async (preview, revision, signal, provider) => {
      signal.throwIfAborted();
      const result = await guideHost.commitMatchedPreview(
        preview.ticket,
        preview.sourceRevision,
        revision,
        signal,
        provider.aliases,
      );
      if (
        !result ||
        typeof result.committed !== 'boolean' ||
        ![result.matched, result.unmatched].every(
          (count) => Number.isSafeInteger(count) && count >= 0 && count <= 100_000,
        )
      )
        throw new Error('The automatic program guide receipt is invalid.');
      return result;
    },
    settlePreviews: () => guideHost.settleProposedPreviews(),
    discard: (ticket) => guideHost.discardPreview(ticket),
    onProgress: (progress) => {
      env.guide.presentAutomaticProgress(progress);
      const review =
        progress.mappingConflictAssessment === 'complete' &&
        typeof progress.preservedMappingConflicts === 'number' &&
        progress.preservedMappingConflicts > 0
          ? ` · ${progress.preservedMappingConflicts} channels have multiple matching guides; your current choices were kept`
          : '';
      env.element('source-refresh-status').textContent =
        `Program guides: ${progress.attempted} of ${progress.total} sources checked · ${progress.failed} unavailable${review}`;
    },
  });
  return {
    automaticGuides,
    guideHost,
    get automaticGuideDiscovery() {
      return automaticGuideDiscovery;
    },
    set automaticGuideDiscovery(value: typeof automaticGuideDiscovery) {
      automaticGuideDiscovery = value;
    },
    get automaticGuideControlPending() {
      return automaticGuideControlPending;
    },
    set automaticGuideControlPending(value: typeof automaticGuideControlPending) {
      automaticGuideControlPending = value;
    },
    get lastCachedGuideConnection() {
      return lastCachedGuideConnection;
    },
    set lastCachedGuideConnection(value: typeof lastCachedGuideConnection) {
      lastCachedGuideConnection = value;
    },
  };
}
