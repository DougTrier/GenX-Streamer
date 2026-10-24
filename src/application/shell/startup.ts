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
 * Start-up: opening storage, loading the saved catalog and settings, the
 * first screen, and recovering from a storage problem. Moved out of main.ts. main.ts passes the shared
 * application context.
 */
import { type createViewingWakeOwner } from '../../playback/viewing-wake-owner';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { type StartupAttempt, type createStartupObserver } from './startup-view';
import { readRecordPair } from '../../platform/records';
import { decodeSavedHealthInWorker } from '../health/health-history-read';
import { installInAppSelects } from '../../ui/shell/in-app-select';
import { mountSharingSettings } from '../../sharing/settings';
import { nativeScanCheckpointSummary } from '../../platform/scan-checkpoint-summary';
import { type createWakeTransportAdmission } from '../../playback/viewing-wake-startup';
import { type createLibraryController } from '../genxtra/library-controller';
import { type createRendererRecoveryPolicy } from './renderer-recovery-policy';
import { type createLibraryState } from '../genxtra/library-state';
import { type createGuideController } from '../guide/guide-controller';
import { type createActivityWakePolicy } from '../playback/activity-wake';
import { type createScanController } from '../discovery/scan-controller';
import { type createSharingHost } from '../sharing/sharing-host';
import { type createPageController } from './page-controller';
import { type createImportController } from '../discovery/import-controller';
import { type createChannelHealthController } from '../health/channel-health-controller';
import { type mountArchiveSearch } from '../../ui/genxtra/archive-search';
import { type createArchiveDownloads } from '../genxtra/archive-downloads';
import { type createArchivePlayer } from '../genxtra/archive-player';
import { type Preferences, type SerializedPreferencesStore } from '../../preferences';
import { type CatalogRecord } from '../../catalog';
import { type ContentLibrary } from '../genxtra/content-library';
import { type ChannelBrowser } from '../../ui/channels/channel-browser';
import { type mountLibrarySwitcher } from '../../ui/genxtra/library-switcher';
import { type mountStorageRecovery } from '../../ui/settings/storage-recovery';

/** What this area reads from, and writes back to, the rest of the application. */
export interface StartupEnvironment {
  readonly applicationClosing: boolean;
  readonly startupObserver: ReturnType<typeof createStartupObserver>;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly wakeTransportAdmission: ReturnType<typeof createWakeTransportAdmission>;
  readonly installCloseBridge: (attempt?: StartupAttempt) => Promise<void>;
  readonly viewingWake: ReturnType<typeof createViewingWakeOwner> | null;
  readonly viewingForeground: {
    setNativeForeground(active: boolean): Promise<void>;
    setDocumentVisible(active: boolean): Promise<void>;
    readonly admitted: boolean;
  } | null;
  readonly archiveSearch: ReturnType<typeof mountArchiveSearch> | undefined;
  readonly archiveDiscovery: ReturnType<typeof createLibraryController>['archiveDiscovery'];
  readonly archiveDownloads: ReturnType<typeof createArchiveDownloads> | undefined;
  readonly archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
  readonly joinLiveBrowse: ReturnType<typeof createLibraryController>['joinLiveBrowse'];
  readonly joinLibraryPersistence: ReturnType<
    typeof createLibraryController
  >['joinLibraryPersistence'];
  readonly startupJobs: Map<Promise<void>, AbortController>;
  readonly rendererRecoveryPolicy: ReturnType<typeof createRendererRecoveryPolicy>;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly clearArchiveResume: () => void;
  readonly guideController: ReturnType<typeof createGuideController>;
  persistedCatalogRevision: string;
  readonly notice: (message: string) => void;
  readonly friendlyError: (error: unknown) => string;
  settings: Preferences;
  readonly preferences: SerializedPreferencesStore;
  catalog: CatalogRecord;
  catalogRevision: number;
  catalogBrowseReady: boolean;
  readonly applySettings: () => void;
  castingAvailable: boolean;
  readonly DEVICE_KIND_KEY: string;
  readonly activityWake: ReturnType<typeof createActivityWakePolicy>;
  televisionSelects: ReturnType<typeof installInAppSelects> | undefined;
  readonly castButton: HTMLButtonElement;
  readonly scanController: ReturnType<typeof createScanController>;
  sharingPanel: ReturnType<typeof mountSharingSettings> | null;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  readonly sourceScan: ReturnType<typeof createScanController>['sourceScan'];
  readonly presentPrimaryPage: ReturnType<typeof createPageController>['presentPrimaryPage'];
  readonly presentLibrary: ReturnType<typeof createLibraryController>['presentLibrary'];
  readonly libraryQueries: Record<ContentLibrary, string>;
  readonly archiveRuntimeScope: () => string | null;
  readonly playbackAction: (work: Promise<unknown>) => void;
  readonly renderCatalog: () => void;
  readonly browser: ChannelBrowser;
  readonly archiveActiveScope: () => string | null;
  readonly requestCachedGuideConnection: ReturnType<
    typeof createImportController
  >['requestCachedGuideConnection'];
  readonly libraries: ReturnType<typeof mountLibrarySwitcher> | undefined;
  readonly updateVisibleGuide: () => void;
  storageRecovery: ReturnType<typeof mountStorageRecovery> | undefined;
  readonly adoptIncludedHttp: ReturnType<typeof createScanController>['adoptIncludedHttp'];
  readonly wakeDailyRefresh: ReturnType<typeof createImportController>['wakeDailyRefresh'];
  readonly savedChannelCheck: ReturnType<typeof createChannelHealthController>['savedChannelCheck'];
}

