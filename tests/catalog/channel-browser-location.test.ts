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
import { ChannelBrowser, type BrowserChannel } from '../../src/ui/channels/channel-browser';
import { createGeographyRegistry } from '../../src/catalog/geography';
import { locationSearchText } from '../../src/search/location-labels';
import subdivisionLabels from '../../src/search/subdivisions.json';
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const count = { textContent: '' },
    empty = { hidden: true, textContent: '', setAttribute() {} };
  const doc = {
    querySelector: (selector: string) => (selector === '#list-empty' ? empty : count),
    getElementById: (id: string): unknown => (id === 'fixture-list' ? list : null),
  };
  const list = {
    id: 'fixture-list',
    isConnected: true,
    ownerDocument: doc,
    dataset: {},
    setAttribute() {},
    addEventListener() {},
    scrollTop: 0,
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const select = vi.fn();
  const browser = new ChannelBrowser(list as unknown as HTMLElement, select);
  vi.spyOn(browser as unknown as { render(): void }, 'render').mockImplementation(() => {});
  return { browser, count, select };
}
const rows: BrowserChannel[] = [
  {
    id: 'illinois',
    name: 'Published station',
    category: 'News',
    providerId: 'ABC.us@WLSTV',
    geography: { country: 'US', state: 'US-IL' },
  },
  {
    id: 'other',
    name: 'Other station',
    category: 'Sports',
    providerId: 'opaque-FOX-reference',
    geography: { country: 'US', state: 'US-NY' },
  },
  { id: 'unknown', name: 'Unknown station', category: 'News' },
];
it('finds persisted location labels/codes without inventing Chicago or tuning', () => {
  const { browser, count, select } = fixture();
  browser.update(structuredClone(rows), [], null);
  for (const query of ['Illinois', 'US-IL', 'Ｉｌｌｉｎｏｉｓ']) {
    browser.search(query);
    expect(count.textContent).toBe('1 channel');
  }
  browser.search('United States');
  expect(count.textContent).toBe('2 channels');
  browser.search('Chicago');
  expect(count.textContent).toBe('0 channels');
  expect(select).not.toHaveBeenCalled();
  browser.search('Illinois');
  browser.setFilter('sports');
  expect(count.textContent).toBe('0 channels');
});
it('matches full exact provider IDs and reviewed networks without opaque substring guesses', () => {
  const { browser, count } = fixture();
  browser.update(structuredClone(rows), [], null);
  for (const query of ['abc.us@wlstv', 'ABC']) {
    browser.search(query);
    expect(count.textContent).toBe('1 channel');
  }
  for (const query of ['WLSTV', 'FOX']) {
    browser.search(query);
    expect(count.textContent).toBe('0 channels');
  }
  browser.search('opaque-fox-reference');
  expect(count.textContent).toBe('1 channel');
});
it('invalidates mutated geography and registry label caches without replacing channel objects', () => {
  const { browser, count } = fixture();
  const channel = structuredClone(rows[0]);
  browser.update([channel], [], null);
  browser.search('Illinois');
  expect(count.textContent).toBe('1 channel');
  channel.geography!.state = 'US-NY';
  browser.update([channel], [], null);
  expect(count.textContent).toBe('0 channels');
  browser.search('New York');
  expect(count.textContent).toBe('1 channel');
  const registry = createGeographyRegistry({
    countries: [{ code: 'US', name: 'United States' }],
    regions: [],
    states: [{ code: 'US-NY', country: 'US', name: 'Published subdivision label' }],
  });
  browser.setGeography({}, 'source', registry);
  browser.search('Published subdivision label');
  expect(count.textContent).toBe('1 channel');
  (registry.states as Map<string, { country: string; name: string }>).set('US-NY', {
    country: 'US',
    name: 'Changed label',
  });
  browser.setGeography({}, 'source', registry);
  expect(count.textContent).toBe('0 channels');
  browser.search('Changed label');
  expect(count.textContent).toBe('1 channel');
});
it('bounds official labels and preserves canonical UK codes without city inference', () => {
  expect(new TextEncoder().encode(JSON.stringify(subdivisionLabels)).length).toBeLessThanOrEqual(
    300 * 1024,
  );
  expect(Object.keys(subdivisionLabels.labels)).toHaveLength(4997);
  expect(locationSearchText({ country: 'UK', state: 'UK-ENG' })).toContain('england');
  expect(locationSearchText()).toBe('');
});
