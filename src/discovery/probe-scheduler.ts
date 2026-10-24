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

export interface ProbeTimer {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}
export interface ProbeSchedulerOptions {
  now?: () => number;
  timer?: ProbeTimer;
  minIntervalMs?: number;
  maxCooldownMs?: number;
}
export interface ProbeScheduler {
  run<T>(
    origin: string,
    signal: AbortSignal,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  noteRetryAfter(origin: string, raw: string | null, status: number): number;
  clear(): void;
  dispose(): Promise<void>;
}
interface Job {
  controller: AbortController;
  execute(): Promise<void>;
  reject(reason: Error): void;
  cleanup(): void;
  done: Promise<void>;
}
class OriginCapacityError extends Error {}
interface OriginState {
  nextAt: number;
  queue: Job[];
  active: Job | null;
  timer: { handle: unknown } | null;
}
function originKey(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error('Probe origin is invalid.');
  }
  if (
    input.length > 16_384 ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error('Probe origin must be an HTTP or HTTPS destination without credentials.');
  return url.origin;
}
/** Scheduling only: callers supply probes and contextual health evidence; this owner launches no background work. */
export function createProbeScheduler(options: ProbeSchedulerOptions = {}): ProbeScheduler {
  const interval = options.minIntervalMs ?? 350;
  const cap = options.maxCooldownMs ?? 60_000;
  if (
    !Number.isInteger(interval) ||
    interval < 0 ||
    interval > 5000 ||
    !Number.isInteger(cap) ||
    cap < 1000 ||
    cap > 120_000
  )
    throw new Error('Probe pacing limits are invalid.');
  const now = () => {
    const value = (options.now ?? Date.now)();
    if (!Number.isSafeInteger(value) || value < 0 || value > Number.MAX_SAFE_INTEGER - 120_000)
      throw new Error('Probe clock is invalid.');
    return value;
  };
  const timer: ProbeTimer = options.timer ?? {
    set: (callback, delay) => setTimeout(callback, delay),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const origins = new Map<string, OriginState>();
  const admissions: { key: string; job: Job }[] = [];
  let admissionTimer: { handle: unknown } | null = null;
  let disposed = false,
    owned = 0;
  const cancelled = () => new Error('Probe canceled.');
  function stateFor(key: string): OriginState {
    let state = origins.get(key);
    if (!state) {
      if (origins.size >= 100) {
        const time = now();
        for (const [oldKey, old] of origins) {
          if (!old.active && !old.queue.length && !old.timer && old.nextAt <= time) {
            origins.delete(oldKey);
            break;
          }
        }
      }
      if (origins.size >= 100)
        throw new OriginCapacityError(
          'The probe scope exceeds 100 active or cooling origins. Wait for cleanup or cooldown.',
        );
      state = { nextAt: 0, queue: [], active: null, timer: null };
      origins.set(key, state);
    }
    return state;
  }
  function pumpAdmissions(): void {
    if (admissionTimer) {
      const handle = admissionTimer.handle;
      admissionTimer = null;
      timer.clear(handle);
    }
    if (disposed || !admissions.length) return;
    // Admission is synchronous: a newly allocated slot receives its job before
    // another waiter can evict it. No active or cooling state is discarded.
    for (let index = 0; index < admissions.length;) {
      const waiting = admissions[index];
      let state: OriginState;
      try {
        state = stateFor(waiting.key);
      } catch (error) {
        if (error instanceof OriginCapacityError) {
          index++;
          continue;
        }
        admissions.splice(index, 1);
        waiting.job.cleanup();
        waiting.job.reject(new Error('Probe pacing could not continue safely.'));
        continue;
      }
      admissions.splice(index, 1);
      state.queue.push(waiting.job);
      pump(state);
    }
    if (!admissions.length) return;
    const time = now();
    let earliest = Infinity;
    for (const state of origins.values())
      if (!state.active && !state.queue.length && !state.timer)
        earliest = Math.min(earliest, state.nextAt);
    // All-active saturation waits for real completion, not a polling loop.
    if (Number.isFinite(earliest))
      admissionTimer = {
        handle: timer.set(
          () => {
            admissionTimer = null;
            wakeAdmissions();
          },
          Math.max(1, earliest - time),
        ),
      };
  }
  function wakeAdmissions(): void {
    try {
      pumpAdmissions();
    } catch {
      for (const { job } of admissions.splice(0)) {
        job.controller.abort();
        job.cleanup();
        job.reject(new Error('Probe pacing could not continue safely.'));
      }
    }
  }
  function clearTimer(state: OriginState) {
    if (state.timer) {
      const handle = state.timer.handle;
      state.timer = null;
      timer.clear(handle);
    }
  }
  function failQueued(state: OriginState) {
    const queued = state.queue.splice(0);
    for (const job of queued) {
      job.controller.abort();
      job.cleanup();
      job.reject(new Error('Probe pacing could not continue safely.'));
    }
  }
  function pump(state: OriginState): void {
    if (disposed || state.active || !state.queue.length) return;
    try {
      clearTimer(state);
      const time = now();
      const delay = Math.max(0, state.nextAt - time);
      if (delay > 0) {
        state.timer = {
          handle: timer.set(() => {
            state.timer = null;
            pump(state);
          }, delay),
        };
        return;
      }
      const job = state.queue.shift()!;
      state.active = job;
      state.nextAt = time + interval;
      // Completion retains ownership even when the operation ignores abort.
      void job.execute().finally(() => {
        state.active = null;
        try {
          pump(state);
        } catch {
          failQueued(state);
        }
        wakeAdmissions();
      });
    } catch {
      failQueued(state);
    }
  }
  return {
    run<T>(
      origin: string,
      signal: AbortSignal,
      operation: (signal: AbortSignal) => Promise<T>,
    ): Promise<T> {
      if (disposed) return Promise.reject(new Error('Probe scheduler is closed.'));
      if (owned >= 1000) return Promise.reject(new Error('The probe queue exceeds 1,000 jobs.'));
      let state: OriginState | undefined;
      let key: string;
      try {
        key = originKey(origin);
        try {
          state = stateFor(key);
        } catch (error) {
          if (!(error instanceof OriginCapacityError)) throw error;
        }
      } catch (error) {
        return Promise.reject(error);
      }
      if (signal.aborted) return Promise.reject(cancelled());
      const controller = new AbortController();
      let resolve!: (value: T) => void, reject!: (reason: Error) => void, finish!: () => void;
      const result = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      const done = new Promise<void>((yes) => {
        finish = yes;
      });
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', abort);
        owned--;
        finish();
      };
      const job: Job = {
        controller,
        done,
        cleanup,
        reject,
        async execute() {
          try {
            if (controller.signal.aborted) throw cancelled();
            const value = await operation(controller.signal);
            if (controller.signal.aborted) throw cancelled();
            resolve(value);
          } catch (error) {
            reject(
              controller.signal.aborted
                ? cancelled()
                : error instanceof Error
                  ? error
                  : new Error('Probe failed.'),
            );
          } finally {
            cleanup();
          }
        },
      };
      const abort = () => {
        controller.abort();
        const waiting = admissions.findIndex((entry) => entry.job === job);
        if (waiting >= 0) {
          admissions.splice(waiting, 1);
          cleanup();
          reject(cancelled());
          wakeAdmissions();
          return;
        }
        // A capacity-waiting job may have been admitted to a state meanwhile.
        const assigned = state ?? origins.get(key);
        if (!assigned || assigned.active === job) return;
        const index = assigned.queue.indexOf(job);
        if (index >= 0) {
          assigned.queue.splice(index, 1);
          cleanup();
          reject(cancelled());
          try {
            clearTimer(assigned);
            pump(assigned);
          } catch {
            failQueued(assigned);
          }
          wakeAdmissions();
        }
      };
      owned++;
      if (state) state.queue.push(job);
      else admissions.push({ key, job });
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      else {
        if (state) pump(state);
        else if (admissions.length === 1) wakeAdmissions();
      }
      return result;
    },
    noteRetryAfter(origin, raw, status) {
      if (disposed) throw new Error('Probe scheduler is closed.');
      const key = originKey(origin);
      if (status !== 429 && status !== 503) return 0;
      const state = stateFor(key),
        time = now();
      let delay = 10_000;
      if (typeof raw === 'string' && raw.length <= 128) {
        const value = raw.trim();
        if (/^\d+$/u.test(value)) delay = Math.min(cap, Number(value) * 1000);
        else if (
          /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(
            value,
          )
        ) {
          const date = Date.parse(value);
          if (Number.isFinite(date) && new Date(date).toUTCString() === value)
            delay = Math.max(0, date - time);
        }
      }
      delay = Math.min(cap, Math.max(0, delay));
      state.nextAt = Math.max(state.nextAt, time + delay);
      try {
        clearTimer(state);
        pump(state);
      } catch {
        failQueued(state);
      }
      wakeAdmissions();
      return delay;
    },
    clear() {
      if (owned) throw new Error('Wait for probe cleanup before resetting origins.');
      origins.clear();
    },
    async dispose() {
      disposed = true;
      wakeAdmissions();
      for (const { job } of admissions.splice(0)) {
        job.controller.abort();
        job.cleanup();
        job.reject(cancelled());
      }
      const running: Promise<void>[] = [];
      for (const state of origins.values()) {
        try {
          clearTimer(state);
        } catch {
          /* Timer callbacks remain closed by the disposed gate. */
        }
        for (const job of state.queue.splice(0)) {
          job.controller.abort();
          job.cleanup();
          job.reject(cancelled());
        }
        if (state.active) {
          state.active.controller.abort();
          running.push(state.active.done);
        }
      }
      await Promise.all(running);
      origins.clear();
    },
  };
}
