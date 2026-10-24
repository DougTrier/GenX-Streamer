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
import { createResourceOwners } from '../../src/playback/resource-owners';
import { classifyHttpFailure } from '../../src/playback/failure';
import { createSharingHost } from '../../src/application/sharing-host';
import {
  PlaybackController,
  type ChannelSelection,
  type EngineEvent,
  type PlaybackEngine,
  type DecodedPlaybackObservation,
} from '../../src/playback/controller';

const channel = (id: string): ChannelSelection => ({
  id,
  name: id,
  url: `https://example.test/${id}.m3u8`,
});

it('records inspected capabilities without claiming playback and ignores stale metadata', async () => {
  const { controller, owners } = harness();
  await controller.select(channel('one'));
  owners[0]!.emit({
    type: 'capability',
    mediaKind: 'hls',
    mediaMime: 'application/vnd.apple.mpegurl',
  });
  expect(controller.snapshot.state).toBe('connecting');
  expect(controller.snapshot.selection).toMatchObject({ id: 'one', mediaKind: 'hls' });
  await controller.select(channel('two'));
  owners[0]!.emit({ type: 'capability', mediaKind: 'media', mediaMime: 'video/mp4' });
  expect(controller.snapshot.selection).toMatchObject({ id: 'two' });
  expect(controller.snapshot.selection).not.toHaveProperty('mediaKind');
  await controller.dispose();
});
const flush = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function harness(options: { holdInitialCancellation?: boolean } = {}) {
  const resources = createResourceOwners();
  const owners: Array<{
    engine: PlaybackEngine;
    emit: (event: EngineEvent) => void;
    signal?: AbortSignal;
    reject?: (error: Error) => void;
    resolve?: () => void;
  }> = [];
  const controller = new PlaybackController(
    (emit) => {
      const owner: (typeof owners)[number] = { engine: null as unknown as PlaybackEngine, emit };
      const holdCancellation = options.holdInitialCancellation && owners.length === 0;
      let cancelInitialization: (() => void) | undefined;
      owner.engine = {
        start: vi.fn((_selection, signal) => {
          owner.signal = signal;
          return new Promise<void>((resolve, reject) => {
            const canceled = () => {
              if (!holdCancellation) owner.resolve?.();
            };
            const settle = (failure?: Error) => {
              signal.removeEventListener('abort', canceled);
              if (failure) reject(failure);
              else resolve();
            };
            owner.resolve = () => settle();
            owner.reject = (failure) => settle(failure);
            cancelInitialization = canceled;
            signal.addEventListener('abort', canceled, { once: true });
            if (signal.aborted) canceled();
          });
        }),
        pause: vi.fn(),
        resume: vi.fn(async () => {}),
        setMuted: vi.fn(),
        setVolume: vi.fn(),
        dispose: vi.fn(() => cancelInitialization?.()),
      };
      owners.push(owner);
      return owner.engine;
    },
    undefined,
    resources,
  );
  return { controller, owners, resources };
}
const temporary: EngineEvent = {
  type: 'error',
  failure: { code: 'network', message: 'Network unavailable', retryable: true },
};

it('finishes explicit on-demand media without failure or retaining its decoder', async () => {
  const { controller, owners, resources } = harness();
  await controller.select({ ...channel('episode'), playMode: 'on-demand' });
  owners[0]!.emit({ type: 'progress' });
  owners[0]!.emit({ type: 'ended' });
  await flush();
  expect(controller.snapshot).toMatchObject({ state: 'idle', selection: null, error: null });
  expect(resources.snapshot().counts.controllerEngines).toBe(0);
  await controller.select(channel('next'));
  owners[0]!.emit({ type: 'ended' });
  expect(controller.snapshot.selection?.id).toBe('next');
  await controller.dispose();
});

