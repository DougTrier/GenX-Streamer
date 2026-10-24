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
 * Saving Paid TV account preferences, one write at a time. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import {
  createAccountPreferences,
  type AccountPreferencesMutation,
  type AccountPreferencesReceipt,
} from '../../platform/account-preferences';
import { type createAccountBrowser } from './account-browser';
import { type createCatalogView } from '../catalog/catalog-view';
import { type createPlayerView } from '../playback/player-view';
import { type PlaybackController } from '../../playback/controller';

/** What this area reads from, and writes back to, the rest of the application. */
export interface AccountPreferencesEnvironment {
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  readonly applicationClosing: boolean;
  readonly renderCatalog: ReturnType<typeof createCatalogView>['renderCatalog'];
  readonly notice: ReturnType<typeof createCatalogView>['notice'];
  readonly renderPlayer: ReturnType<typeof createPlayerView>['renderPlayer'];
  readonly player: PlaybackController;
}

export function createAccountPreferencesController(env: AccountPreferencesEnvironment) {
  const accountPreferences = createAccountPreferences();
  let accountPreferenceOwner: AbortController | null = null;
  let accountPreferenceWork: Promise<AccountPreferencesReceipt> | null = null;
  let accountPreferenceKey = '';
  function writeAccountPreference(
    mutation: AccountPreferencesMutation,
  ): Promise<AccountPreferencesReceipt> {
    const scope = env.accountBrowser.preferenceScope();
    if (!scope || env.applicationClosing)
      return Promise.reject(new Error('Reload the account channel list before making changes.'));
    const key = JSON.stringify([scope, mutation]);
    if (accountPreferenceWork)
      return key === accountPreferenceKey
        ? accountPreferenceWork
        : Promise.reject(new Error('Wait for the current channel change to finish.'));
    const owner = new AbortController();
    accountPreferenceOwner = owner;
    accountPreferenceKey = key;
    const work = accountPreferences
      .write(
        {
          schemaVersion: 1,
          accountId: scope.accountId,
          expectedAccountRevision: scope.accountRevision,
          expectedMediaRevision: scope.mediaRevision,
          expectedPreferencesRevision: scope.preferencesRevision,
          mutation,
        },
        owner.signal,
      )
      .then(async (receipt) => {
        const account = env.accountBrowser.selectedAccount;
        if (
          account?.id === receipt.accountId &&
          account.revision === receipt.accountRevision &&
          !env.applicationClosing
        ) {
          await env.accountBrowser.select(account);
          env.renderCatalog();
        }
        if (receipt.cleanupPending)
          env.notice('Channel changes were saved. Playback cleanup needs a retry.');
        return receipt;
      })
      .finally(() => {
        if (accountPreferenceWork === work) {
          accountPreferenceWork = null;
          accountPreferenceOwner = null;
          accountPreferenceKey = '';
          if (!env.applicationClosing) env.renderPlayer(env.player.snapshot);
        }
      });
    accountPreferenceWork = work;
    env.renderPlayer(env.player.snapshot);
    return work;
  }
  return {
    get accountPreferenceOwner() {
      return accountPreferenceOwner;
    },
    get accountPreferenceWork() {
      return accountPreferenceWork;
    },
    writeAccountPreference,
  };
}
