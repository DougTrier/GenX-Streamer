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
 * Browser engine resource contract: ownership, frame evidence, failures and
 * cleanup retries.
 */
import { describe, expect, it, vi } from 'vitest';
import { createResourceOwners } from '../../src/playback/resource-owners';
import { createBrowserEngine } from '../../src/platform/browser-engine';
import { type Loader, type LoaderContext, type LoaderContextType } from 'hls.js';
import { PlaybackController, type EngineEvent } from '../../src/playback/controller';
import { Video, selection, stateEvents } from './browser-engine.fixture';

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
  it('closes its native loader factory even when HLS destruction fails and joins both actual operations', async () => {
    const owners = createResourceOwners();
    const video = new Video();
    let finishLoad!: (payload: {
      status: number;
      headers: Record<string, string>;
      data: number[];
    }) => void;
    let finishCancel!: () => void;
    const engine = createBrowserEngine(video.element, () => {}, undefined, {
      owners,
      nativeTransport: {
        load: () =>
          new Promise((resolve) => {
            finishLoad = resolve;
          }),
        cancel: () =>
          new Promise((resolve) => {
            finishCancel = resolve;
          }),
      },
    });
    await engine.start(selection, new AbortController().signal);
    const owner = mocked.owners.at(-1)!;
    const Type = (owner.config as { loader: new () => Loader<LoaderContext> }).loader;
    const loader = new Type();
    loader.load(
      {
        url: selection.url,
        responseType: 'arraybuffer',
        type: 'media-fragment' as LoaderContextType,
      },
      {
        loadPolicy: {
          maxTimeToFirstByteMs: 8000,
          maxLoadTimeMs: 15000,
          timeoutRetry: null,
          errorRetry: null,
        },
        timeout: 15000,
        maxRetry: 0,
        retryDelay: 0,
        maxRetryDelay: 0,
      },
      { onSuccess: vi.fn(), onError: vi.fn(), onTimeout: vi.fn() },
    );
    owner.destroy.mockImplementationOnce(() => {
      throw new Error('private');
    });
    expect(() => engine.dispose()).toThrow();
    expect(() => new Type()).toThrow('closed');
    expect(owners.snapshot().counts.nativeLoaders).toBe(0);
    expect(owners.snapshot().counts.nativeLoads).toBe(1);
    expect(owners.snapshot().counts.nativeCancels).toBe(1);
    let acknowledged = false;
    const retry = Promise.resolve(engine.dispose()).then(() => {
      acknowledged = true;
    });
    finishLoad({ status: 200, headers: {}, data: [1] });
    for (let n = 0; n < 8; n++) await Promise.resolve();
    expect(acknowledged).toBe(false);
    expect(owners.snapshot().counts.browserEngines).toBe(1);
    finishCancel();
    await retry;
    expect(Object.values(owners.snapshot().counts).every((count) => count === 0)).toBe(true);
    expect(owners.snapshot().coveredDomains).toContain('native-loader');
  });
  it('retains engine ownership after a five-second drain timeout and permits a real later retry', async () => {
    vi.useFakeTimers();
    const owners = createResourceOwners();
    const video = new Video();
    let finish!: (source: { kind: 'media' }) => void;
    const engine = createBrowserEngine(
      video.element,
      () => {},
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      { owners },
    );
    const start = engine.start(
      { id: 'pending', name: 'Pending', url: selection.url },
      new AbortController().signal,
    );
    try {
      const failure = expect(engine.dispose()).rejects.toThrow('did not settle');
      await vi.advanceTimersByTimeAsync(5000);
      await failure;
      expect(owners.snapshot().counts.browserEngines).toBe(1);
      expect(owners.snapshot().counts.initializationWaits).toBe(1);
      expect(owners.snapshot().counts.drainTimers).toBe(0);
      const retry = engine.dispose();
      finish({ kind: 'media' });
      await start;
      await retry;
      expect(owners.snapshot().counts.browserEngines).toBe(0);
      expect(owners.snapshot().counts.abortListeners).toBe(0);
      expect(video.play).not.toHaveBeenCalled();
    } finally {
      finish({ kind: 'media' });
      await start;
      await engine.dispose();
      vi.useRealTimers();
    }
  });
  it('keeps real failed HLS/listener ownership visible until successful cleanup', async () => {
    const owners = createResourceOwners();
    const video = new Video();
    const engine = createBrowserEngine(video.element, () => {}, undefined, { owners });
    await engine.start(selection, new AbortController().signal);
    expect(owners.snapshot().counts.videoListeners).toBe(11);
    expect(owners.snapshot().counts.hlsInstances).toBe(1);
    expect(owners.snapshot().counts.hlsListeners).toBe(11);
    const hls = mocked.owners.at(-1)!;
    hls.destroy.mockImplementationOnce(() => {
      throw new Error('private');
    });
    expect(() => engine.dispose()).toThrow();
    expect(owners.snapshot().counts.videoListeners).toBe(0);
    expect(owners.snapshot().counts.abortListeners).toBe(0);
    expect(owners.snapshot().counts.hlsInstances).toBe(1);
    expect(owners.snapshot().counts.browserEngines).toBe(1);
    await engine.dispose();
    expect(Object.values(owners.snapshot().counts).every((count) => count === 0)).toBe(true);
    expect(owners.snapshot().coveredDomains).not.toContain('native-loader');
  });
  it('detaches immediately but does not acknowledge cleanup until source inspection settles', async () => {
    const owners = createResourceOwners();
    const video = new Video();
    let finishInspection!: (source: { kind: 'media' }) => void;
    const engine = createBrowserEngine(
      video.element,
      () => {},
      () =>
        new Promise((resolve) => {
          finishInspection = resolve;
        }),
      { owners },
    );
    const start = engine.start(
      { id: 'pending', name: 'Pending', url: selection.url },
      new AbortController().signal,
    );
    let acknowledged = false;
    const cleanup = Promise.resolve(engine.dispose()).then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    try {
      expect(video.pause).toHaveBeenCalledOnce();
      expect(video.removeAttribute).toHaveBeenCalledOnce();
      expect(acknowledged).toBe(false);
      expect(owners.snapshot().counts.browserEngines).toBe(1);
      expect(owners.snapshot().counts.initializationWaits).toBe(1);
    } finally {
      finishInspection({ kind: 'media' });
      await start;
      await cleanup;
    }
    expect(owners.snapshot().counts.browserEngines).toBe(0);
    expect(owners.snapshot().counts.initializationWaits).toBe(0);
    expect(video.play).not.toHaveBeenCalled();
  });
  it('emits conservative frame evidence only when media time and successful frames both advance', async () => {
    const events: EngineEvent[] = [];
    const video = new Video();
    let frames = 10,
      dropped = 2,
      at = 100;
    Object.assign(video, {
      videoWidth: 320,
      videoHeight: 180,
      getVideoPlaybackQuality: () => ({ totalVideoFrames: frames, droppedVideoFrames: dropped }),
    });
    const engine = createBrowserEngine(video.element, (event) => events.push(event), undefined, {
      monotonicNow: () => at,
    });
    await engine.start(selection, new AbortController().signal);
    const tick = (time: number, total: number, lost: number) => {
      video.currentTime = time;
      frames = total;
      dropped = lost;
      at += 100;
      video.dispatchEvent(new Event('timeupdate'));
    };
    tick(1, 10, 2);
    tick(2, 10, 2); // time alone is not decoder proof
    tick(3, 11, 3); // every additional frame dropped
    expect(events.filter((event) => event.type === 'decoded-progress')).toHaveLength(0);
    tick(4, 13, 3);
    expect(events.filter((event) => event.type === 'decoded-progress')).toEqual([
      {
        type: 'decoded-progress',
        evidence: {
          kind: 'decoded',
          before: { mediaTime: 3, decodedFrames: 8, width: 320, height: 180 },
          after: { mediaTime: 4, decodedFrames: 10, width: 320, height: 180 },
          elapsedMilliseconds: 100,
        },
      },
    ]);
    engine.dispose();
    tick(5, 20, 3);
    expect(events.filter((event) => event.type === 'decoded-progress')).toHaveLength(1);
  });
  it('resets samples across seeking/pause and rejects absent, malformed or nonmonotonic quality', async () => {
    const events: EngineEvent[] = [];
    const video = new Video();
    let at = 100,
      frames = 1;
    Object.assign(video, {
      videoWidth: 320,
      videoHeight: 180,
      getVideoPlaybackQuality: () => ({ totalVideoFrames: frames, droppedVideoFrames: 0 }),
    });
    const engine = createBrowserEngine(video.element, (event) => events.push(event), undefined, {
      monotonicNow: () => at,
    });
    await engine.start(selection, new AbortController().signal);
    const tick = () => {
      at += 100;
      frames++;
      video.currentTime++;
      video.dispatchEvent(new Event('timeupdate'));
    };
    tick();
    video.seeking = true;
    video.dispatchEvent(new Event('seeking'));
    tick();
    video.seeking = false;
    tick();
    engine.pause();
    tick();
    await engine.resume();
    tick();
    expect(events.filter((event) => event.type === 'decoded-progress')).toHaveLength(0);
    tick();
    expect(events.filter((event) => event.type === 'decoded-progress')).toHaveLength(1);
    Object.assign(video, { getVideoPlaybackQuality: undefined });
    tick();
    tick();
    Object.assign(video, {
      getVideoPlaybackQuality: () => ({ totalVideoFrames: NaN, droppedVideoFrames: 0 }),
    });
    tick();
    expect(events.filter((event) => event.type === 'decoded-progress')).toHaveLength(1);
    Object.assign(video, {
      getVideoPlaybackQuality: () => ({ totalVideoFrames: frames, droppedVideoFrames: 0 }),
    });
    tick();
    at -= 500;
    tick();
    expect(events.filter((event) => event.type === 'decoded-progress')).toHaveLength(1);
    engine.dispose();
  });
  it.each([
    ['tls-failure', 'tls', false],
    ['dns-failure', 'dns', true],
    [JSON.stringify({ category: 'timeout', phase: 'body' }), 'timeout', true],
    [
      JSON.stringify({ category: 'http', status: 503, retryAfter: '12', phase: 'headers' }),
      'network',
      true,
    ],
  ] as const)('preserves exact native initializer failure %s', async (cause, code, retryable) => {
    const events: EngineEvent[] = [];
    const engine = createBrowserEngine(
      new Video().element,
      (event) => events.push(event),
      async () => {
        throw cause;
      },
    );
    await engine.start({ ...selection, mediaKind: undefined }, new AbortController().signal);
    expect(stateEvents(events)[0]).toMatchObject({ type: 'error', failure: { code, retryable } });
    if (code === 'network')
      expect(stateEvents(events)[0]).toMatchObject({ failure: { retryAfterMs: 12000 } });
    engine.dispose();
  });
  it.each([
    ['mediaError', 'bufferAppendError', 'decode'],
    ['networkError', 'manifestIncompatibleCodecsError', 'unsupported'],
    ['mediaError', 'bufferIncompatibleCodecsError', 'unsupported'],
  ] as const)('does not infer codec rejection from %s/%s', async (type, details, code) => {
    const events: EngineEvent[] = [];
    const engine = createBrowserEngine(new Video().element, (event) => events.push(event));
    await engine.start(selection, new AbortController().signal);
    mocked.owners.at(-1)!.handlers.get('error')?.('error', { fatal: true, type, details });
    expect(stateEvents(events)[0]).toMatchObject({
      type: 'error',
      failure: { code, retryable: false },
    });
    engine.dispose();
  });
  it('propagates native body timeout metadata and preserves opaque failures as unknown', async () => {
    const events: EngineEvent[] = [];
    const engine = createBrowserEngine(new Video().element, (event) => events.push(event));
    await engine.start(selection, new AbortController().signal);
    const callback = mocked.owners.at(-1)!.handlers.get('error')!;
    callback('error', {
      fatal: true,
      type: 'networkError',
      details: 'fragLoadError',
      response: { code: 0, text: 'timeout' },
      networkDetails: { playbackTransportError: { category: 'timeout', phase: 'body' } },
    });
    expect(stateEvents(events)[0]).toMatchObject({
      failure: { code: 'timeout', phase: 'body', evidence: 'native' },
    });
    callback('error', {
      fatal: true,
      type: 'networkError',
      details: 'fragLoadError',
      response: { code: 0, text: 'https://private.invalid/secret' },
    });
    expect(stateEvents(events)[1]).toMatchObject({
      failure: { code: 'unknown', phase: 'unknown', evidence: 'opaque' },
    });
    engine.dispose();
  });
  it.each([3, 4])(
    'media error %i distinguishes decode failure from unsupported capability',
    async (code) => {
      const video = new Video();
      const events: EngineEvent[] = [];
      const engine = createBrowserEngine(video.element, (event) => events.push(event));
      await engine.start(selection, new AbortController().signal);
      video.error = { code };
      video.dispatchEvent(new Event('error'));
      expect(stateEvents(events)[0]).toMatchObject({
        failure: { code: code === 3 ? 'decode' : 'unsupported' },
      });
      engine.dispose();
    },
  );
  it('can select the controlled MSE loader despite native HLS advertisement', async () => {
    const video = new Video();
    video.canPlayType = () => 'probably';
    const before = mocked.owners.length;
    const engine = createBrowserEngine(video.element, vi.fn(), undefined, {
      preferNativeHls: false,
    });
    await engine.start(selection, new AbortController().signal);
    expect(mocked.owners).toHaveLength(before + 1);
    expect(video.src).toBe('');
    expect(video.play).toHaveBeenCalledOnce();
    await engine.dispose();
  });
  it('settles disposal while the library is loading and ignores its late completion', async () => {
    const Library = (await import('hls.js')).default;
    let finish!: (library: typeof Library) => void;
    const loadHls = vi.fn(
      () =>
        new Promise<typeof Library>((resolve) => {
          finish = resolve;
        }),
    );
    const previous = mocked.owners.length;
    const video = new Video();
    const events: EngineEvent[] = [];
    const engine = createBrowserEngine(video.element, (event) => events.push(event), undefined, {
      loadHls,
    });
    const pending = engine.start(selection, new AbortController().signal);
    await vi.waitFor(() => expect(loadHls).toHaveBeenCalledOnce());
    engine.dispose();
    await pending;
    finish(Library);
    await Promise.resolve();
    expect(mocked.owners.length).toBe(previous);
    expect(video.play).not.toHaveBeenCalled();
    expect(stateEvents(events)).toHaveLength(0);
  });
  it('reports a redacted component failure without automatic retries', async () => {
    const video = new Video();
    const events: EngineEvent[] = [];
    const engine = createBrowserEngine(video.element, (event) => events.push(event), undefined, {
      loadHls: async () => {
        throw new Error('private-module-url');
      },
    });
    await engine.start(selection, new AbortController().signal);
    expect(stateEvents(events)).toEqual([
      expect.objectContaining({
        type: 'error',
        failure: expect.objectContaining({ code: 'unsupported', retryable: false }),
      }),
    ]);
    expect(JSON.stringify(events)).not.toContain('private-module-url');
    engine.dispose();
  });
  it('does not import HLS for direct media or platforms with native HLS support', async () => {
    for (const mediaKind of ['hls', 'media'] as const) {
      const video = new Video();
      video.canPlayType = () => 'probably';
      const loadHls = vi.fn(async () => (await import('hls.js')).default);
      const engine = createBrowserEngine(video.element, () => {}, undefined, { loadHls });
      await engine.start({ ...selection, mediaKind }, new AbortController().signal);
      expect(loadHls).not.toHaveBeenCalled();
      expect(video.play).toHaveBeenCalledOnce();
      engine.dispose();
    }
  });
  it('retries failed HLS destruction while completing independent video cleanup once', async () => {
    const video = new Video();
    const events: EngineEvent[] = [];
    const engine = createBrowserEngine(video.element, (event) => events.push(event));
    await engine.start(selection, new AbortController().signal);
    const owner = mocked.owners.at(-1)!;
    owner.destroy.mockImplementationOnce(() => {
      throw new Error('private upstream diagnostic');
    });
    expect(() => engine.dispose()).toThrow();
    expect(video.pause).toHaveBeenCalledOnce();
    expect(video.removeAttribute).toHaveBeenCalledExactlyOnceWith('src');
    expect(video.load).toHaveBeenCalledOnce();
    const before = events.length;
    owner.handlers.get('error')?.('error', { fatal: true, type: 'mediaError' });
    video.dispatchEvent(new Event('waiting'));
    expect(events).toHaveLength(before);
    expect(() => engine.dispose()).not.toThrow();
    expect(owner.destroy).toHaveBeenCalledTimes(2);
    engine.dispose();
    expect(owner.destroy).toHaveBeenCalledTimes(2);
    expect(video.pause).toHaveBeenCalledOnce();
    expect(video.load).toHaveBeenCalledOnce();
  });
  it('retains a repeatedly failing cleanup owner until a real retry acknowledges release', async () => {
    const video = new Video();
    const startCount = mocked.owners.length;
    const player = new PlaybackController((emit) => createBrowserEngine(video.element, emit));
    await player.select(selection);
    await vi.waitFor(() => expect(mocked.owners.length).toBe(startCount + 1));
    const owner = mocked.owners.at(-1)!;
    owner.destroy.mockImplementation(() => {
      throw new Error('private upstream diagnostic');
    });
    await player.select({ ...selection, id: '2' });
    expect(player.snapshot.state).toBe('failed');
    expect(mocked.owners.length).toBe(startCount + 1);
    await player.select({ ...selection, id: '3' });
    expect(player.snapshot.state).toBe('failed');
    expect(mocked.owners.length).toBe(startCount + 1);
    owner.destroy.mockImplementation(() => undefined);
    await player.select({ ...selection, id: '4' });
    await vi.waitFor(() => expect(mocked.owners.length).toBe(startCount + 2));
    await player.dispose();
  });
  it('retries only failed listener and video stages and redacts cleanup errors', async () => {
    const video = new Video();
    const engine = createBrowserEngine(video.element, () => {});
    await engine.start(selection, new AbortController().signal);
    const owner = mocked.owners.at(-1)!;
    const remove = video.removeEventListener.bind(video);
    let failed = false;
    const removeListener = vi
      .spyOn(video, 'removeEventListener')
      .mockImplementation((type, fn, options) => {
        if (type === 'seeking' && !failed) {
          failed = true;
          throw new Error('private token');
        }
        remove(type, fn, options);
      });
    video.pause.mockImplementationOnce(() => {
      throw new Error('private token');
    });
    video.load.mockImplementationOnce(() => {
      throw new Error('private token');
    });
    let failure: unknown;
    try {
      engine.dispose();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    const aggregate = failure as AggregateError;
    expect(aggregate.errors).toHaveLength(3);
    expect(String(aggregate)).not.toContain('private');
    expect(aggregate.errors.every((error: Error) => !String(error).includes('private'))).toBe(true);
    expect(owner.destroy).toHaveBeenCalledOnce();
    expect(video.removeAttribute).toHaveBeenCalledOnce();
    expect(removeListener.mock.calls.filter(([type]) => type === 'timeupdate')).toHaveLength(1);
    engine.dispose();
    expect(video.pause).toHaveBeenCalledTimes(2);
    expect(video.load).toHaveBeenCalledTimes(2);
    expect(video.removeAttribute).toHaveBeenCalledOnce();
    expect(owner.destroy).toHaveBeenCalledOnce();
    expect(removeListener.mock.calls.filter(([type]) => type === 'seeking')).toHaveLength(2);
    engine.dispose();
    expect(video.load).toHaveBeenCalledTimes(2);
  });
});
