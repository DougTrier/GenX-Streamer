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
import { createChannelLogos } from './application/catalog/channel-logos';

import { createBootstrapBoundary } from './application/shell/bootstrap-boundary';
import { createRendererRecoveryPolicy } from './application/shell/renderer-recovery-policy';

import {
  createAccountPlayer,
  type AccountPlaybackChoice,
} from './application/accounts/account-player';
import { createArchivePlayer } from './application/genxtra/archive-player';

import { createArchiveDownloads } from './application/genxtra/archive-downloads';

import {
  createArchiveCatalog,
  type ArchiveDecade,
  type ArchiveContentType,
} from './platform/archive-catalog';
import { mountArchiveSearch } from './ui/genxtra/archive-search';

import { createAccountBrowser } from './application/accounts/account-browser';

import { createVpnStatus } from './platform/vpn-status';
import { mountVpnIndicator } from './ui/shell/vpn-indicator';
import { mountScanOverlay } from './ui/scan/scan-overlay';

import { createStartupObserver } from './application/shell/startup-view';

import { mountLibrarySwitcher } from './ui/genxtra/library-switcher';

import './ui/event-history.css';

import { mountVODStop } from './ui/player/vod-stop';

import { NativeSpeech } from './search/native-speech';
import { mountSpeechSearch } from './ui/channels/speech-search';
import { mountStorageRecovery } from './ui/settings/storage-recovery';
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

import { createSelectionSession } from './discovery/selection-session';

import { type ChannelCheck } from './platform/channel-checks';

import { invoke, isTauri } from '@tauri-apps/api/core';

import { createShell } from './ui/shell/shell';

import { type ChannelFilter } from './ui/channels/channel-browser';

import { type PlaybackSnapshot } from './playback/controller';

import { createNativeVideoBridge, nativeVideoAvailable } from './platform/native-video';

import { createNativePictureHost } from './ui/player/native-picture';

import { emptyCatalog, type CatalogRecord, type Source } from './catalog';

import { mountLocalStreams } from './ui/scan/local-streams';

// Last stylesheet: the shared pop-up look sits over every component sheet.
import './ui/dialog-polish.css';
import { createScanController } from './application/discovery/scan-controller';
import type { ContentLibrary } from './application/genxtra/content-library';

import { createGuideController } from './application/guide/guide-controller';
import { createChannelHealthController } from './application/health/channel-health-controller';
import { createImportController } from './application/discovery/import-controller';
import { createPlayerView } from './application/playback/player-view';
import { createGenxtraNavigation } from './application/genxtra/genxtra-navigation';
import { createLibraryState } from './application/genxtra/library-state';
import { createPageState } from './application/shell/page-state';
import { createVisibleGuideState } from './application/guide/visible-guide-state';
import { createVisibleGuideController } from './application/guide/visible-guide-controller';
import { createLibraryController } from './application/genxtra/library-controller';
import { createPageController } from './application/shell/page-controller';
import { createStartup } from './application/shell/startup';
import { createCloseController } from './application/shell/close-controller';
import { createForegroundController } from './application/shell/foreground-controller';
import { createSettingsController } from './application/shell/settings-controller';
import { createCatalogView } from './application/catalog/catalog-view';
import { createPlaybackControls } from './application/playback/playback-controls';
import { createAccountPlaybackSelection } from './application/accounts/account-playback-selection';
import { createChannelEdits } from './application/catalog/channel-edits';
import { createAccountScope } from './application/accounts/account-scope';
import { createSharedContext } from './application/shell/shared-context';
import { installPageHide } from './application/shell/page-hide';
import { installSettingsFile } from './application/shell/settings-file';
import { installPanelDivider } from './application/shell/panel-divider';
import { installMainScreenControls } from './application/shell/main-screen-controls';
import { createAddChannelsEntry } from './application/discovery/add-channels-entry';
import { createCatalogRefresh } from './application/discovery/catalog-refresh';
import { createMediaKeys } from './application/playback/media-keys';
import { createGuideViews } from './application/guide/guide-views';
import { createAccountSetup } from './application/accounts/account-setup';
import { createChannelListControls } from './application/catalog/channel-list-controls';
import { createChannelBrowserSetup } from './application/catalog/channel-browser-setup';
import { createAccountPreferencesController } from './application/accounts/account-preferences-controller';
import { createSourceFinder } from './application/discovery/source-finder';
import { createDataTransferSetup } from './application/catalog/data-transfer-setup';
import { createViewingWakeSetup } from './application/playback/viewing-wake-setup';
import { createSharingAndCasting } from './application/sharing/sharing-and-casting';
import { createPreferencesSetup } from './application/shell/preferences-setup';
import { createPlaybackSetup } from './application/playback/playback-setup';
import { createShellSetup } from './application/shell/shell-setup';

