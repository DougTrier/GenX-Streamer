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
 * Paid TV accounts in Settings, the library switcher and local streams. Moved out of main.ts; main.ts passes the shared
 * application context.
 */
import { createAccountVault } from '../platform/account-vault';
import { createAccountCatalog } from '../platform/account-catalog';
import { mountLibrarySwitcher } from '../ui/library-switcher';
import { isTauri } from '@tauri-apps/api/core';
import { mountLocalStreams } from '../ui/local-streams';
import { mountAccountManagement } from '../ui/accounts';
import { type createAccountBrowser } from './account-browser';
import { type createAccountScope } from './account-scope';
import { type createLibraryController } from './library-controller';
import { type createAccountPlaybackSelection } from './account-playback-selection';
import { type createSharingHost } from './sharing-host';
import { type mountSpeechSearch } from '../ui/speech-search';
import { type createCatalogView } from './catalog-view';
import { type createAccountPlayer } from './account-player';
import { type installInAppSelects } from '../ui/in-app-select';

/** What this area reads from, and writes back to, the rest of the application. */
export interface AccountSetupEnvironment {
  libraries: ReturnType<typeof mountLibrarySwitcher> | undefined;
  readonly applicationClosing: boolean;
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  readonly selectAccountScope: ReturnType<typeof createAccountScope>['selectAccountScope'];
  readonly accountPlayer: ReturnType<typeof createAccountPlayer> | undefined;
  readonly switchLibrary: ReturnType<typeof createLibraryController>['switchLibrary'];
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly playbackAction: (work: Promise<unknown>) => void;
  readonly playAccountVod: ReturnType<typeof createAccountPlaybackSelection>['playAccountVod'];
  readonly televisionSelects: ReturnType<typeof installInAppSelects> | undefined;
  localStreams: ReturnType<typeof mountLocalStreams> | undefined;
  readonly sharingBridge: ReturnType<typeof createSharingHost>;
  readonly speechSearch: ReturnType<typeof mountSpeechSearch>;
  readonly notice: ReturnType<typeof createCatalogView>['notice'];
}

export function createAccountSetup(env: AccountSetupEnvironment) {
  const accountVault = createAccountVault();
  const accountCatalog = createAccountCatalog();
  env.libraries = mountLibrarySwitcher(
    {
      list: (signal) => accountVault.list(signal),
      ready: () => isTauri() && !env.applicationClosing,
      selected: () => env.accountBrowser.selectedAccount,
      select: (account) => env.selectAccountScope(account),
      release: async (id) => {
        if (env.accountPlayer?.selection?.fence.accountId === id) await env.accountPlayer.stop();
      },
      showLive: () => env.switchLibrary('live'),
      openAccounts: () => {
        env.element('settings-button').click();
        document.querySelector<HTMLButtonElement>('[data-settings-section="sources"]')?.click();
      },
      run: env.playbackAction,
      vod: { play: env.playAccountVod, changed: () => env.televisionSelects?.refresh() },
    },
    {
      free: env.element('live-tv-button'),
      paid: env.element('paid-tv-button'),
      list: env.element('channel-list'),
      row: document.querySelector<HTMLElement>('.sidehead'),
      guide: env.element('guide-button'),
    },
  );
  env.localStreams = mountLocalStreams(
    {
      showLive: () => env.switchLibrary('live'),
      playRadio: (radio) => env.sharingBridge.select(radio),
      stopPlayback: () => env.sharingBridge.stop(),
      run: env.playbackAction,
      voice: (t) =>
        void env.speechSearch
          .retarget(
            t?.container ?? env.element('speech-control'),
            t?.input ?? env.element('search'),
          )
          .catch(() => undefined),
    },
    {
      after: env.element('genxtra-button'),
      leave: ['live-tv-button', 'paid-tv-button', 'genxtra-button', 'guide-button'].map(
        env.element,
      ),
      list: env.element('channel-list'),
      stage: env.element('screen'),
    },
  );
  const accountSettingsContainer = document.createElement('div');
  document.querySelector('[data-settings-panel="sources"]')?.append(accountSettingsContainer);
  const accountControls = mountAccountManagement(accountSettingsContainer, {
    vault: accountVault,
    available: () =>
      isTauri() && env.element('app').dataset.ready === 'true' && !env.applicationClosing,
    changed: () => env.libraries!.reload(),
    notice: env.notice,
    refresh: async (account, signal) => {
      const receipt = await accountCatalog.refresh(account, signal);
      if (env.accountBrowser.selectedAccount?.id === account.id)
        await env.selectAccountScope(account);
      return receipt;
    },
    browse: async (account, signal) => {
      signal.throwIfAborted();
      await env.switchLibrary('live');
      signal.throwIfAborted();
      await env.libraries!.select(account);
      signal.throwIfAborted();
      env.element<HTMLDialogElement>('settings-dialog').close();
      env.element('channel-list').focus({ preventScroll: true });
    },
  });
  const openAccountSettings = () => {
    void accountControls.update();
  };
  return {
    accountControls,
    openAccountSettings,
  };
}