export function createStartup(env: StartupEnvironment) {
  function initialize(retryStorage = false): Promise<void> {
    if (env.applicationClosing) return Promise.reject(new Error('The application is closing.'));
    const controller = new AbortController();
    const attempt = env.startupObserver.begin();
    env.element('storage-status').textContent = 'Loading your channels\u2026';
    const work = Promise.resolve().then(async () => {
      await attempt.run('close-bridge', async () => {
        if (retryStorage) env.wakeTransportAdmission.retry();
        try {
          await env.installCloseBridge(attempt);
          // Release even if close has begun: the held disable must actually drain.
          env.wakeTransportAdmission.release();
        } catch (error) {
          env.wakeTransportAdmission.fail();
          throw error;
        }
        if (retryStorage && env.viewingWake?.snapshot().failed) await env.viewingWake.retry();
        await env.viewingForeground?.setDocumentVisible(!document.hidden);
        await env.viewingWake?.setActive(false);
      });
      controller.signal.throwIfAborted();
      if (retryStorage) {
        env.element('app').dataset.ready = 'false';
        await Promise.all([
          env.archiveSearch!.suspend(),
          env.archiveDiscovery.suspend(),
          env.archiveDownloads!.suspend(),
          env.archivePlayer!.stop(),
          env.joinLiveBrowse(),
          env.joinLibraryPersistence(),
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
    env.startupJobs.set(work, controller);
    void work.then(
      () => attempt.finish('completed'),
      (error: unknown) =>
        attempt.finish(
          controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')
            ? 'cancelled'
            : 'failed',
        ),
    );
    void work.finally(() => env.startupJobs.delete(work)).catch(() => {});
    return work;
  }
  async function initializeSaved(signal: AbortSignal, attempt: StartupAttempt): Promise<void> {
    await env.rendererRecoveryPolicy.initialize();
    signal.throwIfAborted();
    env.library.archiveStorageEpoch++;
    env.library.archiveIndexRevision = null;
    env.clearArchiveResume();
    // Recovery can replace the canonical storage owner while revisions happen
    // to agree; a successful cache scope never crosses that re-initialization.
    env.guideController.lastCachedGuideConnection = null;
    let startupPair: Awaited<ReturnType<typeof readRecordPair>>;
    let startupState: Awaited<ReturnType<typeof decodeSavedHealthInWorker>>;
    try {
      startupPair = await attempt.run('read-record-pair', () => readRecordPair());
      signal.throwIfAborted();
      env.persistedCatalogRevision = startupPair.catalogRevision;
      startupState = await attempt.run('health-decode', () =>
        decodeSavedHealthInWorker(startupPair, signal),
      );
    } catch (error) {
      signal.throwIfAborted();
      env.notice(`Saved data could not open. ${env.friendlyError(error)}`);
      env.element('storage-status').textContent =
        'Storage could not open. Use the recovery controls to retry or choose an available location.';
      throw error;
    }
    signal.throwIfAborted();
    try {
      env.settings = await attempt.run('preferences', () =>
        startupPair.preferences === null
          ? env.preferences.load()
          : env.preferences.replaceAtomically(
              JSON.parse(startupPair.preferences),
              async () => undefined,
            ),
      );
    } catch (error) {
      env.notice(`Saved settings need attention. ${env.friendlyError(error)}`);
    }
    signal.throwIfAborted();
    try {
      const record = startupPair.catalog;
      if (record !== null) {
        env.catalog = startupState.catalog;
        env.catalogRevision++;
      }
    } catch (error) {
      env.notice(`Saved channels need attention. ${env.friendlyError(error)}`);
    }
    // Select the saved library before applying settings can admit indexed browsing.
    env.library.contentLibrary = env.settings.contentLibrary === 'genxtra' ? 'genxtra' : 'live';
    env.library.liveBrowseSuspended = env.library.contentLibrary !== 'live';
    // Admit indexed browsing only after the paired catalog and preferences are available.
    env.catalogBrowseReady = true;
    await attempt.run('apply-settings', () => env.applySettings());
    if (isTauri()) {
      try {
        const capabilities = await attempt.run('capabilities', () =>
          invoke<{ isTelevision: boolean }>('device_capabilities'),
        );
        signal.throwIfAborted();
        if (typeof capabilities?.isTelevision !== 'boolean')
          throw new Error('Device capabilities are unavailable.');
        env.castingAvailable = !capabilities.isTelevision;
        env.element('app').dataset.deviceKind = capabilities.isTelevision ? 'tv' : 'personal';
        try {
          localStorage.setItem(env.DEVICE_KIND_KEY, env.element('app').dataset.deviceKind!);
        } catch {
          // Next launch simply waits for this answer again.
        }
        await env.activityWake.setTelevision(capabilities.isTelevision);
        env.televisionSelects?.dispose();
        env.televisionSelects = capabilities.isTelevision
          ? installInAppSelects(document.body)
          : undefined;
      } catch {
        env.castingAvailable = false;
        // Unconfirmed: no remembered layout stays applied.
        delete env.element('app').dataset.deviceKind;
      }
      env.castButton.hidden = !env.castingAvailable;
      env.castButton.disabled = !env.castingAvailable;
      try {
        const info = await attempt.run('runtime-info', () =>
          invoke<{ platform: string; dataMode: string }>('runtime_info'),
        );
        signal.throwIfAborted();
        if (!['windows', 'android', 'linux', 'macos', 'ios'].includes(info.platform))
          throw new Error('The native platform is unavailable.');
        env.scanController.healthPlatform = info.platform;
        env.element('storage-status').textContent = `${info.platform} · ${info.dataMode} storage`;
        if (info.platform === 'windows') {
          env.sharingPanel = mountSharingSettings(
            env.element('sharing-settings'),
            env.sharingBridge.host,
          );
          env.sharingBridge.bindBeforeSelection(
            env.sharingPanel.service.beforeSelection.bind(env.sharingPanel.service),
          );
        }
      } catch {
        env.element('storage-status').textContent = 'Native storage status unavailable.';
      }
    } else
      env.element('storage-status').textContent =
        'Browser development preview · saved on this browser';
    signal.throwIfAborted();
    if (isTauri()) {
      const scanGeneration = env.sourceScan.snapshot().generation;
      try {
        const summary = await attempt.run('scan-checkpoint-summary', () =>
          nativeScanCheckpointSummary.read(signal),
        );
        signal.throwIfAborted();
        env.sourceScan.presentSavedSummary(summary, scanGeneration);
      } catch {
        signal.throwIfAborted();
        env.notice('Saved scan progress could not be read. Your saved channels are retained.');
      }
    }
    await attempt.run('ready', () => {
      signal.throwIfAborted();
      if (env.applicationClosing) throw new DOMException('Startup canceled.', 'AbortError');
      // Startup has no previous interactive library to close. Joining browse,
      // guide or scan owners here can wait on this same bootstrap completing.
      env.presentPrimaryPage('watch');
      env.presentLibrary();
      env.element<HTMLInputElement>('search').value =
        env.libraryQueries[env.library.contentLibrary];
      env.element('clear-search').hidden = !env.libraryQueries[env.library.contentLibrary];
      document.querySelector<HTMLElement>('.browser')!.inert = false;
      env.element('app').inert = false;
      env.element('app').dataset.ready = 'true';
      queueMicrotask(() => {
        if (env.archiveRuntimeScope()) env.playbackAction(env.archiveDownloads!.resume());
      });
      if (env.library.contentLibrary === 'live') {
        env.renderCatalog();
        env.browser.search(env.libraryQueries.live);
      } else
        queueMicrotask(() => {
          if (env.archiveActiveScope())
            env.playbackAction(env.archiveSearch!.resume(env.libraryQueries.genxtra));
        });
      queueMicrotask(env.requestCachedGuideConnection);
      void env.libraries?.reload();
      env.updateVisibleGuide();
      env.storageRecovery?.dispose();
      env.storageRecovery = undefined;
      void env.adoptIncludedHttp().then(env.wakeDailyRefresh);
      if (isTauri() && env.rendererRecoveryPolicy.allowAutomaticWork())
        env.savedChannelCheck.start();
      if (!env.rendererRecoveryPolicy.allowAutomaticWork())
        env.notice(
          'Automatic updates are paused for this session. Use Scan or Refresh when you are ready.',
        );
    });
  }
  return {
    initialize,
  };
}
