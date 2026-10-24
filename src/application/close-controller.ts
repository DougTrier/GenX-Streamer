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
 * Closing the application: the close owner that stops every activity in
 * order, close progress, the exit command and the native close bridge.
 * Moved out of main.ts. main.ts passes the shared
 * application context.
 */
import { type createViewingWakeOwner } from '../playback/viewing-wake-owner';
import { createCloseFinalizationObserver } from './close-finalization';
import { createCloseProgressObserver } from './close-progress';
import { createCloseOwner, type CleanupToken } from './close-owner';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { mountExit } from '../ui/exit';
import { type StartupAttempt } from './startup-view';
import { listen } from '@tauri-apps/api/event';
import { type createLibraryState } from './library-state';
import { type createPageState } from './page-state';
import { type mountChannelActions } from '../ui/channel-actions';
import { type createFullscreenOwner } from '../ui/fullscreen-owner';
import { type createPlayerView } from './player-view';
import { type createImportController } from './import-controller';
import { type createGenxtraNavigation } from './genxtra-navigation';
import { type createLibraryController } from './library-controller';
import { type createChannelLogos } from './channel-logos';
import { type mountAccountManagement } from '../ui/accounts';
import { type createAccountBrowser } from './account-browser';
import { type createOnlineSourceScan } from '../discovery/online-source-scan';
import { type createSourceIndexService } from '../discovery/source-index-service';
import { type mountProviderManagement } from '../ui/provider-management';
import { type installVideoQuality } from '../ui/video-quality';
import { type installAudioTracks } from '../ui/audio-tracks';
import { type installAudioDiagnostics } from './audio-diagnostics';
import { type createGuideController } from './guide-controller';
import { type mountRegionPreference } from '../ui/region-preference';
import { type installCaptions } from '../ui/captions';
import { type createScanController } from './scan-controller';
import { type createChannelHealthController } from './channel-health-controller';
import { type mountSpeechSearch } from '../ui/speech-search';
import { type mountWebsiteDiscovery } from '../ui/website-discovery';
import { type createPageInput } from '../discovery/page-input';
import { type mountGuide } from '../ui/guide';
import { type createVisibleGuideState } from './visible-guide-state';
import { type installDataTransfer } from '../ui/data-transfer';
import { type installCasting } from '../ui/casting';
import { type createSharingHost } from './sharing-host';
import { type mountEventHistory } from '../ui/event-history';
import { type createDiagnostics } from '../diagnostics/native';
import { type createArchivePlayer } from './archive-player';
import { type installInAppSelects } from '../ui/in-app-select';
import { type mountStorageRecovery } from '../ui/storage-recovery';
import { type mountArchiveSearch } from '../ui/archive-search';
import { type createArchiveDownloads } from './archive-downloads';
import { type mountVODStop } from '../ui/vod-stop';
import { type AccountPreferencesReceipt } from '../platform/account-preferences';
import { type mountLibrarySwitcher } from '../ui/library-switcher';
import { type createAccountPlayer } from './account-player';
import { type ChannelBrowser } from '../ui/channel-browser';
import { type mountSharingSettings } from '../sharing/settings';
import { type CatalogRefreshService } from '../catalog';
import { type SerializedPreferencesStore } from '../preferences';

