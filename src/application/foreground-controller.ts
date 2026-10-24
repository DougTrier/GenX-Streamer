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
 * Foreground and background: full screen, pausing work when the app goes to
 * the background and resuming it, the Android activity lifecycle and the Back
 * key. Moved out of main.ts. main.ts passes the shared
 * application context.
 */
import { createFullscreenOwner } from '../ui/fullscreen-owner';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { installDoubleTapFullscreen } from '../ui/double-tap-fullscreen';
import { type installFullscreenPresentation } from '../ui/fullscreen-presentation';
import { type createPageController } from './page-controller';
import { type createLibraryState } from './library-state';
import { type createPlayerView } from './player-view';
import { type createSharingHost } from './sharing-host';
import { type createPageState } from './page-state';
import { type createLibraryController } from './library-controller';
import { type mountAccountManagement } from '../ui/accounts';
import { type createImportController } from './import-controller';
import { type createGuideController } from './guide-controller';
import { type mountRegionPreference } from '../ui/region-preference';
import { type createScanController } from './scan-controller';
import { type mountWebsiteDiscovery } from '../ui/website-discovery';
import { type mountGuide } from '../ui/guide';
import { type mountEventHistory } from '../ui/event-history';
import { type createVisibleGuideState } from './visible-guide-state';
import { type installDataTransfer } from '../ui/data-transfer';
import { type createPageInput } from '../discovery/page-input';
import { type createRemoteEditMode } from '../ui/remote-navigation';
import { type mountPaidGuide } from '../ui/paid-guide';
import { type createArchivePlayer } from './archive-player';
import { type AccountPlaybackChoice, type createAccountPlayer } from './account-player';
import { type PlaybackController, type PlaybackSnapshot } from '../playback/controller';
import { type CatalogRefreshService, type Source } from '../catalog';
import { type mountArchiveSearch } from '../ui/archive-search';
import { type createArchiveDownloads } from './archive-downloads';
import { type AccountPreferencesReceipt } from '../platform/account-preferences';
import { type mountLibrarySwitcher } from '../ui/library-switcher';
import { type ContentLibrary } from './content-library';