/**
 * The application context: everything the area controllers share with the
 * rest of the application. The first list says where each value lives (read
 * when a controller uses it); the second lists the values controllers may
 * assign. Each controller declares, in its own environment type, the subset
 * it uses.
 */
const app = createSharedContext(
  {
    accountBrowser: () => accountBrowser,
    accountControls: () => accountControls,
    accountPlayer: () => accountPlayer,
    accountPreferenceOwner: () => accountPreferencesController.accountPreferenceOwner,
    accountPreferenceWork: () => accountPreferencesController.accountPreferenceWork,
    accountVodSelected: () => accountVodSelected,
    activeSources: () => activeSources,
    activityWake: () => activityWake,
    addChannelsEntry: () => addChannelsEntry,
    addChannelsEntryController: () => addChannelsEntry.addChannelsEntryController,
    addChannelsEntryGeneration: () => addChannelsEntry.addChannelsEntryGeneration,
    addChannelsEntryWork: () => addChannelsEntry.addChannelsEntryWork,
    admitForegroundPlayback: () => admitForegroundPlayback,
    adoptIncludedHttp: () => adoptIncludedHttp,
    applicationClosing: () => applicationClosing,
    applySettings: () => applySettings,
    archiveActiveScope: () => archiveActiveScope,
    archiveBackgroundPaused: () => library.archiveBackgroundPaused,
    archiveCatalog: () => archiveCatalog,
    archiveDiscovery: () => archiveDiscovery,
    archiveDownloads: () => archiveDownloads,
    archivePlayer: () => archivePlayer,
    archiveResumeChoice: () => library.archiveResumeChoice,
    archiveRuntimeScope: () => archiveRuntimeScope,
    archiveSearch: () => archiveSearch,
    audioDiagnostics: () => audioDiagnostics,
    automaticGuides: () => automaticGuides,
    automaticGuideUpdates: () => automaticGuideUpdates,
    backgroundLiveChoice: () => backgroundLiveChoice,
    backgroundSuspension: () => backgroundSuspension,
    bootstrapBoundary: () => bootstrapBoundary,
    browser: () => browser,
    cancelOnlineSourceEntry: () => cancelOnlineSourceEntry,
    castButton: () => castButton,
    castingAvailable: () => sharingAndCasting.castingAvailable,
    castsActive: () => sharingAndCasting.castsActive,
    catalog: () => catalog,
    catalogBrowseReady: () => catalogBrowseReady,
    catalogBrowseViewRevision: () => catalogBrowseViewRevision,
    catalogRevision: () => catalogRevision,
    catalogWrites: () => catalogWrites,
    categoryMenu: () => categoryMenu,
    changeSound: () => changeSound,
    channelActions: () => channelActions,
    channelCheckMarks: () => channelCheckMarks,
    channelCheckStore: () => channelCheckStore,
    channelLogos: () => channelLogos,
    chooseCategory: () => chooseCategory,
    clearArchiveResume: () => clearArchiveResume,
    collectionAbort: () => collectionAbort,
    configuredImportEntry: () => configuredImportEntry,
    contentLibrary: () => library.contentLibrary,
    customImportIntent: () => addChannelsEntry.customImportIntent,
    dailyGuideRefresh: () => dailyGuideRefresh,
    dailyRefresh: () => dailyRefresh,
    DEVICE_KIND_KEY: () => DEVICE_KIND_KEY,
    diagnostics: () => diagnostics,
    disposeVODTransport: () => disposeVODTransport,
    editPublicChannelGroup: () => editPublicChannelGroup,
    element: () => element,
    eventHistory: () => eventHistory,
    fileImportTarget: () => fileImportTarget,
    foregroundGeneration: () => foregroundGeneration,
    foregroundPlaybackAllowed: () => foregroundPlaybackAllowed,
    friendlyError: () => friendlyError,
    fullscreenOwner: () => fullscreenOwner,
    fullscreenPresentation: () => fullscreenPresentation,
    genxtraNavigation: () => genxtraNavigation,
    geographyControls: () => geographyControls,
    guide: () => guide,
    guideChannelLogos: () => guideChannelLogos,
    guideController: () => guideController,
    guideHost: () => guideHost,
    handleBack: () => handleBack,
    importController: () => importController,
    importDialog: () => importDialog,
    importJobs: () => importJobs,
    importRunning: () => importRunning,
    inlineScanPanel: () => inlineScanPanel,
    inspectStreamEvidence: () => inspectStreamEvidence,
    installCloseBridge: () => installCloseBridge,
    joinLibraryPersistence: () => joinLibraryPersistence,
    joinLiveBrowse: () => joinLiveBrowse,
    libraries: () => libraries,
    library: () => library,
    libraryQueries: () => libraryQueries,
    liveBrowseJobs: () => liveBrowseJobs,
    localStreams: () => localStreams,
    mutateCatalog: () => mutateCatalog,
    nativePicture: () => nativePicture,
    nativeViewingForeground: () => nativeViewingForeground,
    notice: () => notice,
    noticeTimer: () => noticeTimer,
    onlineSourceDiscovery: () => onlineSourceDiscovery,
    openAccountSettings: () => openAccountSettings,
    ownImport: () => ownImport,
    pageInput: () => pageInput,
    pageState: () => pageState,
    paidGuide: () => paidGuide,
    pauseLocalPlayback: () => pauseLocalPlayback,
    pendingAccountPlayback: () => pendingAccountPlayback,
    pendingPublicPlayback: () => pendingPublicPlayback,
    persistedCatalogRevision: () => persistedCatalogRevision,
    playAccountVod: () => playAccountVod,
    playbackAction: () => playbackAction,
    playbackAllowsHttp: () => playbackAllowsHttp,
    playbackHealth: () => playbackHealth,
    player: () => player,
    playerView: () => playerView,
    preferences: () => preferences,
    prepareInlineScanEntry: () => prepareInlineScanEntry,
    presentLibrary: () => presentLibrary,
    presentNotResponding: () => presentNotResponding,
    presentPrimaryPage: () => presentPrimaryPage,
    presentSound: () => presentSound,
    primaryHost: () => primaryHost,
    primaryPage: () => pageState.primaryPage,
    privatePlayback: () => privatePlayback,
    probeScheduler: () => probeScheduler,
    providerManagement: () => providerManagement,
    publicGroupControllers: () => publicGroupControllers,
    recordArchiveRevision: () => recordArchiveRevision,
    refresh: () => refresh,
    refreshAllSources: () => refreshAllSources,
    refreshFileImportTargets: () => refreshFileImportTargets,
    refreshFreeTv: () => refreshFreeTv,
    refreshSource: () => refreshSource,
    regionPreference: () => regionPreference,
    remoteEditMode: () => remoteEditMode,
    removeAbout: () => removeAbout,
    removeAudioTracks: () => removeAudioTracks,
    removeCaptions: () => removeCaptions,
    removeCasting: () => removeCasting,
    removeDataTransfer: () => removeDataTransfer,
    removeLocationDialog: () => removeLocationDialog,
    removeMediaKeys: () => removeMediaKeys,
    removeRemoteNavigation: () => removeRemoteNavigation,
    removeSavedChannel: () => removeSavedChannel,
    removeSettingsNavigation: () => removeSettingsNavigation,
    removeVideoQuality: () => removeVideoQuality,
    removeViewport: () => removeViewport,
    renderCatalog: () => renderCatalog,
    renderedSelection: () => renderedSelection,
    rendererRecoveryPolicy: () => rendererRecoveryPolicy,
    renderPlayer: () => renderPlayer,
    renderVODTransport: () => renderVODTransport,
    requestCachedGuideConnection: () => requestCachedGuideConnection,
    resumeLocalPlayback: () => resumeLocalPlayback,
    retryLocalPlayback: () => retryLocalPlayback,
    savedChannelCheck: () => savedChannelCheck,
    saveSettings: () => saveSettings,
    scanController: () => scanController,
    scanProviderSources: () => scanProviderSources,
    selectAccountPlayback: () => selectAccountPlayback,
    selectAccountScope: () => selectAccountScope,
    selectionEpisode: () => selectionEpisode,
    setImportBusy: () => setImportBusy,
    settings: () => preferencesSetup.settings,
    sharingBridge: () => sharingBridge,
    sharingPanel: () => sharingAndCasting.sharingPanel,
    slowChannelIds: () => slowChannelIds,
    soundNow: () => soundNow,
    sourceActivation: () => sourceActivation,
    sourceIndex: () => sourceIndex,
    sourceScan: () => sourceScan,
    speechSearch: () => speechSearch,
    startInlineDiscovery: () => startInlineDiscovery,
    startupJobs: () => startupJobs,
    startupObserver: () => startupObserver,
    stopLocalPlayback: () => stopLocalPlayback,
    storageRecovery: () => shellSetup.storageRecovery,
    supportsBoundedResume: () => supportsBoundedResume,
    switchLibrary: () => switchLibrary,
    switchPrimaryPage: () => switchPrimaryPage,
    televisionSelects: () => sharingAndCasting.televisionSelects,
    toggleChannelFavorite: () => toggleChannelFavorite,
    transferBusy: () => transferBusy,
    updateGuideForeground: () => updateGuideForeground,
    updateImportActions: () => updateImportActions,
    updatePreviewControl: () => updatePreviewControl,
    updateVisibleGuide: () => updateVisibleGuide,
    viewingChoices: () => channelListControls.viewingChoices,
    viewingForeground: () => viewingForeground,
    viewingWake: () => viewingWake,
    visibleGuide: () => visibleGuideState.visibleGuide,
    visibleGuideState: () => visibleGuideState,
    vodDock: () => vodDock,
    vodRewind: () => vodRewind,
    vodStopControl: () => vodStopControl,
    wakeDailyRefresh: () => wakeDailyRefresh,
    wakeTransportAdmission: () => wakeTransportAdmission,
    websiteDiscovery: () => websiteDiscovery,
    withPausedGuideUpdates: () => withPausedGuideUpdates,
    writeAccountPreference: () => writeAccountPreference,
  },
  {
    accountPlayer: (value: typeof accountPlayer) => (accountPlayer = value),
    addChannelsEntryController: (value: typeof addChannelsEntry.addChannelsEntryController) =>
      (addChannelsEntry.addChannelsEntryController = value),
    addChannelsEntryGeneration: (value: typeof addChannelsEntry.addChannelsEntryGeneration) =>
      (addChannelsEntry.addChannelsEntryGeneration = value),
    addChannelsEntryWork: (value: typeof addChannelsEntry.addChannelsEntryWork) =>
      (addChannelsEntry.addChannelsEntryWork = value),
    applicationClosing: (value: typeof applicationClosing) => (applicationClosing = value),
    archivePlayer: (value: typeof archivePlayer) => (archivePlayer = value),
    archiveSearch: (value: typeof archiveSearch) => (archiveSearch = value),
    backgroundLiveChoice: (value: typeof backgroundLiveChoice) => (backgroundLiveChoice = value),
    backgroundSuspension: (value: typeof backgroundSuspension) => (backgroundSuspension = value),
    castingAvailable: (value: typeof sharingAndCasting.castingAvailable) =>
      (sharingAndCasting.castingAvailable = value),
    catalog: (value: typeof catalog) => (catalog = value),
    catalogBrowseReady: (value: typeof catalogBrowseReady) => (catalogBrowseReady = value),
    catalogBrowseViewRevision: (value: typeof catalogBrowseViewRevision) =>
      (catalogBrowseViewRevision = value),
    catalogRevision: (value: typeof catalogRevision) => (catalogRevision = value),
    catalogWrites: (value: typeof catalogWrites) => (catalogWrites = value),
    channelCheckMarks: (value: typeof channelCheckMarks) => (channelCheckMarks = value),
    channelLogos: (value: typeof channelLogos) => (channelLogos = value),
    collectionAbort: (value: typeof collectionAbort) => (collectionAbort = value),
    customImportIntent: (value: typeof addChannelsEntry.customImportIntent) =>
      (addChannelsEntry.customImportIntent = value),
    foregroundGeneration: (value: typeof foregroundGeneration) => (foregroundGeneration = value),
    importRunning: (value: typeof importRunning) => (importRunning = value),
    libraries: (value: typeof libraries) => (libraries = value),
    localStreams: (value: typeof localStreams) => (localStreams = value),
    nativeViewingForeground: (value: typeof nativeViewingForeground) =>
      (nativeViewingForeground = value),
    noticeTimer: (value: typeof noticeTimer) => (noticeTimer = value),
    pendingAccountPlayback: (value: typeof pendingAccountPlayback) =>
      (pendingAccountPlayback = value),
    pendingPublicPlayback: (value: typeof pendingPublicPlayback) => (pendingPublicPlayback = value),
    persistedCatalogRevision: (value: typeof persistedCatalogRevision) =>
      (persistedCatalogRevision = value),
    renderedSelection: (value: typeof renderedSelection) => (renderedSelection = value),
    selectionEpisode: (value: typeof selectionEpisode) => (selectionEpisode = value),
    settings: (value: typeof preferencesSetup.settings) => (preferencesSetup.settings = value),
    sharingPanel: (value: typeof sharingAndCasting.sharingPanel) =>
      (sharingAndCasting.sharingPanel = value),
    slowChannelIds: (value: typeof slowChannelIds) => (slowChannelIds = value),
    storageRecovery: (value: typeof shellSetup.storageRecovery) =>
      (shellSetup.storageRecovery = value),
    televisionSelects: (value: typeof sharingAndCasting.televisionSelects) =>
      (sharingAndCasting.televisionSelects = value),
    transferBusy: (value: typeof transferBusy) => (transferBusy = value),
    vodStopControl: (value: typeof vodStopControl) => (vodStopControl = value),
  },
);

