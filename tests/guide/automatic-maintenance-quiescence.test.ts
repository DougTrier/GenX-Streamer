/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createAutomaticGuideBuilder } from '../../src/guide/automatic-build';
import { createGuideMaintenance } from '../../src/application/guide/guide-maintenance';

const api = vi.hoisted(() => ({ invoke: vi.fn(), sources: vi.fn(), coverage: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: () => true }));
vi.mock('../../src/guide/native', () => ({
  nativeGuide: { sources: api.sources, coverage: api.coverage },
}));
const gate = <T = void>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
};
const receipt = () => ({
  maintenance: {
    value: {
      sourcesChanged: 0,
      programsBefore: 1,
      programsAfter: 1,
      programsRemoved: 0,
      headersRetained: 1,
    },
    compaction: {
      status: 'skipped',
      pages: { pageSize: 4096, pages: 8, freePages: 0, fileBytes: 32768 },
    },
    fatalVerification: null,
  },
  rootGeneration: 1,
  quarantined: false,
  quarantineError: null,
});
beforeEach(() => {
  vi.useFakeTimers();
  api.invoke.mockReset().mockResolvedValue(receipt());
  api.sources.mockReset().mockResolvedValue([{ id: 'g' }]);
  api.coverage.mockReset().mockResolvedValue({ projectionCompatible: true });
});
const owners: ReturnType<typeof createGuideMaintenance>[] = [];
afterEach(async () => {
  for (const owner of owners.splice(0)) await owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
  vi.useRealTimers();
});
function fixture() {
  const state = { busy: false, scanning: false, allowed: true, current: true };
  const host = {
    scanning: () => state.scanning,
    playbackBusy: () => state.busy,
    canRun: () => state.allowed,
    scopeCurrent: () => state.current,
    changed: vi.fn(),
    failed: vi.fn(),
  };
  const owner = createGuideMaintenance(host);
  owners.push(owner);
  return { owner, state, host };
}
const deferredReceipt = () => {
  const value = receipt();
  return {
    ...value,
    maintenance: {
      ...value.maintenance,
      compaction: { status: 'deferred', reason: 'sqlite-maintenance-cancelled', pages: null },
    },
  };
};
const nativeCalls = () =>
  api.invoke.mock.calls.filter(([command]) => command === 'guide_retention_cleanup');
async function expectUnconfirmed(owner: ReturnType<typeof createGuideMaintenance>, error: unknown) {
  await expect(owner.preparePlayback()).rejects.toBe(error);
  await expect(owner.wake()).rejects.toBe(error);
  await expect(owner.dispose()).rejects.toBe(error);
  owners.splice(owners.indexOf(owner), 1);
}

it('does not start exclusive maintenance when the full Guide builder finishes after a tune', async () => {
  const captured = gate(),
    finished = gate();
  let playbackBusy = false;
  const host = {
    scanning: () => false,
    playbackBusy: () => playbackBusy,
    canRun: () => true,
    scopeCurrent: () => true,
    changed: vi.fn(),
    failed: vi.fn(),
  };
  const maintain = createGuideMaintenance(host);
  const builder = createAutomaticGuideBuilder({
    canRun: () => true,
    isCurrent: () => true,
    capture: async () => {
      captured.resolve();
      await finished.promise;
      return { catalogRevision: '1', channelCount: 1, providers: [] };
    },
    preview: async () => {
      throw new Error('No acquisition is expected.');
    },
    commitMatched: async () => {
      throw new Error('No publication is expected.');
    },
    discard: async () => undefined,
    maintain,
  });
  try {
    const work = builder.run();
    await captured.promise;
    playbackBusy = true;
    finished.resolve();
    expect(await work).toMatchObject({ maintenance: 'deferred' });
    expect(api.invoke).not.toHaveBeenCalled();
  } finally {
    await builder.dispose();
    await maintain.dispose();
  }
});

it.each([
  'connecting',
  'buffering',
  'playing',
  'paused selected media',
  'Web page',
  'Guide browsing',
  'dialog',
])(
  'queues storage work while %s owns the foreground and retries only storage after idle',
  async () => {
    const f = fixture();
    f.state.busy = true;
    expect(await f.owner(new AbortController().signal)).toBe('deferred');
    await vi.advanceTimersByTimeAsync(1000);
    expect(api.sources).not.toHaveBeenCalled();
    expect(api.invoke).not.toHaveBeenCalled();
    f.state.busy = false;
    await vi.advanceTimersByTimeAsync(250);
    expect(nativeCalls()).toHaveLength(1);
    expect(f.host.changed).toHaveBeenCalledOnce();
  },
);

