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

import { refreshDueIn, REFRESH_TIMER_MAX_MS, type RefreshCadence } from './refresh-cadence';
import { isNativeWriteNotCommittedError } from '../platform/native-write-refusal';
export const DAILY_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Host proof that the queued attempt was refused before admitting any persistence write. */
export class DailyRefreshAttemptNotStartedError extends Error {
  constructor() {
    super('Automatic refresh attempt was canceled before its settings write.');
    this.name = 'DailyRefreshAttemptNotStartedError';
  }
}

export interface DailyRefreshClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}
export interface DailyRefreshOptions {
  canRun(): boolean;
  lastAttemptAt(): number;
  cadence?(): RefreshCadence;
  persistAttempt(time: number, signal: AbortSignal): Promise<void>;
  run(signal: AbortSignal): Promise<void>;
  clock?: DailyRefreshClock;
  onError?(error: Error): void;
}

/** Foreground admission is supplied by the host; this owner never fetches sources itself. */
export function createDailyRefresh(options: DailyRefreshOptions): {
  wake(): Promise<void>;
  suspend(): Promise<void>;
  dispose(): Promise<void>;
} {
  const clock: DailyRefreshClock = options.clock ?? {
    now: Date.now,
    setTimer: (callback, delay) => setTimeout(callback, delay),
    clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let closed = false;
  let generation = 0;
  let timer: unknown = null;
  let pending: Promise<void> | null = null;
  let cleanupSafeFailure: ((error: unknown) => boolean) | null = null;
  let cancellation: AbortController | null = null;
  const clear = (): void => {
    if (timer !== null) clock.clearTimer(timer);
    timer = null;
  };
  const cadence = (): RefreshCadence => options.cadence?.() ?? 'daily';
  const admitted = (): boolean => cadence() !== 'off' && options.canRun();
  const dueIn = (): number => refreshDueIn(options.lastAttemptAt(), cadence(), clock.now());
  const schedule = (): void => {
    clear();
    if (closed || !admitted()) return;
    const delay = dueIn();
    // A failed persistence receipt must not cause a zero-delay retry loop.
    if (!Number.isFinite(delay) || delay <= 0) return;
    timer = clock.setTimer(
      () => {
        timer = null;
        void wake().catch(() =>
          options.onError?.(
            new Error('Daily source refresh could not finish. Retry from Sources.'),
          ),
        );
      },
      Math.min(REFRESH_TIMER_MAX_MS, delay),
    );
  };
  const suspend = async (): Promise<void> => {
    const active = pending;
    const safeFailure = cleanupSafeFailure;
    generation++;
    clear();
    cancellation?.abort();
    try {
      await active;
    } catch (error) {
      // The operational wake still rejects. Only a proven pre-write refusal is
      // cleanup-complete after joining; unknown writes and run failures remain failures.
      if (!safeFailure?.(error)) throw error;
    }
  };
  const wake = (): Promise<void> => {
    if (closed) return Promise.resolve();
    if (!admitted()) return suspend();
    if (pending) return cancellation?.signal.aborted ? pending.then(() => wake()) : pending;
    clear();
    if (dueIn() > 0) {
      schedule();
      return Promise.resolve();
    }
    const ownedGeneration = generation;
    const ownedCadence = cadence();
    const controller = new AbortController();
    cancellation = controller;
    let refusedBeforeWrite: Error | null = null;
    const task = Promise.resolve().then(async () => {
      if (closed || ownedGeneration !== generation || ownedCadence !== cadence() || !admitted())
        return;
      try {
        await options.persistAttempt(clock.now(), controller.signal);
      } catch (error) {
        if (
          (error instanceof DailyRefreshAttemptNotStartedError ||
            isNativeWriteNotCommittedError(error)) &&
          (controller.signal.aborted || ownedGeneration !== generation)
        )
          refusedBeforeWrite = error;
        throw error;
      }
      if (
        closed ||
        ownedGeneration !== generation ||
        controller.signal.aborted ||
        ownedCadence !== cadence() ||
        !admitted()
      )
        return;
      await options.run(controller.signal);
    });
    const settled = task.finally(() => {
      if (pending === settled) {
        pending = null;
        cleanupSafeFailure = null;
        cancellation = null;
        if (ownedGeneration === generation) schedule();
      }
    });
    pending = settled;
    cleanupSafeFailure = (error) => controller.signal.aborted && error === refusedBeforeWrite;
    return settled;
  };
  return {
    wake,
    suspend,
    dispose() {
      closed = true;
      return suspend();
    },
  };
}