const accountScope = createAccountScope(app);
const { selectAccountScope } = accountScope;

const channelEdits = createChannelEdits(app);
const { editPublicChannelGroup, publicGroupControllers, toggleChannelFavorite } = channelEdits;

const accountPlaybackSelection = createAccountPlaybackSelection(app);
const { selectAccountPlayback, playAccountVod } = accountPlaybackSelection;

const playbackControls = createPlaybackControls(app);
const {
  accountVodSelected,
  resumeLocalPlayback,
  pauseLocalPlayback,
  retryLocalPlayback,
  stopLocalPlayback,
} = playbackControls;

const catalogView = createCatalogView(app);
const { applySettings, friendlyError, notice, renderCatalog } = catalogView;

const settingsController = createSettingsController(app);
const { saveSettings, changeSound, soundNow, presentSound } = settingsController;

const startup = createStartup(app);
const { initialize } = startup;

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
const shellSetup = createShellSetup(app);
const {
  audioDiagnostics,
  categoryMenu,
  diagnostics,
  eventHistory,
  fullscreenPresentation,
  remoteEditMode,
  removeAbout,
  removeAudioTracks,
  removeCaptions,
  removeLocationDialog,
  removeRemoteNavigation,
  removeSettingsNavigation,
  removeVideoQuality,
  removeViewport,
  vodDock,
} = shellSetup;

