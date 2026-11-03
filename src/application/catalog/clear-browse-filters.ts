// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import type { ChannelBrowser, ChannelFilter } from '../../ui/channels/channel-browser';
import type { mountGeographyControls } from '../../ui/channels/geography-controls';

export interface ClearBrowseFiltersEnvironment {
  readonly applicationClosing: boolean;
  readonly library: { contentLibrary: 'live' | 'genxtra'; liveBrowseSuspended: boolean };
  readonly element: <T extends HTMLElement = HTMLElement>(id: string) => T;
  readonly browser: Pick<ChannelBrowser, 'setSportsFacet'>;
  readonly chooseCategory: (filter: ChannelFilter) => void;
  readonly geographyControls: Pick<ReturnType<typeof mountGeographyControls>, 'reset'>;
}

/** Clear only the visible library's choices through their existing owners. */
export function clearActiveBrowseFilters(env: ClearBrowseFiltersEnvironment): void {
  if (
    env.applicationClosing ||
    (env.library.contentLibrary === 'live' && env.library.liveBrowseSuspended)
  )
    return;
  const search = env.element<HTMLInputElement>('search');
  search.value = '';
  search.dispatchEvent(new Event('input', { bubbles: true }));
  if (env.library.contentLibrary === 'genxtra') {
    for (const id of ['genxtra-kind-select', 'genxtra-decade-select']) {
      const field = env.element<HTMLSelectElement>(id);
      field.value = 'all';
      field.dispatchEvent(new Event('change', { bubbles: true }));
    }
  } else {
    env.browser.setSportsFacet({});
    env.chooseCategory('all');
    env.geographyControls.reset();
  }
}
