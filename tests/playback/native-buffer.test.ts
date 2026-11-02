/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { describe, expect, it, vi } from 'vitest';
import { createNativeVodEngine, type NativeEngineHost } from '../../src/playback/native-vod-engine';
import { createNativeLiveEngine } from '../../src/playback/native-live-engine';
import {
  validateNativeVideoStatus,
  type NativeVideoRequest,
  type NativeVideoStatus,
} from '../../src/platform/native-video';
import type { LiveBufferTelemetry } from '../../src/playback/live-buffer';

const AUTO: LiveBufferTelemetry = {
  mode: 'auto',
  capability: 'controlled',
  targetSeconds: null,
  incomingBitsPerSecond: 8000,
  bufferedSeconds: 3.5,
};
const manual = (targetSeconds: number): LiveBufferTelemetry => ({
  ...AUTO,
  mode: 'manual',
  targetSeconds,
});
const selection = {
  id: 'public-fixture',
  name: 'Fixture',
  url: 'http://127.0.0.1:41234/media/' + 'a'.repeat(64),
  mediaKind: 'hls' as const,
};
const signal = () => new AbortController().signal;
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const requests: NativeVideoRequest[] = [];
  let telemetry: LiveBufferTelemetry | undefined = { ...AUTO };
  let session = 0;
  let tick: (() => void) | null = null;
  let intercept: ((request: NativeVideoRequest) => Promise<NativeVideoStatus> | null) | null = null;
  const status = (policy = telemetry, owned = session): NativeVideoStatus => ({
    session: owned,
    state: 'ready',
    playing: true,
    positionMs: 1000,
    durationMs: -1,
    audio: [],
    text: [],
    ...(policy ? { liveBuffer: policy } : {}),
  });
  const host: NativeEngineHost = {
    bridge: vi.fn(async (request) => {
      requests.push(request);
      session = request.session;
      const held = intercept?.(request);
      if (held) return held;
      if ((request.action === 'buffer' || request.action === 'open') && request.liveBuffer)
        telemetry =
          request.liveBuffer.mode === 'auto'
            ? { ...AUTO }
            : manual(request.liveBuffer.targetSeconds);
      return status();
    }),
    rect: () => [0, 0, 320, 180],
    watchRect: () => () => undefined,
    present: vi.fn(),
    publish: vi.fn(),
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  };
  const engine = createNativeVodEngine(vi.fn(), host, { live: true });
  return {
    engine,
    host,
    requests,
    status,
    tick: () => tick?.(),
    setTelemetry: (value: LiveBufferTelemetry | undefined) => {
      telemetry = value;
    },
    intercept: (fn: NonNullable<typeof intercept>) => {
      intercept = fn;
    },
  };
}

