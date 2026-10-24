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
 * The main screen's buttons: refresh, the daily update choice, VOD stop,
 * live replay, pause, retry, mute, volume and favorite. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { migrateRefreshCadence, validateRefreshCadence } from '../catalog/refresh-cadence';
import { mountVODStop } from '../ui/vod-stop';
import { restoreRemoteFocus } from '../ui/remote-navigation';
import { installLiveReplay } from '../ui/live-replay';
import { type createImportController } from './import-controller';
import { type createSettingsController } from './settings-controller';
import { type createRendererRecoveryPolicy } from './renderer-recovery-policy';
import { type createCatalogView } from './catalog-view';
import { type createPlaybackControls } from './playback-controls';
import { type createPlayerView } from './player-view';
import { type createLibraryState } from './library-state';
import { type createChannelEdits } from './channel-edits';
import { type Preferences } from '../preferences';
import { type PlaybackController, type PlaybackSnapshot } from '../playback/controller';
import { type createArchivePlayer } from './archive-player';
import { type AccountPlaybackChoice } from './account-player';

/** What this area reads from, and writes back to, the rest of the application. */
export interface MainScreenControlsEnvironment {
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly dailyRefresh: ReturnType<typeof createImportController>['dailyRefresh'];
  readonly dailyGuideRefresh: ReturnType<typeof createImportController>['dailyGuideRefresh'];
  readonly saveSettings: ReturnType<typeof createSettingsController>['saveSettings'];
  readonly rendererRecoveryPolicy: ReturnType<typeof createRendererRecoveryPolicy>;
  readonly wakeDailyRefresh: ReturnType<typeof createImportController>['wakeDailyRefresh'];
  readonly notice: ReturnType<typeof createCatalogView>['notice'];
  readonly settings: Preferences;
  readonly playbackAction: (work: Promise<unknown>) => void;
  readonly ownImport: (work: Promise<void>) => Promise<void>;
  readonly refreshAllSources: ReturnType<typeof createImportController>['refreshAllSources'];
  vodStopControl: ReturnType<typeof mountVODStop> | undefined;
  readonly stopLocalPlayback: ReturnType<typeof createPlaybackControls>['stopLocalPlayback'];
  readonly renderPlayer: ReturnType<typeof createPlayerView>['renderPlayer'];
  readonly player: PlaybackController;
  readonly nativeViewingForeground: boolean;
  readonly backgroundSuspension: Promise<void> | null;
  readonly playerView: ReturnType<typeof createPlayerView>;
  readonly applicationClosing: boolean;
  readonly archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly backgroundLiveChoice:
    | { kind: 'public'; selection: NonNullable<PlaybackSnapshot['selection']> }
    | { kind: 'account'; choice: AccountPlaybackChoice }
    | null;
  readonly resumeLocalPlayback: ReturnType<typeof createPlaybackControls>['resumeLocalPlayback'];
  readonly pauseLocalPlayback: ReturnType<typeof createPlaybackControls>['pauseLocalPlayback'];
  readonly retryLocalPlayback: ReturnType<typeof createPlaybackControls>['retryLocalPlayback'];
  readonly changeSound: ReturnType<typeof createSettingsController>['changeSound'];
  readonly soundNow: ReturnType<typeof createSettingsController>['soundNow'];
  readonly toggleChannelFavorite: ReturnType<typeof createChannelEdits>['toggleChannelFavorite'];
}

export function installMainScreenControls(env: MainScreenControlsEnvironment): void {
  env.element('daily-source-refresh').addEventListener('change', async () => {
    const control = env.element<HTMLSelectElement>('daily-source-refresh');
    const cadence = validateRefreshCadence(control.value);
    control.disabled = true;
    try {
      await Promise.all([env.dailyRefresh.suspend(), env.dailyGuideRefresh.suspend()]);
      if (
        await env.saveSettings((draft) => {
          draft.sourceRefreshCadence = cadence;
          draft.automaticSourceRefresh = cadence !== 'off';
        })
      ) {
        if (cadence !== 'off') env.rendererRecoveryPolicy.authorize('update-settings');
        env.wakeDailyRefresh();
      }
    } catch {
      env.notice('Automatic update preference could not be saved. Try again.');
    } finally {
      control.value = migrateRefreshCadence(
        env.settings.sourceRefreshCadence,
        env.settings.automaticSourceRefresh,
      );
      control.disabled = false;
    }
  });
  for (const dialog of document.querySelectorAll('dialog'))
    dialog.addEventListener('close', env.wakeDailyRefresh);
  env.element('refresh-button').addEventListener('click', () => {
    env.rendererRecoveryPolicy.authorize('refresh');
    env.playbackAction(env.ownImport(env.refreshAllSources()));
  });
  env.vodStopControl = mountVODStop(env.element<HTMLButtonElement>('vod-stop'), {
    stop: env.stopLocalPlayback,
    changed: () => env.renderPlayer(env.player.snapshot),
    run: env.playbackAction,
    focusFallback: () => restoreRemoteFocus(env.element('mute-button')),
    canRestoreFocus: () => env.nativeViewingForeground && !env.backgroundSuspension,
  });
  env.playerView.liveReplay = installLiveReplay(document, {
    replay: () => env.player.liveReplay(),
    usable: () =>
      !env.applicationClosing &&
      !document.hidden &&
      env.nativeViewingForeground &&
      !env.backgroundSuspension &&
      !env.archivePlayer?.selection &&
      !!env.player.snapshot.selection &&
      env.player.snapshot.selection.playMode !== 'on-demand' &&
      ['playing', 'buffering'].includes(env.player.snapshot.state),
    notice: env.notice,
    focusFallback: () =>
      restoreRemoteFocus(env.element('pause-button'), env.element('mute-button')),
  });
  env.player.subscribe(() => env.playerView.liveReplay?.render());
  env.element('pause-button').addEventListener('click', () => {
    if (env.playerView.liveReplay?.active()) return env.playerView.liveReplay.togglePause();
    if (
      env.player.snapshot.state === 'paused' ||
      env.library.archiveBackgroundPaused ||
      env.backgroundLiveChoice
    )
      env.playbackAction(env.resumeLocalPlayback());
    else env.playbackAction(env.pauseLocalPlayback());
  });
  env.element('retry-button').addEventListener('click', () => {
    if (
      env.player.snapshot.selection ||
      env.library.archiveResumeChoice ||
      env.backgroundLiveChoice
    )
      env.playbackAction(env.retryLocalPlayback());
  });
  env
    .element('picture-resume')
    .addEventListener('click', () => env.element('pause-button').click());
  env.element('mute-button').addEventListener('click', () => {
    void env.changeSound({ muted: !env.soundNow().muted });
  });
  env.element('volume').addEventListener('change', () => {
    void env.changeSound({ volume: Number(env.element<HTMLInputElement>('volume').value) });
  });
  env.element('favorite-button').addEventListener('click', () => {
    const id = env.player.snapshot.selection?.id;
    if (!id) return;
    env.toggleChannelFavorite(id);
  });
}
