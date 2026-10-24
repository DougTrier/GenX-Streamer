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
import { ChannelBrowser } from '../../src/ui/channel-browser';

afterEach(() => vi.unstubAllGlobals());

it('searches only reviewed exact network identities and invalidates changed metadata', () => {
  const count = { textContent: '' };
  const empty = { hidden: false, textContent: '', setAttribute() {} };
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
  const selected = vi.fn();
  const browser = new ChannelBrowser(list as unknown as HTMLElement, selected);
  vi.spyOn(browser as unknown as { render(): void }, 'render').mockImplementation(() => {});
  const channels = [
    { id: 'fox', name: 'KDFW', category: 'General', providerId: 'Fox.us@KDFW' },
    { id: 'nbc', name: 'WMAQ', category: 'General', providerId: 'NBC.us@WMAQTV' },
    { id: 'cbs', name: 'WBBM', category: 'News', providerId: 'CBS.us' },
    { id: 'abc', name: 'WLS', category: 'General', providerId: 'ABC.us@WLS' },
    { id: 'mnt', name: 'WFLD', category: 'General', providerId: 'MNT.us@WFLD' },
    { id: 'opaque', name: 'Independent', category: 'General', providerId: 'otherFox.us@feed' },
    { id: 'bad', name: 'Other', category: 'General', providerId: 'Fox.us@' },
  ];
  browser.update(channels, [], null);
  for (const [query, id] of [
    ['FOX', 'fox'],
    ['NBC', 'nbc'],
    ['CBS', 'cbs'],
    ['ABC', 'abc'],
  ]) {
    browser.search(query);
    expect(count.textContent).toBe('1 channel');
    browser.selectAdjacent(1);
    expect(selected).toHaveBeenLastCalledWith(id);
  }
  browser.search('FOX');
  browser.setFilter('news');
  expect(count.textContent).toBe('0 channels');
  browser.setFilter('all');
  channels[0].providerId = 'MNT.us@KDFW';
  browser.update(channels, [], null);
  expect(count.textContent).toBe('0 channels');
  channels[0].providerId = 'Fox.us@KDFW';
  browser.update(channels, [], null);
  expect(count.textContent).toBe('1 channel');
  browser.search('WFLD');
  expect(count.textContent).toBe('1 channel');
  channels[0].category = 'Animation';
  browser.update(channels, [], null);
  browser.search('cartoons');
  expect(count.textContent).toBe('1 channel');
  browser.setFilter('news');
  expect(count.textContent).toBe('0 channels');
  browser.setFilter('all');
  channels[0].category = 'Movies';
  browser.update(channels, [], null);
  expect(count.textContent).toBe('0 channels');
  browser.search('action');
  expect(count.textContent).toBe('0 channels');
  channels[0].category = 'Kids';
  browser.update(channels, [], null);
  browser.search('children');
  expect(count.textContent).toBe('1 channel');
  browser.search('kids children');
  expect(count.textContent).toBe('0 channels');
  channels[0].category = 'Family';
  browser.update(channels, [], null);
  browser.search('kids');
  expect(count.textContent).toBe('0 channels');
});
