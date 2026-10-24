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
import { type ScanReview, type ScanSource } from '../../discovery/scan';
import { nativeScanBatchCommit } from '../../platform/scan-batch-commit';
import {
  createScanCheckpointProgressCapture,
  parseScanCheckpointCapabilities,
} from './scan-checkpoint-capture-service';
import { createScanRecoveryObserver } from './scan-recovery-observer';
import {
  createScanPublicationObserver,
  type ScanPublicationHandle,
} from './scan-publication-observer';
import { type ScanWindowFailureCode } from '../../platform/scan-window-commit';
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
  type AutomaticScanCheckpointSnapshot,
  type AutomaticScanProgress,
  type SourceScanSnapshot,
} from '../../ui/scan/source-scan-model';
import { type PreferredRegion } from '../../location/region';
import { allowIncludedHttp, providerScanSources } from './included-sources';
import { inspectSource, writeRecordPair } from '../../platform/records';
import { serializeCatalog } from '../../catalog';
import { exportPreferences } from '../../preferences';
import { createProbeScheduler } from '../../discovery/probe-scheduler';
import { createPlaybackProbeGate } from '../health/playback-probe-gate';
import { createSlowPassGate } from './slow-pass-gate';
import { type HealthEvidence } from '../../discovery/health';
import {
  inspectCheckedMediaSource,
  mediaPreflightDiagnosticsSnapshot,
} from '../../sources/media-preflight';
import { type EventCode } from '../../diagnostics/events';
import { mountInlineScanPanel } from '../../ui/scan/inline-scan-panel';
import { mountScanScreensaver } from '../../ui/scan/scan-screensaver';
import { mountFirstScanHint } from '../../ui/scan/first-scan-hint';
import { createIndexFreshness } from '../../discovery/index-freshness';
import { createScanSourceCollector } from './scan-source-collection';
import { parseInWorker } from '../../catalog/service';
import { createSelectionSession } from '../../discovery/selection-session';

import { createSourceSnapshotActivationTransport } from '../../platform/source-snapshot-activation';

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

import type { CatalogRecord } from '../../catalog';
import type { Preferences, SerializedPreferencesStore } from '../../preferences';
import type { createAutomaticGuideBuilder } from '../../guide/automatic-build';
import type { createDiagnostics } from '../../diagnostics/native';
import type { ChannelBrowser } from '../../ui/channels/channel-browser';
import type { mountGuide } from '../../ui/guide/guide';
import type { mountGeographyControls } from '../../ui/channels/geography-controls';
import type { createChannelCheckStore } from '../../platform/channel-checks';
import type { createSavedChannelCheck } from '../health/saved-channel-check';
import type { PlaybackController } from '../../playback/controller';
import type { createSharingHost } from '../sharing/sharing-host';
import type { createActivityWakePolicy } from '../playback/activity-wake';
import type { ContentLibrary } from '../genxtra/content-library';
import { mountApplicationScanScreen } from './scan-screen';
import { createSharedContext } from '../shell/shared-context';
import { createScanResumeWiring } from './scan-resume-wiring';
import { createScanPublicationCommit } from './scan-publication-commit';

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
  // What the parts of createScanController in other modules share with it: each value
  // is read when a part uses it; the second list holds the ones parts assign.
  const shared = createSharedContext(
    {
      automaticScanActive: () => automaticScanActive,
      candidateManifestClient: () => candidateManifestClient,
      checkpointCaptureInput: () => checkpointCaptureInput,
      checkpointCaptureMode: () => checkpointCaptureMode,
      checkpointProgressCapability: () => checkpointProgressCapability,
      checkpointProgressCapture: () => checkpointProgressCapture,
      collectScanSource: () => collectScanSource,
      commitScanPublication: () => commitScanPublication,
      createApplicationBoundedResume: () => createApplicationBoundedResume,
      flushScanBatchWork: () => flushScanBatchWork,
      healthPlatform: () => healthPlatform,
      indexedFreshAvailable: () => scanResumeWiring.indexedFreshAvailable,
      inlineScanSlowPass: () => inlineScanSlowPass,
      inspectStreamEvidence: () => inspectStreamEvidence,
      logScanFailure: () => logScanFailure,
      manifestBackedJobId: () => manifestBackedJobId,
      pendingManifestSeed: () => pendingManifestSeed,
      progressCaptureOwner: () => progressCaptureOwner,
      publicationTraceByMutation: () => publicationTraceByMutation,
      resumedCheckpointFormat: () => resumedCheckpointFormat,
      SCAN_LIST_BATCH: () => SCAN_LIST_BATCH,
      scanBatchSettled: () => scanBatchSettled,
      scanBatchThrottle: () => scanBatchThrottle,
      scanCollector: () => scanCollector,
      scanNativeFailures: () => scanNativeFailures,
      scanProbeGate: () => scanProbeGate,
      scanProviderSources: () => scanProviderSources,
      scanPublicationObserver: () => scanPublicationObserver,
      scanRecoveryObserver: () => scanRecoveryObserver,
      scanRegion: () => scanRegion,
      scanScope: () => scanScope,
      scanStorageRevision: () => scanStorageRevision,
      scheduleSlowPass: () => scheduleSlowPass,
      searchIndexFreshness: () => searchIndexFreshness,
      showInlineScanProgress: () => showInlineScanProgress,
      slowPassGate: () => slowPassGate,
      slowPassRetries: () => slowPassRetries,
      slowPassTimer: () => slowPassTimer,
      sourceActivation: () => sourceActivation,
      sourceScan: () => sourceScan,
      supportsBoundedResume: () => supportsBoundedResume,
      supportsNativeScanBatch: () => supportsNativeScanBatch,
    },
    {
      automaticScanActive: (value: typeof automaticScanActive) => (automaticScanActive = value),
      manifestBackedJobId: (value: typeof manifestBackedJobId) => (manifestBackedJobId = value),
      pendingManifestSeed: (value: typeof pendingManifestSeed) => (pendingManifestSeed = value),
      resumedCheckpointFormat: (value: typeof resumedCheckpointFormat) =>
        (resumedCheckpointFormat = value),
      scanNativeFailures: (value: typeof scanNativeFailures) => (scanNativeFailures = value),
      scanRegion: (value: typeof scanRegion) => (scanRegion = value),
      scanScope: (value: typeof scanScope) => (scanScope = value),
      scanStorageRevision: (value: typeof scanStorageRevision) => (scanStorageRevision = value),
      slowPassRetries: (value: typeof slowPassRetries) => (slowPassRetries = value),
    },
  );
  const scanPublicationCommit = createScanPublicationCommit(env, shared);
  const { commitScanPublication } = scanPublicationCommit;

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
      if (env.applicationClosing || automaticScanActive || !scanResumeWiring.indexedFreshAvailable)
        return;
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
    () => scanResumeWiring.indexedFreshAvailable,
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
  const scanResumeWiring = createScanResumeWiring(env, shared);
  const { createApplicationBoundedResume, supportsBoundedResume, prepareInlineScanEntry } =
    scanResumeWiring;
  const sourceActivation = createSourceSnapshotActivationTransport();
  const scanScreen = mountApplicationScanScreen(env, shared);
  const { sourceScan } = scanScreen;
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
      return scanResumeWiring.indexedFreshAvailable;
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
