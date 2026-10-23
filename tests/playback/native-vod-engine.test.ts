import { describe, expect, it } from 'vitest';
import { createNativeVodEngine, nativeAudioSnapshot } from '../../src/playback/native-vod-engine';
import { accountOnDemand, createRoutingEngineFactory } from '../../src/playback/routing-engine';
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
  let error: NativeVideoStatus['error'];
  let audio = [english, spanish];
  const status = (session: number): NativeVideoStatus => ({
    session,
    state,
    playing: state === 'ready',
    positionMs: position,
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
      error?: NativeVideoStatus['error'];
    }) {
      if (next.state) state = next.state;
      if (next.position !== undefined) position = next.position;
      error = next.error;
    },
    get polling() {
      return tick !== null;
    },
  };
}

describe('native on-demand engine', () => {
  it('opens the relay address at the picture, then reports buffering and progress', async () => {
    const f = fixture();
    await f.engine.start(movie, new AbortController().signal);
    expect(f.requests[0]).toMatchObject({ action: 'open', url: RELAY, rect: [100, 50, 1280, 720] });
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
