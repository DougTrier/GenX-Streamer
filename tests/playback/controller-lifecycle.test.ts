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

/**
 * Playback controller: lifecycle reentry and background pause ownership.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { classifyHttpFailure } from '../../src/playback/failure';
import { harness, channel, flush, temporary } from './controller.fixture';

describe('synchronous lifecycle reentry ownership', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());
  it.each([429, 503])(
    'malformed HTTP%s hints retain250ms fallback, two retries and original20s deadline',
    async (status) => {
      const { controller, owners } = harness();
      await controller.select(channel('a'));
      owners[0]!.emit({ type: 'error', failure: classifyHttpFailure(status, '-1') });
      await vi.advanceTimersByTimeAsync(249);
      expect(owners).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(owners).toHaveLength(2);
      owners[1]!.emit({ type: 'error', failure: classifyHttpFailure(status, ' ') });
      await vi.advanceTimersByTimeAsync(249);
      expect(owners).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(owners).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(19499);
      expect(controller.snapshot.state).toBe('reconnecting');
      await vi.advanceTimersByTimeAsync(1);
      expect(controller.snapshot).toMatchObject({
        state: 'failed',
        failure: { code: 'timeout', phase: 'startup-progress' },
      });
      await controller.dispose();
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it.each(['select', 'pause', 'suspend', 'dispose'] as const)(
    'does not dispatch stale decoded evidence after an observer reenters %s',
    async (action) => {
      const { controller, owners, resources } = harness();
      const first = vi.fn();
      const following = vi.fn();
      let transition: Promise<void> | undefined;
      controller.subscribeDecoded((observation) => {
        first(observation);
        if (first.mock.calls.length !== 1) return;
        if (action === 'select') transition = controller.select(channel('b'));
        else if (action === 'pause') controller.pause();
        else if (action === 'suspend') transition = controller.suspend();
        else transition = controller.dispose();
      });
      controller.subscribeDecoded(following);
      await controller.select(channel('a'));
      owners[0]!.emit({ type: 'progress' });
      const evidence = {
        kind: 'decoded' as const,
        before: { mediaTime: 1, decodedFrames: 1, width: 320, height: 180 },
        after: { mediaTime: 2, decodedFrames: 2, width: 320, height: 180 },
        elapsedMilliseconds: 100,
      };
      owners[0]!.emit({ type: 'decoded-progress', evidence });
      expect(first).toHaveBeenCalledOnce();
      expect(first.mock.calls[0]![0].selection.id).toBe('a');
      expect(controller.isDecodedCurrent(first.mock.calls[0]![0])).toBe(false);
      expect(following).not.toHaveBeenCalled();
      await transition;
      if (action === 'select') {
        owners[1]!.emit({ type: 'progress' });
        owners[1]!.emit({ type: 'decoded-progress', evidence });
        expect(following).toHaveBeenCalledOnce();
        expect(following.mock.calls[0]![0].selection.id).toBe('b');
        expect(controller.isDecodedCurrent(following.mock.calls[0]![0])).toBe(true);
      }
      await controller.dispose();
      expect(resources.snapshot().counts.controllerEngines).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it('retains the latest startup deadline when connecting observer selects another channel', async () => {
    const { controller, owners, resources } = harness();
    let replacement: Promise<void> | undefined;
    controller.subscribe((snapshot) => {
      if (snapshot.state === 'connecting' && snapshot.selection?.id === 'a')
        replacement = controller.select(channel('b'));
    });
    await controller.select(channel('a'));
    await replacement;
    expect(controller.snapshot.selection?.id).toBe('b');
    expect(owners).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(19999);
    expect(controller.snapshot.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.snapshot.state).toBe('failed');
    expect(controller.snapshot.failure?.phase).toBe('startup-progress');
    await controller.dispose();
    expect(resources.snapshot().counts.controllerTimers).toBe(0);
  });
  it.each(['failed', 'idle', 'paused'] as const)(
    'queues old cleanup before a %s observer starts a replacement',
    async (state) => {
      const { controller, owners, resources } = harness();
      await controller.select(channel('a'));
      let replacement: Promise<void> | undefined;
      controller.subscribe((snapshot) => {
        if (snapshot.state === state && snapshot.selection?.id !== 'b')
          replacement = controller.select(channel('b'));
      });
      if (state === 'failed')
        owners[0]!.emit({
          type: 'error',
          failure: { code: 'policy', message: 'Source policy refused.', retryable: false },
        });
      else if (state === 'idle') await controller.stop();
      else await controller.suspend();
      await replacement;
      await flush();
      expect(controller.snapshot.selection?.id).toBe('b');
      expect(owners).toHaveLength(2);
      expect(owners[0]!.engine.dispose).toHaveBeenCalledOnce();
      expect(owners[1]!.engine.dispose).not.toHaveBeenCalled();
      owners[1]!.emit({ type: 'progress' });
      expect(controller.snapshot.state).toBe('playing');
      expect(resources.snapshot().highWater.controllerEngines).toBe(1);
      await controller.dispose();
      expect(resources.snapshot().counts.controllerEngines).toBe(0);
    },
  );
  it('does not publish or schedule obsolete recovery after an abort listener selects another channel', async () => {
    const { controller, owners, resources } = harness();
    await controller.select(channel('a'));
    let replacement: Promise<void> | undefined;
    owners[0]!.signal!.addEventListener('abort', () => {
      replacement = controller.select(channel('b'));
    });
    owners[0]!.emit(temporary);
    await replacement;
    expect(controller.snapshot).toMatchObject({ state: 'connecting', selection: { id: 'b' } });
    expect(resources.snapshot().counts.controllerTimers).toBe(1);
    await vi.advanceTimersByTimeAsync(250);
    expect(owners).toHaveLength(2);
    expect(owners[1]!.engine.dispose).not.toHaveBeenCalled();
    await controller.dispose();
  });
  it('never resumes an old engine after a connecting observer switches during resume', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    controller.pause();
    let replacement: Promise<void> | undefined;
    controller.subscribe((snapshot) => {
      if (snapshot.state === 'connecting' && snapshot.selection?.id === 'a')
        replacement = controller.select(channel('b'));
    });
    await controller.resume();
    await replacement;
    expect(owners[0]!.engine.resume).not.toHaveBeenCalled();
    expect(controller.snapshot.selection?.id).toBe('b');
    await controller.dispose();
  });
  it('joining close from a connecting observer prevents any late engine or timer allocation', async () => {
    const { controller, owners, resources } = harness();
    let closing: Promise<void> | undefined;
    controller.subscribe((snapshot) => {
      if (snapshot.state === 'connecting') closing = controller.dispose();
    });
    await controller.select(channel('a'));
    await closing;
    await vi.advanceTimersByTimeAsync(20000);
    expect(controller.snapshot.state).toBe('disposed');
    expect(owners).toHaveLength(0);
    expect(resources.snapshot().counts.controllerTimers).toBe(0);
    expect(resources.snapshot().counts.controllerListeners).toBe(0);
  });
  it('a reconnecting observer replacement does not inherit an obsolete retry timer', async () => {
    const { controller, owners, resources } = harness();
    await controller.select(channel('a'));
    let replacement: Promise<void> | undefined;
    controller.subscribe((snapshot) => {
      if (snapshot.state === 'reconnecting') replacement = controller.select(channel('b'));
    });
    owners[0]!.emit(temporary);
    await replacement;
    expect(resources.snapshot().counts.controllerTimers).toBe(1);
    await vi.advanceTimersByTimeAsync(20000);
    expect(owners).toHaveLength(2);
    expect(controller.snapshot.failure?.phase).toBe('startup-progress');
    await controller.dispose();
  });
  it('the latest deadline expires while old real cleanup is held without releasing ownership early', async () => {
    const { controller, owners, resources } = harness();
    await controller.select(channel('a'));
    let finish!: () => void;
    vi.mocked(owners[0]!.engine.dispose).mockImplementationOnce(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    const replacement = controller.select(channel('b'));
    await flush();
    await vi.advanceTimersByTimeAsync(20000);
    expect(controller.snapshot).toMatchObject({ state: 'failed', selection: { id: 'b' } });
    expect(resources.snapshot().counts.controllerEngines).toBe(1);
    let closed = false;
    const closing = controller.dispose().then(() => (closed = true));
    await flush();
    expect(closed).toBe(false);
    expect(owners).toHaveLength(1);
    finish();
    await replacement;
    await closing;
    expect(resources.snapshot().counts.controllerEngines).toBe(0);
    expect(resources.snapshot().counts.controllerTimers).toBe(0);
  });
});
describe('background pause explanation ownership', () => {
  afterEach(() => vi.useRealTimers());
  it('refuses failed background cleanup instead of acknowledging a retained owner', async () => {
    const { controller, owners, resources } = harness();
    await controller.select(channel('a'));
    vi.mocked(owners[0]!.engine.dispose).mockRejectedValue(
      new Error('private https://secret.invalid/token'),
    );
    await expect(controller.suspend()).rejects.toThrow(
      'Background playback cleanup could not be confirmed.',
    );
    await flush();
    expect(controller.snapshot.state).toBe('failed');
    expect(resources.snapshot().counts.controllerEngines).toBe(1);
    expect(controller.snapshot.error).not.toContain('secret');
    vi.mocked(owners[0]!.engine.dispose).mockResolvedValue(undefined);
    await controller.suspend();
    expect(resources.snapshot().counts.controllerEngines).toBe(0);
    await controller.dispose();
  });
  it('coalesces repeated background cleanup until its actual release settles', async () => {
    const { controller, owners, resources } = harness();
    await controller.select(channel('a'));
    let finish!: () => void;
    vi.mocked(owners[0]!.engine.dispose).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const reentered: Promise<void>[] = [];
    owners[0]!.signal!.addEventListener('abort', () => reentered.push(controller.suspend()));
    controller.subscribe((snapshot) => {
      if (snapshot.state === 'paused') reentered.push(controller.suspend());
    });
    const first = controller.suspend();
    expect(controller.suspend()).toBe(first);
    expect(reentered).toHaveLength(2);
    expect(reentered.every((work) => work === first)).toBe(true);
    let settled = false;
    void first.then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    expect(resources.snapshot().counts.controllerEngines).toBe(1);
    expect(owners[0]!.engine.dispose).toHaveBeenCalledTimes(1);
    finish();
    await first;
    expect(resources.snapshot().counts.controllerEngines).toBe(0);
    await controller.dispose();
  });
  it('a new background request still cancels a newer selection while previous cleanup is held', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    let finish!: () => void;
    vi.mocked(owners[0]!.engine.dispose).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const first = controller.suspend();
    await flush();
    const selecting = controller.select(channel('b'));
    const second = controller.suspend();
    expect(second).not.toBe(first);
    finish();
    await Promise.all([first, selecting, second]);
    expect(owners).toHaveLength(1);
    expect(controller.snapshot).toMatchObject({ state: 'paused', selection: { id: 'b' } });
    await controller.resume();
    expect(owners).toHaveLength(2);
    expect(owners[1]!.engine.start).toHaveBeenCalledWith(channel('b'), expect.any(AbortSignal));
    await controller.dispose();
  });
  it('counts held cleanup until settlement and never allocates an overlapping owner', async () => {
    const { controller, owners, resources } = harness();
    await controller.select(channel('a'));
    let finish!: () => void;
    vi.mocked(owners[0]!.engine.dispose).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const suspension = controller.suspend();
    await flush();
    expect(resources.snapshot().counts.controllerEngines).toBe(1);
    expect(resources.snapshot().counts.controllerTimers).toBe(0);
    const resume = controller.resume();
    await flush();
    expect(owners).toHaveLength(1);
    finish();
    await suspension;
    await resume;
    expect(resources.snapshot().counts.controllerEngines).toBe(1);
    expect(resources.snapshot().highWater.controllerEngines).toBe(1);
    await controller.dispose();
    expect(resources.snapshot().counts.controllerEngines).toBe(0);
    expect(resources.snapshot().counts.controllerTimers).toBe(0);
  });
  it('counts real subscriptions and repeated lifecycle ownership without cumulative handles', async () => {
    const { controller, resources } = harness();
    const observer = vi.fn();
    const first = controller.subscribe(observer);
    const duplicate = controller.subscribe(observer);
    const decoded = controller.subscribeDecoded(vi.fn());
    expect(resources.snapshot().counts.controllerListeners).toBe(1);
    expect(resources.snapshot().counts.decodedObservers).toBe(1);
    for (let cycle = 0; cycle < 50; cycle++) {
      await controller.select(channel('a'));
      expect(resources.snapshot().counts.controllerEngines).toBe(1);
      expect(resources.snapshot().counts.controllerTimers).toBe(1);
      await controller.suspend();
      expect(resources.snapshot().counts.controllerEngines).toBe(0);
      expect(resources.snapshot().counts.controllerTimers).toBe(0);
    }
    first();
    duplicate();
    decoded();
    expect(resources.snapshot().counts.controllerListeners).toBe(0);
    expect(resources.snapshot().counts.decodedObservers).toBe(0);
    await controller.dispose();
    controller.subscribe(observer);
    controller.subscribeDecoded(vi.fn());
    expect(resources.snapshot().counts.controllerListeners).toBe(0);
    expect(resources.snapshot().counts.decodedObservers).toBe(0);
    expect(resources.snapshot().highWater.controllerEngines).toBe(1);
    expect(resources.snapshot().acquired.controllerEngines).toBe(50);
    expect(resources.snapshot().released.controllerEngines).toBe(50);
  });
  it('retains engine counts after failed cleanup and releases fired timer ownership', async () => {
    vi.useFakeTimers();
    const { controller, owners, resources } = harness();
    await controller.select(channel('a'));
    vi.mocked(owners[0]!.engine.dispose).mockRejectedValueOnce(new Error('cleanup failed'));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(resources.snapshot().counts.controllerTimers).toBe(0);
    expect(resources.snapshot().counts.controllerEngines).toBe(1);
    await controller.dispose();
    expect(resources.snapshot().counts.controllerEngines).toBe(0);
  });
  it('does not leak failed registrations or let an observer interrupt disposal', async () => {
    const { controller, owners, resources } = harness();
    expect(() =>
      controller.subscribe(() => {
        throw new Error('registration failed');
      }),
    ).toThrow('registration failed');
    expect(resources.snapshot().counts.controllerListeners).toBe(0);
    const observed = vi.fn();
    controller.subscribe((snapshot) => {
      if (snapshot.state === 'disposed') throw new Error('observer failed');
    });
    controller.subscribe(observed);
    await controller.select(channel('a'));
    await controller.dispose();
    expect(observed.mock.calls.at(-1)![0].state).toBe('disposed');
    expect(owners[0]!.engine.dispose).toHaveBeenCalledOnce();
    expect(resources.snapshot().counts.controllerListeners).toBe(0);
    expect(resources.snapshot().counts.controllerEngines).toBe(0);
  });
  it('retains the reason without foreground autoplay and clears it on explicit same-channel resume', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    owners[0]!.emit({ type: 'progress' });
    await controller.suspend();
    expect(controller.snapshot).toMatchObject({ state: 'paused', pauseReason: 'background' });
    owners[0]!.emit({ type: 'progress' });
    expect(controller.snapshot.state).toBe('paused');
    await controller.resume();
    expect(controller.snapshot.pauseReason).toBeNull();
    expect(controller.snapshot.selection?.id).toBe('a');
    expect(controller.snapshot.state).toBe('connecting');
    await controller.dispose();
  });
  it('does not relabel an ordinary manual pause when background cleanup releases it', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    owners[0]!.emit({ type: 'progress' });
    controller.pause();
    await controller.suspend();
    expect(controller.snapshot).toMatchObject({ state: 'paused', pauseReason: null });
    await controller.dispose();
  });
  it('clears background reason on manual pause, same or different selection, stop and disposal', async () => {
    const { controller } = harness();
    await controller.select(channel('a'));
    await controller.suspend();
    controller.pause();
    expect(controller.snapshot.pauseReason).toBeNull();
    await controller.select(channel('a'));
    await controller.suspend();
    await controller.select(channel('a'));
    expect(controller.snapshot.pauseReason).toBeNull();
    await controller.suspend();
    await controller.select(channel('b'));
    expect(controller.snapshot.pauseReason).toBeNull();
    await controller.suspend();
    await controller.stop();
    expect(controller.snapshot.pauseReason).toBeNull();
    expect(controller.snapshot.selection).toBeNull();
    await controller.dispose();
    expect(controller.snapshot.pauseReason).toBeNull();
  });
  it('late suspension failure cannot restore a reason onto a newer selection', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    let rejectCleanup!: (error: Error) => void;
    vi.mocked(owners[0]!.engine.dispose).mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          rejectCleanup = reject;
        }),
    );
    const suspension = controller.suspend();
    await flush();
    const selecting = controller.select(channel('b'));
    rejectCleanup(new Error('late cleanup'));
    await expect(suspension).rejects.toThrow('Background playback cleanup could not be confirmed.');
    await selecting;
    expect(controller.snapshot).toMatchObject({
      state: 'connecting',
      selection: { id: 'b' },
      pauseReason: null,
    });
    await controller.dispose();
  });
  it('current cleanup failure clears reason and gives the actionable failure', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    vi.mocked(owners[0]!.engine.dispose).mockRejectedValueOnce(new Error('owned cleanup failed'));
    await expect(controller.suspend()).rejects.toThrow(
      'Background playback cleanup could not be confirmed.',
    );
    expect(controller.snapshot).toMatchObject({ state: 'failed', pauseReason: null });
    await controller.dispose();
  });
});