describe('native runtime buffer capability', () => {
  it('carries saved target into the one open and applies arrows/Auto without other player commands', async () => {
    const f = fixture();
    await f.engine.start(
      { ...selection, liveBuffer: { mode: 'manual', targetSeconds: 6 } },
      signal(),
    );
    expect(f.requests[0]).toMatchObject({
      action: 'open',
      liveBuffer: { mode: 'manual', targetSeconds: 6 },
    });
    expect(f.engine.readLiveBuffer?.()).toMatchObject({
      mode: 'manual',
      targetSeconds: 6,
      incomingBitsPerSecond: 8000,
      bufferedSeconds: 3.5,
    });
    expect(await f.engine.setLiveBuffer?.({ mode: 'manual', targetSeconds: 12 })).toBe(true);
    expect(await f.engine.setLiveBuffer?.({ mode: 'manual', targetSeconds: 1 })).toBe(true);
    expect(await f.engine.setLiveBuffer?.({ mode: 'auto' })).toBe(true);
    expect(f.requests.map((r) => r.action)).toEqual(['open', 'buffer', 'buffer', 'buffer']);
    expect(new Set(f.requests.map((r) => r.session)).size).toBe(1);
    expect(f.engine.readLiveBuffer?.()).toMatchObject({ mode: 'auto', targetSeconds: null });
    await f.engine.dispose();
  });

  it('refuses unsupported hosts and malformed target without a command', async () => {
    const f = fixture();
    f.setTelemetry(undefined);
    await f.engine.start(selection, signal());
    expect(f.engine.readLiveBuffer?.()).toBeNull();
    expect(await f.engine.setLiveBuffer?.({ mode: 'manual', targetSeconds: 3 })).toBe(false);
    expect(f.requests.map((r) => r.action)).toEqual(['open']);
    await f.engine.dispose();
    const g = fixture();
    await g.engine.start(selection, signal());
    for (const value of [0, 21, 2.5, NaN])
      expect(await g.engine.setLiveBuffer?.({ mode: 'manual', targetSeconds: value })).toBe(false);
    expect(g.requests.map((r) => r.action)).toEqual(['open']);
    await g.engine.dispose();
  });

  it('does not let a pre-edit held poll replace the acknowledged target', async () => {
    const f = fixture();
    await f.engine.start(selection, signal());
    const held = deferred<NativeVideoStatus>();
    const old = f.status();
    f.intercept((request) => (request.action === 'status' ? held.promise : null));
    f.tick();
    await Promise.resolve();
    expect(await f.engine.setLiveBuffer?.({ mode: 'manual', targetSeconds: 9 })).toBe(true);
    held.resolve(old);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.engine.readLiveBuffer?.()).toMatchObject({ mode: 'manual', targetSeconds: 9 });
    await f.engine.dispose();
  });

  it('ignores superseded buffer acknowledgements and disposed/wrong-session responses', async () => {
    const f = fixture();
    await f.engine.start(selection, signal());
    const held = deferred<NativeVideoStatus>();
    const first = f.status(manual(3));
    f.intercept((request) =>
      request.action === 'buffer' &&
      request.liveBuffer?.mode === 'manual' &&
      request.liveBuffer.targetSeconds === 3
        ? held.promise
        : null,
    );
    const older = f.engine.setLiveBuffer!({ mode: 'manual', targetSeconds: 3 });
    expect(await f.engine.setLiveBuffer!({ mode: 'manual', targetSeconds: 8 })).toBe(true);
    held.resolve(first);
    expect(await older).toBe(false);
    expect(f.engine.readLiveBuffer?.()).toMatchObject({ targetSeconds: 8 });
    f.intercept((request) =>
      request.action === 'buffer' ? Promise.resolve(f.status(manual(7), 999999)) : null,
    );
    expect(await f.engine.setLiveBuffer!({ mode: 'manual', targetSeconds: 7 })).toBe(false);
    expect(f.engine.readLiveBuffer?.()).toMatchObject({ targetSeconds: 8 });
    const closing = deferred<NativeVideoStatus>();
    f.intercept((r) => (r.action === 'buffer' ? closing.promise : null));
    const pending = f.engine.setLiveBuffer!({ mode: 'manual', targetSeconds: 4 });
    await f.engine.dispose();
    closing.resolve(f.status(manual(4)));
    expect(await pending).toBe(false);
    expect(f.engine.readLiveBuffer?.()).toBeNull();
  });

  it('forwards the public-live wrapper capability while retaining its relay/session', async () => {
    const f = fixture();
    const relay = {
      open: vi.fn(async () => ({ session: 71, url: selection.url })),
      renew: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const engine = createNativeLiveEngine(vi.fn(), f.host, relay, () => true);
    await engine.start(selection, signal());
    expect(engine.readLiveBuffer?.()).toMatchObject({ capability: 'controlled' });
    expect(await engine.setLiveBuffer?.({ mode: 'manual', targetSeconds: 5 })).toBe(true);
    expect(relay.open).toHaveBeenCalledTimes(1);
    expect(relay.close).not.toHaveBeenCalled();
    expect(f.requests.map((r) => r.action)).toEqual(['open', 'buffer']);
    await engine.dispose();
    expect(engine.readLiveBuffer?.()).toBeNull();
    expect(relay.close).toHaveBeenCalledWith(71);
  });

  it('validates closed numeric bridge telemetry and preserves real zero/unknown separately', () => {
    const f = fixture();
    const good = { ...f.status(), session: 5 };
    expect(
      validateNativeVideoStatus({ ...good, liveBuffer: { ...AUTO, incomingBitsPerSecond: 0 } }, 5)
        .liveBuffer?.incomingBitsPerSecond,
    ).toBe(0);
    expect(
      validateNativeVideoStatus(
        { ...good, liveBuffer: { ...AUTO, incomingBitsPerSecond: null, bufferedSeconds: null } },
        5,
      ).liveBuffer?.incomingBitsPerSecond,
    ).toBeNull();
    for (const bad of [
      { ...AUTO, incomingBitsPerSecond: Infinity },
      { ...AUTO, bufferedSeconds: -1 },
      { ...AUTO, targetSeconds: 21 },
      { ...AUTO, capability: 'pretend' },
    ])
      expect(() => validateNativeVideoStatus({ ...good, liveBuffer: bad }, 5)).toThrow();
  });
});
