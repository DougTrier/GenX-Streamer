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

import { checkScanCandidates } from '../../src/discovery/automatic-check';
import { createHealthObservation, type HealthObservation } from '../../src/discovery/health';
import type { ScanReview } from '../../src/discovery/scan';
import { afterEach, expect, it, vi } from 'vitest';
import { createScanPublisher } from '../../src/discovery/scan-publisher';
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}
afterEach(() => vi.useRealTimers());
it('acknowledges the first64 before collecting a256 window and joins one writer', async () => {
  const windows: number[][] = [];
  const hold = deferred();
  const p = createScanPublisher<number>({
    signal: new AbortController().signal,
    capacity: 256,
    initialBatchSize: 64,
    maxBatchSize: 256,
    sizeOf: () => 1024,
    publish: async (batch) => {
      windows.push([...batch]);
      if (windows.length === 2) await hold.promise;
    },
    failed: vi.fn(),
  });
  for (let index = 0; index < 320; index++) await p.push(index);
  expect(windows.map((batch) => batch.length)).toEqual([64, 256]);
  expect(p.snapshot()).toMatchObject({ active: 256, queued: 0, totalBytes: 256 * 1024 });
  let drained = false;
  const drain = p.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  hold.resolve();
  await drain;
  expect(windows.flat()).toEqual(Array.from({ length: 320 }, (_, index) => index));
});

it('byte pressure includes active entries and flushes smaller windows without loss', async () => {
  const hold = deferred();
  const windows: number[][] = [];
  const p = createScanPublisher<number>({
    signal: new AbortController().signal,
    capacity: 256,
    initialBatchSize: 2,
    maxBatchSize: 256,
    sizeOf: () => 4,
    maxBytes: 12,
    publish: async (batch) => {
      windows.push([...batch]);
      if (windows.length === 1) await hold.promise;
    },
    failed: vi.fn(),
  });
  await p.push(0);
  await p.push(1);
  await p.push(2);
  let admitted = false;
  const blocked = p.push(3).then(() => {
    admitted = true;
  });
  await Promise.resolve();
  expect(admitted).toBe(false);
  expect(p.snapshot()).toMatchObject({ active: 2, queued: 1, totalBytes: 12 });
  hold.resolve();
  await blocked;
  await p.drain();
  expect(windows.flat()).toEqual([0, 1, 2, 3]);
  expect(windows.every((batch) => batch.length * 4 <= 12)).toBe(true);
});

