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
  REPLAY_RATES,
  REPLAY_REACH_SECONDS,
  replayFrameSeconds,
  replayWindowFrom,
  validDecodedProgress,
  type ChannelSelection,
  type EngineEvent,
  type FailureCode,
  type LiveReplayEngine,
  type PlaybackEngine,
} from './controller';
import type { AudioTracksSnapshot } from './audio-tracks';
import { normalizeLiveBufferPreference, type LiveBufferTelemetry } from './live-buffer';
import { accountLive } from './routing-engine';
import type {
  NativeVideoBridge,
  NativeVideoStatus,
  NativeVideoTrack,
} from '../platform/native-video';

/** How often the native player's state is read (docs/native-vod-player.md). */
export const NATIVE_POLL_MS = 500;
export type PictureRect = [number, number, number, number];
export interface NativeTrackControls {
  audio(id: string): void;
  text(id: string | null): void;
}
export interface NativeEngineHost {
  bridge: NativeVideoBridge;
  /** Picture coordinates interpreted by this host's bridge; null while hidden. */
  rect(): PictureRect | null;
  /** Calls back when the picture may have moved; returns the stop function. */
  watchRect(changed: () => void): () => void;
  /** The page leaves a see-through hole for the native picture while on. */
  present(on: boolean): void;
  /** Embedded tracks for the audio menu and the CC button (null clears them). */
  publish(
    tracks: { audio: readonly NativeVideoTrack[]; text: readonly NativeVideoTrack[] } | null,
    controls: NativeTrackControls | null,
  ): void;
  setInterval?(callback: () => void, ms: number): unknown;
  clearInterval?(handle: unknown): void;
}

let sessions = 0;
const MESSAGES: Record<FailureCode, string> = {
  network: 'The video stopped arriving. Retry the video.',
  missing: 'The requested video is unavailable.',
  unsupported: 'This TV cannot play this video’s format.',
  decode: 'This TV could not decode this video.',
  access: 'Access to this video was refused.',
  dns: 'The provider could not be reached.',
  tls: 'The provider’s secure connection failed.',
  timeout: 'The video took too long to start.',
  policy: 'This video is not allowed.',
  unknown: 'The video could not play. Retry or choose another video.',
};

/** Media3's audio list as the audio menu's snapshot (actual metadata only). */
export function nativeAudioSnapshot(
  audio: readonly NativeVideoTrack[],
): Readonly<AudioTracksSnapshot> | null {
  if (!audio.length) return null;
  return {
    source: 'native',
    mode: 'manual',
    selectable: audio.some((track) => track.supported),
    providerDefaultAvailable: false,
    providerDefaultId: 'native-default',
    trackCount: audio.length,
    truncated: false,
    tracks: audio.map((track, index) => ({
      id: track.id,
      index,
      name: track.label || null,
      language: track.language || null,
      description: track.channels ? `${track.channels} ch` : null,
      kind: null,
      selected: track.selected,
      providerDefault: null,
    })),
  };
}

