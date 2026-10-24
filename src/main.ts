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

import './ui/style.css';
import './ui/management.css';
import './ui/channel-logos.css';
import { createChannelLogos } from './application/channel-logos';
import { installAudioDiagnostics } from './application/audio-diagnostics';
import { createBootstrapBoundary } from './application/bootstrap-boundary';
import { createRendererRecoveryPolicy } from './application/renderer-recovery-policy';
import { createFileImportSource } from './application/file-import-identity';
import { createSharingHost } from './application/sharing-host';
import { createAccountPlayer } from './application/account-player';
import { createArchivePlayer, ArchiveFileRemovedError } from './application/archive-player';
import { createArchiveBookmarks } from './platform/archive-bookmarks';
import { createArchiveDownloads } from './application/archive-downloads';
import { chooseArchiveResume } from './ui/archive-resume';
import {
  createArchiveDiscovery,
  type ArchiveDiscoverySnapshot,
} from './application/archive-discovery';
import {
  createArchiveCatalog,
  type ArchiveSelection,
  type ArchiveDecade,
  type ArchiveContentType,
} from './platform/archive-catalog';
import { mountArchiveSearch } from './ui/archive-search';
import { archiveDiscoveryStatus } from './ui/archive-discovery-status';
import { createOwnedAbortSignals } from './platform/abort';
import { createAccountBrowser } from './application/account-browser';
import { createPaidNowPlaying } from './application/paid-now-playing';
import { createVpnStatus } from './platform/vpn-status';
import { mountVpnIndicator } from './ui/vpn-indicator';
import { mountScanOverlay } from './ui/scan-overlay';
import { createAccountVault, type AccountMetadata } from './platform/account-vault';
import { createAccountCatalog } from './platform/account-catalog';
import {
  createAccountPreferences,
  type AccountPreferencesMutation,
  type AccountPreferencesReceipt,
} from './platform/account-preferences';
import { mountAccountManagement } from './ui/accounts';
import { createCloseOwner, type CleanupToken } from './application/close-owner';
import { createCloseFinalizationObserver } from './application/close-finalization';
import { nativeScanCheckpointSummary } from './platform/scan-checkpoint-summary';
import {
  createBoundedNativeScanResumeTransport,
  type BoundedScanTransportDiagnostic,
} from './platform/bounded-scan-resume';
import {
  createBoundedScanResumeService,
  type BoundedScanServiceDiagnostic,
} from './application/bounded-scan-resume-service';
import { createIncrementalRefreshCoordinator } from './discovery/incremental-refresh';
import { createPagedSourceCollection } from './discovery/paged-source-collection';
import { createSourceSnapshotTransport } from './platform/source-snapshot';
import {
  createSourceSnapshotActivationTransport,
  type SourceSnapshotActivationReply,
} from './platform/source-snapshot-activation';
import { sourcePreparationStatus } from './ui/source-preparation-status';
import { createScanPublicationProjectionReader } from './platform/scan-resume-publication-projection';
import type { BoundedScanAck, BoundedScanRevisions } from './application/bounded-scan-resume';
import { createCloseProgressObserver } from './application/close-progress';
import { createScanRecoveryObserver } from './application/scan-recovery-observer';
import {
  createScanPublicationObserver,
  type ScanPublicationHandle,
} from './application/scan-publication-observer';
import { createScanCandidateManifestClient } from './application/scan-candidate-manifest-service';
import { createScanCandidateManifestTransport } from './application/scan-candidate-manifest';
import { createActivityWakePolicy } from './application/activity-wake';
import {
  prepareStoredCapture as prepareScanCheckpointCapture,
  parseStoredCaptureWithPacked as parseScanCheckpointCapture,
  restoreReferencedCapture,
  restorePackedCapture,
  parseScanCheckpointCapabilities,
  createScanCheckpointProgressCapture,
} from './application/scan-checkpoint-capture-service';
import {
  selectScanCheckpointMode,
  scanCheckpointModeOptions,
  type ScanCheckpointCaptureMode,
  type ResumedCheckpointFormat,
} from './application/scan-checkpoint-mode';
import {
  canResumeScanCheckpoint,
  scanReconstructionFailureCode,
  fingerprintScanPolicy,
  fingerprintScanSource,
  validateCheckpointSourceAdmission,
} from './discovery/scan-checkpoint';
import { createStartupObserver, type StartupAttempt } from './application/startup-view';
import { mountSharingSettings } from './sharing/settings';
import {
  createRemoteEditMode,
  installRemoteNavigation,
  restoreRemoteFocus,
} from './ui/remote-navigation';
import { installCasting } from './ui/casting';
import { installViewport } from './ui/viewport';
import { mountRegionPreference } from './ui/region-preference';
import type { PreferredRegion } from './location/region';
import { fetchAuxiliaryText } from './location/fetch';
import { createScanSourceCollector } from './application/scan-source-collection';
import { createIndexFreshness } from './discovery/index-freshness';
import { createPlaybackProbeGate } from './application/playback-probe-gate';
import { createSlowPassGate } from './application/slow-pass-gate';
import { mountLibrarySwitcher } from './ui/library-switcher';
import { readUnavailableSources, recordUnavailableSources } from './discovery/unavailable-sources';
import { emptyOnlineDiscoveryText } from './ui/online-discovery-text';
import { readPackSuggestions } from './guide/pack-suggestions';
import { lookupSeriesIdentity } from './platform/series-identity';
import { installGuideGrabberExport } from './ui/guide-grabber-settings';
import {
  defaultProviderRegistry,
  parseProviderRegistry,
  serializeProviderRegistry,
} from './discovery/provider-registry';
import { automaticGuidePreferenceKey } from './application/automatic-guide-capture';
import { captureAutomaticGuideInWorker } from './application/automatic-guide-capture-service';
import { createAutomaticGuideBuilder } from './guide/automatic-build';
import { prioritizeGuideProviders } from './guide/provider-order';
import { installInAppSelects } from './ui/in-app-select';
import { installMediaKeys } from './ui/media-keys';
import { installDataTransfer } from './ui/data-transfer';
import {
  mountSourceScan,
  SourceScanWindowSizeError,
  type SourceScanHost,
  type SourceScanPublicationChunk,
  type SourceScanSnapshot,
  type AutomaticScanProgress,
  type AutomaticScanCheckpointSnapshot,
  ScanSourcesChanged,
  sourcesChangedRefusal,
} from './ui/source-scan';
import { createDiagnostics } from './diagnostics/native';
import type { EventCode } from './diagnostics/events';
import { mountEventHistory } from './ui/event-history';
import './ui/event-history.css';
import { mountGuide } from './ui/guide';
import { mountExit } from './ui/exit';
import { mountAutomaticGuideUpdates } from './ui/automatic-guide-updates';
import { joinGuideWork } from './application/join-guide-work';
import { installFullscreenPresentation } from './ui/fullscreen-presentation';
import { installDoubleTapFullscreen } from './ui/double-tap-fullscreen';
import { installCategoryMenu } from './ui/category-menu';
import { installCaptions } from './ui/captions';
import { createFullscreenOwner } from './ui/fullscreen-owner';
import { mountGeographyControls } from './ui/geography-controls';
import { mountViewingChoices } from './ui/viewing-choices';
import { mountSettingsNavigation, mountLocationDialog } from './ui/settings-navigation';
import { createGuideHost } from './application/guide-host';
import { discoverPlaylistGuides } from './guide/discovery';
import { nativeGuide, readDailyGuidePlan, refreshDailyGuide } from './guide/native';
import { createGuideMaintenance } from './application/guide-maintenance';
import { mountVODStop } from './ui/vod-stop';
import { createDailyGuideRefresh } from './guide/daily-refresh';
import {
  createAutomaticGuidePermissions,
  previewPermittedAutomaticGuide,
  type AutomaticGuidePermission,
} from './guide/automatic-permissions';
import { readVisibleGuide, type VisibleGuideChannel } from './guide/visible-native';
import { createVisibleGuideOwner, type VisibleGuideScope } from './application/visible-guide';
import { createScanGuideHost } from './application/scan-guide-host';
import { createPageInput } from './discovery/page-input';
import { createSourceIndexService } from './discovery/source-index-service';
import { createOnlineSourceScan } from './discovery/online-source-scan';
import knownSourceDirectories from './discovery/known-directory-ids.json';
import { prepareDiscoveredSources } from './application/discovered-source-configuration';
import { readDirectoryJson } from './platform/source-directory';
import { createProbeScheduler } from './discovery/probe-scheduler';
import { reorderScanCandidates } from './discovery/scan-priority';
import { createPlaybackHealthCapture } from './application/playback-health';
import { DECODER_HEALTH_PROFILE, reachabilityHealthProfile } from './application/health-profile';
import { mountWebsiteDiscovery } from './ui/website-discovery';
import { NativeSpeech } from './search/native-speech';
import { mountSpeechSearch } from './ui/speech-search';
import { mountStorageRecovery } from './ui/storage-recovery';
import './ui/guide.css';
import './ui/guide-timeline.css';
import './ui/responsive.css';
import { installConfiguredImportEntry } from './ui/import-entry';
import './ui/in-app-select.css';
import './ui/scan-screensaver.css';
import { mountScanScreensaver } from './ui/scan-screensaver';
import './ui/modal-viewport.css';
import './ui/genxtra.css';
import './ui/media-results.css';
import './ui/tv-density.css';
import './ui/live-replay.css';
import './ui/guide-panel.css';
import './ui/premium-buttons.css';
import './ui/category-menu.css';
import './ui/saved-channel-check.css';
import './ui/picture-states.css';
import './ui/header-art.css';
import { createAccountGuide } from './platform/account-guide';
import { mountPaidGuide } from './ui/paid-guide';
import { installVODDock } from './ui/vod-dock';
import { installLiveReplay, type LiveReplayControls } from './ui/live-replay';
import { parseInWorker } from './catalog/service';
import { exportPlaylistInWorker } from './catalog/playlist-export-service';
import { savePlaylistExport } from './platform/playlist-file';
import {
  prepareCompactScanInWorker,
  prepareScanInWorker,
  prepareNativeScanBatchInWorker,
} from './discovery/selection';
import { applyCatalogPatch } from './discovery/catalog-patch';
import { createSelectionSession, type SelectionSessionAck } from './discovery/selection-session';
import { nativeScanBatchCommit } from './platform/scan-batch-commit';
import {
  nativeScanWindowCommit,
  validateScanWindow,
  type ScanWindowFailureCode,
} from './platform/scan-window-commit';
import { boundedUtf8Text } from './platform/bounded-text';
import { isSelectionWindowSizeError } from './discovery/selection-window';
import { scanConfiguredSources, type ScanSource, type ScanReview } from './discovery/scan';
import { createHealthObservation, healthVerdict, type HealthEvidence } from './discovery/health';
import { createChannelCheckStore, type ChannelCheck } from './platform/channel-checks';
import { createSavedChannelCheck } from './application/saved-channel-check';
import {
  inspectCheckedMediaSource,
  mediaPreflightDiagnosticsSnapshot,
} from './sources/media-preflight';
import {
  decodeSavedHealthInWorker,
  decodeSavedHealthOnlyInWorker,
  healthHistoryInWorker,
} from './application/health-history-read';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createShell, PICTURE_ART } from './ui/shell';
import { mountAbout } from './ui/about';
import { ChannelBrowser, type ChannelFilter } from './ui/channel-browser';
import { queryCatalogPage } from './platform/catalog-query';
import {
  CATALOG_GROUP_BATCH_LIMIT,
  mutateCatalogGroup,
  type CatalogGroupAction,
} from './platform/catalog-group';
import { PlaybackController, type PlaybackSnapshot } from './playback/controller';
import { startTiming } from './playback/start-timing';
import { playbackFailureGuidance } from './playback/failure-guidance';
import { mountChannelActions } from './ui/channel-actions';
import { mountProviderManagement } from './ui/provider-management';
import { createGuideCacheReady, createGuideAcquisitionAllowed } from './application/guide-cache';
import {
  createViewingWakeOwner,
  createViewingForegroundAdmission,
} from './playback/viewing-wake-owner';
import { createWakeTransportAdmission } from './playback/viewing-wake-startup';
import { createBrowserEngineFactory, readVideoQuality } from './platform/browser-engine';
import { createNativeVideoBridge, nativeVideoAvailable } from './platform/native-video';
import { createNativeVodEngine } from './playback/native-vod-engine';
import { createNativeLiveEngine, nativeLiveRelay } from './playback/native-live-engine';
import { accountOnDemand, createRoutingEngineFactory } from './playback/routing-engine';
import { createNativePictureHost } from './ui/native-picture';
import { installVideoQuality } from './ui/video-quality';
import { installAudioTracks } from './ui/audio-tracks';
import { playbackResourceOwners } from './playback/resource-owners';
import {
  readRecord,
  readRecordPair,
  readScanHealth,
  readGuideCaptureSnapshot,
  writeRecord,
  writeRecordPair,
  writeHealth,
  readScanCheckpoint,
  writeScanCheckpoint,
  writeScanCheckpointMutation,
  discardScanCheckpoint,
  isRecordRevisionConflict,
  inspectSource,
  type CommitReceipt,
} from './platform/records';
import {
  CatalogRefreshService,
  mergeInspectedSource,
  emptyCatalog,
  serializeCatalog,
  validateSource,
  type CatalogRecord,
  type Source,
} from './catalog';
import { collectSources } from './catalog/collector';
import { allowIncludedHttp, providerScanSources } from './application/included-sources';
import { mountInlineScanPanel } from './ui/inline-scan-panel';
import { mountLocalStreams } from './ui/local-streams';
import { mountFirstScanHint } from './ui/first-scan-hint';
import { createDailyRefresh, DailyRefreshAttemptNotStartedError } from './catalog/daily-refresh';
import { migrateRefreshCadence, validateRefreshCadence } from './catalog/refresh-cadence';
import {
  SerializedPreferencesStore,
  defaultPanelWidthForViewport,
  importPreferences,
  exportPreferences,
  createChannelCategoryResolver,
  type Preferences,
} from './preferences';
// Last stylesheet: the shared pop-up look sits over every component sheet.
import './ui/dialog-polish.css';

const bootstrapBoundary = createBootstrapBoundary();
const rendererRecoveryPolicy = createRendererRecoveryPolicy(() =>
  isTauri()
    ? invoke('renderer_recovery_bootstrap')
    : Promise.resolve({ schemaVersion: 1, recoveredRenderer: false }),
);
Object.defineProperty(window, '__GENX_BOOTSTRAP__', {
  get: () => bootstrapBoundary.snapshot(),
  enumerable: false,
  configurable: false,
});
const startupObserver = createStartupObserver();
Object.defineProperty(window, '__GENX_STARTUP__', {
  get: () => startupObserver.snapshot(),
  enumerable: false,
  configurable: false,
});
const element = <T extends HTMLElement = HTMLElement>(id: string): T =>
  document.getElementById(id) as T;
bootstrapBoundary.run('shell', () => createShell(element('app')));
// The device kind this device reported last time, so the first paint already
// has its layout: on the Sansui TV the header was drawn for a phone/desktop and
// jumped to the TV layout ~50 s later, when start-up asked (October 19, 2026).
// device_capabilities still confirms or corrects it below.
const DEVICE_KIND_KEY = 'genx.deviceKind';
if (isTauri())
  try {
    const remembered = localStorage.getItem(DEVICE_KIND_KEY);
    if (remembered === 'tv' || remembered === 'personal')
      element('app').dataset.deviceKind = remembered;
  } catch {
    // Storage unavailable: the layout waits for device_capabilities, as before.
  }
// Upright phones: the scan's progress floats over the idle picture panel.
bootstrapBoundary.run('shell', () => mountScanOverlay(element('app')));
// The header's VPN shield: only the installed app can ask the system.
if (isTauri())
  bootstrapBoundary.run('shell', () =>
    mountVpnIndicator(document.querySelector<HTMLElement>('.topbar')!, createVpnStatus()),
  );
const diagnostics = bootstrapBoundary.run('shell', () => createDiagnostics());
const audioDiagnostics = bootstrapBoundary.run('shell', () =>
  installAudioDiagnostics(element<HTMLVideoElement>('video'), { emit: diagnostics.emit }),
);
const eventHistory = bootstrapBoundary.run('shell', () =>
  mountEventHistory(element('app'), {
    read: diagnostics.read,
    clear: diagnostics.clear,
    formatTime: (timestampMs) => new Date(timestampMs).toLocaleString(),
  }),
);
bootstrapBoundary.run('shell', () =>
  element('event-history-button').addEventListener('click', () => eventHistory.open()),
);
const fullscreenPresentation = bootstrapBoundary.run('viewing-controls', () =>
  installFullscreenPresentation(element('app')),
);
const removeCaptions = bootstrapBoundary.run('viewing-controls', () =>
  installCaptions(
    element<HTMLVideoElement>('video'),
    element<HTMLButtonElement>('captions-button'),
  ),
);
const removeVideoQuality = bootstrapBoundary.run('viewing-controls', () =>
  installVideoQuality(element<HTMLVideoElement>('video'), element('video-quality')),
);
const removeAudioTracks = bootstrapBoundary.run('viewing-controls', () =>
  installAudioTracks(element<HTMLVideoElement>('video'), element('audio-tracks')),
);
const vodDock = bootstrapBoundary.run('viewing-controls', () =>
  installVODDock(
    element('app'),
    () => !applicationClosing && nativeViewingForeground && !backgroundSuspension,
  ),
);

element('app').dataset.compactView = 'watch';
element('compact-view').addEventListener('change', () => {
  element('app').dataset.compactView = element<HTMLSelectElement>('compact-view').value;
  updateVisibleGuide();
});
const removeSettingsNavigation = bootstrapBoundary.run('settings', () =>
  mountSettingsNavigation(element<HTMLDialogElement>('settings-dialog')),
);
const removeLocationDialog = bootstrapBoundary.run('region', () =>
  mountLocationDialog(element('geography-controls')),
);
const removeAbout = bootstrapBoundary.run('settings', () =>
  mountAbout(element('app'), element<HTMLButtonElement>('about-button')),
);
element('app').inert = true;
// TV and Windows: All | Movies | News | Sports fold into one button in the channel row.
const categoryMenu = bootstrapBoundary.run('viewport', () => installCategoryMenu(element('app')));
let storageRecovery: ReturnType<typeof mountStorageRecovery> | undefined;
const removeViewport = bootstrapBoundary.run('viewport', () => installViewport(element('app')));
const remoteEditMode = bootstrapBoundary.run('viewport', () => createRemoteEditMode());
const removeRemoteNavigation = bootstrapBoundary.run('viewport', () =>
  installRemoteNavigation({ editMode: remoteEditMode }),
);
const sourceAllowsHttp = (url: string): boolean =>
  catalog.sources.find((source) =>
    catalog.channels.some(
      (channel) => channel.sourceId === source.id && channel.urls.includes(url),
    ),
  )?.allowHttp ?? false;
// Bootstrap failure callbacks can run before these owners are constructed.
// Keep an initialized optional binding rather than a later const's temporal dead zone.
// eslint-disable-next-line prefer-const
let accountPlayer: ReturnType<typeof createAccountPlayer> | undefined;
// eslint-disable-next-line prefer-const
let archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
// eslint-disable-next-line prefer-const
let localStreams: ReturnType<typeof mountLocalStreams> | undefined;
// eslint-disable-next-line prefer-const
let vodStopControl: ReturnType<typeof mountVODStop> | undefined;
// eslint-disable-next-line prefer-const
let archiveSearch: ReturnType<typeof mountArchiveSearch> | undefined;
let archiveDownloads: ReturnType<typeof createArchiveDownloads> | undefined;
let channelLogos: ReturnType<typeof createChannelLogos> | undefined;
type ContentLibrary = 'live' | 'genxtra';
let contentLibrary: ContentLibrary = 'live';
const libraryQueries: Record<ContentLibrary, string> = { live: '', genxtra: '' };
let libraryIntent = 0;
let archiveDecade: ArchiveDecade | null = null;
let archiveContentType: ArchiveContentType | 'all' = 'all';
let archiveFavoritesOnly = false;
let archiveFilterGeneration = 0;
let liveLibraryScroll = 0;
let archiveStorageEpoch = 0;
let archiveIndexRevision: string | null = null;
let archiveResumeChoice: ArchiveSelection | null = null;
let archiveBackgroundPaused = false;
const archiveCatalog = createArchiveCatalog();
// Bootstrap failure callbacks need the initialized optional binding above.
// eslint-disable-next-line prefer-const
archiveDownloads = createArchiveDownloads({
  readyScope: archiveRuntimeScope,
  beforeRemove: async (downloadRef) => {
    if (archivePlayer?.selection?.downloadRef === downloadRef) await archivePlayer.stop();
    if (archiveResumeChoice?.downloadRef === downloadRef) clearArchiveResume();
  },
});
const liveBrowseJobs = new Map<AbortController, Promise<unknown>>();
let liveBrowseSuspended = false;
function archiveRuntimeScope(): string | null {
  if (!isTauri() || element('app').dataset.ready !== 'true') return null;
  return applicationClosing ? null : `archive-storage-${archiveStorageEpoch}`;
}
function archiveActiveScope(): string | null {
  const scope = archiveRuntimeScope();
  return scope &&
    contentLibrary === 'genxtra' &&
    primaryPage === 'watch' &&
    !document.hidden &&
    nativeViewingForeground &&
    !backgroundSuspension
    ? `${scope}:genxtra:${foregroundGeneration}:${archiveFilterGeneration}`
    : null;
}
function privatePlayback(selection: PlaybackSnapshot['selection']): boolean {
  return (
    !!selection &&
    (selection.playMode === 'on-demand' ||
      /^archive-[a-f0-9]{64}$/u.test(selection.id) ||
      /^account-[a-f0-9]{32}-[a-f0-9]{64}$/u.test(selection.id))
  );
}
function clearArchiveResume(): void {
  archiveResumeChoice = null;
  archiveBackgroundPaused = false;
}
const playbackAllowsHttp = (url: string) =>
  archivePlayer?.allowsHttp(url) === true ||
  localStreams?.allowsHttp(url) === true ||
  accountPlayer?.allowsHttp(url) === true ||
  sourceAllowsHttp(url);
// Android: Paid TV movies and episodes play natively so their embedded audio
// languages and subtitles can be chosen, and so do live channels whose MPEG-2
// picture the WebView cannot show (docs/native-vod-player.md).
const nativePicture = nativeVideoAvailable()
  ? createNativePictureHost(createNativeVideoBridge(), {
      app: element('app'),
      screen: element('screen'),
      video: element<HTMLVideoElement>('video'),
    })
  : null;
const player = bootstrapBoundary.run(
  'playback',
  () =>
    new PlaybackController(
      createRoutingEngineFactory(
        createBrowserEngineFactory(
          element<HTMLVideoElement>('video'),
          (url, signal) => inspectSource(url, playbackAllowsHttp(url), signal),
          {
            allowHttp: playbackAllowsHttp,
            preferNativeHls: false,
            requestAllowed: (url) =>
              archivePlayer?.selection
                ? archivePlayer.allowsRequest(url)
                : accountPlayer?.selection
                  ? accountPlayer.allowsRequest(url)
                  : true,
          },
        ),
        nativePicture ? (emit) => createNativeVodEngine(emit, nativePicture) : null,
        accountOnDemand,
        // Live channels whose MPEG-2 picture the WebView cannot show.
        nativePicture
          ? (emit) =>
              createNativeLiveEngine(
                emit,
                nativePicture,
                nativeLiveRelay,
                playbackAllowsHttp,
                () =>
                  notice(
                    'This channel is playing without sound: this device cannot decode its audio format.',
                  ),
                // Live channels reach this player for their MPEG-2 picture; a
                // phone without an MPEG-2 decoder (Galaxy S25) plays only the sound.
                () => {
                  notice(
                    'This channel’s picture is MPEG-2, which this device cannot show. Its sound plays; Android TVs show the picture.',
                  );
                  // Kept on the black picture while this channel plays.
                  const note = element('picture-note');
                  note.textContent = 'MPEG-2 picture · sound only on this device';
                  note.dataset.channel = player.snapshot.selection?.id ?? '';
                  note.hidden = false;
                },
              )
          : null,
      ),
    ),
);
accountPlayer = createAccountPlayer({ player });
// Read-only, redacted ownership evidence for deterministic packaged diagnostics.
// This exposes no channels, addresses, credentials, commands or mutable registry.
Object.defineProperty(window, '__GENX_PLAYBACK_OWNERS__', {
  get: () => playbackResourceOwners.snapshot(),
  enumerable: false,
  configurable: false,
});
Object.defineProperty(window, '__GENX_VIDEO_QUALITY__', {
  get: () => readVideoQuality(element<HTMLVideoElement>('video')),
  enumerable: false,
  configurable: false,
});
// Measurement only: when each stage of the latest channel starts happened.
// A Paid TV start also gets the local relay's times (provider and player bytes).
if (isTauri())
  startTiming.enrichAccountStarts((add) => {
    void invoke<{
      requestMs: number;
      playerRequestMs: number | null;
      preopened: boolean;
      freshRuns: number;
      upstreamHeadersMs: number | null;
      upstreamFirstByteMs: number | null;
      playerFirstByteMs: number | null;
      busyRetries: number;
      hops: Array<{
        dnsMs: number;
        connectMs: number | null;
        serverWaitMs: number;
        https: boolean;
        status: number;
      }>;
    } | null>('account_playback_start_timing')
      .then((relay) => {
        if (!relay) return;
        add.wallStage('relay-request', relay.requestMs);
        add.wallStage('player-request', relay.playerRequestMs);
        add.fact('preopened', relay.preopened);
        add.fact('fresh-runs', relay.freshRuns);
        add.wallStage('upstream-headers', relay.upstreamHeadersMs);
        add.wallStage('upstream-first-byte', relay.upstreamFirstByteMs);
        add.wallStage('player-first-byte', relay.playerFirstByteMs);
        add.fact('provider-busy-retries', relay.busyRetries);
        // The provider stage split: DNS, connect, redirects and server wait.
        const hops = relay.hops;
        add.fact('redirects', Math.max(0, hops.length - 1));
        const total = (pick: (hop: (typeof hops)[number]) => number | null) =>
          Math.round(hops.reduce((sum, hop) => sum + (pick(hop) ?? 0), 0));
        add.fact(
          'dns-ms',
          total((hop) => hop.dnsMs),
        );
        add.fact(
          'connect-ms',
          total((hop) => hop.connectMs),
        );
        add.fact(
          'server-wait-ms',
          total((hop) => hop.serverWaitMs),
        );
        hops.forEach((hop, index) => {
          const name = `hop${index + 1}`;
          add.fact(`${name}-dns-ms`, Math.round(hop.dnsMs));
          if (hop.connectMs !== null) add.fact(`${name}-connect-ms`, Math.round(hop.connectMs));
          add.fact(`${name}-wait-ms`, Math.round(hop.serverWaitMs));
          add.fact(`${name}-status`, hop.status);
          add.fact(`${name}-https`, hop.https);
        });
      })
      .catch(() => undefined);
  });