/** What this area reads from, and writes back to, the rest of the application. */
export interface ForegroundEnvironment {
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly notice: (message: string) => void;
  readonly fullscreenPresentation: ReturnType<typeof installFullscreenPresentation>;
  readonly updatePreviewControl: ReturnType<typeof createPageController>['updatePreviewControl'];
  backgroundSuspension: Promise<void> | null;
  foregroundGeneration: number;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly playerView: ReturnType<typeof createPlayerView>;
  readonly renderVODTransport: ReturnType<typeof createPlayerView>['renderVODTransport'];
  readonly archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  readonly pendingAccountPlayback: {
    choice: AccountPlaybackChoice;
    sharingGeneration: number;
  } | null;
  readonly pendingPublicPlayback: {
    selection: NonNullable<PlaybackSnapshot['selection']>;
    sharingGeneration: number;
  } | null;
  readonly accountPlayer: ReturnType<typeof createAccountPlayer> | undefined;
  backgroundLiveChoice:
    | { kind: 'public'; selection: NonNullable<PlaybackSnapshot['selection']> }
    | { kind: 'account'; choice: AccountPlaybackChoice }
    | null;
  readonly privatePlayback: (selection: PlaybackSnapshot['selection']) => boolean;
  readonly player: PlaybackController;
  readonly clearArchiveResume: () => void;
  readonly renderPlayer: ReturnType<typeof createPlayerView>['renderPlayer'];
  readonly publicGroupControllers: Set<AbortController>;
  readonly pageState: ReturnType<typeof createPageState>;
  readonly collectionAbort: AbortController | null;
  readonly addChannelsEntryController: AbortController | null;
  readonly activeSources: Map<string, Source>;
  readonly refresh: CatalogRefreshService;
  readonly archiveSearch: ReturnType<typeof mountArchiveSearch> | undefined;
  readonly archiveDiscovery: ReturnType<typeof createLibraryController>['archiveDiscovery'];
  readonly archiveDownloads: ReturnType<typeof createArchiveDownloads> | undefined;
  readonly joinLiveBrowse: ReturnType<typeof createLibraryController>['joinLiveBrowse'];
  readonly accountPreferenceOwner: AbortController | null;
  readonly accountPreferenceWork: Promise<AccountPreferencesReceipt> | null;
  readonly accountControls: ReturnType<typeof mountAccountManagement>;
  readonly cancelOnlineSourceEntry: () => Promise<void>;
  readonly joinLibraryPersistence: ReturnType<
    typeof createLibraryController
  >['joinLibraryPersistence'];
  readonly dailyRefresh: ReturnType<typeof createImportController>['dailyRefresh'];
  readonly dailyGuideRefresh: ReturnType<typeof createImportController>['dailyGuideRefresh'];
  readonly automaticGuides: ReturnType<typeof createGuideController>['automaticGuides'];
  readonly regionPreference: ReturnType<typeof mountRegionPreference>;
  readonly sourceScan: ReturnType<typeof createScanController>['sourceScan'];
  readonly websiteDiscovery: ReturnType<typeof mountWebsiteDiscovery>;
  readonly guide: ReturnType<typeof mountGuide>;
  readonly eventHistory: ReturnType<typeof mountEventHistory>;
  readonly visibleGuideState: ReturnType<typeof createVisibleGuideState>;
  readonly removeDataTransfer: ReturnType<typeof installDataTransfer>;
  readonly pageInput: ReturnType<typeof createPageInput>;
  readonly wakeDailyRefresh: ReturnType<typeof createImportController>['wakeDailyRefresh'];
  nativeViewingForeground: boolean;
  readonly updateGuideForeground: () => void;
  readonly viewingForeground: {
    setNativeForeground(active: boolean): Promise<void>;
    setDocumentVisible(active: boolean): Promise<void>;
    readonly admitted: boolean;
  } | null;
  readonly playbackAction: (work: Promise<unknown>) => void;
  readonly applicationClosing: boolean;
  readonly remoteEditMode: ReturnType<typeof createRemoteEditMode>;
  readonly primaryHost: ReturnType<typeof createPageController>['primaryHost'];
  readonly paidGuide: ReturnType<typeof mountPaidGuide>;
  readonly switchPrimaryPage: ReturnType<typeof createPageController>['switchPrimaryPage'];
  readonly libraries: ReturnType<typeof mountLibrarySwitcher> | undefined;
  readonly libraryQueries: Record<ContentLibrary, string>;
  readonly renderCatalog: () => void;
}