export function createNativeVodEngine(
  emit: (event: EngineEvent) => void,
  host: NativeEngineHost,
  options: {
    live?: boolean;
    /** Once per title: it has a picture, but no decoder here can show it. */
    onPictureUnsupported?: () => void;
  } = {},
): PlaybackEngine {
  const every = host.setInterval ?? ((callback, ms) => setInterval(callback, ms));
  const stopEvery =
    host.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  let session = 0;
  let paidLive = false;
  let liveContent = options.live === true;
  let disposed = false;
  let poll: unknown = null;
  let polling = false;
  let stopWatching: (() => void) | null = null;
  let last: NativeVideoStatus | null = null;
  let bufferTelemetry: Readonly<LiveBufferTelemetry> | null = null;
  let bufferCommand = 0;
  let bufferPending = 0;
  let lastState: NativeVideoStatus['state'] | null = null;
  let tracksKey = '';
  let pictureReported = false;
  let muted = false;
  let volume = 1;
  let finished = false;
  // Instant replay (live channels): where this session's stream began, and
  // the replay's speed and pause while one runs (docs/instant-replay.md).
  let firstStreamMs: number | null = null;
  let replay: { rate: number; paused: boolean } | null = null;
  const live = () => !disposed && session > 0 && !finished;
  const send = (request: Omit<Parameters<NativeVideoBridge>[0], 'session'>) =>
    host.bridge({ ...request, session } as Parameters<NativeVideoBridge>[0]);
  const quiet = (work: Promise<unknown>) => void work.catch(() => undefined);
  // Below 1x a replay is silent; the viewer's own Mute and volume stay as set.
  const applySound = () => {
    if (live())
      quiet(send({ action: 'volume', volume: muted || (replay && replay.rate < 1) ? 0 : volume }));
  };
  const controls: NativeTrackControls = {
    audio: (id) => {
      if (live()) quiet(send({ action: 'audio', track: id }).then(observe));
    },
    text: (id) => {
      if (live()) quiet(send({ action: 'text', track: id ?? '' }).then(observe));
    },
  };
  const finish = () => {
    finished = true;
    if (poll !== null) stopEvery(poll);
    poll = null;
  };
  let lastStatusAt = 0;
  function observe(status: NativeVideoStatus, acceptBuffer = true): void {
    if (!live() || status.session !== session) return;
    const before = last;
    const at = performance.now();
    const elapsed = at - lastStatusAt;
    lastStatusAt = at;
    last = status;
    if (acceptBuffer && !bufferPending)
      bufferTelemetry = status.liveBuffer ? Object.freeze({ ...status.liveBuffer }) : null;
    if (status.picture === 'unsupported' && !pictureReported) {
      pictureReported = true;
      options.onPictureUnsupported?.();
    }
    const key = JSON.stringify([status.audio, status.text]);
    if (key !== tracksKey) {
      tracksKey = key;
      host.publish({ audio: status.audio, text: status.text }, controls);
      emit({ type: 'audio-tracks', snapshot: nativeAudioSnapshot(status.audio) });
    }
    if (status.state === 'error') {
      const code: FailureCode = status.error ?? 'unknown';
      finish();
      emit({
        type: 'error',
        failure: {
          code,
          message: MESSAGES[code],
          retryable: code === 'network',
          phase:
            status.httpStatus !== undefined || code === 'access' || code === 'missing'
              ? 'headers'
              : code === 'network'
                ? 'body'
                : 'decode',
          ...(status.httpStatus !== undefined ? { httpStatus: status.httpStatus } : {}),
          evidence: 'native',
        },
      });
      return;
    }
    if (status.state === 'ended') {
      finish();
      emit({ type: 'ended' });
      return;
    }
    if ((status.liveWindowRecoveries ?? 0) > (before?.liveWindowRecoveries ?? 0))
      emit({ type: 'source-recovery', cause: 'live-window' });
    if (status.state === 'buffering' && lastState !== 'buffering') emit({ type: 'buffering' });
    if (
      status.state === 'ready' &&
      (status.playing
        ? lastState !== 'ready' ||
          !before ||
          // A live playlist's relative position can clamp to zero while its
          // absolute stream clock advances. Use the same clock on both reads.
          (status.streamMs !== undefined && before.streamMs !== undefined
            ? status.streamMs > before.streamMs
            : status.positionMs > before.positionMs)
        : // A paused replay showing its picture again is not a stall.
          replay !== null && lastState !== 'ready')
    )
      emit({ type: 'progress' });
    if (
      !replay &&
      before &&
      status.state === 'ready' &&
      status.playing &&
      before.renderedFrames !== undefined &&
      status.renderedFrames !== undefined
    ) {
      const sample = (s: NativeVideoStatus) => ({
        mediaTime: (s.streamMs ?? s.positionMs) / 1000,
        decodedFrames: s.renderedFrames!,
        width: s.videoWidth ?? 0,
        height: s.videoHeight ?? 0,
        ...((s.audioRenderedFrames ?? 0) > 0 ? { audioObserved: true } : {}),
      });
      const evidence = {
        kind: 'decoded' as const,
        before: sample(before),
        after: sample(status),
        elapsedMilliseconds: elapsed,
      };
      if (validDecodedProgress(evidence)) emit({ type: 'decoded-progress', evidence });
    }
    if (
      firstStreamMs === null &&
      status.state === 'ready' &&
      status.playing &&
      status.streamMs !== undefined
    )
      firstStreamMs = status.streamMs;
    lastState = status.state;
  }
  async function tick(): Promise<void> {
    if (!live() || polling) return;
    polling = true;
    const bufferEpoch = bufferCommand;
    try {
      observe(await send({ action: 'status' }), bufferEpoch === bufferCommand);
    } catch {
      /* One missed reading is not a failure; the next tick reads again. */
    } finally {
      polling = false;
    }
  }
  const place = () => {
    if (live()) quiet(send({ action: 'place', rect: host.rect() ?? [0, 0, 0, 0] }));
  };
  return {
    async start(selection: ChannelSelection, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      if (disposed || session) throw new Error('Native player already used.');
      const initialBuffer =
        selection.liveBuffer === undefined
          ? undefined
          : normalizeLiveBufferPreference(selection.liveBuffer);
      if (selection.liveBuffer !== undefined && !initialBuffer)
        throw new Error('Invalid buffer preference.');
      paidLive = accountLive(selection);
      liveContent = options.live === true || paidLive;
      session = ++sessions;
      host.present(true);
      stopWatching = host.watchRect(place);
      const opened = await send({
        action: 'open',
        url: selection.url,
        rect: host.rect() ?? [0, 0, 0, 0],
        ...(initialBuffer ? { liveBuffer: initialBuffer } : {}),
        ...(paidLive
          ? { accountLive: true, hls: selection.mediaKind === 'hls' }
          : options.live
            ? { publicLive: true, hls: selection.mediaKind !== 'media' }
            : {}),
        ...(!liveContent && selection.id.startsWith('archive-') ? { archive: true } : {}),
      });
      if (signal.aborted || disposed)
        throw new DOMException('Native start canceled.', 'AbortError');
      if (muted || volume !== 1) applySound();
      // Preserve the container on retry: HLS and progressive live need
      // different native sources, without probing an account a second time.
      emit({
        type: 'capability',
        mediaKind: paidLive
          ? (selection.mediaKind ?? 'media')
          : options.live
            ? (selection.mediaKind ?? 'hls')
            : 'media',
      });
      observe(opened);
      poll = every(() => void tick(), NATIVE_POLL_MS);
    },
    pause() {
      // The next play returns to the live edge at normal speed.
      if (replay) {
        replay = null;
        applySound();
      }
      if (live()) quiet(send({ action: 'pause' }).then(observe));
    },
    async resume() {
      if (replay) {
        replay = null;
        applySound();
      }
      if (live()) observe(await send({ action: 'play' }));
    },
    setMuted(value: boolean) {
      muted = value;
      applySound();
    },
    setVolume(value: number) {
      volume = Math.min(1, Math.max(0, Number.isFinite(value) ? value : 1));
      applySound();
    },
    liveReplay(): LiveReplayEngine | null {
      if (!liveContent || !live() || firstStreamMs === null) return null;
      const window = () => {
        const status = last;
        if (!live() || !status || status.streamMs === undefined || firstStreamMs === null)
          return null;
        const position = status.streamMs / 1000;
        const newest = Math.max(position, (status.streamBufferedMs ?? 0) / 1000);
        // Media3 keeps REPLAY_REACH_SECONDS behind what it plays (the back
        // buffer set in NativeVideoPlugin); older media is fetched again.
        return replayWindowFrom(
          [
            [
              Math.min(position, Math.max(firstStreamMs / 1000, position - REPLAY_REACH_SECONDS)),
              newest,
            ],
          ],
          position,
          replayFrameSeconds(status.frameMicros ? status.frameMicros / 1e6 : null),
        );
      };
      const begin = () => {
        if (!live()) return false;
        replay ??= { rate: 1, paused: false };
        return true;
      };
      return {
        window,
        async seek(seconds, signal) {
          const now = window();
          if (
            !now ||
            signal.aborted ||
            !Number.isFinite(seconds) ||
            seconds < now.start - 0.05 ||
            seconds > now.end ||
            !begin()
          )
            return false;
          try {
            let status = await send({ action: 'replay', streamMs: Math.round(seconds * 1000) });
            // The picture is shown once the player is ready again: an MPEG-2
            // step decodes from the previous key frame first.
            for (let wait = 0; wait < 30 && status.state === 'buffering'; wait++) {
              if (signal.aborted || !live()) return false;
              await new Promise((resolve) => setTimeout(resolve, 100));
              status = await send({ action: 'status' });
            }
            if (signal.aborted || !live()) return false;
            observe(status);
            return status.state === 'ready';
          } catch {
            return false;
          }
        },
        setRate(rate) {
          if (!(REPLAY_RATES as readonly number[]).includes(rate) || !begin()) return;
          replay!.rate = rate;
          applySound();
          quiet(send({ action: 'replay', rate }).then(observe));
        },
        setPaused(paused) {
          if (!begin()) return;
          replay!.paused = paused;
          quiet(send({ action: 'replay', playing: !paused }).then(observe));
        },
        leave() {
          if (!replay) return;
          replay = null;
          applySound();
          // Play returns a live channel to its live edge at normal speed.
          if (live()) quiet(send({ action: 'play' }).then(observe));
        },
      };
    },
    readAudioTracks: () => (last ? nativeAudioSnapshot(last.audio) : null),
    readLiveBuffer: () =>
      live() && bufferTelemetry ? Object.freeze({ ...bufferTelemetry }) : null,
    async setLiveBuffer(preference) {
      const policy = normalizeLiveBufferPreference(preference);
      if (!policy || !live() || bufferTelemetry?.capability !== 'controlled') return false;
      const ownedSession = session;
      const command = ++bufferCommand;
      bufferPending = command;
      try {
        const status = await send({ action: 'buffer', liveBuffer: policy });
        if (
          !live() ||
          session !== ownedSession ||
          status.session !== ownedSession ||
          command !== bufferCommand
        )
          return false;
        observe(status, false);
        if (!live()) return false;
        bufferTelemetry = status.liveBuffer ? Object.freeze({ ...status.liveBuffer }) : null;
        return (
          bufferTelemetry?.capability === 'controlled' &&
          bufferTelemetry.mode === policy.mode &&
          (policy.mode === 'auto' || bufferTelemetry.targetSeconds === policy.targetSeconds)
        );
      } catch {
        return false;
      } finally {
        if (bufferPending === command) bufferPending = 0;
      }
    },
    setAudioTrack(id: string | null) {
      if (!id || !last?.audio.some((track) => track.id === id && track.supported)) return false;
      controls.audio(id);
      return true;
    },
    readVODposition: () => (last ? last.positionMs / 1000 : null),
    readVODduration: () => (last && last.durationMs > 0 ? last.durationMs / 1000 : null),
    async seekVOD(seconds: number, signal: AbortSignal) {
      if (!live() || !Number.isFinite(seconds) || seconds < 0) return 'unavailable';
      if (last && last.durationMs > 0 && seconds * 1000 > last.durationMs) return 'out-of-range';
      const status = await send({ action: 'seek', positionMs: Math.round(seconds * 1000) });
      signal.throwIfAborted();
      observe(status);
      return 'seeked';
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      bufferTelemetry = null;
      if (poll !== null) stopEvery(poll);
      poll = null;
      stopWatching?.();
      stopWatching = null;
      host.publish(null, null);
      host.present(false);
      if (session) await send({ action: 'close' }).catch(() => undefined);
    },
  };
}
