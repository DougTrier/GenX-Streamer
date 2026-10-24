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
 * Pause, resume, stop and retry for whatever is playing: live channels,
 * Paid TV and GenXtra titles. Moved out of main.ts. main.ts passes the shared
 * application context.
 */
import { type createSharingHost } from '../sharing/sharing-host';
import { type createLibraryState } from '../genxtra/library-state';
import { type PlaybackController, type PlaybackSnapshot } from '../../playback/controller';
import { type AccountPlaybackChoice, type createAccountPlayer } from '../accounts/account-player';
import { type createArchivePlayer } from '../genxtra/archive-player';
import { type mountLibrarySwitcher } from '../../ui/library-switcher';

/** What this area reads from, and writes back to, the rest of the application. */
export interface PlaybackControlsEnvironment {
  backgroundLiveChoice:
    | { kind: 'public'; selection: NonNullable<PlaybackSnapshot['selection']> }
    | { kind: 'account'; choice: AccountPlaybackChoice }
    | null;
  readonly archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
  readonly player: PlaybackController;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly clearArchiveResume: () => void;
  readonly accountPlayer: ReturnType<typeof createAccountPlayer> | undefined;
  readonly libraries: ReturnType<typeof mountLibrarySwitcher> | undefined;
  readonly backgroundSuspension: Promise<void> | null;
  readonly admitForegroundPlayback: () => void;
  readonly selectAccountPlayback: (
    channel: Parameters<ReturnType<typeof createAccountPlayer>['selectAccount']>[0],
    fence: Parameters<ReturnType<typeof createAccountPlayer>['selectAccount']>[1],
  ) => Promise<void>;
}

export function createPlaybackControls(env: PlaybackControlsEnvironment) {
  async function pauseLocalPlayback(): Promise<void> {
    if (env.backgroundLiveChoice) return;
    if (env.archivePlayer?.selection) await env.player.pause();
    else await env.sharingBridge.pause();
  }
  /** A Paid TV movie or episode is the current selection (it has a Stop button). */
  const accountVodSelected = () => !!env.player.snapshot.selection?.id.startsWith('vod:');
  async function stopLocalPlayback(): Promise<void> {
    env.backgroundLiveChoice = null;
    if (env.archivePlayer?.selection || env.library.archiveResumeChoice) {
      env.clearArchiveResume();
      await env.archivePlayer!.stop();
    } else if (accountVodSelected()) {
      // Stop a Paid TV movie and return to the titles, on the same poster.
      await env.accountPlayer!.stop();
      env.libraries?.showVodTitles();
    } else await env.sharingBridge.stop();
  }
  async function resumeLocalPlayback(): Promise<void> {
    if (env.backgroundSuspension) await env.backgroundSuspension;
    env.admitForegroundPlayback();
    if (env.backgroundLiveChoice) {
      const choice = env.backgroundLiveChoice;
      env.backgroundLiveChoice = null;
      if (choice.kind === 'account')
        await env.selectAccountPlayback(choice.choice.channel, choice.choice.fence);
      else await env.sharingBridge.select(choice.selection);
      return;
    }
    if (env.archivePlayer?.selection) {
      await env.player.resume();
      return;
    }
    if (env.library.archiveResumeChoice) {
      const choice = env.library.archiveResumeChoice;
      env.clearArchiveResume();
      await env.archivePlayer!.select(choice);
      return;
    }
    const account = env.accountPlayer?.selection;
    if (account) {
      // A paused local capability can expire. User Resume starts a fresh live
      // session through the same decoder owner instead of replaying a dead URL.
      await env.selectAccountPlayback(account.channel, account.fence);
    } else await env.sharingBridge.resume();
  }
  async function retryLocalPlayback(): Promise<void> {
    if (env.backgroundLiveChoice) return resumeLocalPlayback();
    const archived = env.archivePlayer?.selection ?? env.library.archiveResumeChoice;
    if (archived) {
      env.clearArchiveResume();
      await env.archivePlayer!.select(archived);
      return;
    }
    const account = env.accountPlayer?.selection;
    if (account) await env.selectAccountPlayback(account.channel, account.fence);
    else if (env.player.snapshot.selection)
      await env.sharingBridge.select(env.player.snapshot.selection);
  }
  return {
    accountVodSelected,
    resumeLocalPlayback,
    pauseLocalPlayback,
    retryLocalPlayback,
    stopLocalPlayback,
  };
}
