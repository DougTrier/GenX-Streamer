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
 * Browser engine resource contract: quality levels, start stages, captions
 * and native loaders.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  VIDEO_QUALITY_CHANGE,
  createBrowserEngine,
  readVideoQuality,
  setVideoQuality,
} from '../../src/platform/browser-engine';
import { startTiming } from '../../src/playback/start-timing';
import { PlaybackController } from '../../src/playback/controller';
import { createResourceOwners } from '../../src/playback/resource-owners';
import { Video, selection } from './browser-engine.fixture';

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
});
