// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import {
  createLiveTabBrowseState,
  type LiveBrowseTab,
  type LiveTabBrowseState,
} from '../../src/application/catalog/live-tab-browse-state';

const state = (overrides: Partial<LiveTabBrowseState> = {}): LiveTabBrowseState => ({
  filter: 'all',
  query: '',
  sportsFacet: {},
  geography: {},
  sort: 'source',
  ...overrides,
});

it('starts each tab independently and never gives an untouched Paid tab the Free choices', () => {
  const owner = createLiveTabBrowseState();
  expect(owner.restore('free')).toBeNull();
  expect(owner.restore('paid')).toBeNull();
  const free = state({
    filter: 'sports',
    query: 'Chicago Bears',
    sportsFacet: { sport: 'american-football', league: 'nfl' },
    geography: { country: 'US', state: 'US-IL' },
    sort: 'name',
    favoritesSort: 'geography',
  });
  owner.capture('free', free);
  expect(owner.restore('paid')).toBeNull();
  const paid = state({ filter: 'ppv', query: 'Boxing', geography: { country: 'CA' } });
  owner.capture('paid', paid);
  expect(owner.restore('free')).toEqual(free);
  expect(owner.restore('paid')).toEqual(paid);
});

it('retains History independently per tab and refuses an unknown filter', () => {
  const owner = createLiveTabBrowseState();
  owner.capture('free', state({ filter: 'watched', query: 'News' }));
  owner.capture('paid', state({ filter: 'favorites' }));
  expect(owner.restore('free')).toMatchObject({ filter: 'watched', query: 'News' });
  expect(owner.restore('paid')).toMatchObject({ filter: 'favorites' });
  expect(() =>
    owner.capture('free', state({ filter: 'other' as LiveTabBrowseState['filter'] })),
  ).toThrow('filter');
  expect(owner.restore('free')!.filter).toBe('watched');
});

it('owns captured country/facet choices even when the caller later changes them', () => {
  const owner = createLiveTabBrowseState();
  const countries = ['US', 'CA'];
  const captured = state({
    query: ' Bears  ',
    sportsFacet: { sport: 'american-football', league: 'nfl' },
    geography: { countries },
  });
  owner.capture('free', captured);
  captured.query = 'Other';
  captured.sportsFacet.league = 'college-football';
  countries.push('GB');
  expect(owner.restore('free')).toEqual(
    state({
      query: ' Bears  ',
      sportsFacet: { sport: 'american-football', league: 'nfl' },
      geography: { countries: ['US', 'CA'] },
    }),
  );
});

it('returns fresh nested choices so restoring or editing Free cannot mutate either saved tab', () => {
  const owner = createLiveTabBrowseState();
  const original = state({
    sportsFacet: { league: 'nba' },
    geography: { countries: ['US', 'CA'] },
  });
  owner.capture('free', original);
  owner.capture('paid', original);
  const restored = owner.restore('free')!;
  restored.filter = 'news';
  restored.sportsFacet.league = 'nfl';
  (restored.geography.countries as string[]).push('GB');
  expect(owner.restore('free')).toEqual(original);
  expect(owner.restore('paid')).toEqual(original);
  expect(owner.restore('free')).not.toBe(owner.restore('free'));
});

it('does not carry global settings, account data, or stale derived sports authority into a tab', () => {
  const owner = createLiveTabBrowseState();
  const input = {
    ...state(),
    hideAdult: true,
    homeLocation: { postalCode: '61554' },
    accountId: 'private-account',
    provider: 'private-provider',
    sportsFacet: {
      sport: 'american-football',
      league: 'nfl',
      includePpv: true,
      windowStartMs: 1,
      windowEndMs: 2,
      vocabularyVersion: 'old',
    },
    geography: { country: 'US', homePostalCode: '61554' },
  };
  owner.capture('paid', input);
  expect(owner.restore('paid')).toEqual(
    state({
      sportsFacet: { sport: 'american-football', league: 'nfl' },
      geography: { country: 'US' },
    }),
  );
});

it('preserves explicit Unknown geography instead of turning it into All', () => {
  const owner = createLiveTabBrowseState();
  owner.capture('free', state({ geography: { country: null, region: null, state: null } }));
  expect(owner.restore('free')!.geography).toEqual({ country: null, region: null, state: null });
});

it('replaces just one tab with cleared choices without retaining its previous facet or geography', () => {
  const owner = createLiveTabBrowseState();
  const selected = state({
    filter: 'sports',
    query: 'NBA',
    sportsFacet: { league: 'nba' },
    geography: { country: 'US' },
  });
  owner.capture('free', selected);
  owner.capture('paid', selected);
  owner.capture('free', state());
  expect(owner.restore('free')).toEqual(state());
  expect(owner.restore('paid')).toEqual(selected);
});

it('refuses another library key without changing saved live-tab choices', () => {
  const owner = createLiveTabBrowseState();
  owner.capture('free', state({ query: 'News' }));
  expect(() => owner.capture('archive' as LiveBrowseTab, state())).toThrow('invalid');
  expect(() => owner.restore('__proto__' as LiveBrowseTab)).toThrow('invalid');
  expect(owner.restore('free')!.query).toBe('News');
  expect(owner.restore('paid')).toBeNull();
});
