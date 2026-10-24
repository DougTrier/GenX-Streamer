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
 * Choosing which Paid TV account the channel list shows. Moved out of main.ts. main.ts passes the shared
 * application context.
 */
import { type AccountMetadata } from '../platform/account-vault';
import { type createAccountBrowser } from './account-browser';
import { type mountGeographyControls } from '../ui/geography-controls';
import { type createCatalogView } from './catalog-view';
import { type ChannelFilter } from '../ui/channel-browser';
import { type mountViewingChoices } from '../ui/viewing-choices';

/** What this area reads from, and writes back to, the rest of the application. */
export interface AccountScopeEnvironment {
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  readonly chooseCategory: (filter: ChannelFilter) => void;
  readonly viewingChoices: ReturnType<typeof mountViewingChoices> | undefined;
  readonly geographyControls: ReturnType<typeof mountGeographyControls>;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly renderCatalog: ReturnType<typeof createCatalogView>['renderCatalog'];
}

export function createAccountScope(env: AccountScopeEnvironment) {
  let accountScopeGeneration = 0;
  async function selectAccountScope(
    account: AccountMetadata | null,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const generation = ++accountScopeGeneration;
    const previous = env.accountBrowser.selectedAccount;
    await env.accountBrowser.select(account);
    if (generation !== accountScopeGeneration)
      throw new DOMException('Library selection replaced.', 'AbortError');
    if (signal?.aborted) {
      await env.accountBrowser.select(previous);
      signal.throwIfAborted();
    }
    env.chooseCategory('all');
    env.viewingChoices?.refresh();
    if (previous?.id !== account?.id) env.geographyControls.reset();
    const favoriteFilter = document.querySelector<HTMLButtonElement>('[data-filter="favorites"]');
    if (favoriteFilter) favoriteFilter.disabled = false;
    const favoriteOption = env
      .element<HTMLSelectElement>('compact-filter')
      .querySelector<HTMLOptionElement>('option[value="favorites"]');
    if (favoriteOption) favoriteOption.disabled = false;
    env.renderCatalog();
  }
  return {
    selectAccountScope,
  };
}
