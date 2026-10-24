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
 * Playback controller: capabilities, on-demand completion, ended live
 * streams and recovery authority.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ChannelSelection } from '../../src/playback/controller';
import { createSharingHost } from '../../src/application/sharing-host';
import { harness, channel, flush, temporary } from './controller.fixture';

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
