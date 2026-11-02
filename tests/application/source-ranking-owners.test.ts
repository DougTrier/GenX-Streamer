import { it, expect, vi } from 'vitest';
import { createAccountPlayer } from '../../src/application/accounts/account-player';
import { createSharingHost } from '../../src/application/sharing/sharing-host';
import {
  PlaybackController,
  type ChannelSelection,
  type PlaybackSnapshot,
  type EngineEvent,
} from '../../src/playback/controller';
import type { AccountChannel } from '../../src/platform/account-catalog';
const account = 'a'.repeat(32);
const fence = { accountId: account, accountRevision: '1', mediaRevision: '1' };
const one: AccountChannel = {
  id: `account-${account}-${'1'.repeat(64)}`,
  name: 'Weather Channel',
  category: 'USA',
  providerId: null,
  epgId: 'weather',
  streamReference: '1'.repeat(32),
};
const two: AccountChannel = {
  ...one,
  id: `account-${account}-${'2'.repeat(64)}`,
  streamReference: '2'.repeat(32),
};
const mediaUrl = `http://127.0.0.1:41234/account/${'c'.repeat(64)}/media/${'d'.repeat(64)}`;
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function paid(equivalents: (c: AccountChannel) => Promise<AccountChannel[]>) {
  let generation = 0;
  let snapshot: PlaybackSnapshot = { state: 'idle', selection: null, error: null };
  const start = vi.fn(async (_input: unknown, _signal?: AbortSignal, _options?: unknown) => ({
    schemaVersion: 1 as const,
    sessionGeneration: String(++generation),
    mediaUrl,
    mediaHint: 'mpegts' as const,
    alternateAvailable: true as const,
  }));
  const select = vi.fn(async (selection: ChannelSelection) => {
      snapshot = { state: 'playing', selection, error: null };
    }),
    stop = vi.fn(async () => {
      snapshot = { state: 'idle', selection: null, error: null };
    }),
    forgetSourceKey = vi.fn();
  const owner = createAccountPlayer({
    equivalents,
    player: {
      select,
      stop,
      suspend: stop,
      forgetSourceKey,
      get snapshot() {
        return snapshot;
      },
      rankSourceKeys: (keys) => [...keys].reverse(),
    },
    playback: {
      start,
      stop: async (sessionGeneration) => ({
        schemaVersion: 1 as const,
        stopped: true as const,
        sessionGeneration,
      }),
      retryCleanup: async () => {},
    },
  });
  return {
    owner,
    start,
    select,
    stop,
    forgetSourceKey,
    failed() {
      snapshot = { ...snapshot, state: 'failed' };
    },
  };
}
it('Paid ranking opens exactly one chosen equivalent through the existing account owner', async () => {
  const equivalents = vi.fn(async () => [one, two]);
  const f = paid(equivalents);
  await f.owner.selectAccount(one, fence);
  expect(f.start).toHaveBeenCalledTimes(1);
  expect(f.start.mock.calls[0][0]).toMatchObject({ streamReference: two.streamReference });
  expect(f.owner.selection?.channel.id).toBe(two.id);
  expect(f.select.mock.calls[0][0]).toMatchObject({
    id: two.id,
    performanceKey: expect.any(String),
  });
  await f.owner.dispose();
});
it('Stop wins an asynchronous Paid equivalence lookup before any provider request', async () => {
  const pending = deferred<AccountChannel[]>(),
    f = paid(async () => pending.promise);
  const selection = f.owner.selectAccount(one, fence);
  await flush();
  const stopped = f.owner.stop();
  pending.resolve([one, two]);
  await expect(selection).rejects.toMatchObject({ name: 'AbortError' });
  await stopped;
  expect(f.start).not.toHaveBeenCalled();
  await f.owner.dispose();
});
it('Paid exact-source retest bypasses equivalents and clears both format histories', async () => {
  const equivalents = vi.fn(async () => [one, two]),
    f = paid(equivalents);
  await f.owner.selectAccount(one, fence, undefined, { exact: true });
  expect(equivalents).not.toHaveBeenCalled();
  expect(f.forgetSourceKey).toHaveBeenCalledTimes(2);
  expect(f.start.mock.calls[0][0]).toMatchObject({ streamReference: one.streamReference });
  await f.owner.dispose();
});
it('a known alternate format may win on the next selection without probing it in parallel', async () => {
  const f = paid(async () => [one]);
  await f.owner.selectAccount(one, fence);
  await f.owner.retryAlternate();
  await f.owner.selectAccount(one, fence);
  expect(f.start).toHaveBeenCalledTimes(3);
  expect(f.start.mock.calls[2][2]).toEqual({ alternate: true });
  await f.owner.dispose();
});
function publicOwner(resolveSelection: (s: ChannelSelection) => Promise<ChannelSelection>) {
  const starts = vi.fn();
  const events: ((event: EngineEvent) => void)[] = [];
  const player = new PlaybackController((emit) => {
    events.push(emit);
    return {
      start: async (s) => {
        starts(s);
      },
      pause() {},
      resume: async () => {},
      setMuted() {},
      setVolume() {},
      dispose() {},
    };
  });
  const channels = ['a', 'b'].map((id) => ({
    id,
    name: id,
    sourceId: 'source',
    category: 'Sports',
    urls: [`https://example.invalid/${id}`],
  }));
  const bridge = createSharingHost({
    player,
    resolveSelection,
    channels: () => channels,
    settings: () => ({ muted: false, volume: 1, removedChannels: [] }),
    saveAudio: async () => {},
  });
  return {
    bridge,
    starts,
    failed() {
      events.at(-1)?.({
        type: 'error',
        failure: { code: 'decode', message: 'fixture', retryable: false },
      });
    },
    selection: (id = 'a') => ({ id, name: id, url: `https://example.invalid/${id}` }),
  };
}
it('Stop also wins an asynchronous public equivalent lookup and no decoder is allocated', async () => {
  const pending = deferred<ChannelSelection>(),
    f = publicOwner(async () => pending.promise);
  const selection = f.bridge.select(f.selection());
  await flush();
  const stopped = f.bridge.stop();
  pending.resolve(f.selection('b'));
  await expect(selection).rejects.toMatchObject({ name: 'AbortError' });
  await stopped;
  expect(f.starts).not.toHaveBeenCalled();
  await f.bridge.dispose();
});
it('public exact-source retest does not invoke the best-feed resolver', async () => {
  const resolve = vi.fn(async (s: ChannelSelection) => ({
      ...s,
      id: 'b',
      url: 'https://example.invalid/b',
    })),
    f = publicOwner(resolve);
  await f.bridge.selectExact(f.selection());
  expect(resolve).not.toHaveBeenCalled();
  expect(f.starts).toHaveBeenCalledWith(f.selection());
  await f.bridge.dispose();
});

