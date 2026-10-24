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
 * Browser engine: stream sources, HTTP permission, CORS, audio faults, and
 * live buffering.
 */
import { describe, expect, it, vi } from 'vitest';
import { PlaybackController, type EngineEvent } from '../../src/playback/controller';
import {
  MPEGTS_BACK_BUFFER,
  classifyHttpFailure,
  createBrowserEngine,
  liveBufferProfile,
  readAudioHealth,
  readRetryAfter,
} from '../../src/platform/browser-engine';
import {
  type Loader,
  type LoaderCallbacks,
  type LoaderConfiguration,
  type LoaderContext,
  type LoaderContextType,
} from 'hls.js';
import { createResourceOwners } from '../../src/playback/resource-owners';
import {
  Video,
  selection,
  stateEvents,
  profiles,
  element,
  live,
  played,
} from './browser-engine.fixture';

const mocked = vi.hoisted(() => ({
  autoManifest: true,
  owners: [] as Array<{
    config: unknown;
    destroy: ReturnType<typeof vi.fn>;
    stopLoad: ReturnType<typeof vi.fn>;
    startLoad: ReturnType<typeof vi.fn>;
    handlers: Map<string, (name: string, data: unknown) => void>;
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
    destroy = vi.fn();
    stopLoad = vi.fn();
    startLoad = vi.fn();
    handlers = new Map();
    constructor(public config: unknown) {
      mocked.owners.push(this);
    }
    on(name: string, callback: (name: string, data: unknown) => void) {
      this.handlers.set(name, callback);
    }
    off(name: string, callback: (name: string, data: unknown) => void) {
      if (this.handlers.get(name) === callback) this.handlers.delete(name);
    }
    attachMedia() {}
    loadSource() {
      if (mocked.autoManifest) this.handlers.get('manifest')?.('manifest', {});
    }
  },
}));

