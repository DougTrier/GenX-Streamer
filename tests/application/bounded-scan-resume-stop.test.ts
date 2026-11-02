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

import { expect, it, vi } from 'vitest';
import { createBoundedScanResumeOwner } from '../../src/application/discovery/bounded-scan-resume';
import {
  createBoundedScanResumeService,
  type BoundedResumeWorkerTransport,
} from '../../src/application/discovery/bounded-scan-resume-service';
import {
  attachBoundedScanResumeWorker,
  type BoundedResumeWorkerPort,
} from '../../src/application/discovery/bounded-scan-resume-worker';
import { invokeOwnedNative } from '../../src/platform/owned-native-command';
import { fixture, gate } from './bounded-scan-resume.fixture';

class Bridge implements BoundedResumeWorkerTransport {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  readonly suspended = gate();
  private port: BoundedResumeWorkerPort;
  constructor() {
    this.port = {
      onmessage: null,
      postMessage: (message) =>
        queueMicrotask(() => this.onmessage?.({ data: structuredClone(message) } as MessageEvent)),
    };
    attachBoundedScanResumeWorker(this.port);
  }
  postMessage(message: unknown) {
    queueMicrotask(() => {
      if (!this.terminated) {
        this.port.onmessage?.({ data: structuredClone(message) } as MessageEvent);
        const wire = message as { kind?: unknown; operation?: unknown };
        // Worker control execution is queued by onmessage. Resolve after that
        // execution has entered suspend, rather than relying on a timer delay.
        if (wire.kind === 'control' && wire.operation === 'suspend')
          queueMicrotask(() => this.suspended.resolve());
      }
    });
  }
  terminate() {
    this.terminated = true;
  }
}
const outcome = (work: Promise<unknown>) =>
  work.then(
    () => ({ ok: true as const }),
    () => ({ ok: false as const }),
  );
const abortError = () => new DOMException('Owned operation joined after Stop.', 'AbortError');

it('keeps Stop paused without a restart failure after Take and native cancellation both join', async () => {
  const f = fixture(1),
    entered = gate(),
    nativeJoined = gate(),
    cancelEntered = gate(),
    cancelJoined = gate();
  f.host.take = async (_id, _request, signal) =>
    invokeOwnedNative(
      {
        idFactory: () => 'owned-fixture',
        invoke: async (command) => {
          if (command === 'cancel_playlist') {
            cancelEntered.resolve();
            await cancelJoined.promise;
            return;
          }
          entered.resolve();
          await nativeJoined.promise;
          throw new Error('Native request settled.');
        },
      },
      'take_scan_resume_candidates',
      {},
      {
        signal,
        validate: () => {
          throw new Error('Rejected Take has no page.');
        },
      },
    );
  const service = createBoundedScanResumeService(f.host, { workerFactory: () => new Bridge() });
  const running = outcome(service.start());
  await entered.promise;
  let stopped = false;
  const stop = outcome(service.suspend()).then((result) => {
    stopped = true;
    return result;
  });
  try {
    await cancelEntered.promise;
    expect(stopped).toBe(false);
    nativeJoined.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(f.host.close).not.toHaveBeenCalled();
    cancelJoined.resolve();
    expect(await stop).toEqual({ ok: true });
    expect(await running).toEqual({ ok: true });
    expect(service.snapshot()).toMatchObject({
      phase: 'paused',
      failure: 'none',
      active: 0,
      ownedReservations: 0,
    });
    expect(f.host.close).toHaveBeenCalledTimes(1);
    expect(f.host.commit).not.toHaveBeenCalled();
  } finally {
    nativeJoined.resolve();
    cancelJoined.resolve();
    await running;
    await service.dispose();
  }
});

it.each(['typed-abort', 'closed-abort', 'closed-unknown'] as const)(
  'preserves the exact closed-admission cause through the worker on Stop: %s',
  async (kind) => {
    const f = fixture(1),
      entered = gate(),
      canceled = gate(),
      joined = gate();
    f.host.admit = async (signal) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            canceled.resolve();
            resolve();
          },
          { once: true },
        ),
      );
      await joined.promise;
      if (kind === 'typed-abort') throw abortError();
      throw Object.assign(new Error('Closed admission.'), {
        name: 'ScanAdmissionClosedError',
        cause: kind === 'closed-abort' ? abortError() : new Error('Genuine refusal.'),
      });
    };
    const service = createBoundedScanResumeService(f.host, { workerFactory: () => new Bridge() });
    const preparing = outcome(service.prepare());
    await entered.promise;
    const stop = outcome(service.suspend());
    try {
      await canceled.promise;
      joined.resolve();
      expect(await stop).toEqual({ ok: true });
      expect(await preparing).toEqual({ ok: false });
      expect(service.snapshot()).toMatchObject({
        phase: 'paused',
        failure: kind === 'closed-unknown' ? 'admission-failed' : 'none',
        active: 0,
        ownedReservations: 0,
      });
      expect(f.host.take).not.toHaveBeenCalled();
    } finally {
      joined.resolve();
      await preparing;
      await service.dispose();
    }
  },
);

