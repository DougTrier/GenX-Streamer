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
 * LAN sharing, the archive player and casting. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { createSharingHost } from './sharing-host';
import { isTauri } from '@tauri-apps/api/core';
import { type mountSharingSettings } from '../../sharing/settings';
import { createArchivePlayer } from '../genxtra/archive-player';
import { createArchiveBookmarks } from '../../platform/archive-bookmarks';
import { chooseArchiveResume } from '../../ui/genxtra/archive-resume';
import { type installInAppSelects } from '../../ui/shell/in-app-select';
import { installCasting } from '../../ui/player/casting';
import { type createBootstrapBoundary } from '../shell/bootstrap-boundary';
import { type createSettingsController } from '../shell/settings-controller';
import { type createCatalogView } from '../catalog/catalog-view';
import { type createLibraryState } from '../genxtra/library-state';
import { type createLibraryController } from '../genxtra/library-controller';
import { type PlaybackController, type PlaybackSnapshot } from '../../playback/controller';
import { type AccountPlaybackChoice, type createAccountPlayer } from '../accounts/account-player';
import { type CatalogRecord } from '../../catalog';
import { type mountLocalStreams } from '../../ui/scan/local-streams';
import { type Preferences } from '../../preferences';
import { type mountArchiveSearch } from '../../ui/genxtra/archive-search';
import { type ContentLibrary } from '../genxtra/content-library';

/** What this area reads from, and writes back to, the rest of the application. */
export interface SharingAndCastingEnvironment {
  readonly bootstrapBoundary: ReturnType<typeof createBootstrapBoundary>;
  readonly player: PlaybackController;
  readonly foregroundPlaybackAllowed: () => boolean;
  readonly admitForegroundPlayback: () => void;
  pendingAccountPlayback: {
    choice: AccountPlaybackChoice;
    sharingGeneration: number;
  } | null;
  backgroundLiveChoice:
    | { kind: 'public'; selection: NonNullable<PlaybackSnapshot['selection']> }
    | { kind: 'account'; choice: AccountPlaybackChoice }
    | null;
  readonly clearArchiveResume: () => void;
  pendingPublicPlayback: {
    selection: NonNullable<PlaybackSnapshot['selection']>;
    sharingGeneration: number;
  } | null;
  readonly accountPlayer: ReturnType<typeof createAccountPlayer> | undefined;
  archivePlayer: ReturnType<typeof createArchivePlayer> | undefined;
  readonly privatePlayback: (selection: PlaybackSnapshot['selection']) => boolean;
  readonly catalog: CatalogRecord;
  readonly localStreams: ReturnType<typeof mountLocalStreams> | undefined;
  readonly settings: Preferences;
  readonly saveSettings: ReturnType<typeof createSettingsController>['saveSettings'];
  readonly applicationClosing: boolean;
  readonly notice: ReturnType<typeof createCatalogView>['notice'];
  readonly archiveRuntimeScope: () => string | null;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly recordArchiveRevision: ReturnType<
    typeof createLibraryController
  >['recordArchiveRevision'];
  readonly archiveActiveScope: () => string | null;
  readonly archiveSearch: ReturnType<typeof mountArchiveSearch> | undefined;
  readonly libraryQueries: Record<ContentLibrary, string>;
  readonly friendlyError: ReturnType<typeof createCatalogView>['friendlyError'];
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
}

