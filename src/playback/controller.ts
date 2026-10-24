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

import { playbackResourceOwners, type ResourceOwners } from './resource-owners';
import type { AudioTracksSnapshot } from './audio-tracks';
import { startTiming } from './start-timing';
import { createOwnedAbortSignals } from '../platform/abort';

export interface ChannelSelection {
  id: string;
  name: string;
  url: string;
  mediaKind?: 'hls' | 'media';
  mediaMime?: string;
  /** Transient credential-free CORS for an explicitly issued media capability. */
  crossOrigin?: 'anonymous';
  /** Explicit finite playback; ordinary channels retain live-end failure behavior. */
  playMode?: 'on-demand';
  /** How much a live stream buffers (a paid account's choice); default balanced. */
  buffer?: 'fast' | 'balanced' | 'smooth';
  /** A longer first-start window (ms, 20–45 s) for sources that may make a
   *  start wait, such as a one-connection provider still closing the last channel. */
  startupMs?: number;
}
/** Transient, local recovery authority. Never enters engine DTOs or snapshots. */
export interface RecoveryPlan {
  urls: readonly string[];
  /** Recheck recovery authority even when restarting the same endpoint. */
  beforeRetry?: (selection: ChannelSelection, signal: AbortSignal) => Promise<void>;
  /** Withdraw/transition publication only when the endpoint actually changes. */
  beforeCandidate?: (selection: ChannelSelection, signal: AbortSignal) => Promise<void>;
}
/** Window for an on-demand seek, which must fetch a new range of a remote file. */
export const VOD_SEEK_MS = 45_000;
export type PlaybackState =
  | 'idle'
  | 'connecting'
  | 'playing'
  | 'buffering'
  | 'paused'
  | 'reconnecting'
  | 'failed'
  | 'disposed';
export interface PlaybackSnapshot {
  state: PlaybackState;
  selection: ChannelSelection | null;
  error: string | null;
  failure?: PlaybackFailure | null;
  pauseReason?: 'background' | null;
  audioTracks?: Readonly<AudioTracksSnapshot> | null;
}
export type FailureCode =
  | 'access'
  | 'unsupported'
  | 'missing'
  | 'network'
  | 'dns'
  | 'tls'
  | 'timeout'
  | 'decode'
  | 'policy'
  | 'unknown';
export type FailurePhase =
  | 'unknown'
  | 'connect'
  | 'headers'
  | 'body'
  | 'startup-progress'
  | 'buffering-progress'
  | 'decode'
  | 'capability';
export interface PlaybackFailure {
  code: FailureCode;
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
  /** Observed HTTP response only; never inferred from provider text. */
  httpStatus?: number;
  phase?: FailurePhase;
  evidence?: 'native' | 'http' | 'media' | 'opaque' | 'observed-progress';
  /** The stream's picture needs the device's own player (Android hands it over). */
  nativeFormat?: 'mpeg2';
}
export type EngineEvent =
  | { type: 'audio-tracks'; snapshot: Readonly<AudioTracksSnapshot> | null }
  | { type: 'progress' }
  | { type: 'decoded-progress'; evidence: DecodedProgressEvidence }
  | { type: 'buffering' }
  | { type: 'ended' }
  | { type: 'capability'; mediaKind: 'hls' | 'media'; mediaMime?: string }
  | { type: 'error'; failure: PlaybackFailure };
export interface PlaybackEngine {
  start(selection: ChannelSelection, signal: AbortSignal): Promise<void>;
  pause(): void;
  resume(): Promise<void>;
  setMuted(muted: boolean): void;
  setVolume(volume: number): void;
  readAudioTracks?(): Readonly<AudioTracksSnapshot> | null;
  setAudioTrack?(id: string | null): boolean;
  readVODposition?(): number | null;
  readVODduration?(): number | null;
  /** Must settle and remove temporary work on the captured signal's abort. */
  seekVOD?(
    seconds: number,
    signal: AbortSignal,
  ): Promise<'seeked' | 'out-of-range' | 'unavailable'>;
  /** Live instant replay within the player's own back buffer (REPLAY01). */
  liveReplay?(): LiveReplayEngine | null;
  dispose(): void | Promise<void>;
}
/** Seconds on the player's media timeline (docs/instant-replay.md). */
export interface ReplayWindow {
  /** Oldest buffered moment of the range holding the position (the players
   *  keep about REPLAY_REACH_SECONDS behind what they play). */
  start: number;
  /** Newest buffered moment. */
  end: number;
  position: number;
  /** One picture: measured from the decoder, 1/30 s until known. */
  frameSeconds: number;
}
export interface LiveReplayEngine {
  window(): ReplayWindow | null;
  /** Settles true once the picture at `seconds` is shown; false otherwise. */
  seek(seconds: number, signal: AbortSignal): Promise<boolean>;
  /** Below 1x the sound is muted; the viewer's own Mute is left as it is. */
  setRate(rate: number): void;
  setPaused(paused: boolean): void;
  /** Normal speed and sound, playing at the live edge. */
  leave(): void;
}
/** How far behind the live picture a replay can jump (owner decision,
 *  October 21, 2026). */
export const REPLAY_REACH_SECONDS = 30;
/** A replay this far behind live (long pauses, slow speeds) returns to live,
 *  which also bounds what a continuous live download buffers meanwhile. */
export const REPLAY_BEHIND_LIMIT_SECONDS = 60;
/** Replay is offered once this much is buffered behind the playing position. */
export const REPLAY_MINIMUM_SECONDS = 2;
export const REPLAY_RATES = [0.125, 0.25, 0.5, 1] as const;
/** Clamp a measured frame period; 1/30 s when unknown. */
export function replayFrameSeconds(measured: number | null | undefined): number {
  return typeof measured === 'number' && Number.isFinite(measured) && measured > 0
    ? Math.min(0.1, Math.max(1 / 120, measured))
    : 1 / 30;
}
/** The replayable part of a player's buffered ranges: the range holding the
 *  playing position; null when the position lies outside every range. How
 *  far back a replay may go is measured from the live picture, by the replay
 *  itself (its live point keeps moving while it runs). */
