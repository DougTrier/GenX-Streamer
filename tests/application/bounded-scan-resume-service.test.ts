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
import {
  createBoundedScanResumeService,
  type BoundedResumeWorkerTransport,
} from '../../src/application/bounded-scan-resume-service';
import {
  attachBoundedScanResumeWorker,
  type BoundedResumeWorkerPort,
} from '../../src/application/bounded-scan-resume-worker';
import type { ResumeWire } from '../../src/application/bounded-scan-resume-protocol';
import {
  scanResumeCommitWindow,
  scanResumeTakeTiming,
} from '../../src/application/bounded-scan-resume';
import type {
  BoundedScanResumeHost,
  BoundedScanCandidateRow,
  BoundedScanResumePlan,
  BoundedScanCommit,
} from '../../src/application/bounded-scan-resume';
import { createHealthObservation } from '../../src/discovery/health';
class Bridge implements BoundedResumeWorkerTransport {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: ((event: MessageEvent) => void) | null = null;
  terminated = false;
  lastControl: ResumeWire | null = null;
  maximumRows = 0;
  private port: BoundedResumeWorkerPort;
  constructor(private schedule: (task: () => void) => void = queueMicrotask) {
    this.port = {
      onmessage: null,
      postMessage: (m) => {
        if (m.kind === 'call' && m.operation === 'commit')
          this.maximumRows = Math.max(
            this.maximumRows,
            (m.args[1] as { observations: unknown[] }).observations.length,
          );
        this.schedule(() => this.onmessage?.({ data: structuredClone(m) } as MessageEvent));
      },
    };
    attachBoundedScanResumeWorker(this.port);
  }
  postMessage(raw: unknown) {
    const m = structuredClone(raw) as ResumeWire;
    if (m.kind === 'control') this.lastControl = m;
    this.schedule(() => {
      if (this.terminated) return;
      try {
        this.port.onmessage?.({ data: m } as MessageEvent);
      } catch {
        this.onerror?.({} as ErrorEvent);
      }
    });
  }
  terminate() {
    this.terminated = true;
  }
  inject(raw: unknown) {
    this.onmessage?.({ data: raw } as MessageEvent);
  }
}
function backend(total: number, oneOrigin = false) {
  const counts = { total, checked: 0, responded: 0, published: 0 },
    revisions = { catalogRevision: '1', healthRevision: '0', checkpointRevision: '1' };
  const reservations = new Map<string, BoundedScanCandidateRow>(),
    done = new Set<number>();
  const header: BoundedScanResumePlan = {
    schemaVersion: 1,
    planId: 'plan',
    jobId: 'job',
    reviewDigest: 'a'.repeat(64),
    sessionRevision: 'session',
    query: 'News',
    createdAtMs: Date.now(),
    platform: 'native',
    observerProfile: 'native-v1',
    budgetMs: 20000,
    sourcePolicies: [{ sourceId: 'source', fingerprint: 'captured', allowHttp: false }],
    counts: { ...counts },
    revisions: { ...revisions },
  };
  const host: BoundedScanResumeHost = {
    admit: vi.fn(async () => header),
    take: vi.fn(async (_id, r) => {
      const rows: BoundedScanCandidateRow[] = [],
        blocked = new Set(r.blockedOrigins);
      for (let i = 0; i < total && rows.length < r.limit; i++) {
        const originToken = oneOrigin ? 'only' : `origin-${i % 16}`;
        if (done.has(i) || reservations.has(String(i)) || blocked.has(originToken)) continue;
        const row: BoundedScanCandidateRow = {
          candidateIndex: i,
          work: 'probe',
          originToken,
          reservationId: String(i),
          candidate: {
            key: `c-${i}`,
            sourceId: 'source',
            sourceFingerprint: 'captured',
            sessionRevision: 'session',
            channel: {
              sourceId: 'source',
              name: `Channel ${i}`,
              category: 'News',
              urls: [`https://fixture.invalid/${i}`],
            },
          },
        };
        rows.push(row);
        reservations.set(String(i), row);
        blocked.add(originToken);
      }
      return {
        schemaVersion: 1 as const,
        planId: 'plan',
        rows,
        exhausted: done.size + reservations.size === total,
      };
    }),
    probe: vi.fn(async (c, _s, _b, policy) => {
      expect(policy.allowHttp).toBe(false);
      return createHealthObservation(
        { channelId: c.key, sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
        { platform: 'native', observedAt: Date.now() },
        { kind: 'recognized-media-response' },
      );
    }),
    commit: vi.fn(async (_id: string, r: BoundedScanCommit) => {
      expect(r.expectedRevisions).toEqual(revisions);
      for (const o of r.observations) done.add(o.candidateIndex);
      counts.checked += r.observations.length;
      counts.responded += r.observations.length;
      counts.published += r.publicationIndices.length;
      revisions.catalogRevision = String(BigInt(revisions.catalogRevision) + 1n);
      revisions.healthRevision = String(BigInt(revisions.healthRevision) + 1n);
      revisions.checkpointRevision = String(BigInt(revisions.checkpointRevision) + 1n);
      return {
        committed: true as const,
        planId: 'plan',
        ...revisions,
        counts: { ...counts },
        acknowledgedIndices: r.observations.map((o) => o.candidateIndex),
        publicationIndices: [...r.publicationIndices],
      };
    }),
    defer: vi.fn(async () => undefined),
    release: vi.fn(async (_id, ids) => {
      for (const id of ids) reservations.delete(id);
    }),
    close: vi.fn(async () => {
      reservations.clear();
    }),
  };
  return { host, header };
}
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
it('joins held native close after a refused commit without replaying publication', async () => {
  const f = backend(16),
    held = gate(),
    bridge = new Bridge((task) => setTimeout(task, 0));
  f.host.commit = vi.fn(async () => {
    throw new Error('scan-checkpoint-storage-failed');
  });
  f.host.close = vi.fn(async () => held.promise);
  const service = createBoundedScanResumeService(f.host, { workerFactory: () => bridge });
  const run = service.start();
  const failed = expect(run).rejects.toThrow();
  await vi.waitFor(() => expect(f.host.close).toHaveBeenCalledTimes(1));
  let disposed = false;
  const disposal = service.dispose().then(() => (disposed = true));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(disposed).toBe(false);
  expect(bridge.terminated).toBe(false);
  held.resolve();
  await failed;
  await disposal;
  expect(service.snapshot()).toMatchObject({
    counts: { checked: 16, published: 0 },
    failure: 'commit-unconfirmed',
    activeCallbacks: 0,
    ownedReservations: 0,
    workerStopped: true,
  });
  expect(f.host.commit).toHaveBeenCalledTimes(1);
  expect(f.host.close).toHaveBeenCalledTimes(1);
});
it('retains the exact native close owner after failure and joins a later retry', async () => {
  const f = backend(16),
    held = gate(),
    bridge = new Bridge((task) => setTimeout(task, 0));
  let refuseClose = true;
  f.host.commit = vi.fn(async () => {
    throw new Error('scan-checkpoint-storage-failed');
  });
  f.host.close = vi.fn(async (id) => {
    expect(id).toBe('plan');
    if (refuseClose) throw new Error('native-close-unconfirmed');
    await held.promise;
  });
  const service = createBoundedScanResumeService(f.host, { workerFactory: () => bridge });
  await expect(service.start()).rejects.toThrow();
  await expect(service.dispose()).rejects.toThrow();
  expect(bridge.terminated).toBe(false);
  expect(service.snapshot().workerStopped).toBe(false);
  expect(service.snapshot().ownedReservations).toBeGreaterThan(0);
  const attempts = vi.mocked(f.host.close).mock.calls.length;
  refuseClose = false;
  let disposed = false;
  const retry = service.dispose().then(() => (disposed = true));
  await vi.waitFor(() => expect(f.host.close).toHaveBeenCalledTimes(attempts + 1));
  expect(disposed).toBe(false);
  held.resolve();
  await retry;
  expect(bridge.terminated).toBe(true);
  expect(service.snapshot().activeCallbacks).toBe(0);
  expect(f.host.commit).toHaveBeenCalledTimes(1);
  expect(f.host.admit).toHaveBeenCalledTimes(1);
});
it('a broken worker retains failed native cleanup until the same plan closes on retry', async () => {
  const f = backend(1),
    held = gate(),
    take = f.host.take,
    bridge = new Bridge();
  f.host.take = vi.fn(async (...args: Parameters<BoundedScanResumeHost['take']>) => {
    await held.promise;
    return take(...args);
  });
  f.host.close = vi.fn(async () => {
    throw new Error('close-unconfirmed');
  });
  const service = createBoundedScanResumeService(f.host, { workerFactory: () => bridge });
  await service.prepare();
  const running = service.start().catch(() => undefined);
  await vi.waitFor(() => expect(f.host.take).toHaveBeenCalledOnce());
  bridge.onmessageerror?.({} as MessageEvent);
  const refused = expect(service.dispose()).rejects.toThrow('close-unconfirmed');
  expect(f.host.close).not.toHaveBeenCalled();
  held.resolve();
  await Promise.all([running, refused]);
  expect(bridge.terminated).toBe(false);
  expect(service.snapshot().activeCallbacks).toBe(0);
  f.host.close = vi.fn(async (id) => {
    expect(id).toBe('plan');
  });
  await service.dispose();
  expect(f.host.close).toHaveBeenCalledOnce();
  expect(bridge.terminated).toBe(true);
  expect(f.host.commit).not.toHaveBeenCalled();
  expect(f.host.admit).toHaveBeenCalledOnce();
});
it('owned worker protocol streams256 and one-origin jobs cross64ACK without holdingoriginuntilpublication', async () => {
  for (const one of [false, true]) {
    const f = backend(256, one),
      bridge = new Bridge(),
      service = createBoundedScanResumeService(f.host, { workerFactory: () => bridge });
    const prepared = await service.prepare();
    expect(prepared.query).toBe('News');
    expect(f.host.take).not.toHaveBeenCalled();
    await service.start();
    expect(f.host.admit).toHaveBeenCalledTimes(1);
    expect(service.snapshot()).toMatchObject({
      phase: 'completed',
      counts: { published: 256 },
      ownedReservations: 0,
    });
    expect(bridge.maximumRows).toBe(64);
    expect(service.snapshot().maxActiveCallbacks).toBeLessThanOrEqual(19);
    await service.dispose();
    expect(bridge.terminated).toBe(true);
    expect(bridge.onmessage).toBeNull();
    expect(bridge.onerror).toBeNull();
    expect(bridge.onmessageerror).toBeNull();
  }
});
it('prestartlate admission isjoined and leaseclosed without take orprobe', async () => {
  const f = backend(1),
    held = gate(),
    admit = f.host.admit;
  f.host.admit = vi.fn(async (s) => {
    await held.promise;
    return admit(s);
  });
  const bridge = new Bridge(),
    service = createBoundedScanResumeService(f.host, { workerFactory: () => bridge });
  const preparing = service.prepare();
  const rejected = preparing.catch(() => undefined);
  await vi.waitFor(() => expect(f.host.admit).toHaveBeenCalledTimes(1));
  let finished = false;
  const disposing = service.dispose().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  held.resolve();
  await Promise.all([rejected, disposing]);
  expect(f.host.close).toHaveBeenCalledTimes(1);
  expect(f.host.take).not.toHaveBeenCalled();
  expect(f.host.probe).not.toHaveBeenCalled();
  expect(bridge.terminated).toBe(true);
});
it('unknowntransportfailure joinsheldcallback and close before terminating, never retries preparation', async () => {
  const f = backend(1),
    held = gate(),
    take = f.host.take;
  f.host.take = vi.fn(async (...args) => {
    await held.promise;
    return take(args[0], args[1], args[2]);
  });
  const bridge = new Bridge(),
    service = createBoundedScanResumeService(f.host, { workerFactory: () => bridge });
  await service.prepare();
  const running = service.start().catch(() => undefined);
  await vi.waitFor(() => expect(f.host.take).toHaveBeenCalledTimes(1));
  bridge.onmessageerror?.({} as MessageEvent);
  let disposed = false;
  const disposing = service.dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  expect(bridge.terminated).toBe(false);
  held.resolve();
  await Promise.all([running, disposing]);
  expect(f.host.close).toHaveBeenCalledTimes(1);
  expect(bridge.terminated).toBe(true);
  await expect(service.prepare()).rejects.toThrow();
  expect(f.host.admit).toHaveBeenCalledTimes(1);
});
it('malformed65item workercommit isrefused before hostdispatch and oldgeneration cannotoverwrite snapshot', async () => {
  const f = backend(1),
    held = gate();
  f.host.take = vi.fn(async () => {
    await held.promise;
    return { schemaVersion: 1 as const, planId: 'plan', rows: [], exhausted: true };
  });
  const bridge = new Bridge(),
    service = createBoundedScanResumeService(f.host, { workerFactory: () => bridge });
  await service.prepare();
  const running = service.start().catch(() => undefined);
  await vi.waitFor(() => expect(f.host.take).toHaveBeenCalledTimes(1));
  const g = bridge.lastControl!.generation;
  const before = service.snapshot();
  bridge.inject({
    kind: 'snapshot',
    generation: g - 1,
    sequence: 50,
    value: { ...before, phase: 'completed' },
  });
  expect(service.snapshot().phase).not.toBe('completed');
  bridge.inject({
    kind: 'call',
    generation: g,
    sequence: 4000,
    operation: 'commit',
    args: [
      'plan',
      {
        expectedRevisions: f.header.revisions,
        observations: Array.from({ length: 65 }, () => ({ candidateIndex: 0, observation: {} })),
        publicationIndices: [],
      },
    ],
  });
  expect(f.host.commit).not.toHaveBeenCalled();
  expect(service.diagnostics().lastFailure).toMatchObject({
    stage: 'call-validation',
    operation: 'commit',
    reason: 'commit-request',
  });
  held.resolve();
  await running;
  await service.dispose();
  expect(service.snapshot().quarantined).toBe(true);
  expect(service.diagnostics().lastFailure).toMatchObject({
    operation: 'commit',
    reason: 'commit-request',
  });
  expect(service.diagnostics().lastEvents.length).toBeLessThanOrEqual(2);
  expect(Object.isFrozen(service.diagnostics())).toBe(true);
  expect(Object.isFrozen(service.diagnostics().lastEvents)).toBe(true);
  expect(JSON.stringify(service.diagnostics())).not.toContain('expectedRevisions');
});
it('observerfailures stayobservable and cannot erase actual durableACK', async () => {
  const f = backend(64),
    service = createBoundedScanResumeService(f.host, { workerFactory: () => new Bridge() });
  service.subscribe(() => {
    throw new Error('observer');
  });
  await service.start();
  expect(service.snapshot()).toMatchObject({
    phase: 'completed',
    observerFailed: true,
    counts: { published: 64 },
  });
  expect(Object.isFrozen(service.snapshot().counts)).toBe(true);
  await service.dispose();
});

it('diagnostic observer failures cannot replace durable ACKs or retain source data', async () => {
  const f = backend(64),
    events: unknown[] = [];
  const service = createBoundedScanResumeService(f.host, {
    workerFactory: () => new Bridge(),
    onDiagnostic(event) {
      events.push(event);
      throw new Error('observer private payload');
    },
  });
  await service.start();
  expect(service.snapshot()).toMatchObject({ phase: 'completed', counts: { published: 64 } });
  await service.dispose();
  expect(events.length).toBeGreaterThan(0);
  expect(events.every(Object.isFrozen)).toBe(true);
  expect(service.diagnostics().failureCount).toBe(0);
  expect(service.diagnostics().lastFailure).toBeNull();
  expect(service.diagnostics().lastEvents.length).toBeLessThanOrEqual(2);
  expect(JSON.stringify(events)).not.toMatch(
    /https:|observer private|reservationId|candidateIndex/,
  );
});

it('rapid native refusals defer every row without stale blocked-origin admission or invented counts', async () => {
  const f = backend(64),
    bridge = new Bridge((task) => {
      setTimeout(task, 0);
    });
  f.host.probe = vi.fn(async () => {
    throw new Error('native-policy-refused');
  });
  const service = createBoundedScanResumeService(f.host, { workerFactory: () => bridge });
  await service.start();
  expect(service.snapshot()).toMatchObject({
    phase: 'paused',
    failure: 'probe-unconfirmed',
    counts: { checked: 0, published: 0 },
    ownedReservations: 0,
    activeCallbacks: 0,
  });
  expect(service.diagnostics().lastFailure?.reason).not.toBe('take-request');
  expect(f.host.probe).toHaveBeenCalledTimes(64);
  expect(f.host.commit).not.toHaveBeenCalled();
  await service.dispose();
  expect(bridge.terminated).toBe(true);
});

it('a held deferral retains its join while healthy original probes commit under task-delivered worker messages', async () => {
  const f = backend(65),
    held = gate(),
    probe = f.host.probe;
  f.host.probe = vi.fn(async (...args) => {
    if (args[0].key === 'c-0') throw new Error('native-policy-refused');
    return probe(args[0], args[1], args[2], args[3]);
  });
  f.host.defer = vi.fn(async () => {
    await held.promise;
  });
  const bridge = new Bridge((task) => {
    setTimeout(task, 0);
  });
  const service = createBoundedScanResumeService(f.host, { workerFactory: () => bridge });
  const running = service.start();
  await vi.waitFor(() => expect(f.host.defer).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(f.host.commit).toHaveBeenCalledTimes(1));
  expect(f.host.probe).toHaveBeenCalledTimes(65);
  expect(f.host.close).not.toHaveBeenCalled();
  held.resolve();
  await running;
  expect(service.snapshot()).toMatchObject({
    phase: 'paused',
    counts: { checked: 64, published: 64 },
    ownedReservations: 0,
    activeCallbacks: 0,
  });
  await service.dispose();
});
it('unknown blocked origins remain refused before host dispatch', async () => {
  const f = backend(1),
    bridge = new Bridge();
  const service = createBoundedScanResumeService(f.host, { workerFactory: () => bridge });
  await service.prepare();
  bridge.inject({
    kind: 'call',
    generation: bridge.lastControl!.generation,
    sequence: 7000,
    operation: 'take',
    args: ['plan', { limit: 1, blockedOrigins: ['never-admitted'] }],
  });
  await service.dispose();
  expect(f.host.take).not.toHaveBeenCalled();
  expect(service.diagnostics().lastFailure).toMatchObject({
    stage: 'call-validation',
    operation: 'take',
    reason: 'take-request',
  });
  expect(bridge.terminated).toBe(true);
});

it('worker generation retains and joins a negotiated cooling timer through Stop before transport termination', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  // Three on one site: two checks run at once (owner design), the third
  // waits on the negotiated cooling timer.
  const f = backend(3, true),
    bridge = new Bridge();
  f.host.admit = async () => ({
    ...f.header,
    commitWindow: scanResumeCommitWindow,
    takeTiming: scanResumeTakeTiming,
  });
  const take = f.host.take;
  let coolingUntil = 0;
  f.host.probe = vi.fn(async (c) => {
    coolingUntil = Date.now() + 60000;
    return createHealthObservation(
      { channelId: c.key, sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
      { platform: 'native', observedAt: Date.now() },
      { kind: 'recognized-media-response' },
    );
  });
  f.host.take = vi.fn(async (id, r, signal) =>
    coolingUntil > Date.now()
      ? {
          schemaVersion: 1 as const,
          planId: 'plan',
          rows: [],
          exhausted: false,
          coolingDelayMs: coolingUntil - Date.now(),
        }
      : take(id, r, signal),
  );
  const service = createBoundedScanResumeService(f.host, { workerFactory: () => bridge });
  try {
    await service.prepare();
    const work = service.start();
    await vi.advanceTimersByTimeAsync(1);
    // The first working channel is saved at once; the second waits for the window.
    expect(service.snapshot()).toMatchObject({ counts: { checked: 2, published: 1 } });
    const calls = vi.mocked(f.host.take).mock.calls.length;
    await vi.advanceTimersByTimeAsync(5000);
    expect(vi.mocked(f.host.take).mock.calls).toHaveLength(calls);
    await service.suspend();
    await work;
    expect(f.host.close).toHaveBeenCalledOnce();
    expect(service.snapshot()).toMatchObject({ activeCallbacks: 0, ownedReservations: 0 });
    await service.dispose();
    expect(bridge.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await service.dispose();
    vi.useRealTimers();
  }
});

for (const [message, closes] of [
  ['application-closing refusal', true],
  ['Native command cancellation could not be confirmed.', false],
] as const)
  it(`closing while a probe ${closes ? 'is refused by the closing native side still disposes' : 'cancellation is unacknowledged stays unconfirmed'}`, async () => {
    const f = backend(1);
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    f.host.probe = vi.fn(async () => {
      await held;
      throw new Error(message);
    });
    const service = createBoundedScanResumeService(f.host, { workerFactory: () => new Bridge() });
    const run = service.start().catch(() => undefined);
    await vi.waitFor(() => expect(f.host.probe).toHaveBeenCalled());
    const disposing = service.dispose();
    release();
    await run;
    if (closes) {
      await expect(disposing).resolves.toBeUndefined();
      expect(f.host.close).toHaveBeenCalled();
    } else await expect(disposing).rejects.toThrow();
  });