it('public automatic choices are bounded across successive failed feeds', async () => {
  let next = 'a';
  const f = publicOwner(async (s) => ({ ...s, id: next, url: `https://example.invalid/${next}` }));
  await f.bridge.select(f.selection());
  f.failed();
  await flush();
  next = 'b';
  expect(await f.bridge.retryBest()).toBe(true);
  f.failed();
  await flush();
  next = 'a';
  expect(await f.bridge.retryBest()).toBe(true);
  f.failed();
  await flush();
  next = 'b';
  expect(await f.bridge.retryBest()).toBe(false);
  expect(f.starts).toHaveBeenCalledTimes(3);
  await f.bridge.dispose();
});
it('Stop wins a public recovery lookup after the selected feed fails', async () => {
  const pending = deferred<ChannelSelection>();
  let recover = false;
  const f = publicOwner(async (s) => (recover ? pending.promise : s));
  await f.bridge.select(f.selection());
  f.failed();
  await flush();
  recover = true;
  const retry = f.bridge.retryBest();
  await flush();
  const stop = f.bridge.stop();
  pending.resolve(f.selection('b'));
  expect(await retry).toBe(false);
  await stop;
  expect(f.starts).toHaveBeenCalledTimes(1);
  await f.bridge.dispose();
});
it('Paid automatic choices are bounded and exact-source retest suppresses automatic alternatives', async () => {
  const f = paid(async (c) => [c, c.id === one.id ? two : one]);
  await f.owner.selectAccount(one, fence);
  f.failed();
  expect(await f.owner.retryBest()).toBe(true);
  f.failed();
  expect(await f.owner.retryBest()).toBe(true);
  f.failed();
  expect(await f.owner.retryBest()).toBe(false);
  expect(f.start).toHaveBeenCalledTimes(3);
  await f.owner.selectAccount(one, fence, undefined, { exact: true });
  f.failed();
  expect(f.owner.alternateAvailable).toBe(false);
  expect(await f.owner.retryBest()).toBe(false);
  await f.owner.dispose();
});
it('Stop wins a Paid recovery lookup without opening another provider connection', async () => {
  const pending = deferred<AccountChannel[]>();
  let recover = false;
  const f = paid(async (c) => (recover ? pending.promise : [c]));
  await f.owner.selectAccount(one, fence);
  f.failed();
  recover = true;
  const retry = f.owner.retryBest();
  await flush();
  const stop = f.owner.stop();
  pending.resolve([one, two]);
  expect(await retry).toBe(false);
  await stop;
  expect(f.start).toHaveBeenCalledTimes(1);
  await f.owner.dispose();
});
