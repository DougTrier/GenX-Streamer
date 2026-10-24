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

import { expect, it, vi } from 'vitest';
import { createAccountPlayer } from '../../src/application/accounts/account-player';
import { PlaybackController, type EngineEvent } from '../../src/playback/controller';
import { createArchivePlayer } from '../../src/application/genxtra/archive-player';
import { createAccountPlayback } from '../../src/platform/account-playback';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it('canceled public handoff cannot select after its preceding cleanup finally settles', async () => {
  const heldCleanup = deferred();
  const cleanupStarted = deferred();
  const select = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const owner = createAccountPlayer({
    player: { select, stop, suspend: stop },
    playback: {
      start: vi.fn(),
      stop: vi.fn(),
      retryCleanup: async () => {
        cleanupStarted.resolve();
        await heldCleanup.promise;
      },
    },
  });
  const abort = new AbortController();
  const selection = owner.selectPublic(
    { id: 'live-fixture', name: 'Live fixture', url: 'https://fixture.invalid/live.m3u8' },
    undefined,
    abort.signal,
  );
  const rejected = expect(selection).rejects.toMatchObject({ name: 'AbortError' });
  await cleanupStarted.promise;
  abort.abort();
  expect(select).not.toHaveBeenCalled();
  heldCleanup.resolve();
  await rejected;
  expect(select).not.toHaveBeenCalled();
  expect(stop).toHaveBeenCalledTimes(2);
  await owner.dispose();
});

it('aborting an admitted public handoff joins the real decoder stop before returning', async () => {
  const selected = deferred();
  const admitted = deferred();
  const decoderStopped = deferred();
  let stops = 0;
  const owner = createAccountPlayer({
    player: {
      select: async () => {
        admitted.resolve();
        await selected.promise;
      },
      stop: async () => {
        if (++stops === 2) {
          selected.resolve();
          await decoderStopped.promise;
        }
      },
      suspend: async () => {},
    },
    playback: { start: vi.fn(), stop: vi.fn(), retryCleanup: async () => undefined },
  });
  const abort = new AbortController();
  let settled = false;
  const selection = owner.selectPublic(
    { id: 'live-fixture', name: 'Live fixture', url: 'https://fixture.invalid/live.m3u8' },
    undefined,
    abort.signal,
  );
  const rejected = expect(selection).rejects.toMatchObject({ name: 'AbortError' });
  void selection.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await admitted.promise;
  abort.abort();
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  decoderStopped.resolve();
  await rejected;
  expect(stops).toBe(2);
  await owner.dispose();
});

it('background invalidates a public handoff without converting its suspended decoder to Stop', async () => {
  const selected = deferred();
  const admitted = deferred();
  const released = deferred();
  let state = 'idle';
  const stop = vi.fn(async () => {
    state = 'idle';
  });
  const suspend = vi.fn(async () => {
    state = 'paused';
    selected.resolve();
    await released.promise;
  });
  const owner = createAccountPlayer({
    player: {
      stop,
      suspend,
      select: async () => {
        state = 'connecting';
        admitted.resolve();
        await selected.promise;
      },
    },
    playback: { start: vi.fn(), stop: vi.fn(), retryCleanup: async () => {} },
  });
  const abort = new AbortController();
  const selecting = owner.selectPublic(
    { id: 'live', name: 'Live', url: 'https://fixture.invalid/live' },
    undefined,
    abort.signal,
  );
  const rejected = expect(selecting).rejects.toMatchObject({ name: 'AbortError' });
  await admitted.promise;
  let settled = false;
  const suspending = owner.suspend();
  expect(owner.suspend()).toBe(suspending);
  void suspending.then(() => {
    settled = true;
  });
  abort.abort();
  await Promise.resolve();
  expect(state).toBe('paused');
  expect(stop).toHaveBeenCalledTimes(1);
  expect(suspend).toHaveBeenCalledTimes(1);
  expect(settled).toBe(false);
  released.resolve();
  await Promise.all([rejected, suspending]);
  expect(state).toBe('paused');
  expect(owner.selection).toBeNull();
  await owner.dispose();
});

