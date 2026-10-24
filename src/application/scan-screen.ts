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

import { mountSourceScan } from '../ui/source-scan';
import { nativeScanCheckpointSummary } from '../platform/scan-checkpoint-summary';
import { validateSource, type Source } from '../catalog';
import { createSourceSnapshotTransport } from '../platform/source-snapshot';
import { createPagedSourceCollection } from '../discovery/paged-source-collection';
import { inspectSource, readRecordPair, type CommitReceipt } from '../platform/records';
import {
  type SourceSnapshotActivationReply,
  type createSourceSnapshotActivationTransport,
} from '../platform/source-snapshot-activation';
import { createIncrementalRefreshCoordinator } from '../discovery/incremental-refresh';
import { recordUnavailableSources } from '../discovery/unavailable-sources';
import { sourcePreparationStatus } from '../ui/source-preparation-status';
import { DECODER_HEALTH_PROFILE, reachabilityHealthProfile } from './health-profile';
import { type createScanCheckpointProgressCapture } from './scan-checkpoint-capture-service';
import { fingerprintScanSource } from '../discovery/scan-checkpoint';
import { isTauri } from '@tauri-apps/api/core';
import { type ScanReview, type ScanSource } from '../discovery/scan';

import { createScanGuideHost } from './scan-guide-host';
import { nativeScanWindowCommit } from '../platform/scan-window-commit';
import { createSelectionSession } from '../discovery/selection-session';
import { healthHistoryInWorker } from './health-history-read';
import { parseInWorker } from '../catalog/service';
import { createHealthObservation, type HealthEvidence } from '../discovery/health';
import { type createScanSourceCollector } from './scan-source-collection';
import { type createIndexFreshness } from '../discovery/index-freshness';
import { type createScanRecoveryObserver } from './scan-recovery-observer';
import { type createScanPublicationObserver } from './scan-publication-observer';
import { type BoundedScanRevisions } from './bounded-scan-resume';
import { type BoundedScanServiceDiagnostic } from './bounded-scan-resume-service';
import {
  type AutomaticScanCheckpointSnapshot,
  type AutomaticScanProgress,
  type SourceScanHost,
  type SourceScanPublicationChunk,
  type SourceScanSnapshot,
} from '../ui/source-scan-model';
import {
  type ResumedCheckpointFormat,
  type ScanCheckpointCaptureMode,
} from './scan-checkpoint-mode';
import { type PreferredRegion } from '../location/region';
import { type ScanEnvironment } from './scan-controller';
import { type ParsedPlaylist } from '../catalog/parser';
import { type ScanPublicationHandle } from './scan-publication-observer';
import { scanScreenCheckpoint } from './scan-screen-checkpoint';

