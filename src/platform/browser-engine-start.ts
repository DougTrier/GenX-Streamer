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

import {
  validDecodedProgress,
  type ChannelSelection,
  type DecodedSample,
  type EngineEvent,
  type PlaybackFailure,
} from '../playback/controller';
import { createOwnedAbortSignals } from './abort';
import { createAdaptiveBuffer, learnedLiveBuffer } from '../playback/adaptive-buffer';
import { SourceRequestError, readConfiguredSource, type ConfiguredSource } from '../sources';
import { classifyHttpFailure, classifyTransportFailure } from '../playback/failure';
import { startTiming } from '../playback/start-timing';
import Hls from 'hls.js';
import { isTauri } from '@tauri-apps/api/core';
import { createNativeHlsSession } from './native-hls-loader';
import Mpegts from 'mpegts.js';
import { type createBrowserAudioHealth } from './browser-audio-health';
import { type createBrowserAudioTracks } from './browser-audio-tracks';
import { type ResourceOwners, type createOwnedWork } from '../playback/resource-owners';
import {
  HLS_BACK_BUFFER_SECONDS,
  MPEGTS_BACK_BUFFER,
  browserSourceReader,
  captionOwners,
  liveBufferProfile,
  mediaAttachmentOwners,
  qualityReaders,
  qualitySetters,
  readRetryAfter,
  type BrowserEngineOptions,
  type PlaybackSourceReader,
  type VideoQualitySnapshot,
} from './browser-engine';

/** Radio servers label ADTS AAC/MP3 with legacy names the WebView does not recognize. */
const STANDARD_MIME: Readonly<Record<string, string>> = {
  'audio/aacp': 'audio/aac',
  'audio/x-aac': 'audio/aac',
  'audio/mp3': 'audio/mpeg',
};

/** Start timing is measurement only: a malformed event must never reach playback. */
const measure = (work: () => void): void => {
  try {
    work();
  } catch {
    // The stage is simply not recorded.
  }
};

/** What this part reads from, and writes back to, createBrowserEngine. */
export interface BrowserEngineStartEnvironment {
  readonly disposed: boolean;
  readonly dispose: () => void | Promise<void>;
  readonly unsupported: () => void;
  readonly video: HTMLVideoElement;
  readonly attachmentToken: object;
  signalOwner: ReturnType<typeof createOwnedAbortSignals> | null;
  readonly ownedAbort: AbortController;
  readonly owners: ResourceOwners;
  finiteMode: boolean;
  buffer: NonNullable<ChannelSelection['buffer']>;
  readonly endHold: (resume: boolean) => void;
  livePlayed: boolean;
  adaptiveChannel: string;
  adaptive: ReturnType<typeof createAdaptiveBuffer> | null;
  signal: AbortSignal | null;
  readonly disposeOnAbort: () => void;
  releaseAbortListener: (() => void) | null;
  readonly captionOwner: object;
  readonly qualityReader: () => Readonly<VideoQualitySnapshot> | null;
  readonly qualitySetter: (index: number | null) => boolean;
  readonly audioHealth: ReturnType<typeof createBrowserAudioHealth>;
  readonly audio: ReturnType<typeof createBrowserAudioTracks>;
  readonly notifyQuality: () => void;
  readonly resetCaptions: () => void;
  readonly options: BrowserEngineOptions;
  readonly report: (event: EngineEvent) => void;
  readonly initialization: ReturnType<typeof createOwnedWork>;
  readonly inspect: PlaybackSourceReader;
  readonly listen: (type: string, listener: EventListener) => void;
  previousTime: number;
  readonly replay: { rate: number; paused: boolean; latency: number } | null;
  frameSample: { media: number; frames: number } | null;
  framePeriod: number | null;
  readonly decodedSample: () => { sample: DecodedSample; at: number } | null;
  previousDecoded: { sample: DecodedSample; at: number } | null;
  readonly pendingSeek: { target: number; finish(result: 'seeked' | 'unavailable'): void } | null;
  readonly hold: () => void;
  readonly decodeFailure: () => void;
  readyToPlay: boolean;
  readonly play: () => Promise<void>;
  nativeSession: ReturnType<typeof createNativeHlsSession> | null;
  readonly inspectFragment: (bytes: Uint8Array) => void;
  hls: Hls | null;
  releaseHls: (() => void) | null;
  readonly hlsListeners: Array<() => void>;
  cancelInitialization: (() => void) | null;
  readonly desiredPaused: boolean;
  tsPlayer: Mpegts.Player | null;
  releaseTsPlayer: (() => void) | null;
}

