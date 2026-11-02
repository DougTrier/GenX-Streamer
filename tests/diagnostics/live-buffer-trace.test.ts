/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LiveBufferTelemetry } from '../../src/playback/live-buffer';
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }));
let now = 1000;
const telemetry = (overrides: Partial<LiveBufferTelemetry> = {}): LiveBufferTelemetry => ({
  incomingBitsPerSecond: 12000,
  bufferedSeconds: 4.5,
  targetSeconds: 3,
  mode: 'auto',
  capability: 'controlled',
  ...overrides,
});
beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
  bridge.invoke.mockReset();
  now = 1000;
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  bridge.invoke.mockImplementation(async (_command, args) => ({
    active: args?.request?.action === 'start',
    untilMs: now + 900000,
    records: [],
    droppedEvents: 0,
  }));
});
const writes = () =>
  bridge.invoke.mock.calls
    .filter((call) => call[1]?.request?.action === 'record')
    .map((call) => call[1].request.record);

describe('buffer measurement capture', () => {
  it('enriches the existing sample without replacing advertised bandwidth or adding periodic records', async () => {
    const trace = await import('../../src/diagnostics/playback-trace');
    await trace.playbackTrace.start();
    for (let index = 0; index < 1000; index++) {
      now++;
      trace.recordLiveBufferSample('free', telemetry());
    }
    expect(writes()).toHaveLength(0);
    trace.recordPlaybackTrace('free', 'sample', { totalFrames: 11, bandwidthEstimate: 999999 });
    await trace.playbackTrace.read();
    expect(writes()).toEqual([
      {
        mode: 'free',
        event: 'sample',
        values: {
          totalFrames: 11,
          bandwidthEstimate: 999999,
          incomingMediaBitsPerSecond: 12000,
          bufferedAheadMs: 4500,
          bufferTargetSeconds: 3,
          manualBuffer: false,
          frontendDroppedEvents: 0,
        },
      },
    ]);
  });
  it('records actual policy changes immediately only after a previous known value', async () => {
    const trace = await import('../../src/diagnostics/playback-trace');
    await trace.playbackTrace.start();
    trace.recordLiveBufferSample('paid', telemetry());
    trace.recordLiveBufferSample('paid', telemetry({ mode: 'manual', targetSeconds: 12 }));
    trace.recordLiveBufferSample(
      'paid',
      telemetry({ mode: 'manual', targetSeconds: 12, incomingBitsPerSecond: 0 }),
    );
    trace.recordLiveBufferSample('paid', telemetry({ mode: 'manual', targetSeconds: 13 }));
    trace.recordLiveBufferSample('paid', telemetry({ mode: 'auto', targetSeconds: null }));
    await trace.playbackTrace.read();
    expect(
      writes().map((r) => [r.event, r.values.bufferTargetSeconds, r.values.manualBuffer]),
    ).toEqual([
      ['sample', 12, true],
      ['sample', 13, true],
      ['sample', null, false],
    ]);
  });
  it('preserves real zero and unknown, and does not replace known buffer with unknown', async () => {
    const trace = await import('../../src/diagnostics/playback-trace');
    await trace.playbackTrace.start();
    trace.recordLiveBufferSample(
      'free',
      telemetry({ incomingBitsPerSecond: 0, bufferedSeconds: null, targetSeconds: null }),
    );
    trace.recordPlaybackTrace('free', 'sample', { bufferedAheadMs: 9000 });
    await trace.playbackTrace.read();
    expect(writes()[0].values).toMatchObject({
      incomingMediaBitsPerSecond: 0,
      bufferTargetSeconds: null,
      bufferedAheadMs: 9000,
    });
    trace.recordLiveBufferSample(
      'free',
      telemetry({ incomingBitsPerSecond: null, targetSeconds: null }),
    );
    trace.recordPlaybackTrace('free', 'sample', {});
    await trace.playbackTrace.read();
    expect(writes()[1].values.incomingMediaBitsPerSecond).toBeNull();
  });
  it('clears on null/new selection, mode change, expiry and backwards clock', async () => {
    const trace = await import('../../src/diagnostics/playback-trace');
    await trace.playbackTrace.start();
    trace.recordLiveBufferSample('free', telemetry());
    trace.recordLiveBufferSample('free', null);
    trace.recordPlaybackTrace('free', 'sample', { totalFrames: 1 });
    trace.recordLiveBufferSample('paid', telemetry());
    trace.recordPlaybackTrace('free', 'sample', { totalFrames: 2 });
    now += 5000;
    trace.recordPlaybackTrace('paid', 'sample', { totalFrames: 3 });
    trace.recordLiveBufferSample('paid', telemetry());
    now--;
    trace.recordPlaybackTrace('paid', 'sample', { totalFrames: 4 });
    await trace.playbackTrace.read();
    expect(writes()).toHaveLength(4);
    expect(writes().every((row) => row.values.incomingMediaBitsPerSecond === undefined)).toBe(true);
  });
  it('takes a synchronous observation copy before a queued IPC crosses a source switch', async () => {
    const trace = await import('../../src/diagnostics/playback-trace');
    await trace.playbackTrace.start();
    let release!: () => void;
    const held = new Promise<void>((done) => {
      release = done;
    });
    bridge.invoke.mockImplementation(async (_command, args) => {
      if (args?.request?.action === 'record') await held;
      return { active: true };
    });
    trace.recordLiveBufferSample('free', telemetry({ incomingBitsPerSecond: 1000 }));
    trace.recordPlaybackTrace('free', 'sample', { totalFrames: 1 });
    trace.recordLiveBufferSample('free', null);
    trace.recordLiveBufferSample('free', telemetry({ incomingBitsPerSecond: 8000 }));
    release();
    await trace.playbackTrace.read();
    expect(writes()[0].values.incomingMediaBitsPerSecond).toBe(1000);
  });
  it('is opt-in only and refuses secret fields/getters/proxies without throwing or serializing them', async () => {
    const trace = await import('../../src/diagnostics/playback-trace');
    trace.recordLiveBufferSample('free', telemetry());
    expect(writes()).toHaveLength(0);
    await trace.playbackTrace.start();
    const getter = vi.fn(() => {
      throw Error('https://secret.invalid/password');
    });
    const bad = {
      ...telemetry(),
      get incomingBitsPerSecond() {
        return getter();
      },
    };
    expect(() => trace.recordLiveBufferSample('free', bad)).not.toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      trace.recordLiveBufferSample('free', new Proxy(telemetry(), { ownKeys: getter })),
    ).not.toThrow();
    trace.recordLiveBufferSample('free', {
      ...telemetry(),
      secret: 'https://secret.invalid/password',
    } as LiveBufferTelemetry);
    trace.recordPlaybackTrace('free', 'sample', { totalFrames: 2 });
    await trace.playbackTrace.read();
    expect(writes()[0].values.incomingMediaBitsPerSecond).toBeUndefined();
    expect(JSON.stringify(bridge.invoke.mock.calls)).not.toMatch(/secret|password|https/);
  });
});