describe('browser adapter resource contract (mocked transport, no decoder proof)', () => {
  it('uses HLS for extensionless streams, disables library retries, and destroys on abort', async () => {
    const video = new Video();
    const events: EngineEvent[] = [];
    const signal = new AbortController();
    const engine = createBrowserEngine(video.element, (event) => events.push(event));
    await engine.start(selection, signal.signal);
    const owner = mocked.owners.at(-1)!;
    expect(owner.config).toMatchObject({
      maxBufferLength: 20,
      backBufferLength: 30,
      manifestLoadPolicy: { default: { timeoutRetry: null, errorRetry: null } },
      fragLoadPolicy: { default: { timeoutRetry: null, errorRetry: null } },
    });
    expect(stateEvents(events)).toHaveLength(0);
    video.currentTime = 1;
    video.dispatchEvent(new Event('timeupdate'));
    expect(stateEvents(events)).toEqual([{ type: 'progress' }]);
    signal.abort();
    engine.dispose();
    expect(owner.destroy).toHaveBeenCalledOnce();
    expect(video.removeAttribute).toHaveBeenCalledWith('src');
    video.currentTime = 2;
    video.dispatchEvent(new Event('timeupdate'));
    expect(stateEvents(events)).toHaveLength(1);
  });
  it('does not treat seek or stalled events as playing and catches lost live positions on resume', async () => {
    const video = new Video();
    const events: EngineEvent[] = [];
    const engine = createBrowserEngine(video.element, (event) => events.push(event));
    await engine.start(
      { ...selection, mediaKind: 'media', url: 'https://example.test/video.mp4' },
      new AbortController().signal,
    );
    video.seeking = true;
    video.currentTime = 20;
    video.dispatchEvent(new Event('timeupdate'));
    video.dispatchEvent(new Event('waiting'));
    expect(stateEvents(events)).toEqual([{ type: 'buffering' }]);
    engine.pause();
    video.seekable.length = 1;
    await engine.resume();
    expect(video.currentTime).toBe(98);
    engine.dispose();
  });
  it('keeps refusal, missing source and busy retry delay distinguishable', () => {
    expect(classifyHttpFailure(403)).toMatchObject({ code: 'access', retryable: false });
    expect(classifyHttpFailure(404)).toMatchObject({ code: 'missing', retryable: false });
    expect(classifyHttpFailure(503, '15')).toMatchObject({
      code: 'network',
      retryable: true,
      retryAfterMs: 15_000,
    });
    expect(classifyHttpFailure(503, 'Thu, 01 Jan 1970 00:00:30 GMT', 10_000).retryAfterMs).toBe(
      20_000,
    );
    expect(classifyHttpFailure(0).code).toBe('unknown');
  });
  it('rejects credentials and non-HTTP schemes without handing them to loaders', async () => {
    const video = new Video();
    const events: EngineEvent[] = [];
    const engine = createBrowserEngine(video.element, (event) => events.push(event));
    const previous = mocked.owners.length;
    await engine.start(
      { ...selection, url: 'file:///private/secret.m3u8' },
      new AbortController().signal,
    );
    expect(mocked.owners.length).toBe(previous);
    expect(stateEvents(events)[0]).toMatchObject({ type: 'error', failure: { retryable: false } });
    engine.dispose();
  });
  it('reports autoplay refusal without automatic retries or raw URLs', async () => {
    const video = new Video();
    const events: EngineEvent[] = [];
    video.play = vi.fn(async () => {
      throw new DOMException('https://private.test/token', 'NotAllowedError');
    });
    const engine = createBrowserEngine(video.element, (event) => events.push(event));
    await engine.start(
      { ...selection, mediaKind: 'media', url: 'https://example.test/video.mp4' },
      new AbortController().signal,
    );
    expect(stateEvents(events)[0]).toMatchObject({
      type: 'error',
      failure: {
        retryable: false,
        message: 'Playback was blocked. Press Retry to start this channel.',
      },
    });
    expect(JSON.stringify(events)).not.toContain('private.test');
    engine.dispose();
  });
  it('waits for a manifest before play and settles initialization when disposed early', async () => {
    mocked.autoManifest = false;
    try {
      const video = new Video();
      const events: EngineEvent[] = [];
      const engine = createBrowserEngine(video.element, (event) => events.push(event));
      const previous = mocked.owners.length;
      const pending = engine.start(selection, new AbortController().signal);
      await vi.waitFor(() => expect(mocked.owners.length).toBe(previous + 1));
      expect(video.play).not.toHaveBeenCalled();
      engine.dispose();
      await pending;
      mocked.owners.at(-1)!.handlers.get('manifest')?.('manifest', {});
      expect(video.play).not.toHaveBeenCalled();
      expect(stateEvents(events)).toHaveLength(0);
    } finally {
      mocked.autoManifest = true;
    }
  });
  it('keeps delayed manifest from starting video after a pause request', async () => {
    mocked.autoManifest = false;
    try {
      const video = new Video();
      const engine = createBrowserEngine(video.element, () => {});
      const previous = mocked.owners.length;
      const pending = engine.start(selection, new AbortController().signal);
      engine.pause();
      await vi.waitFor(() => expect(mocked.owners.length).toBe(previous + 1));
      expect(mocked.owners.at(-1)!.config).toMatchObject({ autoStartLoad: false });
      mocked.owners.at(-1)!.handlers.get('manifest')?.('manifest', {});
      await pending;
      expect(video.play).not.toHaveBeenCalled();
      expect(video.paused).toBe(true);
      await engine.resume();
      expect(video.play).toHaveBeenCalledOnce();
      engine.dispose();
    } finally {
      mocked.autoManifest = true;
    }
  });
  it('passes exposed XHR/Fetch Retry-After into recoverable source errors', async () => {
    const video = new Video();
    const events: EngineEvent[] = [];
    const engine = createBrowserEngine(video.element, (event) => events.push(event));
    await engine.start(selection, new AbortController().signal);
    mocked.owners.at(-1)!.handlers.get('error')?.('error', {
      fatal: true,
      type: 'networkError',
      response: { code: 429 },
      networkDetails: {
        getResponseHeader: (name: string) => (name === 'Retry-After' ? '30' : null),
      },
    });
    expect(stateEvents(events)[0]).toMatchObject({
      type: 'error',
      failure: { retryAfterMs: 30_000 },
    });
    expect(readRetryAfter(new Response('', { headers: { 'Retry-After': '1' } }))).toBe('1');
    expect(
      readRetryAfter({
        getResponseHeader: () => {
          throw new Error('denied');
        },
      }),
    ).toBeNull();
    engine.dispose();
  });
  it('plays confirmed direct media even when its arbitrary filename resembles a playlist', async () => {
    const video = new Video();
    video.canPlayType = (mime) => (mime === 'video/mp4' ? 'probably' : '');
    const previous = mocked.owners.length;
    const inspect = vi.fn(async () => ({ kind: 'media' as const, mime: 'video/mp4' }));
    const engine = createBrowserEngine(video.element, () => {}, inspect);
    const url = 'https://source.test/opaque-playlist.m3u8';
    await engine.start(
      { id: 'arbitrary', name: 'Direct video', url },
      new AbortController().signal,
    );
    expect(inspect).toHaveBeenCalledOnce();
    expect(video.src).toBe(url);
    expect(mocked.owners.length).toBe(previous);
    expect(video.play).toHaveBeenCalledOnce();
    engine.dispose();
  });
  it('never treats unsupported direct MPEG-TS as an HLS playlist', async () => {
    const video = new Video();
    const events: EngineEvent[] = [];
    const previous = mocked.owners.length;
    const engine = createBrowserEngine(
      video.element,
      (event) => events.push(event),
      async () => ({ kind: 'media', mime: 'video/mp2t' }),
    );
    await engine.start(
      { id: 'transport', name: 'Direct TS', url: 'https://source.test/no-extension' },
      new AbortController().signal,
    );
    expect(mocked.owners.length).toBe(previous);
    expect(stateEvents(events)[0]).toMatchObject({
      type: 'error',
      failure: { code: 'unsupported', retryable: false },
    });
    engine.dispose();
  });
  it('rejects a late format probe after disposal before attaching media', async () => {
    const video = new Video();
    const events: EngineEvent[] = [];
    let resolve!: (value: { kind: 'hls' }) => void;
    const previous = mocked.owners.length;
    let probeSignal: AbortSignal | undefined;
    const engine = createBrowserEngine(
      video.element,
      (event) => events.push(event),
      (_url, signal) => {
        probeSignal = signal;
        return new Promise((done) => {
          resolve = done;
        });
      },
    );
    const pending = engine.start(
      { id: 'late', name: 'Delayed', url: 'https://source.test/opaque' },
      new AbortController().signal,
    );
    engine.dispose();
    expect(probeSignal?.aborted).toBe(true);
    resolve({ kind: 'hls' });
    await pending;
    expect(mocked.owners.length).toBe(previous);
    expect(video.play).not.toHaveBeenCalled();
    expect(stateEvents(events)).toHaveLength(0);
  });
  it('resolves source HTTP permission once and carries its grant to related resource hosts', async () => {
    const video = new Video();
    const grant = vi.fn(() => true);
    const load = vi.fn(async () => ({ status: 200, headers: {}, data: [1] }));
    const engine = createBrowserEngine(video.element, () => {}, undefined, {
      allowHttp: grant,
      nativeTransport: { load, cancel: vi.fn(async () => {}) },
    });
    await engine.start(selection, new AbortController().signal);
    const Type = (mocked.owners.at(-1)!.config as { loader: new () => Loader<LoaderContext> })
      .loader;
    const loader = new Type();
    const callbacks: LoaderCallbacks<LoaderContext> = {
      onSuccess: vi.fn(),
      onError: vi.fn(),
      onTimeout: vi.fn(),
    };
    const configuration: LoaderConfiguration = {
      maxRetry: 0,
      timeout: 1000,
      retryDelay: 0,
      maxRetryDelay: 0,
      loadPolicy: {
        maxTimeToFirstByteMs: 1000,
        maxLoadTimeMs: 1000,
        timeoutRetry: null,
        errorRetry: null,
      },
    };
    loader.load(
      {
        url: 'http://alternate-segment.test/opaque',
        responseType: 'arraybuffer',
        type: 'media-fragment' as LoaderContextType,
      },
      configuration,
      callbacks,
    );
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(grant).toHaveBeenCalledExactlyOnceWith(selection.url);
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ allowHttp: true }));
    expect(callbacks.onSuccess).toHaveBeenCalledOnce();
    loader.destroy();
    engine.dispose();
  });
  it('refuses direct HTTP media when no source grant was provided', async () => {
    const video = new Video();
    const events: EngineEvent[] = [];
    const engine = createBrowserEngine(video.element, (event) => events.push(event));
    await engine.start(
      { id: 'insecure', name: 'Direct', url: 'http://source.test/opaque', mediaKind: 'media' },
      new AbortController().signal,
    );
    expect(video.play).not.toHaveBeenCalled();
    expect(stateEvents(events)[0]).toMatchObject({
      type: 'error',
      failure: { code: 'access', retryable: false },
    });
    engine.dispose();
  });
});
// Reuses its actual PlaybackController/createBrowserEngine, mocked HLS and Video fixture.
it.each([
  { url: 'http://private.invalid/signed?token=secret' },
  { url: 'https://user:secret@private.invalid/signed' },
  { url: 'file:///private/secret' },
  {
    url: 'https://private.invalid/signed?token=secret',
    rangeStart: -1,
    rangeEnd: 5,
  },
])(
  'keeps local HLS preflight refusal nonretryable across engine/controller: %j',
  async (resource) => {
    vi.useFakeTimers();
    const before = mocked.owners.length;
    const load = vi.fn(async () => ({ status: 200, headers: {}, data: [] }));
    const controller = new PlaybackController((emit) =>
      createBrowserEngine(new Video().element, emit, undefined, {
        nativeTransport: { load, cancel: vi.fn(async () => {}) },
        allowHttp: () => false,
      }),
    );
    try {
      await controller.select(selection);
      for (let index = 0; index < 100; index++) await Promise.resolve();
      expect(mocked.owners).toHaveLength(before + 1);
      const hls = mocked.owners.at(-1)!;
      const Type = (hls.config as { loader: new () => Loader<LoaderContext> }).loader;
      const loader = new Type();
      const callbacks: LoaderCallbacks<LoaderContext> = {
        onSuccess: vi.fn(),
        onTimeout: vi.fn(),
        onAbort: vi.fn(),
        onError: (response, _context, details) =>
          hls.handlers.get('error')?.('error', {
            fatal: true,
            type: 'networkError',
            details: 'fragLoadError',
            response,
            networkDetails: details,
          }),
      };
      loader.load(
        { ...resource, responseType: 'arraybuffer' } as LoaderContext,
        {
          timeout: 15000,
          maxRetry: 0,
          retryDelay: 0,
          maxRetryDelay: 0,
          loadPolicy: {
            maxTimeToFirstByteMs: 8000,
            maxLoadTimeMs: 15000,
            timeoutRetry: null,
            errorRetry: null,
          },
        },
        callbacks,
      );
      for (let index = 0; index < 100; index++) await Promise.resolve();
      expect(controller.snapshot).toMatchObject({
        state: 'failed',
        failure: {
          code: 'policy',
          retryable: false,
          phase: 'unknown',
          evidence: 'native',
        },
      });
      // Selection necessarily retains its URL; only emitted failure diagnostics must redact it.
      expect(
        JSON.stringify({
          failure: controller.snapshot.failure,
          error: controller.snapshot.error,
        }),
      ).not.toMatch(/private|signed|token|secret/);
      expect(load).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(20000);
      expect(mocked.owners).toHaveLength(before + 1);
      expect(controller.snapshot.state).toBe('failed');
      loader.destroy();
    } finally {
      await controller.dispose();
      vi.useRealTimers();
    }
  },
);
it('explicit anonymous CORS is applied before direct src/load/play and removed before default playback', async () => {
  const video = new Video();
  video.canPlayType = (mime) => (mime === 'video/mp4' ? 'probably' : '');
  const order: string[] = [];
  let source = '';
  Object.defineProperty(video, 'src', {
    get: () => source,
    set: (value: string) => {
      order.push(`src:${video.crossOrigin}`);
      source = value;
    },
  });
  video.load.mockImplementation(() => {
    order.push(`load:${video.crossOrigin}`);
  });
  video.play.mockImplementation(async () => {
    order.push(`play:${video.crossOrigin}`);
  });
  const archive = createBrowserEngine(
    video.element,
    () => {},
    async () => {
      throw Error('explicit media must not inspect');
    },
  );
  await archive.start(
    { ...selection, mediaKind: 'media', mediaMime: 'video/mp4', crossOrigin: 'anonymous' },
    new AbortController().signal,
  );
  expect(order.filter((v) => v.startsWith('src:') || v.startsWith('play:'))).toEqual([
    'src:anonymous',
    'play:anonymous',
  ]);
  await archive.dispose();
  expect(video.crossOrigin).toBeNull();
  order.length = 0;
  const ordinary = createBrowserEngine(video.element, () => {});
  await ordinary.start(
    { ...selection, mediaKind: 'media', mediaMime: 'video/mp4' },
    new AbortController().signal,
  );
  expect(video.crossOrigin).toBeNull();
  expect(order).toContain('src:null');
  expect(order).toContain('play:null');
  await ordinary.dispose();
});
it('retried obsolete cleanup cannot clear a newly attached owner CORS or source', async () => {
  const video = new Video();
  let refuse = true;
  const remove = video.removeAttribute.getMockImplementation()!;
  video.removeAttribute.mockImplementation((name) => {
    if (name === 'crossorigin' && refuse) throw Error('controlled attribute failure');
    remove(name);
  });
  const old = createBrowserEngine(video.element, () => {});
  await old.start(
    { ...selection, mediaKind: 'media', crossOrigin: 'anonymous' },
    new AbortController().signal,
  );
  expect(() => old.dispose()).toThrow();
  const next = createBrowserEngine(video.element, () => {});
  await next.start(
    {
      ...selection,
      url: 'https://fixture.invalid/next.mp4',
      mediaKind: 'media',
      crossOrigin: 'anonymous',
    },
    new AbortController().signal,
  );
  refuse = false;
  await old.dispose();
  expect(video.crossOrigin).toBe('anonymous');
  expect(video.src).toBe('https://fixture.invalid/next.mp4');
  await next.dispose();
  expect(video.crossOrigin).toBeNull();
});
it('observes partial audio faults while video progresses without restarting or changing recovery', async () => {
  mocked.autoManifest = true;
  const video = new Video(),
    events: EngineEvent[] = [],
    owners = createResourceOwners();
  const engine = createBrowserEngine(video.element, (event) => events.push(event), undefined, {
    owners,
  });
  await engine.start(selection, new AbortController().signal);
  const hls = mocked.owners.at(-1)!;
  hls.handlers.get('buffer-codecs')?.('buffer-codecs', { audio: {}, video: {} });
  hls.handlers.get('buffer-created')?.('buffer-created', { tracks: { audio: {} } });
  for (let index = 0; index < 3; index++) {
    hls.handlers.get('error')?.('error', {
      fatal: false,
      details: 'bufferAppendNoProgress',
      parent: 'audio',
      reason: 'private metadata',
    });
    video.currentTime += 1;
    video.dispatchEvent(new Event('timeupdate'));
  }
  expect(events.filter((event) => event.type === 'progress')).toHaveLength(3);
  expect(events.some((event) => event.type === 'error')).toBe(false);
  expect(hls.startLoad).toHaveBeenCalledTimes(1);
  expect(hls.stopLoad).not.toHaveBeenCalled();
  expect(readAudioHealth(video.element)).toMatchObject({
    audioCodecObserved: true,
    audioBufferObserved: true,
    faults: [{ detail: 'bufferAppendNoProgress', count: 3 }],
  });
  const late = hls.handlers.get('error');
  await engine.dispose();
  late?.('error', { fatal: false, details: 'bufferAppendNoProgress', parent: 'audio' });
  expect(readAudioHealth(video.element)).toBeNull();
  expect(Object.values(owners.snapshot().counts).every((count) => count === 0)).toBe(true);
});
describe('live buffer profiles (configuration only, no decoder proof)', () => {
  it.each(profiles)('HLS profile %s', async (buffer, ahead, most, liveSync) => {
    const video = new Video();
    const engine = createBrowserEngine(video.element, () => {});
    await engine.start(
      { ...selection, ...(buffer ? { buffer: buffer as 'fast' } : {}) },
      new AbortController().signal,
    );
    const config = mocked.owners.at(-1)!.config as Record<string, unknown>;
    expect(config.maxBufferLength).toBe(ahead);
    expect(config.maxMaxBufferLength).toBe(most);
    expect(config.liveSyncDurationCount).toBe(liveSync);
    engine.dispose();
  });
  it.each(profiles)('MPEG-TS stash for profile %s', (buffer, _ahead, _most, _sync, stash) => {
    // The engine passes this value as mpegts.js stashInitialSize.
    expect(liveBufferProfile(buffer).mpegtsStash).toBe(stash);
    // Played-back live media: 30 s always kept for instant replay, trimmed
    // after 40 s (mpegts.js keeps minutes by default).
    expect(MPEGTS_BACK_BUFFER).toEqual({
      autoCleanupMaxBackwardDuration: 40,
      autoCleanupMinBackwardDuration: 30,
    });
  });
});
describe('adaptive live buffering (controlled element; no decoder proof)', () => {
  it('a live stream that ends is reported as ended, so the player reconnects', async () => {
    const events: EngineEvent[] = [];
    const video = element({ seconds: 10 });
    const engine = createBrowserEngine(video.element, (event) => events.push(event));
    await engine.start(live, new AbortController().signal);
    video.dispatchEvent(new Event('ended'));
    expect(events.some((e) => e.type === 'ended')).toBe(true);
    expect(events.some((e) => e.type === 'error')).toBe(false);
    engine.dispose();
  });
  it('startup buffering is never held: the first play() must not be cancelled', async () => {
    const video = element({ seconds: 0 });
    let finishPlay: () => void = () => undefined;
    // A real element rejects a pending play() when pause() is called.
    video.play.mockImplementation(
      () =>
        new Promise<void>((resolve, reject) => {
          finishPlay = resolve;
          video.pause.mockImplementationOnce(() => {
            video.paused = true;
            reject(new DOMException('interrupted', 'AbortError'));
          });
        }),
    );
    const events: EngineEvent[] = [];
    const engine = createBrowserEngine(video.element, (event) => events.push(event));
    const starting = engine.start(live, new AbortController().signal);
    await Promise.resolve();
    video.dispatchEvent(new Event('waiting'));
    finishPlay();
    await expect(starting).resolves.toBeUndefined();
    expect(video.pause).not.toHaveBeenCalled();
    expect(events.some((e) => e.type === 'error')).toBe(false);
    engine.dispose();
  });
  it('a stall holds playback until the raised goal is buffered, then resumes', async () => {
    vi.useFakeTimers();
    try {
      const ahead = { seconds: 0.4 };
      const video = element(ahead);
      const engine = createBrowserEngine(video.element, () => undefined);
      await engine.start(live, new AbortController().signal);
      played(video);
      video.play.mockClear();
      video.dispatchEvent(new Event('waiting'));
      expect(video.pause).toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(video.play).not.toHaveBeenCalled();
      ahead.seconds = 5; // balanced 3 s, raised to 5 s by this stall
      await vi.advanceTimersByTimeAsync(300);
      expect(video.play).toHaveBeenCalledTimes(1);
      engine.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it("the viewer's own Pause during a hold is kept", async () => {
    vi.useFakeTimers();
    try {
      const ahead = { seconds: 0 };
      const video = element(ahead);
      const engine = createBrowserEngine(video.element, () => undefined);
      await engine.start(live, new AbortController().signal);
      played(video);
      video.play.mockClear();
      video.dispatchEvent(new Event('waiting'));
      engine.pause();
      ahead.seconds = 30;
      await vi.advanceTimersByTimeAsync(15_000);
      expect(video.play).not.toHaveBeenCalled();
      engine.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it('a hold ends by itself at its cap; on-demand titles never hold', async () => {
    vi.useFakeTimers();
    try {
      const video = element({ seconds: 0 });
      const engine = createBrowserEngine(video.element, () => undefined);
      await engine.start(live, new AbortController().signal);
      played(video);
      video.play.mockClear();
      video.dispatchEvent(new Event('waiting'));
      await vi.advanceTimersByTimeAsync(11_000);
      expect(video.play).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1_500);
      expect(video.play).toHaveBeenCalledTimes(1);
      engine.dispose();
      const film = element({ seconds: 0 });
      const vod = createBrowserEngine(film.element, () => undefined);
      await vod.start({ ...live, id: 'film', playMode: 'on-demand' }, new AbortController().signal);
      film.pause.mockClear();
      film.dispatchEvent(new Event('waiting'));
      expect(film.pause).not.toHaveBeenCalled();
      vod.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
});
