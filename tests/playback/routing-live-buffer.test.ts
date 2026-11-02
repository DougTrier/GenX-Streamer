/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { expect, it, vi } from 'vitest';
import { createRoutingEngineFactory } from '../../src/playback/routing-engine';
import { type EngineEvent, type PlaybackEngine } from '../../src/playback/controller';
import { type LiveBufferTelemetry } from '../../src/playback/live-buffer';
import { channel } from './controller.fixture';

const telemetry: LiveBufferTelemetry = {
  incomingBitsPerSecond: 80_000,
  bufferedSeconds: 3,
  targetSeconds: 3,
  mode: 'auto',
  capability: 'controlled',
};
function engine(): PlaybackEngine {
  return {
    start: vi.fn(async () => {}),
    pause: vi.fn(),
    resume: vi.fn(async () => {}),
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    dispose: vi.fn(),
    readLiveBuffer: () => ({ ...telemetry }),
    setLiveBuffer: vi.fn(() => true),
  };
}
it('forwards measurements and keeps the accepted preference across native format handover', async () => {
  const web = engine(),
    native = engine();
  let webEvent!: (event: EngineEvent) => void;
  const route = createRoutingEngineFactory(
    (emit) => {
      webEvent = emit;
      return web;
    },
    null,
    () => false,
    () => native,
  )(() => {});
  const signal = new AbortController();
  try {
    await route.start(channel('a'), signal.signal);
    expect(route.readLiveBuffer?.()).toEqual(telemetry);
    expect(await route.setLiveBuffer?.({ mode: 'manual', targetSeconds: 11 })).toBe(true);
    webEvent({
      type: 'error',
      failure: {
        code: 'unsupported',
        message: 'Needs native picture.',
        retryable: false,
        nativeFormat: 'mpeg2',
      },
    });
    expect(native.start).toHaveBeenCalledWith(
      expect.objectContaining({ liveBuffer: { mode: 'manual', targetSeconds: 11 } }),
      signal.signal,
    );
    expect(await route.setLiveBuffer?.({ mode: 'auto' })).toBe(true);
    expect(native.setLiveBuffer).toHaveBeenCalledWith({ mode: 'auto' });
  } finally {
    await route.dispose();
  }
});
it('refuses a late old-inner ACK even when the outer routed attempt is unchanged', async () => {
  const web = engine(),
    native = engine();
  let webEvent!: (event: EngineEvent) => void;
  let acknowledge!: (value: boolean) => void;
  web.setLiveBuffer = () =>
    new Promise((resolve) => {
      acknowledge = resolve;
    });
  const route = createRoutingEngineFactory(
    (emit) => {
      webEvent = emit;
      return web;
    },
    null,
    () => false,
    () => native,
  )(() => {});
  try {
    await route.start(channel('a'), new AbortController().signal);
    const changing = route.setLiveBuffer?.({ mode: 'manual', targetSeconds: 12 });
    webEvent({
      type: 'error',
      failure: {
        code: 'unsupported',
        message: 'Needs native picture.',
        retryable: false,
        nativeFormat: 'mpeg2',
      },
    });
    acknowledge(true);
    expect(await changing).toBe(false);
    expect(native.start).toHaveBeenCalledWith(
      expect.not.objectContaining({ liveBuffer: { mode: 'manual', targetSeconds: 12 } }),
      expect.any(AbortSignal),
    );
  } finally {
    await route.dispose();
  }
});
