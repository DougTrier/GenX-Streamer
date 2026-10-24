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
 * Channel scans as the application runs them: the scan screen's wiring
 * (mountSourceScan), saved scan progress and bounded resume, publication of
 * found channels into the catalog, the slow pass, and the scan diagnostics
 * exposed on window for tests. Moved out of main.ts; main.ts passes the shared
 * state it owns through the environment.
 */
import { scanConfiguredSources, type ScanReview, type ScanSource } from '../discovery/scan';
import { nativeScanBatchCommit } from '../platform/scan-batch-commit';
import {
  createScanCheckpointProgressCapture,
  parseScanCheckpointCapabilities,
  parseStoredCaptureWithPacked as parseScanCheckpointCapture,
  prepareStoredCapture as prepareScanCheckpointCapture,
  restorePackedCapture,
  restoreReferencedCapture,
} from './scan-checkpoint-capture-service';
import { createScanRecoveryObserver } from './scan-recovery-observer';
import {
  createScanPublicationObserver,
  type ScanPublicationHandle,
} from './scan-publication-observer';
import {
  nativeScanWindowCommit,
  validateScanWindow,
  type ScanWindowFailureCode,
} from '../platform/scan-window-commit';
import { createScanCandidateManifestClient } from './scan-candidate-manifest-service';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { createScanCandidateManifestTransport } from './scan-candidate-manifest';
import {
  scanCheckpointModeOptions,
  selectScanCheckpointMode,
  type ResumedCheckpointFormat,
  type ScanCheckpointCaptureMode,
} from './scan-checkpoint-mode';
import {
  ScanSourcesChanged,
  SourceScanWindowSizeError,
  mountSourceScan,
  sourcesChangedRefusal,
  type AutomaticScanCheckpointSnapshot,
  type AutomaticScanProgress,
  type SourceScanHost,
  type SourceScanPublicationChunk,
  type SourceScanSnapshot,
} from '../ui/source-scan';
import { type PreferredRegion } from '../location/region';
import { allowIncludedHttp, providerScanSources } from './included-sources';
import {
  discardScanCheckpoint,
  inspectSource,
  readRecordPair,
  readScanCheckpoint,
  readScanHealth,
  writeRecordPair,
  writeScanCheckpoint,
  writeScanCheckpointMutation,
  type CommitReceipt,
} from '../platform/records';
import { serializeCatalog, validateSource, type Source } from '../catalog';
import { exportPreferences } from '../preferences';
import { createProbeScheduler } from '../discovery/probe-scheduler';
import { createPlaybackProbeGate } from './playback-probe-gate';
import { createSlowPassGate } from './slow-pass-gate';
import { createHealthObservation, type HealthEvidence } from '../discovery/health';
import {
  inspectCheckedMediaSource,
  mediaPreflightDiagnosticsSnapshot,
} from '../sources/media-preflight';
import { type EventCode } from '../diagnostics/events';
import { mountInlineScanPanel } from '../ui/inline-scan-panel';
import { mountScanScreensaver } from '../ui/scan-screensaver';
import { mountFirstScanHint } from '../ui/first-scan-hint';
import { createIndexFreshness } from '../discovery/index-freshness';
import { createScanSourceCollector } from './scan-source-collection';
import { parseInWorker } from '../catalog/service';
import { createSelectionSession, type SelectionSessionAck } from '../discovery/selection-session';
import {
  prepareCompactScanInWorker,
  prepareNativeScanBatchInWorker,
  prepareScanInWorker,
} from '../discovery/selection';
import { decodeSavedHealthOnlyInWorker, healthHistoryInWorker } from './health-history-read';
import { applyCatalogPatch } from '../discovery/catalog-patch';
import { boundedUtf8Text } from '../platform/bounded-text';
import { isSelectionWindowSizeError } from '../discovery/selection-window';
import { type BoundedScanAck, type BoundedScanRevisions } from './bounded-scan-resume';
import { createScanPublicationProjectionReader } from '../platform/scan-resume-publication-projection';
import {
  createBoundedNativeScanResumeTransport,
  type BoundedScanTransportDiagnostic,
} from '../platform/bounded-scan-resume';
import {
  createBoundedScanResumeService,
  type BoundedScanServiceDiagnostic,
} from './bounded-scan-resume-service';
import { nativeScanCheckpointSummary } from '../platform/scan-checkpoint-summary';
import {
  createSourceSnapshotActivationTransport,
  type SourceSnapshotActivationReply,
} from '../platform/source-snapshot-activation';
import { createSourceSnapshotTransport } from '../platform/source-snapshot';
import { createPagedSourceCollection } from '../discovery/paged-source-collection';
import { createIncrementalRefreshCoordinator } from '../discovery/incremental-refresh';
import { recordUnavailableSources } from '../discovery/unavailable-sources';
import { sourcePreparationStatus } from '../ui/source-preparation-status';
import { DECODER_HEALTH_PROFILE, reachabilityHealthProfile } from './health-profile';
import {
  canResumeScanCheckpoint,
  fingerprintScanPolicy,
  fingerprintScanSource,
  scanReconstructionFailureCode,
  validateCheckpointSourceAdmission,
} from '../discovery/scan-checkpoint';
import { reorderScanCandidates } from '../discovery/scan-priority';
import { createScanGuideHost } from './scan-guide-host';

export type BoundedRootStage =
  | 'created'
  | 'commit-queued'
  | 'commit-entered'
  | 'root-admission-refused'
  | 'preferences-settled'
  | 'native-commit'
  | 'native-acknowledged'
  | 'projection-refused'
  | 'commit-failed';
export class BoundedScanEntryRefusal extends Error {
  constructor() {
    super('Saved scan admission could not be checked.');
  }
}

import type { CatalogRecord } from '../catalog';
import type { Preferences, SerializedPreferencesStore } from '../preferences';
import type { createAutomaticGuideBuilder } from '../guide/automatic-build';
import type { createDiagnostics } from '../diagnostics/native';
import type { ChannelBrowser } from '../ui/channel-browser';
import type { mountGuide } from '../ui/guide';
import type { mountGeographyControls } from '../ui/geography-controls';
import type { createChannelCheckStore } from '../platform/channel-checks';
import type { createSavedChannelCheck } from './saved-channel-check';
import type { PlaybackController } from '../playback/controller';
import type { createSharingHost } from './sharing-host';
import type { createActivityWakePolicy } from './activity-wake';
import type { ContentLibrary } from './content-library';

/** What this area reads from, and writes back to, the rest of the application. */
export interface ScanEnvironment {
  catalog: CatalogRecord;
  settings: Preferences;
  catalogWrites: Promise<unknown>;
  readonly preferences: SerializedPreferencesStore;
  readonly applicationClosing: boolean;
  persistedCatalogRevision: string;
  catalogRevision: number;
  readonly applySettings: () => void;
  readonly automaticGuides: ReturnType<typeof createAutomaticGuideBuilder>;
  readonly diagnostics: ReturnType<typeof createDiagnostics>;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly browser: ChannelBrowser;
  readonly guide: ReturnType<typeof mountGuide>;
  readonly geographyControls: ReturnType<typeof mountGeographyControls>;
  readonly updateVisibleGuide: () => void;
  readonly channelCheckStore: ReturnType<typeof createChannelCheckStore>;
  readonly savedChannelCheck: ReturnType<typeof createSavedChannelCheck>;
  readonly player: PlaybackController;
  readonly nativeViewingForeground: boolean;
  readonly contentLibrary: ContentLibrary;
  readonly addChannelsEntryWork: Promise<void> | null;
  readonly importRunning: boolean;
  transferBusy: boolean;
  selectionEpisode:
    | {
        id: string;
        actor: ReturnType<typeof createSelectionSession>;
        catalog: CatalogRecord;
        revision: string;
        broken: boolean;
        supportsWindow: boolean;
      }
    | undefined;
  readonly setImportBusy: (busy: boolean) => void;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  readonly notice: (message: string) => void;
  catalogBrowseViewRevision: number;
  readonly renderCatalog: () => void;
  readonly updateImportActions: () => void;
  readonly activityWake: ReturnType<typeof createActivityWakePolicy>;
  readonly foregroundGeneration: number;
}

