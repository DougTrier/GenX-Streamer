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

import { describe, expect, it } from 'vitest';
import {
  createNativeLiveEngine,
  LIVE_RELAY_RENEW_MS,
  type NativeLiveRelay,
} from '../../src/playback/native-live-engine';
import { createRoutingEngineFactory, accountOnDemand } from '../../src/playback/routing-engine';
import type { NativeVideoRequest, NativeVideoStatus } from '../../src/platform/native-video';
import type { EngineEvent, PlaybackEngine } from '../../src/playback/controller';

const LIVE = `http://127.0.0.1:41000/media/${'c'.repeat(64)}`;
const channel = { id: 'acc', name: 'ACC Network', url: 'http://23.239.31.26:8989/acc/index.m3u8' };

function relayFixture() {
  const calls: string[] = [];
  let sessions = 0;
  const relay: NativeLiveRelay = {
    open: async (url, allowHttp) => {
      calls.push(`open ${url} ${allowHttp}`);
      return { session: ++sessions, url: LIVE };
    },
    renew: async (session) => void calls.push(`renew ${session}`),
    close: async (session) => void calls.push(`close ${session}`),
  };
  return { relay, calls };
}
function host(requests: NativeVideoRequest[], timers: Map<number, () => void>) {
  let next = 0;
  return {
    bridge: async (request: NativeVideoRequest): Promise<NativeVideoStatus> => {
      requests.push(request);
      return {
        session: request.session,
        state: 'ready',
        playing: true,
        positionMs: 1000,
        durationMs: -1,
        audio: [],
        text: [],
      };
    },
    rect: () => [0, 0, 1920, 1080] as [number, number, number, number],
    watchRect: () => () => undefined,
    present: () => undefined,
    publish: () => undefined,
    setInterval: (callback: () => void, ms: number) => {
      const id = ++next * 100_000 + ms;
      timers.set(id, callback);
      return id;
    },
    clearInterval: (handle: unknown) => void timers.delete(handle as number),
  };
}

describe('native live engine', () => {
  it('plays the channel through GenX’s loopback relay as HLS and keeps the relay leased', async () => {
    const { relay, calls } = relayFixture();
    const requests: NativeVideoRequest[] = [];
    const timers = new Map<number, () => void>();
    const events: EngineEvent[] = [];
    const engine = createNativeLiveEngine(
      (event) => events.push(event),
      host(requests, timers),
      relay,
      () => true,
    );
    await engine.start(channel, new AbortController().signal);
    expect(calls[0]).toBe(`open ${channel.url} true`);
    expect(requests[0]).toMatchObject({ action: 'open', url: LIVE, hls: true });
    expect(events).toContainEqual({ type: 'progress' });
    // A retry must start again as HLS, never as a plain media file.
    expect(events).toContainEqual({ type: 'capability', mediaKind: 'hls' });
    const renewal = [...timers].find(([id]) => id % 100_000 === LIVE_RELAY_RENEW_MS);
    expect(renewal).toBeDefined();
    renewal![1]();
    expect(calls).toContain('renew 1');
    await engine.dispose();
    expect(requests.at(-1)).toMatchObject({ action: 'close' });
    expect(calls.at(-1)).toBe('close 1');
    expect(timers.size).toBe(0);
  });

  it('closes the relay when the start is canceled after it opened', async () => {
    const { relay, calls } = relayFixture();
    const abort = new AbortController();
    const engine = createNativeLiveEngine(
      () => undefined,
      host([], new Map()),
      relay,
      () => false,
    );
    const opening = relay.open;
    relay.open = async (url, allowHttp) => {
      const opened = await opening(url, allowHttp);
      abort.abort();
      return opened;
    };
    await expect(engine.start(channel, abort.signal)).rejects.toThrow();
    expect(calls).toEqual([`open ${channel.url} false`, 'close 1']);
  });
});