for (const state of ['connecting', 'playing'] as const)
  it(`account lifecycle preserves an admitted public ${state} pause and joins actual engine disposal`, async () => {
    let emit!: (event: EngineEvent) => void;
    const released = deferred();
    const dispose = vi.fn(async () => released.promise);
    const player = new PlaybackController((events) => {
      emit = events;
      return {
        start: async () => {},
        pause: () => {},
        resume: async () => {},
        setMuted: () => {},
        setVolume: () => {},
        dispose,
      };
    });
    const owner = createAccountPlayer({
      player,
      playback: { start: vi.fn(), stop: vi.fn(), retryCleanup: async () => {} },
    });
    const live = { id: 'live', name: 'Live', url: 'https://fixture.invalid/live' };
    try {
      await owner.selectPublic(live);
      if (state === 'playing') emit({ type: 'progress' });
      expect(player.snapshot.state).toBe(state);
      let settled = false;
      const suspending = owner.suspend();
      void suspending.then(() => {
        settled = true;
      });
      expect(player.snapshot).toMatchObject({
        state: 'paused',
        pauseReason: 'background',
        selection: live,
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      released.resolve();
      await suspending;
      expect(dispose).toHaveBeenCalledTimes(1);
      expect(player.snapshot.selection).toEqual(live);
      expect(owner.selection).toBeNull();
    } finally {
      released.resolve();
      await owner.dispose();
      await player.dispose();
    }
  });

it('background joins an unselected private allocation and exact native stop, retaining metadata for explicit Resume', async () => {
  const allocationStarted = deferred(),
    allocation = deferred(),
    nativeReleased = deferred();
  const select = vi.fn(async () => {});
  const nativeStop = vi.fn(async (sessionGeneration: string) => {
    await nativeReleased.promise;
    return { schemaVersion: 1 as const, stopped: true as const, sessionGeneration };
  });
  const cancellation = deferred();
  const cancel = vi.fn(async () => cancellation.promise);
  const requestId = 'frozen-private-allocation';
  const owner = createAccountPlayer({
    player: { select, stop: vi.fn(async () => {}), suspend: vi.fn(async () => {}) },
    playback: createAccountPlayback({
      idFactory: () => requestId,
      invoke: async (command, args) => {
        if (command === 'cancel_playlist') {
          expect(args?.requestId).toBe(requestId);
          return cancel();
        }
        if (command === 'stop_iptv_playback') return nativeStop(args?.sessionGeneration as string);
        if (command === 'start_iptv_playback') {
          allocationStarted.resolve();
          await allocation.promise;
          return {
            schemaVersion: 1,
            sessionGeneration: '1',
            mediaUrl: `http://127.0.0.1:1234/account/${'c'.repeat(64)}/media/${'d'.repeat(64)}`,
          };
        }
        throw new Error('Unexpected private playback command.');
      },
    }),
  });
  const fence = { accountId: 'a'.repeat(32), accountRevision: '1', mediaRevision: '1' };
  const channel = {
    id: `account-${fence.accountId}-${'b'.repeat(64)}`,
    name: 'Private fixture',
    category: '',
    providerId: null,
    epgId: null,
    streamReference: 'e'.repeat(32),
  };
  const selecting = owner.selectAccount(channel, fence);
  const rejected = expect(selecting).rejects.toMatchObject({ name: 'AbortError' });
  await allocationStarted.promise;
  let settled = false;
  const suspending = owner.suspend();
  expect(owner.suspend()).toBe(suspending);
  void suspending.then(() => {
    settled = true;
  });
  expect(owner.selection).toEqual({ channel, fence });
  expect(owner.backgroundPaused).toBe(true);
  await Promise.resolve();
  expect(settled).toBe(false);
  allocation.resolve();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledTimes(1));
  expect(nativeStop).not.toHaveBeenCalled();
  expect(settled).toBe(false);
  cancellation.resolve();
  await vi.waitFor(() => expect(nativeStop).toHaveBeenCalledWith('1'));
  expect(settled).toBe(false);
  expect(select).not.toHaveBeenCalled();
  nativeReleased.resolve();
  await Promise.all([rejected, suspending]);
  expect(owner.selection).toEqual({ channel, fence });
  expect(owner.allowsHttp('http://127.0.0.1:1234/account/private')).toBe(false);
  expect(select).not.toHaveBeenCalled();
  await owner.stop();
  expect(owner.selection).toBeNull();
  await owner.dispose();
});

it('background cancels and joins Archive handoff before a public owner can be admitted', async () => {
  const gate = deferred(),
    entered = deferred();
  const select = vi.fn(async () => {});
  const account = createAccountPlayer({
    player: { select, stop: vi.fn(async () => {}), suspend: vi.fn(async () => {}) },
    playback: { start: vi.fn(), stop: vi.fn(), retryCleanup: async () => {} },
  });
  let block = true;
  const archive = createArchivePlayer({
    player: { select, stop: vi.fn(async () => {}) },
    readyScope: () => 'root',
    catalogRevision: () => '1',
    beforeStart: async () => {},
    playback: {
      start: vi.fn(),
      stop: vi.fn(),
      renew: vi.fn(),
      retryCleanup: async () => {
        if (block) {
          entered.resolve();
          await gate.promise;
        }
      },
    },
  });
  const selecting = archive.handoff((signal) =>
    account.selectPublic(
      { id: 'live', name: 'Live', url: 'https://fixture.invalid/live' },
      undefined,
      signal,
    ),
  );
  const rejected = expect(selecting).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  const accountSuspension = account.suspend();
  let settled = false;
  const suspending = Promise.all([accountSuspension, archive.stop()]).then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  expect(select).not.toHaveBeenCalled();
  block = false;
  gate.resolve();
  await Promise.all([rejected, suspending]);
  expect(select).not.toHaveBeenCalled();
  await archive.dispose();
  await account.dispose();
});

it('a suspended private channel reacquires a new capability only on explicit selection', async () => {
  let starts = 0;
  const selected: string[] = [];
  const player = new PlaybackController(() => ({
    start: async (choice) => {
      selected.push(choice.url);
    },
    pause: () => {},
    resume: async () => {},
    setMuted: () => {},
    setVolume: () => {},
    dispose: async () => {},
  }));
  const stop = vi.fn(async (sessionGeneration: string) => ({
    schemaVersion: 1 as const,
    stopped: true as const,
    sessionGeneration,
  }));
  const owner = createAccountPlayer({
    player,
    playback: {
      start: async () => ({
        schemaVersion: 1,
        sessionGeneration: String(++starts),
        mediaUrl: `http://127.0.0.1:1234/account/${'c'.repeat(64)}/media/${String(starts).repeat(64)}`,
      }),
      stop,
      retryCleanup: async () => {},
    },
  });
  const fence = { accountId: 'a'.repeat(32), accountRevision: '1', mediaRevision: '1' };
  const channel = {
    id: `account-${fence.accountId}-${'b'.repeat(64)}`,
    name: 'Private fixture',
    category: '',
    providerId: null,
    epgId: null,
    streamReference: 'e'.repeat(32),
  };
  try {
    await owner.selectAccount(channel, fence);
    const original = player.snapshot.selection!.url;
    await owner.suspend();
    expect(player.snapshot).toMatchObject({ state: 'paused', pauseReason: 'background' });
    expect(owner.selection).toEqual({ channel, fence });
    expect(owner.allowsHttp(original)).toBe(false);
    expect(starts).toBe(1);
    expect(selected).toHaveLength(1);
    expect(stop).toHaveBeenCalledWith('1');
    await owner.selectAccount(owner.selection!.channel, owner.selection!.fence);
    expect(starts).toBe(2);
    expect(selected).toHaveLength(2);
    expect(selected[1]).not.toBe(original);
    expect(owner.allowsHttp(selected[1])).toBe(true);
    expect(owner.backgroundPaused).toBe(false);
  } finally {
    await owner.dispose();
    await player.dispose();
  }
});

it('background cleanup rejection remains a failed join and prevents later decoder admission', async () => {
  const gate = deferred(),
    entered = deferred();
  const select = vi.fn(async () => {});
  let fail = false;
  const owner = createAccountPlayer({
    player: {
      select,
      stop: vi.fn(async () => {}),
      suspend: async () => {
        entered.resolve();
        await gate.promise;
        if (fail) throw new Error('controlled decoder cleanup failed');
      },
    },
    playback: { start: vi.fn(), stop: vi.fn(), retryCleanup: async () => {} },
  });
  fail = true;
  const suspending = owner.suspend();
  const rejected = expect(suspending).rejects.toThrow('could not stop');
  await entered.promise;
  await expect(
    owner.selectPublic({ id: 'live', name: 'Live', url: 'https://fixture.invalid/live' }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  expect(select).not.toHaveBeenCalled();
  gate.resolve();
  await rejected;
  fail = false;
  await owner.dispose();
});

it('coordinated account suspension and Archive stop join the real bookmark before releasing its proxy', async () => {
  const saved = deferred();
  const events: string[] = [];
  const player = new PlaybackController(() => ({
    start: async () => {},
    pause: () => {},
    resume: async () => {},
    setMuted: () => {},
    setVolume: () => {},
    readVODposition: () => 12,
    readVODduration: () => 100,
    dispose: async () => {
      events.push('decoder-released');
    },
  }));
  const account = createAccountPlayer({
    player,
    playback: { start: vi.fn(), stop: vi.fn(), retryCleanup: async () => {} },
  });
  const save = vi.fn(
    async (request: import('../../src/platform/archive-bookmarks').ArchiveBookmarkSaveRequest) => {
      events.push(`bookmark-${request.positionMs}`);
      await saved.promise;
      return {
        schemaVersion: 1 as const,
        sessionGeneration: request.sessionGeneration,
        committed: true as const,
        revision: '2',
        changed: true,
      };
    },
  );
  const archive = createArchivePlayer({
    player,
    readyScope: () => 'root',
    catalogRevision: () => '1',
    beforeStart: async () => {},
    bookmarks: {
      read: async () => ({
        schemaVersion: 1,
        sessionGeneration: '1',
        supported: true,
        revision: '1',
        position: null,
      }),
      save,
    },
    playback: {
      start: async () => ({
        kind: 'started',
        schemaVersion: 1,
        sessionGeneration: '1',
        mediaUrl: `http://127.0.0.1:1234/archive/${'a'.repeat(64)}/${'b'.repeat(64)}.mp4`,
        leaseMs: 60000,
        cleanupPending: false,
      }),
      stop: async (sessionGeneration) => {
        events.push('proxy-released');
        return { schemaVersion: 1, sessionGeneration, stopped: true, cleanupPending: false };
      },
      renew: vi.fn(),
      retryCleanup: async () => {},
    },
  });
  try {
    await archive.select({
      titleRef: 'a'.repeat(64),
      fileRef: 'b'.repeat(64),
      expectedRevision: '1',
      title: 'Fixture',
      fileTitle: 'Fixture video',
    });
    const suspended = account.suspend();
    const joined = Promise.all([suspended, archive.stop()]);
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(1));
    expect(save.mock.calls[0][0].positionMs).toBe(12000);
    expect(events).not.toContain('proxy-released');
    saved.resolve();
    await joined;
    expect(events.indexOf('bookmark-12000')).toBeLessThan(events.indexOf('proxy-released'));
    expect(events.indexOf('decoder-released')).toBeLessThan(events.indexOf('proxy-released'));
    expect(archive.selection).toBeNull();
    expect(archive.allowsHttp('http://127.0.0.1:1234/archive/private')).toBe(false);
  } finally {
    saved.resolve();
    await archive.dispose();
    await account.dispose();
    await player.dispose();
  }
});
