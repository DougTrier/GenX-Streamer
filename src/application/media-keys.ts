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
 * Remote and keyboard media keys: play, pause, stop, channel up/down. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { installMediaKeys } from '../ui/media-keys';
import { type createPlayerView } from './player-view';
import { type createLibraryState } from './library-state';
import { type createPlaybackControls } from './playback-controls';
import { type createSettingsController } from './settings-controller';
import { type createForegroundController } from './foreground-controller';
import { type createCatalogView } from './catalog-view';
import { type PlaybackController, type PlaybackSnapshot } from '../playback/controller';
import { type AccountPlaybackChoice } from './account-player';
import { type ChannelBrowser } from '../ui/channel-browser';

/** What this area reads from, and writes back to, the rest of the application. */
export interface MediaKeysEnvironment {
  readonly playerView: ReturnType<typeof createPlayerView>;
  readonly player: PlaybackController;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly backgroundLiveChoice:
    | { kind: 'public'; selection: NonNullable<PlaybackSnapshot['selection']> }
    | { kind: 'account'; choice: AccountPlaybackChoice }
    | null;
  readonly resumeLocalPlayback: ReturnType<typeof createPlaybackControls>['resumeLocalPlayback'];
  readonly playbackAction: (work: Promise<unknown>) => void;
  readonly pauseLocalPlayback: ReturnType<typeof createPlaybackControls>['pauseLocalPlayback'];
  readonly retryLocalPlayback: ReturnType<typeof createPlaybackControls>['retryLocalPlayback'];
  readonly stopLocalPlayback: ReturnType<typeof createPlaybackControls>['stopLocalPlayback'];
  readonly changeSound: ReturnType<typeof createSettingsController>['changeSound'];
  readonly soundNow: ReturnType<typeof createSettingsController>['soundNow'];
  readonly browser: ChannelBrowser;
  readonly handleBack: ReturnType<typeof createForegroundController>['handleBack'];
  readonly vodRewind: ReturnType<typeof createPlayerView>['vodRewind'];
  readonly notice: ReturnType<typeof createCatalogView>['notice'];
}

export function createMediaKeys(env: MediaKeysEnvironment) {
  const removeMediaKeys = installMediaKeys({
    togglePause: () => {
      if (env.playerView.liveReplay?.active()) return env.playerView.liveReplay.togglePause();
      if (
        env.player.snapshot.state === 'paused' ||
        env.library.archiveBackgroundPaused ||
        env.backgroundLiveChoice
      )
        return env.resumeLocalPlayback();
      env.playbackAction(env.pauseLocalPlayback());
    },
    play: () => {
      if (env.playerView.liveReplay?.active()) return env.playerView.liveReplay.setPaused(false);
      if (
        env.player.snapshot.state === 'paused' ||
        env.library.archiveBackgroundPaused ||
        env.backgroundLiveChoice
      )
        return env.resumeLocalPlayback();
      if (env.player.snapshot.selection && ['failed', 'idle'].includes(env.player.snapshot.state))
        return env.retryLocalPlayback();
    },
    pause: () => {
      if (env.playerView.liveReplay?.active()) return env.playerView.liveReplay.setPaused(true);
      env.playbackAction(env.pauseLocalPlayback());
    },
    stop: () => env.stopLocalPlayback(),
    mute: async () => {
      await env.changeSound({ muted: !env.soundNow().muted });
    },
    volume: async (direction) => {
      await env.changeSound({
        volume: Math.max(0, Math.min(1, env.soundNow().volume + direction * 0.05)),
      });
    },
    channel: (direction) => {
      if (env.library.contentLibrary === 'live') env.browser.selectAdjacent(direction);
    },
    back: () => env.handleBack(),
    // On-demand videos go back 10 s; live channels start an instant replay.
    rewind: () => {
      if (env.player.snapshot.selection?.playMode === 'on-demand') return env.vodRewind();
      if (env.playerView.liveReplay) env.playbackAction(env.playerView.liveReplay.rewind());
    },
    failed: () => env.notice('The remote command could not finish. Try the on-screen control.'),
  });
  return {
    removeMediaKeys,
  };
}
