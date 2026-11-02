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
  VOD_POSITION_LIMIT,
  clock,
  type DecodedPlaybackObservation,
  type EngineFactory,
  type LiveReplayEngine,
  type PlaybackClock,
  type PlaybackControllerOptions,
  type PlaybackEngine,
  type PlaybackFailure,
  type PlaybackSnapshot,
  type PlaybackState,
  type RecoveryPlan,
  type VODReleaseObservation,
} from './controller-model';
import { playbackResourceOwners, type ResourceOwners } from './resource-owners';
import { createSourceQuality, sourcePerformanceKey } from './source-quality';
import { type ChannelSelection } from './controller-model';
import { type AudioTracksSnapshot } from './audio-tracks';
import { createOwnedAbortSignals } from '../platform/abort';
import {
  normalizeLiveBufferPreference,
  normalizeLiveBufferTelemetry,
  type LiveBufferPreference,
  type LiveBufferTelemetry,
} from './live-buffer';

/**
 * The playback controller's state and what can be read from it: snapshots
 * and their listeners, audio tracks, live replay, decoded-progress and VOD
 * release observers, and the VOD position. PlaybackController (controller.ts)
 * adds what changes it: start, engine events, pause, resume, seek and stop.
 */
export class PlaybackControllerCore {
  protected readonly sourceQuality = createSourceQuality(() => this.time.now());
  protected sourceSuppressed = false;
  protected sourceAttempt: ReturnType<ReturnType<typeof createSourceQuality>['open']> | null = null;
  rankSourceKeys(keys: readonly string[]): string[] {
    return this.sourceQuality.rank(keys);
  }
  forgetSourceKey(key: string): void {
    this.sourceQuality.forget(key);
  }
  get sourceObservationAllowed(): boolean {
    const selection = this.current.selection;
    return (
      !this.sourceSuppressed &&
      !!selection &&
      selection.playMode !== 'on-demand' &&
      ['playing', 'buffering', 'failed'].includes(this.current.state)
    );
  }
  get canRecoverSource(): boolean {
    const selection = this.current.selection;
    if (!this.sourceObservationAllowed || !selection) return false;
    const facts = this.sourceQuality.facts(sourcePerformanceKey(selection));
    return !!facts && (facts.failures > 0 || facts.stalls >= 2);
  }
  /** Ranking never grants equivalence or starts a request; callers provide admitted candidates. */
  rankSources<T extends ChannelSelection>(candidates: readonly T[]): T[] {
    const unique = [...new Map(candidates.map((s) => [sourcePerformanceKey(s), s])).values()];
    const byKey = new Map(unique.map((s) => [sourcePerformanceKey(s), s]));
    return this.sourceQuality.rank([...byKey.keys()]).map((key) => ({ ...byKey.get(key)! }));
  }
  protected current: PlaybackSnapshot = { state: 'idle', selection: null, error: null };
  protected listeners = new Set<(snapshot: PlaybackSnapshot) => void>();
  protected decodedListeners = new Set<(observation: DecodedPlaybackObservation) => void>();
  protected vodReleaseListeners = new Map<
    (observation: VODReleaseObservation) => void,
    () => void
  >();
  protected vodTerminalOwners = new WeakSet<PlaybackEngine>();
  protected vodCheckpoint: {
    engine: PlaybackEngine;
    generation: number;
    position: number;
  } | null = null;
  protected decodedAttempt: Readonly<object> | null = null;
  protected engine: PlaybackEngine | null = null;
  protected engineGeneration: number | null = null;
  protected abort: AbortController | null = null;
  protected generation = 0;
  protected queue: Promise<void> = Promise.resolve();
  protected deadline: ReturnType<typeof setTimeout> | undefined;
  protected retryTimer: ReturnType<typeof setTimeout> | undefined;
  protected sliceTimer: ReturnType<typeof setTimeout> | undefined;
  protected releaseSliceOwner: (() => void) | undefined;
  protected recovery: RecoveryPlan | null = null;
  protected candidateIndex = 0;
  protected originBlockedUntil = new Map<string, number>();
  protected initializer: Promise<void> | null = null;
  protected failureCleanup: {
    generation: number;
    selectionId: string | null;
    work: Promise<void>;
  } | null = null;
  protected episodeEnds = 0;
  protected episodePhase: 'startup-progress' | 'buffering-progress' = 'startup-progress';
  protected retries = 0;
  protected muted = false;
  protected volume = 1;
  protected disposePromise: Promise<void> | null = null;
  protected suspensionPromise: Promise<void> | null = null;
  protected suspensionGeneration = -1;
  protected releaseEngineOwner: (() => void) | undefined;
  protected releaseDeadlineOwner: (() => void) | undefined;
  protected releaseRetryOwner: (() => void) | undefined;
  protected listenerOwners = new Map<(snapshot: PlaybackSnapshot) => void, () => void>();
  protected decodedOwners = new Map<
    (observation: DecodedPlaybackObservation) => void,
    () => void
  >();
  constructor(
    protected readonly factory: EngineFactory,
    protected readonly time: PlaybackClock = clock,
    protected readonly resources: ResourceOwners = playbackResourceOwners,
    protected readonly options: PlaybackControllerOptions = {},
  ) {
    resources.cover('controller');
  }
  get snapshot(): PlaybackSnapshot {
    return {
      ...this.current,
      selection: this.current.selection
        ? {
            ...this.current.selection,
            ...(this.current.selection.liveBuffer
              ? { liveBuffer: { ...this.current.selection.liveBuffer } }
              : {}),
          }
        : null,
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
  get liveBuffer(): Readonly<LiveBufferTelemetry> | null {
    if (
      !this.engine ||
      this.engineGeneration !== this.generation ||
      this.abort?.signal.aborted ||
      !this.current.selection ||
      ['idle', 'failed', 'disposed'].includes(this.current.state)
    )
      return null;
    try {
      return normalizeLiveBufferTelemetry(this.engine.readLiveBuffer?.());
    } catch {
      return null;
    }
  }
  /** Selection/lifecycle revision for async footer work; never exposes an engine handle. */
  get liveBufferGeneration(): number {
    return this.generation;
  }
  /** Changing a live target never selects, pauses, seeks or restarts the player. */
  async setLiveBuffer(value: LiveBufferPreference): Promise<boolean> {
    const preference = normalizeLiveBufferPreference(value);
    const engine = this.engine;
    const generation = this.generation;
    const signal = this.abort?.signal;
    if (!preference || !engine || signal?.aborted || this.liveBuffer?.capability !== 'controlled')
      return false;
    try {
      const accepted = (await engine.setLiveBuffer?.(preference)) === true;
      if (
        !accepted ||
        this.engine !== engine ||
        this.generation !== generation ||
        signal?.aborted ||
        !this.current.selection
      )
        return false;
      this.current.selection = { ...this.current.selection, liveBuffer: { ...preference } };
      return true;
    } catch {
      return false;
    }
  }
  /** Preference lookup may finish late; cancellation never holds the decoder queue. */
  protected async liveBufferPreferenceForStart(
    selection: ChannelSelection,
    signal: AbortSignal,
  ): Promise<LiveBufferPreference> {
    const fallback = normalizeLiveBufferPreference(selection.liveBuffer) ?? {
      mode: 'auto' as const,
    };
    if (!this.options.liveBufferPreference) return fallback;
    const lookup = Promise.resolve().then(() =>
      this.options.liveBufferPreference!({ ...selection }),
    );
    return new Promise<LiveBufferPreference>((resolve) => {
      let finished = false;
      const release = this.resources.acquire('abortListeners');
      const finish = (value?: unknown): void => {
        if (finished) return;
        finished = true;
        signal.removeEventListener('abort', aborted);
        release();
        resolve(normalizeLiveBufferPreference(value) ?? fallback);
      };
      const aborted = (): void => finish();
      signal.addEventListener('abort', aborted, { once: true });
      void lookup.then(finish, () => finish());
      if (signal.aborted) finish();
    });
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
  protected observeVODRelease(reason: VODReleaseObservation['reason']): void {
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
          this.sourceSuppressed = true;
          this.sourceAttempt?.stop();
          this.sourceAttempt = null;
          const signals = createOwnedAbortSignals([abort!.signal, signal], this.resources);
          return engine
            .seek(seconds, signals.signal)
            .then(
              (shown) => shown && current(),
              () => false,
            )
            .finally(() => signals.dispose());
        }),
      setRate: (rate) =>
        guarded(undefined, () => {
          this.sourceSuppressed = true;
          this.sourceAttempt?.stop();
          this.sourceAttempt = null;
          engine.setRate(rate);
        }),
      setPaused: (paused) =>
        guarded(undefined, () => {
          this.sourceSuppressed = true;
          this.sourceAttempt?.stop();
          this.sourceAttempt = null;
          engine.setPaused(paused);
        }),
      leave: () =>
        guarded(undefined, () => {
          engine.leave();
          this.sourceSuppressed = false;
        }),
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
  protected publish(
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
  protected clearTimers(): void {
    if (this.deadline !== undefined) this.time.clearTimeout(this.deadline);
    if (this.retryTimer !== undefined) this.time.clearTimeout(this.retryTimer);
    this.clearSlice();
    this.releaseDeadlineOwner?.();
    this.releaseRetryOwner?.();
    this.releaseDeadlineOwner = this.releaseRetryOwner = undefined;
    this.deadline = this.retryTimer = undefined;
  }
  protected clearSlice(): void {
    if (this.sliceTimer !== undefined) this.time.clearTimeout(this.sliceTimer);
    this.sliceTimer = undefined;
    this.releaseSliceOwner?.();
    this.releaseSliceOwner = undefined;
  }
  protected enqueue(work: () => Promise<void>): Promise<void> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => {
      /* Caller sees error; later cleanup must still run. */
    });
    return result;
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
}
