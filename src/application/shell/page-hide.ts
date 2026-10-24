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
 * What happens when the page is hidden or unloaded: playback, scans and
 * writes are stopped and saved in order. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { type createViewingWakeOwner } from '../../playback/viewing-wake-owner';
import { type createLibraryState } from '../genxtra/library-state';
import { type createGenxtraNavigation } from '../genxtra/genxtra-navigation';
import { type createPlayerView } from '../playback/player-view';
import { type createLibraryController } from '../genxtra/library-controller';
import { type createChannelLogos } from '../catalog/channel-logos';
import { type createImportController } from '../discovery/import-controller';
import { type mountEventHistory } from '../../ui/settings/event-history';
import { type installAudioDiagnostics } from '../playback/audio-diagnostics';
import { type createDiagnostics } from '../../diagnostics/native';
import { type createGuideController } from '../guide/guide-controller';
import { type mountRegionPreference } from '../../ui/channels/region-preference';
import { type installVideoQuality } from '../../ui/player/video-quality';
import { type installAudioTracks } from '../../ui/player/audio-tracks';
import { type createChannelHealthController } from '../health/channel-health-controller';
import { type createScanController } from '../discovery/scan-controller';
import { type mountSpeechSearch } from '../../ui/channels/speech-search';
import { type mountWebsiteDiscovery } from '../../ui/scan/website-discovery';
import { type createPageInput } from '../../discovery/page-input';
import {
  type mountLocationDialog,
  type mountSettingsNavigation,
} from '../../ui/settings/settings-navigation';
import { type mountAbout } from '../../ui/settings/about';
import { type mountGeographyControls } from '../../ui/channels/geography-controls';
import { type mountGuide } from '../../ui/guide/guide';
import { type createVisibleGuideState } from '../guide/visible-guide-state';
import { type createOnlineSourceScan } from '../../discovery/online-source-scan';
import { type createSourceIndexService } from '../../discovery/source-index-service';
import { type installDataTransfer } from '../../ui/settings/data-transfer';
import { type installRemoteNavigation } from '../../ui/shell/remote-navigation';
import { type installViewport } from '../../ui/shell/viewport';
import { type installFullscreenPresentation } from '../../ui/player/fullscreen-presentation';
import { type installCaptions } from '../../ui/player/captions';
import { type createForegroundController } from './foreground-controller';
import { type installMediaKeys } from '../../ui/player/media-keys';
import { type installCasting } from '../../ui/player/casting';
import { type createSharingHost } from '../sharing/sharing-host';
import { type createArchivePlayer } from '../genxtra/archive-player';
import { type mountArchiveSearch } from '../../ui/genxtra/archive-search';
import { type createArchiveDownloads } from '../genxtra/archive-downloads';
import { type installInAppSelects } from '../../ui/shell/in-app-select';
import { type mountStorageRecovery } from '../../ui/settings/storage-recovery';
import { type mountViewingChoices } from '../../ui/channels/viewing-choices';
import { type CatalogRefreshService } from '../../catalog';
import { type ChannelBrowser } from '../../ui/channels/channel-browser';
import { type mountSharingSettings } from '../../sharing/settings';

/** What this area reads from, and writes back to, the rest of the application. */
export interface PageHideEnvironment {
  readonly archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
  applicationClosing: boolean;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly genxtraNavigation: ReturnType<typeof createGenxtraNavigation>['genxtraNavigation'];
  readonly disposeVODTransport: ReturnType<typeof createPlayerView>['disposeVODTransport'];
  readonly archiveSearch: ReturnType<typeof mountArchiveSearch> | undefined;
  readonly archiveDiscovery: ReturnType<typeof createLibraryController>['archiveDiscovery'];
  readonly archiveDownloads: ReturnType<typeof createArchiveDownloads> | undefined;
  readonly channelLogos: ReturnType<typeof createChannelLogos> | undefined;
  readonly guideChannelLogos: ReturnType<typeof createChannelLogos>;
  readonly joinLiveBrowse: ReturnType<typeof createLibraryController>['joinLiveBrowse'];
  readonly automaticGuideUpdates: ReturnType<
    typeof createImportController
  >['automaticGuideUpdates'];
  readonly eventHistory: ReturnType<typeof mountEventHistory>;
  readonly audioDiagnostics: ReturnType<typeof installAudioDiagnostics>;
  readonly diagnostics: ReturnType<typeof createDiagnostics>;
  readonly automaticGuides: ReturnType<typeof createGuideController>['automaticGuides'];
  readonly regionPreference: ReturnType<typeof mountRegionPreference>;
  readonly televisionSelects: ReturnType<typeof installInAppSelects> | undefined;
  readonly dailyRefresh: ReturnType<typeof createImportController>['dailyRefresh'];
  readonly dailyGuideRefresh: ReturnType<typeof createImportController>['dailyGuideRefresh'];
  readonly removeVideoQuality: ReturnType<typeof installVideoQuality>;
  readonly removeAudioTracks: ReturnType<typeof installAudioTracks>;
  readonly viewingWake: ReturnType<typeof createViewingWakeOwner> | null;
  readonly playerView: ReturnType<typeof createPlayerView>;
  readonly playbackHealth: ReturnType<typeof createPlayerView>['playbackHealth'];
  readonly savedChannelCheck: ReturnType<typeof createChannelHealthController>['savedChannelCheck'];
  readonly probeScheduler: ReturnType<typeof createScanController>['probeScheduler'];
  readonly speechSearch: ReturnType<typeof mountSpeechSearch>;
  readonly websiteDiscovery: ReturnType<typeof mountWebsiteDiscovery>;
  readonly pageInput: ReturnType<typeof createPageInput>;
  readonly storageRecovery: ReturnType<typeof mountStorageRecovery> | undefined;
  readonly removeSettingsNavigation: ReturnType<typeof mountSettingsNavigation>;
  readonly removeLocationDialog: ReturnType<typeof mountLocationDialog>;
  readonly removeAbout: ReturnType<typeof mountAbout>;
  readonly geographyControls: ReturnType<typeof mountGeographyControls>;
  readonly viewingChoices: ReturnType<typeof mountViewingChoices> | undefined;
  readonly guide: ReturnType<typeof mountGuide>;
  readonly visibleGuideState: ReturnType<typeof createVisibleGuideState>;
  readonly sourceScan: ReturnType<typeof createScanController>['sourceScan'];
  readonly cancelOnlineSourceEntry: () => Promise<void>;
  readonly onlineSourceDiscovery: ReturnType<typeof createOnlineSourceScan>;
  readonly sourceIndex: ReturnType<typeof createSourceIndexService>;
  readonly removeDataTransfer: ReturnType<typeof installDataTransfer>;
  readonly collectionAbort: AbortController | null;
  readonly refresh: CatalogRefreshService;
  readonly browser: ChannelBrowser;
  readonly removeRemoteNavigation: ReturnType<typeof installRemoteNavigation>;
  readonly removeViewport: ReturnType<typeof installViewport>;
  readonly fullscreenPresentation: ReturnType<typeof installFullscreenPresentation>;
  readonly removeCaptions: ReturnType<typeof installCaptions>;
  readonly fullscreenOwner: ReturnType<typeof createForegroundController>['fullscreenOwner'];
  readonly removeMediaKeys: ReturnType<typeof installMediaKeys>;
  readonly removeCasting: ReturnType<typeof installCasting>;
  readonly noticeTimer: ReturnType<typeof setTimeout> | undefined;
  readonly sharingPanel: ReturnType<typeof mountSharingSettings> | null;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
}