describe('a live stream that ends', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reconnects by itself, as a dropped connection would (provider closed the stream)', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('game'));
    owners[0]!.emit({ type: 'progress' });
    expect(controller.snapshot.state).toBe('playing');
    owners[0]!.emit({ type: 'ended' });
    expect(controller.snapshot.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(250);
    expect(owners).toHaveLength(2);
    expect(owners[1]!.engine.start).toHaveBeenCalledWith(channel('game'), expect.any(AbortSignal));
    owners[1]!.emit({ type: 'progress' });
    expect(controller.snapshot).toMatchObject({ state: 'playing', error: null });
    await controller.dispose();
  });

  it('a retry of the same address keeps its known format (no extra probe connection)', async () => {
    const { controller, owners } = harness();
    const known = { ...channel('paid'), mediaKind: 'media' as const, mediaMime: 'video/mp2t' };
    await controller.select(known);
    owners[0]!.emit({ type: 'progress' });
    owners[0]!.emit({ type: 'ended' });
    await vi.advanceTimersByTimeAsync(250);
    expect(owners[1]!.engine.start).toHaveBeenCalledWith(known, expect.any(AbortSignal));
    await controller.dispose();
  });

  it('a one-connection provider still counting the old stream gets the paid startup budget', async () => {
    const { controller, owners } = harness();
    // Paid TV starts carry 35 s (the relay waits up to 30 s for a busy provider).
    await controller.select({ ...channel('paid'), startupMs: 35_000 });
    owners[0]!.emit({ type: 'progress' });
    owners[0]!.emit(temporary);
    await vi.advanceTimersByTimeAsync(250);
    expect(owners).toHaveLength(2);
    // The provider keeps the reconnect waiting (no progress yet) for 25 s.
    await vi.advanceTimersByTimeAsync(25_000);
    expect(controller.snapshot.state).toBe('reconnecting');
    owners[1]!.emit({ type: 'progress' });
    expect(controller.snapshot).toMatchObject({ state: 'playing', error: null });
    await controller.dispose();
  });

  it('free channels keep their own 20 s reconnect budget', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('free'));
    owners[0]!.emit({ type: 'progress' });
    owners[0]!.emit(temporary);
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(controller.snapshot.state).toBe('failed');
    await controller.dispose();
  });

  it('stays bounded when a stream keeps ending at once', async () => {
    const { controller, owners } = harness();
    await controller.select(channel('flaky'));
    for (let attempt = 0; attempt < 2; attempt++) {
      owners[attempt]!.emit({ type: 'ended' });
      await vi.advanceTimersByTimeAsync(250);
    }
    owners[2]!.emit({ type: 'ended' });
    await vi.advanceTimersByTimeAsync(250);
    expect(controller.snapshot.state).toBe('failed');
    expect(owners).toHaveLength(3);
    await controller.dispose();
  });
});