export function createSharingAndCasting(env: SharingAndCastingEnvironment) {
  const sharingBridge = env.bootstrapBoundary.run('sharing', () =>
    createSharingHost({
      player: env.player,
      playbackAllowed: env.foregroundPlaybackAllowed,
      localSelection: {
        select: async (selection, recovery) => {
          env.admitForegroundPlayback();
          env.pendingAccountPlayback = null;
          env.backgroundLiveChoice = null;
          env.clearArchiveResume();
          const pending = {
            selection: { ...selection },
            sharingGeneration: sharingBridge.host.snapshot().generation,
          };
          env.pendingPublicPlayback = pending;
          try {
            if (!isTauri()) await env.accountPlayer!.selectPublic(selection, recovery);
            else
              await env.archivePlayer!.handoff((signal) =>
                env.accountPlayer!.selectPublic(selection, recovery, signal),
              );
          } finally {
            if (env.pendingPublicPlayback === pending) env.pendingPublicPlayback = null;
          }
        },
        stop: () => env.accountPlayer!.stop(),
      },
      publishSelectionAllowed: (selection) => !env.privatePlayback(selection),
      channels: () => env.catalog.channels,
      extraChannel: (id) => env.localStreams?.channel(id),
      settings: () => env.settings,
      saveAudio: async (patch, context, generation) => {
        const current = () =>
          !context?.signal.aborted && sharingBridge.host.snapshot().generation === generation;
        const guard = context
          ? async () => current() && (await context.authorized()) && current()
          : undefined;
        const saved = await env.saveSettings(
          (draft) => {
            if (context && !current())
              throw new DOMException('Phone action canceled.', 'AbortError');
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
  env.archivePlayer = createArchivePlayer({
    player: env.player,
    bookmarks: createArchiveBookmarks(),
    chooseResume: (selection, position, signal) =>
      chooseArchiveResume(selection.title, position.positionMs, signal, position.completed),
    bookmarkFailed: (message) => {
      if (!env.applicationClosing) env.notice(message);
    },
    readyScope: env.archiveRuntimeScope,
    catalogRevision: () => env.library.archiveIndexRevision,
    beforeStart: async (signal) => {
      signal.throwIfAborted();
      env.admitForegroundPlayback();
      env.backgroundLiveChoice = null;
      env.pendingAccountPlayback = null;
      env.pendingPublicPlayback = null;
      await sharingBridge.stop();
      signal.throwIfAborted();
      env.admitForegroundPlayback();
    },
    confirmedDead: (receipt) => {
      if (env.archiveRuntimeScope() === null) return;
      env.recordArchiveRevision(receipt.revision);
      env.notice(
        'The selected Archive file is no longer available and was removed from playable results.',
      );
      // Do not await the Archive UI's query lane from its own selection callback.
      queueMicrotask(() => {
        if (env.archiveActiveScope())
          void env.archiveSearch?.query(env.libraryQueries.genxtra).catch(() => undefined);
      });
    },
    failed: (message) => {
      if (!env.applicationClosing) env.notice(message);
    },
  });
  const playbackAction = (work: Promise<unknown>): void => {
    void work.catch((error: unknown) => env.notice(env.friendlyError(error)));
  };
  let castingAvailable = !isTauri();
  let televisionSelects: ReturnType<typeof installInAppSelects> | undefined;
  const castButton = env.element('cast-button') as HTMLButtonElement;
  castButton.hidden = !castingAvailable;
  castButton.disabled = !castingAvailable;
  const removeCasting = env.bootstrapBoundary.run('casting', () =>
    installCasting(
      () =>
        env.privatePlayback(env.player.snapshot.selection) ? null : env.player.snapshot.selection,
      (selected) =>
        env.catalog.sources.find((source) =>
          env.catalog.channels.some(
            (channel) => channel.sourceId === source.id && channel.id === selected.id,
          ),
        )?.allowHttp ?? false,
      {
        available: () =>
          castingAvailable &&
          !env.accountPlayer?.selection &&
          !env.archivePlayer?.selection &&
          !env.privatePlayback(env.player.snapshot.selection),
      },
    ),
  );
  return {
    castButton,
    get castingAvailable() {
      return castingAvailable;
    },
    set castingAvailable(value: typeof castingAvailable) {
      castingAvailable = value;
    },
    playbackAction,
    removeCasting,
    sharingBridge,
    get sharingPanel() {
      return sharingPanel;
    },
    set sharingPanel(value: typeof sharingPanel) {
      sharingPanel = value;
    },
    get televisionSelects() {
      return televisionSelects;
    },
    set televisionSelects(value: typeof televisionSelects) {
      televisionSelects = value;
    },
  };
}
