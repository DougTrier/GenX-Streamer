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

import { describe, expect, it, vi } from 'vitest';
import { createNativeVodEngine, nativeAudioSnapshot } from '../../src/playback/native-vod-engine';
import {
  accountOnDemand,
  nativePlaybackSelection,
  createRoutingEngineFactory,
} from '../../src/playback/routing-engine';
import {
  createNativeVideoBridge,
  validateNativeVideoStatus,
  type NativeVideoRequest,
  type NativeVideoStatus,
} from '../../src/platform/native-video';
import type { EngineEvent, PlaybackEngine } from '../../src/playback/controller';

const RELAY = `http://127.0.0.1:41234/account/${'a'.repeat(64)}/media/${'b'.repeat(64)}`;
const movie = { id: 'vod:movie:101', name: 'Movie', url: RELAY, playMode: 'on-demand' as const };
const english = {
  id: '1:0',
  label: '',
  language: 'en',
  selected: true,
  supported: true,
  channels: 6,
};
const spanish = {
  id: '1:1',
  label: 'Castellano',
  language: 'es',
  selected: false,
  supported: true,
  channels: 2,
};
const subtitles = { id: '2:0', label: '', language: 'fr', selected: false, supported: true };

/** Records each command and answers like the native player would. */
function fixture() {
  const requests: NativeVideoRequest[] = [];
  let state: NativeVideoStatus['state'] = 'buffering';
  let position = 0;
  let streamMs: number | undefined;
  let metrics: Partial<NativeVideoStatus> = {};
  let error: NativeVideoStatus['error'];
  let audio = [english, spanish];
  const status = (session: number): NativeVideoStatus => ({
    ...metrics,
    session,
    state,
    playing: state === 'ready',
    positionMs: position,
    ...(streamMs !== undefined ? { streamMs } : {}),
    durationMs: 7_200_000,
    ...(error ? { error } : {}),
    audio,
    text: [subtitles],
  });
  const bridge = async (request: NativeVideoRequest) => {
    requests.push(request);
    if (request.action === 'audio')
      audio = audio.map((track) => ({ ...track, selected: track.id === request.track }));
    return status(request.session);
  };
  let tick: (() => void) | null = null;
  const presented: boolean[] = [];
  const published: unknown[] = [];
  const events: EngineEvent[] = [];
  let watching = 0;
  const engine = createNativeVodEngine((event) => events.push(event), {
    bridge,
    rect: () => [100, 50, 1280, 720],
    watchRect: () => {
      watching++;
      return () => watching--;
    },
    present: (on) => presented.push(on),
    publish: (tracks) => published.push(tracks),
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => {
      tick = null;
    },
  });
  return {
    engine,
    requests,
    events,
    presented,
    published,
    get watching() {
      return watching;
    },
    async poll() {
      tick?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    set(next: {
      state?: NativeVideoStatus['state'];
      position?: number;
      streamMs?: number;
      metrics?: Partial<NativeVideoStatus>;
      error?: NativeVideoStatus['error'];
    }) {
      if (next.metrics) metrics = next.metrics;
      if (next.state) state = next.state;
      if (next.position !== undefined) position = next.position;
      if (next.streamMs !== undefined) streamMs = next.streamMs;
      error = next.error;
    },
    get polling() {
      return tick !== null;
    },
  };
}

describe('native on-demand engine', () => {
  it('retains observed HTTP status and distinguishes access from retryable network failures', async () => {
    for (const [error, httpStatus, retryable] of [
      ['access', 403, false],
      ['network', 502, true],
    ] as const) {
      const f = fixture();
      await f.engine.start(movie, new AbortController().signal);
      f.set({ state: 'error', error, metrics: { httpStatus } });
      await f.poll();
      expect(f.events.find((e) => e.type === 'error')).toMatchObject({
        failure: { code: error, httpStatus, phase: 'headers', retryable },
      });
      await f.engine.dispose();
    }
  });
  it('Paid live channels retain their account session and select HLS or TS without another relay', async () => {
    for (const kind of ['hls', 'media'] as const) {
      const f = fixture();
      await f.engine.start(
        { id: 'account-channel', name: 'Paid live', url: RELAY, mediaKind: kind },
        new AbortController().signal,
      );
      expect(f.requests[0]).toMatchObject({
        action: 'open',
        url: RELAY,
        accountLive: true,
        hls: kind === 'hls',
      });
      expect(f.requests[0]?.archive).toBeUndefined();
      expect(f.events[0]).toEqual({ type: 'capability', mediaKind: kind });
      await f.engine.dispose();
      expect(f.requests.at(-1)?.action).toBe('close');
    }
  });
  it('tags GenXtra for native-side session admission and retains progress/cleanup', async () => {
    const f = fixture();
    await f.engine.start(
      {
        ...movie,
        id: 'archive-file',
        url: `http://127.0.0.1:41234/archive/${'a'.repeat(64)}/${'b'.repeat(64)}.mp4`,
      },
      new AbortController().signal,
    );
    expect(f.requests[0]).toMatchObject({ action: 'open', archive: true });
    expect(f.requests[0]?.hls).toBeUndefined();
    f.set({ state: 'ready', position: 12_000 });
    await f.poll();
    expect(f.engine.readVODposition!()).toBe(12);
    await f.engine.dispose();
    expect(f.requests.at(-1)?.action).toBe('close');
    expect(f.watching).toBe(0);
    expect(f.polling).toBe(false);
  });
  it('publishes actual native decoded frame evidence and live-window recovery counters', async () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const f = fixture();
    try {
      await f.engine.start(
        { id: 'account-live', name: 'Live', url: RELAY },
        new AbortController().signal,
      );
      now.mockReturnValue(1000);
      f.set({
        state: 'ready',
        position: 1000,
        streamMs: 80000,
        metrics: {
          renderedFrames: 60,
          audioRenderedFrames: 10,
          videoWidth: 1280,
          videoHeight: 720,
          liveWindowRecoveries: 0,
        },
      });
      await f.poll();
      now.mockReturnValue(2000);
      f.set({
        position: 0,
        streamMs: 81000,
        metrics: {
          renderedFrames: 120,
          audioRenderedFrames: 20,
          videoWidth: 1280,
          videoHeight: 720,
          liveWindowRecoveries: 0,
        },
      });
      await f.poll();
      expect(f.events.filter((e) => e.type === 'decoded-progress')).toHaveLength(1);
      expect(f.events.find((e) => e.type === 'decoded-progress')).toMatchObject({
        evidence: {
          elapsedMilliseconds: 1000,
          after: {
            mediaTime: 81,
            decodedFrames: 120,
            width: 1280,
            height: 720,
            audioObserved: true,
          },
        },
      });
      f.set({ metrics: { liveWindowRecoveries: 1 } });
      await f.poll();
      await f.poll();
      expect(f.events.filter((e) => e.type === 'source-recovery')).toEqual([
        { type: 'source-recovery', cause: 'live-window' },
      ]);
    } finally {
      await f.engine.dispose();
      now.mockRestore();
    }
  });

  it('uses absolute live progress when a sliding window clamps or moves relative positions', async () => {
    const f = fixture();
    await f.engine.start(
      { id: 'account-live', name: 'Live', url: RELAY },
      new AbortController().signal,
    );
    f.set({ state: 'ready', position: 5000, streamMs: 80000 });
    await f.poll();
    f.set({ position: 0, streamMs: 81000 });
    await f.poll();
    f.set({ position: 0, streamMs: 82000 });
    await f.poll();
    expect(f.events.filter((event) => event.type === 'progress')).toHaveLength(3);
    // A moving window-relative coordinate cannot conceal a frozen stream position.
    f.set({ position: 1000, streamMs: 82000 });
    await f.poll();
    expect(f.events.filter((event) => event.type === 'progress')).toHaveLength(3);
    await f.engine.dispose();
  });

  it('opens the relay address at the picture, then reports buffering and progress', async () => {
    const f = fixture();
    await f.engine.start(movie, new AbortController().signal);
    expect(f.requests[0]).toMatchObject({ action: 'open', url: RELAY, rect: [100, 50, 1280, 720] });
    expect(f.requests[0]?.archive).toBeUndefined();
    expect(f.presented).toEqual([true]);
    expect(f.events.map((e) => e.type)).toEqual(['capability', 'audio-tracks', 'buffering']);
    f.set({ state: 'ready', position: 1000 });
    await f.poll();
    f.set({ position: 1500 });
    await f.poll();
    await f.poll(); // no advance, no progress
    expect(f.events.filter((e) => e.type === 'progress')).toHaveLength(2);
    expect(f.engine.readVODposition!()).toBe(1.5);
    expect(f.engine.readVODduration!()).toBe(7200);
  });

  it('publishes the embedded audio and subtitles and switches them', async () => {
    const f = fixture();
    await f.engine.start(movie, new AbortController().signal);
    expect(f.published.at(-1)).toEqual({ audio: [english, spanish], text: [subtitles] });
    const snapshot = f.engine.readAudioTracks!()!;
    expect(snapshot.source).toBe('native');
    expect(snapshot.tracks.map((t) => [t.id, t.language, t.selected, t.description])).toEqual([
      ['1:0', 'en', true, '6 ch'],
      ['1:1', 'es', false, '2 ch'],
    ]);
    expect(f.engine.setAudioTrack!('1:1')).toBe(true);
    expect(f.engine.setAudioTrack!('9:9')).toBe(false);
    await f.poll();
    expect(f.requests.some((r) => r.action === 'audio' && r.track === '1:1')).toBe(true);
    expect(f.engine.readAudioTracks!()!.tracks[1]!.selected).toBe(true);
  });

  it('a native failure reaches the controller with a fixed code and stops reading', async () => {
    const f = fixture();
    await f.engine.start(movie, new AbortController().signal);
    f.set({ state: 'error', error: 'unsupported' });
    await f.poll();
    const failure = f.events.find((e) => e.type === 'error');
    expect(failure).toMatchObject({
      failure: { code: 'unsupported', retryable: false, evidence: 'native' },
    });
    expect(f.polling).toBe(false);
  });

  it('the end of the movie is reported once', async () => {
    const f = fixture();
    await f.engine.start(movie, new AbortController().signal);
    f.set({ state: 'ended' });
    await f.poll();
    await f.poll();
    expect(f.events.filter((e) => e.type === 'ended')).toHaveLength(1);
  });

  it('seek, pause, volume and dispose reach the native player; dispose clears the page hole', async () => {
    const f = fixture();
    f.engine.setMuted(true);
    await f.engine.start(movie, new AbortController().signal);
    expect(await f.engine.seekVOD!(600, new AbortController().signal)).toBe('seeked');
    expect(await f.engine.seekVOD!(99_999, new AbortController().signal)).toBe('out-of-range');
    f.engine.pause();
    await f.engine.resume();
    await f.engine.dispose();
    const actions = f.requests.map((r) => r.action);
    expect(actions).toEqual(['open', 'volume', 'seek', 'pause', 'play', 'close']);
    expect(f.requests.find((r) => r.action === 'volume')!.volume).toBe(0);
    expect(f.requests.find((r) => r.action === 'seek')!.positionMs).toBe(600_000);
    expect(f.presented).toEqual([true, false]);
    expect(f.published.at(-1)).toBeNull();
    expect(f.watching).toBe(0);
    expect(f.polling).toBe(false);
  });

  it('every command names its own session', async () => {
    const one = fixture();
    const two = fixture();
    await one.engine.start(movie, new AbortController().signal);
    await two.engine.start(movie, new AbortController().signal);
    expect(two.requests[0]!.session).toBeGreaterThan(one.requests[0]!.session);
  });
});

