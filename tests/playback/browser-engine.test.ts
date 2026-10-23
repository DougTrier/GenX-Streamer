import { describe, expect, it, vi } from 'vitest';
import { PlaybackController, type EngineEvent } from '../../src/playback/controller';
import { createResourceOwners } from '../../src/playback/resource-owners';
import { startTiming } from '../../src/playback/start-timing';
import type {
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  LoaderContextType,
} from 'hls.js';

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
import {
  classifyHttpFailure,
  createBrowserEngine,
  readRetryAfter,
  readVideoQuality,
  setVideoQuality,
  VIDEO_QUALITY_CHANGE,
  readAudioHealth,
  liveBufferProfile,
  MPEGTS_BACK_BUFFER,
} from '../../src/platform/browser-engine';

class Video extends EventTarget {
  textTracks: Array<{ kind: string; mode: string; cues: object[]; removeCue(cue: object): void }> =
    [];
  paused = false;
  seeking = false;
  readyState = 2;
  currentTime = 0;
  muted = false;
  volume = 1;
  src = '';
  crossOrigin: string | null = null;
  error: { code: number } | null = null;
  seekable = { length: 0, start: () => 50, end: () => 100 };
  play = vi.fn(async () => {
    this.paused = false;
  });
  pause = vi.fn(() => {
    this.paused = true;
  });
  load = vi.fn();
  removeAttribute = vi.fn((name: string) => {
    if (name === 'src') this.src = '';
    if (name === 'crossorigin') this.crossOrigin = null;
  });
  canPlayType = (_mime: string): string => '';
  get element() {
    return this as unknown as HTMLVideoElement;
  }
}
const stateEvents = (events: EngineEvent[]): EngineEvent[] =>
  events.filter((event) => event.type !== 'capability' && event.type !== 'audio-tracks');
const selection = {
  id: '1',
  name: 'Fixture',
  url: 'https://example.test/live',
  mediaKind: 'hls' as const,
};