it.each(['unknown', 'named-abort', 'closed-abort'] as const)(
  'keeps a settled Take refusal visible when Stop does not prove a typed cancellation: %s',
  async (kind) => {
    const f = fixture(1),
      entered = gate(),
      canceled = gate(),
      joined = gate();
    f.host.take = async (_id, _request, signal) => {
      entered.resolve();
      await new Promise<void>((resolve) =>
        signal.addEventListener(
          'abort',
          () => {
            canceled.resolve();
            resolve();
          },
          { once: true },
        ),
      );
      await joined.promise;
      if (kind === 'named-abort')
        throw Object.assign(new Error('An ordinary error named AbortError.'), {
          name: 'AbortError',
        });
      if (kind === 'closed-abort')
        throw Object.assign(new Error('Wrong operation.'), {
          name: 'ScanAdmissionClosedError',
          cause: abortError(),
        });
      throw new Error('Genuine callback failure.');
    };
    // Direct ownership also proves that the opener-only wrapper cannot hide a Take failure.
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    const running = outcome(owner.start());
    await entered.promise;
    const stop = outcome(owner.suspend());
    try {
      await canceled.promise;
      joined.resolve();
      await stop;
      await running;
      expect(owner.snapshot()).toMatchObject({
        phase: 'paused',
        failure: 'admission-failed',
        active: 0,
        ownedReservations: 0,
      });
      expect(f.host.close).toHaveBeenCalledTimes(1);
    } finally {
      joined.resolve();
      await running;
      await owner.dispose();
    }
  },
);

it('does not treat an unowned AbortError as Stop', async () => {
  const f = fixture(1);
  f.host.take = async () => {
    throw abortError();
  };
  const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
  expect(await outcome(owner.start())).toEqual({ ok: false });
  expect(owner.snapshot()).toMatchObject({ phase: 'failed', failure: 'admission-failed' });
  await owner.dispose();
});

it('retains a real close failure after a typed canceled Take', async () => {
  const f = fixture(1),
    entered = gate(),
    canceled = gate(),
    joined = gate();
  f.host.take = async (_id, _request, signal) => {
    entered.resolve();
    await new Promise<void>((resolve) =>
      signal.addEventListener(
        'abort',
        () => {
          canceled.resolve();
          resolve();
        },
        { once: true },
      ),
    );
    await joined.promise;
    throw abortError();
  };
  f.host.close = vi.fn(async () => {
    throw new Error('Close could not be confirmed.');
  });
  const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
  const running = outcome(owner.start());
  await entered.promise;
  const stop = outcome(owner.suspend());
  await canceled.promise;
  joined.resolve();
  expect(await stop).toEqual({ ok: false });
  expect(await running).toEqual({ ok: false });
  expect(owner.snapshot()).toMatchObject({ phase: 'failed', failure: 'cleanup-unconfirmed' });
  expect(await outcome(owner.dispose())).toEqual({ ok: false });
});

it.each(['ack', 'abort', 'unknown'] as const)(
  'joins a pending durable publication on Stop and preserves its receipt outcome: %s',
  async (kind) => {
    const f = fixture(1, true),
      commit = f.host.commit,
      entered = gate(),
      joined = gate();
    let commitSignal: AbortSignal | undefined;
    f.host.commit = async (id, request, signal) => {
      commitSignal = signal;
      entered.resolve();
      await joined.promise;
      if (kind === 'abort') throw abortError();
      if (kind === 'unknown') throw new Error('Receipt unavailable.');
      return commit(id, request, signal);
    };
    const bridge = new Bridge();
    const service = createBoundedScanResumeService(f.host, { workerFactory: () => bridge });
    const running = outcome(service.start());
    await entered.promise;
    let stopped = false;
    const stop = outcome(service.suspend()).then((result) => {
      stopped = true;
      return result;
    });
    try {
      await bridge.suspended.promise;
      expect(commitSignal?.aborted).toBe(false);
      expect(stopped).toBe(false);
      expect(f.host.close).not.toHaveBeenCalled();
      joined.resolve();
      await stop;
      expect(await running).toEqual({ ok: kind === 'ack' });
      expect(service.snapshot()).toMatchObject({
        phase: kind === 'ack' ? 'paused' : 'quarantined',
        failure: kind === 'ack' ? 'none' : 'commit-unconfirmed',
      });
      if (kind === 'ack')
        expect(service.snapshot()).toMatchObject({
          counts: { checked: 1, published: 1 },
          revisions: { catalogRevision: '2', checkpointRevision: '2' },
        });
    } finally {
      joined.resolve();
      await running;
      await outcome(service.dispose());
    }
  },
);
