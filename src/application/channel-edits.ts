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
 * Editing the channel list: public channel groups and favorites. Moved out of main.ts. main.ts passes the shared
 * application context.
 */
import { mutateCatalogGroup, type CatalogGroupAction } from '../platform/catalog-group';
import { queryCatalogPage } from '../platform/catalog-query';
import { isTauri } from '@tauri-apps/api/core';
import { type mountGuide } from '../ui/guide';
import { type createCatalogView } from './catalog-view';
import { type createAccountBrowser } from './account-browser';
import { type createSettingsController } from './settings-controller';
import { type Preferences, type SerializedPreferencesStore } from '../preferences';
import {
  type AccountPreferencesMutation,
  type AccountPreferencesReceipt,
} from '../platform/account-preferences';

/** What this area reads from, and writes back to, the rest of the application. */
export interface ChannelEditsEnvironment {
  readonly applicationClosing: boolean;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  catalogWrites: Promise<unknown>;
  readonly preferences: SerializedPreferencesStore;
  readonly persistedCatalogRevision: string;
  readonly nativeViewingForeground: boolean;
  settings: Preferences;
  catalogBrowseViewRevision: number;
  readonly guide: ReturnType<typeof mountGuide>;
  readonly applySettings: ReturnType<typeof createCatalogView>['applySettings'];
  readonly renderCatalog: ReturnType<typeof createCatalogView>['renderCatalog'];
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  readonly playbackAction: (work: Promise<unknown>) => void;
  readonly writeAccountPreference: (
    mutation: AccountPreferencesMutation,
  ) => Promise<AccountPreferencesReceipt>;
  readonly notice: ReturnType<typeof createCatalogView>['notice'];
  readonly friendlyError: ReturnType<typeof createCatalogView>['friendlyError'];
  readonly saveSettings: ReturnType<typeof createSettingsController>['saveSettings'];
}

export function createChannelEdits(env: ChannelEditsEnvironment) {
  const publicGroupControllers = new Set<AbortController>();
  async function editPublicChannelGroup(
    id: string,
    action: CatalogGroupAction | (() => CatalogGroupAction),
    moreIds: readonly string[] = [],
  ): Promise<void> {
    if (env.applicationClosing || env.element('app').dataset.ready !== 'true')
      throw new Error('Channel unavailable.');
    let acknowledged = false;
    const work = env.catalogWrites.then(async () => {
      const abort = new AbortController();
      publicGroupControllers.add(abort);
      try {
        const settingsAfter = await env.preferences.mutateExternally(async () => {
          const page = await queryCatalogPage(
            {
              schemaVersion: 1,
              expectedCatalogRevision: env.persistedCatalogRevision,
              query: '',
              filter: 'all',
              sort: 'source',
              pageSize: 1,
            },
            abort.signal,
          );
          if (env.applicationClosing || document.hidden || !env.nativeViewingForeground)
            throw new Error('Channel editing was interrupted. Try again.');
          // Resolve toggles inside both write queues, against acknowledged preferences.
          const resolvedAction = typeof action === 'function' ? action() : action;
          await mutateCatalogGroup(id, resolvedAction, page, abort.signal, moreIds);
          acknowledged = true;
        });
        env.settings = settingsAfter;
        env.catalogBrowseViewRevision++;
        if (!env.applicationClosing) {
          env.guide.catalogChanged(true);
          env.applySettings();
          env.renderCatalog();
        }
      } finally {
        publicGroupControllers.delete(abort);
      }
    });
    env.catalogWrites = work.catch(() => undefined);
    try {
      await work;
    } catch (error) {
      if (acknowledged)
        // Native failure causes can contain private source URLs; publish a fixed symptom.
        // eslint-disable-next-line preserve-caught-error
        throw new Error(
          'Changes were saved, but the channel list needs to reload. Reopen the application.',
        );
      throw error;
    }
  }
  function toggleChannelFavorite(id: string): void {
    if (env.applicationClosing || /^archive-[a-f0-9]{64}$/u.test(id)) return;
    const account = env.accountBrowser.selectionFor(id);
    if (account) {
      env.playbackAction(
        env.writeAccountPreference({
          kind: 'favorite',
          channelId: id,
          favorite: !account.favorite,
        }),
      );
      return;
    }
    if (/^account-[a-f0-9]{32}-[a-f0-9]{64}$/u.test(id)) {
      env.notice('Reload the account channel list to change this favorite.');
      return;
    }
    if (isTauri()) {
      void editPublicChannelGroup(id, () => ({
        kind: 'favorite',
        value: !env.preferences.snapshot().favorites.includes(id),
      })).catch((error) => env.notice(env.friendlyError(error)));
    } else
      void env.saveSettings((draft) => {
        draft.favorites = draft.favorites.includes(id)
          ? draft.favorites.filter((item) => item !== id)
          : [...draft.favorites, id];
      });
  }
  return {
    editPublicChannelGroup,
    publicGroupControllers,
    toggleChannelFavorite,
  };
}