/** What this area reads from, and writes back to, the rest of the application. */
export interface CloseEnvironment {
  readonly archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
  applicationClosing: boolean;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly publicGroupControllers: Set<AbortController>;
  readonly pageState: ReturnType<typeof createPageState>;
  readonly televisionSelects: ReturnType<typeof installInAppSelects> | undefined;
  readonly channelActions: ReturnType<typeof mountChannelActions>;
  readonly fullscreenOwner: ReturnType<typeof createFullscreenOwner>;
  readonly viewingWake: ReturnType<typeof createViewingWakeOwner> | null;
  readonly startupJobs: Map<Promise<void>, AbortController>;
  storageRecovery: ReturnType<typeof mountStorageRecovery> | undefined;
  readonly playerView: ReturnType<typeof createPlayerView>;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly collectionAbort: AbortController | null;
  readonly importController: ReturnType<typeof createImportController>;
  readonly addChannelsEntryController: AbortController | null;
  readonly genxtraNavigation: ReturnType<typeof createGenxtraNavigation>['genxtraNavigation'];
  readonly disposeVODTransport: ReturnType<typeof createPlayerView>['disposeVODTransport'];
  readonly archiveSearch: ReturnType<typeof mountArchiveSearch> | undefined;
  readonly archiveDiscovery: ReturnType<typeof createLibraryController>['archiveDiscovery'];
  readonly archiveDownloads: ReturnType<typeof createArchiveDownloads> | undefined;
  readonly channelLogos: ReturnType<typeof createChannelLogos> | undefined;
  readonly guideChannelLogos: ReturnType<typeof createChannelLogos>;
  readonly vodStopControl: ReturnType<typeof mountVODStop> | undefined;
  readonly joinLiveBrowse: ReturnType<typeof createLibraryController>['joinLiveBrowse'];
  readonly accountPreferenceOwner: AbortController | null;
  readonly accountPreferenceWork: Promise<AccountPreferencesReceipt> | null;
  readonly accountControls: ReturnType<typeof mountAccountManagement>;
  readonly libraries: ReturnType<typeof mountLibrarySwitcher> | undefined;
  readonly openAccountSettings: () => void;
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  readonly accountPlayer: ReturnType<typeof createAccountPlayer> | undefined;
  readonly automaticGuideUpdates: ReturnType<
    typeof createImportController
  >['automaticGuideUpdates'];
  readonly cancelOnlineSourceEntry: () => Promise<void>;
  readonly onlineSourceDiscovery: ReturnType<typeof createOnlineSourceScan>;
  readonly sourceIndex: ReturnType<typeof createSourceIndexService>;
  readonly providerManagement: ReturnType<typeof mountProviderManagement>;
  readonly browser: ChannelBrowser;
  readonly removeVideoQuality: ReturnType<typeof installVideoQuality>;
  readonly removeAudioTracks: ReturnType<typeof installAudioTracks>;
  readonly audioDiagnostics: ReturnType<typeof installAudioDiagnostics>;
  readonly dailyRefresh: ReturnType<typeof createImportController>['dailyRefresh'];
  readonly dailyGuideRefresh: ReturnType<typeof createImportController>['dailyGuideRefresh'];
  readonly automaticGuides: ReturnType<typeof createGuideController>['automaticGuides'];
  readonly regionPreference: ReturnType<typeof mountRegionPreference>;
  readonly removeCaptions: ReturnType<typeof installCaptions>;
  readonly playbackHealth: ReturnType<typeof createPlayerView>['playbackHealth'];
  readonly sourceScan: ReturnType<typeof createScanController>['sourceScan'];
  readonly sourceActivation: ReturnType<typeof createScanController>['sourceActivation'];
  readonly scanController: ReturnType<typeof createScanController>;
  readonly savedChannelCheck: ReturnType<typeof createChannelHealthController>['savedChannelCheck'];
  readonly probeScheduler: ReturnType<typeof createScanController>['probeScheduler'];
  readonly speechSearch: ReturnType<typeof mountSpeechSearch>;
  readonly websiteDiscovery: ReturnType<typeof mountWebsiteDiscovery>;
  readonly pageInput: ReturnType<typeof createPageInput>;
  readonly joinLibraryPersistence: ReturnType<
    typeof createLibraryController
  >['joinLibraryPersistence'];
  readonly guide: ReturnType<typeof mountGuide>;
  readonly visibleGuideState: ReturnType<typeof createVisibleGuideState>;
  readonly removeDataTransfer: ReturnType<typeof installDataTransfer>;
  readonly removeCasting: ReturnType<typeof installCasting>;
  readonly sharingPanel: ReturnType<typeof mountSharingSettings> | null;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  readonly refresh: CatalogRefreshService;
  readonly configuredImportEntry: ReturnType<
    typeof createImportController
  >['configuredImportEntry'];
  readonly importJobs: Set<Promise<void>>;
  readonly catalogWrites: Promise<unknown>;
  readonly preferences: SerializedPreferencesStore;
  readonly eventHistory: ReturnType<typeof mountEventHistory>;
  readonly diagnostics: ReturnType<typeof createDiagnostics>;
  readonly notice: (message: string) => void;
  readonly playbackAction: (work: Promise<unknown>) => void;
}

