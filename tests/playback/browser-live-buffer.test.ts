/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createBrowserEngine } from '../../src/platform/browser-engine';
import { learnedLiveBuffer, liveBufferIdentity } from '../../src/playback/adaptive-buffer';
import { type PlaybackEngine } from '../../src/playback/controller';
import { Video, played, selection } from './browser-engine.fixture';

const mocked = vi.hoisted(() => ({
  owners: [] as Array<{
    config: { maxBufferLength: number; maxMaxBufferLength: number };
    handlers: Map<string, (name: string, data: unknown) => void>;
    loadSource: ReturnType<typeof vi.fn>;
    startLoad: ReturnType<typeof vi.fn>;
    stopLoad: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock('hls.js', () => ({
  default: class {
    static Events = {
      ERROR: 'error',
      MANIFEST_PARSED: 'manifest',
      LEVEL_SWITCHED: 'level',
      FRAG_BUFFERED: 'fragment',
      MANIFEST_LOADED: 'manifest-loaded',
      LEVEL_LOADED: 'level-loaded',
      FRAG_LOADED: 'fragment-loaded',
      AUDIO_TRACKS_UPDATED: 'audio-tracks',
      AUDIO_TRACK_SWITCHED: 'audio-switched',
      BUFFER_CODECS: 'buffer-codecs',
      BUFFER_CREATED: 'buffer-created',
    };
    static ErrorTypes = { MEDIA_ERROR: 'mediaError' };
    static isSupported = () => true;
    handlers = new Map();
    destroy = vi.fn();
    startLoad = vi.fn();
    stopLoad = vi.fn();
    constructor(public config: { maxBufferLength: number; maxMaxBufferLength: number }) {
      mocked.owners.push(this);
    }
    on(name: string, fn: (name: string, data: unknown) => void) {
      this.handlers.set(name, fn);
    }
    off(name: string) {
      this.handlers.delete(name);
    }
    attachMedia() {}
    loadSource = vi.fn(() => this.handlers.get('manifest')?.('manifest', {}));
  },
}));
const engines: PlaybackEngine[] = [];
beforeEach(() => mocked.owners.splice(0));
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.dispose();
  learnedLiveBuffer.set(liveBufferIdentity(selection), 0);
  vi.useRealTimers();
});
function videoFixture() {
  const video = new Video();
  Object.assign(video, { buffered: { length: 1, start: () => 0, end: () => 8 } });
  return video;
}

it('changes HLS forward targets live and restores Auto without retuning or pausing', async () => {
  vi.useFakeTimers();
  const video = videoFixture();
  const engine = createBrowserEngine(video.element, () => {});
  engines.push(engine);
  await engine.start(
    { ...selection, liveBuffer: { mode: 'manual', targetSeconds: 7 } },
    new AbortController().signal,
  );
  const owner = mocked.owners[0];
  expect(owner.config.maxBufferLength).toBe(7);
  expect(owner.config.maxMaxBufferLength).toBe(7);
  expect(engine.setLiveBuffer?.({ mode: 'manual', targetSeconds: 12 })).toBe(true);
  expect(owner.config.maxBufferLength).toBe(12);
  expect(owner.config.maxMaxBufferLength).toBe(12);
  expect(engine.readLiveBuffer?.()).toMatchObject({
    targetSeconds: 12,
    mode: 'manual',
    capability: 'controlled',
    bufferedSeconds: 8,
  });
  expect(video.pause).not.toHaveBeenCalled();
  expect(video.play).toHaveBeenCalledOnce();
  expect(owner.loadSource).toHaveBeenCalledOnce();
  expect(video.currentTime).toBe(0);
  played(video);
  video.dispatchEvent(new Event('waiting'));
  expect(engine.readLiveBuffer?.()?.targetSeconds).toBe(12);
  expect(learnedLiveBuffer.get(liveBufferIdentity(selection))).toBe(0);
  expect(engine.setLiveBuffer?.({ mode: 'auto' })).toBe(true);
  expect(engine.readLiveBuffer?.()).toMatchObject({ targetSeconds: 3, mode: 'auto' });
  expect(owner.config.maxBufferLength).toBe(20);
  expect(owner.config.maxMaxBufferLength).toBe(40);
});

it('measures successful HLS payload over wall time and marks paused/stale input unknown', async () => {
  let now = 1000;
  const video = videoFixture();
  const engine = createBrowserEngine(video.element, () => {}, undefined, {
    monotonicNow: () => now,
  });
  engines.push(engine);
  const signal = new AbortController();
  await engine.start(selection, signal.signal);
  expect(engine.readLiveBuffer?.()?.incomingBitsPerSecond).toBeNull();
  mocked.owners[0].handlers.get('fragment-loaded')?.('fragment-loaded', {
    frag: {
      type: 'main',
      duration: 6,
      stats: { loaded: 1000, loading: { start: 900, first: 920, end: 1000 } },
    },
  });
  expect(engine.readLiveBuffer?.()?.incomingBitsPerSecond).toBe(80_000);
  now = 2000;
  expect(engine.readLiveBuffer?.()?.incomingBitsPerSecond).toBeCloseTo(8000 / 1.1);
  now = 13_001;
  expect(engine.readLiveBuffer?.()?.incomingBitsPerSecond).toBeNull();
  engine.pause();
  expect(engine.readLiveBuffer?.()?.incomingBitsPerSecond).toBeNull();
  signal.abort();
  expect(engine.readLiveBuffer?.()).toBeNull();
  expect(engine.setLiveBuffer?.({ mode: 'manual', targetSeconds: 8 })).toBe(false);
});

it('converts actual MPEGTS KiB/s samples and updates its hold target without rebuilding', async () => {
  let now = 1000;
  const handlers = new Map<string, (value: unknown) => void>();
  const player = {
    on: (name: string, fn: (value: unknown) => void) => handlers.set(name, fn),
    pause: vi.fn(),
    unload: vi.fn(),
    detachMediaElement: vi.fn(),
    destroy: vi.fn(),
    attachMediaElement: vi.fn(),
    load: vi.fn(),
  };
  const library = {
    isSupported: () => true,
    getFeatureList: () => ({ mseLivePlayback: true }),
    createPlayer: vi.fn(() => player),
    Events: { ERROR: 'error', MEDIA_INFO: 'info', STATISTICS_INFO: 'stats' },
  };
  const video = videoFixture();
  const engine = createBrowserEngine(video.element, () => {}, undefined, {
    monotonicNow: () => now,
    loadMpegts: async () => library as unknown as typeof import('mpegts.js').default,
  });
  engines.push(engine);
  await engine.start(
    {
      ...selection,
      url: 'https://example.test/live.ts',
      mediaKind: 'media',
      mediaMime: 'video/mp2t',
    },
    new AbortController().signal,
  );
  handlers.get('stats')?.({ speed: 128 });
  expect(engine.readLiveBuffer?.()?.incomingBitsPerSecond).toBe(1_048_576);
  expect(engine.setLiveBuffer?.({ mode: 'manual', targetSeconds: 10 })).toBe(true);
  expect(engine.readLiveBuffer?.()).toMatchObject({
    targetSeconds: 10,
    mode: 'manual',
    bufferedSeconds: 8,
  });
  expect(library.createPlayer).toHaveBeenCalledOnce();
  expect(player.load).toHaveBeenCalledOnce();
  expect(video.play).toHaveBeenCalledOnce();
  expect(video.pause).not.toHaveBeenCalled();
  handlers.get('stats')?.({ speed: 0 });
  expect(engine.readLiveBuffer?.()?.incomingBitsPerSecond).toBeNull();
  handlers.get('stats')?.({ speed: 128 });
  now += 12_001;
  expect(engine.readLiveBuffer?.()?.incomingBitsPerSecond).toBeNull();
});

it('does not claim buffer control or network measurement for an opaque native media element', async () => {
  const video = videoFixture();
  video.canPlayType = () => 'maybe';
  const engine = createBrowserEngine(video.element, () => {});
  engines.push(engine);
  await engine.start(selection, new AbortController().signal);
  expect(engine.readLiveBuffer?.()).toEqual({
    incomingBitsPerSecond: null,
    bufferedSeconds: 8,
    targetSeconds: null,
    mode: 'auto',
    capability: 'observe-only',
  });
  expect(engine.setLiveBuffer?.({ mode: 'manual', targetSeconds: 8 })).toBe(false);
});

it('reports actual finite-element buffering without pretending to control its cache', async () => {
  const video = videoFixture();
  video.canPlayType = () => 'maybe';
  const engine = createBrowserEngine(video.element, () => {});
  engines.push(engine);
  await engine.start(
    { ...selection, playMode: 'on-demand', mediaKind: 'media', mediaMime: 'video/mp4' },
    new AbortController().signal,
  );
  expect(engine.readLiveBuffer?.()).toMatchObject({
    bufferedSeconds: 8,
    targetSeconds: null,
    capability: 'observe-only',
  });
  expect(engine.setLiveBuffer?.({ mode: 'manual', targetSeconds: 8 })).toBe(false);
  expect(video.play).toHaveBeenCalledOnce();
  expect(video.pause).not.toHaveBeenCalled();
});
