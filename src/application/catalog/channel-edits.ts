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
import {
  CatalogGroupRevisionConflict,
  mutateCatalogGroup,
  type CatalogGroupAction,
} from '../../platform/catalog-group';
import { queryCatalogPage } from '../../platform/catalog-query';
import { isTauri } from '@tauri-apps/api/core';
import { renderFavoriteButton } from '../../ui/channels/favorite-button';
import { type mountGuide } from '../../ui/guide/guide';
import { type createCatalogView } from './catalog-view';
import { type createAccountBrowser } from '../accounts/account-browser';
import { type createSettingsController } from '../shell/settings-controller';
import { type Preferences, type SerializedPreferencesStore } from '../../preferences';
import {
  type AccountPreferencesMutation,
  type AccountPreferencesReceipt,
} from '../../platform/account-preferences';

const PAID_FAVORITE_QUIET_MS = 300;

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
  readonly writeAccountPreference: (
    mutation: AccountPreferencesMutation,
  ) => Promise<AccountPreferencesReceipt>;
  readonly notice: ReturnType<typeof createCatalogView>['notice'];
  readonly friendlyError: ReturnType<typeof createCatalogView>['friendlyError'];
  readonly saveSettings: ReturnType<typeof createSettingsController>['saveSettings'];
}

export function createChannelEdits(env: ChannelEditsEnvironment) {
  const publicGroupControllers = new Set<AbortController>();
  const pendingFavorites = new Map<
    string,
    { desired: boolean; lastTap: number; accountSignal?: AbortSignal }
  >();
  let favoriteWrites = Promise.resolve();
  const activeFavorite = (id: string) => {
    const edit = pendingFavorites.get(id);
    return edit?.accountSignal?.aborted ? undefined : edit;
  };
  const pendingChannelFavorite = (id: string): boolean | undefined => activeFavorite(id)?.desired;

  function showFavorite(id: string, favorite: boolean, pending: boolean): void {
    const dock = env.element<HTMLButtonElement>('favorite-button');
    const rows = env
      .element('channel-list')
      .querySelectorAll<HTMLButtonElement>('button[data-channel-action="favorite"]');
    for (const button of [dock, ...rows]) {
      if (button.dataset.channelId === id) renderFavoriteButton(button, favorite, pending);
    }
  }
  function publishPublicGroupEdit(): void {
    env.catalogBrowseViewRevision++;
    if (!env.applicationClosing) {
      env.guide.catalogChanged(true);
      env.applySettings();
    }
  }
  async function editPublicChannelGroup(
    id: string,
    action: CatalogGroupAction,
    moreIds: readonly string[] = [],
    publish = true,
  ): Promise<void> {
    if (env.applicationClosing || env.element('app').dataset.ready !== 'true')
      throw new Error('Channel unavailable.');
    let acknowledged = false;
    const work = env.catalogWrites.then(async () => {
      const abort = new AbortController();
      publicGroupControllers.add(abort);
      try {
        const settingsAfter = await env.preferences.mutateExternally(async () => {
          for (let attempt = 0; ; attempt++) {
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
            try {
              await mutateCatalogGroup(id, action, page, abort.signal, moreIds);
              acknowledged = true;
              return;
            } catch (error) {
              if (
                attempt !== 0 ||
                action.kind !== 'favorite' ||
                !(error instanceof CatalogGroupRevisionConflict)
              )
                throw error;
            }
          }
        });
        env.settings = settingsAfter;
        if (publish) publishPublicGroupEdit();
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
    const pending = activeFavorite(id);
    if (pending) {
      pending.desired = !pending.desired;
      pending.lastTap = performance.now();
      showFavorite(id, pending.desired, true);
      return;
    }
    const account = env.accountBrowser.selectionFor(id);
    if (!account && /^account-[a-f0-9]{32}-[a-f0-9]{64}$/u.test(id)) {
      env.notice('Reload the account channel list to change this favorite.');
      return;
    }
    const wasFavorite = account?.favorite ?? env.settings.favorites.includes(id);
    const accountSignal = account ? env.accountBrowser.selectionSignal : undefined;
    const edit = { desired: !wasFavorite, lastTap: performance.now(), accountSignal };
    pendingFavorites.set(id, edit);
    showFavorite(id, !wasFavorite, true);
    let saved = wasFavorite;
    let refresh = false;
    favoriteWrites = favoriteWrites
      .then(async () => {
        if (!account) saved = env.settings.favorites.includes(id);
        let paidWriteStarted = false;
        // Coalesce taps while the write is running. Persist the latest target only
        // when it differs from the last acknowledged state.
        while (!env.applicationClosing && !accountSignal?.aborted) {
          // Start the first save immediately. Keep the focused star mounted
          // through the rest of the burst before refreshing the Paid TV list.
          const wait = edit.lastTap + PAID_FAVORITE_QUIET_MS - performance.now();
          if (paidWriteStarted && wait > 0) {
            await new Promise<void>((resolve) => setTimeout(resolve, Math.ceil(wait)));
            continue;
          }
          const { desired } = edit;
          if (desired === saved) return;
          if (account) {
            paidWriteStarted = true;
            const receipt = await env.writeAccountPreference({
              kind: 'favorite',
              channelId: id,
              favorite: desired,
            });
            saved = desired;
            refresh ||= receipt.changed;
          } else if (isTauri()) {
            await editPublicChannelGroup(id, { kind: 'favorite', value: desired }, [], false);
            refresh = true;
            saved = env.settings.favorites.includes(id);
          } else {
            const committed = await env.saveSettings((draft) => {
              if (desired && !draft.favorites.includes(id)) draft.favorites.push(id);
              if (!desired) draft.favorites = draft.favorites.filter((item) => item !== id);
            });
            if (!committed) return;
            saved = env.settings.favorites.includes(id);
          }
          if (saved !== desired) return;
        }
      })
      .catch((error) => {
        if (!accountSignal?.aborted) env.notice(env.friendlyError(error));
      })
      .finally(() => {
        if (pendingFavorites.get(id) !== edit) return;
        pendingFavorites.delete(id);
        if (accountSignal?.aborted) return;
        showFavorite(id, account ? saved : env.settings.favorites.includes(id), false);
        if (!refresh) return;
        if (!account) publishPublicGroupEdit();
        else if (!env.applicationClosing) env.renderCatalog();
      });
  }
  return {
    editPublicChannelGroup,
    pendingChannelFavorite,
    publicGroupControllers,
    toggleChannelFavorite,
  };
}