export function createScanController(env: ScanEnvironment) {
  let scanScope: ScanSource[] = [];
  let nativeBatchSupported: boolean | undefined;
  async function supportsNativeScanBatch(signal: AbortSignal): Promise<boolean> {
    signal.throwIfAborted();
    if (nativeBatchSupported === undefined) {
      const capabilities = await nativeScanBatchCommit.capabilities(signal);
      signal.throwIfAborted();
      nativeBatchSupported = capabilities !== null;
    }
    return nativeBatchSupported;
  }
  let checkpointProgressCapture: ReturnType<typeof createScanCheckpointProgressCapture> | undefined;
  const scanRecoveryObserver = createScanRecoveryObserver();
  const scanPublicationObserver = createScanPublicationObserver();
  const publicationTraceByMutation = new WeakMap<object, ScanPublicationHandle>();
  let scanNativeFailures: readonly Readonly<{ attempt: number; code: ScanWindowFailureCode }>[] =
    Object.freeze([]);
  Object.defineProperty(window, '__GENX_SCAN_PUBLICATION__', {
    get: () =>
      Object.freeze({ ...scanPublicationObserver.snapshot(), nativeFailures: scanNativeFailures }),
    configurable: false,
  });
  Object.defineProperty(window, '__GENX_SCAN_RECOVERY__', {
    get: () => scanRecoveryObserver.snapshot(),
    enumerable: false,
    configurable: false,
  });
  let manifestClient: ReturnType<typeof createScanCandidateManifestClient> | null | undefined;
  let manifestBackedJobId: string | null = null;
  let pendingManifestSeed: { checkpoint: string; jobId: string; review: ScanReview } | undefined;
  async function candidateManifestClient(signal: AbortSignal) {
    signal.throwIfAborted();
    if (!isTauri()) return null;
    if (manifestClient !== undefined) return manifestClient;
    // Failed negotiation is a failed durable admission, never a silent plaintext/legacy fallback.
    const runtime = {
      invoke: (command: string, args?: Record<string, unknown>) => invoke(command, args),
    };
    const capability = await createScanCandidateManifestTransport(runtime).capabilities(signal);
    signal.throwIfAborted();
    return (manifestClient =
      capability.candidateManifest === 1
        ? createScanCandidateManifestClient(runtime, { supportsManifest: true })
        : null);
  }
  let resumedCheckpointFormat: ResumedCheckpointFormat | null = null;
  let checkpointCaptureMode: ScanCheckpointCaptureMode | null = null;
  let checkpointCapability: Promise<ReturnType<typeof parseScanCheckpointCapabilities>> | undefined;
  function checkpointProgressCapability() {
    return (checkpointCapability ??= isTauri()
      ? invoke<unknown>('scan_checkpoint_capabilities')
          .then(parseScanCheckpointCapabilities)
          .catch(() => ({ advance: false, packedReference: false }))
      : Promise.resolve({ advance: false, packedReference: false }));
  }
  async function progressCaptureOwner(jobId: string) {
    const capability = await checkpointProgressCapability();
    const mode = selectScanCheckpointMode(capability, resumedCheckpointFormat, jobId);
    if (checkpointProgressCapture && mode !== checkpointCaptureMode) {
      if (checkpointProgressCapture.hasPendingPreparation)
        throw new Error('Scan progress awaits its durable acknowledgment.');
      await checkpointProgressCapture.dispose();
      checkpointProgressCapture = undefined;
    }
    checkpointCaptureMode = mode;
    return (checkpointProgressCapture ??= createScanCheckpointProgressCapture(
      scanCheckpointModeOptions(capability, mode),
    ));
  }
  function checkpointCaptureInput(snapshot: AutomaticScanCheckpointSnapshot) {
    return {
      jobId: snapshot.jobId,
      createdAtMs: snapshot.createdAtMs,
      review: snapshot.review,
      budgetMs: snapshot.budgetMs,
      platform: snapshot.platform,
      observerProfile: snapshot.observerProfile,
      observations: snapshot.observations,
      publishedKeys: snapshot.publishedKeys,
      catalogRevision: scanStorageRevision,
      sources: scanScope.map((entry) => structuredClone(entry.source)),
      canonicalSources: structuredClone(env.catalog.sources),
      providers: env.settings.reviewedChannelProviders ?? null,
      ...(scanRegion ? { preferredRegion: scanRegion } : {}),
    };
  }
  let scanRegion: PreferredRegion | undefined;
  const scanProviderSources = () => providerScanSources(env.catalog, env.settings);
  // Included sources allow plain HTTP (owner decision); applied once to saved records.
  const adoptIncludedHttp = () =>
    (env.catalogWrites = env.catalogWrites
      .then(async () => {
        const next = allowIncludedHttp(env.catalog, await env.preferences.settledSnapshot());
        if (!next || env.applicationClosing) return;
        env.settings = await env.preferences.replaceAtomically(next.preferences, async () => {
          env.persistedCatalogRevision = (
            await writeRecordPair({
              catalog: serializeCatalog(next.catalog),
              preferences: exportPreferences(next.preferences),
              expectedCatalogRevision: env.persistedCatalogRevision,
            })
          ).catalogRevision;
        });
        env.catalog = next.catalog;
        env.catalogRevision++;
        if (!env.applicationClosing) env.applySettings();
      })
      .catch(() => undefined));
  let scanStorageRevision = '0';
  let healthPlatform: string | null = isTauri() ? null : 'browser-local';
  let automaticScanActive = false;
  /**
   * After each saved scan batch the page re-rendered the whole channel list and
   * asked for a full program-guide rebuild. On the Sansui (9,500 channels) both
   * grew with the list and held the database, so the scan stalled, then burst,
   * and crawled past about 15,000 checks (owner observation, October 21, 2026).
   * Owner rule: the guide is rebuilt only when the scan is done, and the list is
   * refreshed only after at least SCAN_LIST_BATCH new channels, then once at the
   * end; the progress counter shows the scan is moving meanwhile.
   */
  const SCAN_LIST_BATCH = 300;
  const scanBatchThrottle = { listed: -1, guidePending: false, startedMs: 0, listPending: false };
  // The guide update after a scan; the Slow pass waits for it (it can hold the
  // database for minutes on a slow TV: about 5 on the Sansui, October 22, 2026).
  let postScanGuides: Promise<void> | null = null;
  function requestGuidesAfterScan(): void {
    scanBatchThrottle.guidePending = false;
    if (env.applicationClosing) return;
    const work = env.automaticGuides
      .request()
      .then(() => undefined)
      .catch(() => {
        void env.diagnostics.emit({ operation: 'guide', level: 'warning', code: 'guide-failed' });
        env.element('source-refresh-status').textContent =
          'Channels saved. Some program guides could not connect; open Guide to retry.';
      })
      .finally(() => {
        if (postScanGuides === work) postScanGuides = null;
      });
    postScanGuides = work;
  }
  function scanBatchSettled(): void {
    const throttle = scanBatchThrottle;
    const count = env.catalog.channels.length;
    // listed: the list's size at the scan's start or its last refresh.
    if (!automaticScanActive || count - throttle.listed >= SCAN_LIST_BATCH) {
      throttle.listed = count;
      env.applySettings();
    }
    if (automaticScanActive) throttle.guidePending = true;
    else queueMicrotask(requestGuidesAfterScan);
  }
  /** The scan ended: the last list update and the guide rebuild happen now. */
  function flushScanBatchWork(slowPass = false): void {
    const throttle = scanBatchThrottle;
    if (throttle.listPending && !env.applicationClosing) {
      // The native scan's held list, guide and location updates, once.
      env.browser.search(env.element<HTMLInputElement>('search').value);
      env.guide.catalogChanged();
      env.geographyControls.update();
      env.updateVisibleGuide();
    }
    throttle.listPending = false;
    if (
      throttle.listed >= 0 &&
      throttle.listed !== env.catalog.channels.length &&
      !env.applicationClosing
    )
      env.applySettings();
    throttle.listed = -1;
    if (throttle.guidePending) requestGuidesAfterScan();
    // The scan's checks of saved channels count toward Not responding; a minute
    // of slack covers the page and native clocks differing slightly.
    const since = throttle.startedMs - 60_000;
    throttle.startedMs = 0;
    if (since > 0 && isTauri() && !env.applicationClosing)
      void env.channelCheckStore
        .recordFromScan(since, new AbortController().signal, slowPass)
        .then(() => env.savedChannelCheck.poke())
        .catch(() => {
          void env.diagnostics.emit({ operation: 'scan', level: 'warning', code: 'scan-failed' });
        });
  }
  const probeScheduler = createProbeScheduler();
  // Scan checks yield the network to whatever is on screen (two at a time while viewing).
  const scanProbeGate = createPlaybackProbeGate(() =>
    ['connecting', 'playing', 'buffering', 'reconnecting'].includes(env.player.snapshot.state),
  );
  // The Slow list check: one at a time, rested, none while viewing or out of sight.
  const slowPassGate = createSlowPassGate(
    () =>
      document.hidden ||
      !env.nativeViewingForeground ||
      ['connecting', 'playing', 'buffering', 'reconnecting'].includes(env.player.snapshot.state),
  );
  /**
   * One stream check as health evidence, shared by scans and the quiet saved
   * channel check: it yields to playback and keeps each site's pacing.
   */
  async function inspectStreamEvidence(
    url: string,
    allowHttp: boolean,
    signal: AbortSignal,
    budgetMs: 20000 | 45000 | 60000,
  ): Promise<HealthEvidence> {
    try {
      const result = await scanProbeGate.run(
        () =>
          probeScheduler.run(url, signal, async (operationSignal) => {
            const inspected = await inspectCheckedMediaSource(
              url,
              allowHttp,
              operationSignal,
              budgetMs,
            );
            // Install rate-limit cooldown before the scheduler releases this origin.
            probeScheduler.noteRetryAfter(url, inspected.retryAfter ?? null, inspected.status);
            return inspected;
          }),
        signal,
      );
      return result.status < 200 || result.status >= 300
        ? { kind: 'http', status: result.status }
        : result.kind === 'hls' || result.kind === 'media'
          ? { kind: 'http', status: result.status, contentRecognized: true }
          : { kind: 'unsupported' };
    } catch (error) {
      if (signal.aborted) return { kind: 'canceled' };
      if (error === 'timeout' || (error instanceof DOMException && error.name === 'TimeoutError'))
        return { kind: 'timeout' };
      return { kind: navigator.onLine === false ? 'local-network-unavailable' : 'network-failure' };
    }
  }
  let loggedScanFailureGeneration = -1;
  function logScanFailure(snapshot: Readonly<SourceScanSnapshot>): void {
    if (snapshot.phase !== 'failed' || loggedScanFailureGeneration === snapshot.generation) return;
    loggedScanFailureGeneration = snapshot.generation;
    const codes: Record<SourceScanSnapshot['lastFailure'], EventCode> = {
      none: 'scan-failed',
      'catalog-cas': 'scan-catalog-changed',
      'configuration-changed': 'scan-configuration-changed',
      'cancel-ack': 'scan-cancel-unconfirmed',
      capacity: 'scan-capacity',
      'publish-failed': 'scan-save-failed',
      canceled: 'scan-paused',
      other: 'scan-failed',
    };
    void env.diagnostics.emit({
      operation: 'scan',
      level: 'error',
      code: codes[snapshot.lastFailure],
      ...(snapshot.lastFailureCode ? { reason: snapshot.lastFailureCode } : {}),
      total: snapshot.total,
      checked: snapshot.checked,
      published: snapshot.published,
    });
  }
  /** A paused scan that Continue can resume; automatic source updates wait for it. */
  let pausedScanResumable = false;
  // Whether the latest scan run was the Slow list check.
  let inlineScanSlowPass = false;
  let slowPassTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * The Slow list (owner design, October 21, 2026): after a completed scan, the
   * streams its 3-second triage left unanswered are checked in the background
   * with the whole time limit. One that answers is saved and marked Slow.
   */
  // A Slow pass refused because the database was busy is tried again, a few times.
  let slowPassRetries = 0;
  function scheduleSlowPass(delayMs = 10_000): void {
    clearTimeout(slowPassTimer);
    slowPassTimer = setTimeout(async () => {
      slowPassTimer = undefined;
      // After the scan's guide update, which on a slow TV holds the database.
      if (postScanGuides) await postScanGuides;
      if (env.applicationClosing || automaticScanActive || !indexedFreshAvailable) return;
      if (
        env.contentLibrary !== 'live' ||
        document.hidden ||
        !env.nativeViewingForeground ||
        env.addChannelsEntryWork ||
        env.importRunning ||
        env.transferBusy
      ) {
        scheduleSlowPass(60_000);
        return;
      }
      sourceScan.startAutomatic(undefined, { presentation: 'inline', intent: 'slow' });
    }, delayMs);
  }
  function showInlineScanProgress(progress: Readonly<AutomaticScanProgress>): void {
    inlineScanSlowPass = progress.slowPass === true;
    pausedScanResumable =
      progress.canContinue &&
      progress.savedSummary !== 'invalid' &&
      progress.resumeRefusal === undefined &&
      ['paused', 'failed'].includes(progress.phase);
    inlineScanPanel.render(progress);
  }
  const inlineScanPanel = mountInlineScanPanel(document, () => env.applicationClosing);
  // Long scans only (owner design, October 22, 2026): black after 5 minutes
  // without input while a scan runs and nothing plays; never anywhere else.
  mountScanScreensaver(document, {
    scanActive: () => automaticScanActive && !env.applicationClosing,
    viewing: () =>
      ['connecting', 'playing', 'buffering', 'reconnecting'].includes(env.player.snapshot.state),
    status: () => env.element('inline-scan-status').textContent ?? '',
  });
  mountFirstScanHint(
    () => indexedFreshAvailable,
    () => env.catalog.channels.length,
  );
  const searchIndexFreshness = createIndexFreshness();
  const scanCollector = createScanSourceCollector({
    inspectSource,
    parse: parseInWorker,
    scope: () => scanScope,
    region: () => scanRegion,
  });
  const collectScanSource = scanCollector.collect;
  async function commitScanPublication(
    selection: Parameters<SourceScanHost['commit']>[0],
    revision: string,
    signal: AbortSignal,
    health?: Parameters<SourceScanHost['commit']>[3],
    checkpointContext?: Parameters<SourceScanHost['commit']>[4],
    episodeId?: string,
    windowChunks?: readonly SourceScanPublicationChunk[],
  ) {
    const preparedTrace =
      checkpointContext && publicationTraceByMutation.get(checkpointContext.mutation);
    const trace =
      (preparedTrace && scanPublicationObserver.resume(preparedTrace)) ||
      scanPublicationObserver.begin();
    if (checkpointContext) publicationTraceByMutation.set(checkpointContext.mutation, trace);
    const traceAttempt = scanPublicationObserver.snapshot().generation;
    scanPublicationObserver.step(trace, 'queued');
    const scope = structuredClone(scanScope);
    const expectedCatalogRevision = scanStorageRevision;
    const reviewedHealth = health === undefined ? undefined : structuredClone(health);
    let committedCheckpointRevision: string | undefined;
    let durableSelectionReceipt: SelectionSessionAck | undefined;
    let nativePublicationDispatched = false;
    const episode = episodeId === undefined ? undefined : env.selectionEpisode;
    const work = env.catalogWrites.then(async () => {
      const current = () => {
        signal.throwIfAborted();
        if (
          revision !== String(env.catalogRevision) ||
          selection.sessionRevision !== revision ||
          windowChunks?.some((chunk) => chunk.staged.sessionRevision !== revision)
        )
          throw new Error('Saved channels changed. Scan again before saving.');
      };
      current();
      if (
        episodeId !== undefined &&
        (!episode ||
          episode.id !== episodeId ||
          episode.broken ||
          episode.catalog !== env.catalog ||
          episode.revision !== expectedCatalogRevision)
      )
        throw new Error('Scan preparation changed. Continue the scan again.');
      if (env.importRunning || env.transferBusy)
        throw new Error('Wait for the current import to finish.');
      env.transferBusy = true;
      env.setImportBusy(true);
      const releaseUncommittedWindowCheckpoint = async () => {
        if (!checkpointContext || !checkpointProgressCapture?.hasPendingPreparation) return;
        const actual = await readScanCheckpoint();
        current();
        if (
          actual.catalogRevision !== expectedCatalogRevision ||
          actual.checkpointRevision !== checkpointContext.expectedCheckpointRevision ||
          actual.checkpointStatus === 'invalid'
        )
          throw new Error('Scan progress changed. Reopen the app before continuing.');
        checkpointProgressCapture.releaseUncommittedPreparation(
          checkpointContext.expectedCheckpointRevision,
          actual.checkpointRevision,
        );
      };
      try {
        const snapshot = await env.preferences.settledSnapshot();
        current();
        const boundedBatch =
          selection.sources.reduce((sum, source) => sum + source.candidates.length, 0) <= 64;
        const nativeBatch = boundedBatch && (await supportsNativeScanBatch(signal));
        current();
        if (
          windowChunks &&
          (!episode?.supportsWindow || windowChunks.length < 1 || windowChunks.length > 4)
        )
          throw new Error('Scan window preparation is unavailable. Continue the scan again.');
        if (episode && !nativeBatch)
          throw new Error('Scan preparation is unavailable. Continue the scan again.');
        scanPublicationObserver.step(trace, 'read-revisions', {
          catalogRevision: expectedCatalogRevision,
        });
        const saved = nativeBatch
          ? await nativeScanBatchCommit.revisions(signal)
          : await readScanHealth();
        current();
        if (saved.catalogRevision !== expectedCatalogRevision)
          throw new Error('Saved channels changed. Reopen the app and scan again.');
        const baseCatalog = env.catalog;
        // Compact replies target bounded progressive batches. Large manual imports
        // retain the existing full-transfer path instead of deriving a full-size patch.
        const prepare = boundedBatch ? prepareCompactScanInWorker : prepareScanInWorker;
        scanPublicationObserver.step(trace, 'actor-prepare', {
          healthRevision: saved.healthRevision,
        });
        const prepared =
          windowChunks && episode
            ? await episode.actor.prepareWindow(
                {
                  schemaVersion: 1,
                  chunks: windowChunks.map((chunk) => ({
                    selection: chunk.staged,
                    review: chunk.health,
                  })),
                  preferences: snapshot,
                  expectedCatalogRevision,
                },
                signal,
              )
            : nativeBatch
              ? episode
                ? await episode.actor.prepare(
                    {
                      selection,
                      preferences: snapshot,
                      review: reviewedHealth,
                      expectedCatalogRevision,
                    },
                    signal,
                  )
                : await prepareNativeScanBatchInWorker(
                    baseCatalog,
                    snapshot,
                    selection,
                    scope,
                    signal,
                    reviewedHealth,
                  )
              : await prepare(baseCatalog, snapshot, selection, scope, signal, {
                  previousHealth: (
                    await decodeSavedHealthOnlyInWorker(
                      saved as Awaited<ReturnType<typeof readScanHealth>>,
                      signal,
                    )
                  ).health,
                  review: reviewedHealth,
                });
        current();
        if (env.catalog !== baseCatalog)
          throw new Error('Saved channels changed before scan publication.');
        if (
          episode &&
          (!('preparationId' in prepared) ||
            typeof prepared.preparationId !== 'string' ||
            !('expectedCatalogRevision' in prepared) ||
            prepared.expectedCatalogRevision !== expectedCatalogRevision)
        )
          throw new Error('Scan preparation did not confirm its catalog revision.');
        scanPublicationObserver.step(trace, 'patch-admission');
        const nextCatalog =
          'chunks' in prepared
            ? prepared.chunks.reduce(
                (previous, chunk) =>
                  applyCatalogPatch(
                    previous,
                    chunk.catalogPatch,
                    scope.map((entry) => entry.source),
                  ),
                baseCatalog,
              )
            : 'catalogPatch' in prepared
              ? applyCatalogPatch(
                  baseCatalog,
                  prepared.catalogPatch,
                  scope.map((entry) => entry.source),
                )
              : prepared.record.catalog;
        const preparedPreferences =
          'nextPreferences' in prepared
            ? prepared.nextPreferences
            : 'catalogPatch' in prepared
              ? prepared.preferences
              : prepared.record.preferences;
        // Scan preparation changes sources only. Preserve edits acknowledged
        // while its worker/storage preparation was pending, including audio.
        const latestPreferences = await env.preferences.settledSnapshot();
        current();
        const nextPreferences = {
          ...latestPreferences,
          sources: preparedPreferences.sources,
        };
        const selectedSourceIds = new Set(
          (windowChunks ? windowChunks.flatMap((chunk) => chunk.staged.sources) : selection.sources)
            .filter((source) => source.candidates.length > 0)
            .map((source) => source.sourceId),
        );
        const windowInput =
          'chunks' in prepared
            ? {
                schemaVersion: 1 as const,
                chunks: prepared.chunks,
                authorizedSources: nextCatalog.sources.filter((source) =>
                  selectedSourceIds.has(source.id),
                ),
                nextPreferences,
                expectedCatalogRevision,
                expectedHealthRevision: saved.healthRevision,
                ...(checkpointContext
                  ? {
                      scanCheckpoint: checkpointContext.mutation,
                      expectedCheckpointRevision: checkpointContext.expectedCheckpointRevision,
                    }
                  : {}),
              }
            : undefined;
        scanPublicationObserver.step(trace, 'window-admission');
        if (
          windowInput &&
          !boundedUtf8Text(
            JSON.stringify({ window: windowInput, requestId: '0'.repeat(36) }),
            20 * 1024 * 1024,
          )
        ) {
          // No native write has been dispatched. Release the pending checkpoint only
          // after checking storage; the failed episode's provisional actor is discarded.
          await releaseUncommittedWindowCheckpoint();
          throw new SourceScanWindowSizeError();
        }
        if (windowInput) {
          validateScanWindow(windowInput);
          scanPublicationObserver.step(trace, 'window-admission', {
            wireBytes: new TextEncoder().encode(
              JSON.stringify({ window: windowInput, requestId: '0'.repeat(36) }),
            ).byteLength,
          });
        }
        env.settings = await env.preferences.replaceAtomically(nextPreferences, async () => {
          current();
          nativePublicationDispatched = true;
          scanPublicationObserver.step(trace, 'native-dispatch', { dispatched: true });
          const receipt = windowInput
            ? await nativeScanWindowCommit.commit(windowInput, signal, (code) => {
                scanNativeFailures = Object.freeze([
                  ...scanNativeFailures.slice(-1),
                  Object.freeze({ attempt: traceAttempt, code }),
                ]);
              })
            : 'incomingHealth' in prepared
              ? await nativeScanBatchCommit.commit(
                  {
                    schemaVersion: 1,
                    catalogPatch: prepared.catalogPatch,
                    authorizedSources: nextCatalog.sources.filter((source) =>
                      selectedSourceIds.has(source.id),
                    ),
                    nextPreferences,
                    incomingHealth: prepared.incomingHealth,
                    expectedCatalogRevision,
                    expectedHealthRevision: saved.healthRevision,
                    ...(checkpointContext
                      ? {
                          scanCheckpoint: checkpointContext.mutation,
                          expectedCheckpointRevision: checkpointContext.expectedCheckpointRevision,
                        }
                      : {}),
                  },
                  signal,
                )
              : 'catalogText' in prepared
                ? await writeRecordPair(
                    {
                      catalog: prepared.catalogText,
                      preferences: JSON.stringify(nextPreferences),
                      health: prepared.healthText,
                      expectedCatalogRevision,
                      expectedHealthRevision: saved.healthRevision,
                      ...(checkpointContext
                        ? {
                            scanCheckpoint: checkpointContext.mutation,
                            expectedCheckpointRevision:
                              checkpointContext.expectedCheckpointRevision,
                          }
                        : {}),
                    },
                    signal,
                  )
                : await Promise.reject(new Error('Scan window preparation was not admitted.'));
          scanPublicationObserver.step(trace, 'native-settled', {
            durableCommitted: true,
            catalogRevision: receipt.catalogRevision,
            healthRevision: receipt.healthRevision,
            ...(receipt.checkpointRevision === undefined
              ? {}
              : { checkpointRevision: receipt.checkpointRevision }),
          });
          env.persistedCatalogRevision = receipt.catalogRevision;
          scanStorageRevision = receipt.catalogRevision;
          if (checkpointContext && receipt.checkpointRevision === undefined)
            throw new Error('Channel save did not confirm scan progress.');
          committedCheckpointRevision = receipt.checkpointRevision;
          durableSelectionReceipt = {
            committed: true,
            catalogRevision: receipt.catalogRevision,
            healthRevision: receipt.healthRevision,
          };
        });
        env.catalog = nextCatalog;
        env.catalogRevision++;
        const preparationId =
          'preparationId' in prepared && typeof prepared.preparationId === 'string'
            ? prepared.preparationId
            : undefined;
        if (episode && preparationId && durableSelectionReceipt) {
          episode.catalog = env.catalog;
          episode.revision = durableSelectionReceipt.catalogRevision;
          try {
            scanPublicationObserver.step(trace, 'actor-ack');
            if ('chunks' in prepared)
              await episode.actor.acknowledgeWindow(preparationId, durableSelectionReceipt);
            else await episode.actor.acknowledge(preparationId, durableSelectionReceipt);
          } catch {
            scanPublicationObserver.fail(trace, 'ack-failed');
            // The native write already committed. Preserve its receipt and published membership.
            episode.broken = true;
            await episode.actor.dispose().catch(() => undefined);
            void env.diagnostics.emit({ operation: 'scan', level: 'warning', code: 'scan-failed' });
          }
        }
        scanPublicationObserver.step(trace, 'apply-ui');
        const selected = env.player.snapshot.selection;
        if (
          selected &&
          !env.catalog.channels.some(
            (channel) => channel.id === selected.id && channel.urls.includes(selected.url),
          )
        )
          await env.sharingBridge
            .stop()
            .catch(() => env.notice('Channels saved. Playback cleanup needs attention.'));
        scanBatchSettled();
        if (!checkpointContext) scanPublicationObserver.complete(trace);
        return {
          committed: true as const,
          revision: String(env.catalogRevision),
          ...(committedCheckpointRevision === undefined
            ? {}
            : { checkpointRevision: committedCheckpointRevision }),
        };
      } catch (error) {
        scanPublicationObserver.fail(
          trace,
          signal.aborted
            ? 'canceled'
            : nativePublicationDispatched
              ? 'native-failed'
              : 'admission-refused',
        );
        let failure = error;
        if (windowChunks && !nativePublicationDispatched && isSelectionWindowSizeError(error)) {
          try {
            await releaseUncommittedWindowCheckpoint();
            failure = new SourceScanWindowSizeError();
          } catch (refusal) {
            failure = refusal;
          }
        }
        if (episode && !durableSelectionReceipt) {
          episode.broken = true;
          await episode.actor.quarantine().catch(() => undefined);
        }
        throw failure;
      } finally {
        env.transferBusy = false;
        env.setImportBusy(false);
      }
    });
    env.catalogWrites = work.catch(() => undefined);
    void work.catch(() =>
      scanPublicationObserver.fail(
        trace,
        signal.aborted ? 'canceled' : episode?.broken ? 'actor-failed' : 'unknown',
      ),
    );
    return work;
  }
  // The native capability stays disabled until the complete runtime has been admitted.
  const boundedScanPublicationSync: {
    current:
      | ((
          context: {
            planId: string;
            previousRevisions: BoundedScanRevisions;
            receipt: BoundedScanAck;
            expectedPreferenceSources: readonly Source[];
          },
          signal: AbortSignal,
        ) => Promise<void>)
      | null;
  } = { current: null };
  const readBoundedPublicationProjection = createScanPublicationProjectionReader({ invoke });
  boundedScanPublicationSync.current = async (context, signal) => {
    const base = env.catalog;
    const current = () =>
      env.catalog === base && env.persistedCatalogRevision === context.receipt.catalogRevision;
    const projection = await readBoundedPublicationProjection(
      context.receipt,
      base.sources,
      signal,
    );
    signal.throwIfAborted();
    if (!current()) throw new Error('Saved channels changed before publication adoption.');
    const sourceMap = new Map(base.sources.map((source) => [source.id, source]));
    for (const source of projection.sources) sourceMap.set(source.id, source);
    if (sourceMap.size > 100) throw new Error('Saved source projection exceeds its bound.');
    const indices = new Map(projection.channels.map((channel) => [channel.id, -1]));
    for (let i = 0; projection.channels.length && i < base.channels.length; i++) {
      const channel = base.channels[i]!;
      if (indices.has(channel.id)) indices.set(channel.id, i);
    }
    let additions = 0;
    for (const channel of projection.channels) {
      const index = indices.get(channel.id)!;
      if (index < 0) additions++;
      else if (base.channels[index]!.sourceId !== channel.sourceId)
        throw new Error('Saved channel identity changed source.');
    }
    if (base.channels.length + additions > 100000)
      throw new Error('Saved channel projection exceeds its bound.');
    // Preserve old capture arrays; clone only pointers, not the existing channel object graph.
    const channels = projection.channels.length ? base.channels.slice() : base.channels;
    for (const channel of projection.channels) {
      const index = indices.get(channel.id)!;
      if (index < 0) channels.push(channel);
      else channels[index] = channel;
    }
    const sources = [...sourceMap.values()];
    // Even a health-only/no-source-change receipt must not adopt across a queued source revoke/edit.
    const adoptedSources = await env.preferences.adoptAcknowledgedSources(
      projection.sources,
      context.expectedPreferenceSources,
      current,
    );
    if (!current()) throw new Error('Saved channels changed before publication adoption.');
    env.catalogRevision++;
    if (!projection.channels.length && !projection.sources.length) return;
    env.catalog = { ...base, sources, channels };
    if (projection.sources.length) env.settings = { ...env.settings, sources: [...adoptedSources] };
    env.catalogBrowseViewRevision++;
    if (!env.applicationClosing) {
      if (projection.sources.length) env.renderCatalog();
      else if (automaticScanActive) {
        // Owner rule (October 21, 2026): while a scan runs the list refreshes
        // only after 300 new channels, and the guide waits for the scan's end
        // (flushScanBatchWork). A page the list scrolls into later re-reads
        // itself if the catalog has moved on (catalog-window.ts).
        scanBatchThrottle.listPending = true;
        if (env.catalog.channels.length - scanBatchThrottle.listed >= SCAN_LIST_BATCH) {
          scanBatchThrottle.listed = env.catalog.channels.length;
          env.browser.search(env.element<HTMLInputElement>('search').value);
        }
        return;
      } else {
        // Existing indexed apply reads the new revision/window; it does not rebuild all search metadata.
        env.browser.search(env.element<HTMLInputElement>('search').value);
        env.guide.catalogChanged();
        env.geographyControls.update();
      }
      env.updateVisibleGuide();
    }
  };
  let boundedResumeCapability: Promise<boolean> | null = null;
  let indexedFreshAvailable = false;
  let boundedScanGeneration = 0;
  let boundedRootDiagnostic: Readonly<{
    stage: BoundedRootStage;
    catalogMatches: boolean;
    importRunning: boolean;
    transferBusy: boolean;
    closing: boolean;
  }> | null = null;
  let boundedTransportDiagnostic: Readonly<BoundedScanTransportDiagnostic> | null = null;
  let boundedTransportFailure: Readonly<BoundedScanTransportDiagnostic> | null = null;
  let boundedTransportFailures = new Map<string, Readonly<BoundedScanTransportDiagnostic>>();
  let boundedServiceDiagnostic: Readonly<BoundedScanServiceDiagnostic> | null = null;
  let boundedServiceFailure: Readonly<BoundedScanServiceDiagnostic> | null = null;
  let boundedServiceFailures = new Map<string, Readonly<BoundedScanServiceDiagnostic>>();
  Object.defineProperty(window, '__GENX_BOUNDED_SCAN__', {
    get: () =>
      Object.freeze({
        schemaVersion: 1,
        generation: boundedScanGeneration,
        root: boundedRootDiagnostic,
        transport: boundedTransportDiagnostic,
        transportFailure: boundedTransportFailure,
        transportFailures: Object.freeze([...boundedTransportFailures.values()]),
        service: boundedServiceDiagnostic,
        serviceFailure: boundedServiceFailure,
        serviceFailures: Object.freeze([...boundedServiceFailures.values()]),
      }),
    configurable: false,
  });
  function supportsBoundedResume(signal: AbortSignal): Promise<boolean> {
    if (!isTauri()) return Promise.resolve(false);
    if (boundedResumeCapability) return boundedResumeCapability;
    const transport = createBoundedNativeScanResumeTransport({
      runtime: { invoke },
      currentFence: () => ({
        expectedCatalogRevision: env.persistedCatalogRevision,
        expectedCheckpointRevision: '0',
      }),
    });
    const pending = transport
      .capabilities(signal)
      .then((supported) => {
        indexedFreshAvailable = supported;
        return supported;
      })
      .catch((error) => {
        if (boundedResumeCapability === pending) boundedResumeCapability = null;
        throw error;
      });
    boundedResumeCapability = pending;
    return pending;
  }
  async function prepareInlineScanEntry(signal: AbortSignal) {
    if (sourceScan.snapshot().busy) return 'running' as const;
    let supported: boolean;
    try {
      supported = await supportsBoundedResume(signal);
    } catch {
      signal.throwIfAborted();
      throw new BoundedScanEntryRefusal();
    }
    if (!supported) return sourceScan.prepareAutomaticEntry();
    let summary: Awaited<ReturnType<typeof nativeScanCheckpointSummary.read>>;
    try {
      summary = await nativeScanCheckpointSummary.read(signal);
    } catch {
      signal.throwIfAborted();
      throw new BoundedScanEntryRefusal();
    }
    signal.throwIfAborted();
    if (summary.checkpointStatus === 'valid' && summary.storedVersion !== 3)
      return sourceScan.prepareAutomaticEntry();
    // Structural saved-state only. Continue still performs full native admission in its owner.
    sourceScan.presentSavedSummary(summary, sourceScan.snapshot().generation);
    return summary.checkpointStatus === 'absent'
      ? ('fresh' as const)
      : summary.checkpointStatus !== 'valid'
        ? ('unavailable' as const)
        : summary.unfinished
          ? ('unfinished' as const)
          : ('completed' as const);
  }
  async function createApplicationBoundedResume(
    scope: { jobId: string | null; checkpointRevision?: string; query?: string; slow?: boolean },
    signal: AbortSignal,
  ) {
    if (!(await supportsBoundedResume(signal))) return null;
    await env.catalogWrites;
    await env.preferences.settledSources();
    signal.throwIfAborted();
    if (env.applicationClosing) throw new DOMException('Scan entry canceled.', 'AbortError');
    const summary = await nativeScanCheckpointSummary.read(signal);
    signal.throwIfAborted();
    if (summary.checkpointStatus === 'valid' && summary.storedVersion !== 3) return null;
    if (
      summary.checkpointStatus === 'valid' &&
      summary.catalogRevision !== env.persistedCatalogRevision
    )
      throw new ScanSourcesChanged();
    if (
      summary.checkpointStatus !== 'valid' ||
      summary.storedVersion !== 3 ||
      (scope.checkpointRevision !== undefined &&
        scope.checkpointRevision !== summary.checkpointRevision)
    )
      throw new Error('Saved scan progress is unavailable for Continue.');
    const synchronize = boundedScanPublicationSync.current;
    if (!synchronize) throw new Error('Bounded scan publication is unavailable.');
    const diagnosticGeneration = ++boundedScanGeneration;
    boundedTransportDiagnostic = boundedTransportFailure = null;
    boundedServiceDiagnostic = boundedServiceFailure = null;
    boundedTransportFailures = new Map();
    boundedServiceFailures = new Map();
    const recordRoot = (stage: BoundedRootStage, expected = env.persistedCatalogRevision) => {
      if (diagnosticGeneration !== boundedScanGeneration) return;
      boundedRootDiagnostic = Object.freeze({
        stage,
        catalogMatches: expected === env.persistedCatalogRevision,
        importRunning: env.importRunning,
        transferBusy: env.transferBusy,
        closing: env.applicationClosing,
      });
    };
    recordRoot('created');
    const transport = createBoundedNativeScanResumeTransport({
      runtime: { invoke },
      onDiagnostic: (event) => {
        if (diagnosticGeneration !== boundedScanGeneration) return;
        boundedTransportDiagnostic = event;
        if (event.code !== null) {
          boundedTransportFailure = event;
          boundedTransportFailures.set(event.command, event);
        }
      },
      currentFence: () => ({
        expectedCatalogRevision: summary.catalogRevision,
        expectedCheckpointRevision: summary.checkpointRevision,
      }),
    });
    let quarantined = false;
    let acknowledgedCounts: BoundedScanAck['counts'] | null = null;
    const current = () => {
      if (quarantined || env.applicationClosing)
        throw new Error('Scan publication synchronization is unavailable.');
    };
    const host = {
      ...transport.host,
      admit: async (...args: Parameters<typeof transport.host.admit>) => {
        // Window negotiation belongs to this episode's transport, not the entry capability cache.
        if (!(await transport.capabilities(args[0])))
          throw new Error('Native scan support changed. Reopen the app before continuing.');
        args[0].throwIfAborted();
        const plan = await transport.host.admit(...args).catch((error: unknown) => {
          throw sourcesChangedRefusal(boundedTransportFailure?.code, error);
        });
        if (scope.jobId !== null && scope.jobId !== plan.jobId) {
          await transport.host.close(plan.planId);
          throw Object.assign(new Error('Saved scan ownership changed before Continue.'), {
            name: 'ScanAdmissionClosedError',
          });
        }
        acknowledgedCounts = { ...plan.counts };
        return plan;
      },
      take: (...args: Parameters<typeof transport.host.take>) => {
        current();
        return transport.host.take(...args);
      },
      probe: (...args: Parameters<typeof transport.host.probe>) => {
        current();
        return (scope.slow ? slowPassGate : scanProbeGate).run(() => {
          current();
          return transport.host.probe(...args);
        }, args[1]);
      },
      commit: (
        planId: string,
        request: Parameters<typeof transport.host.commit>[1],
        commitSignal: AbortSignal,
      ) => {
        recordRoot('commit-queued', request.expectedRevisions.catalogRevision);
        const pending = env.catalogWrites.then(async () => {
          recordRoot('commit-entered', request.expectedRevisions.catalogRevision);
          current();
          commitSignal.throwIfAborted();
          if (
            request.expectedRevisions.catalogRevision !== env.persistedCatalogRevision ||
            env.importRunning ||
            env.transferBusy
          ) {
            recordRoot('root-admission-refused', request.expectedRevisions.catalogRevision);
            throw new Error('Saved channels changed. Continue the scan again.');
          }
          const expectedPreferenceSources = await env.preferences.settledSources();
          recordRoot('preferences-settled', request.expectedRevisions.catalogRevision);
          current();
          commitSignal.throwIfAborted();
          if (request.expectedRevisions.catalogRevision !== env.persistedCatalogRevision)
            throw new Error('Saved channels changed. Continue the scan again.');
          recordRoot('native-commit', request.expectedRevisions.catalogRevision);
          const receipt = await transport.host.commit(planId, request, commitSignal);
          recordRoot('native-acknowledged');
          const sameIndices = (a: readonly number[], b: readonly number[]) =>
            a.length === b.length &&
            new Set(a).size === a.length &&
            a.every((index) => b.includes(index));
          if (
            !acknowledgedCounts ||
            receipt.counts.total !== acknowledgedCounts.total ||
            receipt.counts.checked < acknowledgedCounts.checked ||
            receipt.counts.checked > acknowledgedCounts.checked + request.observations.length ||
            receipt.counts.responded < acknowledgedCounts.responded ||
            receipt.counts.responded > acknowledgedCounts.responded + request.observations.length ||
            receipt.counts.published !==
              acknowledgedCounts.published + request.publicationIndices.length ||
            BigInt(receipt.catalogRevision) < BigInt(request.expectedRevisions.catalogRevision) ||
            BigInt(receipt.catalogRevision) >
              BigInt(request.expectedRevisions.catalogRevision) + 1n ||
            BigInt(receipt.healthRevision) < BigInt(request.expectedRevisions.healthRevision) ||
            BigInt(receipt.healthRevision) >
              BigInt(request.expectedRevisions.healthRevision) + 1n ||
            BigInt(receipt.checkpointRevision) !==
              BigInt(request.expectedRevisions.checkpointRevision) + 1n ||
            !sameIndices(
              receipt.acknowledgedIndices,
              request.observations.map((entry) => entry.candidateIndex),
            ) ||
            !sameIndices(receipt.publicationIndices, request.publicationIndices)
          ) {
            quarantined = true;
            throw new Error(
              'Saved scan receipt could not be confirmed. Reopen the app before continuing.',
            );
          }
          acknowledgedCounts = { ...receipt.counts };
          // A durable receipt remains true even if postcommit projection/adoption fails.
          env.persistedCatalogRevision = receipt.catalogRevision;
          scanStorageRevision = receipt.catalogRevision;
          try {
            await synchronize(
              {
                planId,
                previousRevisions: request.expectedRevisions,
                receipt,
                expectedPreferenceSources,
              },
              new AbortController().signal,
            );
            queueMicrotask(() => {
              if (!env.applicationClosing)
                void env.automaticGuides
                  .request()
                  .catch(() =>
                    env.notice(
                      'Channels saved. Some program guides could not connect; open Guide to retry.',
                    ),
                  );
            });
          } catch {
            recordRoot('projection-refused');
            quarantined = true;
            env.notice('Channels were saved. Reopen the app before continuing this scan.');
            void env.diagnostics.emit({ operation: 'scan', level: 'warning', code: 'scan-failed' });
          }
          return receipt;
        });
        env.catalogWrites = pending.then(
          () => undefined,
          () => undefined,
        );
        return pending;
      },
    };
    return createBoundedScanResumeService(host, {
      signal,
      onDiagnostic: (event) => {
        if (diagnosticGeneration !== boundedScanGeneration) return;
        boundedServiceDiagnostic = event;
        if (!['host-dispatch'].includes(event.stage)) {
          boundedServiceFailure = event;
          boundedServiceFailures.set(event.operation, event);
        }
      },
    });
  }
  const sourceActivation = createSourceSnapshotActivationTransport();
  const sourceScan = mountSourceScan(env.element('source-scan-settings'), {
    indexedFreshAvailable: () => indexedFreshAvailable,
    createIndexedFreshResume: async (input, signal) => {
      if (!(await supportsBoundedResume(signal)))
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
        const service = await createApplicationBoundedResume(
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
      const platform = healthPlatform;
      if (!platform) throw new Error('Native channel checks are unavailable.');
      const sources = input.sources
        ? input.sources.map(({ source }) => validateSource(source))
        : scanProviderSources();
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
      let geography: ReturnType<typeof scanCollector.readGeography> | undefined;
      const collection = createPagedSourceCollection({
        inspectSource,
        geography: (source, ownedSignal) => {
          const url = new URL(source.location);
          if (url.origin !== 'https://iptv-org.github.io' || !url.pathname.startsWith('/iptv/'))
            return Promise.resolve(undefined);
          return (geography ??= scanCollector.readGeography(ownedSignal));
        },
      });
      let activation: SourceSnapshotActivationReply | undefined;
      const coordinator = createIncrementalRefreshCoordinator({
        snapshots,
        freshness: searchIndexFreshness,
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
          activation = await sourceActivation(
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
              ...(await scanCollector.discoveryHints(scope.query, ownedSignal)),
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
      const service = await createApplicationBoundedResume(
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
    createBoundedResume: createApplicationBoundedResume,
    onProgress: showInlineScanProgress,
    onDiagnostic: logScanFailure,
    activity: (active) => {
      if (active) {
        clearTimeout(slowPassTimer);
        void env.diagnostics.emit({ operation: 'scan', level: 'info', code: 'scan-started' });
      } else
        queueMicrotask(() => {
          const snapshot = sourceScan.snapshot();
          // A completed scan hands the streams its triage left to the Slow list.
          if (snapshot.phase === 'completed' && !inlineScanSlowPass) {
            slowPassRetries = 0;
            scheduleSlowPass();
          } else if (
            inlineScanSlowPass &&
            snapshot.phase === 'failed' &&
            snapshot.lastFailureCode === 'sqlite-busy' &&
            slowPassRetries < 3
          ) {
            // The database was busy (another long write): try again later.
            slowPassRetries++;
            scheduleSlowPass(120_000);
          }
          if (snapshot.phase === 'failed') logScanFailure(snapshot);
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
      automaticScanActive = active;
      if (active && scanBatchThrottle.listed < 0) {
        scanBatchThrottle.listed = env.catalog.channels.length;
        scanBatchThrottle.startedMs = Date.now();
      }
      if (!active) flushScanBatchWork(inlineScanSlowPass);
      env.updateImportActions();
      void env.activityWake.setScan(active).catch(() => undefined);
    },
    checkpoint: {
      load: async (signal) => {
        checkpointProgressCapture?.reset();
        resumedCheckpointFormat = null;
        const recovery = scanRecoveryObserver.begin();
        await env.catalogWrites;
        await env.preferences.settledSnapshot();
        signal.throwIfAborted();
        const saved = await readScanCheckpoint().catch((error: unknown) => {
          scanRecoveryObserver.refuse(recovery, signal.aborted ? 'canceled' : 'read-unavailable');
          throw error;
        });
        signal.throwIfAborted();
        if (saved.catalogRevision !== env.persistedCatalogRevision) {
          scanRecoveryObserver.refuse(recovery, 'saved-catalog-changed');
          throw new Error('Saved channels changed. Reopen the app before scanning.');
        }
        scanStorageRevision = saved.catalogRevision;
        if (saved.checkpointStatus !== 'valid' || saved.checkpoint === null) {
          if (saved.checkpointStatus === 'absent') scanRecoveryObserver.step(recovery, 'absent');
          else scanRecoveryObserver.refuse(recovery, 'invalid-checkpoint');
          return saved;
        }
        scanRecoveryObserver.step(recovery, 'decoding');
        const parsed = await parseScanCheckpointCapture(saved.checkpoint, signal).catch(
          (error: unknown) => {
            scanRecoveryObserver.refuse(
              recovery,
              signal.aborted ? 'canceled' : 'invalid-checkpoint',
            );
            throw error;
          },
        );
        scanRecoveryObserver.decoded(
          recovery,
          parsed.schemaVersion,
          parsed.observations.length,
          parsed.schemaVersion === 3 ? parsed.publishedIndices.length : parsed.publishedKeys.length,
        );
        if (parsed.schemaVersion === 3) {
          const capability = await checkpointProgressCapability();
          signal.throwIfAborted();
          if (!capability.packedReference) {
            scanRecoveryObserver.refuse(recovery, 'unsupported-format');
            return { ...saved, checkpoint: null, checkpointStatus: 'invalid' as const };
          }
        }
        scanRecoveryObserver.step(recovery, 'source-authority');
        try {
          await validateCheckpointSourceAdmission(
            parsed,
            env.catalog.sources,
            env.settings.reviewedChannelProviders ?? null,
          );
        } catch {
          signal.throwIfAborted();
          scanRecoveryObserver.refuse(recovery, 'source-settings-changed');
          return { ...saved, checkpoint: null, checkpointStatus: 'invalid' as const };
        }
        scanRecoveryObserver.step(recovery, 'policy');
        const policy = await fingerprintScanPolicy({
          providers: env.settings.reviewedChannelProviders ?? null,
          preferredRegion: env.settings.preferredRegion,
          budgetMs: parsed.budgetMs,
          platform: healthPlatform ?? 'native-unavailable',
          observerProfile: reachabilityHealthProfile(isTauri(), parsed.budgetMs),
          sourceDefinitions: parsed.sourceDefinitions,
        });
        signal.throwIfAborted();
        if (!canResumeScanCheckpoint(parsed, Date.now(), env.persistedCatalogRevision, policy)) {
          scanRecoveryObserver.refuse(recovery, 'expired-or-policy-changed');
          return { ...saved, checkpoint: null, checkpointStatus: 'invalid' as const };
        }
        scanRegion = parsed.preferredRegion ? structuredClone(parsed.preferredRegion) : undefined;
        scanScope = parsed.sourceDefinitions.map((definition) => ({
          source: structuredClone(definition.source),
          fingerprint: parsed.review.sources.find(
            (source) => source.sourceId === definition.source.id,
          )!.fingerprint,
        }));
        if (parsed.schemaVersion === 2 || parsed.schemaVersion === 3) {
          try {
            if (parsed.schemaVersion === 3) {
              scanRecoveryObserver.step(recovery, 'candidate-storage');
              const client = await candidateManifestClient(signal);
              const revisions = {
                expectedCatalogRevision: saved.catalogRevision,
                expectedCheckpointRevision: saved.checkpointRevision,
              };
              const header = client
                ? await client.lookup(parsed.jobId, parsed.reviewDigest, revisions, signal)
                : null;
              signal.throwIfAborted();
              if (client && header) {
                scanRecoveryObserver.step(recovery, 'candidate-restore');
                const restored = await client.restore(
                  {
                    checkpoint: saved.checkpoint,
                    header,
                    readPage: (startIndex, readSignal) =>
                      client.readPage(header, startIndex, revisions, readSignal),
                  },
                  signal,
                );
                signal.throwIfAborted();
                scanRecoveryObserver.step(recovery, 'catalog-fence');
                if (
                  saved.catalogRevision !== env.persistedCatalogRevision ||
                  env.applicationClosing
                )
                  throw new Error('Saved channels changed during scan recovery.');
                manifestBackedJobId = parsed.jobId;
                resumedCheckpointFormat = { jobId: parsed.jobId, schemaVersion: 3 };
                scanRecoveryObserver.step(recovery, 'accepted');
                return { ...saved, parsed: restored };
              }
            }
            scanRecoveryObserver.step(recovery, 'reacquiring');
            scanCollector.reset();
            const acquired = await scanConfiguredSources(scanScope, collectScanSource, {
              sessionRevision: parsed.review.sessionRevision,
              // Resume resolves the captured URLs, even if their current display metadata changed.
              query: '',
              signal,
            });
            signal.throwIfAborted();
            scanRecoveryObserver.step(recovery, 'source-definition');
            for (const definition of parsed.sourceDefinitions) {
              const observed = scanScope.find((entry) => entry.source.id === definition.source.id);
              if (
                !observed ||
                (await fingerprintScanSource(observed.source)) !== definition.definitionFingerprint
              )
                throw new Error('Saved source definition changed.');
            }
            const review = reorderScanCandidates(acquired, scanRegion);
            scanRecoveryObserver.step(recovery, 'immutable-review');
            const restored =
              parsed.schemaVersion === 3
                ? await restorePackedCapture(parsed, review, signal)
                : await restoreReferencedCapture(parsed, review, signal);
            signal.throwIfAborted();
            scanRecoveryObserver.step(recovery, 'catalog-fence');
            // Reacquisition is read-only and never grants a source or repeats settled probes.
            if (saved.catalogRevision !== env.persistedCatalogRevision || env.applicationClosing)
              throw new Error('Saved channels changed during scan recovery.');
            resumedCheckpointFormat = { jobId: parsed.jobId, schemaVersion: parsed.schemaVersion };
            scanRecoveryObserver.step(recovery, 'accepted');
            return { ...saved, parsed: restored };
          } catch (error) {
            signal.throwIfAborted();
            const stage = scanRecoveryObserver.snapshot().stage;
            scanRecoveryObserver.refuse(
              recovery,
              stage === 'catalog-fence'
                ? 'saved-catalog-changed'
                : stage === 'candidate-storage' || stage === 'candidate-restore'
                  ? 'candidate-storage-unavailable'
                  : stage === 'immutable-review'
                    ? 'immutable-review-changed'
                    : stage === 'source-definition'
                      ? 'source-settings-changed'
                      : 'source-unavailable',
              stage === 'immutable-review' ? scanReconstructionFailureCode(error) : null,
            );
            return { ...saved, checkpoint: null, checkpointStatus: 'invalid' as const };
          } finally {
            scanCollector.reset();
          }
        }
        resumedCheckpointFormat = { jobId: parsed.jobId, schemaVersion: parsed.schemaVersion };
        scanRecoveryObserver.step(recovery, 'accepted');
        return { ...saved, parsed };
      },
      prepare: (snapshot, signal) =>
        prepareScanCheckpointCapture(checkpointCaptureInput(snapshot), signal),
      prepareMutation: async (
        snapshot,
        signal,
        expectedCheckpointRevision,
        publicationLimit = 64,
        publicationKeys,
      ) => {
        const trace = publicationKeys?.length
          ? scanPublicationObserver.begin({
              selected: publicationKeys.length,
              chunks: Math.ceil(publicationKeys.length / 64),
              checkpointRevision: expectedCheckpointRevision,
              total: snapshot.review.candidates.length,
              checked: snapshot.observations.length,
              published: sourceScan.snapshot().published,
            })
          : undefined;
        try {
          const owner = await progressCaptureOwner(snapshot.jobId);
          const input = checkpointCaptureInput(snapshot);
          const prepare = async () => {
            const mutation =
              publicationLimit === 256
                ? await owner.prepareWindowMutation(input, publicationKeys ?? [], signal)
                : await owner.prepareMutation(input, signal);
            if (
              mutation?.kind === 'save' &&
              checkpointCaptureMode === 'version3' &&
              resumedCheckpointFormat?.jobId !== snapshot.jobId &&
              manifestBackedJobId !== snapshot.jobId
            ) {
              const client = await candidateManifestClient(signal);
              if (client)
                pendingManifestSeed = {
                  checkpoint: mutation.checkpoint,
                  jobId: snapshot.jobId,
                  review: snapshot.review,
                };
            }
            if (trace && mutation) publicationTraceByMutation.set(mutation, trace);
            return mutation;
          };
          try {
            return await prepare();
          } catch (failure) {
            if (!isTauri() || !owner.hasPendingPreparation) throw failure;
            if (trace) scanPublicationObserver.step(trace, 'checkpoint-reconcile');
            // A canceled publication may have prepared future keys without writing
            // them. Release that preparation only after an authoritative unchanged
            // storage revision; an uncertain/advanced commit requires reopening.
            await env.catalogWrites;
            signal.throwIfAborted();
            const saved = await readScanCheckpoint();
            signal.throwIfAborted();
            if (
              saved.catalogRevision !== env.persistedCatalogRevision ||
              saved.checkpointRevision !== expectedCheckpointRevision ||
              saved.checkpointStatus === 'invalid' ||
              (saved.checkpointStatus === 'valid' && saved.jobId !== snapshot.jobId)
            )
              throw new Error('Scan progress changed. Reopen the app before continuing.', {
                cause: failure,
              });
            owner.releaseUncommittedPreparation(
              expectedCheckpointRevision,
              saved.checkpointRevision,
            );
            return prepare();
          }
        } catch (failure) {
          if (trace)
            scanPublicationObserver.fail(trace, signal.aborted ? 'canceled' : 'checkpoint-failed');
          throw failure;
        }
      },
      acknowledgeMutation: (mutation, revision) => {
        const trace = publicationTraceByMutation.get(mutation);
        if (trace)
          scanPublicationObserver.step(trace, 'checkpoint-ack', { checkpointRevision: revision });
        try {
          if (!checkpointProgressCapture)
            throw new Error('Checkpoint capture owner is unavailable.');
          checkpointProgressCapture.acknowledgeMutation(mutation, revision);
          if (trace) scanPublicationObserver.complete(trace);
        } catch (failure) {
          if (trace) scanPublicationObserver.fail(trace, 'ack-failed');
          throw failure;
        }
      },
      saveMutation: async (mutation, revision, checkpointRevision, signal) => {
        const work = env.catalogWrites.then(async () => {
          signal.throwIfAborted();
          if (revision !== String(env.catalogRevision))
            throw new Error('Saved channels changed. Rescan before continuing.');
          await env.preferences.settledSnapshot();
          signal.throwIfAborted();
          let receipt: CommitReceipt;
          if (
            mutation.kind === 'save' &&
            checkpointCaptureMode === 'version3' &&
            pendingManifestSeed
          ) {
            const seed = pendingManifestSeed;
            if (seed.checkpoint !== mutation.checkpoint)
              throw new Error('Saved scan candidates changed before storage.');
            const client = await candidateManifestClient(signal);
            if (!client) throw new Error('Scan candidate storage is unavailable.');
            receipt = await client.stageAndSeal(
              {
                checkpoint: seed.checkpoint,
                review: seed.review,
                expectedCatalogRevision: env.persistedCatalogRevision,
                expectedCheckpointRevision: checkpointRevision,
              },
              signal,
            );
            // This is the actual durable seal ACK; a subsequent abort cannot revoke it.
            manifestBackedJobId = seed.jobId;
            pendingManifestSeed = undefined;
          } else {
            receipt = await writeScanCheckpointMutation(
              mutation,
              env.persistedCatalogRevision,
              checkpointRevision,
              signal,
            );
          }
          if (receipt.checkpointRevision === undefined)
            throw new Error('Scan progress save was not confirmed.');
          return { committed: true as const, checkpointRevision: receipt.checkpointRevision };
        });
        env.catalogWrites = work.catch(() => undefined);
        return work;
      },
      save: async (text, revision, checkpointRevision, signal) => {
        await env.catalogWrites;
        if (revision !== String(env.catalogRevision))
          throw new Error('Saved channels changed. Rescan before continuing.');
        const receipt = await writeScanCheckpoint(
          text,
          scanStorageRevision,
          checkpointRevision,
          signal,
        );
        if (receipt.checkpointRevision === undefined)
          throw new Error('Scan progress save was not confirmed.');
        return { committed: true as const, checkpointRevision: receipt.checkpointRevision };
      },
      discard: async (jobId, revision, checkpointRevision, signal) => {
        await env.catalogWrites;
        if (revision !== String(env.catalogRevision))
          throw new Error('Saved channels changed. Rescan before continuing.');
        const receipt = await discardScanCheckpoint(
          jobId,
          env.persistedCatalogRevision,
          checkpointRevision,
          signal,
        );
        if (receipt.checkpointRevision === undefined)
          throw new Error('Scan progress reset was not confirmed.');
        checkpointProgressCapture?.reset();
        if (manifestBackedJobId === jobId) manifestBackedJobId = null;
        pendingManifestSeed = undefined;
        return { committed: true as const, checkpointRevision: receipt.checkpointRevision };
      },
    },
    ...createScanGuideHost(),
    prioritize: scanCollector.prioritize,
    aliases: scanCollector.aliases,
    beginSelectionEpisode: async (context, signal) => {
      const work = env.catalogWrites.then(async () => {
        signal.throwIfAborted();
        const definitionsMatch = await Promise.all(
          context.capturedSources.map(async (captured, index) => {
            const observed = scanScope[index];
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
          context.capturedSources.length !== scanScope.length ||
          // Collection adds observed format; canonical field order is not source authority.
          definitionsMatch.some((matches) => !matches)
        )
          throw new Error('Saved channels changed. Continue the scan again.');
        if (!(await supportsNativeScanBatch(signal))) return null;
        signal.throwIfAborted();
        const supportsWindow = (await nativeScanWindowCommit.capabilities(signal)) !== null;
        signal.throwIfAborted();
        const actor = createSelectionSession({
          catalog: env.catalog,
          catalogRevision: env.persistedCatalogRevision,
          scope: structuredClone(scanScope),
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
    platform: () => healthPlatform ?? 'native-unavailable',
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
          platform: healthPlatform ?? 'native-unavailable',
          observerProfile: reachabilityHealthProfile(isTauri(), query.budgetMs),
          decoderObserverProfile: DECODER_HEALTH_PROFILE,
        },
        query.signal,
      );
    },
    revision: () => String(env.catalogRevision),
    onCollectionSettled: () => {
      // Collection has joined; probes use enriched channels, not the raw registry documents.
      scanCollector.release();
    },
    capture: (drafts) => {
      if (env.importRunning || env.transferBusy)
        throw new Error('Wait for the current import to finish.');
      scanStorageRevision = env.persistedCatalogRevision;
      scanCollector.reset();
      scanRegion = env.settings.preferredRegion
        ? structuredClone(env.settings.preferredRegion)
        : undefined;
      scanScope = drafts
        ? structuredClone([...drafts])
        : scanProviderSources().map((source) => ({
            source: { ...source },
            fingerprint: crypto.randomUUID(),
          }));
      return { revision: String(env.catalogRevision), sources: structuredClone(scanScope) };
    },
    collect: collectScanSource,
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
      const scope = scanScope;
      const work = (async () => {
        signal.throwIfAborted();
        if (healthPlatform === null)
          throw new Error(
            'Device information is unavailable. Reopen the app before checking streams.',
          );
        const definition = scope.find((entry) => entry.source.id === candidate.sourceId);
        if (scope !== scanScope || definition?.fingerprint !== candidate.sourceFingerprint)
          throw new Error('The reviewed source changed. Scan again.');
        const evidence = await inspectStreamEvidence(
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
          { platform: healthPlatform, observedAt: Date.now() },
          evidence,
        );
      })();
      return work;
    },
    commit: commitScanPublication,
    commitWindow: (chunks, revision, signal, checkpoint, episodeId) =>
      commitScanPublication(
        chunks[0].staged,
        revision,
        signal,
        chunks[0].health,
        checkpoint,
        episodeId,
        chunks,
      ),
  });
  // Read-only bounded native check receipts; no channel/source addresses or mutable registry.
  Object.defineProperty(window, '__GENX_MEDIA_PREFLIGHT_DIAGNOSTICS__', {
    get: () => mediaPreflightDiagnosticsSnapshot(),
    enumerable: false,
    configurable: false,
  });
  Object.defineProperty(window, '__GENX_SCAN__', {
    get: () => sourceScan.snapshot(),
    enumerable: false,
    configurable: false,
  });
  return {
    sourceScan,
    get automaticScanActive() {
      return automaticScanActive;
    },
    get healthPlatform() {
      return healthPlatform;
    },
    set healthPlatform(value: typeof healthPlatform) {
      healthPlatform = value;
    },
    get indexedFreshAvailable() {
      return indexedFreshAvailable;
    },
    scanProviderSources,
    supportsBoundedResume,
    prepareInlineScanEntry,
    inlineScanPanel,
    get pausedScanResumable() {
      return pausedScanResumable;
    },
    inspectStreamEvidence,
    probeScheduler,
    sourceActivation,
    get checkpointProgressCapture() {
      return checkpointProgressCapture;
    },
    get pendingManifestSeed() {
      return pendingManifestSeed;
    },
    set pendingManifestSeed(value: typeof pendingManifestSeed) {
      pendingManifestSeed = value;
    },
    adoptIncludedHttp,
  };
}
