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
 * Playback controller: playback session ownership.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type DecodedPlaybackObservation } from '../../src/playback/controller';
import { harness, channel, temporary, flush } from './controller.fixture';

describe('playback session ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });
  it('fences cloned decoder observations by attempt across pause/resume/retry/selection/disposal', async () => {
    const { controller, owners } = harness();
    const observed: DecodedPlaybackObservation[] = [];
    controller.subscribeDecoded((value) => observed.push(value));
    const evidence = {
      kind: 'decoded' as const,
      before: { mediaTime: 1, decodedFrames: 1, width: 320, height: 180 },
      after: { mediaTime: 2, decodedFrames: 2, width: 320, height: 180 },
      elapsedMilliseconds: 100,
    };
    await controller.select(channel('a'));
    owners[0].emit({ type: 'decoded-progress', evidence });
    expect(observed).toHaveLength(0);
    owners[0].emit({ type: 'progress' });
    owners[0].emit({ type: 'decoded-progress', evidence });
    const first = observed[0];
    expect(controller.isDecodedCurrent(first)).toBe(true);
    first.evidence.after.width = 999;
    expect(evidence.after.width).toBe(320);
    controller.pause();
    expect(controller.isDecodedCurrent(first)).toBe(false);
    owners[0].emit({ type: 'decoded-progress', evidence });
    expect(observed).toHaveLength(1);
    await controller.resume();
    owners[0].emit({ type: 'progress' });
    owners[0].emit({ type: 'decoded-progress', evidence });
    expect(observed[1].attempt).not.toBe(first.attempt);
    owners[0].emit(temporary);
    expect(controller.isDecodedCurrent(observed[1])).toBe(false);
    await vi.advanceTimersByTimeAsync(250);
    owners.at(-1)!.emit({ type: 'progress' });
    owners.at(-1)!.emit({ type: 'decoded-progress', evidence });
    const retry = observed.at(-1)!;
    expect(retry.attempt).not.toBe(observed[1].attempt);
    await controller.select(channel('b'));
    expect(controller.isDecodedCurrent(retry)).toBe(false);
    owners[0].emit({ type: 'decoded-progress', evidence });
    expect(observed).toHaveLength(3);
    await controller.dispose();
    expect(controller.isDecodedCurrent(retry)).toBe(false);
  });
  it('retains distinct observed startup and buffering deadlines in a copied failure snapshot', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    await vi.advanceTimersByTimeAsync(20000);
    expect(controller.snapshot.failure).toMatchObject({
      code: 'timeout',
      phase: 'startup-progress',
      evidence: 'observed-progress',
    });
    await controller.select(channel('b'));
    owners.at(-1)!.emit({ type: 'progress' });
    owners.at(-1)!.emit({ type: 'buffering' });
    await vi.advanceTimersByTimeAsync(20000);
    expect(controller.snapshot.failure).toMatchObject({ phase: 'buffering-progress' });
    const copy = controller.snapshot;
    copy.failure!.code = 'unknown';
    expect(controller.snapshot.failure?.code).toBe('timeout');
    await controller.dispose();
  });
  it('does not confuse initialization with observed media progress', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    expect(controller.snapshot.state).toBe('connecting');
    owners[0]!.emit({ type: 'progress' });
    expect(controller.snapshot.state).toBe('playing');
    await controller.dispose();
  });
  it('coalesces queued A B C selection and rejects obsolete callbacks', async () => {
    const { controller, owners } = harness({ holdInitialCancellation: true });
    await controller.select(channel('a'));
    const a = owners[0]!;
    const b = controller.select(channel('b'));
    const c = controller.select(channel('c'));
    await flush();
    expect(owners).toHaveLength(1);
    expect(a.signal?.aborted).toBe(true);
    expect(a.engine.dispose).toHaveBeenCalledOnce();
    a.emit({ type: 'progress' });
    a.reject?.(new Error('old'));
    await Promise.all([b, c]);
    expect(owners).toHaveLength(2);
    await flush();
    expect(controller.snapshot.selection?.id).toBe('c');
    expect(controller.snapshot.state).toBe('connecting');
    owners[1]!.emit({ type: 'progress' });
    expect(controller.snapshot.state).toBe('playing');
    await controller.dispose();
  });
  it('waits for old asynchronous disposal before allocating another engine', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    let release!: () => void;
    owners[0]!.engine.dispose = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const next = controller.select(channel('b'));
    await flush();
    expect(owners).toHaveLength(1);
    release();
    await next;
    expect(owners).toHaveLength(2);
    await controller.dispose();
  });
  it('stops during initialization and disposal is idempotent', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    await controller.stop();
    await controller.stop();
    owners[0]!.emit(temporary);
    expect(controller.snapshot.state).toBe('idle');
    expect(owners[0]!.engine.dispose).toHaveBeenCalledOnce();
    const first = controller.dispose();
    expect(controller.dispose()).toBe(first);
    await first;
    await controller.select(channel('b'));
    expect(owners).toHaveLength(1);
  });
  it('retains failed terminal cleanup and retries it without allocating another engine', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    const cleanup = vi.mocked(owners[0]!.engine.dispose);
    cleanup.mockRejectedValueOnce(new Error('owned cleanup failed'));
    const first = controller.dispose();
    expect(controller.dispose()).toBe(first);
    await expect(first).rejects.toThrow('owned cleanup failed');
    expect(controller.snapshot.state).toBe('disposed');
    await controller.select(channel('b'));
    expect(owners).toHaveLength(1);
    const retry = controller.dispose();
    expect(retry).not.toBe(first);
    expect(controller.dispose()).toBe(retry);
    await retry;
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(controller.dispose()).toBe(retry);
  });
  it('coalesces disposal reentered by abort listeners and disposed subscribers', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    const reentered: Array<Promise<void>> = [];
    owners[0]!.signal!.addEventListener('abort', () => reentered.push(controller.dispose()));
    controller.subscribe((snapshot) => {
      if (snapshot.state === 'disposed') reentered.push(controller.dispose());
    });
    const disposal = controller.dispose();
    expect(reentered).toHaveLength(2);
    expect(reentered.every((attempt) => attempt === disposal)).toBe(true);
    await disposal;
    expect(owners[0]!.engine.dispose).toHaveBeenCalledOnce();
  });
  it('stop retries rejected terminal cleanup instead of falsely acknowledging release', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    const cleanup = vi.mocked(owners[0]!.engine.dispose);
    cleanup.mockRejectedValueOnce(new Error('owned cleanup failed'));
    await expect(controller.dispose()).rejects.toThrow('owned cleanup failed');
    await controller.stop();
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(controller.snapshot.state).toBe('disposed');
  });
  it.each([
    [undefined, 'channel'],
    ['on-demand', 'video'],
  ] as const)(
    'keeps %s startup and buffering timeout guidance scoped to its media mode',
    async (playMode, target) => {
      const { controller, owners } = harness();
      await controller.select({ ...channel('startup'), ...(playMode ? { playMode } : {}) });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(controller.snapshot.failure?.message).toBe(
        `Playback did not start in time. Retry or choose another ${target}.`,
      );
      await controller.select({ ...channel('buffering'), ...(playMode ? { playMode } : {}) });
      owners[1]!.emit({ type: 'progress' });
      owners[1]!.emit({ type: 'buffering' });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(controller.snapshot.failure?.message).toBe(
        `Playback stopped making progress. Retry or choose another ${target}.`,
      );
      expect(controller.snapshot).toMatchObject({
        state: 'failed',
        selection: { id: 'buffering' },
      });
      await controller.dispose();
    },
  );
  it('a selection may ask for a longer first-start window, bounded to 20–45 s', async () => {
    const { controller } = harness();
    await controller.select({ ...channel('paid'), startupMs: 35_000 });
    await vi.advanceTimersByTimeAsync(34_999);
    expect(controller.snapshot.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.snapshot.state).toBe('failed');
    await controller.select({ ...channel('huge'), startupMs: 10 * 60_000 });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(controller.snapshot.state).toBe('failed');
    await controller.select({ ...channel('tiny'), startupMs: 1 });
    await vi.advanceTimersByTimeAsync(19_999);
    expect(controller.snapshot.state).toBe('connecting');
    await controller.dispose();
  });
  it('a waiting note reaches only the selection that is still connecting', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('first'));
    controller.note('other', 'not for this start');
    expect(controller.snapshot.error).toBeNull();
    controller.note('first', 'The provider is busy.');
    expect(controller.snapshot).toMatchObject({
      state: 'connecting',
      error: 'The provider is busy.',
    });
    owners[0]!.emit({ type: 'progress' });
    controller.note('first', 'late');
    expect(controller.snapshot.error).not.toBe('late');
    await controller.dispose();
  });
  it('fails stalled manifests at the single 20 second episode deadline', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    await vi.advanceTimersByTimeAsync(19_999);
    expect(controller.snapshot.state).toBe('connecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.snapshot.state).toBe('failed');
    expect(owners[0]!.signal?.aborted).toBe(true);
    expect(owners[0]!.engine.dispose).toHaveBeenCalledOnce();
    await controller.dispose();
  });
  it('caps automatic retries at two and retains original deadline', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    owners[0]!.emit(temporary);
    await vi.advanceTimersByTimeAsync(250);
    owners[1]!.emit(temporary);
    await vi.advanceTimersByTimeAsync(250);
    owners[2]!.emit(temporary);
    await flush();
    expect(controller.snapshot.state).toBe('failed');
    expect(owners).toHaveLength(3);
    await controller.dispose();
  });
  it('rejects Retry-After beyond the remaining episode', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    owners[0]!.emit({
      type: 'error',
      failure: { code: 'network', message: 'Retry later', retryable: true, retryAfterMs: 30_000 },
    });
    await flush();
    expect(controller.snapshot.state).toBe('failed');
    expect(vi.getTimerCount()).toBe(0);
    await controller.dispose();
  });
  it('never retries an access refusal', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    owners[0]!.emit({
      type: 'error',
      failure: { code: 'access', message: 'Access refused', retryable: false },
    });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(owners).toHaveLength(1);
    expect(controller.snapshot.error).toBe('Access refused');
    await controller.dispose();
  });
  it('ignores late progress from an engine aborted for recovery', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    owners[0]!.emit(temporary);
    owners[0]!.emit({ type: 'progress' });
    expect(controller.snapshot.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(250);
    expect(owners).toHaveLength(2);
    await controller.dispose();
  });
  it('resumes with fresh ownership when paused during recovery', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    owners[0]!.emit(temporary);
    controller.pause();
    await controller.resume();
    expect(owners).toHaveLength(2);
    expect(owners[0]!.engine.dispose).toHaveBeenCalledOnce();
    expect(controller.snapshot.state).toBe('connecting');
    await controller.dispose();
  });
  it('does not allocate new ownership when disposal fails', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    owners[0]!.engine.dispose = vi.fn(async () => {
      throw new Error('cleanup failed');
    });
    await controller.select(channel('b'));
    await flush();
    expect(owners).toHaveLength(1);
    expect(controller.snapshot.state).toBe('failed');
    owners[0]!.engine.dispose = vi.fn();
    await controller.dispose();
  });
  it('does not publish a stale retry cleanup rejection over a newer selection', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    let reject!: (error: Error) => void;
    owners[0]!.engine.dispose = vi.fn().mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    owners[0]!.emit(temporary);
    await vi.advanceTimersByTimeAsync(250);
    const selection = controller.select(channel('b'));
    reject(new Error('old disposal'));
    await selection;
    await flush();
    expect(controller.snapshot.selection?.id).toBe('b');
    expect(controller.snapshot.state).toBe('connecting');
    expect(owners).toHaveLength(2);
    await controller.dispose();
  });
  it('bounds buffering after successful progress and ignores progress while paused', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    owners[0]!.emit({ type: 'progress' });
    controller.pause();
    owners[0]!.emit({ type: 'progress' });
    await vi.advanceTimersByTimeAsync(25_000);
    expect(controller.snapshot.state).toBe('paused');
    await controller.resume();
    expect(owners).toHaveLength(1);
    expect(controller.snapshot.state).toBe('connecting');
    owners[0]!.emit({ type: 'progress' });
    owners[0]!.emit({ type: 'buffering' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(controller.snapshot.state).toBe('failed');
    await controller.dispose();
  });
  it('survives 500 deterministic switches with no obsolete effects or live timers', async () => {
    const { controller, owners } = harness();
    for (let i = 0; i < 500; i++) {
      await controller.select(channel(String(i)));
      owners[i]!.emit({ type: 'progress' });
      if (i) owners[i - 1]!.emit(temporary);
    }
    expect(controller.snapshot.selection?.id).toBe('499');
    expect(controller.snapshot.state).toBe('playing');
    await controller.dispose();
    expect(owners.every((owner) => vi.mocked(owner.engine.dispose).mock.calls.length === 1)).toBe(
      true,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
  it('releases background ownership and explicitly resumes with a fresh decoder', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    owners[0]!.emit({ type: 'progress' });
    await controller.suspend();
    expect(controller.snapshot).toMatchObject({ state: 'paused', selection: { id: 'a' } });
    expect(owners[0]!.signal?.aborted).toBe(true);
    expect(owners[0]!.engine.dispose).toHaveBeenCalledTimes(1);
    owners[0]!.emit({ type: 'progress' });
    await vi.advanceTimersByTimeAsync(25000);
    expect(controller.snapshot.state).toBe('paused');
    await controller.resume();
    expect(owners).toHaveLength(2);
    expect(owners[0]!.engine.resume).not.toHaveBeenCalled();
    owners[1]!.emit({ type: 'progress' });
    expect(controller.snapshot.state).toBe('playing');
    await controller.dispose();
  });
  it('keeps a newer channel selected if background cleanup rejects late', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    let reject!: (error: Error) => void;
    vi.mocked(owners[0]!.engine.dispose).mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, fail) => {
          reject = fail;
        }),
    );
    const suspension = controller.suspend();
    await flush();
    const selected = controller.select(channel('b'));
    reject(new Error('cleanup failed'));
    await expect(suspension).rejects.toThrow('Background playback cleanup could not be confirmed.');
    await selected;
    expect(controller.snapshot.selection?.id).toBe('b');
    owners.at(-1)!.emit({ type: 'progress' });
    expect(controller.snapshot.state).toBe('playing');
    await controller.dispose();
  });
  it('completes 50 suspend/resume cycles without retaining owners or timers', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('a'));
    for (let cycle = 0; cycle < 50; cycle++) {
      owners.at(-1)!.emit({ type: 'progress' });
      await controller.suspend();
      expect(controller.snapshot.state).toBe('paused');
      expect(vi.getTimerCount()).toBe(0);
      await controller.resume();
    }
    await controller.dispose();
    expect(owners).toHaveLength(51);
    expect(owners.every((owner) => vi.mocked(owner.engine.dispose).mock.calls.length === 1)).toBe(
      true,
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
it('joins original failed cleanup without changing guidance or touching a replacement engine', async () => {
  const { controller, owners } = harness({ holdInitialCancellation: true });
  await controller.select(channel('failed'));
  owners[0]!.emit({
    type: 'error',
    failure: { code: 'access', message: 'Access refused.', retryable: false },
  });
  const joined = controller.joinFailedCleanup('failed');
  let settled = false;
  void joined.then(() => (settled = true));
  await flush();
  expect(settled).toBe(false);
  expect(controller.snapshot.state).toBe('failed');
  expect(controller.snapshot.error).toBe('Access refused.');
  const newer = controller.select(channel('next'));
  await expect(controller.joinFailedCleanup('failed')).rejects.toMatchObject({
    name: 'AbortError',
  });
  owners[0]!.resolve!();
  await joined;
  await newer;
  owners[1]!.emit({ type: 'progress' });
  expect(controller.snapshot.state).toBe('playing');
  expect(owners[1]!.engine.dispose).not.toHaveBeenCalled();
  await controller.dispose();
});
