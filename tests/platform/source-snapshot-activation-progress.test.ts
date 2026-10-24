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

import { afterEach, expect, it, vi } from 'vitest';
import {
  createSourceSnapshotActivationTransport,
  type SourceSnapshotActivationRequest,
} from '../../src/platform/source-snapshot-activation';
import { validateSourceSnapshotPreparationProgress } from '../../src/platform/source-snapshot-progress';
import { sourcePreparationStatus } from '../../src/ui/source-preparation-status';
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (v: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const request: SourceSnapshotActivationRequest = {
  schemaVersion: 1,
  sources: [{ sourceId: 's', sourceRevision: '1' }],
  query: '',
  preferredRegion: null,
  budgetMs: 20000,
  mode: 'refresh',
  expectedCatalogRevision: '1',
  expectedCheckpointRevision: '1',
};
const reply = {
  schemaVersion: 1,
  jobId: 'a'.repeat(64),
  reviewDigest: 'b'.repeat(64),
  candidateCount: 100,
  catalogRevision: '1',
  checkpointRevision: '2',
};
const progress = (prepared = 0, extra: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  requestId: 'request-1',
  rootGeneration: '7',
  preparedCandidates: prepared,
  totalCandidates: 100,
  phase: 'preparing',
  ...extra,
});
afterEach(() => vi.restoreAllMocks());
it('closed progress validates bounded counts/root generation without claiming checked or saved', () => {
  expect(validateSourceSnapshotPreparationProgress(progress(64)).preparedCandidates).toBe(64);
  expect(sourcePreparationStatus(validateSourceSnapshotPreparationProgress(progress(64)))).toBe(
    'Preparing channel checks · 64 of 100 prepared',
  );
  expect(
    sourcePreparationStatus(
      validateSourceSnapshotPreparationProgress(progress(100, { phase: 'sealing' })),
    ),
  ).toBe('Sealing channel checks · 100 of 100 prepared');
  expect(
    validateSourceSnapshotPreparationProgress(
      progress(0, { rootGeneration: '18446744073709551615' }),
    ).rootGeneration,
  ).toBe('18446744073709551615');
  for (const extra of [
    { preparedCandidates: -1 },
    { preparedCandidates: 101 },
    { totalCandidates: 100001 },
    { phase: 'sealing' },
    { rootGeneration: '07' },
    { rootGeneration: '18446744073709551616' },
    { unknown: true },
    { requestId: 'bad space' },
  ])
    expect(() => validateSourceSnapshotPreparationProgress(progress(0, extra))).toThrow();
  const getter = { ...progress() };
  Object.defineProperty(getter, 'phase', {
    get: () => {
      throw Error('getter');
    },
  });
  expect(() => validateSourceSnapshotPreparationProgress(getter)).toThrow();
});
it('registers before invoking and ignores other requests, generations, regressions and post-finish events', async () => {
  const producer = deferred<unknown>();
  let emit!: (v: unknown) => void;
  const order: string[] = [];
  const unlisten = vi.fn(async () => {
    order.push('unlisten');
  });
  const onProgress = vi.fn();
  const activate = createSourceSnapshotActivationTransport({
    idFactory: () => 'request-1',
    listenProgress: async (cb) => {
      order.push('listen');
      emit = cb;
      return unlisten;
    },
    invoke: async (command, args) => {
      order.push(command);
      expect(args?.requestId).toBe('request-1');
      return producer.promise;
    },
  });
  const work = activate(request, new AbortController().signal, onProgress);
  await vi.waitFor(() => expect(order).toHaveLength(2));
  expect(order.slice(0, 2)).toEqual(['listen', 'activate_source_snapshot_checks']);
  emit(progress(0, { requestId: 'other' }));
  emit(progress());
  emit(progress(64));
  emit(progress(63));
  emit(progress(65, { rootGeneration: '8' }));
  emit(progress(70, { totalCandidates: 99 }));
  emit(progress(100, { phase: 'sealing' }));
  emit(progress(100));
  expect(onProgress.mock.calls.map(([v]) => v.preparedCandidates)).toEqual([0, 64, 100]);
  producer.resolve(reply);
  expect(await work).toEqual(reply);
  expect(unlisten).toHaveBeenCalledOnce();
  emit(progress(100, { phase: 'sealing' }));
  expect(onProgress).toHaveBeenCalledTimes(3);
});
it('abort during listener registration joins registration and actual async unlisten, starts no producer', async () => {
  const registration = deferred<() => Promise<void>>(),
    cleanup = deferred<void>();
  const invoke = vi.fn();
  const controller = new AbortController();
  const activate = createSourceSnapshotActivationTransport({
    idFactory: () => 'request-1',
    invoke,
    listenProgress: () => registration.promise,
  });
  const work = activate(request, controller.signal, vi.fn());
  let finished = false;
  void work.then(
    () => {
      finished = true;
    },
    () => {
      finished = true;
    },
  );
  controller.abort();
  await Promise.resolve();
  expect(finished).toBe(false);
  registration.resolve(() => cleanup.promise);
  await Promise.resolve();
  await Promise.resolve();
  expect(finished).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
  cleanup.resolve();
  await expect(work).rejects.toMatchObject({ name: 'AbortError' });
});
it('late abort joins producer, cancellation and asynchronous unlisten while preserving actual durable reply', async () => {
  const producer = deferred<unknown>(),
    cancel = deferred<unknown>(),
    cleanup = deferred<void>();
  const controller = new AbortController();
  let emit!: (v: unknown) => void;
  const onProgress = vi.fn();
  const invoke = vi.fn((command: string) =>
    command === 'cancel_playlist' ? cancel.promise : producer.promise,
  );
  const activate = createSourceSnapshotActivationTransport({
    idFactory: () => 'request-1',
    invoke,
    listenProgress: async (cb) => {
      emit = cb;
      return () => cleanup.promise;
    },
  });
  const work = activate(request, controller.signal, onProgress);
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  controller.abort();
  emit(progress(64));
  expect(onProgress).not.toHaveBeenCalled();
  producer.resolve(reply);
  let done = false;
  void work.then(() => {
    done = true;
  });
  await Promise.resolve();
  expect(done).toBe(false);
  cancel.resolve(null);
  await Promise.resolve();
  await Promise.resolve();
  expect(done).toBe(false);
  cleanup.resolve();
  expect(await work).toEqual(reply);
  expect(invoke.mock.calls.map(([name]) => name)).toEqual([
    'activate_source_snapshot_checks',
    'cancel_playlist',
  ]);
});
it('failed registration/callback is observational and cannot turn healthy activation into a failed write', async () => {
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const invoke = vi.fn(async () => reply);
  const unavailable = createSourceSnapshotActivationTransport({
    idFactory: () => 'request-1',
    invoke,
    listenProgress: async () => {
      throw Error('fixture registration');
    },
  });
  expect(await unavailable(request, new AbortController().signal, vi.fn())).toEqual(reply);
  expect(warning).toHaveBeenCalledWith('Source preparation progress unavailable.');
  let emit!: (v: unknown) => void;
  const observed = createSourceSnapshotActivationTransport({
    idFactory: () => 'request-1',
    listenProgress: async (cb) => {
      emit = cb;
      return () => {};
    },
    invoke: async () => {
      emit(progress());
      return reply;
    },
  });
  expect(
    await observed(request, new AbortController().signal, () => {
      throw Error('fixture observer');
    }),
  ).toEqual(reply);
});
it('unlisten failure stays truthful/pending and retries exact callback without losing durable receipt', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let calls = 0,
    registrations = 0;
  const emitters: Array<(v: unknown) => void> = [];
  const unlisten = vi.fn(async () => {
    calls++;
    if (calls < 3) throw Error('fixture cleanup');
  });
  const cb = vi.fn();
  const activate = createSourceSnapshotActivationTransport({
    idFactory: () => 'request-1',
    invoke: async () => reply,
    listenProgress: async (emit) => {
      registrations++;
      emitters.push(emit);
      return unlisten;
    },
  });
  expect(await activate(request, new AbortController().signal, cb)).toEqual(reply);
  expect(activate.cleanupPending).toBe(true);
  emitters[0](progress());
  expect(cb).not.toHaveBeenCalled();
  expect(await activate(request, new AbortController().signal, cb)).toEqual(reply);
  expect(registrations).toBe(1);
  expect(activate.cleanupPending).toBe(true);
  expect(await activate(request, new AbortController().signal, cb)).toEqual(reply);
  expect(registrations).toBe(2);
  expect(activate.cleanupPending).toBe(false);
  expect(unlisten).toHaveBeenCalledTimes(4);
});
it('rejected producer still joins listener disposal and admits no later progress', async () => {
  let emit!: (v: unknown) => void;
  const cleanup = deferred<void>();
  let cleanupStarted = false;
  const cb = vi.fn();
  const activate = createSourceSnapshotActivationTransport({
    idFactory: () => 'request-1',
    listenProgress: async (v) => {
      emit = v;
      return () => {
        cleanupStarted = true;
        return cleanup.promise;
      };
    },
    invoke: async () => {
      throw Error('fixture failure');
    },
  });
  const work = activate(request, new AbortController().signal, cb);
  await vi.waitFor(() => expect(cleanupStarted).toBe(true));
  let done = false;
  void work.catch(() => {
    done = true;
  });
  emit(progress());
  expect(cb).not.toHaveBeenCalled();
  expect(done).toBe(false);
  cleanup.resolve();
  await expect(work).rejects.toThrow('Source checks could not be activated');
});