describe('engine routing', () => {
  it('GenXtra goes native only for the explicit Fire OS capability; Paid TV keeps its native route', () => {
    const archive = { ...movie, id: 'archive-file' };
    expect(nativePlaybackSelection(archive, true)).toBe(true);
    expect(nativePlaybackSelection(archive, false)).toBe(false);
    expect(nativePlaybackSelection(movie, false)).toBe(true);
    expect(nativePlaybackSelection({ ...movie, id: 'vod:episode:7' }, true)).toBe(true);
    expect(nativePlaybackSelection({ ...archive, playMode: undefined }, true)).toBe(false);
    expect(
      nativePlaybackSelection({ id: 'account-channel', name: 'Paid live', url: RELAY }, true),
    ).toBe(true);
    expect(
      nativePlaybackSelection({ id: 'account-channel', name: 'Paid live', url: RELAY }, false),
    ).toBe(false);
  });
  const recorder = (name: string, log: string[]) => () =>
    ({
      start: async () => void log.push(name),
      pause: () => undefined,
      resume: async () => undefined,
      setMuted: () => undefined,
      setVolume: () => undefined,
      dispose: () => undefined,
    }) as PlaybackEngine;
  it('only Paid TV movies and episodes go to the native player', async () => {
    const log: string[] = [];
    const factory = createRoutingEngineFactory(
      recorder('web', log),
      recorder('native', log),
      accountOnDemand,
    );
    for (const selection of [
      movie,
      { ...movie, id: 'vod:episode:7' },
      { id: 'channel-1', name: 'Live', url: RELAY },
      {
        id: 'archive:abc',
        name: 'GenXtra',
        url: 'https://archive.invalid/a.mp4',
        playMode: 'on-demand' as const,
      },
    ])
      await factory(() => undefined).start(selection, new AbortController().signal);
    expect(log).toEqual(['native', 'native', 'web', 'web']);
  });
  it('without a native player everything stays on the web player', async () => {
    const log: string[] = [];
    await createRoutingEngineFactory(
      recorder('web', log),
      null,
      accountOnDemand,
    )(() => undefined).start(movie, new AbortController().signal);
    expect(log).toEqual(['web']);
  });
});