describe('browser adapter resource contract (mocked transport, no decoder proof)', () => {
  it('selects highest supported advertised height, bitrate then width before loading, and preserves explicit Auto', async () => {
    mocked.autoManifest = false;
    const video = new Video(),
      engine = createBrowserEngine(video.element, () => {});
    try {
      const pending = engine.start(selection, new AbortController().signal);
      await vi.waitFor(() =>
        expect(mocked.owners.at(-1)?.config).toMatchObject({ autoStartLoad: false }),
      );
      const hls = mocked.owners.at(-1)!;
      let next = -1;
      Object.assign(hls, {
        levels: [
          { height: 720, width: 1280, bitrate: 9e6 },
          { height: 1080, width: 1920, bitrate: 8e6 },
          { height: 1080, width: 1920, bitrate: 9e6 },
          { height: 1080, width: 2048, bitrate: 9e6 },
          { height: 1080, width: 2048, bitrate: 9e6 },
        ],
        currentLevel: -1,
        autoLevelEnabled: true,
      });
      Object.defineProperty(hls, 'nextLevel', {
        configurable: true,
        get: () => next,
        set(value: number) {
          next = value;
          Reflect.set(hls, 'autoLevelEnabled', value === -1);
        },
      });
      hls.startLoad.mockImplementation(() => {
        expect(next).toBe(3);
      });
      expect(hls.startLoad).not.toHaveBeenCalled();
      hls.handlers.get('manifest')?.('manifest', {});
      await pending;
      expect(next).toBe(3);
      expect(readVideoQuality(video.element)?.auto).toBe(false);
      expect(hls.startLoad).toHaveBeenCalledExactlyOnceWith(-1);
      expect(setVideoQuality(video.element, null)).toBe(true);
      expect(next).toBe(-1);
      expect(readVideoQuality(video.element)?.auto).toBe(true);
      hls.handlers.get('manifest')?.('manifest', {});
      expect(next).toBe(-1);
      expect(hls.startLoad).toHaveBeenCalledTimes(1);
      expect(Reflect.get(hls, 'currentLevel')).toBe(-1);
    } finally {
      await engine.dispose();
      mocked.autoManifest = true;
    }
  });

  it('does not manufacture levels from absent/invalid metadata and refuses obsolete manifest defaults', async () => {
    mocked.autoManifest = false;
    const video = new Video(),
      old = createBrowserEngine(video.element, () => {});
    let next: ReturnType<typeof createBrowserEngine> | undefined;
    try {
      const oldCount = mocked.owners.length;
      const oldPending = old.start(selection, new AbortController().signal);
      await vi.waitFor(() => expect(mocked.owners.length).toBe(oldCount + 1));
      const oldHls = mocked.owners.at(-1)!;
      Object.assign(oldHls, {
        levels: [{ height: 2160, width: 3840, bitrate: 20e6 }],
        nextLevel: -1,
      });
      next = createBrowserEngine(video.element, () => {});
      const pending = next.start(selection, new AbortController().signal);
      await vi.waitFor(() => expect(mocked.owners.at(-1)).not.toBe(oldHls));
      const hls = mocked.owners.at(-1)!;
      Object.assign(hls, {
        levels: [{ height: NaN, width: -1, bitrate: Infinity }, {}],
        nextLevel: -1,
      });
      hls.handlers.get('manifest')?.('manifest', {});
      await pending;
      expect(Reflect.get(hls, 'nextLevel')).toBe(-1);
      oldHls.handlers.get('manifest')?.('manifest', {});
      await oldPending;
      expect(Reflect.get(oldHls, 'nextLevel')).toBe(-1);
      expect(oldHls.startLoad).not.toHaveBeenCalled();
      await old.dispose();
      expect(readVideoQuality(video.element)).not.toBeNull();
      await next.dispose();
      expect(readVideoQuality(video.element)).toBeNull();
    } finally {
      await old.dispose();
      await next?.dispose();
      mocked.autoManifest = true;
    }
  });
  it('each replacement starts at its own highest available rendition and late disposed manifests cannot restart it', async () => {
    mocked.autoManifest = false;
    const video = new Video();
    for (const levels of [
      [],
      [
        { height: 360, width: 640, bitrate: 1e6 },
        { height: 720, width: 1280, bitrate: 2e6 },
      ],
    ]) {
      const engine = createBrowserEngine(video.element, () => {}),
        count = mocked.owners.length;
      try {
        const pending = engine.start(selection, new AbortController().signal);
        await vi.waitFor(() => expect(mocked.owners.length).toBe(count + 1));
        const hls = mocked.owners.at(-1)!;
        Object.assign(hls, { levels, nextLevel: -1 });
        hls.handlers.get('manifest')?.('manifest', {});
        await pending;
        expect(Reflect.get(hls, 'nextLevel')).toBe(levels.length ? 1 : -1);
        await engine.dispose();
        const calls = hls.startLoad.mock.calls.length;
        hls.handlers.get('manifest')?.('manifest', {});
        expect(hls.startLoad).toHaveBeenCalledTimes(calls);
        expect(readVideoQuality(video.element)).toBeNull();
      } finally {
        await engine.dispose();
      }
    }
    mocked.autoManifest = true;
  });
  it('reads finite actual video/HLS quality without exposing source identities or adding polling', async () => {
    const video = new Video();
    Object.assign(video, {
      videoWidth: 426,
      videoHeight: 240,
      currentTime: 30,
      buffered: {
        length: 2,
        start: (index: number) => (index === 0 ? 0 : 29),
        end: (index: number) => (index === 0 ? 10 : 50),
      },
      getVideoPlaybackQuality: () => ({ totalVideoFrames: 900, droppedVideoFrames: 0 }),
    });
    expect(readVideoQuality(video.element)).toBeNull();
    const engine = createBrowserEngine(video.element, () => {});
    await engine.start(selection, new AbortController().signal);
    Object.assign(mocked.owners.at(-1)!, {
      currentLevel: 0,
      nextAutoLevel: 2,
      bandwidthEstimate: 1200000,
      ttfbEstimate: 42,
      levels: [
        {
          width: 426,
          height: 240,
          bitrate: 300000,
          videoCodec: 'avc1.42e01e',
          audioCodec: 'mp4a.40.2',
          url: 'https://private.test/?token=SECRET',
          id: 'SECRET',
        },
      ],
    });
    const snapshot = readVideoQuality(video.element)!;
    expect(snapshot).toMatchObject({
      videoWidth: 426,
      videoHeight: 240,
      totalFrames: 900,
      droppedFrames: 0,
      bufferedAheadSeconds: 20,
      currentLevel: 0,
      nextAutoLevel: 2,
      bandwidthEstimate: 1200000,
      ttfbEstimate: 42,
    });
    expect(snapshot.availableLevels[0]).toEqual({
      index: 0,
      width: 426,
      height: 240,
      bitrate: 300000,
      videoCodec: 'avc1.42e01e',
      audioCodec: 'mp4a.40.2',
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/SECRET|private|url|token/);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.availableLevels[0])).toBe(true);
    const timers = vi.spyOn(globalThis, 'setTimeout');
    readVideoQuality(video.element);
    readVideoQuality(video.element);
    expect(timers).not.toHaveBeenCalled();
    timers.mockRestore();
    await engine.dispose();
    expect(readVideoQuality(video.element)).toBeNull();
    expect(snapshot.bufferedAheadSeconds).toBe(20);
  });
  it('invalid counters/estimates stay unknown; bounded level snapshots reject address-like codec text', async () => {
    const video = new Video();
    Object.assign(video, {
      videoWidth: NaN,
      videoHeight: Infinity,
      currentTime: NaN,
      getVideoPlaybackQuality: () => ({ totalVideoFrames: 1, droppedVideoFrames: 2 }),
    });
    const engine = createBrowserEngine(video.element, () => {});
    await engine.start(selection, new AbortController().signal);
    Object.assign(mocked.owners.at(-1)!, {
      currentLevel: NaN,
      nextAutoLevel: Infinity,
      bandwidthEstimate: -1,
      ttfbEstimate: Infinity,
      levels: Array.from({ length: 65 }, () => ({
        width: NaN,
        height: 240,
        bitrate: Infinity,
        videoCodec: 'https://secret.test',
        audioCodec: 'mp4a.40.2',
      })),
    });
    const snapshot = readVideoQuality(video.element)!;
    expect(snapshot).toMatchObject({
      videoWidth: null,
      videoHeight: null,
      totalFrames: null,
      droppedFrames: null,
      bufferedAheadSeconds: null,
      currentLevel: null,
      nextAutoLevel: null,
      bandwidthEstimate: null,
      ttfbEstimate: null,
      availableLevelCount: 65,
      levelsTruncated: true,
    });
    expect(snapshot.availableLevels).toHaveLength(64);
    expect(snapshot.availableLevels[0]?.videoCodec).toBeNull();
    await engine.dispose();
  });
  it('records the start stages from hls.js events without changing playback (measurement only)', async () => {
    const video = new Video();
    startTiming.begin('player');
    const engine = createBrowserEngine(video.element, () => {});
    await engine.start(selection, new AbortController().signal);
    const hls = mocked.owners.at(-1)!;
    const at = performance.now();
    const stats = (start: number, first: number, end: number) => ({
      loading: { start: at + start, first: at + first, end: at + end },
      loaded: 900000,
    });
    hls.handlers.get('manifest-loaded')?.('manifest-loaded', {
      stats: stats(10, 300, 320),
      levels: [{}, {}],
    });
    hls.handlers.get('level-loaded')?.('level-loaded', {
      stats: stats(330, 600, 610),
      details: { fragments: [{}, {}, {}], targetduration: 6 },
    });
    // An audio segment is not the first picture segment.
    hls.handlers.get('fragment-loaded')?.('fragment-loaded', {
      frag: { type: 'audio', stats: stats(1, 2, 3) },
    });
    hls.handlers.get('fragment-loaded')?.('fragment-loaded', {
      frag: { type: 'main', duration: 6, stats: stats(620, 1400, 2900) },
    });
    hls.handlers.get('fragment')?.('fragment', { frag: { type: 'main' } });
    // Malformed event data is not recorded and does not throw.
    hls.handlers.get('fragment-loaded')?.('fragment-loaded', {});
    video.dispatchEvent(new Event('loadeddata'));
    video.dispatchEvent(new Event('playing'));
    const record = startTiming.snapshot().at(-1)!;
    const stages = record.stages;
    expect(Object.keys(stages)).toEqual(
      expect.arrayContaining([
        'source-known',
        'library-ready',
        'manifest-request',
        'manifest-first-byte',
        'manifest-loaded',
        'playlist-loaded',
        'first-segment-request',
        'first-segment-first-byte',
        'first-segment-loaded',
        'first-segment-buffered',
        'first-decodable-frame',
        'playing-event',
      ]),
    );
    expect(stages['first-segment-loaded']! - stages['first-segment-request']!).toBe(2280);
    expect(stages['manifest-first-byte']! - stages['manifest-request']!).toBe(290);
    expect(record.facts).toMatchObject({
      'manifest-levels': 2,
      'playlist-segments': 3,
      'target-duration': 6,
      'first-segment-bytes': 900000,
      'first-segment-seconds': 6,
    });
    await engine.dispose();
  });
  it('old cleanup cannot unregister replacement quality ownership', async () => {
    const video = new Video();
    const old = createBrowserEngine(video.element, () => {});
    await old.start(selection, new AbortController().signal);
    const next = createBrowserEngine(video.element, () => {});
    await next.start(selection, new AbortController().signal);
    await old.dispose();
    expect(readVideoQuality(video.element)).not.toBeNull();
    await next.dispose();
    expect(readVideoQuality(video.element)).toBeNull();
  });
  it('quality selection validates active advertised indices, preserves Auto and resets event snapshots by ownership', async () => {
    const video = new Video(),
      snapshots: unknown[] = [];
    video.addEventListener(VIDEO_QUALITY_CHANGE, (event) =>
      snapshots.push((event as CustomEvent).detail),
    );
    expect(setVideoQuality(video.element, 0)).toBe(false);
    const old = createBrowserEngine(video.element, () => {});
    await old.start(selection, new AbortController().signal);
    const hls = mocked.owners.at(-1)!;
    Object.assign(hls, {
      levels: [{ width: 426, height: 240, bitrate: 300000 }],
      autoLevelEnabled: true,
      nextLevel: -1,
      currentLevel: 0,
    });
    for (const index of [-1, 1, NaN, Infinity, 0.5])
      expect(setVideoQuality(video.element, index)).toBe(false);
    expect(setVideoQuality(video.element, 0)).toBe(true);
    expect(Reflect.get(hls, 'nextLevel')).toBe(0);
    expect(setVideoQuality(video.element, null)).toBe(true);
    expect(Reflect.get(hls, 'nextLevel')).toBe(-1);
    expect(Reflect.get(hls, 'currentLevel')).toBe(0);
    hls.handlers.get('level')?.('level', { url: 'secret' });
    hls.handlers.get('fragment')?.('fragment', { url: 'secret' });
    expect(JSON.stringify(snapshots)).not.toContain('secret');
    expect(snapshots[0]).toBeNull();
    const next = createBrowserEngine(video.element, () => {});
    await next.start(selection, new AbortController().signal);
    const nextHls = mocked.owners.at(-1)!;
    Object.assign(nextHls, {
      levels: [{ width: 1280, height: 720, bitrate: 2000000 }],
      nextLevel: -1,
    });
    const count = snapshots.length;
    await old.dispose();
    hls.handlers.get('fragment')?.('fragment', {});
    expect(snapshots).toHaveLength(count);
    expect(setVideoQuality(video.element, 0)).toBe(true);
    expect(Reflect.get(nextHls, 'nextLevel')).toBe(0);
    await next.dispose();
    expect(snapshots.at(-1)).toBeNull();
    expect(setVideoQuality(video.element, 0)).toBe(false);
  });
  it('clears and disables detached old caption objects before HLS destruction removes their list entries', async () => {
    const video = new Video();
    const old = {
      kind: 'captions',
      mode: 'showing',
      cues: [] as object[],
      removeCue(cue: object) {
        this.cues.splice(this.cues.indexOf(cue), 1);
      },
    };
    const metadata = { kind: 'metadata', mode: 'hidden', cues: [{}], removeCue: vi.fn() };
    video.textTracks = [old, metadata];
    const engine = createBrowserEngine(video.element, () => {});
    await engine.start(selection, new AbortController().signal);
    old.mode = 'showing';
    old.cues.push({}, {});
    mocked.owners.at(-1)!.destroy.mockImplementation(() => {
      expect(old.mode).toBe('disabled');
      expect(old.cues).toEqual([]);
      video.textTracks = [];
    });
    await engine.dispose();
    expect(old.mode).toBe('disabled');
    expect(old.cues).toEqual([]);
    expect(metadata.cues).toHaveLength(1);
    expect(metadata.removeCue).not.toHaveBeenCalled();
  });
  it('retains rejected old-track cleanup when destroy detaches it and confirms it on retry', async () => {
    const video = new Video();
    let refuse = false;
    const old = {
      kind: 'subtitles',
      mode: 'showing',
      cues: [] as object[],
      removeCue(cue: object) {
        if (refuse) throw new Error('refused');
        this.cues.splice(this.cues.indexOf(cue), 1);
      },
    };
    video.textTracks = [old];
    const engine = createBrowserEngine(video.element, () => {});
    await engine.start(selection, new AbortController().signal);
    old.mode = 'showing';
    old.cues.push({});
    refuse = true;
    mocked.owners.at(-1)!.destroy.mockImplementation(() => {
      video.textTracks = [];
    });
    expect(() => engine.dispose()).toThrow('cleanup did not finish');
    expect(old.mode).toBe('disabled');
    expect(old.cues).toHaveLength(1);
    refuse = false;
    await engine.dispose();
    expect(old.mode).toBe('disabled');
    expect(old.cues).toEqual([]);
  });
  it('clears only caption/subtitle cues across selection, failure and stop; reused tracks accept new cues', async () => {
    const video = new Video();
    const caption = {
      kind: 'captions',
      mode: 'showing',
      cues: [{}],
      removeCue(cue: object) {
        this.cues.splice(this.cues.indexOf(cue), 1);
      },
    };
    const metadata = { kind: 'metadata', mode: 'hidden', cues: [{}], removeCue: vi.fn() };
    video.textTracks = [caption, metadata];
    const resets = vi.fn();
    video.addEventListener('caption-session-reset', resets);
    const controller = new PlaybackController((emit) => createBrowserEngine(video.element, emit));
    await controller.select(selection);
    expect(caption.cues).toEqual([]);
    expect(caption.mode).toBe('disabled');
    const firstCue = {};
    caption.cues.push(firstCue);
    caption.mode = 'showing';
    await controller.select({ ...selection, id: '2', name: 'Programming will be back' });
    expect(caption.cues).toEqual([]);
    expect(caption.mode).toBe('disabled');
    const nextCue = {};
    caption.cues.push(nextCue);
    caption.mode = 'showing';
    expect(caption.cues).toEqual([nextCue]);
    video.error = { code: 4 };
    video.dispatchEvent(new Event('error'));
    await controller.stop();
    expect(caption.cues).toEqual([]);
    expect(caption.mode).toBe('disabled');
    expect(metadata.cues).toHaveLength(1);
    expect(metadata.mode).toBe('hidden');
    expect(metadata.removeCue).not.toHaveBeenCalled();
    expect(resets.mock.calls.length).toBeGreaterThanOrEqual(3);
    await controller.dispose();
  });
  it('stale engine cleanup cannot clear cues installed by the newer video owner', async () => {
    const video = new Video();
    const track = {
      kind: 'subtitles',
      mode: 'disabled',
      cues: [] as object[],
      removeCue(cue: object) {
        this.cues.splice(this.cues.indexOf(cue), 1);
      },
    };
    video.textTracks = [track];
    const old = createBrowserEngine(video.element, () => {});
    await old.start(selection, new AbortController().signal);
    const newer = createBrowserEngine(video.element, () => {});
    await newer.start({ ...selection, id: '2' }, new AbortController().signal);
    const cue = {};
    track.cues.push(cue);
    await old.dispose();
    expect(track.cues).toEqual([cue]);
    await newer.dispose();
    expect(track.cues).toEqual([]);
  });
  it('retains failed composite listener cleanup without throwing from abort events and retries release', async () => {
    const owners = createResourceOwners();
    const source = new AbortController();
    const video = new Video();
    let fail = true;
    const remove = source.signal.removeEventListener.bind(source.signal);
    vi.spyOn(source.signal, 'removeEventListener').mockImplementation((...args) => {
      if (fail) throw new Error('private source diagnostics');
      remove(...args);
    });
    const engine = createBrowserEngine(video.element, () => {}, undefined, { owners });
    await engine.start({ ...selection, mediaKind: 'media', mediaMime: 'video/mp4' }, source.signal);
    expect(() => source.abort()).not.toThrow();
    expect(video.paused).toBe(true);
    expect(() => engine.dispose()).toThrow('cleanup did not finish');
    expect(owners.snapshot().counts.browserEngines).toBe(1);
    expect(owners.snapshot().counts.abortListeners).toBe(1);
    fail = false;
    await engine.dispose();
    expect(owners.snapshot().counts.browserEngines).toBe(0);
    expect(owners.snapshot().counts.abortListeners).toBe(0);
  });
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
  const profiles = [
    [undefined, 20, 40, undefined, 1024 * 1024],
    ['balanced', 20, 40, undefined, 1024 * 1024],
    ['fast', 10, 20, 2, 512 * 1024],
    ['smooth', 45, 90, 5, 3 * 1024 * 1024],
    // An unknown value falls back to the balanced baseline.
    ['huge', 20, 40, undefined, 1024 * 1024],
  ] as const;
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
  const live = {
    id: 'live',
    name: 'Live',
    url: 'https://example.test/live.mp4',
    mediaKind: 'media' as const,
    mediaMime: 'video/mp4',
  };
  function element(ahead: { seconds: number }) {
    const video = new Video();
    video.canPlayType = () => 'maybe';
    Object.defineProperty(video, 'buffered', {
      get: () => ({
        length: 1,
        start: () => 0,
        end: () => video.currentTime + ahead.seconds,
      }),
    });
    return video;
  }
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
  const played = (video: Video) => {
    video.currentTime += 1;
    video.dispatchEvent(new Event('timeupdate'));
  };
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
