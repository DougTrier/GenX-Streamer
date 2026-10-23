import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PlaybackController,
  type EngineEvent,
  type PlaybackEngine,
  type VODReleaseObservation,
  VOD_SEEK_MS,
} from '../../src/playback/controller';
import { createResourceOwners } from '../../src/playback/resource-owners';

const selection = (id: string) => ({
  id,
  name: id,
  url: `https://fixture.invalid/${id}.mp4`,
  playMode: 'on-demand' as const,
});
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
function fixture() {
  const resources = createResourceOwners();
  const owners: Array<{
    engine: PlaybackEngine;
    emit(event: EngineEvent): void;
    position: number | null;
    duration: number | null;
  }> = [];
  const controller = new PlaybackController(
    (emit) => {
      const owner = {
        engine: null as unknown as PlaybackEngine,
        emit,
        position: 12.345 as number | null,
        duration: 120.5 as number | null,
      };
      owner.engine = {
        start: async () => {},
        pause: vi.fn(),
        resume: async () => {},
        setMuted: () => {},
        setVolume: () => {},
        dispose: vi.fn(),
        readVODposition: () => owner.position,
        readVODduration: () => owner.duration,
        seekVOD: vi.fn(async (seconds) => {
          owner.position = seconds;
          return 'seeked' as const;
        }),
      };
      owners.push(owner);
      return owner.engine;
    },
    undefined,
    resources,
  );
  return { controller, owners, resources };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('VOD resume ownership (controlled engine; no physical decoder claim)', () => {
  it('captures actual finite position and duration before pause/replacement invalidates the owner', async () => {
    const f = fixture();
    const observations: VODReleaseObservation[] = [];
    f.controller.subscribeVODRelease((value) => observations.push(value));
    try {
      await f.controller.select(selection('a'));
      f.owners[0]!.emit({ type: 'progress' });
      f.controller.pause();
      expect(f.owners[0]!.engine.pause).toHaveBeenCalledOnce();
      expect(observations[0]).toEqual({
        selectionId: 'a',
        positionSeconds: 12.345,
        durationSeconds: 120.5,
        reason: 'paused',
      });
      expect(Object.isFrozen(observations[0])).toBe(true);
      await f.controller.select(selection('b'));
      expect(observations[1]).toEqual({ ...observations[0], reason: 'replaced' });
      f.owners[0]!.position = 99;
      f.owners[0]!.emit({ type: 'ended' });
      expect(observations).toHaveLength(2);
      await f.controller.stop();
      expect(observations[2]).toMatchObject({
        selectionId: 'b',
        positionSeconds: 12.345,
        reason: 'stopped',
      });
    } finally {
      await f.controller.dispose();
    }
    expect(Object.values(f.resources.snapshot().counts).every((count) => count === 0)).toBe(true);
  });

  it('reports completed once, isolates observer failure, and releases subscription ownership idempotently', async () => {
    const f = fixture(),
      observed = vi.fn();
    const unsubscribe = f.controller.subscribeVODRelease(observed);
    f.controller.subscribeVODRelease(observed);
    f.controller.subscribeVODRelease(() => {
      throw new Error('fixture observer');
    });
    expect(f.resources.snapshot().counts.controllerListeners).toBe(2);
    await f.controller.select(selection('a'));
    f.owners[0]!.position = 120.5;
    f.owners[0]!.emit({ type: 'ended' });
    f.owners[0]!.emit({ type: 'ended' });
    await flush();
    await f.controller.stop();
    await f.controller.dispose();
    expect(observed).toHaveBeenCalledOnce();
    expect(observed.mock.calls[0]![0]).toMatchObject({
      reason: 'completed',
      positionSeconds: 120.5,
    });
    unsubscribe();
    unsubscribe();
    f.controller.subscribeVODRelease(observed)();
    expect(Object.values(f.resources.snapshot().counts).every((count) => count === 0)).toBe(true);
  });

  it('rejects nonfinite/oversized duration and never exposes retiring A as selected B', async () => {
    const f = fixture();
    let finishDispose!: () => void;
    const dispose = new Promise<void>((resolve) => {
      finishDispose = resolve;
    });
    try {
      await f.controller.select(selection('a'));
      for (const duration of [NaN, Infinity, 0, -1, 604801, null]) {
        f.owners[0]!.duration = duration;
        expect(f.controller.currentVODduration()).toBeNull();
      }
      f.owners[0]!.duration = 120;
      vi.mocked(f.owners[0]!.engine.dispose).mockReturnValueOnce(dispose);
      const switching = f.controller.select(selection('b'));
      expect(f.controller.currentVODduration()).toBeNull();
      expect(f.controller.currentVODposition()).toBeNull();
      finishDispose();
      await switching;
      expect(f.controller.currentVODduration()).toBe(120.5);
    } finally {
      finishDispose();
      await f.controller.dispose();
    }
  });

  it('waits for current finite readiness, seeks once, and releases temporary wait handles', async () => {
    const f = fixture();
    try {
      await f.controller.select(selection('a'));
      const pending = f.controller.seekWhenReady(40);
      await flush();
      expect(f.owners[0]!.engine.seekVOD).not.toHaveBeenCalled();
      f.owners[0]!.position = null;
      f.owners[0]!.emit({ type: 'progress' });
      expect(f.owners[0]!.engine.seekVOD).not.toHaveBeenCalled();
      f.owners[0]!.position = 0;
      f.owners[0]!.emit({ type: 'buffering' });
      expect(await pending).toEqual({ ok: true });
      expect(f.owners[0]!.engine.seekVOD).toHaveBeenCalledOnce();
      expect(f.owners[0]!.position).toBe(40);
      expect(f.resources.snapshot().counts.controllerListeners).toBe(0);
      f.owners[0]!.emit({ type: 'progress' });
    } finally {
      await f.controller.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
    expect(Object.values(f.resources.snapshot().counts).every((count) => count === 0)).toBe(true);
  });

  it('cancels an unready resume on selection replacement without applying A offset to B', async () => {
    const f = fixture();
    try {
      await f.controller.select(selection('a'));
      const pending = f.controller.seekWhenReady(80);
      await f.controller.select(selection('b'));
      expect(await pending).toEqual({ ok: false, reason: 'superseded' });
      f.owners[1]!.emit({ type: 'progress' });
      expect(
        f.owners.every((owner) => vi.mocked(owner.engine.seekVOD!).mock.calls.length === 0),
      ).toBe(true);
      expect(f.owners[1]!.position).toBe(12.345);
    } finally {
      await f.controller.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('joins an already started seek after abort instead of acknowledging detached work', async () => {
    const f = fixture(),
      cancel = new AbortController();
    let complete!: (value: 'unavailable') => void, signal: AbortSignal | undefined;
    try {
      await f.controller.select(selection('a'));
      f.owners[0]!.emit({ type: 'progress' });
      vi.mocked(f.owners[0]!.engine.seekVOD!).mockImplementationOnce((_seconds, abort) => {
        signal = abort;
        return new Promise((resolve) => {
          complete = resolve;
        });
      });
      const pending = f.controller.seekWhenReady(50, cancel.signal);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await flush();
      cancel.abort();
      await flush();
      expect(signal?.aborted).toBe(true);
      expect(settled).toBe(false);
      expect(f.resources.snapshot().counts.controllerListeners).toBe(1);
      complete('unavailable');
      expect(await pending).toEqual({ ok: false, reason: 'superseded' });
      expect(f.resources.snapshot().counts.controllerListeners).toBe(0);
      expect(f.owners[0]!.position).toBe(12.345);
    } finally {
      complete?.('unavailable');
      await f.controller.dispose();
    }
    expect(Object.values(f.resources.snapshot().counts).every((count) => count === 0)).toBe(true);
  });

  it('bounds unready waits and removes external abort/timer/listener resources', async () => {
    const f = fixture(),
      abort = new AbortController();
    try {
      await f.controller.select(selection('a'));
      const pending = f.controller.seekWhenReady(50, abort.signal);
      await vi.advanceTimersByTimeAsync(20_000);
      // The existing startup deadline was installed first and truthfully fails playback.
      expect(await pending).toEqual({ ok: false, reason: 'failed' });
      expect(f.owners[0]!.engine.seekVOD).not.toHaveBeenCalled();
      expect(f.resources.snapshot().counts.abortListeners).toBe(0);
      expect(f.resources.snapshot().counts.controllerListeners).toBe(0);
    } finally {
      await f.controller.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });

  it('aborts deadline-expired seek but joins the original worker before settling', async () => {
    const f = fixture();
    let complete!: (value: 'unavailable') => void, signal: AbortSignal | undefined;
    try {
      await f.controller.select(selection('a'));
      f.owners[0]!.emit({ type: 'progress' });
      vi.mocked(f.owners[0]!.engine.seekVOD!).mockImplementationOnce((_seconds, abort) => {
        signal = abort;
        return new Promise((resolve) => {
          complete = resolve;
        });
      });
      const pending = f.controller.seekWhenReady(50);
      let settled = false;
      void pending.then(() => {
        settled = true;
      });
      await flush();
      // The readiness bound no longer cancels a started seek; its own window does.
      await vi.advanceTimersByTimeAsync(20_000);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(VOD_SEEK_MS - 20_000);
      expect(signal?.aborted).toBe(true);
      expect(settled).toBe(false);
      complete('unavailable');
      expect(await pending).toEqual({ ok: false, reason: 'failed' });
    } finally {
      complete?.('unavailable');
      await f.controller.dispose();
    }
    expect(Object.values(f.resources.snapshot().counts).every((count) => count === 0)).toBe(true);
  });

  it('cancels an unready wait immediately without allocating a seek or retaining observers', async () => {
    const f = fixture(),
      abort = new AbortController();
    try {
      await f.controller.select(selection('a'));
      const pending = f.controller.seekWhenReady(50, abort.signal);
      abort.abort();
      expect(await pending).toEqual({ ok: false, reason: 'superseded' });
      expect(f.owners[0]!.engine.seekVOD).not.toHaveBeenCalled();
      expect(f.resources.snapshot().counts.abortListeners).toBe(0);
      expect(f.resources.snapshot().counts.controllerListeners).toBe(0);
      expect(await f.controller.seekWhenReady(50, abort.signal)).toEqual({
        ok: false,
        reason: 'superseded',
      });
    } finally {
      await f.controller.dispose();
    }
    expect(Object.values(f.resources.snapshot().counts).every((count) => count === 0)).toBe(true);
  });

  it('captures background and failure before teardown and emits no duplicate terminal observation', async () => {
    for (const reason of ['background', 'failed'] as const) {
      const f = fixture(),
        observed = vi.fn();
      f.controller.subscribeVODRelease(observed);
      await f.controller.select(selection(reason));
      f.owners[0]!.emit({ type: 'progress' });
      if (reason === 'background') await f.controller.suspend();
      else {
        f.owners[0]!.emit({
          type: 'error',
          failure: { code: 'decode', retryable: false, message: 'Fixture decoder failure.' },
        });
        await flush();
      }
      await f.controller.stop();
      await f.controller.dispose();
      expect(observed).toHaveBeenCalledOnce();
      expect(observed.mock.calls[0]![0]).toEqual({
        selectionId: reason,
        positionSeconds: 12.345,
        durationSeconds: 120.5,
        reason,
      });
      expect(Object.values(f.resources.snapshot().counts).every((count) => count === 0)).toBe(true);
    }
  });
});