describe('native player replies', () => {
  it('admits only the asked session and fixed values', async () => {
    const good = {
      session: 3,
      state: 'ready',
      playing: true,
      positionMs: 10,
      durationMs: -1,
      audio: [english],
      text: [],
    };
    expect(validateNativeVideoStatus(good, 3).state).toBe('ready');
    expect(
      validateNativeVideoStatus({ ...good, state: 'error', error: 'access', httpStatus: 403 }, 3),
    ).toMatchObject({ error: 'access', httpStatus: 403 });
    expect(validateNativeVideoStatus({ ...good, picture: 'unsupported' }, 3).picture).toBe(
      'unsupported',
    );
    for (const bad of [
      { ...good, picture: 'black' },
      { ...good, session: 2 },
      { ...good, state: 'hacked' },
      { ...good, error: 'Connection refused by provider.invalid' },
      { ...good, audio: [{ ...english, id: '<b>' }] },
      { ...good, positionMs: -5 },
      { ...good, httpStatus: 600 },
      { ...good, httpStatus: 99 },
      { ...good, renderedFrames: -1 },
    ])
      expect(() => validateNativeVideoStatus(bad, 3)).toThrow();
    const bridge = createNativeVideoBridge(async () => good);
    await expect(bridge({ action: 'status', session: 3 })).resolves.toMatchObject({
      playing: true,
    });
    await expect(bridge({ action: 'close', session: 3 })).resolves.toMatchObject({
      state: 'closed',
    });
  });
  it('an audio snapshot is null without tracks', () => {
    expect(nativeAudioSnapshot([])).toBeNull();
  });
});