describe('recovery authority and endpoint transitions', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('rechecks both same-URL retries without transitioning and retains the original deadline', async () => {
    const { controller, owners, resources } = harness();
    const beforeRetry = vi.fn(async () => {});
    const beforeCandidate = vi.fn(async () => {});
    await controller.select(channel('a'), {
      urls: [channel('a').url],
      beforeRetry,
      beforeCandidate,
    });
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(beforeCandidate).not.toHaveBeenCalled();
    for (let retry = 0; retry < 2; retry++) {
      owners[retry]!.emit(temporary);
      await vi.advanceTimersByTimeAsync(250);
      expect(beforeRetry).toHaveBeenCalledTimes(retry + 1);
      expect(beforeCandidate).not.toHaveBeenCalled();
      expect(owners).toHaveLength(retry + 2);
      expect(owners[retry + 1]!.engine.start).toHaveBeenCalledWith(
        channel('a'),
        expect.any(AbortSignal),
      );
    }
    await vi.advanceTimersByTimeAsync(19_499);
    expect(controller.snapshot.state).toBe('reconnecting');
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.snapshot).toMatchObject({ state: 'failed', failure: { code: 'timeout' } });
    await controller.dispose();
    expect(resources.snapshot().counts.controllerEngines).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('transitions only A to B, while subsequent B retry still rechecks authority', async () => {
    const { controller, owners } = harness();
    const calls: string[] = [];
    const beforeRetry = vi.fn(async (selection: ChannelSelection) => {
      calls.push(`retry:${selection.url}`);
    });
    const beforeCandidate = vi.fn(async (selection: ChannelSelection) => {
      calls.push(`transition:${selection.url}`);
    });
    const nextUrl = channel('b').url;
    await controller.select(channel('a'), {
      urls: [channel('a').url, nextUrl],
      beforeRetry,
      beforeCandidate,
    });
    owners[0]!.emit(temporary);
    await vi.advanceTimersByTimeAsync(250);
    expect(calls).toEqual([`retry:${nextUrl}`, `transition:${nextUrl}`]);
    expect(controller.snapshot.selection).toEqual({ ...channel('a'), url: nextUrl });
    owners[1]!.emit(temporary);
    await vi.advanceTimersByTimeAsync(250);
    expect(beforeRetry).toHaveBeenCalledTimes(2);
    expect(beforeCandidate).toHaveBeenCalledOnce();
    expect(owners).toHaveLength(3);
    owners[2]!.emit(temporary);
    await flush();
    expect(controller.snapshot.state).toBe('failed');
    expect(owners).toHaveLength(3);
    await controller.dispose();
  });

  it('same-URL authority refusal prevents allocation without transitioning', async () => {
    const { controller, owners } = harness();
    const beforeRetry = vi.fn(async () => {
      throw new DOMException('Revoked', 'AbortError');
    });
    const beforeCandidate = vi.fn(async () => {});
    await controller.select(channel('a'), {
      urls: [channel('a').url],
      beforeRetry,
      beforeCandidate,
    });
    owners[0]!.emit(temporary);
    await vi.advanceTimersByTimeAsync(250);
    expect(beforeRetry).toHaveBeenCalledOnce();
    expect(beforeCandidate).not.toHaveBeenCalled();
    expect(owners).toHaveLength(1);
    expect(controller.snapshot).toMatchObject({ state: 'failed', failure: { code: 'policy' } });
    await controller.dispose();
  });

  it('stop joins a held retry authority check and prevents a later endpoint transition', async () => {
    const { controller, owners } = harness();
    let finish!: () => void;
    let signal!: AbortSignal;
    const beforeRetry = vi.fn((_selection: ChannelSelection, owned: AbortSignal) => {
      signal = owned;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    const beforeCandidate = vi.fn(async () => {});
    await controller.select(channel('a'), {
      urls: [channel('a').url, channel('b').url],
      beforeRetry,
      beforeCandidate,
    });
    owners[0]!.emit(temporary);
    await vi.advanceTimersByTimeAsync(250);
    expect(beforeRetry).toHaveBeenCalledOnce();
    let stopped = false;
    const stopping = controller.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(signal.aborted).toBe(true);
    expect(stopped).toBe(false);
    finish();
    await stopping;
    expect(beforeCandidate).not.toHaveBeenCalled();
    expect(owners).toHaveLength(1);
    expect(controller.snapshot.state).toBe('idle');
    await controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('holds actual initializer ownership until obsolete success settles, then allocates the replacement', async () => {
    const { controller, owners, resources } = harness({ holdInitialCancellation: true });
    await controller.select(channel('a'));
    let selected = false;
    const selecting = controller.select(channel('b')).then(() => {
      selected = true;
    });
    await flush();
    expect(owners[0]!.signal!.aborted).toBe(true);
    expect(owners[0]!.engine.dispose).toHaveBeenCalledOnce();
    expect(selected).toBe(false);
    expect(owners).toHaveLength(1);
    expect(resources.snapshot().counts.controllerEngines).toBe(1);
    owners[0]!.emit({ type: 'progress' });
    expect(controller.snapshot).toMatchObject({ state: 'connecting', selection: { id: 'b' } });
    owners[0]!.resolve!();
    await selecting;
    expect(owners).toHaveLength(2);
    owners[0]!.emit(temporary);
    expect(controller.snapshot.selection?.id).toBe('b');
    expect(resources.snapshot().highWater.controllerEngines).toBe(1);
    await controller.dispose();
    expect(resources.snapshot().counts.controllerEngines).toBe(0);
  });

  it('sharing keeps one-URL retry publication generation and changes it only on an alternative', async () => {
    for (const alternatives of [false, true]) {
      const { controller, owners } = harness();
      const urls = [channel('a').url, ...(alternatives ? [channel('b').url] : [])];
      const bridge = createSharingHost({
        player: controller,
        channels: () => [{ id: 'a', name: 'a', category: '', sourceId: 'fixture', urls }],
        settings: () => ({ muted: false, volume: 1, removedChannels: [] }),
        saveAudio: async () => {},
      });
      const withdrawal = vi.fn(async () => {});
      bridge.bindBeforeSelection(withdrawal);
      await bridge.select(channel('a'));
      const initialGeneration = bridge.host.snapshot().generation;
      owners[0]!.emit(temporary);
      await vi.advanceTimersByTimeAsync(250);
      const expectedGeneration = initialGeneration + (alternatives ? 1 : 0);
      expect(bridge.host.snapshot().generation).toBe(expectedGeneration);
      expect(withdrawal).toHaveBeenCalledTimes(alternatives ? 2 : 1);
      owners[1]!.emit(temporary);
      await vi.advanceTimersByTimeAsync(250);
      expect(bridge.host.snapshot().generation).toBe(expectedGeneration);
      expect(withdrawal).toHaveBeenCalledTimes(alternatives ? 2 : 1);
      await bridge.dispose();
    }
    expect(vi.getTimerCount()).toBe(0);
  });
});

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

describe('playback session ownership', () => {
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
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
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
