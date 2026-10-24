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
import { createAccountVault } from './platform/account-vault';
import { createAccountCatalog } from './platform/account-catalog';
import {
  createAccountPreferences,
  type AccountPreferencesMutation,
  type AccountPreferencesReceipt,
} from './platform/account-preferences';
import { mountAccountManagement } from './ui/accounts';

import { createActivityWakePolicy } from './application/activity-wake';

import { createStartupObserver } from './application/startup-view';
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

import { installFullscreenPresentation } from './ui/fullscreen-presentation';

import { installCategoryMenu } from './ui/category-menu';
import { installCaptions } from './ui/captions';

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

import { createShell } from './ui/shell';
import { mountAbout } from './ui/about';
import { ChannelBrowser, type ChannelFilter } from './ui/channel-browser';
import { queryCatalogPage } from './platform/catalog-query';

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
import { createStartup } from './application/startup';
import { createCloseController } from './application/close-controller';
import { createForegroundController } from './application/foreground-controller';
import { createSettingsController } from './application/settings-controller';
import { createCatalogView } from './application/catalog-view';
import { createPlaybackControls } from './application/playback-controls';
import { createAccountPlaybackSelection } from './application/account-playback-selection';
import { createChannelEdits } from './application/channel-edits';
import { createAccountScope } from './application/account-scope';

/**
 * The application context: everything the area controllers share with the
 * rest of the application, read when used (getters) and written back through
 * setters. Each controller declares, in its own environment type, the subset
 * it uses.
 */
