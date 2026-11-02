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

import { afterEach, expect, it, vi } from 'vitest';
import { hasPpvMarker, isPpvChannel } from '../../src/catalog/ppv';
import { timelineCategoryMatches } from '../../src/ui/guide/guide-timeline-model';
import {
  createChannelCategoryResolver,
  defaultPreferences,
  exportPreferences,
  importPreferences,
} from '../../src/preferences';
import {
  ChannelBrowser,
  type BrowserChannel,
  type ChannelFilter,
} from '../../src/ui/channels/channel-browser';

afterEach(() => vi.unstubAllGlobals());

function fixture() {
  const count = { textContent: '' };
  const doc = { querySelector: () => count };
  const list = {
    id: 'channels',
    ownerDocument: doc,
    dataset: {},
    style: { setProperty() {}, removeProperty() {} },
    scrollTop: 0,
    setAttribute() {},
    addEventListener() {},
    removeEventListener() {},
    querySelector() {
      return null;
    },
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal('HTMLElement', class {});
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const browser = new ChannelBrowser(list as unknown as HTMLElement, () => {});
  vi.spyOn(browser as unknown as { render(): void }, 'render').mockImplementation(() => {});
  const visible = () =>
    (browser as unknown as { visible: BrowserChannel[] }).visible.map((c) => c.id);
  return { browser, count, visible };
}

it('keeps PPV out of normal Free/Paid fallback categories, favorites and searches, with explicit PPV browsing', () => {
  const { browser, visible } = fixture();
  const channels = [
    { id: 'sports', name: 'ESPN Finals', category: 'Sports' },
    { id: 'wwe', name: 'WWE Network', category: 'Sports' },
    { id: 'premium', name: 'Premium Sports', category: 'Paid TV' },
    { id: 'event', name: 'UFC Fight Night', category: 'Sports' },
    { id: 'ppv', name: 'PPV 12: Championship', category: 'Sports' },
    { id: 'group', name: 'Event 1', category: 'US | Pay Per View' },
  ];
  browser.update(channels, ['sports', 'ppv', 'group'], null);
  expect(visible()).toEqual(['sports', 'wwe', 'premium', 'event']);
  browser.search('championship');
  expect(visible()).toEqual([]);
  browser.search('');
  for (const filter of ['sports', 'favorites', 'movies', 'news'] as ChannelFilter[]) {
    browser.setFilter(filter);
    expect(visible()).not.toContain('ppv');
    expect(visible()).not.toContain('group');
  }
  browser.setFilter('ppv');
  expect(visible()).toEqual(['ppv', 'group']);
  browser.search('championship');
  expect(visible()).toEqual(['ppv']);
  browser.update([...channels], [], null);
  expect(visible()).toEqual(['ppv']);
  browser.setFilter('all');
  expect(visible()).toEqual([]);
});

it.each([
  'PPV',
  'PPV23',
  'US|NFL PPV',
  'P.P.V.',
  'Pay-per-view',
  'PAY PER VIEW',
  'payperview',
  'ＰＰＶ 7',
  'PPV\u0345',
])('recognizes the explicit provider marker %s', (text) => expect(hasPpvMarker(text)).toBe(true));
it.each([
  'Paid TV',
  'Premium Sports',
  'UFC Fight Night',
  'WWE Network',
  'NBA Finals',
  'World Cup Final',
  'Sports Events',
  'Championship 2026-11-01',
  'HappyView',
  'PPVision',
  'ppvextra',
  'P\u0345PV',
])('does not invent PPV from an unmarked channel/event %s', (text) =>
  expect(hasPpvMarker(text)).toBe(false),
);
it('retains provider PPV evidence through persisted category overrides and metadata updates', () => {
  const prefs = defaultPreferences();
  prefs.channelCategoryOverrides = [{ channelId: 'one', category: 'Sports' }];
  const saved = importPreferences(exportPreferences(prefs));
  const resolve = createChannelCategoryResolver(saved);
  const original = { id: 'one', name: 'Event 1', category: 'US | PPV' };
  const channel = { ...original, originalCategory: original.category, category: resolve(original) };
  expect(channel.category).toBe('Sports');
  expect(isPpvChannel(channel)).toBe(true);
  const { browser, visible } = fixture();
  browser.update([channel], ['one'], null);
  browser.setFilter('sports');
  expect(visible()).toEqual([]);
  browser.setFilter('favorites');
  expect(visible()).toEqual([]);
  browser.setFilter('ppv');
  expect(visible()).toEqual(['one']);
  channel.originalCategory = 'Sports';
  browser.update([channel], ['one'], null);
  expect(visible()).toEqual([]);
  browser.setFilter('sports');
  expect(visible()).toEqual(['one']);
});
it('isolates Guide channel metadata in every normal category and accepts authoritative PPV event scope', () => {
  const channel = {
    id: 'one',
    sourceId: 's',
    name: 'Event',
    category: 'Sports',
    originalCategory: 'PPV',
    favorite: true,
    guideSourceId: 'g',
    xmltvChannelId: 'x',
  };
  for (const filter of ['all', 'favorites', 'news', 'sports'] as const)
    expect(timelineCategoryMatches(channel, filter)).toBe(false);
  expect(timelineCategoryMatches(channel, 'ppv')).toBe(true);
  expect(timelineCategoryMatches({ ...channel, originalCategory: 'Sports' }, 'ppv', true)).toBe(
    true,
  );
});
