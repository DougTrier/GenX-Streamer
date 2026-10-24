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

it('selection-only updates retain the admitted empty reason until an explicit catalog update', () => {
  const empty = { hidden: false, textContent: '', setAttribute() {} };
  const count = { textContent: '' };
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
  };
  vi.stubGlobal('document', doc);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      disconnect() {}
    },
  );
  const browser = new ChannelBrowser(list as unknown as HTMLElement, () => undefined);
  // Virtual-row rendering is unrelated to the empty-state contract; apply remains real.
  vi.spyOn(browser as unknown as { render(): void }, 'render').mockImplementation(() => {});
  browser.update([], [], 'removed-channel', 'removed-channels');
  const removedMessage = 'All saved channels are removed. Restore removed channels in Settings.';
  expect(empty.textContent).toBe(removedMessage);
  browser.update([], [], null); // Stop/selection notification has no new catalog reason.
  expect(empty.textContent).toBe(removedMessage);
  browser.update([], [], null, 'empty-sources');
  browser.update([], [], 'late-selection');
  expect(empty.textContent).toBe(
    'Your saved sources contain no channels. Update or replace a source in Settings.',
  );
  browser.update([], [], null, 'no-sources');
  expect(empty.textContent).toBe('Select the search icon to find channels.');
});
