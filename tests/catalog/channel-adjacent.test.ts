import { afterEach, expect, it, vi } from 'vitest';
import { ChannelBrowser } from '../../src/ui/channel-browser';

afterEach(() => vi.unstubAllGlobals());

it('channel stepping wraps filtered rows and never reselects the current sole result', () => {
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
  // Exercise the real admitted/filter/selection policy; rendering has separate browser proofs.
  vi.spyOn(browser as unknown as { render(): void }, 'render').mockImplementation(() => {});
  const channels = [
    { id: 'a', name: 'Alpha', category: 'News' },
    { id: 'b', name: 'Beta', category: 'Sports' },
    { id: 'c', name: 'Gamma', category: 'Sports' },
  ];
  browser.update([], [], null);
  expect(browser.selectAdjacent(1)).toBe(false);
  browser.update(channels, [], 'a');
  browser.search('Alpha');
  expect(browser.selectAdjacent(1)).toBe(false);
  expect(browser.selectAdjacent(-1)).toBe(false);
  expect(select).not.toHaveBeenCalled();
  browser.update(channels, [], 'b');
  expect(browser.selectAdjacent(1)).toBe(true);
  expect(select).toHaveBeenLastCalledWith('a');
  browser.search('');
  browser.update(channels, [], 'c');
  browser.selectAdjacent(1);
  expect(select).toHaveBeenLastCalledWith('a');
  browser.update(channels, [], 'a');
  browser.selectAdjacent(-1);
  expect(select).toHaveBeenLastCalledWith('c');
  browser.update(channels, [], 'b');
  browser.selectAdjacent(1);
  expect(select).toHaveBeenLastCalledWith('c');
  browser.selectAdjacent(-1);
  expect(select).toHaveBeenLastCalledWith('a');
  browser.update(channels, [], 'outside');
  browser.selectAdjacent(1);
  expect(select).toHaveBeenLastCalledWith('a');
  browser.selectAdjacent(-1);
  expect(select).toHaveBeenLastCalledWith('c');
});
