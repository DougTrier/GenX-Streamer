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

import { nativeGuide } from '../../guide/native';
import { maintainGuideStorage, type GuideMaintenanceState } from '../../guide/maintenance';

/** Quiescent full-Guide maintenance; startup cache-only work never calls this host. */
export function createGuideMaintenance(host: {
  scanning(): boolean;
  playbackBusy(): boolean;
  canRun(): boolean;
  scopeCurrent(): boolean;
  changed(): void;
  failed(error: unknown): void;
}) {
  let closed = false;
  let epoch = 0;
  let wanted = false;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<GuideMaintenanceState | undefined> | null = null;
  let preparing: Promise<void> | null = null;
  let unconfirmed: { error: unknown } | null = null;
  let controller: AbortController | null = null;
  const busy = () => host.scanning() || host.playbackBusy();
  const canceled = (error: unknown) =>
    (error instanceof DOMException && error.name === 'AbortError') ||
    error === 'canceled' ||
    error === 'guide-cancelled' ||
    error === 'sqlite-maintenance-cancelled';
  const clearRetry = () => {
    if (retry !== undefined) clearTimeout(retry);
    retry = undefined;
  };
  const later = (delay = 250) => {
    clearRetry();
    if (!wanted || closed || !host.canRun()) return;
    retry = setTimeout(() => {
      retry = undefined;
      if (closed || !wanted) return;
      if (!host.canRun() || !host.scopeCurrent()) {
        wanted = false;
        return;
      }
      if (busy()) {
        later();
        return;
      }
      // Retry only deferred storage work, never the Guide feed pipeline.
      void maintain(new AbortController().signal).catch((error: unknown) => {
        wanted = false;
        clearRetry();
        try {
          host.failed(error);
        } catch {
          // Failure presentation cannot change the joined storage outcome.
        }
      });
    }, delay);
  };
  async function maintain(signal: AbortSignal): Promise<GuideMaintenanceState | undefined> {
    signal.throwIfAborted();
    if (unconfirmed) throw unconfirmed.error;
    if (closed) throw new DOMException('Guide maintenance is closed.', 'AbortError');
    clearRetry();
    if (active) {
      const cancel = () => {
        wanted = false;
        controller?.abort();
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        return await active;
      } finally {
        signal.removeEventListener('abort', cancel);
      }
    }
    if (!host.scopeCurrent()) throw new DOMException('Guide configuration changed.', 'AbortError');
    if (!host.canRun()) return 'deferred';
    if (busy()) {
      wanted = true;
      later();
      return 'deferred';
    }
    const owned = new AbortController();
    const ownedEpoch = epoch;
    controller = owned;
    let workloadCanceled = false;
    let nativeStarted = false;
    let monitor: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 250;
    wanted = false;
    const cancel = () => {
      wanted = false;
      owned.abort();
    };
    signal.addEventListener('abort', cancel, { once: true });
    const current = () => {
      owned.signal.throwIfAborted();
      if (!host.scopeCurrent())
        throw new DOMException('Guide configuration changed.', 'AbortError');
      if (!host.canRun()) return false;
      if (busy()) {
        wanted = true;
        return false;
      }
      return true;
    };
    const observe = () => {
      if (owned.signal.aborted) return;
      if (!host.canRun() || !host.scopeCurrent()) cancel();
      else if (busy()) {
        workloadCanceled = true;
        wanted = true;
        owned.abort();
      } else monitor = setTimeout(observe, 100);
    };
    monitor = setTimeout(observe, 100);
    const work = (async (): Promise<GuideMaintenanceState | undefined> => {
      try {
        const sources = await nativeGuide.sources();
        if (!current()) return 'deferred';
        if (!sources.length) return undefined;
        const coverage = await nativeGuide.coverage(sources[0].id);
        if (!current()) return 'deferred';
        // Older installed hosts have no projection/maintenance capability.
        if (typeof coverage.projectionCompatible !== 'boolean') return undefined;
        nativeStarted = true;
        const state = await maintainGuideStorage(owned.signal);
        // A real receipt can include committed retention even after cancellation.
        wanted = state === 'deferred' && !signal.aborted && ownedEpoch === epoch;
        retryDelay = workloadCanceled ? 250 : 60_000;
        if (state !== 'reopen-required') {
          try {
            host.changed();
          } catch {
            // A presentation observer cannot erase a durable maintenance receipt.
          }
        }
        return state;
      } catch (error) {
        if (owned.signal.aborted && canceled(error)) {
          if (workloadCanceled) return 'deferred';
          throw new DOMException('Guide maintenance canceled.', 'AbortError');
        }
        wanted = false;
        if (nativeStarted) unconfirmed = { error };
        throw error;
      }
    })();
    const settled = work.finally(() => {
      signal.removeEventListener('abort', cancel);
      if (monitor !== undefined) clearTimeout(monitor);
      if (active === settled) {
        active = null;
        controller = null;
        later(retryDelay);
      }
    });
    active = settled;
    return settled;
  }
  async function suspend(): Promise<void> {
    epoch++;
    wanted = false;
    clearRetry();
    controller?.abort();
    try {
      await active;
    } catch (error) {
      if (!canceled(error)) throw error;
    }
    if (unconfirmed) throw unconfirmed.error;
  }
  function preparePlayback(): Promise<void> {
    if (unconfirmed) return Promise.reject(unconfirmed.error);
    if (preparing) return preparing;
    const work = (async () => {
      const queued = wanted;
      const terminal = active?.then(
        (state) => ({ ok: true as const, state }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const stopped = suspend();
      const ownedEpoch = epoch;
      await stopped;
      const outcome = await terminal;
      const retryNeeded = outcome
        ? outcome.ok
          ? outcome.state === 'deferred'
          : canceled(outcome.error)
        : queued;
      if (!closed && ownedEpoch === epoch && retryNeeded && host.scopeCurrent()) {
        wanted = true;
        later();
      }
    })();
    const settled = work.finally(() => {
      if (preparing === settled) preparing = null;
    });
    preparing = settled;
    return settled;
  }
  return Object.assign(maintain, {
    suspend,
    preparePlayback,
    async wake(): Promise<void> {
      if (unconfirmed) throw unconfirmed.error;
      await preparing;
      if (!closed && wanted && host.canRun() && host.scopeCurrent()) {
        if (busy()) later();
        else await maintain(new AbortController().signal);
      }
    },
    async dispose() {
      closed = true;
      await suspend();
    },
  });
}
