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

/** One joined publisher. Capacity includes queued and currently publishing entries. */
export function createScanPublisher<T>(options: {
  signal: AbortSignal;
  publish(batch: readonly T[]): Promise<void>;
  failed(error: unknown): void;
  capacity?: number;
  initialBatchSize?: number;
  maxBatchSize?: number;
  sizeOf?(value: T): number;
  maxBytes?: number;
  flushMs?: number;
}) {
  const capacity = options.capacity ?? 64;
  const flushMs = options.flushMs ?? 5000;
  const maxBatch = options.maxBatchSize ?? capacity;
  const initialBatch = options.initialBatchSize ?? maxBatch;
  const maxBytes = options.maxBytes ?? 20 * 1024 * 1024;
  if (
    !Number.isInteger(capacity) ||
    capacity < 1 ||
    capacity > 256 ||
    !Number.isInteger(maxBatch) ||
    maxBatch < 1 ||
    maxBatch > capacity ||
    !Number.isInteger(initialBatch) ||
    initialBatch < 1 ||
    initialBatch > maxBatch ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 20 * 1024 * 1024 ||
    !Number.isFinite(flushMs) ||
    flushMs < 1 ||
    flushMs > 5000
  )
    throw new Error('Scan publisher bounds are invalid.');
  const queued: { value: T; bytes: number }[] = [];
  const waiters = new Set<() => void>();
  let active = 0,
    activeBytes = 0,
    queuedBytes = 0,
    acknowledged = false,
    ending = false,
    stopped = false,
    hasFailure = false;
  let failure: unknown;
  let runner: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let due = false;
  const wake = () => {
    for (const resolve of waiters) resolve();
    waiters.clear();
  };
  const clear = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const abort = () => {
    stopped = true;
    queued.length = 0;
    queuedBytes = 0;
    clear();
    wake();
  };
  options.signal.addEventListener('abort', abort, { once: true });
  if (options.signal.aborted) abort();
  function pump() {
    if (stopped || hasFailure || !queued.length) return;
    // Sparse entries keep their original flush deadline even while the writer is held.
    if (!ending && !due && timer === undefined)
      timer = setTimeout(() => {
        timer = undefined;
        due = true;
        pump();
      }, flushMs);
    if (runner) return;
    const target = acknowledged ? maxBatch : initialBatch;
    if (!ending && !due && queued.length < target) {
      return;
    }
    clear();
    due = false;
    const entries = queued.splice(0, target);
    const batch = entries.map((entry) => entry.value);
    active = entries.length;
    activeBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    queuedBytes -= activeBytes;
    runner = Promise.resolve().then(async () => {
      try {
        await options.publish(batch);
        acknowledged = true;
      } catch (error) {
        hasFailure = true;
        failure = error;
        stopped = true;
        queued.length = 0;
        queuedBytes = 0;
        try {
          options.failed(error);
        } catch {
          /* Notification cannot replace owned failure. */
        }
      } finally {
        active = 0;
        activeBytes = 0;
        runner = null;
        wake();
        pump();
      }
    });
  }
  return {
    async push(value: T): Promise<void> {
      const bytes = options.sizeOf?.(value) ?? 0;
      if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > maxBytes)
        throw new Error('Scan publisher entry exceeds its byte bound.');
      while (
        (active + queued.length >= capacity || activeBytes + queuedBytes + bytes > maxBytes) &&
        !stopped &&
        !hasFailure &&
        !ending
      ) {
        // Capacity held by the active write must not make its next single entry
        // due. Only queued byte pressure requires a smaller whole window.
        if (queued.length && activeBytes + queuedBytes + bytes > maxBytes) {
          due = true;
          pump();
        }
        await new Promise<void>((resolve) => waiters.add(resolve));
      }
      if (hasFailure) throw failure;
      options.signal.throwIfAborted();
      if (stopped || ending) throw new Error('Scan publisher is closed.');
      queued.push({ value, bytes });
      queuedBytes += bytes;
      if (queued.length >= (acknowledged ? maxBatch : initialBatch)) due = true;
      pump();
    },
    async drain(): Promise<void> {
      ending = true;
      clear();
      due = true;
      pump();
      try {
        while (runner) await runner;
        if (hasFailure) throw failure;
      } finally {
        clear();
        options.signal.removeEventListener('abort', abort);
        wake();
      }
    },
    snapshot() {
      return Object.freeze({
        queued: queued.length,
        active,
        total: queued.length + active,
        ...(options.sizeOf
          ? { queuedBytes, activeBytes, totalBytes: queuedBytes + activeBytes }
          : {}),
      });
    },
  };
}
