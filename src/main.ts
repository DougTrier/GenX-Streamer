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

import { createSharingHost } from './application/sharing-host';
import { createAccountPlayer, type AccountPlaybackChoice } from './application/account-player';
import { createArchivePlayer } from './application/archive-player';
import { createArchiveBookmarks } from './platform/archive-bookmarks';
import { createArchiveDownloads } from './application/archive-downloads';
import { chooseArchiveResume } from './ui/archive-resume';

import {
  createArchiveCatalog,
  type ArchiveDecade,
  type ArchiveContentType,
} from './platform/archive-catalog';
import { mountArchiveSearch } from './ui/archive-search';

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

import { createCloseProgressObserver } from './application/close-progress';

import { createActivityWakePolicy } from './application/activity-wake';

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

import { fetchAuxiliaryText } from './location/fetch';

import { mountLibrarySwitcher } from './ui/library-switcher';

import {
  defaultProviderRegistry,
  parseProviderRegistry,
  serializeProviderRegistry,
} from './discovery/provider-registry';

import { installInAppSelects } from './ui/in-app-select';
import { installMediaKeys } from './ui/media-keys';
import { installDataTransfer } from './ui/data-transfer';

import { createDiagnostics } from './diagnostics/native';

import { mountEventHistory } from './ui/event-history';
import './ui/event-history.css';
import { mountGuide } from './ui/guide';
import { mountExit } from './ui/exit';

import { installFullscreenPresentation } from './ui/fullscreen-presentation';
import { installDoubleTapFullscreen } from './ui/double-tap-fullscreen';
import { installCategoryMenu } from './ui/category-menu';
import { installCaptions } from './ui/captions';
import { createFullscreenOwner } from './ui/fullscreen-owner';
import { mountGeographyControls } from './ui/geography-controls';
import { mountViewingChoices } from './ui/viewing-choices';
import { mountSettingsNavigation, mountLocationDialog } from './ui/settings-navigation';

import { mountVODStop } from './ui/vod-stop';

import { createPageInput } from './discovery/page-input';
import { createSourceIndexService } from './discovery/source-index-service';
import { createOnlineSourceScan } from './discovery/online-source-scan';
import knownSourceDirectories from './discovery/known-directory-ids.json';

import { readDirectoryJson } from './platform/source-directory';

import { mountWebsiteDiscovery } from './ui/website-discovery';
import { NativeSpeech } from './search/native-speech';
import { mountSpeechSearch } from './ui/speech-search';
import { mountStorageRecovery } from './ui/storage-recovery';
import './ui/guide.css';
import './ui/guide-timeline.css';
import './ui/responsive.css';

import './ui/in-app-select.css';
import './ui/scan-screensaver.css';

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
import { installLiveReplay } from './ui/live-replay';

import { createSelectionSession } from './discovery/selection-session';

import { type ChannelCheck } from './platform/channel-checks';

import { decodeSavedHealthInWorker } from './application/health-history-read';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { createShell } from './ui/shell';
import { mountAbout } from './ui/about';
import { ChannelBrowser, type ChannelFilter } from './ui/channel-browser';
import { queryCatalogPage } from './platform/catalog-query';
import { mutateCatalogGroup, type CatalogGroupAction } from './platform/catalog-group';
import { PlaybackController, type PlaybackSnapshot } from './playback/controller';
import { startTiming } from './playback/start-timing';

import { mountChannelActions } from './ui/channel-actions';
import { mountProviderManagement } from './ui/provider-management';

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
  writeRecord,
  writeRecordPair,
  inspectSource,
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

import { mountLocalStreams } from './ui/local-streams';

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
import { createScanController } from './application/scan-controller';
import type { ContentLibrary } from './application/content-library';

