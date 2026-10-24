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
 * Starting a Paid TV channel or on-demand title from the list. Moved out of main.ts. main.ts passes the shared
 * application context.
 */
import { startTiming } from '../playback/start-timing';
import { type createSharingHost } from './sharing-host';
import { type AccountPlaybackChoice, type createAccountPlayer } from './account-player';
import { type PlaybackSnapshot } from '../playback/controller';
import { type createArchivePlayer } from './archive-player';

/** What this area reads from, and writes back to, the rest of the application. */
export interface AccountPlaybackSelectionEnvironment {
  readonly accountPlayer: ReturnType<typeof createAccountPlayer> | undefined;
  readonly admitForegroundPlayback: () => void;
  backgroundLiveChoice:
    | { kind: 'public'; selection: NonNullable<PlaybackSnapshot['selection']> }
    | { kind: 'account'; choice: AccountPlaybackChoice }
    | null;
  pendingPublicPlayback: {
    selection: NonNullable<PlaybackSnapshot['selection']>;
    sharingGeneration: number;
  } | null;
  readonly clearArchiveResume: () => void;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  pendingAccountPlayback: {
    choice: AccountPlaybackChoice;
    sharingGeneration: number;
  } | null;
  readonly archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
}

export function createAccountPlaybackSelection(env: AccountPlaybackSelectionEnvironment) {
  async function selectAccountPlayback(
    channel: Parameters<ReturnType<typeof createAccountPlayer>['selectAccount']>[0],
    fence: Parameters<ReturnType<typeof createAccountPlayer>['selectAccount']>[1],
  ): Promise<void> {
    startTiming.begin('account');
    env.admitForegroundPlayback();
    env.backgroundLiveChoice = null;
    env.pendingPublicPlayback = null;
    env.clearArchiveResume();
    const pending = {
      choice: { channel: { ...channel }, fence: { ...fence } },
      sharingGeneration: env.sharingBridge.host.snapshot().generation,
    };
    env.pendingAccountPlayback = pending;
    try {
      await env.archivePlayer!.handoff(async (signal) => {
        await env.sharingBridge.stop();
        if (env.pendingAccountPlayback === pending)
          pending.sharingGeneration = env.sharingBridge.host.snapshot().generation;
        signal.throwIfAborted();
        env.admitForegroundPlayback();
        await env.accountPlayer!.selectAccount(channel, fence, signal);
      });
    } finally {
      if (env.pendingAccountPlayback === pending) env.pendingAccountPlayback = null;
    }
  }
  async function playAccountVod(
    title: Parameters<ReturnType<typeof createAccountPlayer>['selectVod']>[0],
    account: Parameters<ReturnType<typeof createAccountPlayer>['selectVod']>[1],
  ): Promise<void> {
    env.admitForegroundPlayback();
    env.backgroundLiveChoice = env.pendingPublicPlayback = null;
    env.clearArchiveResume();
    await env.archivePlayer!.handoff(async (signal) => {
      await env.sharingBridge.stop();
      signal.throwIfAborted();
      env.admitForegroundPlayback();
      await env.accountPlayer!.selectVod(title, account, signal);
    });
  }
  return {
    selectAccountPlayback,
    playAccountVod,
  };
}
