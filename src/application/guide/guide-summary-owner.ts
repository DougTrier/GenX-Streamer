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

export interface GuideSummarySnapshot<R> {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error';
  summary: R | null;
}
export interface GuideSummaryClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}
const defaultClock: GuideSummaryClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
const failure = () => new Error('Program guide activity could not settle. Retry closing.');
function immutable<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
/** One foreground SQLite query owner; never starts stream or guide-source downloads. */
export function createGuideSummaryOwner<S, Q, R>(options: {
  fetch(query: Q, signal: AbortSignal): Promise<R>;
  cancel?(requestId: string): Promise<unknown>;
  isCurrent(scope: Readonly<S>): boolean;
  validateScope(scope: S): boolean;
  query(scope: Readonly<S>, atMs: number, requestId: string): Q;
  validateReply(reply: R, query: Q, scope: Readonly<S>): boolean;
  boundaries(reply: R): readonly (number | null | undefined)[];
  isUnavailable(error: unknown): boolean;
  available?(): boolean;
  clock?: GuideSummaryClock;
  requestId?(): string;
}) {
  const clock = options.clock ?? defaultClock;
  const listeners = new Set<(snapshot: GuideSummarySnapshot<R>) => void>();
  const unfinishedCancellation = new Set<string>();
  let selection: Readonly<S> | null = null;
  let foreground = true,
    disposed = false,
    revision = 0,
    completedRevision = -1;
  let catchUpUsed = false;
  let timer: unknown,
    active: AbortController | null = null;
  let pending: Promise<void> | null = null,
    disposal: Promise<void> | null = null;
  let snapshot: GuideSummarySnapshot<R> = Object.freeze({ status: 'idle', summary: null });
  const clearTimer = () => {
    if (timer !== undefined) clock.clearTimeout(timer);
    timer = undefined;
  };
  const emit = (status: GuideSummarySnapshot<R>['status'], summary: R | null = null) => {
    snapshot = Object.freeze({ status, summary });
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        /* A renderer cannot abandon query ownership. */
      }
    }
  };
  const current = (scope: Readonly<S>, version: number) =>
    !disposed &&
    foreground &&
    revision === version &&
    selection === scope &&
    options.isCurrent(scope);
  const retryCancellation = async () => {
    for (const requestId of unfinishedCancellation) {
      if (!options.cancel) throw failure();
      try {
        await options.cancel(requestId);
      } catch {
        throw failure();
      }
      unfinishedCancellation.delete(requestId);
    }
  };
  const pump = (): Promise<void> => {
    if (pending) return pending;
    const work = Promise.resolve().then(async () => {
      await retryCancellation();
      while (!disposed && foreground && selection && completedRevision !== revision) {
        const scope = selection,
          version = revision;
        if (!options.isCurrent(scope)) {
          completedRevision = version;
          emit('idle');
          break;
        }
        if (options.available && !options.available()) {
          completedRevision = version;
          emit('unavailable');
          break;
        }
        const atMs = clock.now();
        const requestId = options.requestId?.() ?? crypto.randomUUID();
        if (
          !Number.isSafeInteger(atMs) ||
          atMs < -62135596800000 ||
          atMs > 253402300799999 ||
          !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)
        )
          throw failure();
        const query = options.query(scope, atMs, requestId);
        const controller = new AbortController();
        active = controller;
        emit('loading');
        try {
          if (controller.signal.aborted || !current(scope, version)) continue;
          const value = await options.fetch(query, controller.signal);
          if (!controller.signal.aborted && current(scope, version)) {
            if (!options.validateReply(value, query, scope)) {
              completedRevision = version;
              emit('error');
            } else {
              const deliveredAt = clock.now();
              const crossedBoundary = options
                .boundaries(value)
                .some(
                  (boundary) =>
                    typeof boundary === 'number' && boundary > atMs && boundary <= deliveredAt,
                );
              if (deliveredAt < atMs || crossedBoundary) {
                if (catchUpUsed) {
                  completedRevision = version;
                  emit('error');
                } else {
                  // Retry within this ownership/revision, not a new external refresh.
                  catchUpUsed = true;
                }
                continue;
              }
              completedRevision = version;
              const summary = immutable(structuredClone(value));
              emit('ready', summary);
              if (current(scope, version)) {
                const now = clock.now();
                const boundaries = options
                  .boundaries(summary)
                  .filter((value): value is number => typeof value === 'number' && value > atMs);
                const delay = Math.max(
                  1,
                  Math.min(60000, ...boundaries.map((value) => value - now)),
                );
                timer = clock.setTimeout(() => {
                  timer = undefined;
                  if (current(scope, version)) void refresh().catch(() => undefined);
                }, delay);
              }
            }
          }
        } catch (error) {
          if (controller.signal.aborted) {
            if (!(error instanceof DOMException && error.name === 'AbortError')) {
              unfinishedCancellation.add(requestId);
              throw failure();
            }
          } else if (current(scope, version)) {
            completedRevision = version;
            emit(options.isUnavailable(error) ? 'unavailable' : 'error');
          }
        } finally {
          if (active === controller) active = null;
        }
      }
    });
    pending = work;
    void work.then(
      () => {
        if (pending === work) pending = null;
      },
      () => {
        if (pending === work) pending = null;
      },
    );
    return work;
  };
  const invalidate = () => {
    revision++;
    catchUpUsed = false;
    clearTimer();
    active?.abort();
  };
  const refresh = (): Promise<void> => {
    if (disposed) return Promise.reject(new Error('Program guide owner is closed.'));
    invalidate();
    if (selection && foreground) emit('loading');
    return pump();
  };
  const suspend = (): Promise<void> => {
    foreground = false;
    invalidate();
    emit('idle');
    return pump();
  };
  return {
    setScope(scope: S | null): Promise<void> {
      if (disposed) return Promise.reject(new Error('Program guide owner is closed.'));
      if (scope && !options.validateScope(scope))
        return Promise.reject(new Error('Selected guide identity was invalid.'));
      invalidate();
      selection = scope ? immutable(structuredClone(scope)) : null;
      emit(selection && foreground ? 'loading' : 'idle');
      return pump();
    },
    refresh,
    setForeground(active: boolean): Promise<void> {
      if (disposed) return pump();
      if (active === foreground) return pump();
      if (!active) return suspend();
      foreground = true;
      return refresh();
    },
    suspend,
    dispose(): Promise<void> {
      if (disposal) return disposal;
      if (!disposed) {
        disposed = true;
        foreground = false;
        selection = null;
        invalidate();
        emit('idle');
        listeners.clear();
      }
      const work = pump();
      disposal = work;
      void work.catch(() => {
        if (disposal === work) disposal = null;
      });
      return work;
    },
    subscribe(listener: (snapshot: GuideSummarySnapshot<R>) => void): () => void {
      if (disposed) return () => {};
      listeners.add(listener);
      listener(snapshot);
      return () => listeners.delete(listener);
    },
    get snapshot(): GuideSummarySnapshot<R> {
      return snapshot;
    },
  };
}
