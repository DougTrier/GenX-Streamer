// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import type { GeographyFilter } from '../../catalog/geography';
import type { SportsFacet } from '../../search/sports';
import type { ChannelFilter } from '../../ui/channels/channel-browser';

export type LiveBrowseTab = 'free' | 'paid';
export interface LiveTabBrowseState {
  filter: ChannelFilter;
  favoritesOnly?: boolean;
  query: string;
  sportsFacet: SportsFacet;
  geography: GeographyFilter;
  sort: 'source' | 'geography' | 'name';
  favoritesSort?: LiveTabBrowseState['sort'];
}

function tabKey(tab: LiveBrowseTab): LiveBrowseTab {
  if (tab !== 'free' && tab !== 'paid') throw new Error('Live TV browsing tab is invalid.');
  return tab;
}

/** Copy UI choices only. Query windows and account/home authority are never retained. */
function copy(state: Readonly<LiveTabBrowseState>): LiveTabBrowseState {
  if (
    !['all', 'favorites', 'news', 'sports', 'movies', 'ppv', 'unresponsive', 'watched'].includes(
      state.filter,
    )
  )
    throw new Error('Live TV browsing filter is invalid.');
  return {
    filter: state.filter,
    ...(state.favoritesOnly ? { favoritesOnly: true } : {}),
    query: state.query,
    sportsFacet: {
      ...(state.sportsFacet.sport === undefined ? {} : { sport: state.sportsFacet.sport }),
      ...(state.sportsFacet.league === undefined ? {} : { league: state.sportsFacet.league }),
    },
    geography: {
      ...(state.geography.country === undefined ? {} : { country: state.geography.country }),
      ...(state.geography.region === undefined ? {} : { region: state.geography.region }),
      ...(state.geography.state === undefined ? {} : { state: state.geography.state }),
      ...(state.geography.countries === undefined
        ? {}
        : { countries: [...state.geography.countries] }),
    },
    sort: state.sort,
    ...(state.favoritesSort === undefined ? {} : { favoritesSort: state.favoritesSort }),
  };
}

/** Session-only Free/Paid choices; the browser derives fresh query authority on restore. */
export function createLiveTabBrowseState() {
  const saved = new Map<LiveBrowseTab, LiveTabBrowseState>();
  return {
    capture(tab: LiveBrowseTab, state: Readonly<LiveTabBrowseState>): void {
      saved.set(tabKey(tab), copy(state));
    },
    restore(tab: LiveBrowseTab): LiveTabBrowseState | null {
      const state = saved.get(tabKey(tab));
      return state ? copy(state) : null;
    },
  };
}