export function replayWindowFrom(
  ranges: ReadonlyArray<readonly [number, number]>,
  position: number,
  frameSeconds: number,
): ReplayWindow | null {
  if (!Number.isFinite(position) || position < 0 || ranges.length > 64) return null;
  let newest = -Infinity;
  for (const [start, end] of ranges) {
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start) return null;
    newest = Math.max(newest, end);
  }
  const holding = ranges.find(([start, end]) => start - 0.1 <= position && position <= end + 0.1);
  if (!holding) return null;
  return {
    start: holding[0],
    end: newest,
    position,
    frameSeconds: replayFrameSeconds(frameSeconds),
  };
}
/** Enough lies behind the playing position to start a replay. */
export const replayAvailable = (window: ReplayWindow | null): window is ReplayWindow =>
  !!window && window.position - window.start >= REPLAY_MINIMUM_SECONDS;
export const VOD_POSITION_LIMIT = 7 * 24 * 60 * 60;
export type SeekOutcome =
  | { ok: true }
  | {
      ok: false;
      reason: 'unavailable' | 'invalid-position' | 'out-of-range' | 'superseded' | 'failed';
    };
export type EngineFactory = (emit: (event: EngineEvent) => void) => PlaybackEngine;
export interface VODReleaseObservation {
  selectionId: string;
  positionSeconds: number | null;
  durationSeconds: number | null;
  reason: 'paused' | 'background' | 'failed' | 'completed' | 'stopped' | 'replaced' | 'disposed';
}
export interface DecodedSample {
  mediaTime: number;
  decodedFrames: number;
  width: number;
  height: number;
}
export interface DecodedProgressEvidence {
  kind: 'decoded';
  before: DecodedSample;
  after: DecodedSample;
  elapsedMilliseconds: number;
}
export interface DecodedPlaybackObservation {
  selection: ChannelSelection;
  attempt: Readonly<object>;
  evidence: DecodedProgressEvidence;
}
export function validDecodedProgress(evidence: DecodedProgressEvidence): boolean {
  return (
    evidence.kind === 'decoded' &&
    Number.isFinite(evidence.elapsedMilliseconds) &&
    evidence.elapsedMilliseconds > 0 &&
    evidence.elapsedMilliseconds <= 120000 &&
    [evidence.before, evidence.after].every(
      (sample) =>
        Number.isFinite(sample.mediaTime) &&
        sample.mediaTime >= 0 &&
        sample.mediaTime <= Number.MAX_SAFE_INTEGER &&
        Number.isSafeInteger(sample.decodedFrames) &&
        sample.decodedFrames >= 0 &&
        Number.isInteger(sample.width) &&
        sample.width > 0 &&
        sample.width <= 32768 &&
        Number.isInteger(sample.height) &&
        sample.height > 0 &&
        sample.height <= 32768,
    ) &&
    evidence.after.mediaTime > evidence.before.mediaTime &&
    evidence.after.decodedFrames > evidence.before.decodedFrames
  );
}
export interface PlaybackClock {
  now(): number;
  setTimeout(callback: () => void, delay: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
}
const clock: PlaybackClock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id),
};

/** Owns every engine and recovery timer. Initializers may settle late, never publish late. */
export class PlaybackController {
  private current: PlaybackSnapshot = { state: 'idle', selection: null, error: null };
  private listeners = new Set<(snapshot: PlaybackSnapshot) => void>();
  private decodedListeners = new Set<(observation: DecodedPlaybackObservation) => void>();
  private vodReleaseListeners = new Map<(observation: VODReleaseObservation) => void, () => void>();
  private vodTerminalOwners = new WeakSet<PlaybackEngine>();
  private vodCheckpoint: {
    engine: PlaybackEngine;
    generation: number;
    position: number;
  } | null = null;
  private decodedAttempt: Readonly<object> | null = null;
  private engine: PlaybackEngine | null = null;
  private engineGeneration: number | null = null;
  private abort: AbortController | null = null;
  private generation = 0;
  private queue: Promise<void> = Promise.resolve();
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private sliceTimer: ReturnType<typeof setTimeout> | undefined;
  private releaseSliceOwner: (() => void) | undefined;
  private recovery: RecoveryPlan | null = null;
  private candidateIndex = 0;
  private originBlockedUntil = new Map<string, number>();
  private initializer: Promise<void> | null = null;
  private failureCleanup: {
    generation: number;
    selectionId: string | null;
    work: Promise<void>;
  } | null = null;
  private episodeEnds = 0;
  private episodePhase: 'startup-progress' | 'buffering-progress' = 'startup-progress';
  private retries = 0;
  private muted = false;
  private volume = 1;
  private disposePromise: Promise<void> | null = null;
  private suspensionPromise: Promise<void> | null = null;
  private suspensionGeneration = -1;
  private releaseEngineOwner: (() => void) | undefined;
  private releaseDeadlineOwner: (() => void) | undefined;
  private releaseRetryOwner: (() => void) | undefined;
  private listenerOwners = new Map<(snapshot: PlaybackSnapshot) => void, () => void>();
  private decodedOwners = new Map<(observation: DecodedPlaybackObservation) => void, () => void>();

