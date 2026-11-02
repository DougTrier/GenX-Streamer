// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { afterEach, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  createStreamBufferPreferences,
  archiveStreamBufferKey,
  freeStreamBufferKey,
  getStreamBufferPreferences,
  paidStreamBufferKey,
  paidVodStreamBufferKey,
  STREAM_BUFFER_ENTRY_LIMIT,
  STREAM_BUFFER_RECORD_BYTES,
  STREAM_BUFFER_STORAGE_KEY,
  type StreamBufferPreferencesAdapter,
} from '../../src/playback/stream-buffer-preferences';

const key = (n: number) => n.toString(16).padStart(64, '0');
const manual = (targetSeconds: number) => ({ mode: 'manual' as const, targetSeconds });
function memory(initial: string | null = null) {
  let text = initial;
  const adapter: StreamBufferPreferencesAdapter = {
    read: vi.fn(async () => text),
    write: vi.fn(async (next) => {
      text = next;
    }),
  };
  return { adapter, text: () => text };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
afterEach(() => vi.unstubAllGlobals());

it('keys Free by the canonical actual endpoint across full-rescan ID replacement', async () => {
  const before = {
    id: 'old-scan-row',
    sourceId: 'old-import',
    url: 'HTTPS://EXAMPLE.TEST:443/a/../live.m3u8?token=fixture-token#variant',
  };
  const after = {
    id: 'new-scan-row',
    sourceId: 'new-import',
    url: 'https://example.test/live.m3u8?token=fixture-token#variant',
  };
  const a = await freeStreamBufferKey(before.url);
  expect(a).toBe(await freeStreamBufferKey(after.url));
  expect(a).toBe(
    createHash('sha256')
      .update(JSON.stringify(['stream-buffer-v1', 'free', after.url]))
      .digest('hex'),
  );
  expect(a).not.toBe(await freeStreamBufferKey(after.url.replace('fixture-token', 'other')));
  expect(a).not.toBe(await freeStreamBufferKey(after.url.replace('#variant', '#other')));
  expect(a).not.toBe(await freeStreamBufferKey(after.url.replace('/live', '/backup')));
});

it('preserves Paid provider-stable identity through new capabilities/revisions and isolates accounts/formats', async () => {
  const account = 'a'.repeat(32);
  const otherAccount = 'b'.repeat(32);
  // Native acquisition derives this stable ID from account/provider metadata;
  // media installation independently generates a fresh streamReference.
  const before = {
    id: `account-${account}-${'c'.repeat(64)}`,
    streamReference: 'd'.repeat(32),
    mediaRevision: '1',
  };
  const after = { ...before, streamReference: 'e'.repeat(32), mediaRevision: '9' };
  const a = await paidStreamBufferKey(account, before.id, 'primary');
  expect(a).toBe(await paidStreamBufferKey(account, after.id, 'primary'));
  expect(a).not.toBe(await paidStreamBufferKey(account, after.id, 'alternate'));
  expect(a).not.toBe(
    await paidStreamBufferKey(otherAccount, `account-${otherAccount}-${'c'.repeat(64)}`, 'primary'),
  );
  expect(a).not.toBe(
    await paidStreamBufferKey(account, `account-${account}-${'f'.repeat(64)}`, 'primary'),
  );
  await expect(paidStreamBufferKey(account, before.streamReference, 'primary')).rejects.toThrow(
    'invalid',
  );
  await expect(paidStreamBufferKey(otherAccount, before.id, 'primary')).rejects.toThrow('invalid');
});

it('refuses unsafe/oversized identities with fixed errors without reflecting input', async () => {
  const credentials = new URL('https://example.test/live');
  credentials.username = 'fixture-user';
  credentials.password = 'placeholder';
  for (const value of [credentials.href, 'file:///fixture', 'not-an-address', 'x'.repeat(16385)])
    await expect(freeStreamBufferKey(value)).rejects.toThrow(
      'The stream buffer preference is invalid.',
    );
  await expect(paidStreamBufferKey('not-an-account', key(2), 'primary')).rejects.toThrow(
    'The stream buffer preference is invalid.',
  );
});

it('isolates native archive files/local copies and Paid VOD items without temporary route identity', async () => {
  const a = await archiveStreamBufferKey(key(1), 'remote');
  expect(a).toBe(await archiveStreamBufferKey(key(1), 'remote'));
  expect(a).not.toBe(await archiveStreamBufferKey(key(1), 'saved'));
  expect(a).not.toBe(await archiveStreamBufferKey(key(2), 'remote'));
  const account = 'a'.repeat(32);
  const movie = await paidVodStreamBufferKey(account, 'movie', '123', 'mp4');
  expect(movie).toBe(await paidVodStreamBufferKey(account, 'movie', '123', 'mp4'));
  expect(movie).not.toBe(await paidVodStreamBufferKey(account, 'episode', '123', 'mp4'));
  expect(movie).not.toBe(await paidVodStreamBufferKey(account, 'movie', '124', 'mp4'));
  expect(movie).not.toBe(await paidVodStreamBufferKey(account, 'movie', '123', 'mkv'));
  expect(movie).not.toBe(await paidVodStreamBufferKey('b'.repeat(32), 'movie', '123', 'mp4'));
  expect(movie).not.toBe(a);
});

it('persists only opaque digests and manual seconds, survives restart, and clones synchronous reads', async () => {
  const saved = memory();
  const store = createStreamBufferPreferences(saved.adapter);
  const free = await freeStreamBufferKey('https://example.test/private/live?token=fixture-token');
  const account = 'a'.repeat(32);
  const paid = await paidStreamBufferKey(
    account,
    `account-${account}-${'b'.repeat(64)}`,
    'primary',
  );
  await store.set(free, manual(1));
  await store.set(paid, manual(20));
  const text = saved.text()!;
  expect(text).not.toMatch(/https:|example|fixture-token|account-|streamReference|mediaRevision/);
  expect(text).not.toContain(account);
  expect(JSON.parse(text)).toEqual({
    schemaVersion: 1,
    entries: [
      { key: free, targetSeconds: 1 },
      { key: paid, targetSeconds: 20 },
    ],
  });
  const restarted = createStreamBufferPreferences(saved.adapter);
  expect(restarted.loaded).toBe(false);
  expect(restarted.get(free)).toEqual({ mode: 'auto' });
  await restarted.load();
  expect(restarted.get(free)).toEqual(manual(1));
  const copy = restarted.get(paid);
  if (copy.mode === 'manual') copy.targetSeconds = 7;
  expect(restarted.get(paid)).toEqual(manual(20));
});

it('Auto resets exactly one stream while other source/account choices remain durable', async () => {
  const saved = memory();
  const store = createStreamBufferPreferences(saved.adapter);
  await store.set(key(1), manual(4));
  await store.set(key(2), manual(9));
  await expect(store.reset(key(1))).resolves.toEqual({ mode: 'auto' });
  const next = createStreamBufferPreferences(saved.adapter);
  await next.load();
  expect(next.get(key(1))).toEqual({ mode: 'auto' });
  expect(next.get(key(2))).toEqual(manual(9));
  expect(JSON.parse(saved.text()!).entries).toEqual([{ key: key(2), targetSeconds: 9 }]);
});

it.each([0, 21, -1, 1.5, NaN, Infinity])(
  'refuses invalid manual seconds %s without a write',
  async (n) => {
    const saved = memory();
    const store = createStreamBufferPreferences(saved.adapter);
    await expect(store.set(key(1), manual(n))).rejects.toThrow('invalid');
    expect(saved.adapter.write).not.toHaveBeenCalled();
    expect(store.get(key(1))).toEqual({ mode: 'auto' });
  },
);

it('refuses a new entry at capacity without evicting others, then permits only the explicitly freed slot', async () => {
  const entries = Array.from({ length: STREAM_BUFFER_ENTRY_LIMIT }, (_, i) => ({
    key: key(i),
    targetSeconds: 1 + (i % 20),
  }));
  const saved = memory(JSON.stringify({ schemaVersion: 1, entries }));
  const store = createStreamBufferPreferences(saved.adapter);
  await store.load();
  await expect(store.set(key(500), manual(7))).rejects.toThrow('full');
  expect(saved.adapter.write).not.toHaveBeenCalled();
  for (const item of entries) expect(store.get(item.key)).toEqual(manual(item.targetSeconds));
  await store.set(key(2), manual(8));
  await store.reset(key(3));
  await store.set(key(500), manual(7));
  expect(JSON.parse(saved.text()!).entries).toHaveLength(STREAM_BUFFER_ENTRY_LIMIT);
  expect(store.get(key(2))).toEqual(manual(8));
  expect(store.get(key(3))).toEqual({ mode: 'auto' });
});

it.each([
  'not-json',
  JSON.stringify({ schemaVersion: 2, entries: [] }),
  JSON.stringify({ schemaVersion: 1, entries: [], url: 'unexpected' }),
  JSON.stringify({ schemaVersion: 1, entries: [{ key: 'not-opaque', targetSeconds: 3 }] }),
  JSON.stringify({ schemaVersion: 1, entries: [{ key: key(1), targetSeconds: 21 }] }),
  JSON.stringify({ schemaVersion: 1, entries: [{ key: key(1), targetSeconds: 3, extra: true }] }),
  JSON.stringify({
    schemaVersion: 1,
    entries: [
      { key: key(1), targetSeconds: 3 },
      { key: key(1), targetSeconds: 4 },
    ],
  }),
  JSON.stringify({
    schemaVersion: 1,
    entries: Array.from({ length: 257 }, (_, i) => ({ key: key(i), targetSeconds: 3 })),
  }),
  ' '.repeat(STREAM_BUFFER_RECORD_BYTES + 1),
])('refuses malformed stored records rather than overwriting them %#', async (text) => {
  const saved = memory(text);
  const store = createStreamBufferPreferences(saved.adapter);
  await expect(store.load()).rejects.toThrow('could not be saved or loaded');
  await expect(store.set(key(1), manual(5))).rejects.toThrow('could not be saved or loaded');
  expect(saved.adapter.write).not.toHaveBeenCalled();
  expect(saved.text()).toBe(text);
  expect(store.loaded).toBe(false);
});

it('joins pending initial load and serializes rapid choices without publishing before write acknowledgment', async () => {
  const read = deferred<string | null>();
  const firstWrite = deferred<void>();
  const texts: string[] = [];
  const store = createStreamBufferPreferences({
    read: () => read.promise,
    write: async (text) => {
      texts.push(text);
      if (texts.length === 1) await firstWrite.promise;
    },
  });
  const loading = store.load();
  const first = store.set(key(1), manual(4));
  const second = store.set(key(1), manual(8));
  read.resolve(null);
  await loading;
  await vi.waitFor(() => expect(texts).toHaveLength(1));
  expect(store.get(key(1))).toEqual({ mode: 'auto' });
  firstWrite.resolve();
  await expect(first).resolves.toEqual(manual(4));
  await expect(second).resolves.toEqual(manual(8));
  expect(texts.map((text) => JSON.parse(text).entries[0].targetSeconds)).toEqual([4, 8]);
  expect(store.get(key(1))).toEqual(manual(8));
});

it('retains acknowledged cache on write failure and reloads before a later mutation after a lost acknowledgment', async () => {
  let text: string | null = null;
  let loseAcknowledgment = false;
  const store = createStreamBufferPreferences({
    read: async () => text,
    write: async (next) => {
      text = next;
      if (loseAcknowledgment) {
        loseAcknowledgment = false;
        throw new Error('private storage diagnostic sentinel');
      }
    },
  });
  await store.set(key(1), manual(3));
  loseAcknowledgment = true;
  await expect(store.set(key(1), manual(8))).rejects.toThrow(
    'Stream buffer preferences could not be saved or loaded.',
  );
  expect(store.get(key(1))).toEqual(manual(3));
  expect(store.loaded).toBe(false);
  await store.set(key(2), manual(5));
  expect(store.get(key(1))).toEqual(manual(8));
  expect(store.get(key(2))).toEqual(manual(5));
});

it('lazy default store touches only one private storage key and reports unavailable storage without leaking details', async () => {
  const getItem = vi.fn(() => {
    throw new Error('private storage diagnostic sentinel');
  });
  const setItem = vi.fn();
  vi.stubGlobal('localStorage', { getItem, setItem });
  const store = getStreamBufferPreferences();
  expect(getStreamBufferPreferences()).toBe(store);
  expect(getItem).not.toHaveBeenCalled();
  await expect(store.load()).rejects.toThrow(
    'Stream buffer preferences could not be saved or loaded.',
  );
  expect(getItem).toHaveBeenCalledWith(STREAM_BUFFER_STORAGE_KEY);
  expect(setItem).not.toHaveBeenCalled();
});