/** What this part reads from, and writes back to, createScanController. */
export interface ScanScreenShared {
  readonly indexedFreshAvailable: boolean;
  readonly supportsBoundedResume: (signal: AbortSignal) => Promise<boolean>;
  readonly createApplicationBoundedResume: (
    scope: { jobId: string | null; checkpointRevision?: string; query?: string; slow?: boolean },
    signal: AbortSignal,
  ) => Promise<{
    snapshot: () => Readonly<{
      observerFailed: boolean;
      activeCallbacks: number;
      maxActiveCallbacks: number;
      workerStopped: boolean;
      quarantined: boolean;
      phase:
        | 'idle'
        | 'admitting'
        | 'checking'
        | 'completed'
        | 'paused'
        | 'failed'
        | 'quarantined'
        | 'disposed';
      failure:
        | 'none'
        | 'admission-failed'
        | 'probe-unconfirmed'
        | 'commit-unconfirmed'
        | 'cleanup-unconfirmed';
      counts: Readonly<import('./bounded-scan-resume').BoundedScanCounts>;
      revisions: Readonly<BoundedScanRevisions> | null;
      ownedReservations: number;
      active: number;
      maxOwnedReservations: number;
      capabilityEnabled: false;
    }>;
    diagnostics: () => Readonly<{
      generation: number;
      lastEvents: readonly Readonly<BoundedScanServiceDiagnostic>[];
      lastFailure: Readonly<BoundedScanServiceDiagnostic> | null;
      failureCount: number;
    }>;
    prepare(): Promise<import('./bounded-scan-resume').BoundedScanResumePlan>;
    subscribe(
      listener: (
        value: ReturnType<
          () => Readonly<{
            observerFailed: boolean;
            activeCallbacks: number;
            maxActiveCallbacks: number;
            workerStopped: boolean;
            quarantined: boolean;
            phase:
              | 'idle'
              | 'admitting'
              | 'checking'
              | 'completed'
              | 'paused'
              | 'failed'
              | 'quarantined'
              | 'disposed';
            failure:
              | 'none'
              | 'admission-failed'
              | 'probe-unconfirmed'
              | 'commit-unconfirmed'
              | 'cleanup-unconfirmed';
            counts: Readonly<import('./bounded-scan-resume').BoundedScanCounts>;
            revisions: Readonly<BoundedScanRevisions> | null;
            ownedReservations: number;
            active: number;
            maxOwnedReservations: number;
            capabilityEnabled: false;
          }>
        >,
      ) => void,
    ): () => boolean;
    start(): Promise<void>;
    suspend(): Promise<void>;
    dispose(): Promise<void>;
  } | null>;
  readonly healthPlatform: string | null;
  readonly scanProviderSources: () => Source[];
  readonly scanCollector: ReturnType<typeof createScanSourceCollector>;
  readonly searchIndexFreshness: ReturnType<typeof createIndexFreshness>;
  readonly sourceActivation: ReturnType<typeof createSourceSnapshotActivationTransport>;
  readonly showInlineScanProgress: (progress: Readonly<AutomaticScanProgress>) => void;
  readonly logScanFailure: (snapshot: Readonly<SourceScanSnapshot>) => void;
  readonly slowPassTimer: ReturnType<typeof setTimeout> | undefined;
  readonly inlineScanSlowPass: boolean;
  slowPassRetries: number;
  readonly scheduleSlowPass: (delayMs?: number) => void;
  automaticScanActive: boolean;
  readonly scanBatchThrottle: {
    listed: number;
    guidePending: boolean;
    startedMs: number;
    listPending: boolean;
  };
  readonly flushScanBatchWork: (slowPass?: boolean) => void;
  readonly checkpointProgressCapture:
    ReturnType<typeof createScanCheckpointProgressCapture> | undefined;
  resumedCheckpointFormat: ResumedCheckpointFormat | null;
  readonly scanRecoveryObserver: ReturnType<typeof createScanRecoveryObserver>;
  scanStorageRevision: string;
  readonly checkpointProgressCapability: () => Promise<{
    advance: boolean;
    packedReference: boolean;
  }>;
  scanRegion: PreferredRegion | undefined;
  scanScope: ScanSource[];
  readonly candidateManifestClient: (signal: AbortSignal) => Promise<{
    stageAndSeal(
      input: import('./scan-candidate-manifest-service').StageScanCandidateManifestInput,
      signal: AbortSignal,
    ): Promise<CommitReceipt>;
    lookup(
      jobId: string,
      reviewDigest: string,
      revisions: import('./scan-candidate-manifest').ManifestCas,
      signal: AbortSignal,
    ): Promise<import('./scan-candidate-manifest').ScanCandidateManifestHeader | null>;
    readPage(
      header: import('./scan-candidate-manifest').ScanCandidateManifestHeader,
      startIndex: number,
      revisions: import('./scan-candidate-manifest').ManifestCas,
      signal: AbortSignal,
    ): Promise<import('./scan-candidate-manifest').ScanCandidateManifestPage>;
    restore(
      input: import('./scan-candidate-manifest-service').RestoreScanCandidateManifestInput,
      signal: AbortSignal,
    ): Promise<import('../discovery/scan-checkpoint').ScanCheckpoint>;
  } | null>;
  manifestBackedJobId: string | null;
  readonly collectScanSource: (source: Source, signal: AbortSignal) => Promise<ParsedPlaylist>;
  readonly checkpointCaptureInput: (snapshot: AutomaticScanCheckpointSnapshot) => {
    preferredRegion?: PreferredRegion | undefined;
    jobId: string;
    createdAtMs: number;
    review: ScanReview;
    budgetMs: import('../ui/source-scan-model').HealthCheckBudgetMs;
    platform: string;
    observerProfile: string;
    observations: import('../discovery/health').HealthObservation[];
    publishedKeys: string[];
    catalogRevision: string;
    sources: Source[];
    canonicalSources: Source[];
    providers: import('../discovery/provider-registry').ReviewedChannelProvider[] | null;
  };
  readonly scanPublicationObserver: ReturnType<typeof createScanPublicationObserver>;
  readonly progressCaptureOwner: (jobId: string) => Promise<{
    prepareMutation: (
      input: import('./scan-checkpoint-capture').ScanCheckpointCaptureInput,
      signal: AbortSignal,
    ) => Promise<import('../discovery/scan-checkpoint').ScanCheckpointMutation | null>;
    prepareWindowMutation(
      input: import('./scan-checkpoint-capture').ScanCheckpointCaptureInput,
      publicationKeys: readonly string[],
      signal: AbortSignal,
    ): Promise<import('../discovery/scan-checkpoint').ScanCheckpointMutation | null>;
    acknowledgeMutation: (
      mutation: import('../discovery/scan-checkpoint').ScanCheckpointMutation,
      revision: string,
    ) => void;
    readonly hasPendingPreparation: boolean;
    releaseUncommittedPreparation(expectedRevision: string, actualRevision: string): void;
    reset(): void;
    dispose(): Promise<void>;
  }>;
  readonly checkpointCaptureMode: ScanCheckpointCaptureMode | null;
  pendingManifestSeed: { checkpoint: string; jobId: string; review: ScanReview } | undefined;
  readonly publicationTraceByMutation: WeakMap<object, ScanPublicationHandle>;
  readonly supportsNativeScanBatch: (signal: AbortSignal) => Promise<boolean>;
  readonly inspectStreamEvidence: (
    url: string,
    allowHttp: boolean,
    signal: AbortSignal,
    budgetMs: 20000 | 45000 | 60000,
  ) => Promise<HealthEvidence>;
  readonly commitScanPublication: (
    selection: Parameters<SourceScanHost['commit']>[0],
    revision: string,
    signal: AbortSignal,
    health?: Parameters<SourceScanHost['commit']>[3],
    checkpointContext?: Parameters<SourceScanHost['commit']>[4],
    episodeId?: string,
    windowChunks?: readonly SourceScanPublicationChunk[],
  ) => Promise<{ checkpointRevision?: string | undefined; committed: true; revision: string }>;
}

