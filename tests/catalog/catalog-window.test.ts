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

import { expect, test } from 'vitest';
import { CatalogWindow, type CatalogWindowHost } from '../../src/ui/catalog-window';
import type { CatalogPage, CatalogQueryInput } from '../../src/platform/catalog-query';
const query = { query: '', filter: 'all' as const, geography: {}, sort: 'source' as const };
const row = (i: number) => ({
  id: `c${i}`,
  sourceId: 'source',
  name: `Channel ${i}`,
  category: 'Sports',
  favorite: false,
});
const page = (start: number, count = 100000, size = 50): CatalogPage => ({
  schemaVersion: 1,
  requestId: 'test',
  catalogRevision: '7',
  viewRevision: '9',
  queryVersion: 'v1-test',
  totalCount: count,
  startIndex: start,
  anchorIndex: null,
  rows: Array.from({ length: Math.max(0, Math.min(size, count - start)) }, (_, i) =>
    row(start + i),
  ),
  after: null,
});
function owner(read?: CatalogWindowHost['query']) {
  const calls: CatalogQueryInput[] = [];
  const host: CatalogWindowHost = {
    revision: () => '7',
    changed: () => {},
    query: async (input, signal) => {
      calls.push(input);
      return read ? read(input, signal) : page(input.startIndex ?? 0);
    },
  };
  return { window: new CatalogWindow(host), calls };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

test('100k catalog uses bounded direct windows rather than preceding-page traversal', async () => {
  const { window, calls } = owner();
  window.reset(query, 'first');
  await window.settled();
  for (const index of [1000, 5000, 99999, 25000]) {
    window.ensure(index);
    await window.settled();
  }
  expect(calls.map((c) => c.startIndex)).toEqual([0, 1000, 5000, 99950, 25000]);
  expect(window.total).toBe(100000);
  expect(window.loadedRows).toBeLessThanOrEqual(150);
  expect(window.row(25000)?.id).toBe('c25000');
  expect(window.row(0)).toBeUndefined();
  await window.dispose();
});

test('count acceptance is distinct from pending, legitimate zero, failure and joined close', async () => {
  const held = deferred<CatalogPage>();
  const { window } = owner(async () => held.promise);
  expect(window.state).toBe('uninitialized');
  expect(window.countKnown).toBe(false);
  window.reset(query, 'held');
  expect(window.state).toBe('pending');
  expect(window.countKnown).toBe(false);
  held.resolve(page(0, 0));
  await window.settled();
  expect(window.state).toBe('ready');
  expect(window.countKnown).toBe(true);
  expect(window.total).toBe(0);
  await window.dispose();
  expect(window.state).toBe('closed');
  expect(window.countKnown).toBe(false);
  const broken = owner(async () => {
    throw new Error('private unavailable');
  });
  broken.window.reset(query, 'broken');
  await broken.window.settled();
  expect(broken.window.state).toBe('error');
  expect(broken.window.countKnown).toBe(false);
  await broken.window.dispose();
});

test('obsolete first page cannot make a held replacement count known', async () => {
  const old = deferred<CatalogPage>(),
    current = deferred<CatalogPage>();
  const { window, calls } = owner(async (input) =>
    input.query === '' ? old.promise : current.promise,
  );
  window.reset(query, 'old');
  await Promise.resolve();
  window.reset({ ...query, query: 'current' }, 'current');
  old.resolve(page(0, 100000));
  await Promise.resolve();
  await Promise.resolve();
  expect(window.countKnown).toBe(false);
  expect(window.state).toBe('pending');
  current.resolve(page(0, 3));
  await window.settled();
  expect(calls).toHaveLength(2);
  expect(window.countKnown).toBe(true);
  expect(window.total).toBe(3);
  await window.dispose();
});

test('failure after an accepted count invalidates that count rather than accepting zero', async () => {
  const { window } = owner(async (input) => {
    if (input.startIndex) throw new Error('unavailable');
    return page(0, 100);
  });
  window.reset(query, 'first');
  await window.settled();
  expect(window.countKnown).toBe(true);
  window.ensure(60);
  expect(window.pending).toBe(true);
  await window.settled();
  expect(window.state).toBe('error');
  expect(window.countKnown).toBe(false);
  expect(window.pending).toBe(false);
  await window.dispose();
});
test('byte-bounded short pages load their remainder without holes or repeated empty queries', async () => {
  const { window, calls } = owner(async (input) => page(input.startIndex ?? 0, 100, 1));
  window.reset(query, 'short');
  await window.settled();
  window.ensure(1);
  await window.settled();
  expect(window.row(1)?.id).toBe('c1');
  expect(calls.map((c) => c.startIndex)).toEqual([0, 1]);
  await window.dispose();
  const empty = owner(async () => page(0, 0));
  empty.window.reset(query, 'empty');
  await empty.window.settled();
  empty.window.ensure(0);
  await empty.window.settled();
  expect(empty.calls).toHaveLength(1);
  await empty.window.dispose();
});
test('superseded query is joined before replacement and cannot publish stale results', async () => {
  const held = deferred<CatalogPage>();
  const { window, calls } = owner(async (input) =>
    input.query === '' ? held.promise : page(0, 1),
  );
  window.reset(query, 'old');
  await Promise.resolve();
  window.reset({ ...query, query: 'Fox' }, 'new');
  await Promise.resolve();
  expect(calls).toHaveLength(1);
  held.resolve(page(0, 100000));
  await window.settled();
  expect(calls).toHaveLength(2);
  expect(window.total).toBe(1);
  expect(window.loadedRows).toBe(1);
  await window.dispose();
});
test('dispose retains actual pending query until it settles and blocks late publication', async () => {
  const held = deferred<CatalogPage>();
  const { window } = owner(async () => held.promise);
  window.reset(query, 'held');
  await Promise.resolve();
  let settled = false;
  const closing = window.dispose().then(() => {
    settled = true;
  });
  expect(window.state).toBe('closed');
  expect(window.countKnown).toBe(false);
  await Promise.resolve();
  expect(settled).toBe(false);
  held.resolve(page(0));
  await closing;
  expect(window.loadedRows).toBe(0);
});
test('off-screen selection is located natively and next-channel wraps in the filtered result', async () => {
  const { window, calls } = owner(async (input) =>
    input.anchorId ? { ...page(99998), anchorIndex: 99999 } : page(input.startIndex ?? 0),
  );
  window.reset(query, 'adjacent');
  await window.settled();
  let selected = 'c99999';
  let index = -1;
  window.adjacent(
    () => selected,
    1,
    (channel, position) => {
      selected = channel.id;
      index = position;
    },
  );
  await window.settled();
  expect(calls[1].anchorId).toBe('c99999');
  expect(selected).toBe('c0');
  expect(index).toBe(0);
  expect(calls[2].startIndex).toBe(0);
  await window.dispose();
});
test('rapid scrolling admits at most three queued windows and checks pinned revisions', async () => {
  const held = deferred<CatalogPage>();
  const { window, calls } = owner(async (input) =>
    input.startIndex === 0 ? held.promise : page(input.startIndex ?? 0),
  );
  window.reset(query, 'rapid');
  await Promise.resolve();
  for (let i = 100; i < 10000; i += 100) window.ensure(i);
  held.resolve(page(0));
  await window.settled();
  expect(calls).toHaveLength(3);
  expect(calls.slice(1).every((c) => c.expectedViewRevision === '9')).toBe(true);
  expect(calls.every((c) => c.expectedCatalogRevision === '7')).toBe(true);
  await window.dispose();
});

test('notification failure cannot poison a replacement query and pending is not empty', async () => {
  const held = deferred<CatalogPage>();
  let notifications = 0;
  const calls: CatalogQueryInput[] = [];
  const window = new CatalogWindow({
    revision: () => '7',
    changed: () => {
      if (++notifications === 1) throw new Error('Renderer unavailable');
    },
    query: async (input) => {
      calls.push(input);
      return input.query === '' ? held.promise : page(0, 2027);
    },
  });
  window.reset(query, 'startup');
  expect(window.loading).toBe(true);
  await Promise.resolve();
  held.resolve(page(0, 2027));
  await window.settled();
  expect(window.failed).toBe(true);
  expect(window.loading).toBe(false);
  window.reset({ ...query, query: 'Fox' }, 'retry');
  await window.settled();
  expect(calls.map((call) => call.query)).toEqual(['', 'Fox']);
  expect(window.failed).toBe(false);
  expect(window.total).toBe(2027);
  await window.dispose();
});

// Owner rule (October 21, 2026): during a scan the list is not refreshed per
// saved batch, so the catalog can move on under it. A page refused as stale
// is read again at the new revision, quietly; one that stays stale fails.
test('a page refused because the catalog moved on is read again at the new revision', async () => {
  const { CatalogQueryError } = await import('../../src/platform/catalog-query');
  let revision = '7';
  const calls: CatalogQueryInput[] = [];
  const host: CatalogWindowHost = {
    revision: () => revision,
    changed: () => {},
    query: async (input) => {
      calls.push(input);
      if (input.expectedCatalogRevision !== revision) throw new CatalogQueryError('catalog-stale');
      return { ...page(input.startIndex ?? 0), catalogRevision: revision };
    },
  };
  const window = new CatalogWindow(host);
  window.reset(query, 'scan');
  await window.settled();
  expect(window.row(0)?.id).toBe('c0');
  // A scan saved more channels: the next page the viewer scrolls into is stale.
  revision = '8';
  host.query = async (input) => {
    calls.push(input);
    if (input.expectedCatalogRevision === '7') throw new CatalogQueryError('catalog-stale');
    return { ...page(input.startIndex ?? 0), catalogRevision: '8' };
  };
  window.ensure(5000);
  for (let i = 0; i < 5; i++) await window.settled();
  window.ensure(5000);
  await window.settled();
  expect(window.state).not.toBe('error');
  expect(window.row(5000)?.id).toBe('c5000');
  expect(calls.at(-1)?.expectedCatalogRevision).toBe('8');
  await window.dispose();
});

test('a catalog that stays stale still fails rather than reading forever', async () => {
  const { CatalogQueryError } = await import('../../src/platform/catalog-query');
  let reads = 0;
  const { window } = owner(async () => {
    reads++;
    throw new CatalogQueryError('catalog-stale');
  });
  window.reset(query, 'scan');
  for (let i = 0; i < 6; i++) await window.settled();
  expect(window.state).toBe('error');
  expect(reads).toBe(3);
  await window.dispose();
});