/**
 * Starting playback in the browser engine: choosing hls.js, mpegts.js or the
 * browser's own player for the stream, attaching it, and watching it until
 * the picture starts or the start fails. Part of createBrowserEngine.
 */
export function createBrowserEngineStart(env: BrowserEngineStartEnvironment) {
  async function startPlayback(
    selection: ChannelSelection,
    abortSignal: AbortSignal,
  ): Promise<void> {
    if (env.disposed || abortSignal.aborted) {
      await env.dispose();
      return;
    }
    if (selection.crossOrigin !== undefined && selection.crossOrigin !== 'anonymous') {
      env.unsupported();
      return;
    }
    const previousAttachment = mediaAttachmentOwners.get(env.video);
    if (selection.crossOrigin === 'anonymous') env.video.crossOrigin = 'anonymous';
    else if (previousAttachment?.anonymous && env.video.crossOrigin === 'anonymous')
      env.video.removeAttribute('crossorigin');
    mediaAttachmentOwners.set(env.video, {
      token: env.attachmentToken,
      anonymous: selection.crossOrigin === 'anonymous',
    });
    env.signalOwner = createOwnedAbortSignals([abortSignal, env.ownedAbort.signal], env.owners);
    env.finiteMode = selection.playMode === 'on-demand';
    env.buffer = liveBufferProfile(selection.buffer).profile;
    env.endHold(false);
    env.livePlayed = false;
    env.adaptiveChannel = selection.id;
    env.adaptive = env.finiteMode
      ? null
      : createAdaptiveBuffer(env.buffer, learnedLiveBuffer.get(selection.id));
    env.signal = env.signalOwner.signal;
    env.signal.addEventListener('abort', env.disposeOnAbort, { once: true });
    env.releaseAbortListener = env.owners.acquire('abortListeners');
    captionOwners.set(env.video, env.captionOwner);
    qualityReaders.set(env.video, env.qualityReader);
    qualitySetters.set(env.video, env.qualitySetter);
    env.audioHealth.activate();
    env.audio.activate();
    env.notifyQuality();
    env.resetCaptions();
    let url: URL;
    try {
      url = new URL(selection.url);
    } catch {
      env.unsupported();
      return;
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      env.unsupported();
      return;
    }
    if (env.options.requestAllowed && env.options.requestAllowed(selection.url) !== true) {
      env.report({
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
    const allowHttp = env.options.allowHttp?.(selection.url) === true;
    if (url.protocol === 'http:' && !allowHttp) {
      env.report({
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
        : await env.initialization.run('initializationWaits', () =>
            env.inspect === browserSourceReader
              ? readConfiguredSource(url.href, allowHttp, env.signal!)
              : env.inspect(url.href, env.signal!),
          );
    } catch (error) {
      if (env.disposed || abortSignal.aborted) return;
      env.report({
        type: 'error',
        failure:
          error instanceof SourceRequestError
            ? classifyHttpFailure(error.status, error.retryAfter)
            : classifyTransportFailure(error),
      });
      return;
    }
    if (env.disposed || abortSignal.aborted) return;
    if (source.kind !== 'hls' && source.kind !== 'media') {
      env.unsupported();
      return;
    }
    // Live MPEG-TS has no native element support; it plays through mpegts.js.
    const transportStream =
      source.kind === 'media' && source.mime === 'video/mp2t' && !env.finiteMode;
    if (
      source.kind === 'media' &&
      source.mime &&
      !transportStream &&
      !env.video.canPlayType(STANDARD_MIME[source.mime] ?? source.mime)
    ) {
      env.unsupported();
      return;
    }
    env.report({ type: 'capability', mediaKind: source.kind, mediaMime: source.mime });
    startTiming.mark('source-known');
    startTiming.fact('source-checked', !confirmed.mediaKind);
    // Measurement only: first decoded frame, first frame on screen, first play.
    env.listen('loadeddata', () => startTiming.mark('first-decodable-frame'));
    env.listen('playing', () => startTiming.mark('playing-event'));
    if (typeof env.video.requestVideoFrameCallback === 'function')
      env.video.requestVideoFrameCallback((at, frame) => {
        if (!env.disposed && !env.signal?.aborted)
          startTiming.mark('first-visible-frame', frame.expectedDisplayTime || at);
      });
    env.previousTime = env.video.currentTime;
    env.listen('timeupdate', () => {
      env.audioHealth.sample();
      const current = env.video.currentTime;
      if (
        !env.video.paused &&
        !env.video.seeking &&
        env.video.readyState >= 2 &&
        current > env.previousTime + 0.01
      ) {
        env.livePlayed = true;
        env.report({ type: 'progress' });
      }
      // Frame period at normal speed, for one-picture replay steps.
      if (!env.replay && !env.video.paused && !env.video.seeking && env.video.playbackRate === 1) {
        try {
          const frames = env.video.getVideoPlaybackQuality?.().totalVideoFrames;
          if (Number.isSafeInteger(frames)) {
            const media = current - (env.frameSample?.media ?? current);
            const count = frames! - (env.frameSample?.frames ?? frames!);
            if (env.frameSample && media >= 0.5 && media <= 5 && count > 0)
              env.framePeriod = media / count;
            if (!env.frameSample || media >= 0.5 || media < 0)
              env.frameSample = { media: current, frames: frames! };
          }
        } catch {
          env.frameSample = null;
        }
      }
      // Replay pictures are not live decoding health.
      const next = env.replay ? null : env.decodedSample();
      if (env.previousDecoded && next) {
        const evidence = {
          kind: 'decoded' as const,
          before: env.previousDecoded.sample,
          after: next.sample,
          elapsedMilliseconds: next.at - env.previousDecoded.at,
        };
        if (validDecodedProgress(evidence)) env.report({ type: 'decoded-progress', evidence });
      }
      env.previousDecoded = next;
      env.previousTime = current;
    });
    env.listen('volumechange', () => env.audioHealth.sample());
    env.listen('seeking', () => {
      env.previousDecoded = null;
      env.frameSample = null;
      env.previousTime = env.video.currentTime;
    });
    env.listen('seeked', () => {
      const pending = env.pendingSeek;
      if (
        pending &&
        !env.video.seeking &&
        Number.isFinite(env.video.currentTime) &&
        Math.abs(env.video.currentTime - pending.target) <= 0.1
      )
        pending.finish('seeked');
    });
    env.listen('pause', () => {
      env.previousDecoded = null;
    });
    env.listen('waiting', () => {
      env.previousDecoded = null;
      env.report({ type: 'buffering' });
      env.hold();
    });
    env.listen('stalled', () => {
      env.previousDecoded = null;
      env.report({ type: 'buffering' });
    });
    env.listen('ended', () => {
      // On-demand: finished. Live: the source closed the stream (providers
      // drop long sessions); the controller reconnects within its bounds.
      env.report({ type: 'ended' });
    });
    env.listen('error', () => {
      if (env.video.error?.code === 4) env.unsupported();
      else if (env.video.error?.code === 3) env.decodeFailure();
      else env.report({ type: 'error', failure: classifyHttpFailure(0) });
    });
    const isHls = source.kind === 'hls';
    const nativeHls = !!env.video.canPlayType('application/vnd.apple.mpegurl');
    if (isHls && (!nativeHls || env.options.preferNativeHls === false)) {
      let Library: typeof Hls | null;
      try {
        // Import cannot be canceled, but this owner's wait can. Late module
        // completion must never attach media after disposal or supersession.
        Library = await env.initialization.run(
          'initializationWaits',
          () =>
            new Promise<typeof Hls | null>((resolve, reject) => {
              let releaseWaitListener: (() => void) | null = null;
              const canceled = (): void => {
                env.signal?.removeEventListener('abort', canceled);
                releaseWaitListener?.();
                resolve(null);
              };
              env.signal?.addEventListener('abort', canceled, { once: true });
              releaseWaitListener = env.owners.acquire('abortListeners');
              if (env.signal?.aborted) {
                canceled();
                return;
              }
              const load =
                env.options.loadHls ?? (() => import('hls.js').then((module) => module.default));
              void Promise.resolve()
                .then(load)
                .then(
                  (library) => {
                    env.signal?.removeEventListener('abort', canceled);
                    releaseWaitListener?.();
                    resolve(library);
                  },
                  (error: unknown) => {
                    env.signal?.removeEventListener('abort', canceled);
                    releaseWaitListener?.();
                    reject(error);
                  },
                );
            }),
        );
      } catch {
        env.report({
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
      if (!Library || env.disposed || env.signal?.aborted) return;
      startTiming.mark('library-ready');
      if (!Library.isSupported()) {
        if (nativeHls) {
          env.audio.attachNative();
          env.video.src = url.href;
          env.video.load();
          env.readyToPlay = true;
          env.audio.refresh();
          env.notifyQuality();
          await env.play();
          return;
        }
        env.unsupported();
        return;
      }
      // All retries belong to the controller's one bounded episode, never hidden library loops.
      const noRetry = {
        maxTimeToFirstByteMs: 8000,
        maxLoadTimeMs: 15000,
        timeoutRetry: null,
        errorRetry: null,
      };
      if (isTauri() || env.options.nativeTransport)
        env.nativeSession = createNativeHlsSession({
          allowHttp: () => allowHttp,
          inspectFragment: env.inspectFragment,
          requestAllowed: env.options.requestAllowed,
          transport: env.options.nativeTransport,
          owners: env.owners,
        });
      env.hls = new Library({
        enableWorker: true,
        // Admit the manifest first so the initial request uses the user's
        // highest-available default rather than a preliminary Auto estimate.
        autoStartLoad: false,
        // Fast start / balanced / extra smooth: seconds of media held ahead,
        // and how many segments behind the live edge playback starts.
        ...liveBufferProfile(env.buffer).hls,
        backBufferLength: HLS_BACK_BUFFER_SECONDS,
        ...(env.nativeSession ? { loader: env.nativeSession.Loader } : {}),
        manifestLoadPolicy: { default: noRetry },
        playlistLoadPolicy: { default: noRetry },
        fragLoadPolicy: { default: noRetry },
        keyLoadPolicy: { default: noRetry },
        steeringManifestLoadPolicy: { default: noRetry },
      });
      env.releaseHls = env.owners.acquire('hlsInstances');
      env.audio.attachHls(env.hls, Library.Events);
      for (const [event, observe] of [
        [Library.Events.BUFFER_CODECS, env.audioHealth.codecs],
        [Library.Events.BUFFER_CREATED, env.audioHealth.buffers],
      ] as const) {
        env.hls.on(event, (_name: unknown, data: unknown) => observe(data));
        env.hlsListeners.push(env.owners.acquire('hlsListeners'));
      }
      env.hls.on(Library.Events.LEVEL_SWITCHED, env.notifyQuality);
      env.hlsListeners.push(env.owners.acquire('hlsListeners'));
      env.hls.on(Library.Events.FRAG_BUFFERED, (_name, data) => {
        measure(() => {
          if (data.frag.type === 'main') startTiming.mark('first-segment-buffered');
        });
        env.notifyQuality();
      });
      env.hlsListeners.push(env.owners.acquire('hlsListeners'));
      // Measurement only: request, first byte and end of the manifest and the
      // first segment (the native loader reports its own first-byte time).
      env.hls.on(Library.Events.MANIFEST_LOADED, (_name, data) =>
        measure(() => {
          startTiming.mark('manifest-request', data.stats.loading.start);
          startTiming.mark('manifest-first-byte', data.stats.loading.first);
          startTiming.mark('manifest-loaded', data.stats.loading.end);
          startTiming.fact('manifest-levels', data.levels.length);
        }),
      );
      env.hls.on(Library.Events.LEVEL_LOADED, (_name, data) =>
        measure(() => {
          startTiming.mark('playlist-loaded', data.stats.loading.end);
          startTiming.fact('playlist-segments', data.details.fragments.length);
          startTiming.fact('target-duration', data.details.targetduration);
        }),
      );
      env.hls.on(Library.Events.FRAG_LOADED, (_name, data) =>
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
      env.hlsListeners.push(...[1, 2, 3].map(() => env.owners.acquire('hlsListeners')));
      env.hls.on(Library.Events.ERROR, (_event, data) => {
        env.audioHealth.fault(data);
        if (!data.fatal) return;
        if (
          data.details === 'manifestIncompatibleCodecsError' ||
          data.details === 'bufferIncompatibleCodecsError'
        )
          env.unsupported();
        else if (data.type === Library.ErrorTypes.MEDIA_ERROR) env.decodeFailure();
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
          env.report({ type: 'error', failure });
        }
      });
      env.hlsListeners.push(env.owners.acquire('hlsListeners'));
      // A MediaSource may not be attached yet. Calling play before the manifest
      // can cause a false unsupported-format rejection on an otherwise valid HLS.
      await env.initialization.run(
        'initializationWaits',
        () =>
          new Promise<void>((resolve) => {
            let started = false;
            let releaseWaitListener: (() => void) | null = null;
            const canceled = (): void => {
              env.signal?.removeEventListener('abort', canceled);
              releaseWaitListener?.();
              env.cancelInitialization = null;
              resolve();
            };
            env.cancelInitialization = canceled;
            env.signal?.addEventListener('abort', canceled, { once: true });
            releaseWaitListener = env.owners.acquire('abortListeners');
            env.hls!.on(Library.Events.MANIFEST_PARSED, () => {
              if (started || env.disposed || env.signal?.aborted) return;
              started = true;
              if (qualityReaders.get(env.video) !== env.qualityReader) {
                canceled();
                return;
              }
              // HLS has already filtered unsupported codecs from these actual
              // levels. Invalid/missing metadata does not invent a rendition.
              let highest = -1;
              let best: number[] = [];
              for (const [index, level] of (env.hls?.levels ?? []).entries()) {
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
              if (highest >= 0) env.hls!.nextLevel = highest;
              env.readyToPlay = true;
              env.audio.refresh();
              env.notifyQuality();
              if (!env.desiredPaused) env.hls!.startLoad(-1);
              void env.play().finally(canceled);
            });
            env.hlsListeners.push(env.owners.acquire('hlsListeners'));
            env.hls!.attachMedia(env.video);
            env.hls!.loadSource(url.href);
          }),
      );
    } else if (transportStream) {
      let library: typeof Mpegts | null;
      try {
        library = await env.initialization.run('initializationWaits', () =>
          Promise.race([
            (env.options.loadMpegts ?? (() => import('mpegts.js').then((m) => m.default)))(),
            new Promise<null>((resolve) => {
              if (env.signal?.aborted) resolve(null);
              env.signal?.addEventListener('abort', () => resolve(null), { once: true });
            }),
          ]),
        );
      } catch {
        env.report({
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
      if (!library || env.disposed || env.signal?.aborted) return;
      if (!library.isSupported() || !library.getFeatureList().mseLivePlayback) {
        env.unsupported();
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
          stashInitialSize: liveBufferProfile(env.buffer).mpegtsStash,
          liveBufferLatencyChasing: false,
          liveSync: false,
          autoCleanupSourceBuffer: true,
          ...MPEGTS_BACK_BUFFER,
        },
      );
      env.tsPlayer = player;
      env.releaseTsPlayer = env.owners.acquire('hlsInstances');
      player.on(library.Events.ERROR, (type: string, details: string) => {
        if (env.tsPlayer !== player || env.disposed) return;
        if (type === library!.ErrorTypes.MEDIA_ERROR) {
          if (
            details === library!.ErrorDetails.MEDIA_CODEC_UNSUPPORTED ||
            details === library!.ErrorDetails.MEDIA_FORMAT_UNSUPPORTED
          )
            env.unsupported();
          else env.decodeFailure();
        } else env.report({ type: 'error', failure: classifyTransportFailure('network-failure') });
      });
      // Measurement only: the stream's description has been parsed.
      player.on(library.Events.MEDIA_INFO, () => startTiming.mark('media-info'));
      env.audio.attachNative();
      player.attachMediaElement(env.video);
      player.load();
      env.readyToPlay = true;
      env.audio.refresh();
      env.notifyQuality();
      await env.play();
    } else {
      env.audio.attachNative();
      env.video.src = url.href;
      env.video.load();
      env.readyToPlay = true;
      env.audio.refresh();
      env.notifyQuality();
      await env.play();
    }
  }
  return {
    startPlayback,
  };
}