const sourceAllowsHttp = (url: string): boolean =>
  catalog.sources.find((source) =>
    catalog.channels.some(
      (channel) => channel.sourceId === source.id && channel.urls.includes(url),
    ),
  )?.allowHttp ?? false;
// Bootstrap failure callbacks can run before these owners are constructed.
// Keep an initialized optional binding rather than a later const's temporal dead zone.
let accountPlayer: ReturnType<typeof createAccountPlayer> | undefined;
let archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
let localStreams: ReturnType<typeof mountLocalStreams> | undefined;
let vodStopControl: ReturnType<typeof mountVODStop> | undefined;
let archiveSearch: ReturnType<typeof mountArchiveSearch> | undefined;
// eslint-disable-next-line prefer-const -- assigned once, below; bootstrap failure callbacks read it before that
let archiveDownloads: ReturnType<typeof createArchiveDownloads> | undefined;
let channelLogos: ReturnType<typeof createChannelLogos> | undefined;
const library = createLibraryState();
const libraryQueries: Record<ContentLibrary, string> = { live: '', genxtra: '' };
const archiveCatalog = createArchiveCatalog();
// Bootstrap failure callbacks need the initialized optional binding above.
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
const playbackSetup = createPlaybackSetup(app);
const { player } = playbackSetup;