it.each(['sources', 'coverage'] as const)(
  'rechecks foreground ownership after a delayed %s read',
  async (phase) => {
    const f = fixture();
    const held = gate<unknown>();
    api[phase].mockReturnValueOnce(held.promise);
    const work = f.owner(new AbortController().signal);
    await vi.advanceTimersByTimeAsync(0);
    f.state.busy = true;
    held.resolve(phase === 'sources' ? [{ id: 'g' }] : { projectionCompatible: true });
    expect(await work).toBe('deferred');
    expect(api.invoke).not.toHaveBeenCalled();
  },
);

it('joins the exact maintenance and cancel acknowledgment before playback admission, then wakes deferred storage', async () => {
  const f = fixture(),
    command = gate<unknown>(),
    cancel = gate();
  let calls = 0;
  api.invoke.mockImplementation((name: string) =>
    name === 'cancel_playlist'
      ? cancel.promise
      : ++calls === 1
        ? command.promise
        : Promise.resolve(receipt()),
  );
  const work = f.owner(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  const requestId = nativeCalls()[0][1].requestId;
  f.state.busy = true;
  let admitted = false;
  const admission = f.owner.preparePlayback().then(() => {
    admitted = true;
  });
  expect(api.invoke.mock.calls.at(-1)).toEqual(['cancel_playlist', { requestId }]);
  command.resolve(deferredReceipt());
  await vi.advanceTimersByTimeAsync(0);
  expect(admitted).toBe(false);
  cancel.resolve();
  await admission;
  expect(await work).toBe('deferred');
  expect(admitted).toBe(true);
  expect(nativeCalls()).toHaveLength(1);
  f.state.busy = false;
  await f.owner.wake();
  expect(nativeCalls()).toHaveLength(2);
});

it('interrupts admitted native work when a new workload appears without an explicit admission callback', async () => {
  const f = fixture(),
    command = gate<unknown>();
  api.invoke.mockImplementation((name: string) =>
    name === 'cancel_playlist' ? Promise.resolve() : command.promise,
  );
  const work = f.owner(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  f.state.busy = true;
  await vi.advanceTimersByTimeAsync(100);
  expect(api.invoke.mock.calls.map(([name]) => name)).toEqual([
    'guide_retention_cleanup',
    'cancel_playlist',
  ]);
  command.reject('sqlite-maintenance-cancelled');
  expect(await work).toBe('deferred');
  expect(f.host.changed).not.toHaveBeenCalled();
});

it('keeps a late completed receipt truthful and does not repeat finished compaction', async () => {
  const f = fixture(),
    command = gate<unknown>();
  api.invoke.mockImplementation((name: string) =>
    name === 'cancel_playlist' ? Promise.resolve() : command.promise,
  );
  const work = f.owner(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  f.state.busy = true;
  const admission = f.owner.preparePlayback();
  command.resolve(receipt());
  await admission;
  expect(await work).toBe('skipped');
  expect(f.host.changed).toHaveBeenCalledOnce();
  f.state.busy = false;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(nativeCalls()).toHaveLength(1);
});

it('does not disguise an unknown native failure as an owned workload cancellation', async () => {
  const f = fixture(),
    command = gate<unknown>();
  const failure = new Error('fixture storage operation refused');
  api.invoke.mockImplementation((name: string) =>
    name === 'cancel_playlist' ? Promise.resolve() : command.promise,
  );
  const work = f.owner(new AbortController().signal);
  const observed = work.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  f.state.busy = true;
  await vi.advanceTimersByTimeAsync(100);
  command.reject(failure);
  expect(await observed).toBe(failure);
  f.state.busy = false;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(nativeCalls()).toHaveLength(1);
  await expectUnconfirmed(f.owner, failure);
});

it('preserves cancellation uncertainty even when a durable receipt arrives', async () => {
  const f = fixture(),
    command = gate<unknown>();
  api.invoke.mockImplementation((name: string) =>
    name === 'cancel_playlist'
      ? Promise.reject(new Error('fixture missing cancellation acknowledgment'))
      : command.promise,
  );
  const work = f.owner(new AbortController().signal);
  const observed = work.catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  f.state.busy = true;
  await vi.advanceTimersByTimeAsync(100);
  command.resolve(receipt());
  const error = await observed;
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain('cancellation could not be confirmed');
  expect(f.host.changed).not.toHaveBeenCalled();
  f.state.busy = false;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(nativeCalls()).toHaveLength(1);
  await expectUnconfirmed(f.owner, error);
});

it.each(['suspend', 'dispose'] as const)(
  'revokes queued work at %s rather than carrying it into another root or settings epoch',
  async (method) => {
    const f = fixture();
    f.state.busy = true;
    await f.owner(new AbortController().signal);
    await f.owner[method]();
    f.state.busy = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(api.invoke).not.toHaveBeenCalled();
  },
);

it('does not rearm an interrupted receipt after lifecycle suspension', async () => {
  const f = fixture(),
    command = gate<unknown>();
  api.invoke.mockImplementation((name: string) =>
    name === 'cancel_playlist' ? Promise.resolve() : command.promise,
  );
  const work = f.owner(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  const joined = f.owner.suspend();
  command.resolve(deferredReceipt());
  await joined;
  expect(await work).toBe('deferred');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(nativeCalls()).toHaveLength(1);
});

it('drops a deferred request when its captured configuration is no longer current', async () => {
  const f = fixture();
  f.state.busy = true;
  await f.owner(new AbortController().signal);
  f.state.current = false;
  f.state.busy = false;
  await vi.advanceTimersByTimeAsync(250);
  expect(api.invoke).not.toHaveBeenCalled();
});

it('keeps unsupported native maintenance optional and does not poll forever', async () => {
  const f = fixture();
  api.coverage.mockResolvedValue({});
  expect(await f.owner(new AbortController().signal)).toBeUndefined();
  expect(api.invoke).not.toHaveBeenCalled();
});

it('coalesces concurrent playback admission and lets a newer lifecycle suspension revoke its idle retry', async () => {
  const f = fixture(),
    command = gate<unknown>(),
    cancel = gate();
  api.invoke.mockImplementation((name: string) =>
    name === 'cancel_playlist' ? cancel.promise : command.promise,
  );
  const work = f.owner(new AbortController().signal);
  await vi.advanceTimersByTimeAsync(0);
  f.state.busy = true;
  const first = f.owner.preparePlayback();
  const second = f.owner.preparePlayback();
  expect(second).toBe(first);
  const suspension = f.owner.suspend();
  command.resolve(deferredReceipt());
  cancel.resolve();
  await Promise.all([first, suspension, work]);
  expect(api.invoke.mock.calls.filter(([name]) => name === 'cancel_playlist')).toHaveLength(1);
  f.state.busy = false;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(nativeCalls()).toHaveLength(1);
});

it('blocks playback admission on an unconfirmed storage failure', async () => {
  const f = fixture(),
    command = gate<unknown>();
  const failure = new Error('fixture unknown native outcome');
  api.invoke.mockImplementation((name: string) =>
    name === 'cancel_playlist' ? Promise.resolve() : command.promise,
  );
  const work = f.owner(new AbortController().signal).catch((error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  const admission = f.owner.preparePlayback().catch((error: unknown) => error);
  command.reject(failure);
  expect(await work).toBe(failure);
  expect(await admission).toBe(failure);
  expect(f.host.changed).not.toHaveBeenCalled();
  await expectUnconfirmed(f.owner, failure);
});

it('reports a failed idle retry once without starting another storage or feed operation', async () => {
  const f = fixture();
  const failure = new Error('fixture deferred storage refused');
  f.state.busy = true;
  await f.owner(new AbortController().signal);
  f.state.busy = false;
  api.invoke.mockRejectedValue(failure);
  await vi.advanceTimersByTimeAsync(250);
  expect(f.host.failed).toHaveBeenCalledExactlyOnceWith(failure);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(nativeCalls()).toHaveLength(1);
  await expectUnconfirmed(f.owner, failure);
});

it('does not reacquire when lifecycle permission is absent', async () => {
  const f = fixture();
  f.state.allowed = false;
  expect(await f.owner(new AbortController().signal)).toBe('deferred');
  f.state.allowed = true;
  await f.owner.wake();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(api.invoke).not.toHaveBeenCalled();
});

it('retains only a storage intent while a scan is active', async () => {
  const f = fixture();
  f.state.scanning = true;
  expect(await f.owner(new AbortController().signal)).toBe('deferred');
  expect(api.sources).not.toHaveBeenCalled();
  f.state.scanning = false;
  await f.owner.wake();
  expect(nativeCalls()).toHaveLength(1);
});