/**
 * Mounting the scan screen with the application's side of every scan
 * step: sources, checkpoints, publication, guides and diagnostics. Part of
 * createScanController.
 */
export function mountApplicationScanScreen(env: ScanEnvironment, shared: ScanScreenShared) {
  const sourceScan = mountSourceScan(env.element('source-scan-settings'), {
    indexedFreshAvailable: () => shared.indexedFreshAvailable,
    createIndexedFreshResume: async (input, signal) => {
      if (!(await shared.supportsBoundedResume(signal)))
        throw new Error('Incremental source refresh is unavailable.');
      await env.catalogWrites;
      await env.preferences.settledSources();
      signal.throwIfAborted();
      const summary = await nativeScanCheckpointSummary.read(signal);
      // The Slow list waits for a finished scan; it never takes over an unfinished one.
      if (input.intent === 'slow' && summary.unfinished) return { service: null };
      if (
        summary.checkpointStatus === 'valid' &&
        summary.unfinished &&
        input.intent !== 'full-recheck'
      ) {
        // Ordinary Refresh preserves unfinished ownership and enters Continue.
        // Explicit full recheck retains it until fenced native activation commits.
        const service = await shared.createApplicationBoundedResume(
          { jobId: null, checkpointRevision: summary.checkpointRevision },
          signal,
        );
        if (!service) throw new Error('Saved scan progress is unavailable for Continue.');
        return { service };
      }
      if (
        summary.checkpointStatus !== 'absent' &&
        (summary.checkpointStatus !== 'valid' || summary.storedVersion !== 3)
      )
        throw new Error('Saved scan ownership must be recovered before refreshing sources.');
      const platform = shared.healthPlatform;
      if (!platform) throw new Error('Native channel checks are unavailable.');
      const sources = input.sources
        ? input.sources.map(({ source }) => validateSource(source))
        : shared.scanProviderSources();
      if (!sources.length)
        throw new Error('Configure an authorized channel source before refreshing.');
      const initialCatalogRevision = env.persistedCatalogRevision;
      // Existing sources retain the exact durable permission fingerprint, including
      // optional content hints. Detection may enrich a newly reviewed source only.
      const canonicalSources = new Map(env.catalog.sources.map((source) => [source.id, source]));
      const initialIdentity = JSON.stringify([
        env.catalog.sources,
        env.settings.reviewedChannelProviders,
        env.settings.preferredRegion,
      ]);
      const current = () =>
        !env.applicationClosing &&
        !signal.aborted &&
        env.persistedCatalogRevision === initialCatalogRevision &&
        initialIdentity ===
          JSON.stringify([
            env.catalog.sources,
            env.settings.reviewedChannelProviders,
            env.settings.preferredRegion,
          ]);
      const snapshots = createSourceSnapshotTransport();
      const revisions = [];
      for (const source of sources) {
        signal.throwIfAborted();
        const status = await snapshots.status(source.id, signal);
        revisions.push({ source, sourceRevision: status.sourceRevision });
      }
      let geography: ReturnType<typeof shared.scanCollector.readGeography> | undefined;
      const collection = createPagedSourceCollection({
        inspectSource,
        geography: (source, ownedSignal) => {
          const url = new URL(source.location);
          if (url.origin !== 'https://iptv-org.github.io' || !url.pathname.startsWith('/iptv/'))
            return Promise.resolve(undefined);
          return (geography ??= shared.scanCollector.readGeography(ownedSignal));
        },
      });
      let activation: SourceSnapshotActivationReply | undefined;
      const coordinator = createIncrementalRefreshCoordinator({
        snapshots,
        freshness: shared.searchIndexFreshness,
        unavailable: recordUnavailableSources,
        current,
        collect: async (source, ownedSignal) => {
          const collected = await collection.collect(source, ownedSignal);
          try {
            ownedSignal.throwIfAborted();
            if (!current()) throw new Error('Source refresh configuration changed.');
            const canonical = canonicalSources.get(source.id);
            if (!canonical) return collected;
            if (
              canonical.kind !== source.kind ||
              canonical.location !== source.location ||
              (canonical.allowHttp === true) !== (source.allowHttp === true)
            )
              throw new Error('Source refresh permission changed.');
            return Object.freeze({ ...collected, source: Object.freeze({ ...canonical }) });
          } catch (error) {
            await collected.dispose();
            throw error;
          }
        },
        activateChecks: async (scope, promotions, ownedSignal, reused = []) => {
          if (!promotions.length && !reused.length)
            throw new Error('Sources could not be updated. Saved channels are retained.');
          activation = await shared.sourceActivation(
            {
              schemaVersion: 1,
              sources: [...promotions, ...reused].map(({ sourceId, sourceRevision }) => ({
                sourceId,
                sourceRevision,
              })),
              query: scope.query,
              preferredRegion: scope.region ?? null,
              budgetMs: input.budgetMs,
              mode:
                input.intent === 'full-recheck'
                  ? 'fullRecheck'
                  : input.intent === 'slow'
                    ? 'slow'
                    : 'refresh',
              expectedCatalogRevision: initialCatalogRevision,
              expectedCheckpointRevision: summary.checkpointRevision,
              ...(await shared.scanCollector.discoveryHints(scope.query, ownedSignal)),
            },
            ownedSignal,
            (p) => {
              if (current() && !ownedSignal.aborted)
                env.element('inline-scan-status').textContent = sourcePreparationStatus(p);
            },
          );
        },
        continueChecks: async () => {
          throw new Error('Use the saved scan owner to continue.');
        },
        stopChecks: async () => undefined,
        progress: (progress) => {
          if (!current()) return;
          env.element('inline-scan-status').textContent =
            progress.phase === 'indexing'
              ? `Reading source ${progress.activeSource ?? progress.indexedSources + progress.failedSources + 1} of ${progress.totalSources ?? sources.length} · ${Math.floor((progress.elapsedMilliseconds ?? 0) / 1000)}s · ${progress.sourceEntries === undefined ? 'Downloading channel list…' : `${progress.stagedEntries ?? 0} of ${progress.sourceEntries} entries read`} · ${progress.indexedEntries} entries indexed · ${progress.failedSources} sources unavailable`
              : `Preparing channel checks · ${progress.indexedSources} sources updated · ${progress.indexedEntries} entries indexed · ${progress.failedSources} sources unavailable`;
        },
      });
      try {
        await coordinator.start(
          {
            scopeId: crypto.randomUUID(),
            sources: revisions,
            platform,
            observerProfile: reachabilityHealthProfile(true, input.budgetMs),
            query: input.query,
            region: env.settings.preferredRegion
              ? structuredClone(env.settings.preferredRegion)
              : undefined,
            intent: input.intent,
          },
          signal,
        );
      } finally {
        try {
          await coordinator.dispose();
        } finally {
          await collection.dispose();
          geography = undefined;
        }
      }
      signal.throwIfAborted();
      // A Slow pass whose sources were never read has nothing to check.
      if (!activation && input.intent === 'slow') return { service: null };
      if (!activation) throw new Error('Source checks could not be activated.');
      if (!activation.jobId) return { service: null };
      const service = await shared.createApplicationBoundedResume(
        {
          jobId: activation.jobId,
          checkpointRevision: activation.checkpointRevision,
          slow: input.intent === 'slow',
        },
        signal,
      );
      if (!service)
        throw new Error('Source checks could not be opened. Continue the saved scan to retry.');
      return { service };
    },
    createBoundedResume: shared.createApplicationBoundedResume,
    onProgress: shared.showInlineScanProgress,
    onDiagnostic: shared.logScanFailure,
    activity: (active) => {
      if (active) {
        clearTimeout(shared.slowPassTimer);
        void env.diagnostics.emit({ operation: 'scan', level: 'info', code: 'scan-started' });
      } else
        queueMicrotask(() => {
          const snapshot = sourceScan.snapshot();
          // A completed scan hands the streams its triage left to the Slow list.
          if (snapshot.phase === 'completed' && !shared.inlineScanSlowPass) {
            shared.slowPassRetries = 0;
            shared.scheduleSlowPass();
          } else if (
            shared.inlineScanSlowPass &&
            snapshot.phase === 'failed' &&
            snapshot.lastFailureCode === 'sqlite-busy' &&
            shared.slowPassRetries < 3
          ) {
            // The database was busy (another long write): try again later.
            shared.slowPassRetries++;
            shared.scheduleSlowPass(120_000);
          }
          if (snapshot.phase === 'failed') shared.logScanFailure(snapshot);
          else if (snapshot.phase === 'completed' || snapshot.phase === 'paused')
            void env.diagnostics.emit({
              operation: 'scan',
              level: 'info',
              code: snapshot.phase === 'completed' ? 'scan-completed' : 'scan-paused',
              total: snapshot.total,
              checked: snapshot.checked,
              published: snapshot.published,
            });
        });
      shared.automaticScanActive = active;
      if (active && shared.scanBatchThrottle.listed < 0) {
        shared.scanBatchThrottle.listed = env.catalog.channels.length;
        shared.scanBatchThrottle.startedMs = Date.now();
      }
      if (!active) shared.flushScanBatchWork(shared.inlineScanSlowPass);
      env.updateImportActions();
      void env.activityWake.setScan(active).catch(() => undefined);
    },
    checkpoint: scanScreenCheckpoint(shared, env, () => sourceScan),
    ...createScanGuideHost(),
    prioritize: shared.scanCollector.prioritize,
    aliases: shared.scanCollector.aliases,
    beginSelectionEpisode: async (context, signal) => {
      const work = env.catalogWrites.then(async () => {
        signal.throwIfAborted();
        const definitionsMatch = await Promise.all(
          context.capturedSources.map(async (captured, index) => {
            const observed = shared.scanScope[index];
            return (
              !!observed &&
              captured.fingerprint === observed.fingerprint &&
              (await fingerprintScanSource({
                ...captured.source,
                contentKind: undefined,
                mediaMime: undefined,
              })) ===
                (await fingerprintScanSource({
                  ...observed.source,
                  contentKind: undefined,
                  mediaMime: undefined,
                }))
            );
          }),
        );
        signal.throwIfAborted();
        if (
          env.applicationClosing ||
          context.revision !== String(env.catalogRevision) ||
          env.selectionEpisode ||
          context.capturedSources.length !== shared.scanScope.length ||
          // Collection adds observed format; canonical field order is not source authority.
          definitionsMatch.some((matches) => !matches)
        )
          throw new Error('Saved channels changed. Continue the scan again.');
        if (!(await shared.supportsNativeScanBatch(signal))) return null;
        signal.throwIfAborted();
        const supportsWindow = (await nativeScanWindowCommit.capabilities(signal)) !== null;
        signal.throwIfAborted();
        const actor = createSelectionSession({
          catalog: env.catalog,
          catalogRevision: env.persistedCatalogRevision,
          scope: structuredClone(shared.scanScope),
          reconciliationScopes: [...context.reconciliationScopes.values()],
        });
        try {
          await actor.ready;
          signal.throwIfAborted();
        } catch (error) {
          await actor.dispose();
          throw error;
        }
        const episode = {
          id: crypto.randomUUID(),
          actor,
          catalog: env.catalog,
          revision: env.persistedCatalogRevision,
          broken: false,
          supportsWindow,
        };
        env.selectionEpisode = episode;
        let disposal: Promise<void> | undefined;
        return {
          episodeId: episode.id,
          supportsWindow,
          dispose: () => {
            if (!disposal)
              disposal = (async () => {
                // SourceScan joins its publisher first. Also join the actual catalog owner.
                await env.catalogWrites;
                if (env.selectionEpisode === episode) env.selectionEpisode = undefined;
                await actor.dispose();
              })();
            return disposal;
          },
        };
      });
      env.catalogWrites = work.catch(() => undefined);
      return work;
    },
    platform: () => shared.healthPlatform ?? 'native-unavailable',
    observerProfile: (budgetMs = 20000) => reachabilityHealthProfile(isTauri(), budgetMs),
    now: () => Date.now(),
    savedHealth: async (query) => {
      query.signal.throwIfAborted();
      const saved = await readRecordPair();
      query.signal.throwIfAborted();
      return healthHistoryInWorker(
        saved,
        { offset: query.offset, pageSize: 50, query: query.query, revision: query.revision },
        {
          now: Date.now(),
          platform: shared.healthPlatform ?? 'native-unavailable',
          observerProfile: reachabilityHealthProfile(isTauri(), query.budgetMs),
          decoderObserverProfile: DECODER_HEALTH_PROFILE,
        },
        query.signal,
      );
    },
    revision: () => String(env.catalogRevision),
    onCollectionSettled: () => {
      // Collection has joined; probes use enriched channels, not the raw registry documents.
      shared.scanCollector.release();
    },
    capture: (drafts) => {
      if (env.importRunning || env.transferBusy)
        throw new Error('Wait for the current import to finish.');
      shared.scanStorageRevision = env.persistedCatalogRevision;
      shared.scanCollector.reset();
      shared.scanRegion = env.settings.preferredRegion
        ? structuredClone(env.settings.preferredRegion)
        : undefined;
      shared.scanScope = drafts
        ? structuredClone([...drafts])
        : shared.scanProviderSources().map((source) => ({
            source: { ...source },
            fingerprint: crypto.randomUUID(),
          }));
      return { revision: String(env.catalogRevision), sources: structuredClone(shared.scanScope) };
    },
    collect: shared.collectScanSource,
    readFileSnapshot: async (file, source, signal) => {
      const generation = env.foregroundGeneration;
      signal.throwIfAborted();
      const text = await file.text();
      signal.throwIfAborted();
      if (generation !== env.foregroundGeneration || env.applicationClosing)
        throw new DOMException('File review canceled.', 'AbortError');
      return parseInWorker(text, source.id, signal);
    },
    probe: (candidate, signal, budgetMs = 20000) => {
      // The scan owner bounds parallel response checks; each origin retains its pacing owner.
      const scope = shared.scanScope;
      const work = (async () => {
        signal.throwIfAborted();
        if (shared.healthPlatform === null)
          throw new Error(
            'Device information is unavailable. Reopen the app before checking streams.',
          );
        const definition = scope.find((entry) => entry.source.id === candidate.sourceId);
        if (scope !== shared.scanScope || definition?.fingerprint !== candidate.sourceFingerprint)
          throw new Error('The reviewed source changed. Scan again.');
        const evidence = await shared.inspectStreamEvidence(
          candidate.channel.urls[0],
          definition.source.allowHttp ?? false,
          signal,
          budgetMs,
        );
        return createHealthObservation(
          {
            channelId: candidate.key,
            sourceId: candidate.sourceId,
            fingerprint: candidate.sourceFingerprint,
          },
          { platform: shared.healthPlatform, observedAt: Date.now() },
          evidence,
        );
      })();
      return work;
    },
    commit: shared.commitScanPublication,
    commitWindow: (chunks, revision, signal, checkpoint, episodeId) =>
      shared.commitScanPublication(
        chunks[0].staged,
        revision,
        signal,
        chunks[0].health,
        checkpoint,
        episodeId,
        chunks,
      ),
  });
  return {
    sourceScan,
  };
}