const preferencesSetup = createPreferencesSetup(app);
const { preferences, regionPreference } = preferencesSetup;

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
const sharingAndCasting = createSharingAndCasting(app);
const { castButton, playbackAction, removeCasting, sharingBridge } = sharingAndCasting;

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
const viewingWakeSetup = createViewingWakeSetup(app);
const { activityWake, viewingForeground, viewingWake, wakeTransportAdmission } = viewingWakeSetup;

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
const dataTransferSetup = createDataTransferSetup(app);
const { mutateCatalog, removeDataTransfer } = dataTransferSetup;

const scanController = createScanController(app);
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

// Assigned when account setup mounts the switcher; presentPrimaryPage may run before that.
let libraries: ReturnType<typeof mountLibrarySwitcher> | undefined;
const sourceFinder = createSourceFinder(app);
const { pageInput, websiteDiscovery } = sourceFinder;

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
const accountPreferencesController = createAccountPreferencesController(app);
const { writeAccountPreference } = accountPreferencesController;

const channelBrowserSetup = createChannelBrowserSetup(app);
const { browser } = channelBrowserSetup;

const channelListControls = createChannelListControls(app);
const { channelActions, geographyControls, providerManagement } = channelListControls;

const accountSetup = createAccountSetup(app);
const { accountControls, openAccountSettings } = accountSetup;

