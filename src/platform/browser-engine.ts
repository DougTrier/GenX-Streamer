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
import { createOwnedAbortSignals } from './abort';
import { createAdaptiveBuffer, learnedLiveBuffer } from '../playback/adaptive-buffer';
import {
  REPLAY_RATES,
  replayWindowFrom,
  VOD_POSITION_LIMIT,
  type DecodedSample,
  type LiveReplayEngine,
} from '../playback/controller';
import type {
  EngineEvent,
  EngineFactory,
  PlaybackEngine,
  ChannelSelection,
} from '../playback/controller';
import { readConfiguredSource, type ConfiguredSource } from '../sources';

import { createNativeHlsSession, type NativeMediaTransport } from './native-hls-loader';
import { transportVideoFormat } from '../playback/transport-video';
import { startTiming } from '../playback/start-timing';
import {
  createOwnedWork,
  playbackResourceOwners,
  type ResourceOwners,
} from '../playback/resource-owners';
import { createBrowserEngineStart } from './browser-engine-start';
import { createSharedContext } from '../application/shell/shared-context';
export type PlaybackSourceReader = (url: string, signal: AbortSignal) => Promise<ConfiguredSource>;
export const mediaAttachmentOwners = new WeakMap<
  HTMLVideoElement,
  { token: object; anonymous: boolean }
>();
export const captionOwners = new WeakMap<HTMLVideoElement, object>();
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
export const qualityReaders = new WeakMap<
  HTMLVideoElement,
  () => Readonly<VideoQualitySnapshot> | null
>();
export const qualitySetters = new WeakMap<HTMLVideoElement, (index: number | null) => boolean>();
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
export const browserSourceReader: PlaybackSourceReader = (url, signal) =>
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
  // What the parts of createBrowserEngine in other modules share with it: each value
  // is read when a part uses it; the second list holds the ones parts assign.
  const shared = createSharedContext(
    {
      adaptive: () => adaptive,
      adaptiveChannel: () => adaptiveChannel,
      attachmentToken: () => attachmentToken,
      audio: () => audio,
      audioHealth: () => audioHealth,
      buffer: () => buffer,
      cancelInitialization: () => cancelInitialization,
      captionOwner: () => captionOwner,
      decodedSample: () => decodedSample,
      decodeFailure: () => decodeFailure,
      desiredPaused: () => desiredPaused,
      dispose: () => dispose,
      disposed: () => disposed,
      disposeOnAbort: () => disposeOnAbort,
      endHold: () => endHold,
      finiteMode: () => finiteMode,
      framePeriod: () => framePeriod,
      frameSample: () => frameSample,
      hls: () => hls,
      hlsListeners: () => hlsListeners,
      hold: () => hold,
      initialization: () => initialization,
      inspect: () => inspect,
      inspectFragment: () => inspectFragment,
      listen: () => listen,
      livePlayed: () => livePlayed,
      nativeSession: () => nativeSession,
      notifyQuality: () => notifyQuality,
      options: () => options,
      ownedAbort: () => ownedAbort,
      owners: () => owners,
      pendingSeek: () => pendingSeek,
      play: () => play,
      previousDecoded: () => previousDecoded,
      previousTime: () => previousTime,
      qualityReader: () => qualityReader,
      qualitySetter: () => qualitySetter,
      readyToPlay: () => readyToPlay,
      releaseAbortListener: () => releaseAbortListener,
      releaseHls: () => releaseHls,
      releaseTsPlayer: () => releaseTsPlayer,
      replay: () => replay,
      report: () => report,
      resetCaptions: () => resetCaptions,
      signal: () => signal,
      signalOwner: () => signalOwner,
      tsPlayer: () => tsPlayer,
      unsupported: () => unsupported,
      video: () => video,
    },
    {
      adaptive: (value: typeof adaptive) => (adaptive = value),
      adaptiveChannel: (value: typeof adaptiveChannel) => (adaptiveChannel = value),
      buffer: (value: typeof buffer) => (buffer = value),
      cancelInitialization: (value: typeof cancelInitialization) => (cancelInitialization = value),
      finiteMode: (value: typeof finiteMode) => (finiteMode = value),
      framePeriod: (value: typeof framePeriod) => (framePeriod = value),
      frameSample: (value: typeof frameSample) => (frameSample = value),
      hls: (value: typeof hls) => (hls = value),
      livePlayed: (value: typeof livePlayed) => (livePlayed = value),
      nativeSession: (value: typeof nativeSession) => (nativeSession = value),
      previousDecoded: (value: typeof previousDecoded) => (previousDecoded = value),
      previousTime: (value: typeof previousTime) => (previousTime = value),
      readyToPlay: (value: typeof readyToPlay) => (readyToPlay = value),
      releaseAbortListener: (value: typeof releaseAbortListener) => (releaseAbortListener = value),
      releaseHls: (value: typeof releaseHls) => (releaseHls = value),
      releaseTsPlayer: (value: typeof releaseTsPlayer) => (releaseTsPlayer = value),
      signal: (value: typeof signal) => (signal = value),
      signalOwner: (value: typeof signalOwner) => (signalOwner = value),
      tsPlayer: (value: typeof tsPlayer) => (tsPlayer = value),
    },
  );
  const browserEngineStart = createBrowserEngineStart(shared);
  const { startPlayback } = browserEngineStart;

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
    start: startPlayback,
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
