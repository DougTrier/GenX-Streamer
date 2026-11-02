/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, expect, it, vi } from 'vitest';
import {
  PlaybackController,
  type PlaybackControllerOptions,
  type PlaybackEngine,
} from '../../src/playback/controller';
import { type LiveBufferTelemetry } from '../../src/playback/live-buffer';
import { channel, flush } from './controller.fixture';

const controllers: PlaybackController[] = [];
afterEach(async () => {
  for (const controller of controllers.splice(0)) await controller.dispose();
  vi.useRealTimers();
});
function setup(options: PlaybackControllerOptions = {}) {
  const engines: PlaybackEngine[] = [];
  const factory = vi.fn(() => {
    let reading: LiveBufferTelemetry = {
      incomingBitsPerSecond: null,
      bufferedSeconds: 3,
      targetSeconds: 3,
      mode: 'auto',
      capability: 'controlled',
    };
    const engine: PlaybackEngine = {
      start: vi.fn(async () => {}),
      pause: vi.fn(),
      resume: vi.fn(async () => {}),
      setMuted: vi.fn(),
      setVolume: vi.fn(),
      dispose: vi.fn(),
      readLiveBuffer: () => reading,
      setLiveBuffer: vi.fn((preference) => {
        reading = {
          ...reading,
          mode: preference.mode,
          targetSeconds: preference.mode === 'manual' ? preference.targetSeconds : 3,
        };
        return true;
      }),
    };
    engines.push(engine);
    return engine;
  });
  const controller = new PlaybackController(factory, undefined, undefined, options);
  controllers.push(controller);
  return { controller, engines, factory };
}

it('changes the current target without start/pause/resume/seek or another engine', async () => {
  const { controller, engines, factory } = setup();
  await controller.select(channel('a'));
  expect(await controller.setLiveBuffer({ mode: 'manual', targetSeconds: 9 })).toBe(true);
  expect(controller.liveBuffer?.targetSeconds).toBe(9);
  expect(factory).toHaveBeenCalledOnce();
  expect(engines[0].start).toHaveBeenCalledOnce();
  expect(engines[0].pause).not.toHaveBeenCalled();
  expect(engines[0].resume).not.toHaveBeenCalled();
  expect(await controller.setLiveBuffer({ mode: 'manual', targetSeconds: 99 })).toBe(false);
  expect(controller.liveBuffer?.targetSeconds).toBe(9);
  const snapshot = controller.snapshot;
  if (snapshot.selection?.liveBuffer?.mode === 'manual')
    snapshot.selection.liveBuffer.targetSeconds = 1;
  expect(controller.snapshot.selection?.liveBuffer).toEqual({ mode: 'manual', targetSeconds: 9 });
});

it('refuses unavailable controls but permits finite playback when its actual engine can control it', async () => {
  const { controller, engines } = setup();
  expect(controller.liveBuffer).toBeNull();
  await controller.select(channel('a'));
  engines[0].readLiveBuffer = () => ({
    incomingBitsPerSecond: null,
    bufferedSeconds: 2,
    targetSeconds: null,
    mode: 'auto',
    capability: 'observe-only',
  });
  expect(await controller.setLiveBuffer({ mode: 'manual', targetSeconds: 8 })).toBe(false);
  await controller.select({ ...channel('vod'), playMode: 'on-demand' });
  expect(controller.liveBuffer?.capability).toBe('controlled');
  expect(await controller.setLiveBuffer({ mode: 'manual', targetSeconds: 8 })).toBe(true);
  expect(engines[1].start).toHaveBeenCalledOnce();
  expect(engines[1].pause).not.toHaveBeenCalled();
});

it('a late setter ACK cannot change or report success for the replacement stream', async () => {
  const { controller, engines } = setup();
  await controller.select(channel('a'));
  let acknowledge!: (value: boolean) => void;
  engines[0].setLiveBuffer = () => new Promise((resolve) => (acknowledge = resolve));
  const changing = controller.setLiveBuffer({ mode: 'manual', targetSeconds: 12 });
  await controller.select(channel('b'));
  acknowledge(true);
  expect(await changing).toBe(false);
  expect(controller.snapshot.selection?.id).toBe('b');
  expect(controller.snapshot.selection?.liveBuffer).toBeUndefined();
  expect(controller.liveBuffer?.mode).toBe('auto');
});

it('awaits the preference before allocation, but Stop never waits for a stuck lookup', async () => {
  let resolvePreference!: (value: { mode: 'manual'; targetSeconds: number }) => void;
  const { controller, factory } = setup({
    liveBufferPreference: () => new Promise((resolve) => (resolvePreference = resolve)),
  });
  const starting = controller.select(channel('a'));
  await flush();
  expect(factory).not.toHaveBeenCalled();
  await controller.stop();
  await starting;
  expect(controller.snapshot.state).toBe('idle');
  resolvePreference({ mode: 'manual', targetSeconds: 15 });
  await flush();
  expect(factory).not.toHaveBeenCalled();
});

it('a superseded preference lookup cannot allocate after the next stream has started', async () => {
  let resolveOld!: (value: { mode: 'manual'; targetSeconds: number }) => void;
  const { controller, engines, factory } = setup({
    liveBufferPreference: (selection) =>
      selection.id === 'a'
        ? new Promise((resolve) => (resolveOld = resolve))
        : { mode: 'manual', targetSeconds: 4 },
  });
  const old = controller.select(channel('a'));
  await flush();
  await controller.select(channel('b'));
  await old;
  expect(factory).toHaveBeenCalledOnce();
  expect(engines[0].start).toHaveBeenCalledWith(
    expect.objectContaining({ id: 'b', liveBuffer: { mode: 'manual', targetSeconds: 4 } }),
    expect.any(AbortSignal),
  );
  resolveOld({ mode: 'manual', targetSeconds: 20 });
  await flush();
  expect(factory).toHaveBeenCalledOnce();
  expect(controller.snapshot.selection?.liveBuffer).toEqual({ mode: 'manual', targetSeconds: 4 });
});

it('an unresolved lookup cannot allocate after the existing startup deadline', async () => {
  vi.useFakeTimers();
  const { controller, factory } = setup({ liveBufferPreference: () => new Promise(() => {}) });
  const starting = controller.select(channel('a'));
  await flush();
  await vi.advanceTimersByTimeAsync(20_000);
  await starting;
  expect(factory).not.toHaveBeenCalled();
  expect(controller.snapshot.state).toBe('failed');
});