element('settings-button').addEventListener('click', openAccountSettings);
const speechSearch = mountSpeechSearch(
  element('speech-control'),
  element<HTMLInputElement>('search'),
  {
    recognizer: new NativeSpeech(),
    notice,
    language: () => navigator.language || 'en-US',
    cloudConsent: () => preferencesSetup.settings.voiceSearchConsent === true,
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
const guideController = createGuideController(app);
const { automaticGuides, guideHost } = guideController;
const pageState = createPageState();
const pageController = createPageController(app);
const { primaryHost, switchPrimaryPage, presentPrimaryPage, updatePreviewControl } = pageController;
const guideViews = createGuideViews(app);
const { guide, guideChannelLogos, paidGuide } = guideViews;

const libraryController = createLibraryController(app);
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

element('advanced-guide-button').addEventListener('click', () => {
  element<HTMLDialogElement>('settings-dialog').close();
  playbackAction(guide.openAdvanced());
  sharingAndCasting.televisionSelects?.refresh();
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
visibleGuideController = createVisibleGuideController(app);

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
const genxtraNavigationOwner = createGenxtraNavigation(app);
const { genxtraNavigation } = genxtraNavigationOwner;

document.addEventListener('keydown', genxtraNavigation, true);
const mediaKeys = createMediaKeys(app);
const { removeMediaKeys } = mediaKeys;

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
const catalogRefresh = createCatalogRefresh(app);
const { refresh, refreshSource, setImportBusy, updateImportActions } = catalogRefresh;

const playerView = createPlayerView(app);
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
const addChannelsEntry = createAddChannelsEntry(app);
const {
  cancelOnlineSourceEntry,
  fileImportTarget,
  importDialog,
  onlineSourceDiscovery,
  refreshFileImportTargets,
  sourceIndex,
} = addChannelsEntry;

const importController = createImportController(app);
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
installMainScreenControls(app);

const channelHealth = createChannelHealthController(app);
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
const foregroundController = createForegroundController(app);
const { fullscreenOwner, handleBack } = foregroundController;
installPanelDivider(app);

installSettingsFile(app);

installPageHide(app);

const closeController = createCloseController(app);
const { installCloseBridge } = closeController;

bootstrapBoundary.mounted();
void initialize().catch(() => {
  void diagnostics.emit({ operation: 'storage', level: 'error', code: 'storage-failed' });
  if (!applicationClosing)
    shellSetup.storageRecovery = mountStorageRecovery({ retry: () => initialize(true) });
});