it('diagnostic sink failure cannot abort healthy source activation', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {
    throw Error('fixture diagnostic');
  });
  const activate = createSourceSnapshotActivationTransport({
    idFactory: () => 'request-1',
    invoke: async () => reply,
    listenProgress: async () => {
      throw Error('fixture registration');
    },
  });
  expect(await activate(request, new AbortController().signal, vi.fn())).toEqual(reply);
});
it('app-owned cleanup retries retained exact callback and rejects persistent unconfirmed cleanup', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  let fail = true;
  const unlisten = vi.fn(async () => {
    if (fail) throw Error('fixture cleanup');
  });
  const activate = createSourceSnapshotActivationTransport({
    idFactory: () => 'request-1',
    invoke: async () => reply,
    listenProgress: async () => unlisten,
  });
  expect(await activate(request, new AbortController().signal, vi.fn())).toEqual(reply);
  expect(activate.cleanupPending).toBe(true);
  await expect(activate.settleProgressCleanup()).rejects.toThrow('cleanup could not be confirmed');
  expect(activate.cleanupPending).toBe(true);
  fail = false;
  await activate.settleProgressCleanup();
  expect(activate.cleanupPending).toBe(false);
  expect(unlisten).toHaveBeenCalledTimes(3);
});
it('cleanup join waits late registration and actual unlisten, refuses new registration while closing', async () => {
  const registration = deferred<() => Promise<void>>(),
    cleanup = deferred<void>();
  const controller = new AbortController(),
    invoke = vi.fn();
  const listen = vi.fn(() => registration.promise);
  const activate = createSourceSnapshotActivationTransport({
    idFactory: () => 'request-1',
    invoke,
    listenProgress: listen,
  });
  const work = activate(request, controller.signal, vi.fn());
  expect(listen).toHaveBeenCalledOnce();
  controller.abort();
  const first = activate.settleProgressCleanup(),
    second = activate.settleProgressCleanup();
  expect(first).toBe(second);
  let joined = false;
  void first.then(() => {
    joined = true;
  });
  await expect(activate(request, new AbortController().signal, vi.fn())).rejects.toThrow(
    'active or closing',
  );
  registration.resolve(() => cleanup.promise);
  await Promise.resolve();
  await Promise.resolve();
  expect(joined).toBe(false);
  expect(invoke).not.toHaveBeenCalled();
  cleanup.resolve();
  await expect(work).rejects.toMatchObject({ name: 'AbortError' });
  await first;
  expect(joined).toBe(true);
  expect(activate.cleanupPending).toBe(false);
});
it('cleanup join waits actual producer and cancellation settlement before progress disposal', async () => {
  const producer = deferred<unknown>(),
    cancel = deferred<unknown>(),
    cleanup = deferred<void>();
  const controller = new AbortController();
  const invoke = vi.fn((name: string) =>
    name === 'cancel_playlist' ? cancel.promise : producer.promise,
  );
  const unlisten = vi.fn(() => cleanup.promise);
  const activate = createSourceSnapshotActivationTransport({
    idFactory: () => 'request-1',
    invoke,
    listenProgress: async () => unlisten,
  });
  const work = activate(request, controller.signal, vi.fn());
  await vi.waitFor(() => expect(invoke).toHaveBeenCalledOnce());
  controller.abort();
  const joined = activate.settleProgressCleanup();
  let finished = false;
  void joined.then(() => {
    finished = true;
  });
  producer.resolve(reply);
  await Promise.resolve();
  expect(finished).toBe(false);
  cancel.resolve(null);
  await vi.waitFor(() => expect(unlisten).toHaveBeenCalledOnce());
  expect(finished).toBe(false);
  cleanup.resolve();
  expect(await work).toEqual(reply);
  await joined;
  expect(finished).toBe(true);
});
// October 22, 2026: the Sansui's Slow pass was refused with "sqlite-busy"
// while its guide update held the database, but diagnostics only said
// "unclassified". The native code is now kept as the cause.
it('a native refusal keeps its code for diagnostics', async () => {
  const { scanFailureCode } = await import('../../src/ui/source-scan');
  const activate = createSourceSnapshotActivationTransport({
    idFactory: () => 'request-1',
    invoke: async () => {
      throw 'sqlite-busy';
    },
  });
  const failure = await activate(request, new AbortController().signal).catch((e: unknown) => e);
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toBe(
    'Source checks could not be activated. Saved channels are retained.',
  );
  expect((failure as Error).cause).toBe('sqlite-busy');
  expect(scanFailureCode(failure)).toBe('sqlite-busy');
});
