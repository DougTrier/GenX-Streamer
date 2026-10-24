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
 * The channel browser (the channel list itself), its logos and Paid TV
 * now-playing. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { createChannelLogos } from './channel-logos';
import { isTauri } from '@tauri-apps/api/core';
import { createPaidNowPlaying } from '../accounts/paid-now-playing';
import { ChannelBrowser } from '../../ui/channel-browser';
import { createOwnedAbortSignals } from '../../platform/abort';
import { queryCatalogPage } from '../../platform/catalog-query';
import { createAccountGuide } from '../../platform/account-guide';
import { type createLibraryState } from '../genxtra/library-state';
import { type createPageState } from '../shell/page-state';
import { type createAccountBrowser } from '../accounts/account-browser';
import { type createAccountPlaybackSelection } from '../accounts/account-playback-selection';
import { type createSharingHost } from '../sharing/sharing-host';
import { type createVisibleGuideState } from '../guide/visible-guide-state';
import { type createChannelEdits } from './channel-edits';
import { type createChannelListControls } from './channel-list-controls';
import { type CatalogRecord } from '../../catalog';

/** What this area reads from, and writes back to, the rest of the application. */
export interface ChannelBrowserSetupEnvironment {
  channelLogos: ReturnType<typeof createChannelLogos> | undefined;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly applicationClosing: boolean;
  readonly library: ReturnType<typeof createLibraryState>;
  readonly pageState: ReturnType<typeof createPageState>;
  readonly nativeViewingForeground: boolean;
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  readonly persistedCatalogRevision: string;
  readonly updateVisibleGuide: () => void;
  readonly playbackAction: (work: Promise<unknown>) => void;
  readonly selectAccountPlayback: ReturnType<
    typeof createAccountPlaybackSelection
  >['selectAccountPlayback'];
  readonly catalog: CatalogRecord;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  readonly visibleGuideState: ReturnType<typeof createVisibleGuideState>;
  readonly catalogBrowseReady: boolean;
  readonly catalogRevision: number;
  readonly catalogBrowseViewRevision: number;
  readonly liveBrowseJobs: Map<AbortController, Promise<unknown>>;
  readonly toggleChannelFavorite: ReturnType<typeof createChannelEdits>['toggleChannelFavorite'];
  readonly channelActions: ReturnType<typeof createChannelListControls>['channelActions'];
}

export function createChannelBrowserSetup(env: ChannelBrowserSetupEnvironment) {
  env.channelLogos = createChannelLogos({
    readyScope: () =>
      isTauri() &&
      env.element('app').dataset.ready === 'true' &&
      !env.applicationClosing &&
      env.library.contentLibrary === 'live' &&
      env.pageState.primaryPage === 'watch' &&
      !env.library.liveBrowseSuspended &&
      !document.hidden &&
      env.nativeViewingForeground &&
      !env.accountBrowser.selectedAccount
        ? {
            key: `${env.library.archiveStorageEpoch}:${env.persistedCatalogRevision}`,
            revision: env.persistedCatalogRevision,
          }
        : null,
    changed: () => browser.refreshArtwork(),
  });
  // Paid TV rows show what is on now from the provider guide stored on this device.
  let paidNowPlaying: ReturnType<typeof createPaidNowPlaying> | null = null;
  const browser = new ChannelBrowser(
    env.element('channel-list'),
    (id) => {
      env.element('app').dataset.compactView = 'watch';
      env.element<HTMLSelectElement>('compact-view').value = 'watch';
      env.updateVisibleGuide();
      const privateChannel = env.accountBrowser.selectionFor(id);
      if (privateChannel) {
        env.playbackAction(env.selectAccountPlayback(privateChannel.channel, privateChannel.fence));
        return;
      }
      const channel = env.catalog.channels.find((item) => item.id === id);
      if (channel)
        env.playbackAction(
          env.sharingBridge.select({ id: channel.id, name: channel.name, url: channel.urls[0] }),
        );
    },
    {
      onVisibleGuideRows: (rows) => {
        env.visibleGuideState.visibleGuideRows = rows.map((row) => ({ ...row }));
        env.updateVisibleGuide();
        paidNowPlaying?.setScope(rows);
      },
    },
    isTauri()
      ? {
          revision: () =>
            env.accountBrowser.selectedAccount
              ? env.accountBrowser.revision()
              : env.persistedCatalogRevision,
          ready: () =>
            env.element('app').dataset.ready === 'true' &&
            env.library.contentLibrary === 'live' &&
            !env.library.liveBrowseSuspended &&
            !document.hidden &&
            env.nativeViewingForeground &&
            (!!env.accountBrowser.selectedAccount || env.catalogBrowseReady),
          identity: () =>
            `${env.library.libraryIntent}:` +
            (env.accountBrowser.selectedAccount
              ? env.accountBrowser.identity()
              : `${env.catalogRevision}:${env.catalogBrowseViewRevision}`),
          query: (input, signal) => {
            if (
              env.element('app').dataset.ready !== 'true' ||
              env.library.liveBrowseSuspended ||
              env.library.contentLibrary !== 'live' ||
              env.applicationClosing ||
              document.hidden ||
              !env.nativeViewingForeground
            )
              return Promise.reject(new DOMException('Channel browsing suspended.', 'AbortError'));
            const owner = new AbortController();
            const joined = createOwnedAbortSignals([signal, owner.signal]);
            const work = (
              env.accountBrowser.selectedAccount
                ? env.accountBrowser.query(input, joined.signal)
                : queryCatalogPage({ ...input, favoritesFirst: true }, joined.signal)
            ).finally(() => {
              joined.dispose();
              env.liveBrowseJobs.delete(owner);
            });
            env.liveBrowseJobs.set(owner, work);
            return work;
          },
        }
      : undefined,
    {
      logos: env.channelLogos,
      baseRowHeight: () =>
        env.element('app').dataset.deviceKind === 'tv'
          ? 52
          : window.innerWidth >= 1100 && window.innerHeight >= 600
            ? 72
            : window.innerWidth >= 700 && window.innerWidth <= 1100 && window.innerHeight <= 600
              ? 60
              : 72,
      onFavorite: (id) => env.toggleChannelFavorite(id),
      onManage: (id) => env.channelActions.open(id),
    },
  );
  paidNowPlaying = createPaidNowPlaying({
    guide: createAccountGuide(),
    account: () =>
      env.library.contentLibrary === 'live' ? env.accountBrowser.selectedAccount : null,
    epgId: (id) => env.accountBrowser.selectionFor(id)?.channel.epgId ?? null,
    now: () => Date.now(),
    publish: (rows) => browser.setNowPlaying(rows),
  });
  return {
    browser,
  };
}