  constructor(
    private readonly factory: EngineFactory,
    private readonly time: PlaybackClock = clock,
    private readonly resources: ResourceOwners = playbackResourceOwners,
  ) {
    resources.cover('controller');
  }
  get snapshot(): PlaybackSnapshot {
    return {
      ...this.current,
      selection: this.current.selection ? { ...this.current.selection } : null,
      ...(this.current.failure ? { failure: { ...this.current.failure } } : {}),
      ...(this.current.audioTracks
        ? {
            audioTracks: {
              ...this.current.audioTracks,
              tracks: this.current.audioTracks.tracks.map((track) => ({ ...track })),
            },
          }
        : {}),
    };
  }
  subscribe(listener: (snapshot: PlaybackSnapshot) => void): () => void {
    if (this.current.state === 'disposed') {
      listener(this.snapshot);
      return () => {};
    }
    if (!this.listeners.has(listener))
      this.listenerOwners.set(listener, this.resources.acquire('controllerListeners'));
    this.listeners.add(listener);
    const unsubscribe = () => {
      this.listeners.delete(listener);
      this.listenerOwners.get(listener)?.();
      this.listenerOwners.delete(listener);
    };
    try {
      listener(this.snapshot);
    } catch (error) {
      unsubscribe();
      throw error;
    }
    return unsubscribe;
  }
  get audioTracks(): Readonly<AudioTracksSnapshot> | null {
    if (!this.engine || this.abort?.signal.aborted || this.current.state === 'disposed')
      return null;
    try {
      return this.engine.readAudioTracks?.() ?? null;
    } catch {
      return null;
    }
  }
  /** Capture synchronously before generation changes invalidate the original decoder. */
  subscribeVODRelease(listener: (observation: VODReleaseObservation) => void): () => void {
    if (this.current.state === 'disposed') return () => {};
    if (!this.vodReleaseListeners.has(listener))
      this.vodReleaseListeners.set(listener, this.resources.acquire('controllerListeners'));
    return () => {
      this.vodReleaseListeners.get(listener)?.();
      this.vodReleaseListeners.delete(listener);
    };
  }
  private observeVODRelease(reason: VODReleaseObservation['reason']): void {
    const owner = this.engine;
    const selection = this.current.selection;
    if (
      !owner ||
      selection?.playMode !== 'on-demand' ||
      this.engineGeneration !== this.generation ||
      this.abort?.signal.aborted
    )
      return;
    if (this.vodTerminalOwners.has(owner)) return;
    if (reason !== 'paused') this.vodTerminalOwners.add(owner);
    const observation = Object.freeze({
      selectionId: selection.id,
      positionSeconds: this.checkpointVODposition(),
      durationSeconds: this.currentVODduration(),
      reason,
    });
    for (const listener of [...this.vodReleaseListeners.keys()]) {
      try {
        listener(observation);
      } catch {
        /* Persistence observers cannot prevent decoder cleanup. */
      }
    }
  }
  setAudioTrack(id: string | null): boolean {
    if (!this.engine || this.abort?.signal.aborted || this.current.state === 'disposed')
      return false;
    try {
      return this.engine.setAudioTrack?.(id) ?? false;
    } catch {
      return false;
    }
  }
  /**
   * Instant replay for the live channel playing now (REPLAY01), or null. The
   * handle is tied to this attempt: once the channel changes, stops, pauses,
   * fails or is released, every call is a no-op and window() is null.
   */
  liveReplay(): LiveReplayEngine | null {
    const owner = this.engine,
      generation = this.generation,
      abort = this.abort;
    const current = () =>
      !!owner &&
      !!abort &&
      this.engine === owner &&
      this.generation === generation &&
      this.engineGeneration === generation &&
      !abort.signal.aborted &&
      this.current.selection?.playMode !== 'on-demand' &&
      ['playing', 'buffering'].includes(this.current.state);
    if (!current()) return null;
    let inner: LiveReplayEngine | null;
    try {
      inner = owner!.liveReplay?.() ?? null;
    } catch {
      inner = null;
    }
    if (!inner) return null;
    const engine = inner;
    const guarded = <T>(fallback: T, action: () => T): T => {
      if (!current()) return fallback;
      try {
        return action();
      } catch {
        return fallback;
      }
    };
    return {
      window: () => guarded(null, () => engine.window()),
      seek: (seconds, signal) =>
        guarded(Promise.resolve(false), () => {
          const signals = createOwnedAbortSignals([abort!.signal, signal], this.resources);
          return engine
            .seek(seconds, signals.signal)
            .then(
              (shown) => shown && current(),
              () => false,
            )
            .finally(() => signals.dispose());
        }),
      setRate: (rate) => guarded(undefined, () => engine.setRate(rate)),
      setPaused: (paused) => guarded(undefined, () => engine.setPaused(paused)),
      leave: () => guarded(undefined, () => engine.leave()),
    };
  }
  subscribeDecoded(listener: (observation: DecodedPlaybackObservation) => void): () => void {
    if (this.current.state === 'disposed') return () => {};
    if (!this.decodedListeners.has(listener))
      this.decodedOwners.set(listener, this.resources.acquire('decodedObservers'));
    this.decodedListeners.add(listener);
    return () => {
      this.decodedListeners.delete(listener);
      this.decodedOwners.get(listener)?.();
      this.decodedOwners.delete(listener);
    };
  }
  isDecodedCurrent(observation: DecodedPlaybackObservation): boolean {
    return (
      this.decodedAttempt !== null &&
      observation.attempt === this.decodedAttempt &&
      this.current.state === 'playing' &&
      !this.abort?.signal.aborted &&
      observation.selection.id === this.current.selection?.id &&
      observation.selection.url === this.current.selection?.url
    );
  }
  private publish(
    state: PlaybackState,
    error: string | null = null,
    failure: PlaybackFailure | null = null,
    pauseReason: 'background' | null = null,
  ): void {
    this.current = {
      ...this.current,
      state,
      error,
      failure: failure ? { ...failure } : null,
      pauseReason,
    };
    for (const listener of this.listeners) {
      try {
        listener(this.snapshot);
      } catch {
        /* A failed observer cannot interrupt engine cleanup or other observers. */
      }
    }
  }
  private clearTimers(): void {
    if (this.deadline !== undefined) this.time.clearTimeout(this.deadline);
    if (this.retryTimer !== undefined) this.time.clearTimeout(this.retryTimer);
    this.clearSlice();
    this.releaseDeadlineOwner?.();
    this.releaseRetryOwner?.();
    this.releaseDeadlineOwner = this.releaseRetryOwner = undefined;
    this.deadline = this.retryTimer = undefined;
  }
  private clearSlice(): void {
    if (this.sliceTimer !== undefined) this.time.clearTimeout(this.sliceTimer);
    this.sliceTimer = undefined;
    this.releaseSliceOwner?.();
    this.releaseSliceOwner = undefined;
  }
  private enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {
      /* Caller sees error; later cleanup must still run. */
    });
    return result;
  }
  private async release(): Promise<void> {
    this.vodCheckpoint = null;
    const old = this.engine;
    // Retain ownership on a failed disposal. A later selection must retry cleanup,
    // never allocate a second engine while the first may still own resources.
    if (old) {
      await old.dispose();
      // Cancellation/disposal must join the actual initializer, even if it settles late.
      await this.initializer?.catch(() => {});
      if (this.engine === old) {
        this.initializer = null;
        this.engine = null;
        this.engineGeneration = null;
        this.releaseEngineOwner?.();
        this.releaseEngineOwner = undefined;
      }
    }
  }
  /** A selection's own time to start (paid accounts wait out a busy provider). */
  private startupBudget(): number {
    const ms = this.current.selection?.startupMs;
    return Number.isFinite(ms) ? Math.min(45_000, Math.max(20_000, ms!)) : 20_000;
  }
  private beginEpisode(
    generation: number,
    phase: 'startup-progress' | 'buffering-progress' = 'startup-progress',
    ends = this.time.now() + 20_000,
  ): void {
    this.clearTimers();
    this.retries = 0;
    this.episodePhase = phase;
    this.episodeEnds = ends;
    this.deadline = this.time.setTimeout(
      () => {
        this.deadline = undefined;
        this.releaseDeadlineOwner?.();
        this.releaseDeadlineOwner = undefined;
        if (generation !== this.generation) return;
        const phase = this.episodePhase;
        const target = this.current.selection?.playMode === 'on-demand' ? 'video' : 'channel';
        const message =
          phase === 'buffering-progress'
            ? `Playback stopped making progress. Retry or choose another ${target}.`
            : `Playback did not start in time. Retry or choose another ${target}.`;
        this.fail(message, {
          code: 'timeout',
          phase,
          evidence: 'observed-progress',
          message,
          retryable: true,
        });
      },
      Math.max(0, ends - this.time.now()),
    );
    this.releaseDeadlineOwner = this.resources.acquire('controllerTimers');
  }
  private fail(message: string, failure: PlaybackFailure | null = null): void {
    this.observeVODRelease('failed');
    this.current = { ...this.current, audioTracks: null };
    this.decodedAttempt = null;
    const failedGeneration = ++this.generation;
    this.clearTimers();
    this.episodeEnds = 0;
    // Reserve old cleanup before abort listeners or observers can queue a new selection.
    const cleanup = this.enqueue(() => this.release());
    this.failureCleanup = {
      generation: failedGeneration,
      selectionId: this.current.selection?.id ?? null,
      work: cleanup,
    };
    this.abort?.abort();
    if (failedGeneration === this.generation) this.publish('failed', message, failure);
    void cleanup.catch(() => {
      if (failedGeneration === this.generation && this.current.state !== 'disposed')
        this.publish('failed', 'The player could not release its resources. Restart the app.');
    });
  }
  async select(selection: ChannelSelection, recovery?: RecoveryPlan): Promise<void> {
    if (this.current.state === 'disposed') return;
    if (
      recovery &&
      (recovery.urls.length < 1 ||
        recovery.urls.length > 16 ||
        recovery.urls[0] !== selection.url ||
        recovery.urls.some((url) => typeof url !== 'string' || !url))
    )
      throw new Error('The channel recovery sources are invalid.');
    this.observeVODRelease('replaced');
    startTiming.enterPlayer();
    const generation = ++this.generation;
    this.decodedAttempt = null;
    this.clearTimers();
    this.recovery = recovery ? { ...recovery, urls: [...recovery.urls] } : null;
    this.candidateIndex = 0;
    this.originBlockedUntil.clear();
    this.current = { state: 'connecting', selection: { ...selection }, error: null };
    const attempt = this.enqueue(async () => {
      await this.release();
      if (generation === this.generation) await this.start(generation);
    });
    this.beginEpisode(generation, 'startup-progress', this.time.now() + this.startupBudget());
    this.abort?.abort();
    if (generation === this.generation) this.publish('connecting');
    await attempt.catch(() => {
      if (generation === this.generation)
        this.fail('The player could not release its resources. Restart the app.');
    });
  }
  private async start(
    generation: number,
    recovering = false,
    endpointChanged = false,
  ): Promise<void> {
    const selection = this.current.selection;
    if (!selection || generation !== this.generation) return;
    this.decodedAttempt = Object.freeze({});
    if (recovering) startTiming.count('retries');
    startTiming.mark('engine-start');
    const abort = new AbortController();
    this.abort = abort;
    if (recovering && this.recovery) {
      try {
        await this.recovery.beforeRetry?.({ ...selection }, abort.signal);
        if (
          generation !== this.generation ||
          abort.signal.aborted ||
          this.time.now() >= this.episodeEnds
        )
          return;
        if (endpointChanged) await this.recovery.beforeCandidate?.({ ...selection }, abort.signal);
      } catch {
        if (generation === this.generation && !abort.signal.aborted)
          this.fail(
            `Playback recovery was not authorized. Retry the ${selection.playMode === 'on-demand' ? 'video' : 'channel'}.`,
            {
              code: 'policy',
              message: `Playback recovery was not authorized. Retry the ${selection.playMode === 'on-demand' ? 'video' : 'channel'}.`,
              retryable: false,
            },
          );
        return;
      }
    }
    if (
      generation !== this.generation ||
      abort.signal.aborted ||
      this.time.now() >= this.episodeEnds
    )
      return;
    let owner: PlaybackEngine;
    try {
      owner = this.factory((event) => {
        if (generation === this.generation && this.engine === owner && !abort.signal.aborted)
          this.onEvent(event, generation);
      });
      this.engine = owner;
      this.engineGeneration = generation;
      this.releaseEngineOwner = this.resources.acquire('controllerEngines');
      owner.setMuted(this.muted);
      owner.setVolume(this.volume);
      this.armSlice(generation, owner, abort);
      this.initializer = Promise.resolve().then(() => owner.start(selection, abort.signal));
      void this.initializer.catch(() => {
        if (generation === this.generation && this.engine === owner && !abort.signal.aborted)
          this.onEvent(
            {
              type: 'error',
              failure: {
                code: 'unknown',
                message: `The stream could not start. Retry or choose another ${selection.playMode === 'on-demand' ? 'video' : 'channel'}.`,
                retryable: true,
              },
            },
            generation,
          );
      });
    } catch {
      this.fail('The player could not initialize. Restart the app.');
    }
  }
  private armSlice(generation: number, owner: PlaybackEngine, abort: AbortController): void {
    this.clearSlice();
    if (!this.recovery || this.candidateIndex + 1 >= this.recovery.urls.length || this.retries >= 2)
      return;
    const remaining = this.episodeEnds - this.time.now();
    const attempts = Math.min(3 - this.retries, this.recovery.urls.length - this.candidateIndex);
    this.sliceTimer = this.time.setTimeout(
      () => {
        this.clearSlice();
        if (generation !== this.generation || this.engine !== owner || abort.signal.aborted) return;
        this.onEvent(
          {
            type: 'error',
            failure: {
              code: 'timeout',
              phase: this.episodePhase,
              evidence: 'observed-progress',
              retryable: true,
              message: 'The stream stopped making progress. Trying another admitted source.',
            },
          },
          generation,
        );
      },
      Math.max(1, Math.floor(remaining / attempts)),
    );
    this.releaseSliceOwner = this.resources.acquire('controllerTimers');
  }
  private origin(url: string): string {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  }
  private onEvent(event: EngineEvent, generation: number): void {
    if (event.type === 'ended') {
      // A live stream has no end: the source closed it (providers drop long
      // sessions). Reconnect through the same bounded path as a dropped
      // connection instead of waiting on a dead stream for the viewer's Retry.
      if (this.current.selection?.playMode !== 'on-demand') {
        this.onEvent(
          {
            type: 'error',
            failure: {
              code: 'network',
              message: 'The live stream stopped. Reconnecting.',
              retryable: true,
              phase: 'body',
              evidence: 'media',
            },
          },
          generation,
        );
        return;
      }
      this.observeVODRelease('completed');
      const stoppedGeneration = this.generation + 1;
      // Natural finite completion releases the same retained owner as ordinary Stop.
      void this.stop().catch(() => {
        if (this.generation === stoppedGeneration)
          this.fail('The player could not release its resources. Restart the app.');
      });
      return;
    }
    if (event.type === 'audio-tracks') {
      this.current = { ...this.current, audioTracks: event.snapshot };
      this.publish(this.current.state);
      return;
    }
    if (event.type === 'decoded-progress') {
      if (
        this.decodedAttempt &&
        this.current.selection &&
        this.current.state === 'playing' &&
        validDecodedProgress(event.evidence)
      ) {
        const attempt = this.decodedAttempt;
        const selection = { ...this.current.selection };
        for (const listener of this.decodedListeners) {
          // An observer may synchronously change channels or end this attempt.
          if (
            generation !== this.generation ||
            this.decodedAttempt !== attempt ||
            this.current.state !== 'playing' ||
            this.abort?.signal.aborted
          )
            break;
          try {
            listener({
              selection: { ...selection },
              attempt,
              evidence: structuredClone(event.evidence),
            });
          } catch {
            /* Optional health observers cannot interrupt playback ownership. */
          }
        }
      }
      return;
    }
    if (event.type === 'capability') {
      if (this.current.selection) {
        this.current.selection = {
          ...this.current.selection,
          mediaKind: event.mediaKind,
          mediaMime: event.mediaMime,
        };
        this.publish(this.current.state);
      }
      return;
    }
    if (this.current.state === 'paused') return;
    if (event.type === 'progress') {
      this.clearTimers();
      this.episodeEnds = 0;
      startTiming.mark('playback-start');
      this.publish('playing');
      return;
    }
    if (event.type === 'buffering') {
      if (!this.episodeEnds) {
        this.beginEpisode(generation, 'buffering-progress');
        if (this.engine && this.abort) this.armSlice(generation, this.engine, this.abort);
      }
      this.publish('buffering');
      return;
    }
    // A reconnect gets the same budget as the first start: a one-connection
    // provider still counting the old stream keeps the relay waiting (SC-001).
    if (!this.episodeEnds)
      this.beginEpisode(
        generation,
        this.current.state === 'playing' ? 'buffering-progress' : 'startup-progress',
        this.time.now() + this.startupBudget(),
      );
    if (this.retryTimer !== undefined) return;
    const now = this.time.now();
    const activeUrl = this.current.selection?.url;
    const retryAfter = event.failure.retryAfterMs;
    if (activeUrl && retryAfter !== undefined && Number.isFinite(retryAfter) && retryAfter > 0) {
      const origin = this.origin(activeUrl);
      this.originBlockedUntil.set(
        origin,
        Math.max(this.originBlockedUntil.get(origin) ?? 0, now + retryAfter),
      );
    }
    let nextIndex = this.candidateIndex;
    if (this.recovery && nextIndex + 1 < this.recovery.urls.length) nextIndex++;
    const nextUrl = this.recovery?.urls[nextIndex] ?? activeUrl;
    const blockedUntil = nextUrl ? (this.originBlockedUntil.get(this.origin(nextUrl)) ?? 0) : 0;
    // A Retry-After applies to the origin, including another URL on that origin.
    const wait = Math.max(
      0,
      blockedUntil - now,
      nextUrl === activeUrl ? (Number.isFinite(retryAfter) ? retryAfter! : 250) : 250,
    );
    const candidateSpecific =
      nextUrl !== activeUrl && ['missing', 'unsupported', 'decode'].includes(event.failure.code);
    if (
      (!event.failure.retryable && !candidateSpecific) ||
      event.failure.code === 'access' ||
      event.failure.code === 'policy' ||
      this.retries >= 2 ||
      this.time.now() + wait >= this.episodeEnds
    ) {
      this.fail(event.failure.message, event.failure);
      return;
    }
    this.observeVODRelease('failed');
    this.retries++;
    this.clearSlice();
    this.current = { ...this.current, audioTracks: null };
    this.decodedAttempt = null;
    this.abort?.abort();
    if (generation !== this.generation) return;
    this.publish('reconnecting', event.failure.message, event.failure);
    if (generation !== this.generation) return;
    this.retryTimer = this.time.setTimeout(() => {
      this.retryTimer = undefined;
      this.releaseRetryOwner?.();
      this.releaseRetryOwner = undefined;
      if (generation !== this.generation) return;
      void this.enqueue(async () => {
        await this.release();
        if (generation !== this.generation) return;
        this.candidateIndex = nextIndex;
        // A different address must have its format checked again; the same
        // address keeps its known format, so a retry never adds a probe
        // connection (one-connection paid accounts refuse a second one).
        if (nextUrl && nextUrl !== activeUrl && this.current.selection) {
          const { mediaKind: _kind, mediaMime: _mime, ...selection } = this.current.selection;
          this.current = {
            ...this.current,
            audioTracks: null,
            selection: { ...selection, url: nextUrl },
          };
        }
        if (generation === this.generation)
          await this.start(generation, true, nextUrl !== activeUrl);
      }).catch(() => {
        if (generation === this.generation)
          this.fail('The player could not release its resources. Restart the app.');
      });
    }, wait);
    this.releaseRetryOwner = this.resources.acquire('controllerTimers');
  }
  pause(): void {
    if (
      this.current.selection &&
      !['disposed', 'failed', 'idle', 'paused'].includes(this.current.state) &&
      (!this.engine || this.abort?.signal.aborted)
    ) {
      // A recovery gate/cleanup can be pending without a live decoder. Invalidate
      // that attempt now; an explicit resume owns the next allocation.
      const generation = ++this.generation;
      this.decodedAttempt = null;
      this.clearTimers();
      this.episodeEnds = 0;
      const cleanup = this.enqueue(() => this.release());
      this.abort?.abort();
      if (generation === this.generation) this.publish('paused');
      void cleanup.catch(() => {
        if (generation === this.generation)
          this.fail('The player could not release its resources. Restart the app.');
      });
      return;
    }
    if (!this.engine && this.current.state === 'paused') {
      this.publish('paused');
      return;
    }
    if (!this.engine || ['disposed', 'failed'].includes(this.current.state)) return;
    this.decodedAttempt = null;
    this.engine.pause();
    this.observeVODRelease('paused');
    this.clearTimers();
    this.episodeEnds = 0;
    this.publish('paused');
  }
  /** Background suspension releases the decoder/network owner; foreground needs explicit resume. */
  suspend(): Promise<void> {
    if (this.current.state === 'disposed')
      return this.dispose().catch(() => {
        throw new Error('Background playback cleanup could not be confirmed.');
      });
    if (this.suspensionPromise && this.suspensionGeneration === this.generation)
      return this.suspensionPromise;
    if (
      !this.engine &&
      (!this.current.selection || ['failed', 'idle'].includes(this.current.state))
    )
      return Promise.resolve();
    this.observeVODRelease('background');
    const generation = ++this.generation;
    const backgroundPause =
      this.current.state !== 'paused' || this.current.pauseReason === 'background';
    this.decodedAttempt = null;
    this.clearTimers();
    this.episodeEnds = 0;
    const cleanup = this.enqueue(() => this.release());
    const settled = cleanup
      .catch(() => {
        if (generation === this.generation)
          this.fail('The player could not release its resources. Restart the app.');
        throw new Error('Background playback cleanup could not be confirmed.');
      })
      .finally(() => {
        if (this.suspensionPromise === settled) this.suspensionPromise = null;
      });
    // Reserve before abort callbacks or observers can reenter suspension.
    this.suspensionPromise = settled;
    this.suspensionGeneration = generation;
    this.abort?.abort();
    if (generation === this.generation)
      this.publish('paused', null, null, backgroundPause ? 'background' : null);
    return settled;
  }
  async resume(): Promise<void> {
    if (this.current.state !== 'paused') return;
    if ((!this.engine || this.abort?.signal.aborted) && this.current.selection) {
      await this.select(
        this.current.selection,
        this.recovery
          ? {
              ...this.recovery,
              urls: [
                this.current.selection.url,
                ...this.recovery.urls.filter((url) => url !== this.current.selection?.url),
              ],
            }
          : undefined,
      );
      return;
    }
    if (!this.engine) return;
    const generation = this.generation;
    const owner = this.engine;
    this.decodedAttempt = Object.freeze({});
    this.beginEpisode(generation);
    if (this.abort) this.armSlice(generation, owner, this.abort);
    this.publish('connecting');
    if (generation !== this.generation || this.engine !== owner || this.abort?.signal.aborted)
      return;
    try {
      await owner.resume();
    } catch {
      if (generation === this.generation)
        this.fail(
          `Playback could not resume. Retry the ${this.current.selection?.playMode === 'on-demand' ? 'video' : 'channel'}.`,
        );
    }
  }
  /** Actual current decoder position, never a catalog duration or title match. */
  currentVODposition(): number | null {
    if (
      this.current.selection?.playMode !== 'on-demand' ||
      !this.engine ||
      this.engineGeneration !== this.generation ||
      this.abort?.signal.aborted
    )
      return null;
    try {
      const value = this.engine.readVODposition?.();
      if (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        value >= 0 &&
        value <= VOD_POSITION_LIMIT
      ) {
        // Only actual non-seeking engine observations can become checkpoints.
        // seek() samples this before issuing a target; the target is never cached.
        this.vodCheckpoint = { engine: this.engine, generation: this.generation, position: value };
        return value;
      }
      return null;
    } catch {
      return null;
    }
  }
  /** Lifecycle persistence may retain the last real observation during a seek.
   * Strict live reads and seek admission still use currentVODposition(). */
  checkpointVODposition(): number | null {
    const fresh = this.currentVODposition();
    if (fresh !== null) return fresh;
    const saved = this.vodCheckpoint;
    return saved &&
      this.current.selection?.playMode === 'on-demand' &&
      this.engine === saved.engine &&
      this.engineGeneration === this.generation &&
      saved.generation === this.generation &&
      !this.abort?.signal.aborted
      ? saved.position
      : null;
  }
  /** Finite duration from the original decoder, never provider metadata. */
  currentVODduration(): number | null {
    if (
      this.current.selection?.playMode !== 'on-demand' ||
      !this.engine ||
      this.engineGeneration !== this.generation ||
      this.abort?.signal.aborted
    )
      return null;
    try {
      const duration = this.engine.readVODduration?.();
      return typeof duration === 'number' &&
        Number.isFinite(duration) &&
        duration > 0 &&
        duration <= VOD_POSITION_LIMIT
        ? duration
        : null;
    } catch {
      return null;
    }
  }
  /** One owned readiness wait (twenty seconds) and one seek under its own seek window. */
  seekWhenReady(seconds: number, signal?: AbortSignal): Promise<SeekOutcome> {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > VOD_POSITION_LIMIT)
      return Promise.resolve({ ok: false, reason: 'invalid-position' });
    const captured = this.generation;
    const selectionId = this.current.selection?.id;
    if (!selectionId || this.current.selection?.playMode !== 'on-demand')
      return Promise.resolve({ ok: false, reason: 'unavailable' });
    const request = new AbortController();
    return new Promise<SeekOutcome>((resolve) => {
      let started = false,
        settled = false;
      // Cleanup may run before subscription/timer acquisition (already-aborted input).
      // eslint-disable-next-line prefer-const
      let unsubscribe: (() => void) | undefined;
      // eslint-disable-next-line prefer-const
      let timer: ReturnType<typeof setTimeout> | undefined;
      // eslint-disable-next-line prefer-const
      let releaseTimer: (() => void) | undefined;
      let releaseAbort: (() => void) | undefined;
      const finish = (outcome: SeekOutcome) => {
        if (settled) return;
        settled = true;
        unsubscribe?.();
        if (timer !== undefined) this.time.clearTimeout(timer);
        releaseTimer?.();
        signal?.removeEventListener('abort', abort);
        releaseAbort?.();
        resolve(outcome);
      };
      const abort = () => {
        request.abort(signal?.reason);
        // An already-started seek must actually settle before cancellation is acknowledged.
        if (!started) finish({ ok: false, reason: 'superseded' });
      };
      if (signal?.aborted) {
        abort();
        return;
      }
      if (signal) {
        signal.addEventListener('abort', abort, { once: true });
        releaseAbort = this.resources.acquire('abortListeners');
      }
      // Bounds only the readiness wait; once the seek starts, its own window governs.
      timer = this.time.setTimeout(() => {
        if (started) return;
        request.abort(new Error('Resume seek deadline reached.'));
        finish({ ok: false, reason: 'unavailable' });
      }, 20_000);
      releaseTimer = this.resources.acquire('controllerTimers');
      unsubscribe = this.subscribe((snapshot) => {
        if (settled || started) return;
        if (
          this.generation !== captured ||
          snapshot.selection?.id !== selectionId ||
          ['failed', 'disposed', 'idle'].includes(snapshot.state)
        ) {
          finish({ ok: false, reason: snapshot.state === 'failed' ? 'failed' : 'superseded' });
          return;
        }
        if (
          !['playing', 'paused', 'buffering'].includes(snapshot.state) ||
          this.currentVODposition() === null
        )
          return;
        started = true;
        // The seek's own window starts now, not when this readiness wait began.
        void this.seek(seconds, undefined, request.signal).then(finish, () =>
          finish({ ok: false, reason: 'failed' }),
        );
      });
      if (settled) unsubscribe();
    });
  }
  async seek(seconds: number, until?: number, signal?: AbortSignal): Promise<SeekOutcome> {
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > VOD_POSITION_LIMIT)
      return { ok: false, reason: 'invalid-position' };
    const owner = this.engine,
      generation = this.generation,
      abort = this.abort;
    if (
      !owner?.seekVOD ||
      !abort ||
      this.currentVODposition() === null ||
      !['playing', 'paused', 'buffering'].includes(this.current.state)
    )
      return { ok: false, reason: 'unavailable' };
    const current = () =>
      this.generation === generation && this.engine === owner && !abort.signal.aborted;
    let result: SeekOutcome = { ok: false, reason: 'superseded' };
    await this.enqueue(async () => {
      if (!current() || signal?.aborted) return;
      const previousEnds = this.episodeEnds,
        previousPhase = this.episodePhase,
        previousRetries = this.retries;
      // Seeking a remote file needs a new range response; on-demand gets a longer
      // window. A seek during stall recovery stays capped by that recovery
      // deadline, but a seek while the video is still starting (resume) does not
      // inherit the remainder of the startup window.
      const fresh =
        this.time.now() + (this.current.selection?.playMode === 'on-demand' ? VOD_SEEK_MS : 20_000);
      const ends = Math.min(
        until ?? Infinity,
        previousEnds > 0 && previousPhase === 'buffering-progress'
          ? Math.min(previousEnds, fresh)
          : fresh,
      );
      if (ends <= this.time.now()) {
        result = { ok: false, reason: 'unavailable' };
        return;
      }
      this.beginEpisode(generation, 'buffering-progress', ends);
      this.decodedAttempt = null;
      let outcome: 'seeked' | 'out-of-range' | 'unavailable' | 'failed';
      const signals = createOwnedAbortSignals(
        signal ? [abort.signal, signal] : [abort.signal],
        this.resources,
      );
      try {
        outcome = await owner.seekVOD!(seconds, signals.signal);
      } catch {
        outcome = 'failed';
      } finally {
        signals.dispose();
      }
      if (!current()) {
        if (this.generation === generation + 1 && this.current.state === 'failed')
          result = { ok: false, reason: 'failed' };
        return;
      }
      this.decodedAttempt = Object.freeze({});
      if (outcome === 'seeked' && !signal?.aborted) {
        if (this.current.state === 'paused') {
          this.clearTimers();
          this.episodeEnds = 0;
        } else if (this.episodeEnds > 0) this.publish('buffering'); // seeked is not advancing decoded playback.
        result = { ok: true };
      } else {
        this.clearTimers();
        this.episodeEnds = 0;
        if (previousEnds > 0 && this.current.state !== 'paused') {
          // A startup window the seek replaced is renewed rather than restored
          // already expired; stall recovery keeps its original deadline.
          this.beginEpisode(
            generation,
            previousPhase,
            previousPhase === 'startup-progress'
              ? Math.max(previousEnds, this.time.now() + 20_000)
              : previousEnds,
          );
          this.retries = previousRetries;
        }
        result = {
          ok: false,
          reason: signal?.aborted ? 'superseded' : outcome === 'seeked' ? 'unavailable' : outcome,
        };
      }
    });
    return result;
  }
  /** A waiting explanation for the start of `selectionId` (e.g. a busy provider).
   *  Ignored unless that exact selection is still connecting. */
  note(selectionId: string, message: string): void {
    if (this.current.state !== 'connecting' || this.current.selection?.id !== selectionId) return;
    this.publish('connecting', message);
  }
  setMuted(muted: boolean): void {
    this.muted = muted;
    this.engine?.setMuted(muted);
  }
  setVolume(volume: number): void {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.min(1, Math.max(0, volume));
    this.engine?.setVolume(this.volume);
  }
  /** Join the already reserved failed decoder cleanup without changing its guidance. */
  joinFailedCleanup(selectionId: string): Promise<void> {
    const captured = this.failureCleanup;
    if (
      !captured ||
      captured.generation !== this.generation ||
      this.current.state !== 'failed' ||
      captured.selectionId !== selectionId ||
      this.current.selection?.id !== selectionId
    )
      return Promise.reject(new DOMException('Failed playback was replaced.', 'AbortError'));
    // Return the original producer itself: a later selection cannot redirect
    // this join to a newer engine, and observer cancellation cannot detach it.
    return captured.work;
  }
  async stop(): Promise<void> {
    if (this.current.state === 'disposed') return this.dispose();
    this.observeVODRelease('stopped');
    const generation = ++this.generation;
    this.decodedAttempt = null;
    this.clearTimers();
    this.episodeEnds = 0;
    this.current = { state: 'idle', selection: null, error: null };
    this.recovery = null;
    this.originBlockedUntil.clear();
    const cleanup = this.enqueue(() => this.release());
    this.abort?.abort();
    if (generation === this.generation) this.publish('idle');
    await cleanup;
  }
  dispose(): Promise<void> {
    if (this.disposePromise) return this.disposePromise;
    this.observeVODRelease('disposed');
    // Reserve ownership before abort listeners or subscribers can reenter.
    const attempt = this.enqueue(() => this.release());
    this.disposePromise = attempt;
    // Coalesce in-flight and successful disposal, but a rejected cleanup is not
    // a release acknowledgment. Keep the engine and allow an explicit retry.
    void attempt.catch(() => {
      if (this.disposePromise === attempt) this.disposePromise = null;
    });
    ++this.generation;
    this.decodedAttempt = null;
    this.current = { state: 'disposed', selection: null, error: null };
    this.recovery = null;
    this.originBlockedUntil.clear();
    this.abort?.abort();
    this.clearTimers();
    this.publish('disposed');
    this.listeners.clear();
    this.decodedListeners.clear();
    for (const release of this.listenerOwners.values()) release();
    for (const release of this.decodedOwners.values()) release();
    this.listenerOwners.clear();
    this.decodedOwners.clear();
    for (const release of this.vodReleaseListeners.values()) release();
    this.vodReleaseListeners.clear();
    return attempt;
  }
}
