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
import {
  PlaybackController,
  type EngineEvent,
  type PlaybackEngine,
  VOD_SEEK_MS,
} from '../../src/playback/controller';
import { createBrowserEngine } from '../../src/platform/browser-engine';
import { createResourceOwners } from '../../src/playback/resource-owners';

const vod = (id: string) => ({
  id,
  name: id,
  url: `https://fixture.invalid/${id}.mp4`,
  playMode: 'on-demand' as const,
  mediaKind: 'media' as const,
  mediaMime: 'video/mp4',
});
class Video extends EventTarget {
  textTracks = [];
  paused = false;
  seeking = false;
  readyState = 2;
  duration = 120;
  src = '';
  muted = false;
  volume = 1;
  position = 10;
  positions: number[] = [];
  spans: Array<[number, number]> = [[0, 120]];
  get currentTime() {
    return this.position;
  }
  set currentTime(value: number) {
    this.position = value;
    this.positions.push(value);
    this.seeking = true;
    this.dispatchEvent(new Event('seeking'));
  }
  get seekable() {
    return {
      length: this.spans.length,
      start: (i: number) => this.spans[i]![0],
      end: (i: number) => this.spans[i]![1],
    };
  }
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  });
  load = vi.fn();
  removeAttribute = vi.fn(() => {
    this.src = '';
  });
  canPlayType = () => 'probably';
  completeSeek() {
    this.seeking = false;
    this.dispatchEvent(new Event('seeked'));
  }
  get element() {
    return this as unknown as HTMLVideoElement;
  }
}
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('finite engine seek (controlled media fixture, no decoder claim)', () => {
  it('validates actual ranges and completes only on seeked, without reallocating the engine', async () => {
    const video = new Video(),
      resources = createResourceOwners(),
      abort = new AbortController();
    const engine = createBrowserEngine(
      video.element,
      () => {},
      async () => ({ kind: 'media', mime: 'video/mp4' }),
      { owners: resources },
    );
    try {
      await engine.start(vod('a'), abort.signal);
      expect(engine.readVODposition!()).toBe(10);
      video.spans = [
        [0, 20],
        [40, 120],
      ];
      expect(await engine.seekVOD!(30, abort.signal)).toBe('out-of-range');
      expect(video.positions).toEqual([]);
      const seeking = engine.seekVOD!(60, abort.signal);
      expect(engine.readVODposition!()).toBeNull();
      let settled = false;
      void seeking.then(() => {
        settled = true;
      });
      await flush();
      expect(settled).toBe(false);
      video.completeSeek();
      expect(await seeking).toBe('seeked');
      expect(engine.readVODposition!()).toBe(60);
      expect(video.play).toHaveBeenCalledOnce();
      expect(resources.snapshot().counts.initializationWaits).toBe(0);
    } finally {
      await engine.dispose();
    }
    expect(Object.values(resources.snapshot().counts).every((count) => count === 0)).toBe(true);
  });

  it('refuses unknown duration, invalid targets and live media without mutation', async () => {
    const video = new Video(),
      abort = new AbortController();
    const engine = createBrowserEngine(video.element, () => {});
    try {
      await engine.start(vod('a'), abort.signal);
      for (const seconds of [NaN, Infinity, -1, 121, 604801])
        expect(await engine.seekVOD!(seconds, abort.signal)).toBe('out-of-range');
      video.duration = Infinity;
      expect(engine.readVODposition!()).toBeNull();
      expect(await engine.seekVOD!(12, abort.signal)).toBe('unavailable');
      video.duration = 120;
      video.spans = [];
      expect(engine.readVODposition!()).toBeNull();
      expect(await engine.seekVOD!(12, abort.signal)).toBe('unavailable');
      expect(video.positions).toEqual([]);
    } finally {
      await engine.dispose();
    }
    const live = createBrowserEngine(video.element, () => {});
    try {
      video.duration = 120;
      await live.start({ ...vod('live'), playMode: undefined }, new AbortController().signal);
      expect(await live.seekVOD!(40, new AbortController().signal)).toBe('unavailable');
      expect(video.positions).toEqual([]);
    } finally {
      await live.dispose();
    }
  });

  it('joins aborted/stalled seeks and preserves finite paused position on resume', async () => {
    const video = new Video(),
      resources = createResourceOwners(),
      abort = new AbortController();
    const engine = createBrowserEngine(video.element, () => {}, undefined, { owners: resources });
    try {
      await engine.start(vod('a'), abort.signal);
      engine.pause();
      video.position = 30;
      video.spans = [[50, 100]];
      await engine.resume();
      expect(video.position).toBe(30); // no live-edge jump to 98.
      const seekAbort = new AbortController();
      const pending = engine.seekVOD!(60, seekAbort.signal);
      seekAbort.abort();
      expect(await pending).toBe('unavailable');
      video.seeking = false;
      const stalled = engine.seekVOD!(80, abort.signal);
      // The engine timer is a backstop behind the controller's seek window.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await stalled).toBe('unavailable');
      expect(resources.snapshot().counts.loaderTimers).toBe(0);
      expect(resources.snapshot().counts.initializationWaits).toBe(0);
    } finally {
      await engine.dispose();
    }
  });
});