const app = {
  get accountBrowser() {
    return accountBrowser;
  },
  get accountControls() {
    return accountControls;
  },
  get accountPlayer() {
    return accountPlayer;
  },
  get accountPreferenceOwner() {
    return accountPreferenceOwner;
  },
  get accountPreferenceWork() {
    return accountPreferenceWork;
  },
  get accountVodSelected() {
    return accountVodSelected;
  },
  get activeSources() {
    return activeSources;
  },
  get activityWake() {
    return activityWake;
  },
  get addChannelsEntryController() {
    return addChannelsEntryController;
  },
  set addChannelsEntryController(value) {
    addChannelsEntryController = value;
  },
  get addChannelsEntryGeneration() {
    return addChannelsEntryGeneration;
  },
  set addChannelsEntryGeneration(value) {
    addChannelsEntryGeneration = value;
  },
  get addChannelsEntryWork() {
    return addChannelsEntryWork;
  },
  set addChannelsEntryWork(value) {
    addChannelsEntryWork = value;
  },
  get admitForegroundPlayback() {
    return admitForegroundPlayback;
  },
  get adoptIncludedHttp() {
    return adoptIncludedHttp;
  },
  get applicationClosing() {
    return applicationClosing;
  },
  set applicationClosing(value) {
    applicationClosing = value;
  },
  get applySettings() {
    return applySettings;
  },
  get archiveActiveScope() {
    return archiveActiveScope;
  },
  get archiveBackgroundPaused() {
    return library.archiveBackgroundPaused;
  },
  get archiveCatalog() {
    return archiveCatalog;
  },
  get archiveDiscovery() {
    return archiveDiscovery;
  },
  get archiveDownloads() {
    return archiveDownloads;
  },
  get archivePlayer() {
    return archivePlayer;
  },
  get archiveResumeChoice() {
    return library.archiveResumeChoice;
  },
  get archiveRuntimeScope() {
    return archiveRuntimeScope;
  },
  get archiveSearch() {
    return archiveSearch;
  },
  set archiveSearch(value) {
    archiveSearch = value;
  },
  get audioDiagnostics() {
    return audioDiagnostics;
  },
  get automaticGuides() {
    return automaticGuides;
  },
  get automaticGuideUpdates() {
    return automaticGuideUpdates;
  },
  get backgroundLiveChoice() {
    return backgroundLiveChoice;
  },
  set backgroundLiveChoice(value) {
    backgroundLiveChoice = value;
  },
  get backgroundSuspension() {
    return backgroundSuspension;
  },
  set backgroundSuspension(value) {
    backgroundSuspension = value;
  },
  get bootstrapBoundary() {
    return bootstrapBoundary;
  },
  get browser() {
    return browser;
  },
  get cancelOnlineSourceEntry() {
    return cancelOnlineSourceEntry;
  },
  get castButton() {
    return castButton;
  },
  get castingAvailable() {
    return castingAvailable;
  },
  set castingAvailable(value) {
    castingAvailable = value;
  },
  get catalog() {
    return catalog;
  },
  set catalog(value) {
    catalog = value;
  },
  get catalogBrowseReady() {
    return catalogBrowseReady;
  },
  set catalogBrowseReady(value) {
    catalogBrowseReady = value;
  },
  get catalogBrowseViewRevision() {
    return catalogBrowseViewRevision;
  },
  set catalogBrowseViewRevision(value) {
    catalogBrowseViewRevision = value;
  },
  get catalogRevision() {
    return catalogRevision;
  },
  set catalogRevision(value) {
    catalogRevision = value;
  },
  get catalogWrites() {
    return catalogWrites;
  },
  set catalogWrites(value) {
    catalogWrites = value;
  },
  get categoryMenu() {
    return categoryMenu;
  },
  get channelActions() {
    return channelActions;
  },
  get channelCheckMarks() {
    return channelCheckMarks;
  },
  set channelCheckMarks(value) {
    channelCheckMarks = value;
  },
  get channelCheckStore() {
    return channelCheckStore;
  },
  get channelLogos() {
    return channelLogos;
  },
  get chooseCategory() {
    return chooseCategory;
  },
  get clearArchiveResume() {
    return clearArchiveResume;
  },
  get collectionAbort() {
    return collectionAbort;
  },
  set collectionAbort(value) {
    collectionAbort = value;
  },
  get configuredImportEntry() {
    return configuredImportEntry;
  },
  get contentLibrary() {
    return library.contentLibrary;
  },
  get customImportIntent() {
    return customImportIntent;
  },
  set customImportIntent(value) {
    customImportIntent = value;
  },
  get dailyGuideRefresh() {
    return dailyGuideRefresh;
  },
  get dailyRefresh() {
    return dailyRefresh;
  },
  get DEVICE_KIND_KEY() {
    return DEVICE_KIND_KEY;
  },
  get diagnostics() {
    return diagnostics;
  },
  get disposeVODTransport() {
    return disposeVODTransport;
  },
  get editPublicChannelGroup() {
    return editPublicChannelGroup;
  },
  get element() {
    return element;
  },
  get eventHistory() {
    return eventHistory;
  },
  get fileImportTarget() {
    return fileImportTarget;
  },
  get foregroundGeneration() {
    return foregroundGeneration;
  },
  set foregroundGeneration(value) {
    foregroundGeneration = value;
  },
  get friendlyError() {
    return friendlyError;
  },
  get fullscreenOwner() {
    return fullscreenOwner;
  },
  get fullscreenPresentation() {
    return fullscreenPresentation;
  },
  get genxtraNavigation() {
    return genxtraNavigation;
  },
  get geographyControls() {
    return geographyControls;
  },
  get guide() {
    return guide;
  },
  get guideChannelLogos() {
    return guideChannelLogos;
  },
  get guideController() {
    return guideController;
  },
  get importController() {
    return importController;
  },
  get importDialog() {
    return importDialog;
  },
  get importJobs() {
    return importJobs;
  },
  get importRunning() {
    return importRunning;
  },
  get inlineScanPanel() {
    return inlineScanPanel;
  },
  get inspectStreamEvidence() {
    return inspectStreamEvidence;
  },
  get installCloseBridge() {
    return installCloseBridge;
  },
  get joinLibraryPersistence() {
    return joinLibraryPersistence;
  },
  get joinLiveBrowse() {
    return joinLiveBrowse;
  },
  get libraries() {
    return libraries;
  },
  get library() {
    return library;
  },
  get libraryQueries() {
    return libraryQueries;
  },
  get liveBrowseJobs() {
    return liveBrowseJobs;
  },
  get localStreams() {
    return localStreams;
  },
  get nativeViewingForeground() {
    return nativeViewingForeground;
  },
  set nativeViewingForeground(value) {
    nativeViewingForeground = value;
  },
  get notice() {
    return notice;
  },
  get noticeTimer() {
    return noticeTimer;
  },
  set noticeTimer(value) {
    noticeTimer = value;
  },
  get onlineSourceDiscovery() {
    return onlineSourceDiscovery;
  },
  get openAccountSettings() {
    return openAccountSettings;
  },
  get ownImport() {
    return ownImport;
  },
  get pageInput() {
    return pageInput;
  },
  get pageState() {
    return pageState;
  },
  get paidGuide() {
    return paidGuide;
  },
  get pendingAccountPlayback() {
    return pendingAccountPlayback;
  },
  set pendingAccountPlayback(value) {
    pendingAccountPlayback = value;
  },
  get pendingPublicPlayback() {
    return pendingPublicPlayback;
  },
  set pendingPublicPlayback(value) {
    pendingPublicPlayback = value;
  },
  get persistedCatalogRevision() {
    return persistedCatalogRevision;
  },
  set persistedCatalogRevision(value) {
    persistedCatalogRevision = value;
  },
  get playbackAction() {
    return playbackAction;
  },
  get playbackHealth() {
    return playbackHealth;
  },
  get player() {
    return player;
  },
  get playerView() {
    return playerView;
  },
  get preferences() {
    return preferences;
  },
  get prepareInlineScanEntry() {
    return prepareInlineScanEntry;
  },
  get presentLibrary() {
    return presentLibrary;
  },
  get presentNotResponding() {
    return presentNotResponding;
  },
  get presentPrimaryPage() {
    return presentPrimaryPage;
  },
  get presentSound() {
    return presentSound;
  },
  get primaryHost() {
    return primaryHost;
  },
  get primaryPage() {
    return pageState.primaryPage;
  },
  get privatePlayback() {
    return privatePlayback;
  },
  get probeScheduler() {
    return probeScheduler;
  },
  get providerManagement() {
    return providerManagement;
  },
  get publicGroupControllers() {
    return publicGroupControllers;
  },
  get refresh() {
    return refresh;
  },
  get refreshFileImportTargets() {
    return refreshFileImportTargets;
  },
  get refreshFreeTv() {
    return refreshFreeTv;
  },
  get refreshSource() {
    return refreshSource;
  },
  get regionPreference() {
    return regionPreference;
  },
  get remoteEditMode() {
    return remoteEditMode;
  },
  get removeAudioTracks() {
    return removeAudioTracks;
  },
  get removeCaptions() {
    return removeCaptions;
  },
  get removeCasting() {
    return removeCasting;
  },
  get removeDataTransfer() {
    return removeDataTransfer;
  },
  get removeVideoQuality() {
    return removeVideoQuality;
  },
  get renderCatalog() {
    return renderCatalog;
  },
  get renderedSelection() {
    return renderedSelection;
  },
  set renderedSelection(value) {
    renderedSelection = value;
  },
  get rendererRecoveryPolicy() {
    return rendererRecoveryPolicy;
  },
  get renderPlayer() {
    return renderPlayer;
  },
  get renderVODTransport() {
    return renderVODTransport;
  },
  get requestCachedGuideConnection() {
    return requestCachedGuideConnection;
  },
  get savedChannelCheck() {
    return savedChannelCheck;
  },
  get saveSettings() {
    return saveSettings;
  },
  get scanController() {
    return scanController;
  },
  get scanProviderSources() {
    return scanProviderSources;
  },
  get selectAccountPlayback() {
    return selectAccountPlayback;
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
  get settings() {
    return settings;
  },
  set settings(value) {
    settings = value;
  },
  get sharingBridge() {
    return sharingBridge;
  },
  get sharingPanel() {
    return sharingPanel;
  },
  set sharingPanel(value) {
    sharingPanel = value;
  },
  get slowChannelIds() {
    return slowChannelIds;
  },
  set slowChannelIds(value) {
    slowChannelIds = value;
  },
  get sourceActivation() {
    return sourceActivation;
  },
  get sourceIndex() {
    return sourceIndex;
  },
  get sourceScan() {
    return sourceScan;
  },
  get speechSearch() {
    return speechSearch;
  },
  get startInlineDiscovery() {
    return startInlineDiscovery;
  },
  get startupJobs() {
    return startupJobs;
  },
  get startupObserver() {
    return startupObserver;
  },
  get storageRecovery() {
    return storageRecovery;
  },
  set storageRecovery(value) {
    storageRecovery = value;
  },
  get supportsBoundedResume() {
    return supportsBoundedResume;
  },
  get switchPrimaryPage() {
    return switchPrimaryPage;
  },
  get televisionSelects() {
    return televisionSelects;
  },
  set televisionSelects(value) {
    televisionSelects = value;
  },
  get transferBusy() {
    return transferBusy;
  },
  set transferBusy(value) {
    transferBusy = value;
  },
  get updateGuideForeground() {
    return updateGuideForeground;
  },
  get updateImportActions() {
    return updateImportActions;
  },
  get updatePreviewControl() {
    return updatePreviewControl;
  },
  get updateVisibleGuide() {
    return updateVisibleGuide;
  },
  get viewingChoices() {
    return viewingChoices;
  },
  get viewingForeground() {
    return viewingForeground;
  },
  get viewingWake() {
    return viewingWake;
  },
  get visibleGuide() {
    return visibleGuideState.visibleGuide;
  },
  get visibleGuideState() {
    return visibleGuideState;
  },
  get vodDock() {
    return vodDock;
  },
  get vodStopControl() {
    return vodStopControl;
  },
  get wakeDailyRefresh() {
    return wakeDailyRefresh;
  },
  get wakeTransportAdmission() {
    return wakeTransportAdmission;
  },
  get websiteDiscovery() {
    return websiteDiscovery;
  },
  get writeAccountPreference() {
    return writeAccountPreference;
  },
};

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
// eslint-disable-next-line prefer-const -- assigned once, below; bootstrap failure callbacks read it before that
let archiveDownloads: ReturnType<typeof createArchiveDownloads> | undefined;
// eslint-disable-next-line prefer-const -- assigned once, later; read before that
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

// Assigned once below; presentPrimaryPage may run before the switcher mounts.
// eslint-disable-next-line prefer-const -- read earlier by presentPrimaryPage
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
const guideController = createGuideController(app);
const { automaticGuides, guideHost } = guideController;
const pageState = createPageState();
const pageController = createPageController(app);
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
const closeController = createCloseController(app);
const { installCloseBridge } = closeController;

bootstrapBoundary.mounted();
void initialize().catch(() => {
  void diagnostics.emit({ operation: 'storage', level: 'error', code: 'storage-failed' });
  if (!applicationClosing)
    storageRecovery = mountStorageRecovery({ retry: () => initialize(true) });
});