export function createForegroundController(env: ForegroundEnvironment) {
  const fullscreenOwner = createFullscreenOwner({
    apply: async (enabled) => {
      if (isTauri()) {
        await invoke('set_fullscreen', { enabled });
      } else if (enabled) await document.querySelector('.workspace')!.requestFullscreen();
      else if (document.fullscreenElement) await document.exitFullscreen();
    },
    changed: updateFullscreen,
  });
  env.element('fullscreen-button').addEventListener('click', async () => {
    try {
      await fullscreenOwner.toggle();
    } catch {
      env.notice('Full screen is unavailable in this environment.');
    }
  });
  // Touch screens: double tap the playing picture for full screen and back.
  installDoubleTapFullscreen(env.element('screen'), {
    playing: () => env.element('app').dataset.playerIdle !== 'true',
    toggle: () => env.element('fullscreen-button').click(),
  });
  function updateFullscreen(): void {
    const active = fullscreenOwner.active || !!document.fullscreenElement;
    env.fullscreenPresentation.set(active);
    env.updatePreviewControl();
    env.element('fullscreen-button').textContent = active ? 'Exit full screen' : 'Full screen';
    env.element('fullscreen-button').setAttribute('aria-pressed', String(active));
  }
  document.addEventListener('fullscreenchange', () => {
    if (!document.fullscreenElement) fullscreenOwner.nativeExited();
    updateFullscreen();
  });
  window.addEventListener('native-fullscreen-exited', () => {
    fullscreenOwner.nativeExited();
  });
  function suspendForegroundWork(): Promise<void> {
    if (env.backgroundSuspension) return env.backgroundSuspension;
    let suspensionConfirmed = false;
    env.foregroundGeneration++;
    env.library.libraryIntent++;
    env.library.liveBrowseSuspended = true;
    document.querySelector<HTMLElement>('.browser')!.inert = true;
    env.playerView.vodSeekGeneration++;
    env.renderVODTransport();
    if (env.archivePlayer?.selection) {
      env.library.archiveResumeChoice = env.archivePlayer.selection;
      env.library.archiveBackgroundPaused = true;
    }
    const publicSnapshot = env.sharingBridge.host.snapshot();
    const pendingAccount = env.pendingAccountPlayback;
    const pendingPublic = env.pendingPublicPlayback;
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
          : env.accountPlayer?.selection;
    if (accountChoice) env.backgroundLiveChoice = { kind: 'account', choice: accountChoice };
    else if (
      publicChoice &&
      !env.privatePlayback(publicChoice) &&
      (publicChoice.id !== env.player.snapshot.selection?.id ||
        env.player.snapshot.state === 'idle')
    )
      env.backgroundLiveChoice = { kind: 'public', selection: { ...publicChoice } };
    if (env.backgroundLiveChoice) env.clearArchiveResume();
    // A held native allocation may have no controller selection to publish yet.
    // Present its retained intent immediately, while the real cleanup stays joined.
    env.renderPlayer(env.player.snapshot);
    // Reserve account cancellation before Archive handoff abort callbacks run.
    // Every queued startup is joined, including allocations without a selection.
    const accountSuspension = env.accountPlayer!.suspend();
    for (const controller of env.publicGroupControllers) controller.abort();
    env.pageState.primaryIntent++;
    env.collectionAbort?.abort();
    env.addChannelsEntryController?.abort();
    for (const sourceId of env.activeSources.keys()) env.refresh.cancel(sourceId);
    // Cancel acquisition and join playback/scan/guide suspension. Import
    // cancellation settles through its existing atomic publication flow.
    // Explicit LAN sharing keeps its separate service owner.
    env.backgroundSuspension = Promise.allSettled([
      env.playerView.vodSeekWork,
      env.archiveSearch!.suspend(),
      env.archiveDiscovery.suspend(),
      env.archiveDownloads!.suspend(),
      env.archivePlayer!.stop(),
      env.joinLiveBrowse(),
      (async () => {
        env.accountPreferenceOwner?.abort();
        await env.accountPreferenceWork?.catch(() => undefined);
      })(),
      env.accountControls.suspend(),
      accountSuspension,
      env.cancelOnlineSourceEntry(),
      env.pageState.primaryTransitions,
      env.joinLibraryPersistence(),
      env.dailyRefresh.suspend(),
      env.dailyGuideRefresh.suspend(),
      env.automaticGuides.suspend(),
      env.regionPreference.suspend(),
      env.refresh.cancelAll(),
      env.sharingBridge.suspend(),
      env.sourceScan.suspend(),
      env.websiteDiscovery.suspend(),
      env.guide.suspend(),
      env.eventHistory.suspend(),
      env.visibleGuideState.visibleGuide?.suspend(),
      env.removeDataTransfer.suspend(),
      env.pageInput.cancel(),
    ])
      .then((results) => {
        if (results.some((result) => result.status === 'rejected'))
          throw new Error('Background activity cleanup could not be confirmed. Retry when ready.');
        suspensionConfirmed = true;
        env.renderPlayer(env.player.snapshot);
      })
      .finally(() => {
        env.backgroundSuspension = null;
        if (suspensionConfirmed) {
          resumeForegroundScan();
          queueMicrotask(env.wakeDailyRefresh);
        }
      });
    return env.backgroundSuspension;
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
    if (!acceptNativeActivityLifecycle(event, false) || !env.nativeViewingForeground) return;
    env.nativeViewingForeground = false;
    env.updateGuideForeground();
    void env.viewingForeground?.setNativeForeground(false).catch(() => undefined);
    env.playbackAction(suspendForegroundWork());
  });
  window.addEventListener('native-app-foreground', (event) => {
    if (
      !acceptNativeActivityLifecycle(event, true) ||
      env.nativeViewingForeground ||
      env.applicationClosing
    )
      return;
    env.nativeViewingForeground = true;
    env.updateGuideForeground();
    void env.viewingForeground?.setNativeForeground(true).catch(() => undefined);
    resumeForegroundScan();
    env.wakeDailyRefresh();
  });
  window.addEventListener('native-back-requested', (event) => {
    const requestId = (event as CustomEvent<{ requestId?: unknown }>).detail?.requestId;
    if (isTauri() && typeof requestId === 'string' && /^back-\d{1,20}$/.test(requestId))
      void invoke('acknowledge_back', { requestId }).catch(() =>
        env.notice('The Back request could not be acknowledged.'),
      );
    if (!event.defaultPrevented)
      void handleBack().catch(() => env.notice('Closing could not finish.'));
  });
  async function handleBack(): Promise<void> {
    if (env.remoteEditMode.exit()) return;
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
    if (!document.querySelector('dialog[open]') && env.playerView.liveReplay?.back()) return;
    const modal = [
      ...document.querySelectorAll<HTMLDialogElement>('dialog[open]:not([data-primary-page])'),
    ].at(-1);
    // Full screen from the Guide's preview leaves to the Guide, not past it.
    if (
      !modal &&
      env.pageState.primaryPage === 'guide' &&
      (fullscreenOwner.active || fullscreenOwner.busy || document.fullscreenElement)
    ) {
      await fullscreenOwner.set(false);
      return;
    }
    const dialog = modal ?? env.primaryHost.querySelector<HTMLDialogElement>('dialog[open]');
    if (dialog) {
      // Give the modal owner its cancellation/commit guard before changing visibility.
      if (dialog.dispatchEvent(new Event('cancel', { cancelable: true }))) dialog.close();
      return;
    }
    if (env.paidGuide.open) {
      await env.switchPrimaryPage('watch');
      return;
    }
    // Video On Demand steps out one level at a time.
    if (env.libraries?.vodBack()) return;
    if (env.archiveSearch?.dismissFilters()) return;
    if (fullscreenOwner.active || fullscreenOwner.busy || document.fullscreenElement) {
      await fullscreenOwner.set(false);
      return;
    }
    if (env.archiveSearch?.dismissEpisodes()) return;
    // Back unwinds viewing UI; closing the application requires explicit Exit.
    // At the main screen there is nothing left to dismiss.
  }
  document.addEventListener('keydown', (event) => {
    if (
      event.key === 'Escape' &&
      env.pageState.primaryPage !== 'watch' &&
      !document.querySelector('dialog[open]:not([data-primary-page])')
    ) {
      event.preventDefault();
      void handleBack().catch(() => env.notice('Closing could not finish.'));
      return;
    }
    if (
      event.key === 'Escape' &&
      env.element('app').dataset.vod === 'open' &&
      !fullscreenOwner.active &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      void handleBack().catch(() => env.notice('Closing could not finish.'));
      return;
    }
    if (
      event.key === 'Escape' &&
      (fullscreenOwner.active || fullscreenOwner.busy) &&
      !document.querySelector('dialog[open]')
    ) {
      event.preventDefault();
      void fullscreenOwner
        .set(false)
        .catch(() => env.notice('Leaving full screen could not finish.'));
    }
  });
  document.addEventListener('visibilitychange', () => {
    env.updateGuideForeground();
    void env.viewingForeground?.setDocumentVisible(!document.hidden).catch(() => undefined);
    if (document.hidden) env.playbackAction(suspendForegroundWork());
    else {
      resumeForegroundScan();
      env.wakeDailyRefresh();
    }
  });
  function resumeForegroundScan(): void {
    if (env.applicationClosing || document.hidden || !env.nativeViewingForeground) return;
    void Promise.resolve(env.backgroundSuspension)
      .then(async () => {
        if (env.applicationClosing || document.hidden || !env.nativeViewingForeground) return;
        document.querySelector<HTMLElement>('.browser')!.inert = false;
        await env.archiveDownloads!.resume();
        if (env.library.contentLibrary === 'genxtra') {
          if (env.pageState.primaryPage === 'watch')
            await env.archiveSearch!.resume(env.libraryQueries.genxtra);
        } else {
          env.library.liveBrowseSuspended = false;
          env.renderCatalog();
          await env.sourceScan.resume();
        }
      })
      .catch(() => env.notice('Scan progress could not resume. Use Continue scan to retry.'));
  }
  return {
    fullscreenOwner,
    handleBack,
  };
}