describe('finite controller generation and watchdog fences', () => {
  function fixture() {
    const owners: Array<{
      emit(event: EngineEvent): void;
      engine: PlaybackEngine;
      position: number;
    }> = [];
    const controller = new PlaybackController((emit) => {
      const owner = { emit, position: 10, engine: null as unknown as PlaybackEngine };
      owner.engine = {
        start: async () => {},
        pause: () => {},
        resume: async () => {},
        setMuted: () => {},
        setVolume: () => {},
        dispose: vi.fn(),
        readVODposition: () => owner.position,
        seekVOD: vi.fn(async (seconds) => {
          owner.position = seconds;
          return 'seeked' as const;
        }),
      };
      owners.push(owner);
      return owner.engine;
    });
    return { controller, owners };
  }
  it('keeps one engine, requires progress after seek, and has no paused false watchdog', async () => {
    const f = fixture();
    try {
      await f.controller.select(vod('a'));
      f.owners[0]!.emit({ type: 'progress' });
      expect(await f.controller.seek(40)).toEqual({ ok: true });
      expect(f.controller.snapshot.state).toBe('buffering');
      expect(f.owners).toHaveLength(1);
      f.owners[0]!.emit({ type: 'progress' });
      f.controller.pause();
      expect(await f.controller.seek(50)).toEqual({ ok: true });
      expect(f.controller.currentVODposition()).toBe(50);
      await vi.advanceTimersByTimeAsync(21_000);
      expect(f.controller.snapshot.state).toBe('paused');
    } finally {
      await f.controller.dispose();
    }
  });
  it('rejects live and nonfinite/out-of-range requests without new engines or writes', async () => {
    const f = fixture();
    try {
      await f.controller.select({ ...vod('live'), playMode: undefined });
      f.owners[0]!.emit({ type: 'progress' });
      expect(await f.controller.seek(10)).toEqual({ ok: false, reason: 'unavailable' });
      expect(f.owners[0]!.engine.seekVOD).not.toHaveBeenCalled();
      for (const value of [NaN, Infinity, -1, 604801])
        expect(await f.controller.seek(value)).toEqual({ ok: false, reason: 'invalid-position' });
      await f.controller.select(vod('a'));
      f.owners[1]!.emit({ type: 'progress' });
      vi.mocked(f.owners[1]!.engine.seekVOD!).mockResolvedValueOnce('out-of-range');
      expect(await f.controller.seek(120)).toEqual({ ok: false, reason: 'out-of-range' });
      expect(f.controller.snapshot.state).toBe('playing');
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await f.controller.dispose();
    }
  });
  it('joins A seek abort before allocating B and prevents old offsets reaching B', async () => {
    const f = fixture();
    try {
      await f.controller.select(vod('a'));
      f.owners[0]!.emit({ type: 'progress' });
      vi.mocked(f.owners[0]!.engine.seekVOD!).mockImplementationOnce(
        (_seconds, signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve('unavailable'), { once: true });
          }),
      );
      const seeking = f.controller.seek(80);
      await flush();
      const switching = f.controller.select(vod('b'));
      expect(await seeking).toEqual({ ok: false, reason: 'superseded' });
      await switching;
      expect(f.owners).toHaveLength(2);
      expect(f.owners[1]!.position).toBe(10);
      expect(f.owners[0]!.engine.dispose).toHaveBeenCalledOnce();
    } finally {
      await f.controller.dispose();
    }
  });
  it('never labels the retiring A engine position as newly selected B', async () => {
    const f = fixture();
    let release!: () => void;
    const joined = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await f.controller.select(vod('a'));
      f.owners[0]!.emit({ type: 'progress' });
      vi.mocked(f.owners[0]!.engine.dispose).mockReturnValueOnce(joined);
      const switching = f.controller.select(vod('b'));
      expect(f.controller.snapshot.selection?.id).toBe('b');
      expect(f.controller.currentVODposition()).toBeNull();
      expect(await f.controller.seek(80)).toEqual({ ok: false, reason: 'unavailable' });
      release();
      await switching;
      expect(f.owners).toHaveLength(2);
    } finally {
      release();
      await f.controller.dispose();
    }
  });
  it('stalled seeking cannot silence the controller deadline indefinitely', async () => {
    const f = fixture();
    try {
      await f.controller.select(vod('a'));
      f.owners[0]!.emit({ type: 'progress' });
      vi.mocked(f.owners[0]!.engine.seekVOD!).mockImplementationOnce(
        (_seconds, signal) =>
          new Promise((resolve) => {
            signal.addEventListener('abort', () => resolve('unavailable'), { once: true });
          }),
      );
      const seeking = f.controller.seek(80);
      await flush();
      await vi.advanceTimersByTimeAsync(VOD_SEEK_MS);
      expect(await seeking).toEqual({ ok: false, reason: 'failed' });
      expect(f.controller.snapshot.state).toBe('failed');
      expect(f.owners).toHaveLength(1);
    } finally {
      await f.controller.dispose();
    }
  });
  it('a resume seek started during startup gets its own window, not the startup remainder', async () => {
    const f = fixture();
    let complete!: (value: 'seeked') => void;
    try {
      await f.controller.select(vod('a'));
      // Still starting (no progress yet): 15 of the 20 startup seconds are spent.
      f.owners[0]!.emit({ type: 'buffering' });
      await vi.advanceTimersByTimeAsync(15_000);
      vi.mocked(f.owners[0]!.engine.seekVOD!).mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      );
      const seeking = f.controller.seek(80);
      await flush();
      // A slow remote range response well past the old startup deadline.
      await vi.advanceTimersByTimeAsync(VOD_SEEK_MS - 5_000);
      expect(f.controller.snapshot.state).not.toBe('failed');
      complete('seeked');
      expect(await seeking).toEqual({ ok: true });
      f.owners[0]!.emit({ type: 'progress' });
      expect(f.controller.snapshot.state).toBe('playing');
    } finally {
      await f.controller.dispose();
    }
  });
  it('a failed seek during startup renews the startup window instead of failing at once', async () => {
    const f = fixture();
    try {
      await f.controller.select(vod('a'));
      f.owners[0]!.emit({ type: 'buffering' });
      await vi.advanceTimersByTimeAsync(19_000);
      vi.mocked(f.owners[0]!.engine.seekVOD!).mockImplementationOnce(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_000));
        return 'unavailable';
      });
      const seeking = f.controller.seek(80);
      await flush();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(await seeking).toEqual({ ok: false, reason: 'unavailable' });
      expect(f.controller.snapshot.state).not.toBe('failed');
      f.owners[0]!.emit({ type: 'progress' });
      expect(f.controller.snapshot.state).toBe('playing');
    } finally {
      await f.controller.dispose();
    }
  });
  it('a refused seek preserves the original recovery deadline rather than restarting it', async () => {
    const f = fixture();
    try {
      await f.controller.select(vod('a'));
      f.owners[0]!.emit({ type: 'progress' });
      f.owners[0]!.emit({ type: 'buffering' });
      await vi.advanceTimersByTimeAsync(10_000);
      vi.mocked(f.owners[0]!.engine.seekVOD!).mockResolvedValueOnce('out-of-range');
      expect(await f.controller.seek(121)).toEqual({ ok: false, reason: 'out-of-range' });
      await vi.advanceTimersByTimeAsync(10_000);
      expect(f.controller.snapshot.state).toBe('failed');
      expect(f.owners).toHaveLength(1);
    } finally {
      await f.controller.dispose();
    }
  });
});