import { createGuideController } from './application/guide-controller';
import { createChannelHealthController } from './application/channel-health-controller';
import { createImportController } from './application/import-controller';
import { createPlayerView } from './application/player-view';
import { createGenxtraNavigation } from './application/genxtra-navigation';
import { createLibraryState } from './application/library-state';
import { createPageState } from './application/page-state';
import { createVisibleGuideState } from './application/visible-guide-state';
import { createVisibleGuideController } from './application/visible-guide-controller';
import { createLibraryController } from './application/library-controller';
import { createPageController } from './application/page-controller';

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
let archiveSearch: ReturnType<typeof mountArchiveSearch> | undefined;
let archiveDownloads: ReturnType<typeof createArchiveDownloads> | undefined;
let channelLogos: ReturnType<typeof createChannelLogos> | undefined;
const library = createLibraryState();
const libraryQueries: Record<ContentLibrary, string> = { live: '', genxtra: '' };
const archiveCatalog = createArchiveCatalog();
// Bootstrap failure callbacks need the initialized optional binding above.
// eslint-disable-next-line prefer-const
archiveDownloads = createArchiveDownloads({
  readyScope: archiveRuntimeScope,
  beforeRemove: async (downloadRef) => {
    if (archivePlayer?.selection?.downloadRef === downloadRef) await archivePlayer.stop();
    if (library.archiveResumeChoice?.downloadRef === downloadRef) clearArchiveResume();
  },
});
const liveBrowseJobs = new Map<AbortController, Promise<unknown>>();
function archiveRuntimeScope(): string | null {
  if (!isTauri() || element('app').dataset.ready !== 'true') return null;
  return applicationClosing ? null : `archive-storage-${library.archiveStorageEpoch}`;
}
function archiveActiveScope(): string | null {
  const scope = archiveRuntimeScope();
  return scope &&
    library.contentLibrary === 'genxtra' &&
    pageState.primaryPage === 'watch' &&
    !document.hidden &&
    nativeViewingForeground &&
    !backgroundSuspension
    ? `${scope}:genxtra:${foregroundGeneration}:${library.archiveFilterGeneration}`
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
  library.archiveResumeChoice = null;
  library.archiveBackgroundPaused = false;
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
  catalogRevision: () => library.archiveIndexRevision,
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
const scanController = createScanController({
  get catalog() {
    return catalog;
  },
  set catalog(value) {
    catalog = value;
  },
  get settings() {
    return settings;
  },
  set settings(value) {
    settings = value;
  },
  get catalogWrites() {
    return catalogWrites;
  },
  set catalogWrites(value) {
    catalogWrites = value;
  },
  get preferences() {
    return preferences;
  },
  get applicationClosing() {
    return applicationClosing;
  },
  get persistedCatalogRevision() {
    return persistedCatalogRevision;
  },
  set persistedCatalogRevision(value) {
    persistedCatalogRevision = value;
  },
  get catalogRevision() {
    return catalogRevision;
  },
  set catalogRevision(value) {
    catalogRevision = value;
  },
  get applySettings() {
    return applySettings;
  },
  get automaticGuides() {
    return automaticGuides;
  },
  get diagnostics() {
    return diagnostics;
  },
  get element() {
    return element;
  },
  get browser() {
    return browser;
  },
  get guide() {
    return guide;
  },
  get geographyControls() {
    return geographyControls;
  },
  get updateVisibleGuide() {
    return updateVisibleGuide;
  },
  get channelCheckStore() {
    return channelCheckStore;
  },
  get savedChannelCheck() {
    return savedChannelCheck;
  },
  get player() {
    return player;
  },
  get nativeViewingForeground() {
    return nativeViewingForeground;
  },
  get contentLibrary() {
    return library.contentLibrary;
  },
  get addChannelsEntryWork() {
    return addChannelsEntryWork;
  },
  get importRunning() {
    return importRunning;
  },
  get transferBusy() {
    return transferBusy;
  },
  set transferBusy(value) {
    transferBusy = value;
  },
  get selectionEpisode() {
    return selectionEpisode;
  },
  set selectionEpisode(value) {
    selectionEpisode = value;
  },
  get setImportBusy() {
    return setImportBusy;
  },
  get sharingBridge() {
    return sharingBridge;
  },
  get notice() {
    return notice;
  },
  get catalogBrowseViewRevision() {
    return catalogBrowseViewRevision;
  },
  set catalogBrowseViewRevision(value) {
    catalogBrowseViewRevision = value;
  },
  get renderCatalog() {
    return renderCatalog;
  },
  get updateImportActions() {
    return updateImportActions;
  },
  get activityWake() {
    return activityWake;
  },
  get foregroundGeneration() {
    return foregroundGeneration;
  },
});
const {
  sourceScan,
  scanProviderSources,
  supportsBoundedResume,
  prepareInlineScanEntry,
  inlineScanPanel,
  inspectStreamEvidence,
  probeScheduler,
  sourceActivation,
  adoptIncludedHttp,
} = scanController;

// Assigned once below; presentPrimaryPage may run before the switcher mounts.
let libraries: ReturnType<typeof mountLibrarySwitcher> | undefined;
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
const visibleGuideState = createVisibleGuideState();
// The guide-row controller is created further down, but the channel list can
// ask for guide rows while it is still being set up. Until the controller
// exists there is nothing to update, exactly as before it moved out of this
// file (the guide owner did not exist yet then either).
// eslint-disable-next-line prefer-const -- assigned once, below, and read before that
let visibleGuideController: ReturnType<typeof createVisibleGuideController> | undefined;
function updateVisibleGuide(): void {
  visibleGuideController?.updateVisibleGuide();
}
function updateGuideForeground(): void {
  visibleGuideController?.updateGuideForeground();
}
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
    library.contentLibrary === 'live' &&
    pageState.primaryPage === 'watch' &&
    !library.liveBrowseSuspended &&
    !document.hidden &&
    nativeViewingForeground &&
    !accountBrowser.selectedAccount
      ? {
          key: `${library.archiveStorageEpoch}:${persistedCatalogRevision}`,
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
      visibleGuideState.visibleGuideRows = rows.map((row) => ({ ...row }));
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
          library.contentLibrary === 'live' &&
          !library.liveBrowseSuspended &&
          !document.hidden &&
          nativeViewingForeground &&
          (!!accountBrowser.selectedAccount || catalogBrowseReady),
        identity: () =>
          `${library.libraryIntent}:` +
          (accountBrowser.selectedAccount
            ? accountBrowser.identity()
            : `${catalogRevision}:${catalogBrowseViewRevision}`),
        query: (input, signal) => {
          if (
            element('app').dataset.ready !== 'true' ||
            library.liveBrowseSuspended ||
            library.contentLibrary !== 'live' ||
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
  account: () => (library.contentLibrary === 'live' ? accountBrowser.selectedAccount : null),
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
const guideController = createGuideController({
  get settings() {
    return settings;
  },
  get catalog() {
    return catalog;
  },
  get visibleGuide() {
    return visibleGuideState.visibleGuide;
  },
  get guide() {
    return guide;
  },
  get wakeDailyRefresh() {
    return wakeDailyRefresh;
  },
  get element() {
    return element;
  },
  get applicationClosing() {
    return applicationClosing;
  },
  get persistedCatalogRevision() {
    return persistedCatalogRevision;
  },
  get player() {
    return player;
  },
  get sharingBridge() {
    return sharingBridge;
  },
  get catalogWrites() {
    return catalogWrites;
  },
  get preferences() {
    return preferences;
  },
  get diagnostics() {
    return diagnostics;
  },
  get rendererRecoveryPolicy() {
    return rendererRecoveryPolicy;
  },
  get nativeViewingForeground() {
    return nativeViewingForeground;
  },
  get scanController() {
    return scanController;
  },
  get sourceScan() {
    return sourceScan;
  },
});
const { automaticGuides, guideHost } = guideController;
const pageState = createPageState();
const pageController = createPageController({
  get pageState() {
    return pageState;
  },
  get element() {
    return element;
  },
  get libraries() {
    return libraries;
  },
  get library() {
    return library;
  },
  get applicationClosing() {
    return applicationClosing;
  },
  get guide() {
    return guide;
  },
  get paidGuide() {
    return paidGuide;
  },
  get archiveSearch() {
    return archiveSearch;
  },
  get archiveDiscovery() {
    return archiveDiscovery;
  },
  get nativeViewingForeground() {
    return nativeViewingForeground;
  },
  get accountBrowser() {
    return accountBrowser;
  },
  get libraryQueries() {
    return libraryQueries;
  },
});
const { primaryHost, switchPrimaryPage, presentPrimaryPage, updatePreviewControl } = pageController;

const guideChannelLogos = createChannelLogos({
  readyScope: () =>
    isTauri() &&
    element('app').dataset.ready === 'true' &&
    !applicationClosing &&
    pageState.primaryPage === 'guide' &&
    !document.hidden &&
    nativeViewingForeground &&
    !accountBrowser.selectedAccount
      ? {
          key: `${library.archiveStorageEpoch}:${persistedCatalogRevision}`,
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
    if (pageState.primaryPage === 'guide') presentPrimaryPage('watch');
  },
  buildForChannels: (signal) => {
    // Explicit Find retries discovery; automatic requests keep the retry cooldown.
    if (
      guideController.automaticGuideDiscovery?.result.outcomes.some(
        (outcome) => outcome.status === 'failed',
      )
    )
      guideController.automaticGuideDiscovery = null;
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
const libraryController = createLibraryController({
  get archiveRuntimeScope() {
    return archiveRuntimeScope;
  },
  get library() {
    return library;
  },
  get element() {
    return element;
  },
  get archiveSearch() {
    return archiveSearch;
  },
  set archiveSearch(value) {
    archiveSearch = value;
  },
  get archiveCatalog() {
    return archiveCatalog;
  },
  get diagnostics() {
    return diagnostics;
  },
  get archiveDownloads() {
    return archiveDownloads;
  },
  get clearArchiveResume() {
    return clearArchiveResume;
  },
  get archivePlayer() {
    return archivePlayer;
  },
  get player() {
    return player;
  },
  get archiveActiveScope() {
    return archiveActiveScope;
  },
  get playbackAction() {
    return playbackAction;
  },
  get libraryQueries() {
    return libraryQueries;
  },
  get vodDock() {
    return vodDock;
  },
  get categoryMenu() {
    return categoryMenu;
  },
  get televisionSelects() {
    return televisionSelects;
  },
  get presentPrimaryPage() {
    return presentPrimaryPage;
  },
  get pageState() {
    return pageState;
  },
  get liveBrowseJobs() {
    return liveBrowseJobs;
  },
  get channelLogos() {
    return channelLogos;
  },
  get applicationClosing() {
    return applicationClosing;
  },
  get nativeViewingForeground() {
    return nativeViewingForeground;
  },
  get backgroundSuspension() {
    return backgroundSuspension;
  },
  get renderCatalog() {
    return renderCatalog;
  },
  get browser() {
    return browser;
  },
  get preferences() {
    return preferences;
  },
  get transferBusy() {
    return transferBusy;
  },
  get settings() {
    return settings;
  },
  set settings(value) {
    settings = value;
  },
  get notice() {
    return notice;
  },
  get guide() {
    return guide;
  },
  get sourceScan() {
    return sourceScan;
  },
});
const {
  recordArchiveRevision,
  switchLibrary,
  archiveDiscovery,
  changeArchiveFilter,
  renderArchiveDiscovery,
  joinLiveBrowse,
  joinLibraryPersistence,
  presentLibrary,
} = libraryController;

element('genxtra-decade-select').addEventListener('change', () =>
  playbackAction(
    changeArchiveFilter(() => {
      const value = element<HTMLSelectElement>('genxtra-decade-select').value;
      library.archiveDecade = value === 'all' ? null : (Number(value) as ArchiveDecade);
    }),
  ),
);
element('genxtra-kind-select').addEventListener('change', () =>
  playbackAction(
    changeArchiveFilter(() => {
      const value = element<HTMLSelectElement>('genxtra-kind-select').value;
      library.archiveFavoritesOnly = value === 'favorites';
      library.archiveContentType = library.archiveFavoritesOnly
        ? 'all'
        : (value as ArchiveContentType | 'all');
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
      revision: pageState.primaryTransitionRevision,
      stage: pageState.primaryTransitionStage,
      reason: pageState.primaryTransitionReason,
      activeIntent: pageState.primaryTransitionActiveIntent,
      requestedIntent: pageState.primaryTransitionRequestedIntent,
      pending: pageState.primaryTransitionPending > 0,
      queued:
        pageState.primaryTransitionPending > (pageState.primaryTransitionActiveIntent ? 1 : 0),
      errorCount: pageState.primaryTransitionErrorCount,
      nativeForeground: nativeViewingForeground,
      documentHidden: document.hidden,
      closing: applicationClosing,
    }),
});
visibleGuideController = createVisibleGuideController({
  get nativeViewingForeground() {
    return nativeViewingForeground;
  },
  get applicationClosing() {
    return applicationClosing;
  },
  get browser() {
    return browser;
  },
  get guide() {
    return guide;
  },
  get visibleGuideState() {
    return visibleGuideState;
  },
  get element() {
    return element;
  },
  get persistedCatalogRevision() {
    return persistedCatalogRevision;
  },
  get catalog() {
    return catalog;
  },
  get settings() {
    return settings;
  },
});

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
      (library.contentLibrary === 'genxtra' || !library.liveBrowseSuspended) &&
      element<HTMLInputElement>('search').value.trim()
    ) {
      event.preventDefault();
      if (library.contentLibrary === 'genxtra') {
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
const genxtraNavigationOwner = createGenxtraNavigation({
  get contentLibrary() {
    return library.contentLibrary;
  },
  get primaryPage() {
    return pageState.primaryPage;
  },
  get fullscreenOwner() {
    return fullscreenOwner;
  },
  get remoteEditMode() {
    return remoteEditMode;
  },
  get element() {
    return element;
  },
});
const { genxtraNavigation } = genxtraNavigationOwner;

document.addEventListener('keydown', genxtraNavigation, true);
const removeMediaKeys = installMediaKeys({
  togglePause: () => {
    if (playerView.liveReplay?.active()) return playerView.liveReplay.togglePause();
    if (
      player.snapshot.state === 'paused' ||
      library.archiveBackgroundPaused ||
      backgroundLiveChoice
    )
      return resumeLocalPlayback();
    playbackAction(pauseLocalPlayback());
  },
  play: () => {
    if (playerView.liveReplay?.active()) return playerView.liveReplay.setPaused(false);
    if (
      player.snapshot.state === 'paused' ||
      library.archiveBackgroundPaused ||
      backgroundLiveChoice
    )
      return resumeLocalPlayback();
    if (player.snapshot.selection && ['failed', 'idle'].includes(player.snapshot.state))
      return retryLocalPlayback();
  },
  pause: () => {
    if (playerView.liveReplay?.active()) return playerView.liveReplay.setPaused(true);
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
    if (library.contentLibrary === 'live') browser.selectAdjacent(direction);
  },
  back: () => handleBack(),
  // On-demand videos go back 10 s; live channels start an instant replay.
  rewind: () => {
    if (player.snapshot.selection?.playMode === 'on-demand') return vodRewind();
    if (playerView.liveReplay) playbackAction(playerView.liveReplay.rewind());
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
  if (archivePlayer?.selection || library.archiveResumeChoice) {
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
  if (library.archiveResumeChoice) {
    const choice = library.archiveResumeChoice;
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
  const archived = archivePlayer?.selection ?? library.archiveResumeChoice;
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
  if (library.contentLibrary === 'live')
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
  if (
    importRunning ||
    transferBusy ||
    addChannelsEntryWork ||
    importController.playlistExportWork
  ) {
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
  const disabled = importRunning && !scanController.automaticScanActive;
  element<HTMLButtonElement>('import-button').disabled =
    importRunning || transferBusy || scanController.automaticScanActive || !!addChannelsEntryWork;
  element<HTMLButtonElement>('export-channels-button').disabled =
    importRunning || transferBusy || scanController.automaticScanActive || !!addChannelsEntryWork;
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
const playerView = createPlayerView({
  get player() {
    return player;
  },
  get vodDock() {
    return vodDock;
  },
  get contentLibrary() {
    return library.contentLibrary;
  },
  get applicationClosing() {
    return applicationClosing;
  },
  get nativeViewingForeground() {
    return nativeViewingForeground;
  },
  get archivePlayer() {
    return archivePlayer;
  },
  get element() {
    return element;
  },
  get backgroundSuspension() {
    return backgroundSuspension;
  },
  get primaryPage() {
    return pageState.primaryPage;
  },
  get notice() {
    return notice;
  },
  get playbackAction() {
    return playbackAction;
  },
  get archiveSearch() {
    return archiveSearch;
  },
  get diagnostics() {
    return diagnostics;
  },
  get accountPlayer() {
    return accountPlayer;
  },
  get activityWake() {
    return activityWake;
  },
  get backgroundLiveChoice() {
    return backgroundLiveChoice;
  },
  get archiveBackgroundPaused() {
    return library.archiveBackgroundPaused;
  },
  get archiveResumeChoice() {
    return library.archiveResumeChoice;
  },
  get updatePreviewControl() {
    return updatePreviewControl;
  },
  get localStreams() {
    return localStreams;
  },
  get vodStopControl() {
    return vodStopControl;
  },
  get accountVodSelected() {
    return accountVodSelected;
  },
  get accountBrowser() {
    return accountBrowser;
  },
  get accountPreferenceWork() {
    return accountPreferenceWork;
  },
  get settings() {
    return settings;
  },
  get castButton() {
    return castButton;
  },
  get castingAvailable() {
    return castingAvailable;
  },
  get privatePlayback() {
    return privatePlayback;
  },
  get renderedSelection() {
    return renderedSelection;
  },
  set renderedSelection(value) {
    renderedSelection = value;
  },
  get guide() {
    return guide;
  },
  get browser() {
    return browser;
  },
  get catalog() {
    return catalog;
  },
  get persistedCatalogRevision() {
    return persistedCatalogRevision;
  },
  get scanController() {
    return scanController;
  },
  get sharingBridge() {
    return sharingBridge;
  },
  get catalogWrites() {
    return catalogWrites;
  },
  set catalogWrites(value) {
    catalogWrites = value;
  },
});
const { renderPlayer, vodRewind, renderVODTransport, disposeVODTransport, playbackHealth } =
  playerView;

element('genxtra-button').addEventListener('click', () => playbackAction(switchLibrary('genxtra')));
element('search-programs').addEventListener('click', () => {
  if (library.contentLibrary === 'genxtra') playbackAction(archiveSearch!.searchOnline());
  // Paid channels come from the account's own import, never the public scan.
  else if (accountBrowser.selectedAccount) {
    element('settings-button').click();
    document.querySelector<HTMLButtonElement>('[data-settings-section="sources"]')?.click();
  } else startInlineDiscovery();
});
element('search').addEventListener('input', () => {
  const query = element<HTMLInputElement>('search').value;
  libraryQueries[library.contentLibrary] = query;
  if (library.contentLibrary === 'genxtra') renderArchiveDiscovery(archiveDiscovery.snapshot);
  if (library.contentLibrary === 'live') browser.search(query);
  element('search-programs').hidden = false;
  element('clear-search').hidden = query.length === 0;
});
element('clear-search').addEventListener('click', () => {
  const search = element<HTMLInputElement>('search');
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  if (library.contentLibrary === 'genxtra' && element('app').dataset.deviceKind === 'tv')
    remoteEditMode.navigate(search);
  element(library.contentLibrary === 'live' ? 'channel-list' : 'search').focus({
    preventScroll: true,
  });
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
const importController = createImportController({
  get fileImportTarget() {
    return fileImportTarget;
  },
  get catalog() {
    return catalog;
  },
  get element() {
    return element;
  },
  get importDialog() {
    return importDialog;
  },
  get addChannelsEntryGeneration() {
    return addChannelsEntryGeneration;
  },
  set addChannelsEntryGeneration(value) {
    addChannelsEntryGeneration = value;
  },
  get applicationClosing() {
    return applicationClosing;
  },
  get importRunning() {
    return importRunning;
  },
  get transferBusy() {
    return transferBusy;
  },
  get scanController() {
    return scanController;
  },
  get addChannelsEntryWork() {
    return addChannelsEntryWork;
  },
  set addChannelsEntryWork(value) {
    addChannelsEntryWork = value;
  },
  get backgroundSuspension() {
    return backgroundSuspension;
  },
  get nativeViewingForeground() {
    return nativeViewingForeground;
  },
  get foregroundGeneration() {
    return foregroundGeneration;
  },
  get scanProviderSources() {
    return scanProviderSources;
  },
  get supportsBoundedResume() {
    return supportsBoundedResume;
  },
  get ownImport() {
    return ownImport;
  },
  get playbackAction() {
    return playbackAction;
  },
  get refreshFileImportTargets() {
    return refreshFileImportTargets;
  },
  get rendererRecoveryPolicy() {
    return rendererRecoveryPolicy;
  },
  get sourceScan() {
    return sourceScan;
  },
  get contentLibrary() {
    return library.contentLibrary;
  },
  get primaryPage() {
    return pageState.primaryPage;
  },
  get addChannelsEntryController() {
    return addChannelsEntryController;
  },
  set addChannelsEntryController(value) {
    addChannelsEntryController = value;
  },
  get settings() {
    return settings;
  },
  set settings(value) {
    settings = value;
  },
  get prepareInlineScanEntry() {
    return prepareInlineScanEntry;
  },
  get inlineScanPanel() {
    return inlineScanPanel;
  },
  get onlineSourceDiscovery() {
    return onlineSourceDiscovery;
  },
  get notice() {
    return notice;
  },
  get saveSettings() {
    return saveSettings;
  },
  get updateImportActions() {
    return updateImportActions;
  },
  get cancelOnlineSourceEntry() {
    return cancelOnlineSourceEntry;
  },
  get refreshFreeTv() {
    return refreshFreeTv;
  },
  get catalogWrites() {
    return catalogWrites;
  },
  get customImportIntent() {
    return customImportIntent;
  },
  set customImportIntent(value) {
    customImportIntent = value;
  },
  get friendlyError() {
    return friendlyError;
  },
  get collectionAbort() {
    return collectionAbort;
  },
  set collectionAbort(value) {
    collectionAbort = value;
  },
  get setImportBusy() {
    return setImportBusy;
  },
  get refreshSource() {
    return refreshSource;
  },
  get preferences() {
    return preferences;
  },
  get applySettings() {
    return applySettings;
  },
  get renderCatalog() {
    return renderCatalog;
  },
  get guideController() {
    return guideController;
  },
  get visibleGuide() {
    return visibleGuideState.visibleGuide;
  },
  get guide() {
    return guide;
  },
  get bootstrapBoundary() {
    return bootstrapBoundary;
  },
  get automaticGuides() {
    return automaticGuides;
  },
  get diagnostics() {
    return diagnostics;
  },
});
const {
  withPausedGuideUpdates,
  wakeDailyRefresh,
  automaticGuideUpdates,
  startInlineDiscovery,
  dailyRefresh,
  dailyGuideRefresh,
  refreshAllSources,
  configuredImportEntry,
  requestCachedGuideConnection,
} = importController;

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
playerView.liveReplay = installLiveReplay(document, {
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
player.subscribe(() => playerView.liveReplay?.render());
element('pause-button').addEventListener('click', () => {
  if (playerView.liveReplay?.active()) return playerView.liveReplay.togglePause();
  if (player.snapshot.state === 'paused' || library.archiveBackgroundPaused || backgroundLiveChoice)
    playbackAction(resumeLocalPlayback());
  else playbackAction(pauseLocalPlayback());
});
element('retry-button').addEventListener('click', () => {
  if (player.snapshot.selection || library.archiveResumeChoice || backgroundLiveChoice)
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
const channelHealth = createChannelHealthController({
  get applicationClosing() {
    return applicationClosing;
  },
  get writeAccountPreference() {
    return writeAccountPreference;
  },
  get player() {
    return player;
  },
  get accountPlayer() {
    return accountPlayer;
  },
  get notice() {
    return notice;
  },
  get editPublicChannelGroup() {
    return editPublicChannelGroup;
  },
  get settings() {
    return settings;
  },
  get sharingBridge() {
    return sharingBridge;
  },
  get saveSettings() {
    return saveSettings;
  },
  get renderCatalog() {
    return renderCatalog;
  },
  get catalog() {
    return catalog;
  },
  get element() {
    return element;
  },
  get nativeViewingForeground() {
    return nativeViewingForeground;
  },
  get scanController() {
    return scanController;
  },
  get sourceScan() {
    return sourceScan;
  },
  get inspectStreamEvidence() {
    return inspectStreamEvidence;
  },
  get channelCheckMarks() {
    return channelCheckMarks;
  },
  set channelCheckMarks(value) {
    channelCheckMarks = value;
  },
  get slowChannelIds() {
    return slowChannelIds;
  },
  set slowChannelIds(value) {
    slowChannelIds = value;
  },
  get browser() {
    return browser;
  },
  get catalogBrowseViewRevision() {
    return catalogBrowseViewRevision;
  },
  set catalogBrowseViewRevision(value) {
    catalogBrowseViewRevision = value;
  },
  get contentLibrary() {
    return library.contentLibrary;
  },
  get accountBrowser() {
    return accountBrowser;
  },
  get addChannelsEntryWork() {
    return addChannelsEntryWork;
  },
  get startInlineDiscovery() {
    return startInlineDiscovery;
  },
  get playbackAction() {
    return playbackAction;
  },
});
const {
  channelCheckStore,
  savedChannelCheck,
  removeSavedChannel,
  presentNotResponding,
  refreshFreeTv,
} = channelHealth;

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
  library.libraryIntent++;
  library.liveBrowseSuspended = true;
  document.querySelector<HTMLElement>('.browser')!.inert = true;
  playerView.vodSeekGeneration++;
  renderVODTransport();
  if (archivePlayer?.selection) {
    library.archiveResumeChoice = archivePlayer.selection;
    library.archiveBackgroundPaused = true;
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
  pageState.primaryIntent++;
  collectionAbort?.abort();
  addChannelsEntryController?.abort();
  for (const sourceId of activeSources.keys()) refresh.cancel(sourceId);
  // Cancel acquisition and join playback/scan/guide suspension. Import
  // cancellation settles through its existing atomic publication flow.
  // Explicit LAN sharing keeps its separate service owner.
  backgroundSuspension = Promise.allSettled([
    playerView.vodSeekWork,
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
    pageState.primaryTransitions,
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
    visibleGuideState.visibleGuide?.suspend(),
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
  if (!document.querySelector('dialog[open]') && playerView.liveReplay?.back()) return;
  const modal = [
    ...document.querySelectorAll<HTMLDialogElement>('dialog[open]:not([data-primary-page])'),
  ].at(-1);
  // Full screen from the Guide's preview leaves to the Guide, not past it.
  if (
    !modal &&
    pageState.primaryPage === 'guide' &&
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
    pageState.primaryPage !== 'watch' &&
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
      if (library.contentLibrary === 'genxtra') {
        if (pageState.primaryPage === 'watch') await archiveSearch!.resume(libraryQueries.genxtra);
      } else {
        library.liveBrowseSuspended = false;
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
  library.libraryIntent++;
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
  playerView.healthCaptureClosing = true;
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
  void visibleGuideState.visibleGuide?.dispose().catch(() => undefined);
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
    library.libraryIntent++;
    for (const controller of publicGroupControllers) controller.abort();
    pageState.primaryIntent++;
    televisionSelects?.dispose();
    channelActions.dispose();
    void fullscreenOwner.close().catch(() => undefined);
    viewingWake?.freeze();
    for (const controller of startupJobs.values()) controller.abort();
    storageRecovery?.dispose();
    storageRecovery = undefined;
    playerView.healthCaptureClosing = true;
    // Startup may have made the shell inert; the close modal must remain reachable.
    element('app').inert = false;
    for (const region of document.querySelectorAll<HTMLElement>('.topbar,.workspace,dialog'))
      if (region.id !== 'close-dialog') region.inert = true;
    collectionAbort?.abort();
    importController.playlistExportController?.abort();
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
      importController.playlistExportController?.abort();
      await importController.playlistExportWork;
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
      await scanController.checkpointProgressCapture?.dispose();
      scanController.pendingManifestSeed = undefined;
    },
    () => savedChannelCheck.dispose(),
    () => probeScheduler.dispose(),
    () => speechSearch.dispose(),
    () => websiteDiscovery.dispose(),
    () => pageInput.cancel(),
    async () => {
      await pageState.primaryTransitions;
      await joinLibraryPersistence();
      await guide.dispose();
    },
    () => visibleGuideState.visibleGuide?.dispose(),
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
  library.archiveStorageEpoch++;
  library.archiveIndexRevision = null;
  clearArchiveResume();
  // Recovery can replace the canonical storage owner while revisions happen
  // to agree; a successful cache scope never crosses that re-initialization.
  guideController.lastCachedGuideConnection = null;
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
  library.contentLibrary = settings.contentLibrary === 'genxtra' ? 'genxtra' : 'live';
  library.liveBrowseSuspended = library.contentLibrary !== 'live';
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
      scanController.healthPlatform = info.platform;
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
    element<HTMLInputElement>('search').value = libraryQueries[library.contentLibrary];
    element('clear-search').hidden = !libraryQueries[library.contentLibrary];
    document.querySelector<HTMLElement>('.browser')!.inert = false;
    element('app').inert = false;
    element('app').dataset.ready = 'true';
    queueMicrotask(() => {
      if (archiveRuntimeScope()) playbackAction(archiveDownloads!.resume());
    });
    if (library.contentLibrary === 'live') {
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
