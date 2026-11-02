// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import {
  createWatchHistory,
  validateHistoryIds,
  WATCH_HISTORY_LIMIT,
} from '../../src/playback/watch-history';

const free = { kind: 'free' as const };
const paid = { kind: 'paid' as const, accountId: 'a'.repeat(32) };
const other = { kind: 'paid' as const, accountId: 'b'.repeat(32) };
const id = (scope = paid, n = 1) =>
  `account-${scope.accountId}-${n.toString(16).padStart(64, '0')}`;
function memory(initial: string | null = null) {
  let text = initial;
  return {
    read: vi.fn(async () => text),
    write: vi.fn(async (value: string) => {
      text = value;
    }),
    text: () => text,
  };
}

it('durably orders decoded visits, isolates accounts and returns copies', async () => {
  const adapter = memory();
  let clock = 100;
  const store = createWatchHistory(adapter, () => ++clock);
  await Promise.all([
    store.record(free, 'one'),
    store.record(free, 'two'),
    store.record(paid, id()),
    store.record(other, id(other)),
  ]);
  await store.record(free, 'one');
  expect(store.ids(free)).toEqual(['one', 'two']);
  const rows = store.get(free);
  rows[0]!.id = 'changed';
  rows.length = 0;
  expect(store.ids(free)).toEqual(['one', 'two']);
  const reopened = createWatchHistory(adapter);
  await reopened.load();
  expect(reopened.get(free)).toEqual([
    { id: 'one', watchedAtMs: 105 },
    { id: 'two', watchedAtMs: 102 },
  ]);
  expect(reopened.ids(paid)).toEqual([id()]);
  expect(reopened.ids(other)).toEqual([id(other)]);
  expect(JSON.parse(adapter.text()!)).toEqual({
    schemaVersion: 1,
    scopes: [
      { scope: 'free', entries: store.get(free) },
      { scope: `paid:${paid.accountId}`, entries: store.get(paid) },
      { scope: `paid:${other.accountId}`, entries: store.get(other) },
    ],
  });
});

it('removes one or clears exactly one scope and preserves other scopes across restart', async () => {
  const adapter = memory();
  const store = createWatchHistory(adapter);
  await store.record(free, 'one');
  await store.record(free, 'two');
  await store.record(paid, id());
  await store.remove(free, 'one');
  expect(store.ids(free)).toEqual(['two']);
  await store.clear(free);
  const reopened = createWatchHistory(adapter);
  await reopened.load();
  expect(reopened.ids(free)).toEqual([]);
  expect(reopened.ids(paid)).toEqual([id()]);
  expect(adapter.text()).not.toContain('"free"');
});

it('bounds recency to 256 in its own scope without deleting another account', async () => {
  const adapter = memory();
  const store = createWatchHistory(adapter);
  await store.record(paid, id());
  for (let n = 0; n <= WATCH_HISTORY_LIMIT; n++) await store.record(free, `row-${n}`);
  expect(store.ids(free)).toHaveLength(256);
  expect(store.ids(free)[0]).toBe('row-256');
  expect(store.ids(free)).not.toContain('row-0');
  expect(store.ids(paid)).toEqual([id()]);
});

it('captures scope before async storage and rejects URL identities and cross-account rows', async () => {
  const adapter = memory();
  const store = createWatchHistory(adapter);
  const mutable = { ...paid };
  const pending = store.record(mutable, id());
  mutable.accountId = other.accountId;
  await pending;
  expect(store.ids(paid)).toEqual([id()]);
  expect(store.ids(other)).toEqual([]);
  for (const bad of [
    'https://example.invalid/private',
    'data:fixture',
    '',
    'a\n',
    'x'.repeat(16385),
  ]) {
    await expect(store.record(free, bad)).rejects.toThrow('Watch history is invalid.');
  }
  await expect(store.record(paid, id(other))).rejects.toThrow('invalid');
  await expect(store.record(free, id())).rejects.toThrow('invalid');
  for (const bad of [undefined, ['one', 'one'], Array.from({ length: 257 }, (_, n) => String(n))])
    expect(() => validateHistoryIds(bad)).toThrow();
});