export function createCloseController(env: CloseEnvironment) {
  const closeFinalization = createCloseFinalizationObserver();
  const closeProgress = createCloseProgressObserver();
  let archiveCloseStop: Promise<void> | null = null;
  const closeOwner = createCloseOwner({
    freeze: () => {
      // Capture the actual finite position before closing revokes the browsing scope.
      // Retain this original stop/save owner for the close sequence to join.
      const capturedStop = env.archivePlayer!.stop();
      archiveCloseStop = capturedStop;
      void capturedStop.catch(() => {
        // Only a settled failure permits a later close retry to drain again.
        if (archiveCloseStop === capturedStop) archiveCloseStop = null;
      });
      env.applicationClosing = true;
      env.library.libraryIntent++;
      for (const controller of env.publicGroupControllers) controller.abort();
      env.pageState.primaryIntent++;
      env.televisionSelects?.dispose();
      env.channelActions.dispose();
      void env.fullscreenOwner.close().catch(() => undefined);
      env.viewingWake?.freeze();
      for (const controller of env.startupJobs.values()) controller.abort();
      env.storageRecovery?.dispose();
      env.storageRecovery = undefined;
      env.playerView.healthCaptureClosing = true;
      // Startup may have made the shell inert; the close modal must remain reachable.
      env.element('app').inert = false;
      for (const region of document.querySelectorAll<HTMLElement>('.topbar,.workspace,dialog'))
        if (region.id !== 'close-dialog') region.inert = true;
      env.collectionAbort?.abort();
      env.importController.playlistExportController?.abort();
      env.addChannelsEntryController?.abort();
    },
    owners: [
      () => {
        document.removeEventListener('keydown', env.genxtraNavigation, true);
      },
      () =>
        Promise.all([
          archiveCloseStop ?? env.archivePlayer!.stop(),
          env.disposeVODTransport(),
        ]).then(() => undefined),
      () => env.archiveSearch!.dispose(),
      () => env.archiveDiscovery.dispose(),
      () => env.archiveDownloads!.dispose(),
      () => env.channelLogos?.dispose(),
      () => env.guideChannelLogos.dispose(),
      () => env.archivePlayer!.dispose(),
      () => env.vodStopControl?.dispose(),
      () => env.joinLiveBrowse(),
      async () => {
        env.accountPreferenceOwner?.abort();
        await env.accountPreferenceWork?.catch(() => undefined);
      },
      () => env.accountControls.dispose(),
      async () => {
        env.libraries?.dispose();
        env.element('settings-button').removeEventListener('click', env.openAccountSettings);
        await env.accountBrowser.dispose();
      },
      () => env.accountPlayer!.dispose(),
      () => env.automaticGuideUpdates.dispose(),
      async () => {
        await env.cancelOnlineSourceEntry();
        await env.onlineSourceDiscovery.dispose();
        await env.sourceIndex.dispose();
      },
      () => env.providerManagement.dispose(),
      async () => {
        env.importController.playlistExportController?.abort();
        await env.importController.playlistExportWork;
      },
      () => env.browser.dispose(),
      () => env.removeVideoQuality(),
      () => env.removeAudioTracks(),
      () => env.audioDiagnostics.dispose(),
      () => env.dailyRefresh.dispose(),
      () => env.dailyGuideRefresh.dispose(),
      () => env.automaticGuides.dispose(),
      () => env.regionPreference.dispose(),
      () => env.fullscreenOwner.close(),
      () => env.removeCaptions(),
      () => env.viewingWake?.close(),
      async () => {
        await Promise.allSettled([...env.startupJobs.keys()]);
      },
      () => env.playbackHealth.dispose(),
      async () => {
        await env.sourceScan.dispose();
        await env.sourceActivation.settleProgressCleanup();
      },
      async () => {
        await env.scanController.checkpointProgressCapture?.dispose();
        env.scanController.pendingManifestSeed = undefined;
      },
      () => env.savedChannelCheck.dispose(),
      () => env.probeScheduler.dispose(),
      () => env.speechSearch.dispose(),
      () => env.websiteDiscovery.dispose(),
      () => env.pageInput.cancel(),
      async () => {
        await env.pageState.primaryTransitions;
        await env.joinLibraryPersistence();
        await env.guide.dispose();
      },
      () => env.visibleGuideState.visibleGuide?.dispose(),
      () => env.removeDataTransfer(),
      () => env.removeCasting(),
      () => env.sharingPanel?.dispose(),
      () => env.sharingBridge.dispose(),
      async () => {
        env.collectionAbort?.abort();
        await env.refresh.dispose();
        await env.configuredImportEntry.dispose();
        const settled = await Promise.allSettled([...env.importJobs]);
        if (settled.some((result) => result.status === 'rejected'))
          throw new Error('Source activity cleanup could not be confirmed.');
      },
    ],
    acknowledge: async (token, result) => {
      if (result === 'drained') {
        // All producers have settled before capturing the final serialized queues.
        await closeFinalization.run('catalog-writes', () => env.catalogWrites);
        await closeFinalization.run('preferences', () => env.preferences.settledSnapshot());
        await closeFinalization.run('event-history', () => env.eventHistory.dispose());
        await closeFinalization.run('diagnostics', () => env.diagnostics.dispose());
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
    get: () => env.archivePlayer?.releaseTimings(),
  });
  Object.defineProperty(window, '__GENX_NATIVE_CLOSE__', {
    get: () => closeProgress.snapshot(),
    enumerable: false,
    configurable: false,
  });
  const removeExit = mountExit(env.element<HTMLButtonElement>('exit-button'), {
    native: isTauri,
    request: async () => {
      await installCloseBridge();
      await invoke('request_exit');
    },
    notice: env.notice,
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
            env.playbackAction(closeOwner.begin(event.payload));
          });
        await (attempt ? attempt.run('close-start-listen', register) : register());
        closeStartInstalled = true;
      }
      if (!closeBlockedInstalled) {
        const register = () =>
          listen('native-close-blocked', () => {
            const dialog = env.element<HTMLDialogElement>('close-dialog');
            if (!dialog.open) dialog.showModal();
          });
        await (attempt ? attempt.run('close-blocked-listen', register) : register());
        closeBlockedInstalled = true;
      }
      if (!closeActionsInstalled) {
        env.element('close-dialog').addEventListener('cancel', (event) => event.preventDefault());
        env.element('close-retry').addEventListener('click', () => {
          env.element<HTMLDialogElement>('close-dialog').close();
          void invoke('request_exit').catch(() => env.notice('Closing could not finish.'));
        });
        env.element('close-force').addEventListener('click', () => {
          void invoke('force_exit').catch(() => env.notice('Force quit could not finish.'));
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
  return {
    installCloseBridge,
  };
}