export function installPageHide(env: PageHideEnvironment): void {
  window.addEventListener('pagehide', () => {
    // Capture while the exact playback/storage scope is still admitted. Pagehide
    // cannot guarantee async delivery; retain the original stop for disposal to join.
    const archiveStop = env.archivePlayer?.stop();
    void archiveStop?.catch(() => undefined);
    env.applicationClosing = true;
    env.library.libraryIntent++;
    document.removeEventListener('keydown', env.genxtraNavigation, true);
    void env.disposeVODTransport().catch(() => undefined);
    void env.archiveSearch!.dispose().catch(() => undefined);
    void env.archiveDiscovery.dispose().catch(() => undefined);
    void env.archiveDownloads!.dispose().catch(() => undefined);
    void env.channelLogos?.dispose().catch(() => undefined);
    void env.guideChannelLogos.dispose().catch(() => undefined);
    void Promise.resolve(archiveStop)
      .then(
        () => env.archivePlayer?.dispose(),
        () => env.archivePlayer?.dispose(),
      )
      .catch(() => undefined);
    void env.joinLiveBrowse().catch(() => undefined);
    void env.automaticGuideUpdates.dispose().catch(() => undefined);
    void env.eventHistory
      .dispose()
      .then(() => env.audioDiagnostics.dispose())
      .then(() => env.diagnostics.dispose())
      .catch(() => undefined);
    void env.automaticGuides.dispose().catch(() => undefined);
    void env.regionPreference.dispose().catch(() => undefined);
    env.televisionSelects?.dispose();
    void env.dailyRefresh.dispose().catch(() => undefined);
    void env.dailyGuideRefresh.dispose().catch(() => undefined);
    env.removeVideoQuality();
    env.removeAudioTracks();
    void env.viewingWake?.close().catch(() => undefined);
    env.playerView.healthCaptureClosing = true;
    void env.playbackHealth.dispose().catch(() => undefined);
    void env.savedChannelCheck.dispose().catch(() => undefined);
    void env.probeScheduler.dispose().catch(() => undefined);
    void env.speechSearch.dispose().catch(() => undefined);
    void env.websiteDiscovery.dispose().catch(() => undefined);
    void env.pageInput.cancel().catch(() => undefined);
    env.storageRecovery?.dispose();
    env.removeSettingsNavigation();
    env.removeLocationDialog();
    env.removeAbout();
    env.geographyControls.dispose();
    env.viewingChoices?.dispose();
    void env.guide.dispose().catch(() => undefined);
    void env.visibleGuideState.visibleGuide?.dispose().catch(() => undefined);
    void env.sourceScan.dispose().catch(() => undefined);
    void env
      .cancelOnlineSourceEntry()
      .then(async () => {
        await env.onlineSourceDiscovery.dispose();
        await env.sourceIndex.dispose();
      })
      .catch(() => undefined);
    void env.removeDataTransfer().catch(() => undefined);
    env.collectionAbort?.abort();
    void env.refresh.dispose().catch(() => undefined);
    void env.browser.dispose().catch(() => undefined);
    env.removeRemoteNavigation();
    env.removeViewport();
    env.fullscreenPresentation.dispose();
    env.removeCaptions();
    env.fullscreenOwner.dispose();
    env.removeMediaKeys();
    void env.removeCasting().catch(() => undefined);
    clearTimeout(env.noticeTimer);
    if (env.sharingPanel) void env.sharingPanel.dispose().catch(() => undefined);
    void env.sharingBridge.dispose().catch(() => undefined);
  });
}
