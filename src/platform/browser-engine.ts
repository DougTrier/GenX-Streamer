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

import type Hls from 'hls.js';
import type Mpegts from 'mpegts.js';
import { createBrowserAudioTracks } from './browser-audio-tracks';
import { createBrowserAudioHealth } from './browser-audio-health';
export { AUDIO_HEALTH_CHANGE, readAudioHealth } from './browser-audio-health';
export { AUDIO_TRACKS_CHANGE, readAudioTracks, setAudioTrack } from './browser-audio-tracks';
import { classifyHttpFailure, classifyTransportFailure } from '../playback/failure';
import { createOwnedAbortSignals } from './abort';
import { createAdaptiveBuffer, learnedLiveBuffer } from '../playback/adaptive-buffer';
import {
  REPLAY_RATES,
  replayWindowFrom,
  validDecodedProgress,
  VOD_POSITION_LIMIT,
  type DecodedSample,
  type LiveReplayEngine,
} from '../playback/controller';
import type {
  EngineEvent,
  EngineFactory,
  PlaybackEngine,
  PlaybackFailure,
  ChannelSelection,
} from '../playback/controller';
import { readConfiguredSource, SourceRequestError, type ConfiguredSource } from '../sources';
import { isTauri } from '@tauri-apps/api/core';
import { createNativeHlsSession, type NativeMediaTransport } from './native-hls-loader';
import { transportVideoFormat } from '../playback/transport-video';
import { startTiming } from '../playback/start-timing';
import {
  createOwnedWork,
  playbackResourceOwners,
  type ResourceOwners,
} from '../playback/resource-owners';
/** Radio servers label ADTS AAC/MP3 with legacy names the WebView does not recognize. */
const STANDARD_MIME: Readonly<Record<string, string>> = {
  'audio/aacp': 'audio/aac',
  'audio/x-aac': 'audio/aac',
  'audio/mp3': 'audio/mpeg',
};
export type PlaybackSourceReader = (url: string, signal: AbortSignal) => Promise<ConfiguredSource>;
const mediaAttachmentOwners = new WeakMap<
  HTMLVideoElement,
  { token: object; anonymous: boolean }
>();
const captionOwners = new WeakMap<HTMLVideoElement, object>();
export interface VideoQualitySnapshot {
  auto: boolean;
  videoWidth: number | null;
  videoHeight: number | null;
  totalFrames: number | null;
  droppedFrames: number | null;
  bufferedAheadSeconds: number | null;
  currentLevel: number | null;
  nextAutoLevel: number | null;
  bandwidthEstimate: number | null;
  ttfbEstimate: number | null;
  availableLevelCount: number;
  levelsTruncated: boolean;
  availableLevels: ReadonlyArray<
    Readonly<{
      index: number;
      width: number | null;
      height: number | null;
      bitrate: number | null;
      videoCodec: string | null;
      audioCodec: string | null;
    }>
  >;
}
/** Start timing is measurement only: a malformed event must never reach playback. */
const measure = (work: () => void): void => {
  try {
    work();
  } catch {
    // The stage is simply not recorded.
  }
};
const qualityReaders = new WeakMap<HTMLVideoElement, () => Readonly<VideoQualitySnapshot> | null>();
const qualitySetters = new WeakMap<HTMLVideoElement, (index: number | null) => boolean>();
export const VIDEO_QUALITY_CHANGE = 'video-quality-change';
export function setVideoQuality(video: HTMLVideoElement, index: number | null): boolean {
  try {
    return qualitySetters.get(video)?.(index) ?? false;
  } catch {
    return false;
  }
}
/** No stream identity, network address, or mutable engine handle crosses this boundary. */
export function readVideoQuality(video: HTMLVideoElement): Readonly<VideoQualitySnapshot> | null {
  try {
    return qualityReaders.get(video)?.() ?? null;
  } catch {
    return null;
  }
}
const browserSourceReader: PlaybackSourceReader = (url, signal) =>
  readConfiguredSource(url, false, signal);
export interface BrowserEngineOptions {
  allowHttp?: (selectionUrl: string) => boolean;
  /** Session-scoped transports may refuse requests outside their issued capabilities. */
  requestAllowed?: (url: string) => boolean;
  nativeTransport?: NativeMediaTransport;
  loadHls?: () => Promise<typeof Hls>;
  loadMpegts?: () => Promise<typeof Mpegts>;
  /** Prefer the controlled MSE loader when native HLS support is incomplete. */
  preferNativeHls?: boolean;
  monotonicNow?: () => number;
  owners?: ResourceOwners;
}

export { classifyHttpFailure } from '../playback/failure';
export function readRetryAfter(details: unknown): string | null {
  if (!details || typeof details !== 'object') return null;
  try {
    if ('getResponseHeader' in details && typeof details.getResponseHeader === 'function') {
      const value: unknown = details.getResponseHeader('Retry-After');
      return typeof value === 'string' ? value : null;
    }
    if (
      'headers' in details &&
      details.headers &&
      typeof details.headers === 'object' &&
      'get' in details.headers &&
      typeof details.headers.get === 'function'
    ) {
      const value: unknown = details.headers.get('Retry-After');
      return typeof value === 'string' ? value : null;
    }
  } catch {
    /* Browser policy may deny access to a response header. */
  }
  return null;
}

/**
 * Live buffering per profile. Balanced is the established baseline; the HLS
 * buffer (seconds ahead) and the MPEG-TS stash (bytes before playback) act at
 * different layers, so each is tuned on its own. Unknown values are balanced.
 */
export function liveBufferProfile(buffer: unknown) {
  const profile: 'fast' | 'balanced' | 'smooth' =
    buffer === 'fast' || buffer === 'smooth' ? buffer : 'balanced';
  return {
    profile,
    hls: {
      maxBufferLength: profile === 'fast' ? 10 : profile === 'smooth' ? 45 : 20,
      maxMaxBufferLength: profile === 'fast' ? 20 : profile === 'smooth' ? 90 : 40,
      ...(profile === 'fast' ? { liveSyncDurationCount: 2 } : {}),
      ...(profile === 'smooth' ? { liveSyncDurationCount: 5 } : {}),
    },
    mpegtsStash:
      profile === 'fast' ? 512 * 1024 : profile === 'smooth' ? 3 * 1024 * 1024 : 1024 * 1024,
  };
}
/**
 * Already-played live MPEG-TS media kept in the video buffer. mpegts.js keeps
 * two to three minutes by default, which on a 1.7 GB TV is over 100 MB of
 * renderer memory per channel. Instant replay reaches back 30 s (REPLAY01), so
 * 30 s always stays (trimmed once it reaches 40 s), like hls.js below.
 */
