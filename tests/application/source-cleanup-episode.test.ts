// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import {
  createSourceCleanupEpisode,
  finishAndAdoptSourceCleanup,
  sourceCleanupOutcomeText,
  sourceCleanupPlaybackIdle,
  sourceCleanupRequested,
  SourceCleanupProjectionError,
} from '../../src/application/discovery/source-cleanup-episode';
import type { SourceCleanupReceipt } from '../../src/platform/source-cleanup';
import { defaultPreferences, SerializedPreferencesStore } from '../../src/preferences';
import { channel, harness } from '../playback/controller.fixture';

const roundId = 'a'.repeat(64);
const receipt: SourceCleanupReceipt = {
  schemaVersion: 1,
  committed: true,
  status: 'completed',
  archivedCount: 1,
  checkedTargets: 1,
  deferredCount: 0,
  catalogRevision: '4',
  healthRevision: '7',
  viewRevision: '8',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function fixture() {
  let current = true,
    idle = true,
    changed = () => {};
  const transport = {
    begin: vi.fn(async () => ({ schemaVersion: 1 as const, roundId, sourceCount: 2 })),
    finish: vi.fn(
      async (_id: string, _signal: AbortSignal): Promise<SourceCleanupReceipt> => receipt,
    ),
    cancel: vi.fn(async (_id: string) => {}),
  };
  const host = {
    transport,
    expectedCatalogRevision: '4',
    current: () => current,
    playbackIdle: () => idle,
    observe: vi.fn((callback: () => void): (() => void) => {
      changed = callback;
      return vi.fn();
    }),
    finishAndAdopt: vi.fn((id: string, signal: AbortSignal) => transport.finish(id, signal)),
  };
  const outer = new AbortController();
  const episode = createSourceCleanupEpisode(host, outer.signal);
  return {
    transport,
    host,
    outer,
    episode,
    playing() {
      idle = false;
      changed();
    },
    replaceRoot() {
      current = false;
      changed();
    },
  };
}
it('cleanup is admitted only for complete unfiltered configured Refresh or Rescan', () => {
  for (const intent of ['refresh', 'full-recheck']) {
    expect(sourceCleanupRequested({ intent, query: '  ' })).toBe(true);
    expect(sourceCleanupRequested({ intent, query: 'sports' })).toBe(false);
    expect(sourceCleanupRequested({ intent, query: '', sources: [] })).toBe(false);
  }
  for (const intent of ['continue', 'slow', 'other'])
    expect(sourceCleanupRequested({ intent, query: '' })).toBe(false);
});
it('active playback defers cleanup visibly without stopping source refresh ownership', async () => {
  const f = fixture();
  f.playing();
  await f.episode.begin();
  const outcome = await f.episode.finish();
  expect(outcome.status).toBe('deferred-playback');
  expect(sourceCleanupOutcomeText(outcome)).toMatch(/Stop playback and Refresh/);
  expect(f.transport.begin).not.toHaveBeenCalled();
  expect(f.host.finishAndAdopt).not.toHaveBeenCalled();
  expect(f.outer.signal.aborted).toBe(false);
  await f.episode.dispose();
});
it.each(['free-channel', 'account-live', 'archive-title'])(
  'a chosen but paused %s on the shared playback owner defers cleanup',
  async (id) => {
    const { controller, owners } = harness();
    const f = fixture();
    f.host.playbackIdle = () => sourceCleanupPlaybackIdle({ snapshot: controller.snapshot });
    f.host.observe = vi.fn((changed: () => void) => controller.subscribe(changed));
    const episode = createSourceCleanupEpisode(f.host, f.outer.signal);
    try {
      await controller.select({
        ...channel(id),
        ...(id === 'archive-title' ? { playMode: 'on-demand' as const } : {}),
      });
      owners[0]!.emit({ type: 'progress' });
      await controller.pause();
      expect(controller.snapshot).toMatchObject({ state: 'paused', selection: { id } });
      await episode.begin();
      expect((await episode.finish()).status).toBe('deferred-playback');
      expect(f.transport.begin).not.toHaveBeenCalled();
      expect(f.outer.signal.aborted).toBe(false);
    } finally {
      await episode.dispose();
      await f.episode.dispose();
      await controller.dispose();
    }
  },
);
it('native Web Stream and retained or pending choices protect even an idle shared decoder', async () => {
  const { controller } = harness();
  try {
    expect(sourceCleanupPlaybackIdle({ snapshot: controller.snapshot })).toBe(true);
    for (const protection of [
      { webPageOpen: true },
      { accountSelected: true },
      { archiveSelected: true },
      { pendingPlayback: true },
      { retainedPlayback: true },
    ]) {
      const f = fixture();
      f.host.playbackIdle = () =>
        sourceCleanupPlaybackIdle({ snapshot: controller.snapshot, ...protection });
      await f.episode.begin();
      expect((await f.episode.finish()).status).toBe('deferred-playback');
      expect(f.transport.begin).not.toHaveBeenCalled();
      expect(f.outer.signal.aborted).toBe(false);
      await f.episode.dispose();
    }
  } finally {
    await controller.dispose();
  }
});
it('playback beginning after source capture revokes the round and defers only cleanup', async () => {
  const f = fixture();
  await f.episode.begin();
  f.playing();
  expect((await f.episode.finish()).status).toBe('deferred-playback');
  expect(f.transport.cancel).toHaveBeenCalledWith(roundId);
  expect(f.host.finishAndAdopt).not.toHaveBeenCalled();
  expect(f.outer.signal.aborted).toBe(false);
  await f.episode.dispose();
});
it('root/configuration replacement cannot finish the captured cleanup round', async () => {
  const f = fixture();
  await f.episode.begin();
  f.replaceRoot();
  expect((await f.episode.finish()).status).toBe('interrupted');
  expect(f.host.finishAndAdopt).not.toHaveBeenCalled();
  expect(f.transport.cancel).toHaveBeenCalledWith(roundId);
  await f.episode.dispose();
});
it('disposing joins actual round revocation instead of returning an early acknowledgment', async () => {
  const f = fixture(),
    cancel = deferred<void>();
  f.transport.cancel.mockImplementation(() => cancel.promise);
  await f.episode.begin();
  let disposed = false;
  const work = f.episode.dispose().then(() => {
    disposed = true;
  });
  await vi.waitFor(() => expect(f.transport.cancel).toHaveBeenCalledTimes(1));
  expect(disposed).toBe(false);
  cancel.resolve();
  await work;
  expect(disposed).toBe(true);
});
it('a durable finish that wins late abort still resolves after preference adoption', async () => {
  const f = fixture(),
    finish = deferred<SourceCleanupReceipt>();
  const order: string[] = [];
  f.host.finishAndAdopt.mockImplementation(async () => {
    const committed = await finish.promise;
    order.push('adopt');
    return committed;
  });
  await f.episode.begin();
  const work = f.episode.finish().then((result) => {
    order.push('settled');
    return result;
  });
  f.outer.abort();
  finish.resolve(receipt);
  expect(await work).toEqual({ status: 'finished', receipt });
  expect(order).toEqual(['adopt', 'settled']);
  await f.episode.dispose();
});
it('unknown finish failure remains visible rather than being relabeled canceled', async () => {
  const f = fixture();
  await f.episode.begin();
  f.host.finishAndAdopt.mockRejectedValue(new Error('unconfirmed'));
  await expect(f.episode.finish()).rejects.toThrow('unconfirmed');
  await f.episode.dispose();
});
it('partial source coverage and exhausted checks produce truthful retained/deferred text', () => {
  expect(
    sourceCleanupOutcomeText({
      status: 'finished',
      receipt: { ...receipt, status: 'coverage-incomplete', archivedCount: 0 },
    }),
  ).toMatch(/Saved channels were retained/);
  expect(
    sourceCleanupOutcomeText({
      status: 'finished',
      receipt: { ...receipt, status: 'budget-exhausted', deferredCount: 8 },
    }),
  ).toMatch(/later Refresh/);
  expect(
    sourceCleanupOutcomeText({
      status: 'finished',
      receipt: { ...receipt, status: 'completed', archivedCount: 0, deferredCount: 44 },
    }),
  ).toBe('More cleanup checks were deferred until a later Refresh.');
});

async function commitFixture() {
  let stored = defaultPreferences(360),
    adopted = structuredClone(stored),
    current = true,
    admitted = true;
  const order: string[] = [];
  const preferences = new SerializedPreferencesStore({
    read: async () => {
      order.push('read');
      return structuredClone(stored);
    },
    write: async (value) => {
      stored = structuredClone(value);
    },
  });
  await preferences.load();
  order.length = 0;
  let writes: Promise<unknown> = Promise.resolve();
  const host = {
    preferences,
    current: () => current,
    admitted: () => admitted,
    queue: <T>(operation: () => Promise<T>) => {
      const work = writes.then(operation);
      writes = work.catch(() => undefined);
      return work;
    },
    acknowledge: vi.fn(() => {
      order.push('ack');
    }),
    adopt: vi.fn((settings: typeof stored) => {
      adopted = settings;
      order.push('adopt');
    }),
  };
  const transport = {
    begin: vi.fn(),
    cancel: vi.fn(),
    finish: vi.fn(async () => {
      stored = { ...stored, removedChannels: ['gone'] };
      order.push('commit');
      return receipt;
    }),
  };
  return {
    host,
    transport,
    order,
    preferences,
    adopted: () => adopted,
    replaceRoot() {
      current = false;
    },
    deny() {
      admitted = false;
    },
    commit() {
      stored = { ...stored, removedChannels: ['gone'] };
    },
  };
}
it('finish adopts authoritative preferences through both queues before activation can continue', async () => {
  const f = await commitFixture();
  expect(
    await finishAndAdoptSourceCleanup(f.host, f.transport, roundId, new AbortController().signal),
  ).toEqual(receipt);
  expect(f.order).toEqual(['commit', 'ack', 'read', 'adopt']);
  expect(f.adopted().removedChannels).toEqual(['gone']);
});
it('queued user settings survive cleanup adoption and late abort does not skip the saved removal', async () => {
  const f = await commitFixture(),
    finish = deferred<SourceCleanupReceipt>(),
    abort = new AbortController();
  f.transport.finish.mockImplementation(async () => {
    const result = await finish.promise;
    f.commit();
    return result;
  });
  const work = finishAndAdoptSourceCleanup(f.host, f.transport, roundId, abort.signal);
  await vi.waitFor(() => expect(f.transport.finish).toHaveBeenCalledTimes(1));
  const edit = f.preferences.update((draft) => {
    draft.favorites.push('kept');
  });
  abort.abort();
  finish.resolve(receipt);
  await work;
  await edit;
  expect(f.adopted().removedChannels).toEqual(['gone']);
  expect(f.preferences.snapshot()).toMatchObject({
    removedChannels: ['gone'],
    favorites: ['kept'],
  });
});
it('a changed root after a real receipt requires reload and cannot adopt old-root preferences', async () => {
  const f = await commitFixture();
  f.transport.finish.mockImplementation(async () => {
    f.commit();
    f.replaceRoot();
    return receipt;
  });
  await expect(
    finishAndAdoptSourceCleanup(f.host, f.transport, roundId, new AbortController().signal),
  ).rejects.toBeInstanceOf(SourceCleanupProjectionError);
  expect(f.host.acknowledge).not.toHaveBeenCalled();
  expect(f.host.adopt).not.toHaveBeenCalled();
});