it('does not publish writes before durable ACK; failed ACK forces a fresh read', async () => {
  const adapter = memory();
  const store = createWatchHistory(adapter);
  await store.record(free, 'old');
  let ack!: () => void;
  const original = adapter.write.getMockImplementation()!;
  adapter.write.mockImplementationOnce(async (text) => {
    await new Promise<void>((resolve) => {
      ack = resolve;
    });
    await original(text);
  });
  const pending = store.record(free, 'new');
  await vi.waitFor(() => expect(ack).toBeTypeOf('function'));
  expect(store.ids(free)).toEqual(['old']);
  ack();
  await pending;
  expect(store.ids(free)).toEqual(['new', 'old']);
  adapter.write.mockRejectedValueOnce(new Error('private-storage-detail'));
  await expect(store.remove(free, 'old')).rejects.toThrow(
    'Watch history could not be saved or loaded.',
  );
  expect(store.ids(free)).toEqual(['new', 'old']);
  expect(store.loaded).toBe(false);
  await store.clear(free);
  expect(adapter.read).toHaveBeenCalledTimes(2);
});

it('refuses corrupt/private/duplicate saved fields without overwriting; observer failures cannot undo ACK', async () => {
  for (const initial of [
    'bad',
    JSON.stringify({ schemaVersion: 1, scopes: [], title: 'private' }),
    JSON.stringify({
      schemaVersion: 1,
      scopes: [{ scope: 'free', entries: [{ id: 'one', watchedAtMs: -1 }] }],
    }),
    ' '.repeat(2 * 1024 * 1024 + 1),
  ]) {
    const adapter = memory(initial);
    const store = createWatchHistory(adapter);
    await expect(store.record(free, 'new')).rejects.toThrow(
      'Watch history could not be saved or loaded.',
    );
    expect(adapter.write).not.toHaveBeenCalled();
    expect(store.loaded).toBe(false);
  }
  const store = createWatchHistory(memory());
  const listener = vi.fn(() => {
    throw new Error('observer');
  });
  const unsubscribe = store.subscribe(listener);
  await store.record(free, 'one');
  expect(listener).toHaveBeenCalledOnce();
  unsubscribe();
  await store.record(free, 'two');
  await store.settle();
  expect(listener).toHaveBeenCalledOnce();
});

it('recovers a lost write acknowledgement from durable state before the next mutation', async () => {
  const adapter = memory();
  const store = createWatchHistory(adapter);
  await store.record(free, 'one');
  const original = adapter.write.getMockImplementation()!;
  adapter.write.mockImplementationOnce(async (text) => {
    await original(text);
    throw new Error('private lost acknowledgement');
  });
  await expect(store.record(free, 'two')).rejects.toThrow('could not be saved or loaded');
  expect(store.ids(free)).toEqual(['one']);
  await store.remove(free, 'one');
  expect(store.ids(free)).toEqual(['two']);
  const reopened = createWatchHistory(adapter);
  await reopened.load();
  expect(reopened.ids(free)).toEqual(['two']);
});

it('refuses a new scope at capacity without evicting any existing scope', async () => {
  const adapter = memory();
  const store = createWatchHistory(adapter);
  for (let n = 1; n <= 32; n++) {
    const scope = { kind: 'paid' as const, accountId: n.toString(16).padStart(32, '0') };
    await store.record(scope, id(scope));
  }
  const before = adapter.text();
  await expect(store.record(free, 'one')).rejects.toThrow('could not be saved or loaded');
  expect(adapter.text()).toBe(before);
  expect(store.ids({ kind: 'paid', accountId: '1'.padStart(32, '0') })).toHaveLength(1);
});

it('joins failed optional persistence through settlement without rethrowing its reported failure', async () => {
  const badLoad = createWatchHistory(memory('not-json'));
  await expect(badLoad.load()).rejects.toThrow('could not be saved or loaded');
  await expect(badLoad.settle()).resolves.toBeUndefined();
  const adapter = memory();
  const store = createWatchHistory(adapter);
  let release!: () => void;
  adapter.write.mockImplementationOnce(async () => {
    await new Promise<void>((done) => {
      release = done;
    });
    throw new Error('private write failure');
  });
  const original = store.record(free, 'one');
  void original.catch(() => undefined);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  let joined = false;
  const closing = store.settle().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  expect(store.ids(free)).toEqual([]);
  release();
  await expect(original).rejects.toThrow('could not be saved or loaded');
  await closing;
  expect(joined).toBe(true);
  expect(store.ids(free)).toEqual([]);
});