export const MPEGTS_BACK_BUFFER = {
  autoCleanupMaxBackwardDuration: 40,
  autoCleanupMinBackwardDuration: 30,
} as const;
/** Already-played HLS media kept for instant replay (REPLAY01; was 15 s). */
export const HLS_BACK_BUFFER_SECONDS = 30;
export function createBrowserEngineFactory(
  video: HTMLVideoElement,
  inspect: PlaybackSourceReader = browserSourceReader,
  options: BrowserEngineOptions = {},
): EngineFactory {
  return (emit) => createBrowserEngine(video, emit, inspect, options);
}

export function createBrowserEngine(
  video: HTMLVideoElement,
  emit: (event: EngineEvent) => void,
  inspect: PlaybackSourceReader = browserSourceReader,
  options: BrowserEngineOptions = {},
): PlaybackEngine {
  const owners = options.owners ?? playbackResourceOwners;
  owners.cover('browser-engine');
  const releaseEngine = owners.acquire('browserEngines');
  const initialization = createOwnedWork(owners);
  const attachmentToken = {};
  let nativeSession: ReturnType<typeof createNativeHlsSession> | null = null;
  let drainPromise: Promise<void> | null = null;
  let releaseHls: (() => void) | null = null;
  const hlsListeners: Array<() => void> = [];
  let releaseAbortListener: (() => void) | null = null;
  let hls: Hls | null = null;
  /** Live MPEG-TS (most IPTV providers' `.ts` output) transmuxed for MSE playback. */
  let tsPlayer: Mpegts.Player | null = null;
  let releaseTsPlayer: (() => void) | null = null;
  const qualityReader = (): Readonly<VideoQualitySnapshot> | null => {
    if (disposed || !readyToPlay) return null;
    const finite = (value: unknown): number | null =>
      typeof value === 'number' && Number.isFinite(value) ? value : null;
    const nonnegative = (value: unknown): number | null => {
      const result = finite(value);
      return result !== null && result >= 0 ? result : null;
    };
    const codec = (value: unknown): string | null =>
      typeof value === 'string' && /^[A-Za-z0-9._,-]{1,128}$/.test(value) ? value : null;
    let totalFrames: number | null = null,
      droppedFrames: number | null = null,
      bufferedAheadSeconds: number | null = null;
    try {
      const quality = video.getVideoPlaybackQuality?.();
      if (
        quality &&
        Number.isSafeInteger(quality.totalVideoFrames) &&
        Number.isSafeInteger(quality.droppedVideoFrames) &&
        quality.droppedVideoFrames >= 0 &&
        quality.totalVideoFrames >= quality.droppedVideoFrames
      ) {
        totalFrames = quality.totalVideoFrames;
        droppedFrames = quality.droppedVideoFrames;
      }
    } catch {
      /* Some WebViews do not expose frame counters. */
    }
    try {
      if (Number.isFinite(video.currentTime)) {
        bufferedAheadSeconds = 0;
        for (let index = 0; index < video.buffered.length; index++) {
          const start = video.buffered.start(index),
            end = video.buffered.end(index);
          if (
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            start <= video.currentTime &&
            end >= video.currentTime
          ) {
            bufferedAheadSeconds = end - video.currentTime;
            break;
          }
        }
      }
    } catch {
      bufferedAheadSeconds = null;
    }
    const levels = hls?.levels ?? [];
    const availableLevels = Object.freeze(
      levels.slice(0, 64).map((level, index) =>
        Object.freeze({
          index,
          width: nonnegative(level.width),
          height: nonnegative(level.height),
          bitrate: nonnegative(level.bitrate),
          videoCodec: codec(level.videoCodec),
          audioCodec: codec(level.audioCodec),
        }),
      ),
    );
    return Object.freeze({
      auto: hls?.autoLevelEnabled !== false,
      videoWidth: nonnegative(video.videoWidth),
      videoHeight: nonnegative(video.videoHeight),
      totalFrames,
      droppedFrames,
      bufferedAheadSeconds,
      currentLevel: finite(hls?.currentLevel),
      nextAutoLevel: finite(hls?.nextAutoLevel),
      bandwidthEstimate: nonnegative(hls?.bandwidthEstimate),
      ttfbEstimate: nonnegative(hls?.ttfbEstimate),
      availableLevelCount: levels.length,
      levelsTruncated: levels.length > availableLevels.length,
      availableLevels,
    });
  };
  const notifyQuality = (): void => {
    if (qualityReaders.get(video) === qualityReader)
      video.dispatchEvent(
        new CustomEvent(VIDEO_QUALITY_CHANGE, { detail: readVideoQuality(video) }),
      );
  };
  const qualitySetter = (index: number | null): boolean => {
    if (disposed || !readyToPlay || !hls || qualityReaders.get(video) !== qualityReader)
      return false;
    if (index === null) hls.nextLevel = -1;
    else {
      if (!Number.isSafeInteger(index) || index < 0 || index >= hls.levels.length) return false;
      hls.nextLevel = index;
    }
    notifyQuality();
    return true;
  };
  const captionOwner = {};
  const pendingCaptionTracks = new Set<TextTrack>();
  const resetCaptions = (): void => {
    if (captionOwners.get(video) !== captionOwner) return;
    // The caption selector must release user-enabled state before native track
    // change events; persistent TextTracks can be reused by the next HLS owner.
    video.dispatchEvent(new Event('caption-session-reset'));
    for (const track of Array.from(video.textTracks ?? [])) {
      if (track.kind !== 'captions' && track.kind !== 'subtitles') continue;
      pendingCaptionTracks.add(track);
    }
    // Retain failed track cleanup even if HLS removes it from textTracks.
    for (const track of pendingCaptionTracks) {
      if (track.mode === 'disabled') track.mode = 'hidden';
      const cues = Array.from(track.cues ?? []);
      try {
        for (const cue of cues) track.removeCue(cue);
      } finally {
        track.mode = 'disabled';
      }
      pendingCaptionTracks.delete(track);
    }
  };
  const ownedAbort = new AbortController();
  let disposed = false;
  let signal: AbortSignal | null = null;
  let signalOwner: ReturnType<typeof createOwnedAbortSignals> | null = null;
  let cancelInitialization: (() => void) | null = null;
  let previousTime = 0;
  let previousDecoded: { sample: DecodedSample; at: number } | null = null;
  const decodedSample = (): { sample: DecodedSample; at: number } | null => {
    if (
      video.paused ||
      video.seeking ||
      video.readyState < 2 ||
      typeof video.getVideoPlaybackQuality !== 'function'
    )
      return null;
    try {
      const quality = video.getVideoPlaybackQuality();
      if (
        ![quality.totalVideoFrames, quality.droppedVideoFrames].every(
          (value) => Number.isSafeInteger(value) && value >= 0,
        ) ||
        quality.droppedVideoFrames > quality.totalVideoFrames
      )
        return null;
      const at = (options.monotonicNow ?? (() => performance.now()))();
      if (!Number.isFinite(at) || at < 0) return null;
      return {
        sample: {
          mediaTime: video.currentTime,
          decodedFrames: quality.totalVideoFrames - quality.droppedVideoFrames,
          width: video.videoWidth,
          height: video.videoHeight,
        },
        at,
      };
    } catch {
      return null;
    }
  };
  let desiredPaused = false;
  let readyToPlay = false;
  let finiteMode = false;
  // Live buffering profile for this selection (balanced unless chosen).
  let buffer: NonNullable<ChannelSelection['buffer']> = 'balanced';
  // Adaptive live rebuffering (playback/adaptive-buffer.ts): live only.
  let adaptive: ReturnType<typeof createAdaptiveBuffer> | null = null;
  let adaptiveChannel = '';
  let holdTimer: ReturnType<typeof setInterval> | null = null;
  let releaseHoldTimer: (() => void) | null = null;
  // Holds apply only once this stream has played: during startup the first
  // play() is still pending, and pausing then cancels it (start fails).
  let livePlayed = false;
  let pendingSeek: { target: number; finish(result: 'seeked' | 'unavailable'): void } | null = null;
  // Instant replay (REPLAY01): null while playing live normally. `latency` is
  // how far the picture ran behind the newest buffered moment when replay
  // began, restored when it returns to live.
  let replay: { rate: number; paused: boolean; latency: number } | null = null;
  // Until then, waiting is the jump back to live after a replay, not a stall:
  // it must not raise this channel's learned buffer (adaptive-buffer.ts).
  let rejoiningUntil = 0;
  let userMuted = false;
  // Seconds per picture, measured from the decoder's frame counter at 1x.
  let framePeriod: number | null = null;
  let frameSample: { media: number; frames: number } | null = null;
  const applySound = (): void => {
    if (!disposed) video.muted = userMuted || (replay !== null && replay.rate < 1);
  };
  const bufferedRanges = (): Array<[number, number]> => {
    const ranges: Array<[number, number]> = [];
    try {
      for (let i = 0; i < Math.min(video.buffered.length, 64); i++)
        ranges.push([video.buffered.start(i), video.buffered.end(i)]);
    } catch {
      return [];
    }
    return ranges;
  };
  const endReplay = (): void => {
    if (!replay) return;
    replay = null;
    if (!disposed) video.playbackRate = 1;
    applySound();
  };
  const vodRanges = (): Array<[number, number]> | null => {
    if (
      !finiteMode ||
      disposed ||
      signal?.aborted ||
      !readyToPlay ||
      video.readyState < 1 ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0 ||
      video.duration > VOD_POSITION_LIMIT
    )
      return null;
    try {
      const ranges = video.seekable;
      if (!Number.isInteger(ranges.length) || ranges.length < 1 || ranges.length > 64) return null;
      const result: Array<[number, number]> = [];
      for (let i = 0; i < ranges.length; i++) {
        const start = ranges.start(i),
          end = ranges.end(i);
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end < start ||
          end > video.duration
        )
          return null;
        result.push([start, end]);
      }
      return result;
    } catch {
      return null;
    }
  };
  const listeners: Array<[string, EventListener, () => void]> = [];
  const listen = (type: string, listener: EventListener): void => {
    video.addEventListener(type, listener);
    listeners.push([type, listener, owners.acquire('videoListeners')]);
  };
  const report = (event: EngineEvent): void => {
    if (!disposed && !signal?.aborted) emit(event);
  };
  // Seconds of media buffered ahead of the playing position.
  const aheadSeconds = (): number => {
    const ranges = video.buffered;
    const now = video.currentTime;
    for (let i = 0; i < (ranges?.length ?? 0); i++)
      if (ranges.start(i) <= now + 0.1 && now <= ranges.end(i)) return ranges.end(i) - now;
    return 0;
  };
  const endHold = (resume: boolean): void => {
    if (holdTimer === null) return;
    clearInterval(holdTimer);
    holdTimer = null;
    releaseHoldTimer?.();
    releaseHoldTimer = null;
    if (resume && !disposed && !signal?.aborted && !desiredPaused && !replay?.paused)
      void video.play().catch(() => undefined);
  };
  // A live stall: wait for the adaptive goal before resuming, instead of
  // resuming on the first frame and stalling again (stop-start jitter). The
  // goal rises with each stall and never steps down for this channel.
  const hold = (): void => {
    // A replay seek is not a live stall: it must not raise this channel's
    // learned buffer or pause a replay the viewer is watching.
    if (
      !adaptive ||
      !livePlayed ||
      holdTimer !== null ||
      replay ||
      Date.now() < rejoiningUntil ||
      desiredPaused ||
      disposed ||
      signal?.aborted
    )
      return;
    learnedLiveBuffer.set(adaptiveChannel, adaptive.stalled());
    const started = Date.now();
    video.pause();
    releaseHoldTimer = owners.acquire('loaderTimers');
    holdTimer = setInterval(() => {
      if (disposed || signal?.aborted) return endHold(false);
      if (adaptive!.ready(aheadSeconds()) || Date.now() - started >= adaptive!.holdLimitMs)
        endHold(true);
    }, 250);
  };
  const audioHealth = createBrowserAudioHealth(video, {
    current: () => !disposed && !signal?.aborted && qualityReaders.get(video) === qualityReader,
    now: options.monotonicNow,
  });
  const audio = createBrowserAudioTracks(video, {
    current: () => !disposed && !signal?.aborted && qualityReaders.get(video) === qualityReader,
    canSelect: () => readyToPlay,
    emit: (snapshot) => {
      const selected = snapshot?.tracks.find((track) => track.selected);
      audioHealth.tracks(
        snapshot,
        selected ? hls?.audioTracks?.[selected.index]?.groupId : undefined,
      );
      report({ type: 'audio-tracks', snapshot });
    },
    owners,
  });
  const unsupported = (): void =>
    report({
      type: 'error',
      failure: {
        code: 'unsupported',
        message:
          'This format is not supported by this player. Choose another stream for this channel.',
        retryable: false,
      },
    });
  // MPEG-2 pictures: the web player would play only the sound. Android's own
  // player takes these channels over (routing-engine); elsewhere say why.
  let mpegReported = false;
  const inspectFragment = (bytes: Uint8Array): void => {
    if (mpegReported || transportVideoFormat(bytes) !== 'mpeg2') return;
    mpegReported = true;
    report({
      type: 'error',
      failure: {
        code: 'unsupported',
        message:
          'This channel sends its picture as MPEG-2, which this player cannot show. It plays in GenX on Android TVs and phones.',
        retryable: false,
        phase: 'decode',
        evidence: 'media',
        nativeFormat: 'mpeg2',
      },
    });
  };
  const decodeFailure = (): void =>
    report({
      type: 'error',
      failure: {
        code: 'decode',
        message: 'This device could not decode the stream. Try another stream for this channel.',
        retryable: false,
        phase: 'decode',
        evidence: 'media',
      },
    });
  let cleanupRunning = false;
  let cleanupComplete = false;
  const completedCleanup = new Set<string>();
  const cleanup = (): Error[] => {
    if (cleanupComplete || cleanupRunning) return [];
    // The video element outlives this engine: never leave it slowed or muted.
    endReplay();
    disposed = true;
    endHold(false);
    if (qualityReaders.get(video) === qualityReader) {
      notifyQuality();
      qualityReaders.delete(video);
      qualitySetters.delete(video);
    }
    previousDecoded = null;
    cleanupRunning = true;
    const failures: Error[] = [];
    const stage = (name: string, work: () => void): void => {
      if (completedCleanup.has(name)) return;
      try {
        work();
        completedCleanup.add(name);
      } catch {
        // Only fixed stage labels escape; thrown library/browser errors can carry source secrets.
        failures.push(new Error(`Playback cleanup stage failed: ${name}.`));
      }
    };
    try {
      stage('finite-seek', () => pendingSeek?.finish('unavailable'));
      stage('abort', () => ownedAbort.abort());
      stage('composite-signal', () => signalOwner?.dispose());
      stage('initialization', () => {
        cancelInitialization?.();
        cancelInitialization = null;
      });
      stage('abort-listener', () => {
        signal?.removeEventListener('abort', disposeOnAbort);
        releaseAbortListener?.();
      });
      const pendingListeners: typeof listeners = [];
      for (const [type, listener, release] of listeners) {
        try {
          video.removeEventListener(type, listener);
          release();
        } catch {
          pendingListeners.push([type, listener, release]);
          failures.push(new Error('Playback cleanup stage failed: video-listener.'));
        }
      }
      listeners.splice(0, listeners.length, ...pendingListeners);
      stage('native-loaders', () => nativeSession?.close());
      stage('audio-health', () => audioHealth.dispose());
      stage('audio-tracks', () => audio.dispose());
      stage('caption-cues-before-hls', resetCaptions);
      stage('mpegts', () => {
        const player = tsPlayer;
        tsPlayer = null;
        if (player) {
          player.pause();
          player.unload();
          player.detachMediaElement();
          player.destroy();
        }
        releaseTsPlayer?.();
        releaseTsPlayer = null;
      });
      stage('hls', () => {
        hls?.destroy();
        hls = null;
        releaseHls?.();
        for (const release of hlsListeners) release();
        hlsListeners.length = 0;
      });
      stage('caption-cues', resetCaptions);
      const ownsAttachment = () => mediaAttachmentOwners.get(video)?.token === attachmentToken;
      stage('video-pause', () => {
        if (ownsAttachment()) video.pause();
      });
      stage('video-source', () => {
        if (ownsAttachment()) video.removeAttribute('src');
      });
      stage('video-crossorigin', () => {
        const current = mediaAttachmentOwners.get(video);
        if (
          current?.token === attachmentToken &&
          current.anonymous &&
          video.crossOrigin === 'anonymous'
        )
          video.removeAttribute('crossorigin');
      });
      stage('video-reset', () => {
        if (ownsAttachment()) video.load();
      });
      if (!failures.length && ownsAttachment()) mediaAttachmentOwners.delete(video);
      cleanupComplete = failures.length === 0;
      return failures;
    } finally {
      cleanupRunning = false;
    }
  };
  const dispose = (): void | Promise<void> => {
    if (cleanupRunning)
      throw new Error('Playback cleanup is already running. Retry releasing the player.');
    const failures = cleanup();
    if (failures.length) throw new AggregateError(failures, 'Playback cleanup did not finish.');
    if (drainPromise) return drainPromise;
    if (!initialization.pending() && !nativeSession?.pending()) {
      releaseEngine();
      return;
    }
    drainPromise = Promise.all([initialization.settled(), nativeSession?.settled()])
      .then(() => {
        releaseEngine();
      })
      .finally(() => {
        drainPromise = null;
      });
    return drainPromise;
  };
  const disposeOnAbort = (): void => {
    // Abort events are cancellation, not release acknowledgements. Keep failed
    // stages owned for the controller's explicit dispose/retry; never throw into
    // EventTarget (which reports listener exceptions outside its caller).
    cleanup();
  };
  const liveEdge = (): void => {
    const ranges = video.seekable;
    if (!ranges.length) return;
    const start = ranges.start(ranges.length - 1);
    const end = ranges.end(ranges.length - 1);
    if (video.currentTime < start || video.currentTime > end) {
      video.currentTime = Math.max(start, end - 2);
      previousTime = video.currentTime;
    }
  };
  const play = async (): Promise<void> => {
    if (desiredPaused || disposed || signal?.aborted) return;
    startTiming.mark('play-called');
    try {
      await video.play();
    } catch (error) {
      if (disposed || signal?.aborted || desiredPaused) return;
      const name = error instanceof DOMException ? error.name : '';
      report({
        type: 'error',
        failure: {
          code: name === 'NotSupportedError' ? 'unsupported' : 'unknown',
          message:
            name === 'NotAllowedError'
              ? 'Playback was blocked. Press Retry to start this channel.'
              : 'Playback could not start. Retry or choose another channel.',
          retryable: false,
        },
      });
    }
  };
  return {
    async start(selection: ChannelSelection, abortSignal: AbortSignal): Promise<void> {
      if (disposed || abortSignal.aborted) {
        await dispose();
        return;
      }
      if (selection.crossOrigin !== undefined && selection.crossOrigin !== 'anonymous') {
        unsupported();
        return;
      }
      const previousAttachment = mediaAttachmentOwners.get(video);
      if (selection.crossOrigin === 'anonymous') video.crossOrigin = 'anonymous';
      else if (previousAttachment?.anonymous && video.crossOrigin === 'anonymous')
        video.removeAttribute('crossorigin');
      mediaAttachmentOwners.set(video, {
        token: attachmentToken,
        anonymous: selection.crossOrigin === 'anonymous',
      });
      signalOwner = createOwnedAbortSignals([abortSignal, ownedAbort.signal], owners);
      finiteMode = selection.playMode === 'on-demand';
      buffer = liveBufferProfile(selection.buffer).profile;
      endHold(false);
      livePlayed = false;
      adaptiveChannel = selection.id;
      adaptive = finiteMode
        ? null
        : createAdaptiveBuffer(buffer, learnedLiveBuffer.get(selection.id));
      signal = signalOwner.signal;
      signal.addEventListener('abort', disposeOnAbort, { once: true });
      releaseAbortListener = owners.acquire('abortListeners');
      captionOwners.set(video, captionOwner);
      qualityReaders.set(video, qualityReader);
      qualitySetters.set(video, qualitySetter);
      audioHealth.activate();
      audio.activate();
      notifyQuality();
      resetCaptions();
      let url: URL;
      try {
        url = new URL(selection.url);
      } catch {
        unsupported();
        return;
      }
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
        unsupported();
        return;
      }
      if (options.requestAllowed && options.requestAllowed(selection.url) !== true) {
        report({
          type: 'error',
          failure: {
            code: 'policy',
            message: 'This playback session is no longer available. Choose the channel again.',
            retryable: false,
            phase: 'capability',
          },
        });
        return;
      }
      // Bind the grant to the selected configured source, including its referenced
      // manifests/keys/segments on other hosts. No per-segment catalog URL lookup.
      const allowHttp = options.allowHttp?.(selection.url) === true;
      if (url.protocol === 'http:' && !allowHttp) {
        report({
          type: 'error',
          failure: {
            code: 'access',
            message:
              'This source needs explicit permission to use HTTP. Update its source settings or choose an HTTPS stream.',
            retryable: false,
          },
        });
        return;
      }
      const confirmed = selection as ChannelSelection & {
        mediaKind?: 'hls' | 'media';
        mediaMime?: string;
      };
      let source: ConfiguredSource;
      try {
        source = confirmed.mediaKind
          ? { kind: confirmed.mediaKind, mime: confirmed.mediaMime }
          : await initialization.run('initializationWaits', () =>
              inspect === browserSourceReader
                ? readConfiguredSource(url.href, allowHttp, signal!)
                : inspect(url.href, signal!),
            );
      } catch (error) {
        if (disposed || abortSignal.aborted) return;
        report({
          type: 'error',
          failure:
            error instanceof SourceRequestError
              ? classifyHttpFailure(error.status, error.retryAfter)
              : classifyTransportFailure(error),
        });
        return;
      }
      if (disposed || abortSignal.aborted) return;
      if (source.kind !== 'hls' && source.kind !== 'media') {
        unsupported();
        return;
      }
      // Live MPEG-TS has no native element support; it plays through mpegts.js.
      const transportStream =
        source.kind === 'media' && source.mime === 'video/mp2t' && !finiteMode;
      if (
        source.kind === 'media' &&
        source.mime &&
        !transportStream &&
        !video.canPlayType(STANDARD_MIME[source.mime] ?? source.mime)
      ) {
        unsupported();
        return;
      }
      report({ type: 'capability', mediaKind: source.kind, mediaMime: source.mime });
      startTiming.mark('source-known');
      startTiming.fact('source-checked', !confirmed.mediaKind);
      // Measurement only: first decoded frame, first frame on screen, first play.
      listen('loadeddata', () => startTiming.mark('first-decodable-frame'));
      listen('playing', () => startTiming.mark('playing-event'));
      if (typeof video.requestVideoFrameCallback === 'function')
        video.requestVideoFrameCallback((at, frame) => {
          if (!disposed && !signal?.aborted)
            startTiming.mark('first-visible-frame', frame.expectedDisplayTime || at);
        });
      previousTime = video.currentTime;
      listen('timeupdate', () => {
        audioHealth.sample();
        const current = video.currentTime;
        if (
          !video.paused &&
          !video.seeking &&
          video.readyState >= 2 &&
          current > previousTime + 0.01
        ) {
          livePlayed = true;
          report({ type: 'progress' });
        }
        // Frame period at normal speed, for one-picture replay steps.
        if (!replay && !video.paused && !video.seeking && video.playbackRate === 1) {
          try {
            const frames = video.getVideoPlaybackQuality?.().totalVideoFrames;
            if (Number.isSafeInteger(frames)) {
              const media = current - (frameSample?.media ?? current);
              const count = frames! - (frameSample?.frames ?? frames!);
              if (frameSample && media >= 0.5 && media <= 5 && count > 0)
                framePeriod = media / count;
              if (!frameSample || media >= 0.5 || media < 0)
                frameSample = { media: current, frames: frames! };
            }
          } catch {
            frameSample = null;
          }
        }
        // Replay pictures are not live decoding health.
        const next = replay ? null : decodedSample();
        if (previousDecoded && next) {
          const evidence = {
            kind: 'decoded' as const,
            before: previousDecoded.sample,
            after: next.sample,
            elapsedMilliseconds: next.at - previousDecoded.at,
          };
          if (validDecodedProgress(evidence)) report({ type: 'decoded-progress', evidence });
        }
        previousDecoded = next;
        previousTime = current;
      });
      listen('volumechange', () => audioHealth.sample());
      listen('seeking', () => {
        previousDecoded = null;
        frameSample = null;
        previousTime = video.currentTime;
      });
      listen('seeked', () => {
        const pending = pendingSeek;
        if (
          pending &&
          !video.seeking &&
          Number.isFinite(video.currentTime) &&
          Math.abs(video.currentTime - pending.target) <= 0.1
        )
          pending.finish('seeked');
      });
      listen('pause', () => {
        previousDecoded = null;
      });
      listen('waiting', () => {
        previousDecoded = null;
        report({ type: 'buffering' });
        hold();
      });
      listen('stalled', () => {
        previousDecoded = null;
        report({ type: 'buffering' });
      });
      listen('ended', () => {
        // On-demand: finished. Live: the source closed the stream (providers
        // drop long sessions); the controller reconnects within its bounds.
        report({ type: 'ended' });
      });
      listen('error', () => {
        if (video.error?.code === 4) unsupported();
        else if (video.error?.code === 3) decodeFailure();
        else report({ type: 'error', failure: classifyHttpFailure(0) });
      });
      const isHls = source.kind === 'hls';
      const nativeHls = !!video.canPlayType('application/vnd.apple.mpegurl');
      if (isHls && (!nativeHls || options.preferNativeHls === false)) {
        let Library: typeof Hls | null;
        try {
          // Import cannot be canceled, but this owner's wait can. Late module
          // completion must never attach media after disposal or supersession.
          Library = await initialization.run(
            'initializationWaits',
            () =>
              new Promise<typeof Hls | null>((resolve, reject) => {
                let releaseWaitListener: (() => void) | null = null;
                const canceled = (): void => {
                  signal?.removeEventListener('abort', canceled);
                  releaseWaitListener?.();
                  resolve(null);
                };
                signal?.addEventListener('abort', canceled, { once: true });
                releaseWaitListener = owners.acquire('abortListeners');
                if (signal?.aborted) {
                  canceled();
                  return;
                }
                const load =
                  options.loadHls ?? (() => import('hls.js').then((module) => module.default));
                void Promise.resolve()
                  .then(load)
                  .then(
                    (library) => {
                      signal?.removeEventListener('abort', canceled);
                      releaseWaitListener?.();
                      resolve(library);
                    },
                    (error: unknown) => {
                      signal?.removeEventListener('abort', canceled);
                      releaseWaitListener?.();
                      reject(error);
                    },
                  );
              }),
          );
        } catch {
          report({
            type: 'error',
            failure: {
              code: 'unsupported',
              message:
                'The playback component could not load. Restart the application or choose another stream.',
              retryable: false,
            },
          });
          return;
        }
        if (!Library || disposed || signal?.aborted) return;
        startTiming.mark('library-ready');
        if (!Library.isSupported()) {
          if (nativeHls) {
            audio.attachNative();
            video.src = url.href;
            video.load();
            readyToPlay = true;
            audio.refresh();
            notifyQuality();
            await play();
            return;
          }
          unsupported();
          return;
        }
        // All retries belong to the controller's one bounded episode, never hidden library loops.
        const noRetry = {
          maxTimeToFirstByteMs: 8000,
          maxLoadTimeMs: 15000,
          timeoutRetry: null,
          errorRetry: null,
        };
        if (isTauri() || options.nativeTransport)
          nativeSession = createNativeHlsSession({
            allowHttp: () => allowHttp,
            inspectFragment,
            requestAllowed: options.requestAllowed,
            transport: options.nativeTransport,
            owners,
          });
        hls = new Library({
          enableWorker: true,
          // Admit the manifest first so the initial request uses the user's
          // highest-available default rather than a preliminary Auto estimate.
          autoStartLoad: false,
          // Fast start / balanced / extra smooth: seconds of media held ahead,
          // and how many segments behind the live edge playback starts.
          ...liveBufferProfile(buffer).hls,
          backBufferLength: HLS_BACK_BUFFER_SECONDS,
          ...(nativeSession ? { loader: nativeSession.Loader } : {}),
          manifestLoadPolicy: { default: noRetry },
          playlistLoadPolicy: { default: noRetry },
          fragLoadPolicy: { default: noRetry },
          keyLoadPolicy: { default: noRetry },
          steeringManifestLoadPolicy: { default: noRetry },
        });
        releaseHls = owners.acquire('hlsInstances');
        audio.attachHls(hls, Library.Events);
        for (const [event, observe] of [
          [Library.Events.BUFFER_CODECS, audioHealth.codecs],
          [Library.Events.BUFFER_CREATED, audioHealth.buffers],
        ] as const) {
          hls.on(event, (_name: unknown, data: unknown) => observe(data));
          hlsListeners.push(owners.acquire('hlsListeners'));
        }
        hls.on(Library.Events.LEVEL_SWITCHED, notifyQuality);
        hlsListeners.push(owners.acquire('hlsListeners'));
        hls.on(Library.Events.FRAG_BUFFERED, (_name, data) => {
          measure(() => {
            if (data.frag.type === 'main') startTiming.mark('first-segment-buffered');
          });
          notifyQuality();
        });
        hlsListeners.push(owners.acquire('hlsListeners'));
        // Measurement only: request, first byte and end of the manifest and the
        // first segment (the native loader reports its own first-byte time).
        hls.on(Library.Events.MANIFEST_LOADED, (_name, data) =>
          measure(() => {
            startTiming.mark('manifest-request', data.stats.loading.start);
            startTiming.mark('manifest-first-byte', data.stats.loading.first);
            startTiming.mark('manifest-loaded', data.stats.loading.end);
            startTiming.fact('manifest-levels', data.levels.length);
          }),
        );
        hls.on(Library.Events.LEVEL_LOADED, (_name, data) =>
          measure(() => {
            startTiming.mark('playlist-loaded', data.stats.loading.end);
            startTiming.fact('playlist-segments', data.details.fragments.length);
            startTiming.fact('target-duration', data.details.targetduration);
          }),
        );
        hls.on(Library.Events.FRAG_LOADED, (_name, data) =>
          measure(() => {
            if (data.frag.type !== 'main') return;
            const loading = data.frag.stats.loading;
            startTiming.mark('first-segment-request', loading.start);
            startTiming.mark('first-segment-first-byte', loading.first);
            startTiming.mark('first-segment-loaded', loading.end);
            startTiming.fact('first-segment-bytes', data.frag.stats.loaded);
            startTiming.fact('first-segment-seconds', data.frag.duration);
          }),
        );
        hlsListeners.push(...[1, 2, 3].map(() => owners.acquire('hlsListeners')));
        hls.on(Library.Events.ERROR, (_event, data) => {
          audioHealth.fault(data);
          if (!data.fatal) return;
          if (
            data.details === 'manifestIncompatibleCodecsError' ||
            data.details === 'bufferIncompatibleCodecsError'
          )
            unsupported();
          else if (data.type === Library.ErrorTypes.MEDIA_ERROR) decodeFailure();
          else {
            const status = data.response?.code ?? 0;
            const details = data.networkDetails as unknown;
            const transportError =
              details && typeof details === 'object' && 'playbackTransportError' in details
                ? details.playbackTransportError
                : data.response?.text;
            const failure: PlaybackFailure = status
              ? classifyHttpFailure(status, readRetryAfter(details))
              : /timeout/i.test(data.details) && !transportError
                ? { ...classifyTransportFailure('timeout'), evidence: 'opaque', phase: 'unknown' }
                : classifyTransportFailure(transportError);
            report({ type: 'error', failure });
          }
        });
        hlsListeners.push(owners.acquire('hlsListeners'));
        // A MediaSource may not be attached yet. Calling play before the manifest
        // can cause a false unsupported-format rejection on an otherwise valid HLS.
        await initialization.run(
          'initializationWaits',
          () =>
            new Promise<void>((resolve) => {
              let started = false;
              let releaseWaitListener: (() => void) | null = null;
              const canceled = (): void => {
                signal?.removeEventListener('abort', canceled);
                releaseWaitListener?.();
                cancelInitialization = null;
                resolve();
              };
              cancelInitialization = canceled;
              signal?.addEventListener('abort', canceled, { once: true });
              releaseWaitListener = owners.acquire('abortListeners');
              hls!.on(Library.Events.MANIFEST_PARSED, () => {
                if (started || disposed || signal?.aborted) return;
                started = true;
                if (qualityReaders.get(video) !== qualityReader) {
                  canceled();
                  return;
                }
                // HLS has already filtered unsupported codecs from these actual
                // levels. Invalid/missing metadata does not invent a rendition.
                let highest = -1;
                let best: number[] = [];
                for (const [index, level] of (hls?.levels ?? []).entries()) {
                  const positive = (value: unknown): number =>
                    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
                  const score = [
                    positive(level.height),
                    positive(level.bitrate),
                    positive(level.width),
                  ];
                  if (!score.some((value) => value > 0)) continue;
                  if (
                    highest < 0 ||
                    score.some(
                      (value, part) =>
                        value > best[part]! &&
                        score.slice(0, part).every((prior, earlier) => prior === best[earlier]),
                    )
                  ) {
                    highest = index;
                    best = score;
                  }
                }
                if (highest >= 0) hls!.nextLevel = highest;
                readyToPlay = true;
                audio.refresh();
                notifyQuality();
                if (!desiredPaused) hls!.startLoad(-1);
                void play().finally(canceled);
              });
              hlsListeners.push(owners.acquire('hlsListeners'));
              hls!.attachMedia(video);
              hls!.loadSource(url.href);
            }),
        );
      } else if (transportStream) {
        let library: typeof Mpegts | null;
        try {
          library = await initialization.run('initializationWaits', () =>
            Promise.race([
              (options.loadMpegts ?? (() => import('mpegts.js').then((m) => m.default)))(),
              new Promise<null>((resolve) => {
                if (signal?.aborted) resolve(null);
                signal?.addEventListener('abort', () => resolve(null), { once: true });
              }),
            ]),
          );
        } catch {
          report({
            type: 'error',
            failure: {
              code: 'unsupported',
              message:
                'The playback component could not load. Restart the application or choose another stream.',
              retryable: false,
            },
          });
          return;
        }
        if (!library || disposed || signal?.aborted) return;
        if (!library.isSupported() || !library.getFeatureList().mseLivePlayback) {
          unsupported();
          return;
        }
        // Retries stay with the controller's bounded episode, never hidden library loops.
        const player = library.createPlayer(
          { type: 'mpegts', isLive: true, url: url.href },
          {
            enableWorker: true,
            lazyLoad: false,
            // Smooth over latency: keep a cushion like a set-top player instead of
            // jumping forward to the live edge (which skips audio and video).
            enableStashBuffer: true,
            stashInitialSize: liveBufferProfile(buffer).mpegtsStash,
            liveBufferLatencyChasing: false,
            liveSync: false,
            autoCleanupSourceBuffer: true,
            ...MPEGTS_BACK_BUFFER,
          },
        );
        tsPlayer = player;
        releaseTsPlayer = owners.acquire('hlsInstances');
        player.on(library.Events.ERROR, (type: string, details: string) => {
          if (tsPlayer !== player || disposed) return;
          if (type === library!.ErrorTypes.MEDIA_ERROR) {
            if (
              details === library!.ErrorDetails.MEDIA_CODEC_UNSUPPORTED ||
              details === library!.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED
            )
              unsupported();
            else decodeFailure();
          } else report({ type: 'error', failure: classifyTransportFailure('network-failure') });
        });
        // Measurement only: the stream's description has been parsed.
        player.on(library.Events.MEDIA_INFO, () => startTiming.mark('media-info'));
        audio.attachNative();
        player.attachMediaElement(video);
        player.load();
        readyToPlay = true;
        audio.refresh();
        notifyQuality();
        await play();
      } else {
        audio.attachNative();
        video.src = url.href;
        video.load();
        readyToPlay = true;
        audio.refresh();
        notifyQuality();
        await play();
      }
    },
    pause: () => {
      previousDecoded = null;
      desiredPaused = true;
      endReplay();
      endHold(false);
      if (!disposed) {
        video.pause();
        hls?.stopLoad();
      }
    },
    resume: async () => {
      previousDecoded = null;
      desiredPaused = false;
      endReplay();
      endHold(false);
      if (!disposed) {
        if (!finiteMode) liveEdge();
        hls?.startLoad(-1);
        if (readyToPlay) await video.play();
      }
    },
    setMuted: (value) => {
      userMuted = value;
      applySound();
    },
    setVolume: (value) => {
      if (!disposed) video.volume = value;
    },
    dispose,
    liveReplay: (): LiveReplayEngine | null => {
      // Only hls.js and mpegts.js keep a seekable back buffer; a browser's own
      // live HLS player reports nothing seekable, so it offers no replay.
      if (finiteMode || disposed || signal?.aborted || !readyToPlay || !livePlayed) return null;
      if (!hls && !tsPlayer) return null;
      const live = () => !disposed && !signal?.aborted && !desiredPaused;
      const window = () =>
        live() ? replayWindowFrom(bufferedRanges(), video.currentTime, framePeriod ?? NaN) : null;
      const begin = (): boolean => {
        if (!live()) return false;
        if (!replay) {
          const now = window();
          if (!now) return false;
          endHold(false);
          replay = { rate: 1, paused: false, latency: Math.max(0.5, now.end - now.position) };
        }
        return true;
      };
      return {
        window,
        seek: (seconds, capturedSignal) => {
          const now = window();
          if (
            !now ||
            capturedSignal.aborted ||
            !Number.isFinite(seconds) ||
            seconds < now.start - 0.05 ||
            seconds > now.end ||
            !begin()
          )
            return Promise.resolve(false);
          return new Promise<boolean>((resolve) => {
            const releaseTimer = owners.acquire('loaderTimers');
            const releaseAbort = owners.acquire('abortListeners');
            // eslint-disable-next-line prefer-const -- Assigned after listeners that may settle first.
            let timer: ReturnType<typeof setTimeout> | undefined;
            let settled = false;
            const finish = (shown: boolean) => {
              if (settled) return;
              settled = true;
              video.removeEventListener('seeked', seeked);
              capturedSignal.removeEventListener('abort', canceled);
              if (timer !== undefined) clearTimeout(timer);
              releaseTimer();
              releaseAbort();
              // A shown picture is real media progress: a replay pause after
              // a step is never mistaken for a stalled stream.
              if (shown && live()) report({ type: 'progress' });
              resolve(shown && live());
            };
            const seeked = () => {
              if (!video.seeking) finish(video.readyState >= 2);
            };
            const canceled = () => finish(false);
            video.addEventListener('seeked', seeked);
            capturedSignal.addEventListener('abort', canceled, { once: true });
            timer = setTimeout(canceled, 5_000);
            previousDecoded = null;
            previousTime = seconds;
            try {
              video.currentTime = seconds;
            } catch {
              finish(false);
            }
          });
        },
        setRate: (rate) => {
          if (!(REPLAY_RATES as readonly number[]).includes(rate) || !begin()) return;
          replay!.rate = rate;
          video.playbackRate = rate;
          applySound();
        },
        setPaused: (paused) => {
          if (!begin()) return;
          replay!.paused = paused;
          if (paused) video.pause();
          else void video.play().catch(() => undefined);
        },
        leave: () => {
          const was = replay;
          endReplay();
          if (!was || !live()) return;
          // hls.js knows the live edge from the playlist; otherwise keep the
          // distance behind the newest media that playback had before replay.
          const ranges = bufferedRanges();
          const newest = ranges.length ? Math.max(...ranges.map(([, end]) => end)) : NaN;
          const sync = hls?.liveSyncPosition;
          const target =
            typeof sync === 'number' && Number.isFinite(sync) ? sync : newest - was.latency;
          if (Number.isFinite(target) && target > video.currentTime + 0.5) {
            rejoiningUntil = Date.now() + 10_000;
            previousDecoded = null;
            previousTime = target;
            try {
              video.currentTime = Number.isFinite(newest) ? Math.min(target, newest - 0.5) : target;
            } catch {
              /* The player keeps its position; Live still restores 1x and sound. */
            }
          }
          if (video.paused) void video.play().catch(() => undefined);
        },
      };
    },
    readAudioTracks: audio.read,
    setAudioTrack: audio.set,
    readVODposition: () => {
      const position = video.currentTime;
      return vodRanges() &&
        !video.seeking &&
        Number.isFinite(position) &&
        position >= 0 &&
        position <= video.duration
        ? position
        : null;
    },
    readVODduration: () => (vodRanges() ? video.duration : null),
    seekVOD: (seconds, capturedSignal) => {
      const ranges = vodRanges();
      if (!ranges || capturedSignal.aborted || pendingSeek) return Promise.resolve('unavailable');
      if (
        !Number.isFinite(seconds) ||
        seconds < 0 ||
        seconds > VOD_POSITION_LIMIT ||
        !ranges.some(([start, end]) => start <= seconds && seconds <= end)
      )
        return Promise.resolve('out-of-range');
      if (!video.seeking && video.currentTime === seconds) return Promise.resolve('seeked');
      return new Promise((resolve) => {
        const releaseWait = owners.acquire('initializationWaits');
        const releaseTimer = owners.acquire('loaderTimers');
        const releaseAbort = owners.acquire('abortListeners');
        // Registered seek callbacks can settle synchronously before timer assignment.
        // eslint-disable-next-line prefer-const -- Keep an initialized binding rather than a callback-visible TDZ.
        let timer: ReturnType<typeof setTimeout>;
        let settled = false;
        const finish = (result: 'seeked' | 'unavailable') => {
          if (settled) return;
          settled = true;
          capturedSignal.removeEventListener('abort', canceled);
          clearTimeout(timer);
          releaseTimer();
          releaseAbort();
          releaseWait();
          pendingSeek = null;
          resolve(result);
        };
        const canceled = () => finish('unavailable');
        pendingSeek = { target: seconds, finish };
        // Backstop only: the controller window (VOD_SEEK_MS) aborts first.
        timer = setTimeout(canceled, 60_000);
        capturedSignal.addEventListener('abort', canceled, { once: true });
        previousDecoded = null;
        previousTime = seconds;
        try {
          video.currentTime = seconds;
        } catch {
          finish('unavailable');
        }
        if (capturedSignal.aborted) finish('unavailable');
      });
    },
  };
}