Object.defineProperty(window, '__GENX_START_TIMING__', {
  get: () => startTiming.snapshot(),
  enumerable: false,
  configurable: false,
});
// WebView can report zero before its first measured layout; this is a DOM
// initialization fallback, not validation or normalization of saved data.
function initialPanelWidth(): number {
  const width = window.innerWidth;
  return Number.isFinite(width) && width > 0 ? defaultPanelWidthForViewport(width) : 360;
}
const preferences = bootstrapBoundary.run(
  'preferences',
  () =>
    new SerializedPreferencesStore(
      {
        read: async () => {
          const text = await readRecord('preferences');
          return text === null ? null : JSON.parse(text);
        },
        write: async (value) => {
          await writeRecord('preferences', JSON.stringify(value));
        },
      },
      initialPanelWidth(),
    ),
);
let settings: Preferences = preferences.snapshot();
const regionPreference = bootstrapBoundary.run('region', () =>
  mountRegionPreference(element('region-settings'), {
    read: () => settings.preferredRegion,
    save: async (region, signal) => {
      signal.throwIfAborted();
      const saved = await saveSettings(
        (draft) => {
          draft.preferredRegion = region;
        },
        async () => !signal.aborted,
      );
      if (saved) catalogRevision++;
      return saved;
    },
    fetch: fetchAuxiliaryText,
  }),
);
element('save-provider-configuration').addEventListener('click', () => {
  void (async () => {
    try {
      const parsed = parseProviderRegistry(
        element<HTMLTextAreaElement>('provider-configuration').value,
      );
      // Owner decision, October 17, 2026: included channel sources always allow
      // plain HTTP (allowIncludedHttp grants it again at every start). Keep it on
      // here and say so, rather than save "off" and silently undo it later.
      const withdrawn = parsed.reviewedChannelProviders.some(
        (provider) => provider.allowHttp !== true,
      );
      const registry = {
        ...parsed,
        reviewedChannelProviders: parsed.reviewedChannelProviders.map((provider) => ({
          ...provider,
          allowHttp: true,
        })),
      };
      const saved = await saveSettings((draft) => {
        draft.reviewedChannelProviders = registry.reviewedChannelProviders;
        draft.reviewedGuideProviders = registry.reviewedGuideProviders;
      });
      if (!saved) return;
      catalogRevision++;
      if (withdrawn)
        element<HTMLTextAreaElement>('provider-configuration').value =
          serializeProviderRegistry(registry);
      element('provider-configuration-status').textContent = withdrawn
        ? 'Discovery providers saved. Included channel sources always allow plain HTTP, so that stays on. Your existing channels are preserved.'
        : 'Discovery providers saved. Your existing channels are preserved.';
    } catch {
      element('provider-configuration-status').textContent =
        'Check the provider configuration. No changes were saved.';
    }
  })();
});
element('restore-provider-configuration').addEventListener('click', () => {
  void (async () => {
    try {
      const registry = defaultProviderRegistry();
      const saved = await saveSettings((draft) => {
        draft.reviewedChannelProviders = registry.reviewedChannelProviders;
        draft.reviewedGuideProviders = registry.reviewedGuideProviders;
      });
      if (!saved) return;
      catalogRevision++;
      element<HTMLTextAreaElement>('provider-configuration').value =
        serializeProviderRegistry(registry);
      element('provider-configuration-status').textContent =
        'Suggested sources restored. Scan channels or find program guides when you are ready.';
    } catch {
      element('provider-configuration-status').textContent =
        'Suggested sources could not be saved.';
    }
  })();
});
let catalog: CatalogRecord = emptyCatalog();
// Newest saved-channel checks (Not responding marks); see presentNotResponding.
let channelCheckMarks: ReadonlyMap<string, ChannelCheck> = new Map();
let catalogRevision = 0;
let persistedCatalogRevision = '0';
let catalogBrowseViewRevision = 0;
// Channels carrying the Slow badge, as last read (see adoptSlowChannels).
let slowChannelIds: ReadonlySet<string> = new Set();
type AccountPlaybackChoice = NonNullable<ReturnType<typeof createAccountPlayer>['selection']>;
let pendingAccountPlayback: {
  choice: AccountPlaybackChoice;
  sharingGeneration: number;
} | null = null;
let pendingPublicPlayback: {
  selection: NonNullable<PlaybackSnapshot['selection']>;
  sharingGeneration: number;
} | null = null;
let backgroundLiveChoice:
  | { kind: 'public'; selection: NonNullable<PlaybackSnapshot['selection']> }
  | { kind: 'account'; choice: AccountPlaybackChoice }
  | null = null;
function foregroundPlaybackAllowed(): boolean {
  return (
    !applicationClosing && !document.hidden && nativeViewingForeground && !backgroundSuspension
  );
}
function admitForegroundPlayback(): void {
  if (!foregroundPlaybackAllowed())
    throw new DOMException('Playback is paused in the background.', 'AbortError');
}
const sharingBridge = bootstrapBoundary.run('sharing', () =>
  createSharingHost({
    player,
    playbackAllowed: foregroundPlaybackAllowed,
    localSelection: {
      select: async (selection, recovery) => {
        admitForegroundPlayback();
        pendingAccountPlayback = null;
        backgroundLiveChoice = null;
        clearArchiveResume();
        const pending = {
          selection: { ...selection },
          sharingGeneration: sharingBridge.host.snapshot().generation,
        };
        pendingPublicPlayback = pending;
        try {
          if (!isTauri()) await accountPlayer!.selectPublic(selection, recovery);
          else
            await archivePlayer!.handoff((signal) =>
              accountPlayer!.selectPublic(selection, recovery, signal),
            );
        } finally {
          if (pendingPublicPlayback === pending) pendingPublicPlayback = null;
        }
      },
      stop: () => accountPlayer!.stop(),
    },
    publishSelectionAllowed: (selection) => !privatePlayback(selection),
    channels: () => catalog.channels,
    extraChannel: (id) => localStreams?.channel(id),
    settings: () => settings,
    saveAudio: async (patch, context, generation) => {
      const current = () =>
        !context?.signal.aborted && sharingBridge.host.snapshot().generation === generation;
      const guard = context
        ? async () => current() && (await context.authorized()) && current()
        : undefined;
      const saved = await saveSettings(
        (draft) => {
          if (context && !current()) throw new DOMException('Phone action canceled.', 'AbortError');
          Object.assign(draft, patch);
        },
        guard,
        true,
      );
      if (!saved) throw new Error('Audio settings could not be saved.');
    },
  }),
);
let sharingPanel: ReturnType<typeof mountSharingSettings> | null = null;
archivePlayer = createArchivePlayer({
  player,
  bookmarks: createArchiveBookmarks(),
  chooseResume: (selection, position, signal) =>
    chooseArchiveResume(selection.title, position.positionMs, signal, position.completed),
  bookmarkFailed: (message) => {
    if (!applicationClosing) notice(message);
  },
  readyScope: archiveRuntimeScope,
  catalogRevision: () => archiveIndexRevision,
  beforeStart: async (signal) => {
    signal.throwIfAborted();
    admitForegroundPlayback();
    backgroundLiveChoice = null;
    pendingAccountPlayback = null;
    pendingPublicPlayback = null;
    await sharingBridge.stop();
    signal.throwIfAborted();
    admitForegroundPlayback();
  },
  confirmedDead: (receipt) => {
    if (archiveRuntimeScope() === null) return;
    recordArchiveRevision(receipt.revision);
    notice(
      'The selected Archive file is no longer available and was removed from playable results.',
    );
    // Do not await the Archive UI's query lane from its own selection callback.
    queueMicrotask(() => {
      if (archiveActiveScope())
        void archiveSearch?.query(libraryQueries.genxtra).catch(() => undefined);
    });
  },
  failed: (message) => {
    if (!applicationClosing) notice(message);
  },
});
const playbackAction = (work: Promise<unknown>): void => {
  void work.catch((error: unknown) => notice(friendlyError(error)));
};
let castingAvailable = !isTauri();
let televisionSelects: ReturnType<typeof installInAppSelects> | undefined;
const castButton = element('cast-button') as HTMLButtonElement;
castButton.hidden = !castingAvailable;
castButton.disabled = !castingAvailable;
const removeCasting = bootstrapBoundary.run('casting', () =>
  installCasting(
    () => (privatePlayback(player.snapshot.selection) ? null : player.snapshot.selection),
    (selected) =>
      catalog.sources.find((source) =>
        catalog.channels.some(
          (channel) => channel.sourceId === source.id && channel.id === selected.id,
        ),
      )?.allowHttp ?? false,
    {
      available: () =>
        castingAvailable &&
        !accountPlayer?.selection &&
        !archivePlayer?.selection &&
        !privatePlayback(player.snapshot.selection),
    },
  ),
);
const activeSources = new Map<string, Source>();
let collectionAbort: AbortController | null = null;
let importRunning = false;
let foregroundGeneration = 0;
let backgroundSuspension: Promise<void> | null = null;
let applicationClosing = false;
const startupJobs = new Map<Promise<void>, AbortController>();

const importJobs = new Set<Promise<void>>();
function ownImport(work: Promise<void>): Promise<void> {
  importJobs.add(work);
  void work.then(
    () => importJobs.delete(work),
    () => importJobs.delete(work),
  );
  return work;
}
let noticeTimer: ReturnType<typeof setTimeout> | undefined;
let expanded = false;
let renderedSelection: string | null = null;
const wakeTransportAdmission = createWakeTransportAdmission();
const viewingWake = isTauri()
  ? createViewingWakeOwner({
      send: async (active) => {
        await wakeTransportAdmission.wait();
        return invoke('set_viewing_active', { active });
      },
      onError: () => {
        if (!applicationClosing)
          notice('Screen sleep preference could not be applied. Playback remains available.');
      },
    })
  : null;
Object.defineProperty(window, '__GENX_WAKE__', {
  get: () => viewingWake?.snapshot() ?? null,
  enumerable: false,
  configurable: false,
});
const viewingForeground = viewingWake
  ? createViewingForegroundAdmission((active) => viewingWake.setForeground(active))
  : null;
const activityWake = createActivityWakePolicy(
  (active) => viewingWake?.setActive(active) ?? Promise.resolve(),
);
void viewingForeground?.setDocumentVisible(!document.hidden).catch(() => undefined);
// Initial idle is an explicit owned disable, not an assumed native state.
void viewingWake?.setActive(false).catch(() => undefined);
let catalogWrites: Promise<unknown> = Promise.resolve();
let selectionEpisode:
  | {
      id: string;
      actor: ReturnType<typeof createSelectionSession>;
      catalog: typeof catalog;
      revision: string;
      broken: boolean;
      supportsWindow: boolean;
    }
  | undefined;
let transferBusy = false;
const removeDataTransfer = installDataTransfer({
  available: () => !importRunning && element('app').dataset.ready === 'true',
  busy: (value) => {
    transferBusy = value;
    setImportBusy(value);
    for (const id of ['settings-file', 'export-button'])
      element<HTMLButtonElement | HTMLInputElement>(id).disabled = value;
  },
  capture: async () => {
    await catalogWrites;
    const saved = await readRecordPair();
    if (saved.catalogRevision !== persistedCatalogRevision)
      throw new Error('Saved channels changed. Reopen the app before exporting.');
    const health = (await decodeSavedHealthInWorker(saved)).health;
    return {
      format: 'genx-tv-backup',
      schemaVersion: 1,
      catalog,
      preferences: await preferences.settledSnapshot(),
      health,
    };
  },
  commit: (prepared) =>
    withPausedGuideUpdates(async () => {
      const work = catalogWrites.then(async () => {
        const healthRevision =
          prepared.healthText === undefined ? undefined : (await readRecordPair()).healthRevision;
        settings = await preferences.replaceAtomically(prepared.record.preferences, async () => {
          const receipt = await writeRecordPair({
            catalog: prepared.catalogText,
            preferences: prepared.preferencesText,
            expectedCatalogRevision: persistedCatalogRevision,
            ...(prepared.healthText === undefined
              ? {}
              : { health: prepared.healthText, expectedHealthRevision: healthRevision }),
          });
          persistedCatalogRevision = receipt.catalogRevision;
        });
        catalog = prepared.record.catalog;
        catalogRevision++;
        await sharingBridge
          .stop()
          .catch(() =>
            notice('Import saved. Playback cleanup needs attention before selecting a channel.'),
          );
        applySettings();
      });
      catalogWrites = work.catch(() => undefined);
      await work;
    }),
  notice,
});
function mutateCatalog(
  mutate: (previous: CatalogRecord) => CatalogRecord,
  signal?: AbortSignal,
): Promise<void> {
  const work = catalogWrites.then(async () => {
    signal?.throwIfAborted();
    const next = mutate(catalog);
    const contents = serializeCatalog(next);
    signal?.throwIfAborted();
    const receipt = await writeRecord('catalog', contents, signal, persistedCatalogRevision);
    persistedCatalogRevision = receipt.catalogRevision;
    catalog = next;
    catalogRevision++;
  });
  catalogWrites = work.catch(() => undefined);
  return work;
}
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
    canonicalSources: structuredClone(catalog.sources),
    providers: settings.reviewedChannelProviders ?? null,
    ...(scanRegion ? { preferredRegion: scanRegion } : {}),
  };
}
let scanRegion: PreferredRegion | undefined;
const scanProviderSources = () => providerScanSources(catalog, settings);
// Included sources allow plain HTTP (owner decision); applied once to saved records.
const adoptIncludedHttp = () =>
  (catalogWrites = catalogWrites
    .then(async () => {
      const next = allowIncludedHttp(catalog, await preferences.settledSnapshot());
      if (!next || applicationClosing) return;
      settings = await preferences.replaceAtomically(next.preferences, async () => {
        persistedCatalogRevision = (
          await writeRecordPair({
            catalog: serializeCatalog(next.catalog),
            preferences: exportPreferences(next.preferences),
            expectedCatalogRevision: persistedCatalogRevision,
          })
        ).catalogRevision;
      });
      catalog = next.catalog;
      catalogRevision++;
      if (!applicationClosing) applySettings();
    })
    .catch(() => undefined));