describe('MPEG-2 handover', () => {
  const mpeg2 = {
    type: 'error' as const,
    failure: {
      code: 'unsupported' as const,
      message: 'MPEG-2',
      retryable: false,
      nativeFormat: 'mpeg2' as const,
    },
  };
  function engines() {
    const log: string[] = [];
    let webEmit: ((event: EngineEvent) => void) | null = null;
    let rejectWeb: ((error: Error) => void) | null = null;
    const web = (emit: (event: EngineEvent) => void) => {
      webEmit = emit;
      return {
        start: () =>
          new Promise<void>((_, reject) => {
            log.push('web start');
            rejectWeb = reject;
          }),
        pause: () => undefined,
        resume: async () => undefined,
        setMuted: (muted: boolean) => void log.push(`web muted ${muted}`),
        setVolume: () => undefined,
        dispose: () => void log.push('web dispose'),
      } as PlaybackEngine;
    };
    const live = () =>
      ({
        start: async () => void log.push('live start'),
        pause: () => undefined,
        resume: async () => undefined,
        setMuted: (muted: boolean) => void log.push(`live muted ${muted}`),
        setVolume: () => undefined,
        dispose: () => void log.push('live dispose'),
      }) as PlaybackEngine;
    return {
      log,
      web,
      live,
      emitFromWeb: (event: EngineEvent) => webEmit!(event),
      failWebStart: () => rejectWeb!(new Error('released')),
    };
  }

  it('a live MPEG-2 channel moves to the device’s player without an error', async () => {
    const e = engines();
    const events: EngineEvent[] = [];
    const routed = createRoutingEngineFactory(
      e.web,
      null,
      accountOnDemand,
      e.live,
    )((event) => events.push(event));
    routed.setMuted(true);
    const starting = routed.start(channel, new AbortController().signal);
    e.emitFromWeb(mpeg2);
    e.failWebStart();
    await starting;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(e.log).toEqual([
      'web muted true',
      'web start',
      'live muted true',
      'web dispose',
      'live start',
    ]);
    expect(events).toEqual([]);
    // Only once per attempt: a second report reaches the controller.
    e.emitFromWeb(mpeg2);
    expect(events).toEqual([mpeg2]);
    await routed.dispose();
    expect(e.log.at(-1)).toBe('live dispose');
  });

  it('without a device player (Windows) the controller gets the clear message', async () => {
    const e = engines();
    const events: EngineEvent[] = [];
    const routed = createRoutingEngineFactory(
      e.web,
      null,
      accountOnDemand,
      null,
    )((event) => events.push(event));
    void routed.start(channel, new AbortController().signal).catch(() => undefined);
    e.emitFromWeb(mpeg2);
    expect(events).toEqual([mpeg2]);
    expect(e.log).not.toContain('live start');
  });

  it('on-demand videos and other failures never move', async () => {
    const e = engines();
    const events: EngineEvent[] = [];
    const routed = createRoutingEngineFactory(
      e.web,
      null,
      () => false,
      e.live,
    )((event) => events.push(event));
    void routed
      .start({ ...channel, playMode: 'on-demand' }, new AbortController().signal)
      .catch(() => undefined);
    e.emitFromWeb(mpeg2);
    const other = {
      type: 'error' as const,
      failure: { ...mpeg2.failure, nativeFormat: undefined },
    };
    e.emitFromWeb(other);
    expect(events).toEqual([mpeg2, other]);
    expect(e.log).not.toContain('live start');
  });
});

describe('sound the device cannot decode', () => {
  it('says once that the channel plays without sound', async () => {
    const { relay } = relayFixture();
    const base = host([], new Map());
    let silent = 0;
    const engine = createNativeLiveEngine(
      () => undefined,
      {
        ...base,
        bridge: async (request) => ({
          ...(await base.bridge(request)),
          audio: [{ id: '1:0', label: '', language: 'en', selected: false, supported: false }],
        }),
      },
      relay,
      () => true,
      () => silent++,
    );
    await engine.start(channel, new AbortController().signal);
    expect(silent).toBe(1);
    await engine.dispose();
  });
});

describe('a picture the device cannot decode', () => {
  // Galaxy S25, October 19, 2026: MPEG-2 channels played as sound over black.
  it('says once that the picture cannot be shown, and never for a shown picture', async () => {
    for (const [picture, expected] of [
      ['unsupported', 1],
      ['shown', 0],
      [undefined, 0],
    ] as const) {
      const { relay } = relayFixture();
      const base = host([], new Map());
      let unsupported = 0;
      const engine = createNativeLiveEngine(
        () => undefined,
        {
          ...base,
          bridge: async (request) => ({
            ...(await base.bridge(request)),
            ...(picture ? { picture } : {}),
          }),
        },
        relay,
        () => true,
        () => undefined,
        () => unsupported++,
      );
      await engine.start(channel, new AbortController().signal);
      expect(unsupported, String(picture)).toBe(expected);
      await engine.dispose();
    }
  });
});
