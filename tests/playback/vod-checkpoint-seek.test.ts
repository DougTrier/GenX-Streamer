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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createArchivePlayer } from '../../src/application/genxtra/archive-player';
import {
  PlaybackController,
  type EngineEvent,
  type PlaybackEngine,
  type VODReleaseObservation,
} from '../../src/playback/controller';
import { createResourceOwners } from '../../src/playback/resource-owners';
import type { ArchiveBookmarkSaveRequest } from '../../src/platform/archive-bookmarks';
import type { ArchiveSelection } from '../../src/platform/archive-catalog';

const selected: ArchiveSelection = {
  titleRef: 'a'.repeat(64),
  fileRef: 'b'.repeat(64),
  expectedRevision: '1',
  title: 'Controlled series',
  fileTitle: 'Controlled episode',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
const flush = async () => {
  for (let i = 0; i < 24; i++) await Promise.resolve();
};

/** Real controller + Archive application; only engine/native/storage boundaries are controlled. */
function fixture(holdSave = false) {
  const resources = createResourceOwners();
  const seekEntered = deferred<void>();
  const seekFinished = deferred<'seeked' | 'unavailable'>();
  const saveFinished = deferred<void>();
  if (!holdSave) saveFinished.resolve();
  const events: string[] = [];
  const owners: Array<{
    emit(event: EngineEvent): void;
    engine: PlaybackEngine;
    position: number | null;
    seeking: boolean;
    seekSignal?: AbortSignal;
  }> = [];
  let nextPosition: number | null = 12.5;
  const player = new PlaybackController(
    (emit) => {
      const owner = {
        emit,
        position: nextPosition,
        seeking: false,
        seekSignal: undefined as AbortSignal | undefined,
        engine: null as unknown as PlaybackEngine,
      };
      owner.engine = {
        start: async () => {},
        pause: vi.fn(),
        resume: async () => {},
        setMuted: () => {},
        setVolume: () => {},
        readVODposition: () => (owner.seeking ? null : owner.position),
        readVODduration: () => 120,
        seekVOD: vi.fn(async (seconds, signal) => {
          events.push(`seek-request-${seconds}`);
          owner.seeking = true;
          owner.seekSignal = signal;
          seekEntered.resolve();
          // Abort is observable, but cannot acknowledge this held original's settlement.
          const result = await seekFinished.promise;
          owner.seeking = false;
          if (result === 'seeked' && !signal.aborted) owner.position = seconds;
          events.push('seek-settled');
          return signal.aborted ? 'unavailable' : result;
        }),
        dispose: vi.fn(() => {
          events.push('decoder-dispose');
        }),
      };
      owners.push(owner);
      return owner.engine;
    },
    undefined,
    resources,
  );
  const observations: VODReleaseObservation[] = [];
  const unsubscribe = player.subscribeVODRelease((value) => observations.push(value));
  const bookmarks = {
    read: vi.fn(async () => ({
      schemaVersion: 1 as const,
      sessionGeneration: '1',
      supported: true,
      revision: '0',
      position: null,
    })),
    save: vi.fn(async (request: ArchiveBookmarkSaveRequest) => {
      events.push(`save-request-${request.positionMs}`);
      await saveFinished.promise;
      events.push('save-settled');
      return {
        schemaVersion: 1 as const,
        sessionGeneration: request.sessionGeneration,
        committed: true as const,
        revision: String(BigInt(request.expectedRevision) + 1n),
        changed: true,
      };
    }),
  };
  const playback = {
    start: vi.fn(async () => ({
      kind: 'started' as const,
      schemaVersion: 1 as const,
      sessionGeneration: '1',
      mediaUrl: `http://127.0.0.1:23456/archive/${'c'.repeat(64)}/${'d'.repeat(64)}.mp4`,
      leaseMs: 60000 as const,
      cleanupPending: false as const,
    })),
    stop: vi.fn(async (sessionGeneration: string) => {
      events.push('native-stop');
      return {
        schemaVersion: 1 as const,
        sessionGeneration,
        stopped: true as const,
        cleanupPending: false as const,
      };
    }),
    renew: vi.fn(async (sessionGeneration: string) => ({
      schemaVersion: 1 as const,
      sessionGeneration,
      renewed: true as const,
      leaseMs: 60000 as const,
    })),
    retryCleanup: vi.fn(async () => {}),
  };
  const archive = createArchivePlayer({
    player,
    bookmarks,
    playback,
    readyScope: () => 'owned-root',
    catalogRevision: () => '1',
    beforeStart: async () => {},
  });
  return {
    player,
    archive,
    bookmarks,
    playback,
    owners,
    resources,
    observations,
    events,
    seekEntered,
    seekFinished,
    saveFinished,
    nextPosition: (value: number | null) => {
      nextPosition = value;
    },
    start: async () => {
      await archive.select(selected);
      owners[0]!.emit({ type: 'progress' });
      expect(player.currentVODposition()).toBe(12.5);
    },
    close: async () => {
      seekFinished.resolve('unavailable');
      saveFinished.resolve();
      await archive.dispose();
      unsubscribe();
      await player.dispose();
    },
  };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('VOD lifecycle checkpoint during held seek (controlled integration, not decoder proof)', () => {
  it('treats an implemented null checkpoint as no authority instead of falling back to a strict host read', async () => {
    const f = fixture();
    const host = {
      select: vi.fn(async () => {}),
      stop: vi.fn(async () => {}),
      checkpointVODposition: vi.fn(() => null),
      currentVODposition: vi.fn(() => 12.5),
      currentVODduration: () => 120,
    };
    const archive = createArchivePlayer({
      player: host,
      bookmarks: f.bookmarks,
      playback: f.playback,
      readyScope: () => 'owned-root',
      catalogRevision: () => '1',
      beforeStart: async () => {},
    });
    try {
      await archive.select(selected);
      await archive.stop();
      expect(host.checkpointVODposition).toHaveBeenCalled();
      expect(host.currentVODposition).not.toHaveBeenCalled();
      expect(f.bookmarks.save).not.toHaveBeenCalled();
    } finally {
      await archive.dispose();
      await f.close();
    }
  });

  it('Pause saves the last actual 12.5 seconds while strict current position is null, never requested 22.5', async () => {
    const f = fixture();
    try {
      await f.start();
      let seekSettled = false;
      const seek = f.player.seek(22.5).then((result) => {
        seekSettled = true;
        return result;
      });
      await f.seekEntered.promise;
      expect(f.player.currentVODposition()).toBeNull();
      f.player.pause();
      await flush();
      expect(seekSettled).toBe(false);
      expect(f.observations.at(-1)).toMatchObject({ reason: 'paused', positionSeconds: 12.5 });
      expect(f.bookmarks.save.mock.calls.map(([request]) => request.positionMs)).toEqual([12500]);
      expect(f.bookmarks.save.mock.calls[0]![0]).toMatchObject({
        durationMs: 120000,
        completed: false,
      });
      expect(f.player.checkpointVODposition()).toBe(12.5);
      f.seekFinished.resolve('unavailable');
      await seek;
    } finally {
      await f.close();
    }
    expect(Object.values(f.resources.snapshot().counts).every((n) => n === 0)).toBe(true);
  });

  it.each(['Stop', 'Exit'] as const)(
    '%s captures 12.5 before seek settlement and joins both held original seek and bookmark write',
    async (action) => {
      const f = fixture(true);
      let stopping: Promise<void> | undefined;
      try {
        await f.start();
        const seek = f.player.seek(22.5);
        await f.seekEntered.promise;
        expect(f.player.currentVODposition()).toBeNull();
        let stopSettled = false;
        stopping = (action === 'Stop' ? f.archive.stop() : f.archive.dispose()).then(() => {
          stopSettled = true;
        });
        await flush();
        expect(f.owners[0]!.seekSignal!.aborted).toBe(true);
        expect(f.bookmarks.save.mock.calls.map(([request]) => request.positionMs)).toEqual([12500]);
        expect(stopSettled).toBe(false);
        expect(f.owners[0]!.engine.dispose).not.toHaveBeenCalled();
        expect(f.playback.stop).not.toHaveBeenCalled();
        f.seekFinished.resolve('unavailable');
        await seek;
        await flush();
        expect(f.owners[0]!.engine.dispose).toHaveBeenCalledOnce();
        expect(stopSettled).toBe(false);
        expect(f.playback.stop).not.toHaveBeenCalled();
        f.saveFinished.resolve();
        await stopping;
        expect(f.playback.stop).toHaveBeenCalledOnce();
        expect(f.bookmarks.save.mock.calls.map(([request]) => request.positionMs)).toEqual([12500]);
        expect(f.events.indexOf('save-settled')).toBeLessThan(f.events.indexOf('native-stop'));
        expect(f.events.indexOf('seek-settled')).toBeLessThan(f.events.indexOf('decoder-dispose'));
      } finally {
        await f.close();
        await stopping;
      }
      expect(vi.getTimerCount()).toBe(0);
      expect(Object.values(f.resources.snapshot().counts).every((n) => n === 0)).toBe(true);
    },
  );

  it('a settled real seek can replace the cached observation only with an actual validated read', async () => {
    const f = fixture();
    try {
      await f.start();
      const seek = f.player.seek(22.5);
      await f.seekEntered.promise;
      expect(f.player.checkpointVODposition()).toBe(12.5);
      f.seekFinished.resolve('seeked');
      expect(await seek).toEqual({ ok: true });
      expect(f.player.currentVODposition()).toBe(22.5);
      expect(f.player.checkpointVODposition()).toBe(22.5);
      f.player.pause();
      await flush();
      expect(f.bookmarks.save.mock.calls.map(([request]) => request.positionMs)).toEqual([22500]);
    } finally {
      await f.close();
    }
  });

  it('does not lend retiring A observations to an unobserved replacement B or to live playback', async () => {
    const f = fixture();
    try {
      await f.start();
      const seek = f.player.seek(22.5);
      await f.seekEntered.promise;
      f.nextPosition(null);
      const switching = f.player.select({
        id: 'b',
        name: 'B',
        url: 'https://fixture.invalid/b.mp4',
        playMode: 'on-demand',
      });
      expect(f.player.currentVODposition()).toBeNull();
      expect(f.player.checkpointVODposition()).toBeNull();
      f.seekFinished.resolve('unavailable');
      await seek;
      await switching;
      f.owners[0]!.position = 99;
      f.owners[0]!.emit({ type: 'progress' });
      expect(f.player.checkpointVODposition()).toBeNull();
      f.player.pause();
      expect(f.observations.at(-1)).toMatchObject({ selectionId: 'b', positionSeconds: null });
      f.nextPosition(88);
      await f.player.select({ id: 'live', name: 'Live', url: 'https://fixture.invalid/live.m3u8' });
      expect(f.player.currentVODposition()).toBeNull();
      expect(f.player.checkpointVODposition()).toBeNull();
      await f.player.stop();
      expect(f.player.checkpointVODposition()).toBeNull();
    } finally {
      await f.close();
    }
  });
});
