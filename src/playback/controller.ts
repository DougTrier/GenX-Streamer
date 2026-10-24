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

import { startTiming } from './start-timing';
import { createOwnedAbortSignals } from '../platform/abort';
import {
  type PlaybackEngine,
  type RecoveryPlan,
  type PlaybackFailure,
  type ChannelSelection,
  type EngineEvent,
  validDecodedProgress,
  VOD_POSITION_LIMIT,
  type SeekOutcome,
  VOD_SEEK_MS,
} from './controller-model';
import { PlaybackControllerCore } from './controller-core';
// The controller's types and helpers are part of this module's interface too.
export * from './controller-model';

/** Owns every engine and recovery timer. Initializers may settle late, never publish late. */
export class PlaybackController extends PlaybackControllerCore {
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
