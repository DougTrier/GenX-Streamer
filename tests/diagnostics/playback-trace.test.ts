// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PlaybackSnapshot } from '../../src/playback/controller';
const bridge = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: bridge.invoke }));
beforeEach(() => {
  vi.resetModules();
  bridge.invoke.mockReset();
  bridge.invoke.mockImplementation(
    async (_command: string, args?: { request?: { action?: string } }) => ({
      schemaVersion: 1,
      version: '0.1.6',
      build: 1006,
      active: args?.request?.action === 'start',
      untilMs: Date.now() + 900000,
      records: [],
      droppedEvents: 0,
    }),
  );
});
describe('playback capture boundary', () => {
  it.each([
    ['playback-trace-invalid', 'validation'],
    ['playback-trace-write', 'storage'],
    ['playback-trace-encode', 'storage'],
    ['playback-trace-worker', 'worker'],
    ['application-closing', 'application-closing'],
    ['https://user:secret@provider.invalid/private', 'unknown'],
  ])(
    'retains closed interruption category for %s without changing rejection',
    async (rejected, category) => {
      const trace = await import('../../src/diagnostics/playback-trace');
      const success = bridge.invoke.getMockImplementation()!;
      await trace.playbackTrace.start();
      bridge.invoke.mockImplementation(async (command, args) => {
        if (args?.request?.action === 'record') throw rejected;
        return success(command, args);
      });
      trace.recordPlaybackTrace('paid', 'warning', {
        code: 'decode',
        detail: 'mse-no-progress',
        transport: 'hls',
      });
      await trace.playbackTrace.read();
      expect(trace.traceInterrupted()).toBe(true);
      expect(trace.traceEnabled()).toBe(false);
      expect(trace.traceInterruptionReason()).toBe(category);
      const calls = bridge.invoke.mock.calls.length;
      trace.recordPlaybackTrace('paid', 'sample', { totalFrames: 12 });
      await Promise.resolve();
      expect(bridge.invoke.mock.calls.length).toBe(calls);
      expect(JSON.stringify(trace.traceInterruptionReason())).not.toMatch(
        /secret|https|provider|private/,
      );
      bridge.invoke.mockImplementation(success);
      await trace.playbackTrace.start();
      expect(trace.traceInterruptionReason()).toBeNull();
      expect(trace.traceInterrupted()).toBe(false);
      await trace.playbackTrace.dispose();
    },
  );
  it('does not read untrusted error getters or reflect unknown keys/values', async () => {
    const { playbackTraceFailureReason } = await import('../../src/diagnostics/playback-trace');
    const getter = vi.fn(() => {
      throw Error('secret');
    });
    expect(
      playbackTraceFailureReason({
        get message() {
          return getter();
        },
        private: 'https://secret.invalid',
      }),
    ).toBe('unknown');
    expect(getter).not.toHaveBeenCalled();
    expect(
      playbackTraceFailureReason({ message: 'playback-trace-invalid', stack: 'private' }),
    ).toBe('validation');
    expect(playbackTraceFailureReason(new Error('private unknown failure'))).toBe('unknown');
  });
  it('keeps 15 minutes of quarter-second HLS parts within the recorder budget alongside frame samples and errors', async () => {
    const { createPlaybackDeliverySampler } = await import('../../src/diagnostics/playback-trace');
    const native = createPlaybackDeliverySampler();
    let routine = 0;
    for (let ms = 0; ms < 900000; ms += 250) if (native(ms)) routine++;
    // Body facts + buffered-fragment facts + five-second frame/native bounds
    // samples. Reserve room for immediate states/errors in the 800-entry ring.
    const otherRoutine = 180 + 2 * 180;
    expect(routine + otherRoutine + 20).toBeLessThanOrEqual(800);
    expect(routine).toBeGreaterThanOrEqual(150);
    expect(native(Number.NaN)).toBe(false);
    expect(native(-1)).toBe(false);
    expect(native(100)).toBe(true); // A reset monotonic origin cannot starve capture.
  });
  it('covers each playback section while excluding source URLs, names and account identities', async () => {
    const trace = await import('../../src/diagnostics/playback-trace');
    await trace.playbackTrace.start();
    for (const id of [
      'public-channel',
      'account-secret-id',
      'vod:movie:secret-id',
      'archive-secret-id',
    ]) {
      trace.recordPlaybackState({
        state: 'playing',
        selection: {
          id,
          name: 'private channel name',
          url: 'https://user:password@private.invalid/secret-token',
        },
      } as PlaybackSnapshot);
    }
    trace.recordWebTrace('open', [784, 257, 1088, 612]);
    await trace.playbackTrace.dispose();
    const calls = bridge.invoke.mock.calls;
    const records = calls
      .filter((call) => call[1]?.request?.action === 'record')
      .map((call) => call[1].request.record);
    expect(records.map((r) => r.mode)).toEqual(['free', 'paid', 'paid', 'genxtra', 'web']);
    const text = JSON.stringify(calls);
    for (const secret of [
      'secret-id',
      'private channel',
      'password',
      'private.invalid',
      'secret-token',
    ])
      expect(text).not.toContain(secret);
    expect(calls.some((call) => call[1]?.request?.action === 'stop')).toBe(false);
  });
  it('limits queued writes when the native recorder stalls and reports dropped observations', async () => {
    const trace = await import('../../src/diagnostics/playback-trace');
    await trace.playbackTrace.start();
    let unblock: () => void = () => undefined;
    const wait = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    bridge.invoke.mockImplementation(async () => {
      await wait;
      return { active: true, recorded: true };
    });
    for (let i = 0; i < 1000; i++) trace.recordPlaybackTrace('paid', 'sample', { totalFrames: i });
    const joined = trace.playbackTrace.dispose();
    unblock();
    await joined;
    const writes = bridge.invoke.mock.calls.filter((call) => call[1]?.request?.action === 'record');
    expect(writes.length).toBeLessThanOrEqual(16);
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.some((call) => call[1].request.record.values.frontendDroppedEvents > 0)).toBe(
      true,
    );
    expect(trace.traceEnabled()).toBe(false);
  });
});