it('a queued sparse window becomes due after5s while the active writer remains held', async () => {
  vi.useFakeTimers();
  const hold = deferred();
  const windows: number[][] = [];
  const p = createScanPublisher<number>({
    signal: new AbortController().signal,
    capacity: 256,
    initialBatchSize: 1,
    maxBatchSize: 256,
    publish: async (batch) => {
      windows.push([...batch]);
      if (windows.length === 1) await hold.promise;
    },
    failed: vi.fn(),
  });
  await p.push(0);
  await p.push(1);
  await vi.advanceTimersByTimeAsync(5000);
  expect(windows).toEqual([[0]]);
  hold.resolve();
  for (let index = 0; index < 8; index++) await Promise.resolve();
  expect(windows).toEqual([[0], [1]]);
  await p.drain();
  expect(vi.getTimerCount()).toBe(0);
});
it('holds at most64 queued plus active entries, then releases admission only after actual sink settlement', async () => {
  const hold = deferred(),
    batches: number[][] = [],
    failed = vi.fn();
  const p = createScanPublisher<number>({
    signal: new AbortController().signal,
    publish: async (b) => {
      batches.push([...b]);
      if (batches.length === 1) await hold.promise;
    },
    failed,
  });
  for (let i = 0; i < 64; i++) await p.push(i);
  expect(p.snapshot()).toEqual({ queued: 0, active: 64, total: 64 });
  let admitted = false;
  const blocked = p.push(64).then(() => {
    admitted = true;
  });
  await Promise.resolve();
  expect(admitted).toBe(false);
  hold.resolve();
  await blocked;
  await p.drain();
  expect(batches.map((b) => b.length)).toEqual([64, 1]);
  expect(failed).not.toHaveBeenCalled();
  expect(p.snapshot().total).toBe(0);
});
it('flushes a partial batch after5s even with no subsequent observation and final drain joins it', async () => {
  vi.useFakeTimers();
  const publish = vi.fn(async () => undefined);
  const p = createScanPublisher({ signal: new AbortController().signal, publish, failed: vi.fn() });
  await p.push(1);
  await vi.advanceTimersByTimeAsync(4999);
  expect(publish).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(publish).toHaveBeenCalledWith([1]);
  await p.drain();
  expect(vi.getTimerCount()).toBe(0);
});
it('failed full queue rejects waiting admission and drain without deadlock or acknowledging entries', async () => {
  const hold = deferred(),
    error = new Error('catalog-revision-stale'),
    failed = vi.fn();
  const p = createScanPublisher<number>({
    signal: new AbortController().signal,
    publish: async () => {
      await hold.promise;
      throw error;
    },
    failed,
  });
  for (let i = 0; i < 64; i++) await p.push(i);
  const blocked = expect(p.push(64)).rejects.toBe(error);
  hold.resolve();
  await blocked;
  await expect(p.drain()).rejects.toBe(error);
  expect(failed).toHaveBeenCalledOnce();
  expect(p.snapshot().total).toBe(0);
});
it('cancel discards queued publication but joins late durable active receipt before drain completes', async () => {
  vi.useFakeTimers();
  const abort = new AbortController(),
    hold = deferred();
  let ack = 0;
  const p = createScanPublisher<number>({
    signal: abort.signal,
    publish: async (b) => {
      await hold.promise;
      ack += b.length;
    },
    failed: vi.fn(),
  });
  await p.push(1);
  await vi.advanceTimersByTimeAsync(5000);
  await p.push(2);
  abort.abort();
  let drained = false;
  const join = p.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  hold.resolve();
  await join;
  expect(ack).toBe(1);
  expect(p.snapshot().total).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it('13241 settled intermittent outcomes retain order and never exceed64 while using one writer', async () => {
  const batches: number[][] = [];
  let active = 0,
    high = 0;
  const p = createScanPublisher<number>({
    signal: new AbortController().signal,
    publish: async (b) => {
      active++;
      high = Math.max(high, active);
      await Promise.resolve();
      batches.push([...b]);
      active--;
    },
    failed: vi.fn(),
  });
  const expected: number[] = [];
  for (let i = 0; i < 13241; i++) {
    if (i % 7 === 0) continue;
    expected.push(i);
    await p.push(i);
    expect(p.snapshot().total).toBeLessThanOrEqual(64);
  }
  await p.drain();
  expect(batches.flat()).toEqual(expected);
  expect(high).toBe(1);
  expect(batches.every((b) => b.length <= 64)).toBe(true);
});
it('synchronous sink rejection is joined and reported exactly once', async () => {
  const error = new Error('unconfirmed'),
    failed = vi.fn();
  const p = createScanPublisher<number>({
    signal: new AbortController().signal,
    capacity: 1,
    publish: () => {
      throw error;
    },
    failed,
  });
  await p.push(1);
  await expect(p.drain()).rejects.toBe(error);
  expect(failed).toHaveBeenCalledOnce();
});

it('real13241 candidate check pipeline isolates intermittent malformed evidence with bounded joined publication', async () => {
  const abort = new AbortController(),
    published: string[] = [],
    retained = new Set<string>();
  const input: ScanReview = {
    sessionRevision: 'revision',
    query: '',
    status: 'completed',
    sources: [],
    counts: { inspected: 13241, matched: 13241, failedSources: 0, canceledSources: 0 },
    candidates: Array.from({ length: 13241 }, (_, i) => ({
      key: `c${i}`,
      sourceId: 's',
      sourceFingerprint: 'fingerprint',
      sessionRevision: 'revision',
      channel: {
        sourceId: 's',
        name: `Channel ${i}`,
        category: 'General',
        urls: [`https://fixture-${i % 32}.invalid/${i}`],
      },
    })),
  };
  const publisher = createScanPublisher<string>({
    signal: abort.signal,
    publish: async (batch) => {
      await Promise.resolve();
      published.push(...batch);
    },
    failed: () => abort.abort(),
  });
  const result = await checkScanCandidates(input, {
    signal: abort.signal,
    platform: 'browser',
    maxConcurrency: 16,
    now: () => 1000,
    probe: async (c) => {
      const observation = createHealthObservation(
        { channelId: c.key, sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
        { platform: 'browser', observedAt: 1000 },
        { kind: 'recognized-media-response' },
      );
      return Number(c.key.slice(1)) % 7 === 0
        ? ({ ...observation, evidence: { kind: 'decoded' } } as unknown as HealthObservation)
        : observation;
    },
    onObservation: async (c, o) => {
      retained.add(c.key);
      if (o.verdict === 'Reachable' || o.verdict === 'PlayedHere') await publisher.push(c.key);
      expect(publisher.snapshot().total).toBeLessThanOrEqual(64);
    },
  });
  await publisher.drain();
  expect(result.observations).toHaveLength(13241);
  expect(retained.size).toBe(13241);
  expect(new Set(published)).toEqual(new Set(result.eligibleKeys));
  expect(published).toHaveLength(13241 - Math.ceil(13241 / 7));
  expect(result.observations.filter((o) => o.verdict === 'NotChecked')).toHaveLength(
    Math.ceil(13241 / 7),
  );
});