// Assigned once below; presentPrimaryPage may run before the switcher mounts.
let libraries: ReturnType<typeof mountLibrarySwitcher> | undefined;
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
  if (applicationClosing) return;
  const work = automaticGuides
    .request()
    .then(() => undefined)
    .catch(() => {
      void diagnostics.emit({ operation: 'guide', level: 'warning', code: 'guide-failed' });
      element('source-refresh-status').textContent =
        'Channels saved. Some program guides could not connect; open Guide to retry.';
    })
    .finally(() => {
      if (postScanGuides === work) postScanGuides = null;
    });
  postScanGuides = work;
}
function scanBatchSettled(): void {
  const throttle = scanBatchThrottle;
  const count = catalog.channels.length;
  // listed: the list's size at the scan's start or its last refresh.
  if (!automaticScanActive || count - throttle.listed >= SCAN_LIST_BATCH) {
    throttle.listed = count;
    applySettings();
  }
  if (automaticScanActive) throttle.guidePending = true;
  else queueMicrotask(requestGuidesAfterScan);
}
/** The scan ended: the last list update and the guide rebuild happen now. */
function flushScanBatchWork(slowPass = false): void {
  const throttle = scanBatchThrottle;
  if (throttle.listPending && !applicationClosing) {
    // The native scan's held list, guide and location updates, once.
    browser.search(element<HTMLInputElement>('search').value);
    guide.catalogChanged();
    geographyControls.update();
    updateVisibleGuide();
  }
  throttle.listPending = false;
  if (throttle.listed >= 0 && throttle.listed !== catalog.channels.length && !applicationClosing)
    applySettings();
  throttle.listed = -1;
  if (throttle.guidePending) requestGuidesAfterScan();
  // The scan's checks of saved channels count toward Not responding; a minute
  // of slack covers the page and native clocks differing slightly.
  const since = throttle.startedMs - 60_000;
  throttle.startedMs = 0;
  if (since > 0 && isTauri() && !applicationClosing)
    void channelCheckStore
      .recordFromScan(since, new AbortController().signal, slowPass)
      .then(() => savedChannelCheck.poke())
      .catch(() => {
        void diagnostics.emit({ operation: 'scan', level: 'warning', code: 'scan-failed' });
      });
}
const probeScheduler = createProbeScheduler();
// Scan checks yield the network to whatever is on screen (two at a time while viewing).
const scanProbeGate = createPlaybackProbeGate(() =>
  ['connecting', 'playing', 'buffering', 'reconnecting'].includes(player.snapshot.state),
);
// The Slow list check: one at a time, rested, none while viewing or out of sight.
const slowPassGate = createSlowPassGate(
  () =>
    document.hidden ||
    !nativeViewingForeground ||
    ['connecting', 'playing', 'buffering', 'reconnecting'].includes(player.snapshot.state),
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
  void diagnostics.emit({
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
    if (applicationClosing || automaticScanActive || !indexedFreshAvailable) return;
    if (
      contentLibrary !== 'live' ||
      document.hidden ||
      !nativeViewingForeground ||
      addChannelsEntryWork ||
      importRunning ||
      transferBusy
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
const inlineScanPanel = mountInlineScanPanel(document, () => applicationClosing);
// Long scans only (owner design, October 22, 2026): black after 5 minutes
// without input while a scan runs and nothing plays; never anywhere else.
mountScanScreensaver(document, {
  scanActive: () => automaticScanActive && !applicationClosing,
  viewing: () =>
    ['connecting', 'playing', 'buffering', 'reconnecting'].includes(player.snapshot.state),
  status: () => element('inline-scan-status').textContent ?? '',
});
mountFirstScanHint(
  () => indexedFreshAvailable,
  () => catalog.channels.length,
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
  const episode = episodeId === undefined ? undefined : selectionEpisode;
  const work = catalogWrites.then(async () => {
    const current = () => {
      signal.throwIfAborted();
      if (
        revision !== String(catalogRevision) ||
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
        episode.catalog !== catalog ||
        episode.revision !== expectedCatalogRevision)
    )
      throw new Error('Scan preparation changed. Continue the scan again.');
    if (importRunning || transferBusy) throw new Error('Wait for the current import to finish.');
    transferBusy = true;
    setImportBusy(true);
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
      const snapshot = await preferences.settledSnapshot();
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
      const baseCatalog = catalog;
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
      if (catalog !== baseCatalog)
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
      const latestPreferences = await preferences.settledSnapshot();
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
      settings = await preferences.replaceAtomically(nextPreferences, async () => {
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
                          expectedCheckpointRevision: checkpointContext.expectedCheckpointRevision,
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
        persistedCatalogRevision = receipt.catalogRevision;
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
      catalog = nextCatalog;
      catalogRevision++;
      const preparationId =
        'preparationId' in prepared && typeof prepared.preparationId === 'string'
          ? prepared.preparationId
          : undefined;
      if (episode && preparationId && durableSelectionReceipt) {
        episode.catalog = catalog;
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
          void diagnostics.emit({ operation: 'scan', level: 'warning', code: 'scan-failed' });
        }
      }
      scanPublicationObserver.step(trace, 'apply-ui');
      const selected = player.snapshot.selection;
      if (
        selected &&
        !catalog.channels.some(
          (channel) => channel.id === selected.id && channel.urls.includes(selected.url),
        )
      )
        await sharingBridge
          .stop()
          .catch(() => notice('Channels saved. Playback cleanup needs attention.'));
      scanBatchSettled();
      if (!checkpointContext) scanPublicationObserver.complete(trace);
      return {
        committed: true as const,
        revision: String(catalogRevision),
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
      transferBusy = false;
      setImportBusy(false);
    }
  });
  catalogWrites = work.catch(() => undefined);
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
  const base = catalog;
  const current = () =>
    catalog === base && persistedCatalogRevision === context.receipt.catalogRevision;
  const projection = await readBoundedPublicationProjection(context.receipt, base.sources, signal);
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
  const adoptedSources = await preferences.adoptAcknowledgedSources(
    projection.sources,
    context.expectedPreferenceSources,
    current,
  );
  if (!current()) throw new Error('Saved channels changed before publication adoption.');
  catalogRevision++;
  if (!projection.channels.length && !projection.sources.length) return;
  catalog = { ...base, sources, channels };
  if (projection.sources.length) settings = { ...settings, sources: [...adoptedSources] };
  catalogBrowseViewRevision++;
  if (!applicationClosing) {
    if (projection.sources.length) renderCatalog();
    else if (automaticScanActive) {
      // Owner rule (October 21, 2026): while a scan runs the list refreshes
      // only after 300 new channels, and the guide waits for the scan's end
      // (flushScanBatchWork). A page the list scrolls into later re-reads
      // itself if the catalog has moved on (catalog-window.ts).
      scanBatchThrottle.listPending = true;
      if (catalog.channels.length - scanBatchThrottle.listed >= SCAN_LIST_BATCH) {
        scanBatchThrottle.listed = catalog.channels.length;
        browser.search(element<HTMLInputElement>('search').value);
      }
      return;
    } else {
      // Existing indexed apply reads the new revision/window; it does not rebuild all search metadata.
      browser.search(element<HTMLInputElement>('search').value);
      guide.catalogChanged();
      geographyControls.update();
    }
    updateVisibleGuide();
  }
};
let boundedResumeCapability: Promise<boolean> | null = null;
let indexedFreshAvailable = false;
let boundedScanGeneration = 0;
type BoundedRootStage =
  | 'created'
  | 'commit-queued'
  | 'commit-entered'
  | 'root-admission-refused'
  | 'preferences-settled'
  | 'native-commit'
  | 'native-acknowledged'
  | 'projection-refused'
  | 'commit-failed';
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
class BoundedScanEntryRefusal extends Error {
  constructor() {
    super('Saved scan admission could not be checked.');
  }
}
function supportsBoundedResume(signal: AbortSignal): Promise<boolean> {
  if (!isTauri()) return Promise.resolve(false);
  if (boundedResumeCapability) return boundedResumeCapability;
  const transport = createBoundedNativeScanResumeTransport({
    runtime: { invoke },
    currentFence: () => ({
      expectedCatalogRevision: persistedCatalogRevision,
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
  await catalogWrites;
  await preferences.settledSources();
  signal.throwIfAborted();
  if (applicationClosing) throw new DOMException('Scan entry canceled.', 'AbortError');
  const summary = await nativeScanCheckpointSummary.read(signal);
  signal.throwIfAborted();
  if (summary.checkpointStatus === 'valid' && summary.storedVersion !== 3) return null;
  if (summary.checkpointStatus === 'valid' && summary.catalogRevision !== persistedCatalogRevision)
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
  const recordRoot = (stage: BoundedRootStage, expected = persistedCatalogRevision) => {
    if (diagnosticGeneration !== boundedScanGeneration) return;
    boundedRootDiagnostic = Object.freeze({
      stage,
      catalogMatches: expected === persistedCatalogRevision,
      importRunning,
      transferBusy,
      closing: applicationClosing,
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
    if (quarantined || applicationClosing)
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
      const pending = catalogWrites.then(async () => {
        recordRoot('commit-entered', request.expectedRevisions.catalogRevision);
        current();
        commitSignal.throwIfAborted();
        if (
          request.expectedRevisions.catalogRevision !== persistedCatalogRevision ||
          importRunning ||
          transferBusy
        ) {
          recordRoot('root-admission-refused', request.expectedRevisions.catalogRevision);
          throw new Error('Saved channels changed. Continue the scan again.');
        }
        const expectedPreferenceSources = await preferences.settledSources();
        recordRoot('preferences-settled', request.expectedRevisions.catalogRevision);
        current();
        commitSignal.throwIfAborted();
        if (request.expectedRevisions.catalogRevision !== persistedCatalogRevision)
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
          BigInt(receipt.healthRevision) > BigInt(request.expectedRevisions.healthRevision) + 1n ||
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
        persistedCatalogRevision = receipt.catalogRevision;
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
            if (!applicationClosing)
              void automaticGuides
                .request()
                .catch(() =>
                  notice(
                    'Channels saved. Some program guides could not connect; open Guide to retry.',
                  ),
                );
          });
        } catch {
          recordRoot('projection-refused');
          quarantined = true;
          notice('Channels were saved. Reopen the app before continuing this scan.');
          void diagnostics.emit({ operation: 'scan', level: 'warning', code: 'scan-failed' });
        }
        return receipt;
      });
      catalogWrites = pending.then(
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
const sourceScan = mountSourceScan(element('source-scan-settings'), {
  indexedFreshAvailable: () => indexedFreshAvailable,
  createIndexedFreshResume: async (input, signal) => {
    if (!(await supportsBoundedResume(signal)))
      throw new Error('Incremental source refresh is unavailable.');
    await catalogWrites;
    await preferences.settledSources();
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
    const initialCatalogRevision = persistedCatalogRevision;
    // Existing sources retain the exact durable permission fingerprint, including
    // optional content hints. Detection may enrich a newly reviewed source only.
    const canonicalSources = new Map(catalog.sources.map((source) => [source.id, source]));
    const initialIdentity = JSON.stringify([
      catalog.sources,
      settings.reviewedChannelProviders,
      settings.preferredRegion,
    ]);
    const current = () =>
      !applicationClosing &&
      !signal.aborted &&
      persistedCatalogRevision === initialCatalogRevision &&
      initialIdentity ===
        JSON.stringify([
          catalog.sources,
          settings.reviewedChannelProviders,
          settings.preferredRegion,
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
              element('inline-scan-status').textContent = sourcePreparationStatus(p);
          },
        );
      },
      continueChecks: async () => {
        throw new Error('Use the saved scan owner to continue.');
      },
      stopChecks: async () => undefined,
      progress: (progress) => {
        if (!current()) return;
        element('inline-scan-status').textContent =
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
          region: settings.preferredRegion ? structuredClone(settings.preferredRegion) : undefined,
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
      void diagnostics.emit({ operation: 'scan', level: 'info', code: 'scan-started' });
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
          void diagnostics.emit({
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
      scanBatchThrottle.listed = catalog.channels.length;
      scanBatchThrottle.startedMs = Date.now();
    }
    if (!active) flushScanBatchWork(inlineScanSlowPass);
    updateImportActions();
    void activityWake.setScan(active).catch(() => undefined);
  },
  checkpoint: {
    load: async (signal) => {
      checkpointProgressCapture?.reset();
      resumedCheckpointFormat = null;
      const recovery = scanRecoveryObserver.begin();
      await catalogWrites;
      await preferences.settledSnapshot();
      signal.throwIfAborted();
      const saved = await readScanCheckpoint().catch((error: unknown) => {
        scanRecoveryObserver.refuse(recovery, signal.aborted ? 'canceled' : 'read-unavailable');
        throw error;
      });
      signal.throwIfAborted();
      if (saved.catalogRevision !== persistedCatalogRevision) {
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
          scanRecoveryObserver.refuse(recovery, signal.aborted ? 'canceled' : 'invalid-checkpoint');
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
          catalog.sources,
          settings.reviewedChannelProviders ?? null,
        );
      } catch {
        signal.throwIfAborted();
        scanRecoveryObserver.refuse(recovery, 'source-settings-changed');
        return { ...saved, checkpoint: null, checkpointStatus: 'invalid' as const };
      }
      scanRecoveryObserver.step(recovery, 'policy');
      const policy = await fingerprintScanPolicy({
        providers: settings.reviewedChannelProviders ?? null,
        preferredRegion: settings.preferredRegion,
        budgetMs: parsed.budgetMs,
        platform: healthPlatform ?? 'native-unavailable',
        observerProfile: reachabilityHealthProfile(isTauri(), parsed.budgetMs),
        sourceDefinitions: parsed.sourceDefinitions,
      });
      signal.throwIfAborted();
      if (!canResumeScanCheckpoint(parsed, Date.now(), persistedCatalogRevision, policy)) {
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
              if (saved.catalogRevision !== persistedCatalogRevision || applicationClosing)
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
          if (saved.catalogRevision !== persistedCatalogRevision || applicationClosing)
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
          await catalogWrites;
          signal.throwIfAborted();
          const saved = await readScanCheckpoint();
          signal.throwIfAborted();
          if (
            saved.catalogRevision !== persistedCatalogRevision ||
            saved.checkpointRevision !== expectedCheckpointRevision ||
            saved.checkpointStatus === 'invalid' ||
            (saved.checkpointStatus === 'valid' && saved.jobId !== snapshot.jobId)
          )
            throw new Error('Scan progress changed. Reopen the app before continuing.', {
              cause: failure,
            });
          owner.releaseUncommittedPreparation(expectedCheckpointRevision, saved.checkpointRevision);
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
        if (!checkpointProgressCapture) throw new Error('Checkpoint capture owner is unavailable.');
        checkpointProgressCapture.acknowledgeMutation(mutation, revision);
        if (trace) scanPublicationObserver.complete(trace);
      } catch (failure) {
        if (trace) scanPublicationObserver.fail(trace, 'ack-failed');
        throw failure;
      }
    },
    saveMutation: async (mutation, revision, checkpointRevision, signal) => {
      const work = catalogWrites.then(async () => {
        signal.throwIfAborted();
        if (revision !== String(catalogRevision))
          throw new Error('Saved channels changed. Rescan before continuing.');
        await preferences.settledSnapshot();
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
              expectedCatalogRevision: persistedCatalogRevision,
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
            persistedCatalogRevision,
            checkpointRevision,
            signal,
          );
        }
        if (receipt.checkpointRevision === undefined)
          throw new Error('Scan progress save was not confirmed.');
        return { committed: true as const, checkpointRevision: receipt.checkpointRevision };
      });
      catalogWrites = work.catch(() => undefined);
      return work;
    },
    save: async (text, revision, checkpointRevision, signal) => {
      await catalogWrites;
      if (revision !== String(catalogRevision))
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
      await catalogWrites;
      if (revision !== String(catalogRevision))
        throw new Error('Saved channels changed. Rescan before continuing.');
      const receipt = await discardScanCheckpoint(
        jobId,
        persistedCatalogRevision,
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
    const work = catalogWrites.then(async () => {
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
        applicationClosing ||
        context.revision !== String(catalogRevision) ||
        selectionEpisode ||
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
        catalog,
        catalogRevision: persistedCatalogRevision,
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
        catalog,
        revision: persistedCatalogRevision,
        broken: false,
        supportsWindow,
      };
      selectionEpisode = episode;
      let disposal: Promise<void> | undefined;
      return {
        episodeId: episode.id,
        supportsWindow,
        dispose: () => {
          if (!disposal)
            disposal = (async () => {
              // SourceScan joins its publisher first. Also join the actual catalog owner.
              await catalogWrites;
              if (selectionEpisode === episode) selectionEpisode = undefined;
              await actor.dispose();
            })();
          return disposal;
        },
      };
    });
    catalogWrites = work.catch(() => undefined);
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
  revision: () => String(catalogRevision),
  onCollectionSettled: () => {
    // Collection has joined; probes use enriched channels, not the raw registry documents.
    scanCollector.release();
  },
  capture: (drafts) => {
    if (importRunning || transferBusy) throw new Error('Wait for the current import to finish.');
    scanStorageRevision = persistedCatalogRevision;
    scanCollector.reset();
    scanRegion = settings.preferredRegion ? structuredClone(settings.preferredRegion) : undefined;
    scanScope = drafts
      ? structuredClone([...drafts])
      : scanProviderSources().map((source) => ({
          source: { ...source },
          fingerprint: crypto.randomUUID(),
        }));
    return { revision: String(catalogRevision), sources: structuredClone(scanScope) };
  },
  collect: collectScanSource,
  readFileSnapshot: async (file, source, signal) => {
    const generation = foregroundGeneration;
    signal.throwIfAborted();
    const text = await file.text();
    signal.throwIfAborted();
    if (generation !== foregroundGeneration || applicationClosing)
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
const pageInput = createPageInput(
  isTauri()
    ? {
        native: {
          inspect: (url, allowHttp, requestId) =>
            invoke('inspect_discovery_page', { url, allowHttp, requestId }),
          cancel: (requestId) => invoke('cancel_playlist', { requestId }),
        },
      }
    : {},
);
const websiteDiscovery = mountWebsiteDiscovery(element('source-scan-settings'), {
  inspect: (url, allowHttp, signal) => pageInput.inspect(url, allowHttp, signal),
  reviewSource: (url, label, allowHttp, signal) => {
    signal?.throwIfAborted();
    if (importRunning || transferBusy) throw new Error('Wait for the current import to finish.');
    const existing = catalog.sources.find(
      (source) => source.kind === 'url' && source.location === url,
    );
    const source = validateSource({
      id: existing?.id ?? crypto.randomUUID(),
      name: label.trim().slice(0, 512) || new URL(url).hostname,
      location: url,
      kind: 'url',
      allowHttp,
    });
    sourceScan.open([{ source, fingerprint: crypto.randomUUID() }]);
  },
});
element('find-sources-button').addEventListener('click', () => {
  if (importRunning || transferBusy) return;
  const initialUrl = element<HTMLInputElement>('playlist-url').value.trim();
  element<HTMLDialogElement>('import-dialog').close();
  element('settings-button').focus();
  websiteDiscovery.open(initialUrl);
});
let visibleGuide: ReturnType<typeof createVisibleGuideOwner> | null = null;
let visibleGuideRows: readonly VisibleGuideChannel[] = [];
let visibleGuideRequestedRows: readonly VisibleGuideChannel[] = [];
let visibleGuideCatalog: CatalogRecord | null = null;
let visibleGuideRemoved: readonly string[] | null = null;
let visibleGuideIdentities = new Set<string>();
let visibleGuideGeneration = 0;
let visibleGuideKey: string | null = null;
let catalogBrowseReady = false;
const accountBrowser = createAccountBrowser({
  pageChanged: () => queueMicrotask(() => renderPlayer(player.snapshot)),
});
const accountPreferences = createAccountPreferences();
let accountPreferenceOwner: AbortController | null = null;
let accountPreferenceWork: Promise<AccountPreferencesReceipt> | null = null;
let accountPreferenceKey = '';
function writeAccountPreference(
  mutation: AccountPreferencesMutation,
): Promise<AccountPreferencesReceipt> {
  const scope = accountBrowser.preferenceScope();
  if (!scope || applicationClosing)
    return Promise.reject(new Error('Reload the account channel list before making changes.'));
  const key = JSON.stringify([scope, mutation]);
  if (accountPreferenceWork)
    return key === accountPreferenceKey
      ? accountPreferenceWork
      : Promise.reject(new Error('Wait for the current channel change to finish.'));
  const owner = new AbortController();
  accountPreferenceOwner = owner;
  accountPreferenceKey = key;
  const work = accountPreferences
    .write(
      {
        schemaVersion: 1,
        accountId: scope.accountId,
        expectedAccountRevision: scope.accountRevision,
        expectedMediaRevision: scope.mediaRevision,
        expectedPreferencesRevision: scope.preferencesRevision,
        mutation,
      },
      owner.signal,
    )
    .then(async (receipt) => {
      const account = accountBrowser.selectedAccount;
      if (
        account?.id === receipt.accountId &&
        account.revision === receipt.accountRevision &&
        !applicationClosing
      ) {
        await accountBrowser.select(account);
        renderCatalog();
      }
      if (receipt.cleanupPending)
        notice('Channel changes were saved. Playback cleanup needs a retry.');
      return receipt;
    })
    .finally(() => {
      if (accountPreferenceWork === work) {
        accountPreferenceWork = null;
        accountPreferenceOwner = null;
        accountPreferenceKey = '';
        if (!applicationClosing) renderPlayer(player.snapshot);
      }
    });
  accountPreferenceWork = work;
  renderPlayer(player.snapshot);
  return work;
}
// eslint-disable-next-line prefer-const
channelLogos = createChannelLogos({
  readyScope: () =>
    isTauri() &&
    element('app').dataset.ready === 'true' &&
    !applicationClosing &&
    contentLibrary === 'live' &&
    primaryPage === 'watch' &&
    !liveBrowseSuspended &&
    !document.hidden &&
    nativeViewingForeground &&
    !accountBrowser.selectedAccount
      ? {
          key: `${archiveStorageEpoch}:${persistedCatalogRevision}`,
          revision: persistedCatalogRevision,
        }
      : null,
  changed: () => browser.refreshArtwork(),
});
// Paid TV rows show what is on now from the provider guide stored on this device.
let paidNowPlaying: ReturnType<typeof createPaidNowPlaying> | null = null;
const browser = new ChannelBrowser(
  element('channel-list'),
  (id) => {
    element('app').dataset.compactView = 'watch';
    element<HTMLSelectElement>('compact-view').value = 'watch';
    updateVisibleGuide();
    const privateChannel = accountBrowser.selectionFor(id);
    if (privateChannel) {
      playbackAction(selectAccountPlayback(privateChannel.channel, privateChannel.fence));
      return;
    }
    const channel = catalog.channels.find((item) => item.id === id);
    if (channel)
      playbackAction(
        sharingBridge.select({ id: channel.id, name: channel.name, url: channel.urls[0] }),
      );
  },
  {
    onVisibleGuideRows: (rows) => {
      visibleGuideRows = rows.map((row) => ({ ...row }));
      updateVisibleGuide();
      paidNowPlaying?.setScope(rows);
    },
  },
  isTauri()
    ? {
        revision: () =>
          accountBrowser.selectedAccount ? accountBrowser.revision() : persistedCatalogRevision,
        ready: () =>
          element('app').dataset.ready === 'true' &&
          contentLibrary === 'live' &&
          !liveBrowseSuspended &&
          !document.hidden &&
          nativeViewingForeground &&
          (!!accountBrowser.selectedAccount || catalogBrowseReady),
        identity: () =>
          `${libraryIntent}:` +
          (accountBrowser.selectedAccount
            ? accountBrowser.identity()
            : `${catalogRevision}:${catalogBrowseViewRevision}`),
        query: (input, signal) => {
          if (
            element('app').dataset.ready !== 'true' ||
            liveBrowseSuspended ||
            contentLibrary !== 'live' ||
            applicationClosing ||
            document.hidden ||
            !nativeViewingForeground
          )
            return Promise.reject(new DOMException('Channel browsing suspended.', 'AbortError'));
          const owner = new AbortController();
          const joined = createOwnedAbortSignals([signal, owner.signal]);
          const work = (
            accountBrowser.selectedAccount
              ? accountBrowser.query(input, joined.signal)
              : queryCatalogPage({ ...input, favoritesFirst: true }, joined.signal)
          ).finally(() => {
            joined.dispose();
            liveBrowseJobs.delete(owner);
          });
          liveBrowseJobs.set(owner, work);
          return work;
        },
      }
    : undefined,
  {
    logos: channelLogos,
    baseRowHeight: () =>
      element('app').dataset.deviceKind === 'tv'
        ? 52
        : window.innerWidth >= 1100 && window.innerHeight >= 600
          ? 72
          : window.innerWidth >= 700 && window.innerWidth <= 1100 && window.innerHeight <= 600
            ? 60
            : 72,
    onFavorite: (id) => toggleChannelFavorite(id),
    onManage: (id) => channelActions.open(id),
  },
);
paidNowPlaying = createPaidNowPlaying({
  guide: createAccountGuide(),
  account: () => (contentLibrary === 'live' ? accountBrowser.selectedAccount : null),
  epgId: (id) => accountBrowser.selectionFor(id)?.channel.epgId ?? null,
  now: () => Date.now(),
  publish: (rows) => browser.setNowPlaying(rows),
});
const channelActions = mountChannelActions({
  category: (id) => {
    const account = accountBrowser.selectionFor(id);
    if (account)
      return {
        name: account.channel.name,
        original: account.originalCategory,
        current: account.channel.category,
      };
    const channel = catalog.channels.find((entry) => entry.id === id);
    return channel
      ? {
          name: channel.name,
          original: channel.category,
          current: createChannelCategoryResolver(settings)(channel),
        }
      : null;
  },
  saveCategory: async (id, category) => {
    if (accountBrowser.selectionFor(id)) {
      await writeAccountPreference({ kind: 'category', channelId: id, category });
      return;
    }
    if (applicationClosing || !catalog.channels.some((channel) => channel.id === id))
      throw new Error('Channel unavailable.');
    if (isTauri()) {
      await editPublicChannelGroup(id, { kind: 'category', value: category });
      return;
    }
    const saved = await saveSettings((draft) => {
      const overrides = (draft.channelCategoryOverrides ?? []).filter(
        (entry) => entry.channelId !== id,
      );
      if (category !== null) overrides.push({ channelId: id, category });
      draft.channelCategoryOverrides = overrides;
    });
    if (!saved) throw new Error('Category was not saved.');
  },
  removeChannel: (id) => removeSavedChannel(id),
  notice,
});
const providerManagement = mountProviderManagement(element('provider-management'), {
  read: () => ({
    schemaVersion: 1,
    reviewedChannelProviders: settings.reviewedChannelProviders ?? [],
    reviewedGuideProviders: settings.reviewedGuideProviders ?? [],
  }),
  remove: async (kind, id, signal) => {
    if (applicationClosing || importRunning || transferBusy || addChannelsEntryWork) return false;
    return saveSettings(
      (draft) => {
        if (kind === 'channel')
          draft.reviewedChannelProviders = (draft.reviewedChannelProviders ?? []).filter(
            (provider) => provider.id !== id,
          );
        else
          draft.reviewedGuideProviders = (draft.reviewedGuideProviders ?? []).filter(
            (provider) => provider.id !== id,
          );
      },
      async () => !signal.aborted && !applicationClosing,
    );
  },
});
const publicGroupControllers = new Set<AbortController>();
async function editPublicChannelGroup(
  id: string,
  action: CatalogGroupAction | (() => CatalogGroupAction),
  moreIds: readonly string[] = [],
): Promise<void> {
  if (applicationClosing || element('app').dataset.ready !== 'true')
    throw new Error('Channel unavailable.');
  let acknowledged = false;
  const work = catalogWrites.then(async () => {
    const abort = new AbortController();
    publicGroupControllers.add(abort);
    try {
      const settingsAfter = await preferences.mutateExternally(async () => {
        const page = await queryCatalogPage(
          {
            schemaVersion: 1,
            expectedCatalogRevision: persistedCatalogRevision,
            query: '',
            filter: 'all',
            sort: 'source',
            pageSize: 1,
          },
          abort.signal,
        );
        if (applicationClosing || document.hidden || !nativeViewingForeground)
          throw new Error('Channel editing was interrupted. Try again.');
        // Resolve toggles inside both write queues, against acknowledged preferences.
        const resolvedAction = typeof action === 'function' ? action() : action;
        await mutateCatalogGroup(id, resolvedAction, page, abort.signal, moreIds);
        acknowledged = true;
      });
      settings = settingsAfter;
      catalogBrowseViewRevision++;
      if (!applicationClosing) {
        guide.catalogChanged(true);
        applySettings();
        renderCatalog();
      }
    } finally {
      publicGroupControllers.delete(abort);
    }
  });
  catalogWrites = work.catch(() => undefined);
  try {
    await work;
  } catch (error) {
    if (acknowledged)
      // Native failure causes can contain private source URLs; publish a fixed symptom.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(
        'Changes were saved, but the channel list needs to reload. Reopen the application.',
      );
    throw error;
  }
}
function toggleChannelFavorite(id: string): void {
  if (applicationClosing || /^archive-[a-f0-9]{64}$/u.test(id)) return;
  const account = accountBrowser.selectionFor(id);
  if (account) {
    playbackAction(
      writeAccountPreference({ kind: 'favorite', channelId: id, favorite: !account.favorite }),
    );
    return;
  }
  if (/^account-[a-f0-9]{32}-[a-f0-9]{64}$/u.test(id)) {
    notice('Reload the account channel list to change this favorite.');
    return;
  }
  if (isTauri()) {
    void editPublicChannelGroup(id, () => ({
      kind: 'favorite',
      value: !preferences.snapshot().favorites.includes(id),
    })).catch((error) => notice(friendlyError(error)));
  } else
    void saveSettings((draft) => {
      draft.favorites = draft.favorites.includes(id)
        ? draft.favorites.filter((item) => item !== id)
        : [...draft.favorites, id];
    });
}
// eslint-disable-next-line prefer-const -- assigned after the panel it serves
let viewingChoices: ReturnType<typeof mountViewingChoices> | undefined;
const geographyControls = mountGeographyControls(element('geography-controls'), {
  preferredCountry: () => settings.preferredRegion?.country,
  channels: () =>
    catalog.channels.filter((channel) => !settings.removedChannels.includes(channel.id)),
  summary: () => (accountBrowser.selectedAccount ? (viewingChoices?.summary ?? null) : null),
  apply: ({ filter, sort, registry }) => browser.setGeography(filter, sort, registry),
});
viewingChoices = mountViewingChoices({
  channels: browser,
  accounts: accountBrowser,
  changed: () => geographyControls.update(),
  notice,
});
const accountVault = createAccountVault();
const accountCatalog = createAccountCatalog();
let accountScopeGeneration = 0;
async function selectAccountScope(
  account: AccountMetadata | null,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  const generation = ++accountScopeGeneration;
  const previous = accountBrowser.selectedAccount;
  await accountBrowser.select(account);
  if (generation !== accountScopeGeneration)
    throw new DOMException('Library selection replaced.', 'AbortError');
  if (signal?.aborted) {
    await accountBrowser.select(previous);
    signal.throwIfAborted();
  }
  chooseCategory('all');
  viewingChoices?.refresh();
  if (previous?.id !== account?.id) geographyControls.reset();
  const favoriteFilter = document.querySelector<HTMLButtonElement>('[data-filter="favorites"]');
  if (favoriteFilter) favoriteFilter.disabled = false;
  const favoriteOption = element<HTMLSelectElement>(
    'compact-filter',
  ).querySelector<HTMLOptionElement>('option[value="favorites"]');
  if (favoriteOption) favoriteOption.disabled = false;
  renderCatalog();
}
// eslint-disable-next-line prefer-const -- read earlier by presentPrimaryPage
libraries = mountLibrarySwitcher(
  {
    list: (signal) => accountVault.list(signal),
    ready: () => isTauri() && !applicationClosing,
    selected: () => accountBrowser.selectedAccount,
    select: (account) => selectAccountScope(account),
    release: async (id) => {
      if (accountPlayer?.selection?.fence.accountId === id) await accountPlayer.stop();
    },
    showLive: () => switchLibrary('live'),
    openAccounts: () => {
      element('settings-button').click();
      document.querySelector<HTMLButtonElement>('[data-settings-section="sources"]')?.click();
    },
    run: playbackAction,
    vod: { play: playAccountVod, changed: () => televisionSelects?.refresh() },
  },
  {
    free: element('live-tv-button'),
    paid: element('paid-tv-button'),
    list: element('channel-list'),
    row: document.querySelector<HTMLElement>('.sidehead'),
    guide: element('guide-button'),
  },
);
localStreams = mountLocalStreams(
  {
    showLive: () => switchLibrary('live'),
    playRadio: (radio) => sharingBridge.select(radio),
    stopPlayback: () => sharingBridge.stop(),
    run: playbackAction,
    voice: (t) =>
      void speechSearch
        .retarget(t?.container ?? element('speech-control'), t?.input ?? element('search'))
        .catch(() => undefined),
  },
  {
    after: element('genxtra-button'),
    leave: ['live-tv-button', 'paid-tv-button', 'genxtra-button', 'guide-button'].map(element),
    list: element('channel-list'),
    stage: element('screen'),
  },
);
const accountSettingsContainer = document.createElement('div');
document.querySelector('[data-settings-panel="sources"]')?.append(accountSettingsContainer);
const accountControls = mountAccountManagement(accountSettingsContainer, {
  vault: accountVault,
  available: () => isTauri() && element('app').dataset.ready === 'true' && !applicationClosing,
  changed: () => libraries!.reload(),
  notice,
  refresh: async (account, signal) => {
    const receipt = await accountCatalog.refresh(account, signal);
    if (accountBrowser.selectedAccount?.id === account.id) await selectAccountScope(account);
    return receipt;
  },
  browse: async (account, signal) => {
    signal.throwIfAborted();
    await switchLibrary('live');
    signal.throwIfAborted();
    await libraries!.select(account);
    signal.throwIfAborted();
    element<HTMLDialogElement>('settings-dialog').close();
    element('channel-list').focus({ preventScroll: true });
  },
});
const openAccountSettings = () => {
  void accountControls.update();
};
element('settings-button').addEventListener('click', openAccountSettings);
const speechSearch = mountSpeechSearch(
  element('speech-control'),
  element<HTMLInputElement>('search'),
  {
    recognizer: new NativeSpeech(),
    notice,
    language: () => navigator.language || 'en-US',
    cloudConsent: () => settings.voiceSearchConsent === true,
    saveCloudConsent: async (accepted, signal) => {
      signal?.throwIfAborted();
      if (
        !(await saveSettings(
          (draft) => {
            draft.voiceSearchConsent = accepted;
          },
          async () => !signal?.aborted,
        ))
      )
        throw new Error('Voice search permission could not be saved.');
    },
  },
);
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
  automaticGuidePreferenceSnapshot === automaticGuidePreferenceKey(settings) &&
  automaticGuideSourceSnapshot === automaticGuideSourceKey(catalog.sources) &&
  automaticGuideRemovedSnapshot.length === settings.removedChannels.length &&
  automaticGuideRemovedSnapshot.every((id, index) => id === settings.removedChannels[index]);
let automaticGuideDiscovery: {
  key: string;
  result: Awaited<ReturnType<typeof discoverPlaylistGuides>>;
  retryAtMs: number;
} | null = null;
function guideChanged(): void {
  void visibleGuide?.refresh().catch(() => undefined);
  guide.catalogChanged(true);
  queueMicrotask(wakeDailyRefresh);
}
const guideHost = createGuideHost({
  enableTimeline: isTauri(),
  discover: (signal) =>
    discoverPlaylistGuides(
      structuredClone(catalog.sources),
      (url, allowHttp, ownedSignal) => inspectSource(url, allowHttp, ownedSignal),
      signal,
      { registry: settings.reviewedGuideProviders },
    ),
  catalogRevision: () =>
    element('app').dataset.ready === 'true' && !applicationClosing
      ? persistedCatalogRevision
      : null,
  onChanged: guideChanged,
  channels: () => {
    const removed = new Set(settings.removedChannels);
    const favorites = new Set(settings.favorites);
    const category = createChannelCategoryResolver(settings);
    return catalog.channels
      .filter((channel) => !removed.has(channel.id))
      .map((channel) => ({
        ...channel,
        category: category(channel),
        favorite: favorites.has(channel.id),
      }));
  },
  selectedChannel: () =>
    catalog.channels.find((channel) => channel.id === player.snapshot.selection?.id) ?? null,
  watch: async (channel, signal) => {
    signal.throwIfAborted();
    const current = catalog.channels.find(
      (entry) => entry.id === channel.id && entry.sourceId === channel.sourceId,
    );
    if (!current || settings.removedChannels.includes(current.id))
      throw new Error('This channel is no longer available.');
    await sharingBridge.select({ id: current.id, name: current.name, url: current.urls[0] });
  },
});
let lastCachedGuideConnection: {
  key: string;
  receipt: Awaited<ReturnType<typeof nativeGuide.connectCached>>;
} | null = null;
async function connectSavedGuideCaches(signal: AbortSignal, cacheOnly: boolean) {
  await catalogWrites;
  await preferences.settledSnapshot();
  signal.throwIfAborted();
  const capturedRemoved = [...settings.removedChannels];
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
    fresh.preferenceKey === automaticGuidePreferenceKey(settings) &&
    automaticGuideSourceKey(fresh.sources) === automaticGuideSourceKey(catalog.sources) &&
    capturedRemoved.length === settings.removedChannels.length &&
    capturedRemoved.every((id, index) => id === settings.removedChannels[index]);
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
      void diagnostics.emit({
        operation: 'guide',
        level: 'warning',
        code: 'guide-identity-unavailable',
      });
    void visibleGuide?.refresh().catch(() => undefined);
    guide.catalogChanged(true);
    completedResult = result;
    return result;
  } finally {
    signal.removeEventListener('abort', cancel);
    await Promise.resolve(cancellation).then(() => {
      if (cancellationFailed) throw new Error('Program guide cancellation could not be confirmed.');
    });
    if (completedResult && boundedScopeKey !== null && !signal.aborted && scopeCurrent())
      lastCachedGuideConnection = { key: boundedScopeKey, receipt: completedResult };
  }
}
const automaticGuides = createAutomaticGuideBuilder({
  canRequest: () =>
    rendererRecoveryPolicy.allowAutomaticWork() &&
    settings.automaticGuideUpdates !== false &&
    !automaticGuideControlPending,
  canRun: () =>
    isTauri() &&
    !applicationClosing &&
    nativeViewingForeground &&
    element('app').dataset.ready === 'true',
  isCurrent: (revision) =>
    revision === persistedCatalogRevision &&
    automaticGuidePreferenceSnapshot === automaticGuidePreferenceKey(settings) &&
    automaticGuideRemovedSnapshot.length === settings.removedChannels.length &&
    automaticGuideRemovedSnapshot.every((id, index) => id === settings.removedChannels[index]),
  isScopeCurrent: automaticGuideScopeCurrent,
  capture: async (signal, reportPhase) => {
    await catalogWrites;
    await preferences.settledSnapshot();
    signal.throwIfAborted();
    automaticGuideRemovedSnapshot = [...settings.removedChannels];
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
      captured.sources.map((source) => [source.id, source.kind, source.location, source.allowHttp]),
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
      discoveryFailed: discovered.outcomes.filter((outcome) => outcome.status === 'failed').length,
      catalogCountries: captured.catalogCountries,
      providers: prioritizeGuideProviders(
        [...providerLocations.values()].map((candidate) => ({
          name: candidate.name,
          location: candidate.location,
          allowHttp: permissions.get(candidate.location)!.allowHttp,
          aliases: captured.aliases.find((aliases) => aliases.guideLocation === candidate.location),
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
    if (automaticGuidePreferenceSnapshot !== automaticGuidePreferenceKey(settings))
      throw new DOMException('Guide configuration changed.', 'AbortError');
    await guideHost.publishCachedPreview(preview.ticket, preview.sourceRevision, signal);
  },
  connectScopeLatest: (signal) => connectSavedGuideCaches(signal, false),
  connectCacheOnly: (signal) => connectSavedGuideCaches(signal, true),
  maintain: createGuideMaintenance({
    scanning: () => automaticScanActive || sourceScan.snapshot().busy,
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
    guide.presentAutomaticProgress(progress);
    const review =
      progress.mappingConflictAssessment === 'complete' &&
      typeof progress.preservedMappingConflicts === 'number' &&
      progress.preservedMappingConflicts > 0
        ? ` · ${progress.preservedMappingConflicts} channels have multiple matching guides; your current choices were kept`
        : '';
    element('source-refresh-status').textContent =
      `Program guides: ${progress.attempted} of ${progress.total} sources checked · ${progress.failed} unavailable${review}`;
  },
});
type PrimaryPage = 'watch' | 'guide';
let primaryPage: PrimaryPage = 'watch';
let primaryIntent = 0;
let primaryTransitions: Promise<void> = Promise.resolve();
type PrimaryTransitionStage =
  | 'idle'
  | 'queued'
  | 'closing-guide'
  | 'closing-search'
  | 'refused'
  | 'opening'
  | 'completed'
  | 'failed';
type PrimaryTransitionReason =
  | 'none'
  | 'application-closing'
  | 'superseded'
  | 'document-hidden'
  | 'native-background'
  | 'operation-failed';
let primaryTransitionStage: PrimaryTransitionStage = 'idle';
let primaryTransitionReason: PrimaryTransitionReason = 'none';
let primaryTransitionRevision = 0;
let primaryTransitionActiveIntent = 0;
let primaryTransitionRequestedIntent = 0;
let primaryTransitionPending = 0;
let primaryTransitionErrorCount = 0;
function observePrimaryTransition(
  stage: PrimaryTransitionStage,
  reason: PrimaryTransitionReason = 'none',
): void {
  primaryTransitionStage = stage;
  primaryTransitionReason = reason;
  primaryTransitionRevision = Math.min(Number.MAX_SAFE_INTEGER, primaryTransitionRevision + 1);
}
const primaryHost = element('primary-view-host');
let guideOpenedFrom = 'watch';
/** While the Guide is open and something plays, the preview is a control:
 * OK, Enter or a click opens full screen; leaving full screen returns to the
 * Guide, and only Close guide returns to the normal view. */
function updatePreviewControl(): void {
  const screen = element('screen');
  const app = element('app');
  const selectable =
    app.dataset.guidePanel === 'open' &&
    app.dataset.playerIdle !== 'true' &&
    !app.classList.contains('viewing-fullscreen');
  if (selectable) {
    screen.tabIndex = 0;
    screen.setAttribute('role', 'button');
    screen.setAttribute('aria-label', 'Watch full screen');
    screen.title = 'Watch full screen';
  } else {
    if (document.activeElement === screen) screen.blur();
    screen.removeAttribute('tabindex');
    screen.removeAttribute('role');
    screen.removeAttribute('aria-label');
    screen.removeAttribute('title');
  }
}
function selectPreview(event: Event): void {
  if (element('screen').getAttribute('role') !== 'button') return;
  event.preventDefault();
  element('fullscreen-button').click();
}
element('screen').addEventListener('click', selectPreview);
element('screen').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') selectPreview(event);
});
function presentPrimaryPage(page: PrimaryPage): void {
  primaryPage = page;
  // The guide opens in the right panel under a small playing picture; the
  // channel list and the library tabs stay as they are.
  primaryHost.hidden = page === 'watch';
  const app = element('app');
  const wasOpen = app.dataset.guidePanel === 'open';
  app.dataset.guidePanel = page === 'guide' ? 'open' : 'closed';
  // Phones show one panel: the guide takes it, and closing returns to the
  // panel it was opened from (the channel row holds the Guide button).
  // Outside the phone's separate screens the Guide always opens from the channel row.
  if (page === 'guide' && !wasOpen)
    guideOpenedFrom = app.classList.contains('compact-content')
      ? (app.dataset.compactView ?? 'watch')
      : 'channels';
  const compact = page === 'guide' ? 'watch' : wasOpen ? guideOpenedFrom : null;
  if (compact) {
    app.dataset.compactView = compact;
    element<HTMLSelectElement>('compact-view').value = compact;
  }
  libraries?.present(contentLibrary === 'live');
  updatePreviewControl();
  element('genxtra-button').setAttribute(
    'aria-pressed',
    String(page === 'watch' && contentLibrary === 'genxtra'),
  );
  element('guide-button').setAttribute('aria-pressed', String(page === 'guide'));
  element<HTMLButtonElement>('guide-button').disabled = contentLibrary === 'genxtra';
}
function switchPrimaryPage(page: PrimaryPage, query = ''): Promise<void> {
  const intent = ++primaryIntent;
  primaryTransitionRequestedIntent = intent;
  primaryTransitionPending++;
  if (!primaryTransitionActiveIntent) observePrimaryTransition('queued');
  const work = primaryTransitions.then(async () => {
    primaryTransitionActiveIntent = intent;
    try {
      if (applicationClosing) {
        observePrimaryTransition('refused', 'application-closing');
        return;
      }
      observePrimaryTransition('closing-guide');
      await guide.close();
      await paidGuide.hide();
      observePrimaryTransition('closing-search');
      if (page !== 'watch') {
        await archiveSearch?.suspend({ preserveSelection: true });
        await archiveDiscovery.suspend();
      }
      const reason: PrimaryTransitionReason =
        intent !== primaryIntent
          ? 'superseded'
          : applicationClosing
            ? 'application-closing'
            : document.hidden
              ? 'document-hidden'
              : !nativeViewingForeground
                ? 'native-background'
                : 'none';
      if (reason !== 'none') {
        observePrimaryTransition('refused', reason);
        return;
      }
      observePrimaryTransition('opening');
      const paidAccount = page === 'guide' ? accountBrowser.selectedAccount : null;
      if (paidAccount) {
        // Paid TV: the provider's own guide. Its download continues in the
        // panel; the transition queue never waits for the network.
        presentPrimaryPage('guide');
        void paidGuide.show({ ...paidAccount });
        paidGuide.focus();
      } else if (page === 'guide') await guide.open(query);
      else {
        presentPrimaryPage('watch');
        element('guide-button').focus({ preventScroll: true });
        if (contentLibrary === 'genxtra') await archiveSearch?.resume(libraryQueries.genxtra);
      }
      observePrimaryTransition('completed');
    } catch (error) {
      primaryTransitionErrorCount = Math.min(
        Number.MAX_SAFE_INTEGER,
        primaryTransitionErrorCount + 1,
      );
      observePrimaryTransition('failed', 'operation-failed');
      throw error;
    } finally {
      primaryTransitionPending--;
      primaryTransitionActiveIntent = 0;
    }
  });
  primaryTransitions = work.catch(() => undefined);
  return work;
}
const guideChannelLogos = createChannelLogos({
  readyScope: () =>
    isTauri() &&
    element('app').dataset.ready === 'true' &&
    !applicationClosing &&
    primaryPage === 'guide' &&
    !document.hidden &&
    nativeViewingForeground &&
    !accountBrowser.selectedAccount
      ? {
          key: `${archiveStorageEpoch}:${persistedCatalogRevision}`,
          revision: persistedCatalogRevision,
        }
      : null,
  changed: () => guide.refreshArtwork(),
});
const paidGuide = mountPaidGuide(primaryHost, {
  guide: createAccountGuide(),
  async watch(row, signal) {
    signal.throwIfAborted();
    const scope = accountBrowser.preferenceScope();
    if (!scope || scope.accountId !== accountBrowser.selectedAccount?.id)
      throw new Error('This Paid TV account is no longer selected.');
    await selectAccountPlayback(
      {
        id: row.id,
        name: row.name,
        category: row.category,
        providerId: row.providerId,
        epgId: row.epgId,
        streamReference: row.streamReference,
      },
      {
        accountId: scope.accountId,
        accountRevision: scope.accountRevision,
        mediaRevision: scope.mediaRevision,
      },
    );
  },
  close: () => playbackAction(switchPrimaryPage('watch')),
  now: () => guideHost.now(),
  formatTime: (ms) => guideHost.formatTime(ms),
});
const guide = mountGuide(primaryHost, {
  ...guideHost,
  logos: guideChannelLogos,
  presentation: 'page',
  opened: async () => {
    presentPrimaryPage('guide');
    // The remote starts inside the guide: opened with OK, it had no focus at
    // all on the Streamer (October 19, 2026), so nothing showed where to go.
    requestAnimationFrame(() => {
      const page = primaryHost.querySelector<HTMLElement>('dialog[open]');
      const active = document.activeElement;
      if (!page || (active && active !== document.body && page.contains(active))) return;
      const entry = [
        ...page.querySelectorAll<HTMLElement>(
          '.gx-timeline-channel, .gx-agenda-channel, .gx-timeline-toolbar button',
        ),
      ].find((control) => control.getClientRects().length && !control.closest('[hidden],[inert]'));
      entry?.focus({ preventScroll: true });
    });
  },
  closed: async () => {
    if (primaryPage === 'guide') presentPrimaryPage('watch');
  },
  buildForChannels: (signal) => {
    // Explicit Find retries discovery; automatic requests keep the retry cooldown.
    if (automaticGuideDiscovery?.result.outcomes.some((outcome) => outcome.status === 'failed'))
      automaticGuideDiscovery = null;
    // The build belongs to the background guide owner. Leaving the Guide page stops
    // waiting for it; it neither cancels the build nor waits for it to settle.
    const build = automaticGuides.run();
    return new Promise<Awaited<typeof build>>((resolve, reject) => {
      const leave = () => reject(new DOMException('Guide page closed.', 'AbortError'));
      if (signal.aborted) return leave();
      signal.addEventListener('abort', leave, { once: true });
      build.then(resolve, reject).finally(() => signal.removeEventListener('abort', leave));
    });
  },
});
function recordArchiveRevision(revision: string): void {
  if (
    archiveRuntimeScope() !== null &&
    (archiveIndexRevision === null || BigInt(revision) >= BigInt(archiveIndexRevision))
  )
    archiveIndexRevision = revision;
}
function renderArchiveDiscovery(snapshot: Readonly<ArchiveDiscoverySnapshot>): void {
  const status = element('genxtra-discovery-progress');
  const presentation = archiveDiscoveryStatus(snapshot, { nowEpochMs: Date.now() });
  status.hidden =
    contentLibrary !== 'genxtra' ||
    snapshot.query !== element<HTMLInputElement>('search').value.trim() ||
    snapshot.decade !== archiveDecade ||
    presentation.hidden;
  status.textContent = status.hidden ? '' : presentation.text;
  // Full counters remain optional metadata, rather than a second visible status block.
  status.dataset.discoveryDetails = status.hidden ? '' : presentation.details;
  if (!status.hidden) archiveSearch?.searchProgress(snapshot.query, snapshot.examined);
}
const publicProviderDiagnosticStates = new Map<string, string>();
const archiveDiscovery = createArchiveDiscovery({
  catalog: archiveCatalog,
  readyScope: archiveRuntimeScope,
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
        void diagnostics.emit({
          operation: 'application',
          level: 'warning',
          code: 'application-archive-commons-identification-required',
        });
      else if (provider.state === 'failed' || provider.state === 'waiting')
        void diagnostics.emit({
          operation: 'application',
          level: 'warning',
          code: unavailableCodes[provider.providerId],
        });
    }
  },
});
archiveSearch = mountArchiveSearch(element('genxtra-library'), {
  downloads: archiveDownloads,
  seriesLookup: lookupSeriesIdentity,
  onPlaySaved: async (entry, revision, signal) => {
    clearArchiveResume();
    await archivePlayer!.selectSaved(entry, revision, signal);
  },
  detailsContainer: element('archive-details'),
  playbackActive: () =>
    player.snapshot.selection !== null &&
    player.snapshot.state !== 'idle' &&
    player.snapshot.state !== 'disposed',
  onTitleSelected: () => {
    if (element('app').classList.contains('compact-content')) {
      element<HTMLSelectElement>('compact-view').value = 'watch';
      element('compact-view').dispatchEvent(new Event('change'));
    }
  },
  managementContainer:
    document.querySelector<HTMLElement>('[data-settings-panel="sources"]') ?? undefined,
  onRemove: async (target, expectedRevision, signal) => {
    const scope = archiveRuntimeScope();
    const check = () => {
      signal.throwIfAborted();
      if (scope === null || archiveRuntimeScope() !== scope)
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
    const selected = archivePlayer!.selection;
    if (selected && matches(selected)) await archivePlayer!.stop();
    if (archiveResumeChoice && matches(archiveResumeChoice)) clearArchiveResume();
    check();
    const receipt = await archiveCatalog.remove(
      target,
      { schemaVersion: 1, expectedRevision, explicitAction: true },
      signal,
    );
    // COMMIT truth survives a late abort, but never crosses a replaced storage root.
    if (archiveRuntimeScope() === scope) recordArchiveRevision(receipt.revision);
    return receipt;
  },
  input: element<HTMLInputElement>('search'),
  catalog: archiveCatalog,
  readyScope: archiveActiveScope,
  queryOptions: () => ({
    decade: archiveDecade,
    favoritesOnly: archiveFavoritesOnly,
    contentType: archiveContentType,
  }),
  clearFilters: () =>
    playbackAction(
      changeArchiveFilter(() => {
        archiveDecade = null;
        archiveContentType = 'all';
        libraryQueries.genxtra = '';
        element<HTMLInputElement>('search').value = '';
        element('clear-search').hidden = true;
      }),
    ),
  artwork: (request, signal) => archiveCatalog.artwork(request, signal),
  pendingFiles: (expectedRevision, offset, query, signal, languageMode, contentType) =>
    archiveCatalog.itemFilesProgress(
      {
        schemaVersion: 1,
        expectedRevision,
        offset,
        pageSize: 5,
        query,
        decade: archiveDecade,
        favoritesOnly: archiveFavoritesOnly,
        languageMode,
        contentType: contentType ?? archiveContentType,
      },
      signal,
    ),
  loadFiles: async (progress, expectedRevision, signal) => {
    const receipt = await archiveCatalog.itemFilesStep(
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
    clearArchiveResume();
    try {
      await archivePlayer!.select(selection, signal);
    } catch (error) {
      if (error instanceof ArchiveFileRemovedError) {
        recordArchiveRevision(error.receipt.revision);
        throw new Error('This file was confirmed unavailable and removed from playable results.', {
          cause: error,
        });
      }
      throw error;
    }
  },
  onFavorite: async (title, expectedRevision, value, signal) => {
    const receipt = await archiveCatalog.setFavorite(
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
      archiveDecade,
      view,
    );
    recordArchiveRevision(result.revision);
    return result;
  },
});
Object.defineProperty(window, '__GENX_ARCHIVE_ARTWORK__', {
  get: () => archiveSearch?.artworkSnapshot() ?? null,
});
function presentLibrary(): void {
  const extra = contentLibrary === 'genxtra';
  element('app').dataset.contentLibrary = contentLibrary;
  vodDock.render(
    player.snapshot.selection ? player.snapshot.selection.playMode === 'on-demand' : extra,
  );
  element('genxtra-library').hidden = !extra;
  archiveSearch?.syncDetails();
  if (!extra) element('archive-details').hidden = true;
  element('genxtra-browse-filters').hidden = !extra;
  element('genxtra-filter-status').hidden = !extra;
  element('genxtra-discovery-progress').hidden =
    !extra || archiveDiscovery.snapshot.state === 'idle';
  const liveFilters = element('channel-list').parentElement?.querySelector<HTMLElement>(
    '.browse-options .filters',
  );
  if (liveFilters) {
    // The category list (category-menu.ts) owns hidden on TV and Windows.
    liveFilters.dataset.libraryHidden = String(extra);
    if (categoryMenu) categoryMenu.sync();
    else liveFilters.hidden = extra;
  }
  element('search').setAttribute(
    'aria-label',
    extra ? 'Search saved GenXtra shows and movies' : 'Search channels and programs',
  );
  element('search-programs').title = extra
    ? 'Search shows and movies online'
    : 'Find channels online';
  element<HTMLInputElement>('search').placeholder = extra
    ? 'Search shows and movies'
    : 'Search channels or programs';
  element('search-programs').setAttribute(
    'aria-label',
    extra ? 'Search GenXtra online' : 'Find channels online',
  );
  element('genxtra-filter-status').textContent =
    `${archiveDecade === 2020 ? '20s+' : archiveDecade ? `${String(archiveDecade).slice(2)}s` : 'All years'}${archiveFavoritesOnly ? ' · Favorites' : ''} · Source-listed years`;
  element<HTMLSelectElement>('genxtra-kind-select').value = archiveFavoritesOnly
    ? 'favorites'
    : archiveContentType;
  element<HTMLSelectElement>('genxtra-decade-select').value =
    archiveDecade === null ? 'all' : String(archiveDecade);
  televisionSelects?.refresh();
  presentPrimaryPage(primaryPage);
  if (player.snapshot.state === 'idle' && !player.snapshot.selection && !archiveBackgroundPaused) {
    element('overlay-title').textContent = extra
      ? 'Your next favorite show.'
      : 'Your next favorite channel.';
    element('overlay-message').textContent = extra
      ? 'Browse a decade, or search for shows and movies.'
      : 'Choose a channel, or use channel search to discover more.';
  }
  renderArchiveDiscovery(archiveDiscovery.snapshot);
}
async function joinLiveBrowse(): Promise<void> {
  for (const owner of liveBrowseJobs.keys()) owner.abort();
  const results = await Promise.allSettled([...liveBrowseJobs.values(), channelLogos?.suspend()]);
  if (
    results.some(
      (result) =>
        result.status === 'rejected' &&
        !(result.reason instanceof DOMException && result.reason.name === 'AbortError'),
    )
  )
    throw new Error('Channel browsing cleanup could not be confirmed.');
}
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
type LibraryOperationName = (typeof libraryOperationNames)[number];
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
      libraryTransitionRevision = Math.min(Number.MAX_SAFE_INTEGER, libraryTransitionRevision + 1);
    });
}
Object.defineProperty(window, '__GENX_LIBRARY_TRANSITION__', {
  configurable: false,
  get: () =>
    Object.freeze({
      schemaVersion: 1,
      generation: libraryIntent,
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
  if (intent !== libraryIntent || applicationClosing) return;
  contentLibrary = previous;
  const active =
    element('app').dataset.ready === 'true' &&
    !document.hidden &&
    nativeViewingForeground &&
    !backgroundSuspension;
  liveBrowseSuspended = previous !== 'live' || !active;
  document.querySelector<HTMLElement>('.browser')!.inert = !active;
  presentPrimaryPage('watch');
  element<HTMLInputElement>('search').value = libraryQueries[previous];
  element('clear-search').hidden = !libraryQueries[previous];
  presentLibrary();
  if (!active) return;
  if (previous === 'live') {
    renderCatalog();
    browser.search(libraryQueries.live);
    element('channel-list').scrollTop = liveLibraryScroll;
  } else
    await trackLibraryOperation('archive-read', () =>
      archiveSearch!.resume(libraryQueries.genxtra),
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
  const epoch = archiveStorageEpoch;
  libraryPersistenceUnsaved = true;
  let admitted = false;
  const work = preferences
    .update(
      (draft) => {
        draft.contentLibrary = next;
      },
      async () => {
        if (choice !== libraryPersistenceChoice || epoch !== archiveStorageEpoch || transferBusy)
          return false;
        admitted = true;
        libraryPersistenceActive++;
        return true;
      },
    )
    .then((saved) => {
      // A late COMMIT is durable truth. Updating metadata must never re-present
      // an obsolete pane or run applySettings behind a newer user selection.
      if (epoch === archiveStorageEpoch) settings = saved;
      if (choice === libraryPersistenceChoice && epoch === archiveStorageEpoch)
        libraryPersistenceUnsaved = false;
    })
    .catch((error: unknown) => {
      if (
        error instanceof DOMException &&
        error.name === 'AbortError' &&
        (choice !== libraryPersistenceChoice || epoch !== archiveStorageEpoch)
      )
        return;
      libraryPersistenceErrors = Math.min(Number.MAX_SAFE_INTEGER, libraryPersistenceErrors + 1);
      void diagnostics.emit({ operation: 'storage', level: 'error', code: 'storage-failed' });
      if (
        choice === libraryPersistenceChoice &&
        epoch === archiveStorageEpoch &&
        !applicationClosing
      )
        notice(
          'Your library choice wasn’t saved. Both tabs remain available; switch tabs to retry saving.',
        );
    })
    .finally(() => {
      if (admitted) libraryPersistenceActive--;
      libraryPersistenceJobs.delete(work);
      libraryTransitionRevision = Math.min(Number.MAX_SAFE_INTEGER, libraryTransitionRevision + 1);
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
    next === contentLibrary &&
    primaryPage === 'watch' &&
    !libraryTransitionActive &&
    libraryTransitionPending === 0 &&
    !applicationClosing &&
    element('app').dataset.ready === 'true' &&
    !element('app').inert &&
    !document.querySelector<HTMLElement>('.browser')!.inert
  )
    return Promise.resolve();
  const opener = document.activeElement,
    intent = ++libraryIntent;
  liveBrowseSuspended = true;
  document.querySelector<HTMLElement>('.browser')!.inert = true;
  primaryIntent++;
  libraryTransitionPending++;
  if (!libraryTransitionActive) observeLibrary('queued');
  const work = primaryTransitions.then(async () => {
    libraryTransitionActive = intent;
    libraryFailedDrains.clear();
    const previous = contentLibrary;
    try {
      if (applicationClosing || element('app').dataset.ready !== 'true') {
        observeLibrary('refused');
        await restoreLibraryPane(previous, intent);
        return;
      }
      libraryQueries[previous] = element<HTMLInputElement>('search').value;
      if (previous === 'live') liveLibraryScroll = element('channel-list').scrollTop;
      observeLibrary('draining');
      // Every admitted drain settles before refusal/failure can restore a pane.
      const drains = await Promise.allSettled([
        trackLibraryOperation('guide', () => guide.close()),
        trackLibraryOperation('archive-search', () =>
          archiveSearch!.suspend({ preserveSelection: true }),
        ),
        trackLibraryOperation('archive-discovery', () => archiveDiscovery.suspend()),
        // Channel discovery and scans are background work: they keep running across
        // page switches (they never use the player) and pause only when the app does.
        trackLibraryOperation('live-browse', () => joinLiveBrowse()),
      ]);
      if (drains.some((result) => result.status === 'rejected'))
        throw new Error('Library cleanup failed.');
      if (
        intent !== libraryIntent ||
        applicationClosing ||
        document.hidden ||
        !nativeViewingForeground
      ) {
        observeLibrary('refused');
        await restoreLibraryPane(previous, intent);
        return;
      }
      observeLibrary('opening');
      contentLibrary = next;
      liveBrowseSuspended = next !== 'live';
      document.querySelector<HTMLElement>('.browser')!.inert = false;
      presentPrimaryPage('watch');
      element<HTMLInputElement>('search').value = libraryQueries[next];
      element('clear-search').hidden = !libraryQueries[next];
      presentLibrary();
      if (next === 'genxtra')
        await trackLibraryOperation('archive-read', () =>
          archiveSearch!.resume(libraryQueries.genxtra),
        );
      else {
        renderCatalog();
        browser.search(libraryQueries.live);
        element('channel-list').scrollTop = liveLibraryScroll;
        await trackLibraryOperation('source-resume', () => sourceScan.resume());
      }
      if (intent !== libraryIntent || applicationClosing) {
        observeLibrary('refused');
        await restoreLibraryPane(previous, intent);
        return;
      }
      if (persist) persistLibraryChoice(next);
      if (focus && document.activeElement === opener)
        element(next === 'genxtra' ? 'genxtra-button' : 'live-tv-button').focus({
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
  primaryTransitions = work.catch(() => undefined);
  return work;
}

async function changeArchiveFilter(change: () => void): Promise<void> {
  if (contentLibrary !== 'genxtra' || applicationClosing) return;
  change();
  archiveFilterGeneration++;
  await archiveDiscovery.suspend();
  if (contentLibrary !== 'genxtra' || applicationClosing) return;
  presentLibrary();
  await archiveSearch!.query(libraryQueries.genxtra);
}
element('genxtra-decade-select').addEventListener('change', () =>
  playbackAction(
    changeArchiveFilter(() => {
      const value = element<HTMLSelectElement>('genxtra-decade-select').value;
      archiveDecade = value === 'all' ? null : (Number(value) as ArchiveDecade);
    }),
  ),
);
element('genxtra-kind-select').addEventListener('change', () =>
  playbackAction(
    changeArchiveFilter(() => {
      const value = element<HTMLSelectElement>('genxtra-kind-select').value;
      archiveFavoritesOnly = value === 'favorites';
      archiveContentType = archiveFavoritesOnly ? 'all' : (value as ArchiveContentType | 'all');
    }),
  ),
);
async function selectAccountPlayback(
  channel: Parameters<NonNullable<typeof accountPlayer>['selectAccount']>[0],
  fence: Parameters<NonNullable<typeof accountPlayer>['selectAccount']>[1],
): Promise<void> {
  startTiming.begin('account');
  admitForegroundPlayback();
  backgroundLiveChoice = null;
  pendingPublicPlayback = null;
  clearArchiveResume();
  const pending = {
    choice: { channel: { ...channel }, fence: { ...fence } },
    sharingGeneration: sharingBridge.host.snapshot().generation,
  };
  pendingAccountPlayback = pending;
  try {
    await archivePlayer!.handoff(async (signal) => {
      await sharingBridge.stop();
      if (pendingAccountPlayback === pending)
        pending.sharingGeneration = sharingBridge.host.snapshot().generation;
      signal.throwIfAborted();
      admitForegroundPlayback();
      await accountPlayer!.selectAccount(channel, fence, signal);
    });
  } finally {
    if (pendingAccountPlayback === pending) pendingAccountPlayback = null;
  }
}
async function playAccountVod(
  title: Parameters<NonNullable<typeof accountPlayer>['selectVod']>[0],
  account: Parameters<NonNullable<typeof accountPlayer>['selectVod']>[1],
): Promise<void> {
  admitForegroundPlayback();
  backgroundLiveChoice = pendingPublicPlayback = null;
  clearArchiveResume();
  await archivePlayer!.handoff(async (signal) => {
    await sharingBridge.stop();
    signal.throwIfAborted();
    admitForegroundPlayback();
    await accountPlayer!.selectVod(title, account, signal);
  });
}

element('advanced-guide-button').addEventListener('click', () => {
  element<HTMLDialogElement>('settings-dialog').close();
  playbackAction(guide.openAdvanced());
  televisionSelects?.refresh();
});
let nativeViewingForeground = true;
Object.defineProperty(window, '__GENX_PRIMARY_TRANSITION__', {
  enumerable: false,
  configurable: false,
  get: () =>
    Object.freeze({
      schemaVersion: 1,
      revision: primaryTransitionRevision,
      stage: primaryTransitionStage,
      reason: primaryTransitionReason,
      activeIntent: primaryTransitionActiveIntent,
      requestedIntent: primaryTransitionRequestedIntent,
      pending: primaryTransitionPending > 0,
      queued: primaryTransitionPending > (primaryTransitionActiveIntent ? 1 : 0),
      errorCount: primaryTransitionErrorCount,
      nativeForeground: nativeViewingForeground,
      documentHidden: document.hidden,
      closing: applicationClosing,
    }),
});
function updateGuideForeground(): void {
  const foreground = nativeViewingForeground && !document.hidden && !applicationClosing;
  browser.setGuideForeground(foreground);
  void guide.setForeground(foreground).catch(() => undefined);
  void visibleGuide?.setForeground(foreground).catch(() => undefined);
}
visibleGuide = createVisibleGuideOwner({
  fetch: readVisibleGuide,
  cancel: (requestId) => invoke('cancel_playlist', { requestId }),
  available: () => isTauri() && element('app').dataset.ready === 'true' && !applicationClosing,
  isCurrent: (scope) =>
    scope.generation === visibleGuideGeneration &&
    scope.catalogRevision === persistedCatalogRevision &&
    !applicationClosing &&
    element('app').dataset.ready === 'true',
});
visibleGuide.subscribe((snapshot) => {
  if (snapshot.status === 'idle') {
    browser.setGuideRows([]);
    return;
  }
  const summary = snapshot.summary;
  const status = snapshot.status;
  browser.setGuideRows(
    visibleGuideRequestedRows.map((row, index) => ({
      ...row,
      status,
      summary: summary?.rows[index] ?? null,
    })),
  );
});
function updateVisibleGuide(): void {
  if (!visibleGuide) return;
  const ready =
    element('app').dataset.ready === 'true' &&
    !applicationClosing &&
    element('channel-list').getClientRects().length > 0;
  if (visibleGuideCatalog !== catalog || visibleGuideRemoved !== settings.removedChannels) {
    visibleGuideCatalog = catalog;
    visibleGuideRemoved = settings.removedChannels;
    const removed = new Set(settings.removedChannels);
    visibleGuideIdentities = new Set(
      catalog.channels
        .filter((channel) => !removed.has(channel.id))
        .map((channel) => JSON.stringify([channel.sourceId, channel.id])),
    );
  }
  const rows = ready
    ? visibleGuideRows.filter((row) =>
        visibleGuideIdentities.has(JSON.stringify([row.catalogSourceId, row.appChannelId])),
      )
    : [];
  const key = rows.length ? JSON.stringify([persistedCatalogRevision, rows]) : null;
  if (key === visibleGuideKey) return;
  visibleGuideKey = key;
  visibleGuideGeneration++;
  visibleGuideRequestedRows = rows;
  const scope: VisibleGuideScope | null =
    rows.length > 0 && rows.length <= 64
      ? {
          channels: rows,
          catalogRevision: persistedCatalogRevision,
          generation: visibleGuideGeneration,
        }
      : null;
  void visibleGuide.setScope(scope).catch(() => undefined);
  if (rows.length > 64)
    browser.setGuideRows(rows.map((row) => ({ ...row, status: 'capacity', summary: null })));
}
updateGuideForeground();
updateVisibleGuide();
// The Guide covers the library its row belongs to: Free TV's guide page, or
// the Paid TV account's own provider guide (never the Free TV listings).
// It always opens on the grid (owner request, October 19, 2026): text left in
// the channel search used to open Program search instead. The guide's own
// search box finds programmes.
element('guide-button').addEventListener('click', () => playbackAction(switchPrimaryPage('guide')));
element('search').addEventListener(
  'keydown',
  (event) => {
    if (
      event.key === 'Enter' &&
      (contentLibrary === 'genxtra' || !liveBrowseSuspended) &&
      element<HTMLInputElement>('search').value.trim()
    ) {
      event.preventDefault();
      if (contentLibrary === 'genxtra') {
        playbackAction(archiveSearch!.searchOnline());
        return;
      }
      browser.search(element<HTMLInputElement>('search').value);
      element<HTMLInputElement>('search').blur();
      element('channel-list').focus({ preventScroll: true });
    }
  },
  { capture: true },
);
function genxtraNavigation(event: KeyboardEvent): void {
  if (
    contentLibrary !== 'genxtra' ||
    event.defaultPrevented ||
    primaryPage !== 'watch' ||
    document.querySelector('dialog[open]') ||
    fullscreenOwner.active
  )
    return;
  const focused = document.activeElement;
  if (!(focused instanceof HTMLElement)) return;
  if (focused.id === 'search' && remoteEditMode.isEditing(focused)) return;
  const firstFile =
    [
      ...element('genxtra-library').querySelectorAll<HTMLElement>(
        '.gx-archive-filter-toggle, .gx-archive-title-button',
      ),
    ].find(
      (control) =>
        !control.matches(':disabled') &&
        !control.closest('[hidden],[inert]') &&
        control.getClientRects().length > 0,
    ) ?? null;
  const firstDetail =
    [
      ...element('archive-details').querySelectorAll<HTMLElement>('button:not(:disabled), summary'),
    ].find((control) => control.checkVisibility() && !control.closest('[hidden],[inert]')) ?? null;
  const selectedResult = element('genxtra-library').querySelector<HTMLButtonElement>(
    '.gx-archive-title-button[aria-current="true"]',
  );
  const filterControl = (id: string): HTMLElement =>
    element('genxtra-browse-filters').querySelector<HTMLElement>(
      `.in-app-select[data-native-select-id="${id}"] > button`,
    ) ?? element(id);
  const firstKind = filterControl('genxtra-kind-select');
  const firstFilter = filterControl('genxtra-decade-select');
  // TV seek and playback buttons share one visual row. Pause is not its left
  // boundary while an earlier seek action is visible and enabled.
  const dockSelector =
    element('app').dataset.deviceKind === 'tv'
      ? '#vod-transport button,.controls button'
      : '.controls button';
  const dock = [...document.querySelectorAll<HTMLButtonElement>(dockSelector)].find(
    (button) => !button.disabled && button.checkVisibility() && !button.closest('[hidden],[inert]'),
  );
  const searchRow = focused.closest('.search-controls');
  const lastSearchAction = searchRow
    ? [...searchRow.querySelectorAll<HTMLElement>('button,input')]
        .filter(
          (control) =>
            !control.matches(':disabled,[aria-disabled="true"]') &&
            control.checkVisibility({ visibilityProperty: true }) &&
            !control.closest('[hidden],[inert]'),
        )
        .at(-1)
    : null;
  let target: HTMLElement | null = null;
  if (focused.id === 'genxtra-button' && event.key === 'ArrowDown') target = element('search');
  else if (focused.id === 'search' && event.key === 'ArrowDown') target = firstKind ?? firstFilter;
  // Shared search-row navigation owns the field, Clear and microphone. Only
  // the row's right edge leaves for the dock; capture must not skip its actions.
  else if (focused === lastSearchAction && event.key === 'ArrowRight') target = dock ?? null;
  else if (focused.closest('#genxtra-browse-filters') && event.key === 'ArrowDown')
    target = firstFile ?? dock ?? null;
  else if (focused.closest('#genxtra-browse-filters') && event.key === 'ArrowUp')
    target = element('search');
  else if (
    focused.closest('#genxtra-browse-filters') &&
    event.key === 'ArrowLeft' &&
    focused !== firstKind
  )
    target = firstKind;
  else if (
    focused.closest('#genxtra-browse-filters') &&
    event.key === 'ArrowRight' &&
    focused !== firstFilter
  )
    target = firstFilter;
  else if (focused.matches('.gx-archive-favorite') && event.key === 'ArrowRight')
    target = firstDetail ?? dock ?? null;
  else if (focused.closest('#archive-details') && event.key === 'ArrowLeft')
    target = selectedResult ?? firstFile;
  else if (focused === dock && event.key === 'ArrowLeft')
    target = selectedResult ?? firstFile ?? firstFilter;
  else if (focused.closest('.controls') && event.key === 'ArrowUp')
    target = element('genxtra-button');
  if (target && target.getClientRects().length && !target.closest('[hidden],[inert]')) {
    event.preventDefault();
    event.stopPropagation();
    if (target.id === 'search') remoteEditMode.navigate(target);
    target.focus({ preventScroll: true });
  }
}
document.addEventListener('keydown', genxtraNavigation, true);
const removeMediaKeys = installMediaKeys({
  togglePause: () => {
    if (liveReplay?.active()) return liveReplay.togglePause();
    if (player.snapshot.state === 'paused' || archiveBackgroundPaused || backgroundLiveChoice)
      return resumeLocalPlayback();
    playbackAction(pauseLocalPlayback());
  },
  play: () => {
    if (liveReplay?.active()) return liveReplay.setPaused(false);
    if (player.snapshot.state === 'paused' || archiveBackgroundPaused || backgroundLiveChoice)
      return resumeLocalPlayback();
    if (player.snapshot.selection && ['failed', 'idle'].includes(player.snapshot.state))
      return retryLocalPlayback();
  },
  pause: () => {
    if (liveReplay?.active()) return liveReplay.setPaused(true);
    playbackAction(pauseLocalPlayback());
  },
  stop: () => stopLocalPlayback(),
  mute: async () => {
    await changeSound({ muted: !soundNow().muted });
  },
  volume: async (direction) => {
    await changeSound({
      volume: Math.max(0, Math.min(1, soundNow().volume + direction * 0.05)),
    });
  },
  channel: (direction) => {
    if (contentLibrary === 'live') browser.selectAdjacent(direction);
  },
  back: () => handleBack(),
  // On-demand videos go back 10 s; live channels start an instant replay.
  rewind: () => {
    if (player.snapshot.selection?.playMode === 'on-demand') return vodRewind();
    if (liveReplay) playbackAction(liveReplay.rewind());
  },
  failed: () => notice('The remote command could not finish. Try the on-screen control.'),
});
async function pauseLocalPlayback(): Promise<void> {
  if (backgroundLiveChoice) return;
  if (archivePlayer?.selection) await player.pause();
  else await sharingBridge.pause();
}
/** A Paid TV movie or episode is the current selection (it has a Stop button). */
const accountVodSelected = () => !!player.snapshot.selection?.id.startsWith('vod:');
async function stopLocalPlayback(): Promise<void> {
  backgroundLiveChoice = null;
  if (archivePlayer?.selection || archiveResumeChoice) {
    clearArchiveResume();
    await archivePlayer!.stop();
  } else if (accountVodSelected()) {
    // Stop a Paid TV movie and return to the titles, on the same poster.
    await accountPlayer!.stop();
    libraries?.showVodTitles();
  } else await sharingBridge.stop();
}
async function resumeLocalPlayback(): Promise<void> {
  if (backgroundSuspension) await backgroundSuspension;
  admitForegroundPlayback();
  if (backgroundLiveChoice) {
    const choice = backgroundLiveChoice;
    backgroundLiveChoice = null;
    if (choice.kind === 'account')
      await selectAccountPlayback(choice.choice.channel, choice.choice.fence);
    else await sharingBridge.select(choice.selection);
    return;
  }
  if (archivePlayer?.selection) {
    await player.resume();
    return;
  }
  if (archiveResumeChoice) {
    const choice = archiveResumeChoice;
    clearArchiveResume();
    await archivePlayer!.select(choice);
    return;
  }
  const account = accountPlayer?.selection;
  if (account) {
    // A paused local capability can expire. User Resume starts a fresh live
    // session through the same decoder owner instead of replaying a dead URL.
    await selectAccountPlayback(account.channel, account.fence);
  } else await sharingBridge.resume();
}
async function retryLocalPlayback(): Promise<void> {
  if (backgroundLiveChoice) return resumeLocalPlayback();
  const archived = archivePlayer?.selection ?? archiveResumeChoice;
  if (archived) {
    clearArchiveResume();
    await archivePlayer!.select(archived);
    return;
  }
  const account = accountPlayer?.selection;
  if (account) await selectAccountPlayback(account.channel, account.fence);
  else if (player.snapshot.selection) await sharingBridge.select(player.snapshot.selection);
}
function notice(message: string): void {
  clearTimeout(noticeTimer);
  element('notice').textContent = message;
  element('notice').hidden = false;
  noticeTimer = setTimeout(() => {
    element('notice').hidden = true;
  }, 6000);
}
// External errors never include provider URLs or raw native payloads in exported diagnostics.
function friendlyError(error: unknown): string {
  if (error instanceof Error && !/https?:\/\//i.test(error.message)) return error.message;
  return 'The operation could not finish. Check the source, connection, or available storage.';
}
function renderCatalog(): void {
  updateVisibleGuide();
  guide.catalogChanged();
  const removed = new Set(settings.removedChannels);
  const category = createChannelCategoryResolver(settings);
  if (contentLibrary === 'live')
    browser.update(
      catalog.channels
        .filter((channel) => !removed.has(channel.id))
        .map((channel) =>
          category(channel) === channel.category
            ? channel
            : { ...channel, category: category(channel) },
        ),
      settings.favorites,
      player.snapshot.selection?.id ?? null,
      catalog.sources.length === 0
        ? 'no-sources'
        : catalog.channels.length === 0
          ? 'empty-sources'
          : 'removed-channels',
    );
  geographyControls.update();
  presentNotResponding();
  element<HTMLButtonElement>('refresh-button').disabled =
    importRunning || !catalog.sources.some((source) => source.kind === 'url');
  element('source-status').textContent =
    `${catalog.sources.length} ${catalog.sources.length === 1 ? 'playlist' : 'playlists'} saved`;
  element<HTMLButtonElement>('restore-channels').disabled = accountBrowser.selectedAccount
    ? !accountBrowser.preferenceScope()
    : settings.removedChannels.length === 0;
  const sourceList = element('source-list');
  const sourceButtons = [...sourceList.querySelectorAll<HTMLButtonElement>('button')];
  const sourceFocusIndex = sourceButtons.findIndex((button) => button === document.activeElement);
  const rows = document.createDocumentFragment();
  for (const source of catalog.sources) {
    const row = document.createElement('div');
    row.className = 'source-row';
    const name = document.createElement('span');
    name.textContent = source.name;
    const remove = document.createElement('button');
    remove.textContent = 'Remove';
    remove.setAttribute('aria-label', `Remove source ${source.name}`);
    remove.disabled = importRunning;
    remove.addEventListener('click', () => {
      void removeSource(source.id);
    });
    row.append(name, remove);
    rows.append(row);
  }
  sourceList.replaceChildren(rows);
  if (sourceFocusIndex >= 0) {
    const nextButtons = [...sourceList.querySelectorAll<HTMLButtonElement>('button')];
    restoreRemoteFocus(
      nextButtons[Math.min(sourceFocusIndex, nextButtons.length - 1)] ?? null,
      element('settings-dialog').querySelector<HTMLElement>('[data-close]'),
    );
  }
}
async function removeSource(id: string): Promise<void> {
  if (importRunning || transferBusy || addChannelsEntryWork || playlistExportWork) {
    notice('Finish or cancel the import before removing a source.');
    return;
  }
  const removedIds = new Set(
    catalog.channels.filter((channel) => channel.sourceId === id).map((channel) => channel.id),
  );
  const source = catalog.sources.find((entry) => entry.id === id);
  if (!source || applicationClosing) return;
  transferBusy = true;
  setImportBusy(true);
  try {
    const work = catalogWrites.then(async () => {
      const next = {
        ...catalog,
        sources: catalog.sources.filter((entry) => entry.id !== id),
        channels: catalog.channels.filter((channel) => channel.sourceId !== id),
      };
      const nextPreferences = await preferences.settledSnapshot();
      nextPreferences.sources = [...next.sources];
      if (source.kind === 'url') {
        const location = new URL(source.location).href;
        nextPreferences.reviewedChannelProviders = (
          nextPreferences.reviewedChannelProviders ?? []
        ).filter((provider) => new URL(provider.location).href !== location);
      }
      settings = await preferences.replaceAtomically(nextPreferences, async () => {
        const receipt = await writeRecordPair({
          catalog: serializeCatalog(next),
          preferences: exportPreferences(nextPreferences),
          expectedCatalogRevision: persistedCatalogRevision,
        });
        persistedCatalogRevision = receipt.catalogRevision;
      });
      catalog = next;
      catalogRevision++;
    });
    catalogWrites = work.catch(() => undefined);
    await work;
    if (removedIds.has(player.snapshot.selection?.id ?? '')) await sharingBridge.stop();
    if (!applicationClosing) {
      applySettings();
      notice(
        'Source removed from saved channels and discovery. Other sources and favorites are preserved.',
      );
    }
  } catch (error) {
    notice(friendlyError(error));
  } finally {
    transferBusy = false;
    if (!applicationClosing) setImportBusy(false);
  }
}
function applySettings(): void {
  automaticGuideUpdates.update(settings.automaticGuideUpdates);
  providerManagement.update();
  element<HTMLInputElement>('voice-search-consent').checked = settings.voiceSearchConsent === true;
  regionPreference.update();
  if (document.activeElement !== element('provider-configuration'))
    element<HTMLTextAreaElement>('provider-configuration').value = serializeProviderRegistry({
      schemaVersion: 1,
      reviewedChannelProviders: settings.reviewedChannelProviders ?? [],
      reviewedGuideProviders: settings.reviewedGuideProviders ?? [],
    });
  element<HTMLSelectElement>('daily-source-refresh').value = migrateRefreshCadence(
    settings.sourceRefreshCadence,
    settings.automaticSourceRefresh,
  );
  document.documentElement.style.setProperty('--sidebar', `${settings.panelWidth}px`);
  presentSound();
  element('divider').setAttribute('aria-valuenow', String(settings.panelWidth));
  renderCatalog();
  renderPlayer(player.snapshot);
  sharingBridge.notifySettings();
  televisionSelects?.refresh();
}
element('voice-search-consent').addEventListener('change', () => {
  const accepted = element<HTMLInputElement>('voice-search-consent').checked;
  const canceled = accepted ? Promise.resolve() : speechSearch.revokeConsent();
  void (async () => {
    await saveSettings((draft) => {
      draft.voiceSearchConsent = accepted;
    });
    await canceled;
  })().catch(() => notice('Voice search could not finish closing. Try again.'));
});
/**
 * Sound changes are heard at once; saving them follows. Waiting for the save
 * delayed Mute by 4.4 s on the Galaxy S25 (owner report, October 19, 2026).
 * Only the newest change of each kind clears its pending value, so quick
 * repeated presses never flicker; a refused or failed save restores the saved
 * sound.
 */
let pendingSound: { muted?: boolean; volume?: number } = {};
function soundNow(): { muted: boolean; volume: number } {
  return {
    muted: pendingSound.muted ?? settings.muted,
    volume: pendingSound.volume ?? settings.volume,
  };
}
function presentSound(): void {
  const { muted, volume } = soundNow();
  player.setMuted(muted);
  player.setVolume(volume);
  element<HTMLInputElement>('volume').value = String(volume);
  element('mute-button').textContent = muted ? 'Unmute' : 'Mute';
  element('mute-button').setAttribute('aria-pressed', String(muted));
}
async function changeSound(change: { muted?: boolean; volume?: number }): Promise<boolean> {
  pendingSound = { ...pendingSound, ...change };
  presentSound();
  const saved = await saveSettings(
    (draft) => {
      if (change.muted !== undefined) draft.muted = change.muted;
      if (change.volume !== undefined) draft.volume = change.volume;
    },
    undefined,
    true,
  );
  if (!saved) pendingSound = {};
  else {
    if (change.muted !== undefined && pendingSound.muted === change.muted)
      delete pendingSound.muted;
    if (change.volume !== undefined && pendingSound.volume === change.volume)
      delete pendingSound.volume;
  }
  presentSound();
  return saved;
}
async function saveSettings(
  mutate: (draft: Preferences) => void,
  guard?: () => Promise<boolean>,
  allowDuringScan = false,
): Promise<boolean> {
  if (
    (transferBusy && !(allowDuringScan && sourceScan.snapshot().busy)) ||
    element('app').dataset.ready !== 'true'
  )
    return false;
  try {
    const previous = settings;
    settings = await preferences.update(mutate, guard);
    const sameIds = (left: readonly string[], right: readonly string[]) =>
      left.length === right.length && left.every((id, index) => id === right[index]);
    const previousCategories = previous.channelCategoryOverrides ?? [];
    const nextCategories = settings.channelCategoryOverrides ?? [];
    if (
      !sameIds(previous.favorites, settings.favorites) ||
      !sameIds(previous.removedChannels, settings.removedChannels) ||
      previousCategories.length !== nextCategories.length ||
      previousCategories.some(
        (entry, index) =>
          entry.channelId !== nextCategories[index]?.channelId ||
          entry.category !== nextCategories[index]?.category,
      )
    ) {
      catalogBrowseViewRevision++;
      // Saved viewing metadata is independent of the native catalog revision.
      // Invalidate open Guide snapshots only after the preference write acknowledges.
      if (!applicationClosing) guide.catalogChanged(true);
    }
    if (!applicationClosing) applySettings();
    return true;
  } catch (error) {
    void diagnostics.emit({ operation: 'storage', level: 'error', code: 'storage-failed' });
    notice(`Changes weren’t saved. ${friendlyError(error)}`);
    return false;
  }
}
const refresh = new CatalogRefreshService(
  {
    read: async (sourceId) => catalog.channels.filter((channel) => channel.sourceId === sourceId),
    commit: async (sourceId, channels, signal, stagedSource) => {
      const source = activeSources.get(sourceId);
      if (!source || source.id !== sourceId || stagedSource.id !== sourceId)
        throw new Error('Import source changed. Try again.');
      await mutateCatalog((previous) => {
        const currentSource = previous.sources.find((item) => item.id === sourceId);
        const publishedSource = mergeInspectedSource(currentSource, stagedSource);
        return {
          schemaVersion: 1,
          sources: [...previous.sources.filter((item) => item.id !== sourceId), publishedSource],
          channels: [
            ...previous.channels.filter((item) => item.sourceId !== sourceId),
            ...channels,
          ],
        };
      }, signal);
    },
  },
  async (source, signal) => {
    const result = await inspectSource(source.location, source.allowHttp ?? false, signal);
    if (result.kind === 'unsupported')
      throw new Error(
        'This source format is not supported. Choose a channel catalog or supported media source.',
      );
    source.contentKind = result.kind;
    source.mediaMime = result.mime;
    if (result.kind === 'catalog' && result.text !== undefined) return result.text;
    return `#EXTM3U\n#EXTINF:-1 tvg-id="direct" group-title="Custom",${source.name.replace(/[\r\n]/g, ' ')}\n${source.location}\n`;
  },
);
function setImportBusy(busy: boolean): void {
  importRunning = busy;
  for (const id of ['load-button', 'find-sources-button'])
    element<HTMLButtonElement>(id).disabled = busy;
  updateImportActions();
  element<HTMLInputElement>('playlist-file').disabled = busy;
  element('cancel-import').hidden = !busy;
  renderCatalog();
  if (!busy) queueMicrotask(wakeDailyRefresh);
}
function updateImportActions(): void {
  // Reopening the existing scan does not admit another import or writer.
  const disabled = importRunning && !automaticScanActive;
  element<HTMLButtonElement>('import-button').disabled =
    importRunning || transferBusy || automaticScanActive || !!addChannelsEntryWork;
  element<HTMLButtonElement>('export-channels-button').disabled =
    importRunning || transferBusy || automaticScanActive || !!addChannelsEntryWork;
  element<HTMLButtonElement>('automatic-scan-button').disabled = disabled;
  element<HTMLButtonElement>('rescan-automatic-button').disabled = disabled;
}
async function refreshSource(source: Source, text?: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  activeSources.set(source.id, source);
  const cancel = () => refresh.cancel(source.id);
  const work = refresh.refresh(source, text);
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await work;
  } finally {
    signal?.removeEventListener('abort', cancel);
    if (activeSources.get(source.id) === source) activeSources.delete(source.id);
  }
}
const finitePlayback = player;
let vodSeekWork: Promise<void> | null = null;
let vodSeekGeneration = 0;
const vodPositionEvents = [
  'timeupdate',
  'loadedmetadata',
  'seeked',
  'durationchange',
  'emptied',
  'playing',
  'pause',
] as const;
function renderVODTransport(): void {
  vodDock.render(
    player.snapshot.selection
      ? player.snapshot.selection.playMode === 'on-demand'
      : contentLibrary === 'genxtra',
  );
  const active =
    !applicationClosing &&
    !document.hidden &&
    nativeViewingForeground &&
    !!archivePlayer?.selection &&
    player.snapshot.selection?.playMode === 'on-demand' &&
    ['playing', 'paused', 'buffering'].includes(player.snapshot.state);
  // Written only when changed: this runs several times a second while playing.
  const root = element('vod-transport');
  if (root.hidden !== !active) root.hidden = !active;
  const position = active ? (finitePlayback.currentVODposition?.() ?? null) : null;
  const valid =
    position !== null && Number.isFinite(position) && position >= 0 && position <= 604800;
  const shown = element('vod-position');
  const text = valid
    ? `${Math.floor(position / 60)}:${String(Math.floor(position % 60)).padStart(2, '0')}`
    : '—:—';
  if (shown.textContent !== text) shown.textContent = text;
  const label = valid ? 'Current playback position' : 'Playback position unavailable';
  if (shown.getAttribute('aria-label') !== label) shown.setAttribute('aria-label', label);
  const rewind = element<HTMLButtonElement>('vod-rewind');
  const forward = element<HTMLButtonElement>('vod-forward');
  const rewindDisabled = !valid || position <= 0 || !!vodSeekWork;
  const forwardDisabled = !valid || !!vodSeekWork;
  const focused = document.activeElement;
  if (
    active &&
    !backgroundSuspension &&
    primaryPage === 'watch' &&
    !document.querySelector('dialog[open]') &&
    !root.closest('[hidden],[inert]') &&
    root.checkVisibility({ visibilityProperty: true }) &&
    ((focused === rewind && rewindDisabled) || (focused === forward && forwardDisabled))
  ) {
    // Native disabled controls may lose focus before the next key. Keep this
    // handoff local and synchronous; seek completion never restores old focus.
    restoreRemoteFocus(element('pause-button'), element('mute-button'));
  }
  if (rewind.disabled !== rewindDisabled) rewind.disabled = rewindDisabled;
  if (forward.disabled !== forwardDisabled) forward.disabled = forwardDisabled;
}
async function seekVODRelative(distance: number): Promise<void> {
  if (
    vodSeekWork ||
    applicationClosing ||
    document.hidden ||
    !nativeViewingForeground ||
    !archivePlayer?.selection ||
    !finitePlayback.seek
  )
    return;
  const position = finitePlayback.currentVODposition?.();
  if (position == null) return;
  const generation = vodSeekGeneration;
  const work = (async () => {
    const result = await finitePlayback.seek!(Math.max(0, position + distance));
    if (generation !== vodSeekGeneration || applicationClosing) return;
    if (!result.ok && result.reason !== 'superseded')
      notice(
        result.reason === 'out-of-range'
          ? 'That position is not available in this video yet.'
          : 'Seeking is not available for this video right now.',
      );
  })();
  vodSeekWork = work;
  renderVODTransport();
  try {
    await work;
  } finally {
    if (vodSeekWork === work) vodSeekWork = null;
    renderVODTransport();
  }
}
const vodRewind = () => playbackAction(seekVODRelative(-10));
const vodForward = () => playbackAction(seekVODRelative(10));
for (const event of vodPositionEvents) element('video').addEventListener(event, renderVODTransport);
element('vod-rewind').addEventListener('click', vodRewind);
element('vod-forward').addEventListener('click', vodForward);
/** Instant replay on live TV (docs/instant-replay.md); installed with the dock's handlers. */
let liveReplay: LiveReplayControls | null = null;
async function disposeVODTransport(): Promise<void> {
  liveReplay?.dispose();
  vodDock.dispose();
  vodSeekGeneration++;
  for (const event of vodPositionEvents)
    element('video').removeEventListener(event, renderVODTransport);
  element('vod-rewind').removeEventListener('click', vodRewind);
  element('vod-forward').removeEventListener('click', vodForward);
  await vodSeekWork;
}
let playbackFailureLogged = false;
let alternateRetry: Promise<boolean> | null = null;
function renderPlayer(snapshot: PlaybackSnapshot): void {
  archiveSearch?.syncDetails();
  // The sound-only note belongs to the channel that raised it.
  const pictureNote = element('picture-note');
  if (
    !pictureNote.hidden &&
    (pictureNote.dataset.channel !== snapshot.selection?.id ||
      ['idle', 'failed', 'disposed'].includes(snapshot.state))
  )
    pictureNote.hidden = true;
  if (contentLibrary !== 'genxtra') element('archive-details').hidden = true;
  if (snapshot.state === 'connecting' || snapshot.state === 'disposed') vodSeekGeneration++;
  renderVODTransport();
  if (snapshot.state === 'failed' && !playbackFailureLogged)
    void diagnostics.emit({ operation: 'playback', level: 'error', code: 'playback-failed' });
  playbackFailureLogged = snapshot.state === 'failed';
  // Paid TV only: a start that delivered no video tries the provider's other
  // stored format once (never a guessed address; Free TV never reaches this).
  if (snapshot.state === 'failed' && accountPlayer?.alternateAvailable && !alternateRetry) {
    alternateRetry = accountPlayer
      .retryAlternate()
      .catch(() => false)
      .finally(() => {
        alternateRetry = null;
      });
  }
  const focusedControl = document.activeElement;
  const viewingActive =
    !document.hidden &&
    !backgroundSuspension &&
    !applicationClosing &&
    (snapshot.state === 'playing' || snapshot.state === 'buffering');
  void activityWake.setPlayback(viewingActive).catch(() => undefined);
  const resumeChoice = ['failed', 'disposed'].includes(snapshot.state)
    ? null
    : backgroundLiveChoice;
  const selection = resumeChoice?.kind === 'public' ? resumeChoice.selection : snapshot.selection;
  const archived = selection?.playMode === 'on-demand';
  const failureGuidance =
    snapshot.state === 'failed'
      ? playbackFailureGuidance(snapshot.failure, { playMode: archived ? 'on-demand' : 'live' })
      : null;
  element('watch-title').textContent =
    selection?.name ??
    (resumeChoice?.kind === 'account' ? resumeChoice.choice.channel.name : undefined) ??
    (archiveBackgroundPaused ? archiveResumeChoice?.fileTitle : undefined) ??
    'Make yourself comfortable.';
  element('playback-status').textContent = resumeChoice
    ? 'Paused'
    : {
        idle: 'Ready when you are',
        connecting: 'Connecting…',
        playing: 'Playing',
        buffering: 'Buffering…',
        paused: 'Paused',
        reconnecting: 'Reconnecting…',
        failed: 'Unable to play',
        disposed: 'Player closed',
      }[snapshot.state];
  const overlay = element('player-overlay');
  const backgroundPaused =
    resumeChoice !== null ||
    (snapshot.state === 'paused' && snapshot.pauseReason === 'background') ||
    (archiveBackgroundPaused && snapshot.state === 'idle');
  // The picture's states, each with the owner's artwork (October 19, 2026):
  // nothing playing → play screen; opening, buffering or reconnecting → the
  // buffering screen; failed → could not connect, whose painted TRY AGAIN is
  // the real Retry button. A stall during playback shows only after a moment
  // (CSS delay on data-wait), so brief hiccups never flash it.
  const busy =
    !!selection &&
    !backgroundPaused &&
    ['idle', 'connecting', 'buffering', 'reconnecting'].includes(snapshot.state);
  const art =
    backgroundPaused || snapshot.state === 'paused'
      ? 'paused'
      : snapshot.state === 'failed'
        ? 'failed'
        : busy
          ? 'buffering'
          : !selection && snapshot.state === 'idle'
            ? 'play'
            : 'none';
  overlay.hidden = !backgroundPaused && snapshot.state === 'playing';
  // Paused: the painted PRESS PLAY TO RESUME is a real Resume; the artwork says
  // PAUSED, so words show only when GenX paused in the background.
  element('picture-resume').hidden = art !== 'paused';
  overlay.toggleAttribute('data-quiet', art === 'paused' && !backgroundPaused);
  if (overlay.dataset.art !== art) {
    overlay.dataset.art = art;
    const image = overlay.querySelector<HTMLImageElement>('.picture-image');
    if (image && art !== 'none') image.src = PICTURE_ART[art];
  }
  overlay.toggleAttribute('data-wait', snapshot.state === 'buffering');
  // Nothing chosen to play: the right-panel Guide does not keep an empty picture box.
  element('app').dataset.playerIdle = String(!selection && snapshot.state === 'idle');
  updatePreviewControl();
  element('welcome-icon').hidden = !!selection || art !== 'none';
  element('overlay-title').textContent = backgroundPaused
    ? 'Playback paused'
    : snapshot.state === 'failed'
      ? failureGuidance!.title
      : selection
        ? snapshot.state === 'buffering'
          ? 'Buffering…'
          : snapshot.state === 'reconnecting'
            ? 'Reconnecting…'
            : archived
              ? 'Opening your video…'
              : 'Opening your channel…'
        : contentLibrary === 'genxtra'
          ? 'Your next favorite show.'
          : 'Your next favorite channel.';
  element('overlay-message').textContent = backgroundPaused
    ? archiveBackgroundPaused
      ? 'Playback stopped in the background. Resume opens this file from the beginning.'
      : 'Playback paused in the background. Resume reconnects to this channel.'
    : (failureGuidance?.explanation ??
      snapshot.error ??
      (selection
        ? 'Waiting for the stream to begin.'
        : contentLibrary === 'genxtra'
          ? 'Browse a decade, or search for shows and movies.'
          : 'Choose a channel, or use channel search to discover more.'));
  element('retry-button').hidden = snapshot.state !== 'failed';
  const pause = element<HTMLButtonElement>('pause-button');
  pause.disabled =
    !resumeChoice &&
    !archiveBackgroundPaused &&
    !localStreams?.pageOpen &&
    !['playing', 'paused', 'buffering'].includes(snapshot.state) &&
    // Resuming passes through Connecting: disabling Pause there moved the
    // remote's focus to Mute (Sansui, October 19, 2026). The player pauses a
    // connecting channel safely, so Pause stays usable while a channel is chosen.
    !(selection && ['connecting', 'reconnecting'].includes(snapshot.state));
  pause.textContent =
    snapshot.state === 'paused' || archiveBackgroundPaused || resumeChoice ? 'Resume' : 'Pause';
  pause.dataset.icon = pause.textContent === 'Resume' ? 'play' : 'pause';
  vodStopControl?.render(
    contentLibrary === 'genxtra' || accountVodSelected(),
    !!archivePlayer?.selection || accountVodSelected(),
  );
  const favorite = element<HTMLButtonElement>('favorite-button');
  const accountRow = selection ? accountBrowser.selectionFor(selection.id) : undefined;
  favorite.disabled =
    backgroundLiveChoice !== null ||
    archived ||
    !selection ||
    (!!accountPlayer?.selection && (!accountRow || !!accountPreferenceWork));
  const isFavorite = accountRow
    ? accountRow.favorite
    : !!selection && settings.favorites.includes(selection.id);
  favorite.textContent = isFavorite ? '★ Favorited' : '☆ Favorite';
  favorite.setAttribute('aria-pressed', String(isFavorite));
  element<HTMLButtonElement>('remove-channel').disabled =
    backgroundLiveChoice !== null ||
    archived ||
    !selection ||
    (!!accountPlayer?.selection && (!accountRow || !!accountPreferenceWork));
  element<HTMLButtonElement>('restore-channels').disabled = accountBrowser.selectedAccount
    ? !accountBrowser.preferenceScope() || !!accountPreferenceWork
    : settings.removedChannels.length === 0;
  castButton.disabled = !!backgroundLiveChoice || !castingAvailable || privatePlayback(selection);
  if (
    focusedControl instanceof HTMLButtonElement &&
    focusedControl.disabled &&
    focusedControl.closest('.view')
  )
    restoreRemoteFocus(null, element('mute-button'));
  const selectedId = selection?.id ?? null;
  if (selectedId !== renderedSelection) {
    renderedSelection = selectedId;
    guide.selectedChannelChanged();
    const removed = new Set(settings.removedChannels);
    const category = createChannelCategoryResolver(settings);
    if (contentLibrary === 'live')
      browser.update(
        catalog.channels
          .filter((channel) => !removed.has(channel.id))
          .map((channel) =>
            category(channel) === channel.category
              ? channel
              : { ...channel, category: category(channel) },
          ),
        settings.favorites,
        selectedId,
      );
  }
}
player.subscribe(renderPlayer);

let healthCaptureClosing = false;
const playbackHealth = createPlaybackHealthCapture({
  player,
  resolve: (selection) => {
    if (healthCaptureClosing || element('app').dataset.ready !== 'true') return null;
    const channel = catalog.channels.find((entry) => entry.id === selection.id);
    if (!channel || !channel.urls.includes(selection.url)) return null;
    const source = catalog.sources.find((entry) => entry.id === channel.sourceId);
    if (!source) return null;
    return {
      channel: structuredClone(channel),
      source: structuredClone(source),
      catalogRevision: persistedCatalogRevision,
    };
  },
  context: () =>
    healthPlatform === null || healthCaptureClosing || document.hidden
      ? null
      : {
          platform: healthPlatform,
          observerProfile: DECODER_HEALTH_PROFILE,
          scope: String(sharingBridge.host.snapshot().generation),
        },
  isContextCurrent: (context) =>
    !healthCaptureClosing &&
    !document.hidden &&
    element('app').dataset.ready === 'true' &&
    context.platform === healthPlatform &&
    context.observerProfile === DECODER_HEALTH_PROFILE &&
    context.scope === String(sharingBridge.host.snapshot().generation),
  readRecordPair: async (signal) => {
    signal.throwIfAborted();
    const saved = await readRecordPair();
    signal.throwIfAborted();
    return saved;
  },
  writeHealth: (request, signal) =>
    writeHealth(
      request.health,
      request.expectedCatalogRevision,
      request.expectedHealthRevision,
      signal,
    ),
  isRevisionConflict: isRecordRevisionConflict,
  enqueue: (action) => {
    const work = catalogWrites.then(action);
    catalogWrites = work.catch(() => undefined);
    return work;
  },
  now: () => Date.now(),
  notice,
});
element('genxtra-button').addEventListener('click', () => playbackAction(switchLibrary('genxtra')));
element('search-programs').addEventListener('click', () => {
  if (contentLibrary === 'genxtra') playbackAction(archiveSearch!.searchOnline());
  // Paid channels come from the account's own import, never the public scan.
  else if (accountBrowser.selectedAccount) {
    element('settings-button').click();
    document.querySelector<HTMLButtonElement>('[data-settings-section="sources"]')?.click();
  } else startInlineDiscovery();
});
element('search').addEventListener('input', () => {
  const query = element<HTMLInputElement>('search').value;
  libraryQueries[contentLibrary] = query;
  if (contentLibrary === 'genxtra') renderArchiveDiscovery(archiveDiscovery.snapshot);
  if (contentLibrary === 'live') browser.search(query);
  element('search-programs').hidden = false;
  element('clear-search').hidden = query.length === 0;
});
element('clear-search').addEventListener('click', () => {
  const search = element<HTMLInputElement>('search');
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  if (contentLibrary === 'genxtra' && element('app').dataset.deviceKind === 'tv')
    remoteEditMode.navigate(search);
  element(contentLibrary === 'live' ? 'channel-list' : 'search').focus({ preventScroll: true });
});
const categorySelector = element<HTMLSelectElement>('compact-filter');
const chooseCategory = (filter: ChannelFilter): void => {
  for (const item of document.querySelectorAll<HTMLElement>('[data-filter]'))
    item.setAttribute('aria-pressed', String(item.dataset.filter === filter));
  categorySelector.value = filter;
  browser.setFilter(filter);
  presentNotResponding();
};
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-filter]'))
  button.addEventListener('click', () => chooseCategory(button.dataset.filter as ChannelFilter));
categorySelector.addEventListener('change', () =>
  chooseCategory(categorySelector.value as ChannelFilter),
);
for (const button of document.querySelectorAll<HTMLButtonElement>('[data-close]'))
  button.addEventListener('click', () => element<HTMLDialogElement>(button.dataset.close!).close());
let addChannelsEntryWork: Promise<void> | null = null;
let addChannelsEntryController: AbortController | null = null;
const sourceIndex = createSourceIndexService({ json: readDirectoryJson });
const onlineSourceDiscovery = createOnlineSourceScan(
  sourceIndex,
  knownSourceDirectories.repositoryIds,
  Date.now,
  (progress) => {
    if (
      applicationClosing ||
      document.hidden ||
      addChannelsEntryController?.signal.aborted ||
      !addChannelsEntryWork
    )
      return;
    element('inline-scan-status').textContent =
      `Finding sources · ${progress.checkedDirectories} of ${progress.totalDirectories} sites checked · ${progress.channelSources} channel sources found · ${Math.floor(progress.elapsedMilliseconds / 1000)}s`;
  },
);
async function cancelOnlineSourceEntry(): Promise<void> {
  addChannelsEntryController?.abort();
  await onlineSourceDiscovery.cancel();
  await addChannelsEntryWork;
}
let addChannelsEntryGeneration = 0;
let customImportIntent = 0;
const importDialog = element<HTMLDialogElement>('import-dialog');
const fileImportTargetLabel = document.createElement('label');
fileImportTargetLabel.hidden = true;
fileImportTargetLabel.textContent = 'File action';
const fileImportTarget = document.createElement('select');
fileImportTarget.setAttribute('aria-label', 'Add or update a file playlist');
fileImportTargetLabel.append(fileImportTarget);
element('source-file-area').prepend(fileImportTargetLabel);
function refreshFileImportTargets(): void {
  const files = catalog.sources.filter((source) => source.kind === 'file');
  const fileIds = new Set(files.map((source) => source.id));
  const counts = new Map<string, number>();
  if (files.length)
    for (const channel of catalog.channels) {
      if (fileIds.has(channel.sourceId))
        counts.set(channel.sourceId, (counts.get(channel.sourceId) ?? 0) + 1);
    }
  fileImportTarget.replaceChildren(new Option('Add a separate playlist', ''));
  for (const [index, source] of files.entries()) {
    const count = counts.get(source.id) ?? 0;
    fileImportTarget.add(
      new Option(`Update ${source.name} (${count} channels, playlist ${index + 1})`, source.id),
    );
  }
  fileImportTarget.value = '';
  fileImportTargetLabel.hidden = files.length === 0;
}
fileImportTarget.addEventListener('change', () => {
  const selected = catalog.sources.find(
    (source) => source.id === fileImportTarget.value && source.kind === 'file',
  );
  element<HTMLInputElement>('allow-http').checked = selected?.allowHttp === true;
});
importDialog.addEventListener('close', () => {
  addChannelsEntryGeneration++;
});
const configuredImportEntry = installConfiguredImportEntry({
  root: document,
  allowed: () =>
    !applicationClosing &&
    !importRunning &&
    !transferBusy &&
    !automaticScanActive &&
    !addChannelsEntryWork &&
    !backgroundSuspension &&
    nativeViewingForeground,
  foreground: () => foregroundGeneration,
  configured: () => indexedFreshAvailable && !!scanProviderSources().length,
  capability: () => supportsBoundedResume(new AbortController().signal),
  own: ownImport,
  run: playbackAction,
  refreshFiles: refreshFileImportTargets,
  start: () => {
    rendererRecoveryPolicy.authorize('scan');
    sourceScan.startAutomatic(undefined, {
      presentation:
        contentLibrary === 'live' &&
        primaryPage === 'watch' &&
        !element('app').classList.contains('keyboard-open') &&
        element('channel-list').getClientRects().length > 0
          ? 'inline'
          : 'dialog',
    });
  },
});

function startInlineDiscovery(rescan = false): void {
  if (
    applicationClosing ||
    contentLibrary !== 'live' ||
    document.hidden ||
    !nativeViewingForeground ||
    addChannelsEntryWork ||
    ((importRunning || transferBusy) && !automaticScanActive)
  )
    return;
  rendererRecoveryPolicy.authorize('scan');
  const capturedQuery = element<HTMLInputElement>('search')
    .value.normalize('NFKC')
    .trim()
    .replace(/\s+/g, ' ');
  const generation = ++addChannelsEntryGeneration;
  const controller = new AbortController();
  addChannelsEntryController = controller;
  const capturedRegion = settings.preferredRegion
    ? structuredClone(settings.preferredRegion)
    : undefined;
  const configuredSourceIdentity = () =>
    JSON.stringify([catalog.sources, settings.reviewedChannelProviders, settings.preferredRegion]);
  const capturedSourceIdentity = configuredSourceIdentity();
  const admitted = () =>
    contentLibrary === 'live' &&
    !applicationClosing &&
    !document.hidden &&
    nativeViewingForeground &&
    !controller.signal.aborted &&
    generation === addChannelsEntryGeneration;
  const searchAction = element<HTMLButtonElement>('search-programs');
  searchAction.disabled = true;
  const pending = prepareInlineScanEntry(controller.signal)
    .then(async (state) => {
      if (!admitted()) return;
      const options = { query: capturedQuery, presentation: 'inline' as const };
      if (indexedFreshAvailable) {
        if (state === 'unavailable')
          throw new Error('Saved scan ownership must be recovered before refreshing sources.');
        if (state === 'unfinished' && !rescan) {
          // A different query is refused with Continue/Rescan, never silently continued.
          sourceScan.startAutomatic(undefined, {
            ...(capturedQuery ? { query: capturedQuery } : {}),
            presentation: 'inline',
            intent: 'continue',
          });
          return;
        }
        if (state === 'running') {
          sourceScan.startAutomatic(undefined, { presentation: 'inline' });
          return;
        }
        // This explicit online search uses the same discovered-source permission
        // pipeline below before native indexing. Refresh uses configured sources.
      }
      if (!rescan && state === 'running')
        sourceScan.startAutomatic(undefined, { presentation: 'inline' });
      else if (
        !indexedFreshAvailable &&
        !rescan &&
        (state === 'unavailable' ||
          (!capturedQuery &&
            (state === 'completed' || (state === 'fresh' && catalog.channels.length > 0))))
      ) {
        // Revealing saved channels is not authorization to replace a finished/lost scan.
        inlineScanPanel.reveal();
        element('inline-scan-status').textContent =
          state === 'completed'
            ? 'Your previous scan is finished. Select Refresh to look for new channels and remove dead ones, or Rescan to check everything again.'
            : state === 'unavailable'
              ? 'Your saved channels are retained. Previous scan progress cannot resume. Select Rescan to check all sources again.'
              : 'Saved channels are ready. Select Rescan to check all sources again.';
        element('inline-scan-error').textContent = '';
        element('inline-scan-error').hidden = true;
        element('inline-scan-stop').hidden = true;
        element('inline-scan-continue').hidden = true;
        const rescanAction = element<HTMLButtonElement>('inline-scan-rescan');
        rescanAction.hidden = false;
        rescanAction.disabled = false;
      } else if (!rescan && state === 'unfinished') {
        // Offer Finish scan / Rescan / Close rather than resuming on its own.
        if (!capturedQuery && inlineScanPanel.reopen()) return;
        sourceScan.startAutomatic(undefined, {
          ...(capturedQuery ? { query: capturedQuery } : {}),
          presentation: 'inline',
          intent: 'continue',
        });
      } else {
        inlineScanPanel.reveal(true);
        element('inline-scan-status').textContent = capturedQuery
          ? `Finding “${capturedQuery}” online…`
          : 'Finding public channel sources online…';
        element('inline-scan-error').hidden = true;
        element('inline-scan-stop').hidden = false;
        element<HTMLButtonElement>('inline-scan-stop').disabled = false;
        element('inline-scan-continue').hidden = true;
        element('inline-scan-rescan').hidden = true;
        const discovered = await onlineSourceDiscovery.start(
          { query: capturedQuery, ...(capturedRegion ? { region: capturedRegion } : {}) },
          controller.signal,
        );
        if (!admitted()) return;
        if (configuredSourceIdentity() !== capturedSourceIdentity)
          throw new Error('Configured sources changed during discovery.');
        if (!discovered.channels.length) {
          if (scanProviderSources().length > 0) {
            notice('No new online sources were found. Checking your configured sources.');
            if (rescan || (!indexedFreshAvailable && state === 'completed'))
              sourceScan.rescanAutomatic(undefined, options);
            else sourceScan.startAutomatic(undefined, options);
            return;
          }
          element('inline-scan-status').textContent = emptyOnlineDiscoveryText(discovered);
          element('inline-scan-stop').hidden = true;
          element('inline-scan-rescan').hidden = false;
          return;
        }
        // Known-dead links are skipped and pruned; saved catalog sources are never pruned.
        const dead = {
          unavailable: await readUnavailableSources(),
          keep: new Set(catalog.sources.map((source) => source.location)),
        };
        const preparedRegistry = prepareDiscoveredSources(
          settings,
          discovered,
          () => crypto.randomUUID(),
          dead,
        );
        const registryUnchanged =
          JSON.stringify([settings.reviewedChannelProviders, settings.reviewedGuideProviders]) ===
          JSON.stringify([
            preparedRegistry.preferences.reviewedChannelProviders,
            preparedRegistry.preferences.reviewedGuideProviders,
          ]);
        const saved =
          registryUnchanged ||
          (await saveSettings(
            (draft) => {
              const prepared = prepareDiscoveredSources(
                draft,
                discovered,
                () => crypto.randomUUID(),
                dead,
              );
              draft.reviewedChannelProviders = prepared.preferences.reviewedChannelProviders;
              draft.reviewedGuideProviders = prepared.preferences.reviewedGuideProviders;
            },
            async () =>
              admitted() &&
              configuredSourceIdentity() === capturedSourceIdentity &&
              JSON.stringify(settings.preferredRegion) === JSON.stringify(capturedRegion),
          ));
        if (!saved || !admitted()) {
          if (!saved && admitted()) throw new Error('Discovered sources could not be saved.');
          return;
        }
        if (rescan || (!indexedFreshAvailable && state === 'completed'))
          sourceScan.rescanAutomatic(undefined, options);
        else sourceScan.startAutomatic(undefined, options);
      }
    })
    .catch((failure: unknown) => {
      if (admitted()) {
        inlineScanPanel.reveal();
        element('inline-scan-status').textContent =
          failure instanceof BoundedScanEntryRefusal
            ? 'Saved scan progress could not be checked. Your saved channels are retained. Select Rescan to try again.'
            : 'Online source discovery could not finish. Your saved channels are retained. Select Rescan to try again.';
        if (failure instanceof BoundedScanEntryRefusal) {
          element('inline-scan-error').textContent =
            'Saved scan admission is unavailable. No channels were changed.';
          element('inline-scan-error').hidden = false;
        }
        element('inline-scan-stop').hidden = true;
        element('inline-scan-continue').hidden = true;
        element('inline-scan-rescan').hidden = false;
      } else if (
        !applicationClosing &&
        !document.hidden &&
        generation === addChannelsEntryGeneration
      ) {
        element('inline-scan-status').textContent =
          'Online discovery stopped. Your saved channels are retained.';
        element('inline-scan-stop').hidden = true;
        element('inline-scan-rescan').hidden = false;
      }
    })
    .finally(() => {
      if (addChannelsEntryWork === pending) addChannelsEntryWork = null;
      if (addChannelsEntryController === controller) addChannelsEntryController = null;
      searchAction.disabled = applicationClosing;
      updateImportActions();
    });
  addChannelsEntryWork = pending;
  updateImportActions();
}
element('inline-scan-stop').addEventListener('click', () => {
  if (applicationClosing) return;
  const button = element<HTMLButtonElement>('inline-scan-stop');
  button.disabled = true;
  playbackAction(
    Promise.all([cancelOnlineSourceEntry(), sourceScan.stopAutomatic()]).finally(() => {
      button.disabled = applicationClosing;
    }),
  );
});
element('inline-scan-continue').addEventListener('click', () => {
  if (applicationClosing || addChannelsEntryWork) return;
  playbackAction(sourceScan.continueAutomatic({ presentation: 'inline' }));
});
element('inline-scan-rescan').addEventListener('click', () => startInlineDiscovery(true));
element('inline-scan-refresh').addEventListener('click', () => playbackAction(refreshFreeTv()));

installGuideGrabberExport(document);
let playlistExportWork: Promise<void> | null = null;
let playlistExportController: AbortController | null = null;
element('export-channels-button').addEventListener('click', () => {
  if (
    applicationClosing ||
    playlistExportWork ||
    importRunning ||
    transferBusy ||
    automaticScanActive ||
    addChannelsEntryWork
  )
    return;
  const controller = new AbortController();
  playlistExportController = controller;
  const button = element<HTMLButtonElement>('export-channels-button');
  const status = element('channel-transfer-status');
  button.disabled = true;
  status.textContent = 'Preparing your channel list…';
  const work = (async () => {
    try {
      await catalogWrites;
      controller.signal.throwIfAborted();
      const removed = new Set(settings.removedChannels);
      const result = await exportPlaylistInWorker(
        {
          channels: catalog.channels.filter((channel) => !removed.has(channel.id)),
          sources: catalog.sources,
        },
        controller.signal,
      );
      controller.signal.throwIfAborted();
      if (!applicationClosing) status.textContent = 'Choose where to save your playlist.';
      const receipt = await savePlaylistExport(result, controller.signal);
      if (!applicationClosing)
        status.textContent =
          receipt.status === 'saved'
            ? `${result.channelCount} channels exported to ${receipt.filename}.`
            : receipt.status === 'download-started'
              ? `${result.channelCount} channels prepared. Your browser started the download.`
              : 'Export canceled. Your saved channels are unchanged.';
    } catch {
      if (!applicationClosing && !controller.signal.aborted)
        status.textContent =
          'The channel list could not be exported. Your saved channels are unchanged.';
    } finally {
      if (playlistExportController === controller) playlistExportController = null;

      button.disabled = applicationClosing || importRunning || transferBusy || automaticScanActive;
    }
  })().finally(() => {
    if (playlistExportWork === work) playlistExportWork = null;
  });
  playlistExportWork = work;
});
element('rescan-automatic-button').addEventListener('click', () => {
  if (applicationClosing || importRunning || transferBusy || addChannelsEntryWork) return;
  importDialog.close();
  playbackAction(
    (async () => {
      await supportsBoundedResume(new AbortController().signal);
      if (!applicationClosing && !backgroundSuspension) {
        rendererRecoveryPolicy.authorize('scan');
        sourceScan.rescanAutomatic();
      }
    })(),
  );
});
element('settings-button').addEventListener('click', () =>
  element<HTMLDialogElement>('settings-dialog').showModal(),
);
element('import-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (importRunning || transferBusy || applicationClosing) return;
  const location = element<HTMLInputElement>('playlist-url').value.trim();
  const allowHttp = element<HTMLInputElement>('allow-http').checked;
  const generation = addChannelsEntryGeneration;
  const intent = ++customImportIntent;
  playbackAction(
    ownImport(
      (async () => {
        try {
          await addChannelsEntryWork;
          if (
            !importDialog.open ||
            generation !== addChannelsEntryGeneration ||
            intent !== customImportIntent ||
            importRunning ||
            transferBusy ||
            applicationClosing ||
            backgroundSuspension
          )
            return;
          let drafts: ScanSource[] | undefined;
          if (location) {
            const url = new URL(location);
            const existing = catalog.sources.find(
              (source) => source.kind === 'url' && source.location === url.href,
            );
            const source = validateSource({
              id: existing?.id ?? crypto.randomUUID(),
              name: url.hostname,
              location: url.href,
              kind: 'url',
              allowHttp,
            });
            drafts = [{ source, fingerprint: crypto.randomUUID() }];
          }
          element<HTMLDialogElement>('import-dialog').close();
          sourceScan.start(drafts);
        } catch {
          if (
            !importDialog.open ||
            generation !== addChannelsEntryGeneration ||
            intent !== customImportIntent
          )
            return;
          element('import-status').textContent =
            'Enter a complete HTTP or HTTPS source URL and allow HTTP if needed.';
        }
      })(),
    ),
  );
});
async function importPlaylistFile(): Promise<void> {
  const file = element<HTMLInputElement>('playlist-file').files?.[0];
  if (!file) return;
  const allowHttp = element<HTMLInputElement>('allow-http').checked;
  const generation = addChannelsEntryGeneration;
  const intent = ++customImportIntent;
  const targetId = fileImportTarget.value;
  try {
    await addChannelsEntryWork;
    if (
      !importDialog.open ||
      generation !== addChannelsEntryGeneration ||
      intent !== customImportIntent
    )
      return;
    if (importRunning || transferBusy || applicationClosing || backgroundSuspension) return;
    const existing = targetId
      ? catalog.sources.find((source) => source.id === targetId && source.kind === 'file')
      : undefined;
    if (targetId && !existing)
      throw new Error('The selected playlist was removed. Choose it again.');
    element<HTMLDialogElement>('import-dialog').close();
    await sourceScan.reviewFile(createFileImportSource(file.name, allowHttp, existing), file);
  } catch (error) {
    if (
      importDialog.open &&
      generation === addChannelsEntryGeneration &&
      intent === customImportIntent
    )
      element('import-status').textContent = friendlyError(error);
  } finally {
    if (intent === customImportIntent) element<HTMLInputElement>('playlist-file').value = '';
  }
}
element('playlist-file').addEventListener('change', () => {
  playbackAction(ownImport(importPlaylistFile()));
});
element('cancel-import').addEventListener('click', () => {
  if (collectionAbort) collectionAbort.abort();
  element('import-status').textContent = 'Canceling…';
});
async function refreshAllSources(quiet = false, signal?: AbortSignal): Promise<void> {
  if (importRunning || transferBusy || applicationClosing) return;
  signal?.throwIfAborted();
  if (await supportsBoundedResume(signal ?? new AbortController().signal)) {
    const cancel = () => {
      void sourceScan.stopAutomatic().catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      signal?.throwIfAborted();
      const state = await prepareInlineScanEntry(signal ?? new AbortController().signal);
      if (state === 'unavailable')
        throw new Error('Saved scan ownership must be recovered before refreshing sources.');
      if (state === 'unfinished') await sourceScan.continueAutomatic({ presentation: 'inline' });
      else await sourceScan.refreshAutomatic(undefined, { query: '', presentation: 'inline' });
    } finally {
      signal?.removeEventListener('abort', cancel);
      if (signal?.aborted) await sourceScan.stopAutomatic();
    }
    return;
  }
  if (!quiet) element<HTMLDialogElement>('import-dialog').showModal();
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal?.addEventListener('abort', cancel, { once: true });
  const warnings: string[] = [];
  collectionAbort = controller;
  setImportBusy(true);
  try {
    const outcomes = await collectSources(
      [...catalog.sources].filter((item) => item.kind === 'url'),
      async (source, signal) => {
        const result = await refreshSource(source, undefined, signal);
        warnings.push(...(result.warnings ?? []));
        return result.status === 'completed'
          ? { status: 'completed', value: result.channels?.length ?? 0, published: true }
          : { status: 'canceled' };
      },
      controller.signal,
      (progress) => {
        element(quiet ? 'source-refresh-status' : 'import-status').textContent =
          `Collected ${progress.settled} of ${progress.total} sources…`;
      },
    );
    settings = await preferences.update((draft) => {
      draft.sources = [...catalog.sources];
    });
    applySettings();
    const completed = outcomes.filter((item) => item.status === 'completed').length;
    const failed = outcomes.filter((item) => item.status === 'failed').length;
    const summary = `${completed} sources refreshed${failed ? `; ${failed} failed and retained their saved channels` : ''}${controller.signal.aborted ? '; remaining collection canceled' : ''}.`;
    const message = [summary, ...warnings].join(' ');
    element('source-refresh-status').textContent = message;
    if (!quiet) {
      element('import-status').textContent = message;
      if (!failed && !controller.signal.aborted) {
        element<HTMLDialogElement>('import-dialog').close();
        notice(message);
      }
    }
  } catch (error) {
    element(quiet ? 'source-refresh-status' : 'import-status').textContent = friendlyError(error);
  } finally {
    signal?.removeEventListener('abort', cancel);
    collectionAbort = null;
    setImportBusy(false);
    renderCatalog();
  }
}
const dailyRefresh = createDailyRefresh({
  cadence: () =>
    migrateRefreshCadence(settings.sourceRefreshCadence, settings.automaticSourceRefresh),
  canRun: () =>
    rendererRecoveryPolicy.allowAutomaticWork() &&
    settings.automaticSourceRefresh &&
    element('app').dataset.ready === 'true' &&
    !document.hidden &&
    nativeViewingForeground &&
    !backgroundSuspension &&
    !applicationClosing &&
    !importRunning &&
    !transferBusy &&
    !automaticScanActive &&
    // A refresh would invalidate a paused scan's saved checks.
    !pausedScanResumable &&
    !document.querySelector('dialog[open]') &&
    catalog.sources.some((source) => source.kind === 'url'),
  lastAttemptAt: () => settings.sourceRefreshAttemptAt,
  persistAttempt: async (time, signal) => {
    settings = await preferences.update(
      (draft) => {
        draft.sourceRefreshAttemptAt = time;
      },
      async () => {
        if (signal.aborted || applicationClosing) throw new DailyRefreshAttemptNotStartedError();
        return true;
      },
    );
  },
  run: (signal) => ownImport(refreshAllSources(true, signal)),
  onError: () => {
    element('source-refresh-status').textContent =
      'Automatic update could not finish. Your saved channels remain available. Use Refresh to retry.';
  },
});
const dailyGuideRefresh = createDailyGuideRefresh({
  canRun: () =>
    rendererRecoveryPolicy.allowAutomaticWork() &&
    isTauri() &&
    settings.automaticGuideUpdates !== false &&
    !automaticGuideControlPending &&
    element('app').dataset.ready === 'true' &&
    !document.hidden &&
    nativeViewingForeground &&
    !backgroundSuspension &&
    !applicationClosing &&
    !importRunning &&
    !transferBusy &&
    !document.querySelector('dialog[open]'),
  plan: async (signal) => {
    const result = await readDailyGuidePlan(signal);
    const localNow = Date.now();
    return result.sources.map((entry) => ({
      ...entry,
      nextDueMs: localNow + Math.max(0, entry.nextDueMs - result.nowMs),
    }));
  },
  refresh: refreshDailyGuide,
  onChanged: () => {
    void visibleGuide?.refresh().catch(() => undefined);
    guide.catalogChanged(true);
    requestCachedGuideConnection();
  },
  onError: () => {
    element('source-refresh-status').textContent =
      'A program guide could not update. Its previous schedule remains available. Retry from Guide.';
  },
});
const automaticGuideUpdates = bootstrapBoundary.run('settings', () =>
  mountAutomaticGuideUpdates(element<HTMLDialogElement>('settings-dialog'), {
    automaticGuideUpdates: settings.automaticGuideUpdates,
    save: (value) =>
      withPausedGuideUpdates(async () => {
        if (
          !(await saveSettings((draft) => {
            draft.automaticGuideUpdates = value;
          }))
        )
          throw new Error('Program guide settings could not be saved.');
        if (value) rendererRecoveryPolicy.authorize('update-settings');
      }),
  }),
);
async function withPausedGuideUpdates<T>(operation: () => Promise<T>): Promise<T> {
  automaticGuideControlPending++;
  try {
    await joinGuideWork([automaticGuides, dailyGuideRefresh]);
    return await operation();
  } finally {
    automaticGuideControlPending--;
    if (!automaticGuideControlPending && !applicationClosing) wakeDailyRefresh();
  }
}
function requestCachedGuideConnection(): void {
  void automaticGuides.requestCached().catch((error) => {
    if (error instanceof DOMException && error.name === 'AbortError') return;
    void diagnostics.emit({ operation: 'guide', level: 'warning', code: 'guide-failed' });
  });
}
function wakeDailyRefresh(): void {
  void dailyGuideRefresh.wake().catch(() => {
    element('source-refresh-status').textContent =
      'The program guide update could not finish. Retry from Guide.';
  });
  void dailyRefresh.wake().catch(() => {
    element('source-refresh-status').textContent =
      'Automatic update could not finish. Your saved channels remain available. Use Refresh to retry.';
  });
}
element('daily-source-refresh').addEventListener('change', async () => {
  const control = element<HTMLSelectElement>('daily-source-refresh');
  const cadence = validateRefreshCadence(control.value);
  control.disabled = true;
  try {
    await Promise.all([dailyRefresh.suspend(), dailyGuideRefresh.suspend()]);
    if (
      await saveSettings((draft) => {
        draft.sourceRefreshCadence = cadence;
        draft.automaticSourceRefresh = cadence !== 'off';
      })
    ) {
      if (cadence !== 'off') rendererRecoveryPolicy.authorize('update-settings');
      wakeDailyRefresh();
    }
  } catch {
    notice('Automatic update preference could not be saved. Try again.');
  } finally {
    control.value = migrateRefreshCadence(
      settings.sourceRefreshCadence,
      settings.automaticSourceRefresh,
    );
    control.disabled = false;
  }
});
for (const dialog of document.querySelectorAll('dialog'))
  dialog.addEventListener('close', wakeDailyRefresh);
element('refresh-button').addEventListener('click', () => {
  rendererRecoveryPolicy.authorize('refresh');
  playbackAction(ownImport(refreshAllSources()));
});
vodStopControl = mountVODStop(element<HTMLButtonElement>('vod-stop'), {
  stop: stopLocalPlayback,
  changed: () => renderPlayer(player.snapshot),
  run: playbackAction,
  focusFallback: () => restoreRemoteFocus(element('mute-button')),
  canRestoreFocus: () => nativeViewingForeground && !backgroundSuspension,
});
liveReplay = installLiveReplay(document, {
  replay: () => player.liveReplay(),
  usable: () =>
    !applicationClosing &&
    !document.hidden &&
    nativeViewingForeground &&
    !backgroundSuspension &&
    !archivePlayer?.selection &&
    !!player.snapshot.selection &&
    player.snapshot.selection.playMode !== 'on-demand' &&
    ['playing', 'buffering'].includes(player.snapshot.state),
  notice,
  focusFallback: () => restoreRemoteFocus(element('pause-button'), element('mute-button')),
});
player.subscribe(() => liveReplay?.render());
element('pause-button').addEventListener('click', () => {
  if (liveReplay?.active()) return liveReplay.togglePause();
  if (player.snapshot.state === 'paused' || archiveBackgroundPaused || backgroundLiveChoice)
    playbackAction(resumeLocalPlayback());
  else playbackAction(pauseLocalPlayback());
});
element('retry-button').addEventListener('click', () => {
  if (player.snapshot.selection || archiveResumeChoice || backgroundLiveChoice)
    playbackAction(retryLocalPlayback());
});
element('picture-resume').addEventListener('click', () => element('pause-button').click());
element('mute-button').addEventListener('click', () => {
  void changeSound({ muted: !soundNow().muted });
});
element('volume').addEventListener('change', () => {
  void changeSound({ volume: Number(element<HTMLInputElement>('volume').value) });
});
element('favorite-button').addEventListener('click', () => {
  const id = player.snapshot.selection?.id;
  if (!id) return;
  toggleChannelFavorite(id);
});
async function removeSavedChannel(id: string): Promise<void> {
  if (applicationClosing) throw new Error('Application closing.');
  if (/^archive-[a-f0-9]{64}$/u.test(id))
    throw new Error('GenXtra titles are managed separately from channels.');
  if (/^account-[a-f0-9]{32}-[a-f0-9]{64}$/u.test(id)) {
    const receipt = await writeAccountPreference({ kind: 'remove', channelId: id });
    try {
      if (player.snapshot.selection?.id === id) await accountPlayer!.stop();
      notice('Channel removed. You can restore it in Settings.');
    } catch {
      notice('Channel removed. Playback cleanup needs a retry.');
    }
    if (receipt.cleanupPending) notice('Channel removed. Playback cleanup needs a retry.');
    return;
  }
  if (isTauri()) {
    await editPublicChannelGroup(id, { kind: 'remove' });
    try {
      const selected = player.snapshot.selection?.id;
      if (selected && settings.removedChannels.includes(selected)) await sharingBridge.stop();
      notice('Channel removed. You can restore removed channels in Settings.');
    } catch {
      notice('Channel removed, but playback cleanup needs attention.');
    }
    return;
  }
  const saved = await saveSettings((draft) => {
    if (!draft.removedChannels.includes(id)) draft.removedChannels.push(id);
  });
  if (!saved) throw new Error('Channel was not removed.');
  if (saved) {
    try {
      if (player.snapshot.selection?.id === id) await sharingBridge.stop();
      notice('Channel removed. You can restore removed channels in Settings.');
    } catch {
      notice('Channel removed, but playback cleanup needs attention. Retry stopping playback.');
    } finally {
      renderCatalog();
    }
  }
}
// The quiet saved-channel check (Free TV, native store only).
const channelCheckStore = createChannelCheckStore();
const savedChannelCheck = createSavedChannelCheck({
  channels: () => {
    const removed = new Set(settings.removedChannels);
    const allowHttp = new Map(catalog.sources.map((source) => [source.id, !!source.allowHttp]));
    return catalog.channels
      .filter((channel) => !removed.has(channel.id) && channel.urls.length > 0)
      .map((channel) => ({
        id: channel.id,
        url: channel.urls[0],
        allowHttp: allowHttp.get(channel.sourceId) ?? false,
      }));
  },
  idle: () =>
    !applicationClosing &&
    element('app').dataset.ready === 'true' &&
    !document.hidden &&
    nativeViewingForeground &&
    healthPlatform !== null &&
    ['idle', 'paused', 'failed'].includes(player.snapshot.state) &&
    !automaticScanActive &&
    !sourceScan.snapshot().busy,
  read: (signal) => channelCheckStore.read(signal),
  record: (observations, signal) => channelCheckStore.record(observations, signal),
  probe: async (channel, signal) =>
    healthVerdict(await inspectStreamEvidence(channel.url, channel.allowHttp, signal, 20000)),
  changed: (checks, slow) => {
    channelCheckMarks = checks;
    adoptSlowChannels(slow);
    presentNotResponding();
  },
  wait: (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(resolve, ms);
      signal.addEventListener(
        'abort',
        () => {
          window.clearTimeout(timer);
          reject(signal.reason);
        },
        { once: true },
      );
    }),
});
let lastCheckPlayback: PlaybackSnapshot['state'] | null = null;
/**
 * How long a saved Free TV channel takes from selection to playing sets or
 * clears its Slow badge (owner design, October 21, 2026): under 3 s clears it,
 * over 5 s sets it (native rule). Measured once per selection, page clock.
 */
let channelStart: { id: string; at: number; recorded: boolean } | null = null;
/**
 * Slow channels sort after fast ones (owner design, October 21, 2026). A
 * badge change advances the native list's view revision, so the list is read
 * again at once in the new order rather than paging with a refused cursor.
 */
function adoptSlowChannels(ids: ReadonlySet<string>): void {
  const same = ids.size === slowChannelIds.size && [...ids].every((id) => slowChannelIds.has(id));
  browser.setSlow(ids);
  if (same) return;
  slowChannelIds = new Set(ids);
  catalogBrowseViewRevision++;
  if (!applicationClosing) browser.search(element<HTMLInputElement>('search').value);
}
player.subscribe((snapshot) => {
  const id = snapshot.selection?.id;
  if (!id || ['idle', 'failed', 'disposed'].includes(snapshot.state)) channelStart = null;
  else if (snapshot.state === 'connecting' && channelStart?.id !== id)
    channelStart = { id, at: performance.now(), recorded: false };
  else if (
    snapshot.state === 'playing' &&
    channelStart?.id === id &&
    !channelStart.recorded &&
    isTauri() &&
    catalog.channels.some((channel) => channel.id === id)
  ) {
    channelStart.recorded = true;
    const startMs = Math.round(performance.now() - channelStart.at);
    if (startMs <= 120_000)
      void channelCheckStore
        .recordStart(id, startMs, new AbortController().signal)
        .then((slow) => {
          if (slow !== null && slow !== slowChannelIds.has(id)) {
            const next = new Set(slowChannelIds);
            if (slow) next.add(id);
            else next.delete(id);
            adoptSlowChannels(next);
          }
          savedChannelCheck.poke();
        })
        .catch(() => undefined);
  }
});
player.subscribe((snapshot) => {
  const selected = snapshot.selection?.id;
  // A saved Free TV channel playing here is working: record it.
  if (
    snapshot.state === 'playing' &&
    lastCheckPlayback !== 'playing' &&
    selected &&
    catalog.channels.some((channel) => channel.id === selected)
  )
    savedChannelCheck.played(selected);
  if (snapshot.state !== lastCheckPlayback) savedChannelCheck.poke();
  lastCheckPlayback = snapshot.state;
});
let removingDeadChannels = false;
/** Marks, the Not responding category and its Remove strip follow the newest checks. */
function presentNotResponding(): void {
  const removed = new Set(settings.removedChannels);
  const ids = new Set<string>();
  for (const check of channelCheckMarks.values())
    if (check.notResponding && !removed.has(check.channelId)) ids.add(check.channelId);
  browser.setNotResponding(ids);
  const freeTv = contentLibrary === 'live' && !accountBrowser.selectedAccount;
  const offered = freeTv && ids.size > 0;
  const item = document.querySelector<HTMLButtonElement>('.filters [data-filter="unresponsive"]');
  const option = document.querySelector<HTMLOptionElement>(
    '#compact-filter option[value="unresponsive"]',
  );
  if (!item || !option) return;
  const chosen = item.getAttribute('aria-pressed') === 'true';
  item.hidden = !offered;
  item.dataset.count = ids.size.toLocaleString();
  option.hidden = option.disabled = !offered;
  option.textContent = `Not responding (${ids.size.toLocaleString()})`;
  element('dead-channels').hidden = !(offered && chosen);
  if (!removingDeadChannels) {
    element('dead-channels-text').textContent =
      `${ids.size.toLocaleString()} saved ${ids.size === 1 ? 'channel' : 'channels'} failed checks on two different days.`;
    element('remove-dead-channels').textContent =
      ids.size === 1 ? 'Remove it' : `Remove all ${ids.size.toLocaleString()}`;
  }
  // Nothing left to show (removed, recovered, or Paid TV): back to All.
  if (chosen && !offered && !removingDeadChannels)
    document.querySelector<HTMLButtonElement>('.filters [data-filter="all"]')?.click();
}
/**
 * Removes saved channels the quiet check confirmed Not responding (failed on
 * two different days). Refresh keeps favorites (owner decision, October 21,
 * 2026); the Not responding view's own button removes them all. Every removal
 * is the ordinary one, restorable in Settings.
 */
async function removeDeadChannels(options: { keepFavorites?: boolean } = {}): Promise<number> {
  if (removingDeadChannels) return 0;
  const removed = new Set(settings.removedChannels);
  const favorites = new Set(options.keepFavorites ? settings.favorites : []);
  const ids = [...channelCheckMarks.values()]
    .filter(
      (check) =>
        check.notResponding && !removed.has(check.channelId) && !favorites.has(check.channelId),
    )
    .map((check) => check.channelId);
  if (!ids.length) return 0;
  removingDeadChannels = true;
  const button = element<HTMLButtonElement>('remove-dead-channels');
  button.disabled = true;
  try {
    // One native write and one list refresh per 5,001 channels (owner design,
    // October 21, 2026); each removal takes the channel's duplicates with it.
    for (let start = 0; start < ids.length; start += CATALOG_GROUP_BATCH_LIMIT + 1) {
      if (applicationClosing) break;
      const [first, ...more] = ids.slice(start, start + CATALOG_GROUP_BATCH_LIMIT + 1);
      element('dead-channels-text').textContent =
        `Removing ${ids.length.toLocaleString()} ${ids.length === 1 ? 'channel' : 'channels'}…`;
      await editPublicChannelGroup(first!, { kind: 'remove' }, more);
    }
    const selected = player.snapshot.selection?.id;
    if (selected && settings.removedChannels.includes(selected)) await sharingBridge.stop();
    notice(
      `${ids.length.toLocaleString()} not responding ${ids.length === 1 ? 'channel' : 'channels'} removed. You can restore removed channels in Settings.`,
    );
  } finally {
    removingDeadChannels = false;
    button.disabled = false;
    presentNotResponding();
  }
  return ids.length;
}
/**
 * Refresh (owner request, October 21, 2026): remove the channels the daily
 * check confirmed dead (favorites kept), then look for new channels only.
 * The scan's Refresh mode checks just what is due: never-seen streams, and
 * failures past their trust window (source_snapshot_activation.rs). Rescan
 * still checks everything from scratch.
 */
async function refreshFreeTv(): Promise<void> {
  if (applicationClosing || addChannelsEntryWork) return;
  await removeDeadChannels({ keepFavorites: true });
  startInlineDiscovery(false);
}
element('remove-dead-channels').addEventListener('click', () =>
  playbackAction(removeDeadChannels().then(() => undefined)),
);
element('remove-channel').addEventListener('click', () => {
  const id = player.snapshot.selection?.id;
  if (id) playbackAction(removeSavedChannel(id));
});
element('restore-channels').addEventListener('click', () => {
  if (accountBrowser.selectedAccount) {
    playbackAction(
      writeAccountPreference({ kind: 'restoreAll' }).then((receipt) => {
        notice(
          receipt.changed
            ? 'Removed account channels restored.'
            : 'No removed account channels to restore.',
        );
      }),
    );
    return;
  }
  void saveSettings((draft) => {
    draft.removedChannels = [];
  }).then((saved) => {
    if (saved) notice('Removed channels restored.');
  });
});
element('expand-button').addEventListener('click', () => {
  expanded = !expanded;
  element('app').classList.toggle('expanded', expanded);
  element('expand-button').textContent = expanded ? 'Show channels' : 'Expand';
  element('expand-button').setAttribute('aria-pressed', String(expanded));
});
const fullscreenOwner = createFullscreenOwner({
  apply: async (enabled) => {
    if (isTauri()) {
      await invoke('set_fullscreen', { enabled });
    } else if (enabled) await document.querySelector('.workspace')!.requestFullscreen();
    else if (document.fullscreenElement) await document.exitFullscreen();
  },
  changed: updateFullscreen,
});
element('fullscreen-button').addEventListener('click', async () => {
  try {
    await fullscreenOwner.toggle();
  } catch {
    notice('Full screen is unavailable in this environment.');
  }
});
// Touch screens: double tap the playing picture for full screen and back.
installDoubleTapFullscreen(element('screen'), {
  playing: () => element('app').dataset.playerIdle !== 'true',
  toggle: () => element('fullscreen-button').click(),
});
function updateFullscreen(): void {
  const active = fullscreenOwner.active || !!document.fullscreenElement;
  fullscreenPresentation.set(active);
  updatePreviewControl();
  element('fullscreen-button').textContent = active ? 'Exit full screen' : 'Full screen';
  element('fullscreen-button').setAttribute('aria-pressed', String(active));
}
document.addEventListener('fullscreenchange', () => {
  if (!document.fullscreenElement) fullscreenOwner.nativeExited();
  updateFullscreen();
});
window.addEventListener('native-fullscreen-exited', () => {
  fullscreenOwner.nativeExited();
});
function suspendForegroundWork(): Promise<void> {
  if (backgroundSuspension) return backgroundSuspension;
  let suspensionConfirmed = false;
  foregroundGeneration++;
  libraryIntent++;
  liveBrowseSuspended = true;
  document.querySelector<HTMLElement>('.browser')!.inert = true;
  vodSeekGeneration++;
  renderVODTransport();
  if (archivePlayer?.selection) {
    archiveResumeChoice = archivePlayer.selection;
    archiveBackgroundPaused = true;
  }
  const publicSnapshot = sharingBridge.host.snapshot();
  const pendingAccount = pendingAccountPlayback;
  const pendingPublic = pendingPublicPlayback;
  const publicChoice =
    pendingPublic &&
    (publicSnapshot.generation <= pendingPublic.sharingGeneration ||
      !publicSnapshot.playback.selection)
      ? pendingPublic.selection
      : publicSnapshot.playback.selection;
  const accountChoice =
    pendingAccount && publicSnapshot.generation <= pendingAccount.sharingGeneration
      ? pendingAccount.choice
      : publicChoice
        ? null
        : accountPlayer?.selection;
  if (accountChoice) backgroundLiveChoice = { kind: 'account', choice: accountChoice };
  else if (
    publicChoice &&
    !privatePlayback(publicChoice) &&
    (publicChoice.id !== player.snapshot.selection?.id || player.snapshot.state === 'idle')
  )
    backgroundLiveChoice = { kind: 'public', selection: { ...publicChoice } };
  if (backgroundLiveChoice) clearArchiveResume();
  // A held native allocation may have no controller selection to publish yet.
  // Present its retained intent immediately, while the real cleanup stays joined.
  renderPlayer(player.snapshot);
  // Reserve account cancellation before Archive handoff abort callbacks run.
  // Every queued startup is joined, including allocations without a selection.
  const accountSuspension = accountPlayer!.suspend();
  for (const controller of publicGroupControllers) controller.abort();
  primaryIntent++;
  collectionAbort?.abort();
  addChannelsEntryController?.abort();
  for (const sourceId of activeSources.keys()) refresh.cancel(sourceId);
  // Cancel acquisition and join playback/scan/guide suspension. Import
  // cancellation settles through its existing atomic publication flow.
  // Explicit LAN sharing keeps its separate service owner.
  backgroundSuspension = Promise.allSettled([
    vodSeekWork,
    archiveSearch!.suspend(),
    archiveDiscovery.suspend(),
    archiveDownloads!.suspend(),
    archivePlayer!.stop(),
    joinLiveBrowse(),
    (async () => {
      accountPreferenceOwner?.abort();
      await accountPreferenceWork?.catch(() => undefined);
    })(),
    accountControls.suspend(),
    accountSuspension,
    cancelOnlineSourceEntry(),
    primaryTransitions,
    joinLibraryPersistence(),
    dailyRefresh.suspend(),
    dailyGuideRefresh.suspend(),
    automaticGuides.suspend(),
    regionPreference.suspend(),
    refresh.cancelAll(),
    sharingBridge.suspend(),
    sourceScan.suspend(),
    websiteDiscovery.suspend(),
    guide.suspend(),
    eventHistory.suspend(),
    visibleGuide?.suspend(),
    removeDataTransfer.suspend(),
    pageInput.cancel(),
  ])
    .then((results) => {
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('Background activity cleanup could not be confirmed. Retry when ready.');
      suspensionConfirmed = true;
      renderPlayer(player.snapshot);
    })
    .finally(() => {
      backgroundSuspension = null;
      if (suspensionConfirmed) {
        resumeForegroundScan();
        queueMicrotask(wakeDailyRefresh);
      }
    });
  return backgroundSuspension;
}
let nativeActivityLifecycleSequence = 0;
function acceptNativeActivityLifecycle(event: Event, foreground: boolean): boolean {
  const detail = (event as CustomEvent<unknown>).detail;
  // Legacy desktop/older adapters emit ordinary events without a sequence.
  if (detail == null) return true;
  if (typeof detail !== 'object' || Array.isArray(detail)) return false;
  const fields = Object.getOwnPropertyDescriptors(detail);
  if (
    Object.keys(fields).length !== 3 ||
    ['schemaVersion', 'sequence', 'foreground'].some(
      (key) => !fields[key] || !('value' in fields[key]),
    )
  )
    return false;
  const sequence = fields.sequence.value;
  if (
    fields.schemaVersion.value !== 1 ||
    fields.foreground.value !== foreground ||
    !Number.isSafeInteger(sequence) ||
    sequence <= nativeActivityLifecycleSequence ||
    sequence <= 0
  )
    return false;
  nativeActivityLifecycleSequence = sequence;
  return true;
}
window.addEventListener('native-app-background', (event) => {
  if (!acceptNativeActivityLifecycle(event, false) || !nativeViewingForeground) return;
  nativeViewingForeground = false;
  updateGuideForeground();
  void viewingForeground?.setNativeForeground(false).catch(() => undefined);
  playbackAction(suspendForegroundWork());
});
window.addEventListener('native-app-foreground', (event) => {
  if (!acceptNativeActivityLifecycle(event, true) || nativeViewingForeground || applicationClosing)
    return;
  nativeViewingForeground = true;
  updateGuideForeground();
  void viewingForeground?.setNativeForeground(true).catch(() => undefined);
  resumeForegroundScan();
  wakeDailyRefresh();
});
window.addEventListener('native-back-requested', (event) => {
  const requestId = (event as CustomEvent<{ requestId?: unknown }>).detail?.requestId;
  if (isTauri() && typeof requestId === 'string' && /^back-\d{1,20}$/.test(requestId))
    void invoke('acknowledge_back', { requestId }).catch(() =>
      notice('The Back request could not be acknowledged.'),
    );
  if (!event.defaultPrevented) void handleBack().catch(() => notice('Closing could not finish.'));
});
async function handleBack(): Promise<void> {
  if (remoteEditMode.exit()) return;
  const audioMenu = document.querySelector('[data-audio-tracks-open="true"]');
  if (audioMenu) {
    audioMenu.dispatchEvent(new Event('audio-tracks-close'));
    return;
  }
  const qualityMenu = document.querySelector('[data-video-quality-open="true"]');
  if (qualityMenu) {
    qualityMenu.dispatchEvent(new Event('video-quality-close'));
    return;
  }
  // A small list opened from a button (Local's Favorites / APK sites).
  const popup = document.querySelector('[data-popup-open="true"]');
  if (popup) {
    popup.dispatchEvent(new Event('popup-close'));
    return;
  }
  // An instant replay returns to live before Back leaves anything else.
  if (!document.querySelector('dialog[open]') && liveReplay?.back()) return;
  const modal = [
    ...document.querySelectorAll<HTMLDialogElement>('dialog[open]:not([data-primary-page])'),
  ].at(-1);
  // Full screen from the Guide's preview leaves to the Guide, not past it.
  if (
    !modal &&
    primaryPage === 'guide' &&
    (fullscreenOwner.active || fullscreenOwner.busy || document.fullscreenElement)
  ) {
    await fullscreenOwner.set(false);
    return;
  }
  const dialog = modal ?? primaryHost.querySelector<HTMLDialogElement>('dialog[open]');
  if (dialog) {
    // Give the modal owner its cancellation/commit guard before changing visibility.
    if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
    return;
  }
  if (paidGuide.open) {
    await switchPrimaryPage('watch');
    return;
  }
  // Video On Demand steps out one level at a time.
  if (libraries?.vodBack()) return;
  if (archiveSearch?.dismissFilters()) return;
  if (fullscreenOwner.active || fullscreenOwner.busy || document.fullscreenElement) {
    await fullscreenOwner.set(false);
    return;
  }
  if (archiveSearch?.dismissEpisodes()) return;
  // Back unwinds viewing UI; closing the application requires explicit Exit.
  // At the main screen there is nothing left to dismiss.
}
document.addEventListener('keydown', (event) => {
  if (
    event.key === 'Escape' &&
    primaryPage !== 'watch' &&
    !document.querySelector('dialog[open]:not([data-primary-page])')
  ) {
    event.preventDefault();
    void handleBack().catch(() => notice('Closing could not finish.'));
    return;
  }
  if (
    event.key === 'Escape' &&
    element('app').dataset.vod === 'open' &&
    !fullscreenOwner.active &&
    !document.querySelector('dialog[open]')
  ) {
    event.preventDefault();
    void handleBack().catch(() => notice('Closing could not finish.'));
    return;
  }
  if (
    event.key === 'Escape' &&
    (fullscreenOwner.active || fullscreenOwner.busy) &&
    !document.querySelector('dialog[open]')
  ) {
    event.preventDefault();
    void fullscreenOwner.set(false).catch(() => notice('Leaving full screen could not finish.'));
  }
});
document.addEventListener('visibilitychange', () => {
  updateGuideForeground();
  void viewingForeground?.setDocumentVisible(!document.hidden).catch(() => undefined);
  if (document.hidden) playbackAction(suspendForegroundWork());
  else {
    resumeForegroundScan();
    wakeDailyRefresh();
  }
});
function resumeForegroundScan(): void {
  if (applicationClosing || document.hidden || !nativeViewingForeground) return;
  void Promise.resolve(backgroundSuspension)
    .then(async () => {
      if (applicationClosing || document.hidden || !nativeViewingForeground) return;
      document.querySelector<HTMLElement>('.browser')!.inert = false;
      await archiveDownloads!.resume();
      if (contentLibrary === 'genxtra') {
        if (primaryPage === 'watch') await archiveSearch!.resume(libraryQueries.genxtra);
      } else {
        liveBrowseSuspended = false;
        renderCatalog();
        await sourceScan.resume();
      }
    })
    .catch(() => notice('Scan progress could not resume. Use Continue scan to retry.'));
}
const divider = element('divider');
let dragWidth: number | null = null;
divider.addEventListener('pointerdown', (event) => {
  divider.setPointerCapture(event.pointerId);
  dragWidth = settings.panelWidth;
});
divider.addEventListener('pointermove', (event) => {
  if (dragWidth === null) return;
  dragWidth = Math.min(600, Math.max(240, event.clientX));
  document.documentElement.style.setProperty('--sidebar', `${dragWidth}px`);
  divider.setAttribute('aria-valuenow', String(dragWidth));
});
divider.addEventListener('pointerup', (event) => {
  if (dragWidth === null) return;
  const width = dragWidth;
  dragWidth = null;
  divider.releasePointerCapture(event.pointerId);
  void saveSettings((draft) => {
    draft.panelWidth = width;
  });
});
divider.addEventListener('pointercancel', () => {
  dragWidth = null;
  applySettings();
});
divider.addEventListener('keydown', (event) => {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  const width =
    event.key === 'Home'
      ? 240
      : event.key === 'End'
        ? 600
        : Math.min(
            600,
            Math.max(240, settings.panelWidth + (event.key === 'ArrowRight' ? 20 : -20)),
          );
  void saveSettings((draft) => {
    draft.panelWidth = width;
  });
});
element('export-button').addEventListener('click', () => {
  const url = URL.createObjectURL(
    new Blob([exportPreferences(settings)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = 'genx-streamer-settings.json';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
element('settings-file').addEventListener('change', async () => {
  const input = element<HTMLInputElement>('settings-file');
  const file = input.files?.[0];
  if (!file) return;
  try {
    if (file.size > 20 * 1024 * 1024) throw new Error('Settings exceed the 20 MiB limit.');
    const imported = importPreferences(await file.text());
    await withPausedGuideUpdates(async () => {
      settings = await preferences.replace(imported);
      applySettings();
    });
    notice('Settings imported.');
  } catch (error) {
    notice(friendlyError(error));
  } finally {
    input.value = '';
  }
});
window.addEventListener('pagehide', () => {
  // Capture while the exact playback/storage scope is still admitted. Pagehide
  // cannot guarantee async delivery; retain the original stop for disposal to join.
  const archiveStop = archivePlayer?.stop();
  void archiveStop?.catch(() => undefined);
  applicationClosing = true;
  libraryIntent++;
  document.removeEventListener('keydown', genxtraNavigation, true);
  void disposeVODTransport().catch(() => undefined);
  void archiveSearch!.dispose().catch(() => undefined);
  void archiveDiscovery.dispose().catch(() => undefined);
  void archiveDownloads!.dispose().catch(() => undefined);
  void channelLogos?.dispose().catch(() => undefined);
  void guideChannelLogos.dispose().catch(() => undefined);
  void Promise.resolve(archiveStop)
    .then(
      () => archivePlayer?.dispose(),
      () => archivePlayer?.dispose(),
    )
    .catch(() => undefined);
  void joinLiveBrowse().catch(() => undefined);
  void automaticGuideUpdates.dispose().catch(() => undefined);
  void eventHistory
    .dispose()
    .then(() => audioDiagnostics.dispose())
    .then(() => diagnostics.dispose())
    .catch(() => undefined);
  void automaticGuides.dispose().catch(() => undefined);
  void regionPreference.dispose().catch(() => undefined);
  televisionSelects?.dispose();
  void dailyRefresh.dispose().catch(() => undefined);
  void dailyGuideRefresh.dispose().catch(() => undefined);
  removeVideoQuality();
  removeAudioTracks();
  void viewingWake?.close().catch(() => undefined);
  healthCaptureClosing = true;
  void playbackHealth.dispose().catch(() => undefined);
  void savedChannelCheck.dispose().catch(() => undefined);
  void probeScheduler.dispose().catch(() => undefined);
  void speechSearch.dispose().catch(() => undefined);
  void websiteDiscovery.dispose().catch(() => undefined);
  void pageInput.cancel().catch(() => undefined);
  storageRecovery?.dispose();
  removeSettingsNavigation();
  removeLocationDialog();
  removeAbout();
  geographyControls.dispose();
  viewingChoices?.dispose();
  void guide.dispose().catch(() => undefined);
  void visibleGuide?.dispose().catch(() => undefined);
  void sourceScan.dispose().catch(() => undefined);
  void cancelOnlineSourceEntry()
    .then(async () => {
      await onlineSourceDiscovery.dispose();
      await sourceIndex.dispose();
    })
    .catch(() => undefined);
  void removeDataTransfer().catch(() => undefined);
  collectionAbort?.abort();
  void refresh.dispose().catch(() => undefined);
  void browser.dispose().catch(() => undefined);
  removeRemoteNavigation();
  removeViewport();
  fullscreenPresentation.dispose();
  removeCaptions();
  fullscreenOwner.dispose();
  removeMediaKeys();
  void removeCasting().catch(() => undefined);
  clearTimeout(noticeTimer);
  if (sharingPanel) void sharingPanel.dispose().catch(() => undefined);
  void sharingBridge.dispose().catch(() => undefined);
});
const closeFinalization = createCloseFinalizationObserver();
const closeProgress = createCloseProgressObserver();
let archiveCloseStop: Promise<void> | null = null;
const closeOwner = createCloseOwner({
  freeze: () => {
    // Capture the actual finite position before closing revokes the browsing scope.
    // Retain this original stop/save owner for the close sequence to join.
    const capturedStop = archivePlayer!.stop();
    archiveCloseStop = capturedStop;
    void capturedStop.catch(() => {
      // Only a settled failure permits a later close retry to drain again.
      if (archiveCloseStop === capturedStop) archiveCloseStop = null;
    });
    applicationClosing = true;
    libraryIntent++;
    for (const controller of publicGroupControllers) controller.abort();
    primaryIntent++;
    televisionSelects?.dispose();
    channelActions.dispose();
    void fullscreenOwner.close().catch(() => undefined);
    viewingWake?.freeze();
    for (const controller of startupJobs.values()) controller.abort();
    storageRecovery?.dispose();
    storageRecovery = undefined;
    healthCaptureClosing = true;
    // Startup may have made the shell inert; the close modal must remain reachable.
    element('app').inert = false;
    for (const region of document.querySelectorAll<HTMLElement>('.topbar,.workspace,dialog'))
      if (region.id !== 'close-dialog') region.inert = true;
    collectionAbort?.abort();
    playlistExportController?.abort();
    addChannelsEntryController?.abort();
  },
  owners: [
    () => {
      document.removeEventListener('keydown', genxtraNavigation, true);
    },
    () =>
      Promise.all([archiveCloseStop ?? archivePlayer!.stop(), disposeVODTransport()]).then(
        () => undefined,
      ),
    () => archiveSearch!.dispose(),
    () => archiveDiscovery.dispose(),
    () => archiveDownloads!.dispose(),
    () => channelLogos?.dispose(),
    () => guideChannelLogos.dispose(),
    () => archivePlayer!.dispose(),
    () => vodStopControl?.dispose(),
    () => joinLiveBrowse(),
    async () => {
      accountPreferenceOwner?.abort();
      await accountPreferenceWork?.catch(() => undefined);
    },
    () => accountControls.dispose(),
    async () => {
      libraries?.dispose();
      element('settings-button').removeEventListener('click', openAccountSettings);
      await accountBrowser.dispose();
    },
    () => accountPlayer!.dispose(),
    () => automaticGuideUpdates.dispose(),
    async () => {
      await cancelOnlineSourceEntry();
      await onlineSourceDiscovery.dispose();
      await sourceIndex.dispose();
    },
    () => providerManagement.dispose(),
    async () => {
      playlistExportController?.abort();
      await playlistExportWork;
    },
    () => browser.dispose(),
    () => removeVideoQuality(),
    () => removeAudioTracks(),
    () => audioDiagnostics.dispose(),
    () => dailyRefresh.dispose(),
    () => dailyGuideRefresh.dispose(),
    () => automaticGuides.dispose(),
    () => regionPreference.dispose(),
    () => fullscreenOwner.close(),
    () => removeCaptions(),
    () => viewingWake?.close(),
    async () => {
      await Promise.allSettled([...startupJobs.keys()]);
    },
    () => playbackHealth.dispose(),
    async () => {
      await sourceScan.dispose();
      await sourceActivation.settleProgressCleanup();
    },
    async () => {
      await checkpointProgressCapture?.dispose();
      pendingManifestSeed = undefined;
    },
    () => savedChannelCheck.dispose(),
    () => probeScheduler.dispose(),
    () => speechSearch.dispose(),
    () => websiteDiscovery.dispose(),
    () => pageInput.cancel(),
    async () => {
      await primaryTransitions;
      await joinLibraryPersistence();
      await guide.dispose();
    },
    () => visibleGuide?.dispose(),
    () => removeDataTransfer(),
    () => removeCasting(),
    () => sharingPanel?.dispose(),
    () => sharingBridge.dispose(),
    async () => {
      collectionAbort?.abort();
      await refresh.dispose();
      await configuredImportEntry.dispose();
      const settled = await Promise.allSettled([...importJobs]);
      if (settled.some((result) => result.status === 'rejected'))
        throw new Error('Source activity cleanup could not be confirmed.');
    },
  ],
  acknowledge: async (token, result) => {
    if (result === 'drained') {
      // All producers have settled before capturing the final serialized queues.
      await closeFinalization.run('catalog-writes', () => catalogWrites);
      await closeFinalization.run('preferences', () => preferences.settledSnapshot());
      await closeFinalization.run('event-history', () => eventHistory.dispose());
      await closeFinalization.run('diagnostics', () => diagnostics.dispose());
    }
    await closeFinalization.run('native-acknowledgment', () =>
      invoke('acknowledge_cleanup', { ...token, result }),
    );
    closeFinalization.complete();
  },
});
Object.defineProperty(window, '__GENX_CLOSE__', {
  get: () => closeOwner.snapshot(),
  enumerable: false,
  configurable: false,
});
Object.defineProperty(window, '__GENX_CLOSE_FINALIZATION__', {
  get: () => closeFinalization.snapshot(),
  enumerable: false,
  configurable: false,
});
Object.defineProperty(window, '__GENX_ARCHIVE_RELEASE__', {
  get: () => archivePlayer?.releaseTimings(),
});
Object.defineProperty(window, '__GENX_NATIVE_CLOSE__', {
  get: () => closeProgress.snapshot(),
  enumerable: false,
  configurable: false,
});
const removeExit = mountExit(element<HTMLButtonElement>('exit-button'), {
  native: isTauri,
  request: async () => {
    await installCloseBridge();
    await invoke('request_exit');
  },
  notice,
});
window.addEventListener('pagehide', removeExit, { once: true });
let closeStartInstalled = false;
let closeProgressInstalled = false;
let closeBlockedInstalled = false;
let closeActionsInstalled = false;
let closeBridgeWork: Promise<void> | null = null;
function installCloseBridge(attempt?: StartupAttempt): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  if (closeBridgeWork) return closeBridgeWork;
  const work = (async () => {
    if (!closeProgressInstalled) {
      const register = () =>
        listen<unknown>('native-close-progress', (event) => {
          closeProgress.receive(event.payload);
        });
      await (attempt ? attempt.run('close-progress-listen', register) : register());
      closeProgressInstalled = true;
    }
    if (!closeStartInstalled) {
      const register = () =>
        listen<CleanupToken>('native-close-starting', (event) => {
          playbackAction(closeOwner.begin(event.payload));
        });
      await (attempt ? attempt.run('close-start-listen', register) : register());
      closeStartInstalled = true;
    }
    if (!closeBlockedInstalled) {
      const register = () =>
        listen('native-close-blocked', () => {
          const dialog = element<HTMLDialogElement>('close-dialog');
          if (!dialog.open) dialog.showModal();
        });
      await (attempt ? attempt.run('close-blocked-listen', register) : register());
      closeBlockedInstalled = true;
    }
    if (!closeActionsInstalled) {
      element('close-dialog').addEventListener('cancel', (event) => event.preventDefault());
      element('close-retry').addEventListener('click', () => {
        element<HTMLDialogElement>('close-dialog').close();
        void invoke('request_exit').catch(() => notice('Closing could not finish.'));
      });
      element('close-force').addEventListener('click', () => {
        void invoke('force_exit').catch(() => notice('Force quit could not finish.'));
      });
      closeActionsInstalled = true;
    }
  })();
  closeBridgeWork = work;
  void work
    .finally(() => {
      if (closeBridgeWork === work) closeBridgeWork = null;
    })
    .catch(() => {});
  return work;
}
function initialize(retryStorage = false): Promise<void> {
  if (applicationClosing) return Promise.reject(new Error('The application is closing.'));
  const controller = new AbortController();
  const attempt = startupObserver.begin();
  element('storage-status').textContent = 'Loading your channels\u2026';
  const work = Promise.resolve().then(async () => {
    await attempt.run('close-bridge', async () => {
      if (retryStorage) wakeTransportAdmission.retry();
      try {
        await installCloseBridge(attempt);
        // Release even if close has begun: the held disable must actually drain.
        wakeTransportAdmission.release();
      } catch (error) {
        wakeTransportAdmission.fail();
        throw error;
      }
      if (retryStorage && viewingWake?.snapshot().failed) await viewingWake.retry();
      await viewingForeground?.setDocumentVisible(!document.hidden);
      await viewingWake?.setActive(false);
    });
    controller.signal.throwIfAborted();
    if (retryStorage) {
      element('app').dataset.ready = 'false';
      await Promise.all([
        archiveSearch!.suspend(),
        archiveDiscovery.suspend(),
        archiveDownloads!.suspend(),
        archivePlayer!.stop(),
        joinLiveBrowse(),
        joinLibraryPersistence(),
      ]);
    }
    if (retryStorage && isTauri()) {
      const receipt = await attempt.run('retry-storage', () =>
        invoke<{ dataMode: string; retryReady: true }>('retry_storage'),
      );
      controller.signal.throwIfAborted();
      if (receipt?.retryReady !== true || typeof receipt.dataMode !== 'string')
        throw new Error('Storage retry was not confirmed.');
    }
    await initializeSaved(controller.signal, attempt);
  });
  startupJobs.set(work, controller);
  void work.then(
    () => attempt.finish('completed'),
    (error: unknown) =>
      attempt.finish(
        controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
          ? 'cancelled'
          : 'failed',
      ),
  );
  void work.finally(() => startupJobs.delete(work)).catch(() => {});
  return work;
}
async function initializeSaved(signal: AbortSignal, attempt: StartupAttempt): Promise<void> {
  await rendererRecoveryPolicy.initialize();
  signal.throwIfAborted();
  archiveStorageEpoch++;
  archiveIndexRevision = null;
  clearArchiveResume();
  // Recovery can replace the canonical storage owner while revisions happen
  // to agree; a successful cache scope never crosses that re-initialization.
  lastCachedGuideConnection = null;
  let startupPair: Awaited<ReturnType<typeof readRecordPair>>;
  let startupState: Awaited<ReturnType<typeof decodeSavedHealthInWorker>>;
  try {
    startupPair = await attempt.run('read-record-pair', () => readRecordPair());
    signal.throwIfAborted();
    persistedCatalogRevision = startupPair.catalogRevision;
    startupState = await attempt.run('health-decode', () =>
      decodeSavedHealthInWorker(startupPair, signal),
    );
  } catch (error) {
    signal.throwIfAborted();
    notice(`Saved data could not open. ${friendlyError(error)}`);
    element('storage-status').textContent =
      'Storage could not open. Use the recovery controls to retry or choose an available location.';
    throw error;
  }
  signal.throwIfAborted();
  try {
    settings = await attempt.run('preferences', () =>
      startupPair.preferences === null
        ? preferences.load()
        : preferences.replaceAtomically(JSON.parse(startupPair.preferences), async () => undefined),
    );
  } catch (error) {
    notice(`Saved settings need attention. ${friendlyError(error)}`);
  }
  signal.throwIfAborted();
  try {
    const record = startupPair.catalog;
    if (record !== null) {
      catalog = startupState.catalog;
      catalogRevision++;
    }
  } catch (error) {
    notice(`Saved channels need attention. ${friendlyError(error)}`);
  }
  // Select the saved library before applying settings can admit indexed browsing.
  contentLibrary = settings.contentLibrary === 'genxtra' ? 'genxtra' : 'live';
  liveBrowseSuspended = contentLibrary !== 'live';
  // Admit indexed browsing only after the paired catalog and preferences are available.
  catalogBrowseReady = true;
  await attempt.run('apply-settings', () => applySettings());
  if (isTauri()) {
    try {
      const capabilities = await attempt.run('capabilities', () =>
        invoke<{ isTelevision: boolean }>('device_capabilities'),
      );
      signal.throwIfAborted();
      if (typeof capabilities?.isTelevision !== 'boolean')
        throw new Error('Device capabilities are unavailable.');
      castingAvailable = !capabilities.isTelevision;
      element('app').dataset.deviceKind = capabilities.isTelevision ? 'tv' : 'personal';
      try {
        localStorage.setItem(DEVICE_KIND_KEY, element('app').dataset.deviceKind!);
      } catch {
        // Next launch simply waits for this answer again.
      }
      await activityWake.setTelevision(capabilities.isTelevision);
      televisionSelects?.dispose();
      televisionSelects = capabilities.isTelevision
        ? installInAppSelects(document.body)
        : undefined;
    } catch {
      castingAvailable = false;
      // Unconfirmed: no remembered layout stays applied.
      delete element('app').dataset.deviceKind;
    }
    castButton.hidden = !castingAvailable;
    castButton.disabled = !castingAvailable;
    try {
      const info = await attempt.run('runtime-info', () =>
        invoke<{ platform: string; dataMode: string }>('runtime_info'),
      );
      signal.throwIfAborted();
      if (!['windows', 'android', 'linux', 'macos', 'ios'].includes(info.platform))
        throw new Error('The native platform is unavailable.');
      healthPlatform = info.platform;
      element('storage-status').textContent = `${info.platform} · ${info.dataMode} storage`;
      if (info.platform === 'windows') {
        sharingPanel = mountSharingSettings(element('sharing-settings'), sharingBridge.host);
        sharingBridge.bindBeforeSelection(
          sharingPanel.service.beforeSelection.bind(sharingPanel.service),
        );
      }
    } catch {
      element('storage-status').textContent = 'Native storage status unavailable.';
    }
  } else
    element('storage-status').textContent = 'Browser development preview · saved on this browser';
  signal.throwIfAborted();
  if (isTauri()) {
    const scanGeneration = sourceScan.snapshot().generation;
    try {
      const summary = await attempt.run('scan-checkpoint-summary', () =>
        nativeScanCheckpointSummary.read(signal),
      );
      signal.throwIfAborted();
      sourceScan.presentSavedSummary(summary, scanGeneration);
    } catch {
      signal.throwIfAborted();
      notice('Saved scan progress could not be read. Your saved channels are retained.');
    }
  }
  await attempt.run('ready', () => {
    signal.throwIfAborted();
    if (applicationClosing) throw new DOMException('Startup canceled.', 'AbortError');
    // Startup has no previous interactive library to close. Joining browse,
    // guide or scan owners here can wait on this same bootstrap completing.
    presentPrimaryPage('watch');
    presentLibrary();
    element<HTMLInputElement>('search').value = libraryQueries[contentLibrary];
    element('clear-search').hidden = !libraryQueries[contentLibrary];
    document.querySelector<HTMLElement>('.browser')!.inert = false;
    element('app').inert = false;
    element('app').dataset.ready = 'true';
    queueMicrotask(() => {
      if (archiveRuntimeScope()) playbackAction(archiveDownloads!.resume());
    });
    if (contentLibrary === 'live') {
      renderCatalog();
      browser.search(libraryQueries.live);
    } else
      queueMicrotask(() => {
        if (archiveActiveScope()) playbackAction(archiveSearch!.resume(libraryQueries.genxtra));
      });
    queueMicrotask(requestCachedGuideConnection);
    void libraries?.reload();
    updateVisibleGuide();
    storageRecovery?.dispose();
    storageRecovery = undefined;
    void adoptIncludedHttp().then(wakeDailyRefresh);
    if (isTauri() && rendererRecoveryPolicy.allowAutomaticWork()) savedChannelCheck.start();
    if (!rendererRecoveryPolicy.allowAutomaticWork())
      notice(
        'Automatic updates are paused for this session. Use Scan or Refresh when you are ready.',
      );
  });
}
bootstrapBoundary.mounted();
void initialize().catch(() => {
  void diagnostics.emit({ operation: 'storage', level: 'error', code: 'storage-failed' });
  if (!applicationClosing)
    storageRecovery = mountStorageRecovery({ retry: () => initialize(true) });
});
