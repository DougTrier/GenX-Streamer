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
import { type AccountMetadata } from '../../platform/account-vault';
import { type createAccountBrowser } from './account-browser';
import { type mountGeographyControls } from '../../ui/channels/geography-controls';
import { type createCatalogView } from '../catalog/catalog-view';
import { type ChannelBrowser, type ChannelFilter } from '../../ui/channels/channel-browser';
import { type mountViewingChoices } from '../../ui/channels/viewing-choices';
import {
  createLiveTabBrowseState,
  type LiveBrowseTab,
  type LiveTabBrowseState,
} from '../catalog/live-tab-browse-state';

/** What this area reads from, and writes back to, the rest of the application. */
export interface AccountScopeEnvironment {
  readonly accountBrowser: ReturnType<typeof createAccountBrowser>;
  readonly browser: ChannelBrowser;
  readonly libraryQueries: { live: string };
  readonly chooseCategory: (filter: ChannelFilter, favoritesOnly?: boolean) => void;
  readonly viewingChoices: ReturnType<typeof mountViewingChoices> | undefined;
  readonly geographyControls: ReturnType<typeof mountGeographyControls>;
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly renderCatalog: ReturnType<typeof createCatalogView>['renderCatalog'];
}

export function createAccountScope(env: AccountScopeEnvironment) {
  let accountScopeGeneration = 0;
  const choices = createLiveTabBrowseState();
  let presentedTab: LiveBrowseTab = 'free';
  const restore = (state: LiveTabBrowseState) => {
    env.libraryQueries.live = state.query;
    env.element<HTMLInputElement>('search').value = state.query;
    env.element('clear-search').hidden = state.query.length === 0;
    env.browser.restoreBrowseState(state);
    env.chooseCategory(state.filter, state.favoritesOnly);
    env.geographyControls.restore({ filter: state.geography, sort: env.browser.getSort() });
  };
  async function selectAccountScope(
    account: AccountMetadata | null,
    signal?: AbortSignal,
  ): Promise<void> {
    signal?.throwIfAborted();
    const generation = ++accountScopeGeneration;
    const previous = env.accountBrowser.selectedAccount;
    const previousState = { ...env.browser.getBrowseState(), query: env.libraryQueries.live };
    // During a joined account transition the browser still presents the old tab.
    // Save under that presentation owner rather than the eagerly changed account pointer.
    choices.capture(presentedTab, previousState);
    await env.accountBrowser.select(account);
    if (generation !== accountScopeGeneration)
      throw new DOMException('Library selection replaced.', 'AbortError');
    if (signal?.aborted) {
      await env.accountBrowser.select(previous);
      if (generation !== accountScopeGeneration)
        throw new DOMException('Library selection replaced.', 'AbortError');
      restore(previousState);
      signal.throwIfAborted();
    }
    const next: LiveBrowseTab = account ? 'paid' : 'free';
    const state = choices.restore(next) ?? {
      filter: 'all',
      query: '',
      sportsFacet: {},
      geography: {},
      sort: 'source',
    };
    presentedTab = next;
    env.viewingChoices?.refresh();
    const favoriteFilter = document.querySelector<HTMLButtonElement>('[data-filter="favorites"]');
    if (favoriteFilter) favoriteFilter.disabled = false;
    const favoriteOption = env
      .element<HTMLSelectElement>('compact-filter')
      .querySelector<HTMLOptionElement>('option[value="favorites"]');
    if (favoriteOption) favoriteOption.disabled = false;
    env.renderCatalog();
    restore(state);
  }
  return {
    selectAccountScope,
  };
}
