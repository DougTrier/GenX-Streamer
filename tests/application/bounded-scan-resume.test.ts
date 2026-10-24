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

import { describe, expect, it, vi } from 'vitest';
import {
  createBoundedScanResumeOwner,
  scanResumeCommitWindow,
  scanResumeTakeTiming,
  fitScanResumeCommitPrefix,
  validateBoundedScanResumePlan,
  validateBoundedScanCandidatePage,
  type BoundedScanResumeHost,
  type BoundedScanCandidateRow,
  type BoundedScanResumePlan,
  type BoundedScanCommit,
} from '../../src/application/bounded-scan-resume';
import { createHealthObservation, type HealthObservation } from '../../src/discovery/health';
import type { ReviewCandidate } from '../../src/discovery/scan';
const gate = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const candidate = (i: number): ReviewCandidate => ({
  key: `key-${i}`,
  sourceId: 'source',
  sourceFingerprint: 'captured',
  sessionRevision: 'original',
  channel: {
    sourceId: 'source',
    name: `Channel ${i}`,
    category: 'News',
    urls: [`https://origin-${i % 16}.fixture.invalid/${i}`],
  },
});
const observation = (
  c: ReviewCandidate,
  kind:
    | 'recognized-media-response'
    | 'timeout'
    | 'http'
    | 'slow'
    | 'host-down' = 'recognized-media-response',
): HealthObservation =>
  createHealthObservation(
    { channelId: c.key, sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
    { platform: 'native', observedAt: 1000 },
    kind === 'http' ? { kind, status: 429 } : { kind },
  );
function fixture(total: number, storedPositive = false, window = false) {
  const nativeCounts = {
    total,
    checked: storedPositive ? 1 : 0,
    responded: storedPositive ? 1 : 0,
    published: 0,
  };
  const revisions = { catalogRevision: '1', healthRevision: '0', checkpointRevision: '1' };
  const plan: BoundedScanResumePlan = {
    schemaVersion: 1,
    ...(window ? { commitWindow: scanResumeCommitWindow } : {}),
    planId: 'plan',
    jobId: 'job',
    reviewDigest: 'a'.repeat(64),
    sessionRevision: 'original',
    query: 'News',
    createdAtMs: 1000,
    platform: 'native',
    observerProfile: 'native-response-v1',
    budgetMs: 20000,
    sourcePolicies: [{ sourceId: 'source', fingerprint: 'captured', allowHttp: false }],
    counts: { ...nativeCounts },
    revisions: { ...revisions },
  };
  const deferred = new Set<number>();
  const settled = new Set<number>(),
    reserved = new Map<string, BoundedScanCandidateRow>();
  let peakReservations = 0;
  const requests: { limit: number; blockedOrigins: readonly string[] }[] = [],
    batches: BoundedScanCommit[] = [];
  const host: BoundedScanResumeHost = {
    admit: vi.fn(async () => ({
      ...plan,
      counts: { ...nativeCounts },
      revisions: { ...revisions },
    })),
    take: vi.fn(
      async (_id: string, request: { limit: number; blockedOrigins: readonly string[] }) => {
        requests.push(request);
        const rows: BoundedScanCandidateRow[] = [],
          blocked = new Set(request.blockedOrigins);
        for (let i = 0; i < total && rows.length < request.limit; i++) {
          const token = `origin-${i % 16}`,
            reservationId = `reservation-${i}`;
          if (
            settled.has(i) ||
            deferred.has(i) ||
            reserved.has(reservationId) ||
            blocked.has(token)
          )
            continue;
          const row: BoundedScanCandidateRow = {
            candidateIndex: i,
            candidate: candidate(i),
            originToken: token,
            reservationId,
            work: storedPositive && i === 0 ? 'publish' : 'probe',
            ...(storedPositive && i === 0 ? { observation: observation(candidate(0)) } : {}),
          };
          blocked.add(token);
          rows.push(row);
          reserved.set(reservationId, row);
        }
        peakReservations = Math.max(peakReservations, reserved.size);
        return {
          schemaVersion: 1 as const,
          planId: 'plan',
          rows,
          exhausted: settled.size + reserved.size + deferred.size === total,
        };
      },
    ),
    probe: vi.fn(async (c) => observation(c)),
    commit: vi.fn(async (_id: string, request: BoundedScanCommit) => {
      batches.push(request);
      expect(request.observations.length).toBeLessThanOrEqual(window ? 240 : 64);
      expect(request.expectedRevisions).toEqual(revisions);
      for (const x of request.observations) {
        const row = reserved.get(`reservation-${x.candidateIndex}`)!;
        expect(row).toBeTruthy();
        if (row.work === 'probe') {
          nativeCounts.checked++;
          if (['Reachable', 'PlayedHere'].includes(x.observation.verdict)) nativeCounts.responded++;
        }
        settled.add(x.candidateIndex);
      }
      nativeCounts.published += request.publicationIndices.length;
      revisions.checkpointRevision = String(BigInt(revisions.checkpointRevision) + 1n);
      revisions.healthRevision = String(BigInt(revisions.healthRevision) + 1n);
      if (request.publicationIndices.length)
        revisions.catalogRevision = String(BigInt(revisions.catalogRevision) + 1n);
      return {
        committed: true as const,
        planId: 'plan',
        ...revisions,
        counts: { ...nativeCounts },
        acknowledgedIndices: request.observations.map((x) => x.candidateIndex),
        publicationIndices: [...request.publicationIndices],
      };
    }),
    defer: vi.fn(async (_id, ids) => {
      for (const id of ids) {
        const row = reserved.get(id);
        if (!row) throw new Error('Unknown reservation');
        deferred.add(row.candidateIndex);
        reserved.delete(id);
      }
    }),
    release: vi.fn(async (_id, ids) => {
      for (const id of ids) reserved.delete(id);
    }),
    close: vi.fn(async () => {
      reserved.clear();
      deferred.clear();
    }),
  };
  return { host, plan, requests, batches, peak: () => peakReservations, reserved, nativeCounts };
}
describe('disabled bounded native resume owner', () => {
  it('streams13000 original candidates without a fullreview IPC or accumulating owner history', async () => {
    const f = fixture(13000),
      owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    await owner.start();
    expect(owner.snapshot()).toMatchObject({
      phase: 'completed',
      capabilityEnabled: false,
      counts: { total: 13000, checked: 13000, responded: 13000, published: 13000 },
      ownedReservations: 0,
      active: 0,
    });
    expect(owner.snapshot().maxOwnedReservations).toBeLessThanOrEqual(80);
    expect(f.peak()).toBeLessThanOrEqual(80);
    expect(f.requests.every((r) => r.limit <= 16 && r.blockedOrigins.length <= 16)).toBe(true);
    expect(
      f.batches.every((b) => b.observations.length <= 64 && b.publicationIndices.length <= 64),
    ).toBe(true);
    expect(Object.keys(owner.snapshot())).not.toContain('observations');
    expect(Object.isFrozen(owner.snapshot().counts)).toBe(true);
    expect(f.host.close).toHaveBeenCalledTimes(1);
    await owner.dispose();
  });
  it('onehostile reply among13000 never settles or blocks peers and coldRetry checks onlydeferred index', async () => {
    const f = fixture(13000);
    f.host.probe = vi.fn(async (c) =>
      c.key === 'key-0' ? { ...observation(c), fingerprint: 'hostile' } : observation(c),
    );
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    await owner.start();
    expect(owner.snapshot()).toMatchObject({
      phase: 'paused',
      failure: 'probe-unconfirmed',
      counts: { total: 13000, checked: 12999, responded: 12999, published: 12999 },
      ownedReservations: 0,
    });
    expect(f.host.probe).toHaveBeenCalledTimes(13000);
    expect(f.host.defer).toHaveBeenCalledExactlyOnceWith(
      'plan',
      ['reservation-0'],
      expect.any(AbortSignal),
    );
    expect(f.batches.flatMap((b) => b.observations).some((o) => o.candidateIndex === 0)).toBe(
      false,
    );
    expect(owner.snapshot().maxOwnedReservations).toBeLessThanOrEqual(80);
    await owner.dispose();
    f.host.probe = vi.fn(async (c) => observation(c));
    const cold = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    await cold.start();
    expect(f.host.probe).toHaveBeenCalledExactlyOnceWith(
      candidate(0),
      expect.any(AbortSignal),
      20000,
      { sourceId: 'source', fingerprint: 'captured', allowHttp: false },
    );
    expect(cold.snapshot()).toMatchObject({
      phase: 'completed',
      counts: { total: 13000, checked: 13000, responded: 13000, published: 13000 },
    });
  });
  it('independent Canceled evidence defers onlythatpeer while trustedTimedOut issettled', async () => {
    const f = fixture(3);
    f.host.probe = vi.fn(async (c) =>
      c.key === 'key-0'
        ? createHealthObservation(
            { channelId: c.key, sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
            { platform: 'native', observedAt: 1000 },
            { kind: 'canceled' },
          )
        : observation(c, c.key === 'key-1' ? 'timeout' : 'recognized-media-response'),
    );
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    await owner.start();
    expect(owner.snapshot()).toMatchObject({
      phase: 'paused',
      counts: { checked: 2, responded: 1, published: 1 },
    });
    expect(f.host.probe).toHaveBeenCalledTimes(3);
    expect(f.batches.flatMap((b) => b.observations).map((o) => o.candidateIndex)).toEqual([1, 2]);
    expect(
      f.batches.flatMap((b) => b.observations).find((o) => o.candidateIndex === 1)?.observation
        .verdict,
    ).toBe('TimedOut');
  });
  it('Stop joins a held episode-only deferral without inventing durableevidence', async () => {
    const f = fixture(2),
      held = gate(),
      defer = f.host.defer;
    let entered = false;
    f.host.probe = vi.fn(async (c) => ({ ...observation(c), fingerprint: 'wrong' }));
    f.host.defer = vi.fn(async (...args) => {
      entered = true;
      await held.promise;
      return defer(args[0], args[1], args[2]);
    });
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 }),
      run = owner.start();
    await vi.waitFor(() => expect(entered).toBe(true));
    let stopped = false;
    const stop = owner.suspend().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    held.resolve();
    await Promise.all([run, stop]);
    expect(f.host.commit).not.toHaveBeenCalled();
    expect(owner.snapshot().counts.checked).toBe(0);
    expect(f.host.close).toHaveBeenCalledTimes(1);
  });
  it('flushes64 trusted negatives and never publishes429 orTimedOut while healthy peers finish', async () => {
    const f = fixture(130);
    f.host.probe = vi.fn(async (c) =>
      observation(
        c,
        Number(c.key.slice(4)) < 64
          ? 'http'
          : Number(c.key.slice(4)) < 128
            ? 'timeout'
            : 'recognized-media-response',
      ),
    );
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    await owner.start();
    expect(owner.snapshot().counts).toEqual({
      total: 130,
      checked: 130,
      responded: 2,
      published: 2,
    });
    expect(
      f.batches.some((b) => b.observations.length === 64 && b.publicationIndices.length === 0),
    ).toBe(true);
  });
  it('publishes storedpositive without reprobe or incrementing settledcount', async () => {
    const f = fixture(3, true),
      owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    await owner.start();
    expect(f.host.probe).toHaveBeenCalledTimes(2);
    expect(owner.snapshot().counts).toEqual({ total: 3, checked: 3, responded: 3, published: 3 });
  });
  it('passes blocked origins to server-owned fair selection while a stalled origin joinsStop', async () => {
    // Two checks at once per site (owner design): origin-0 is reported full
    // only while both of its slots (key-0 and key-16) are held.
    const f = fixture(48),
      held = gate();
    let entered = 0,
      aborted = 0;
    f.host.probe = vi.fn(async (c, signal) => {
      if (c.key === 'key-0' || c.key === 'key-16') {
        entered++;
        signal.addEventListener(
          'abort',
          () => {
            aborted++;
          },
          { once: true },
        );
        await held.promise;
      }
      return observation(c);
    });
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 }),
      run = owner.start();
    await vi.waitFor(() => expect(entered).toBe(2));
    await vi.waitFor(() =>
      expect(f.host.probe).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'key-47' }),
        expect.any(AbortSignal),
        20000,
        { sourceId: 'source', fingerprint: 'captured', allowHttp: false },
      ),
    );
    expect(f.requests.some((r) => r.blockedOrigins.includes('origin-0'))).toBe(true);
    // Never a third origin-0 check while two are held.
    expect(vi.mocked(f.host.probe).mock.calls.some(([c]) => c.key === 'key-32')).toBe(false);
    let stopped = false;
    const stop = owner.suspend().then(() => {
      stopped = true;
    });
    await vi.waitFor(() => expect(aborted).toBe(2));
    expect(stopped).toBe(false);
    held.resolve();
    await Promise.all([run, stop]);
    expect(owner.snapshot().phase).toBe('paused');
    expect(f.host.close).toHaveBeenCalledTimes(1);
    expect(f.reserved.size).toBe(0);
  });
  it('quarantines a lost or malformed dispatchedACK without fakepromotion or another acquisition', async () => {
    for (const malformed of [false, true]) {
      const f = fixture(80),
        original = f.host.commit;
      f.host.commit = vi.fn(async (id, r, s) => {
        if (!malformed) throw new Error('transport-unknown');
        return { ...(await original(id, r, s)), acknowledgedIndices: [0, 0] };
      });
      const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
      await expect(owner.start()).rejects.toThrow();
      expect(owner.snapshot()).toMatchObject({
        phase: 'quarantined',
        failure: 'commit-unconfirmed',
        revisions: { checkpointRevision: '1' },
        counts: { published: 0 },
      });
      expect(f.host.commit).toHaveBeenCalledTimes(1);
      expect(f.host.close).toHaveBeenCalledTimes(1);
      await owner.dispose();
      expect(owner.snapshot()).toMatchObject({
        phase: 'quarantined',
        failure: 'commit-unconfirmed',
        ownedReservations: 0,
        counts: { published: 0 },
      });
      expect(f.host.commit).toHaveBeenCalledTimes(1);
      expect(f.host.close).toHaveBeenCalledTimes(1);
    }
  });
  it('late durableACK afterStop preservesactual counts and joins before dispose', async () => {
    const f = fixture(64),
      held = gate(),
      original = f.host.commit;
    let entered = false;
    f.host.commit = vi.fn(async (id, r, s) => {
      entered = true;
      await held.promise;
      return original(id, r, s);
    });
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 }),
      run = owner.start();
    await vi.waitFor(() => expect(entered).toBe(true));
    let disposed = false;
    const disposing = owner.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    held.resolve();
    await Promise.all([run, disposing]);
    expect(owner.snapshot()).toMatchObject({
      phase: 'disposed',
      counts: { published: 64 },
      ownedReservations: 0,
    });
  });
  for (const [name, settles] of [
    ['BoundedCallbackSettled', true],
    ['Error', false],
  ] as const)
    it(`a probe refused during Stop ${settles ? 'settles' : 'without an acknowledged cancellation keeps cleanup unconfirmed'}`, async () => {
      // On the TV, closing the app made the native side refuse the in-flight
      // probe ("application-closing") just before Stop aborted it. That refusal
      // had settled, so closing must finish; an unacknowledged cancellation must not.
      const f = fixture(1),
        held = gate();
      f.host.probe = vi.fn(async () => {
        await held.promise;
        throw Object.assign(new Error('Bounded scan callback failed.'), { name });
      });
      const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 }),
        run = owner.start().catch(() => undefined);
      await vi.waitFor(() => expect(f.host.probe).toHaveBeenCalled());
      const disposing = owner.dispose();
      held.resolve();
      await run;
      if (settles) {
        await expect(disposing).resolves.toBeUndefined();
        expect(f.host.close).toHaveBeenCalledOnce();
        expect(owner.snapshot().phase).toBe('disposed');
      } else {
        await expect(disposing).rejects.toThrow();
        expect(owner.snapshot().failure).toBe('cleanup-unconfirmed');
      }
    });
  it('closes the native owner even when releasing a durable committed batch fails', async () => {
    const f = fixture(1),
      owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    f.host.release = vi.fn(async () => {
      throw new Error('release-unconfirmed');
    });
    await expect(owner.start()).rejects.toThrow('release-unconfirmed');
    expect(f.host.close).toHaveBeenCalledExactlyOnceWith('plan');
    expect(owner.snapshot()).toMatchObject({
      failure: 'cleanup-unconfirmed',
      ownedReservations: 0,
      counts: { published: 1 },
    });
    await owner.dispose();
    expect(f.host.commit).toHaveBeenCalledOnce();
    expect(f.host.close).toHaveBeenCalledOnce();
  });
  it('late reservedpage after abort isreleased without a probe and cleanup isactually joined', async () => {
    const f = fixture(1),
      pageGate = gate(),
      releaseGate = gate(),
      take = f.host.take,
      release = f.host.release;
    let entered = false;
    f.host.take = vi.fn(async (...args: Parameters<BoundedScanResumeHost['take']>) => {
      entered = true;
      await pageGate.promise;
      return take(args[0], args[1], args[2]);
    });
    f.host.release = vi.fn(async (...args) => {
      await releaseGate.promise;
      return release(args[0], args[1], args[2]);
    });
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 }),
      run = owner.start();
    await vi.waitFor(() => expect(entered).toBe(true));
    let stopped = false;
    const stop = owner.suspend().then(() => {
      stopped = true;
    });
    pageGate.resolve();
    await vi.waitFor(() => expect(f.host.release).toHaveBeenCalledTimes(1));
    expect(stopped).toBe(false);
    expect(f.host.probe).not.toHaveBeenCalled();
    releaseGate.resolve();
    await Promise.all([run, stop]);
    expect(f.host.close).toHaveBeenCalledTimes(1);
  });
  it('whole-refuses oversized pages or wrong capturedsource identity before anyprobe', async () => {
    for (const attack of ['oversized', 'source', 'fingerprint'] as const) {
      const f = fixture(20),
        take = f.host.take;
      f.host.take = vi.fn(async (id, r, s) => {
        const page = await take(id, r, s);
        const rows = structuredClone(page.rows);
        if (attack === 'oversized')
          return { ...page, rows: Array.from({ length: 65 }, () => rows[0]) };
        if (attack === 'source') rows[0].candidate.sourceId = 'other';
        else rows[0].candidate.sourceFingerprint = 'other';
        return { ...page, rows };
      });
      const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
      await expect(owner.start()).rejects.toThrow();
      expect(f.host.probe).not.toHaveBeenCalled();
      expect(f.host.commit).not.toHaveBeenCalled();
      expect(f.host.close).toHaveBeenCalledTimes(1);
    }
  });
  it('supplies capturedfalse HTTPgrant explicitly without deriving permission from a URL', async () => {
    const f = fixture(1),
      take = f.host.take;
    f.host.take = vi.fn(async (id, r, s) => {
      const page = await take(id, r, s);
      return {
        ...page,
        rows: page.rows.map((row) => ({
          ...row,
          candidate: {
            ...row.candidate,
            channel: { ...row.candidate.channel, urls: ['http://fixture.invalid/live'] },
          },
        })),
      };
    });
    f.host.probe = vi.fn(async (c, _signal, _budget, policy) => {
      expect(policy).toEqual({ sourceId: 'source', fingerprint: 'captured', allowHttp: false });
      expect(Object.isFrozen(policy)).toBe(true);
      return createHealthObservation(
        { channelId: c.key, sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
        { platform: 'native', observedAt: 1000 },
        { kind: 'unsupported' },
      );
    });
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    await owner.start();
    expect(owner.snapshot().counts).toEqual({ total: 1, checked: 1, responded: 0, published: 0 });
    expect(f.batches[0].publicationIndices).toEqual([]);
  });
  it('held admission is joined onStop, with one request and no page/probe before actualsettlement', async () => {
    const f = fixture(1),
      held = gate();
    let entered = false;
    f.host.admit = vi.fn(async (signal) => {
      entered = true;
      await held.promise;
      signal.throwIfAborted();
      return f.plan;
    });
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    expect(f.host.admit).not.toHaveBeenCalled();
    const run = owner.start();
    await vi.waitFor(() => expect(entered).toBe(true));
    let stopped = false;
    const stop = owner.suspend().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(f.host.admit).toHaveBeenCalledTimes(1);
    expect(f.host.take).not.toHaveBeenCalled();
    expect(f.host.probe).not.toHaveBeenCalled();
    held.resolve();
    await Promise.all([run, stop]);
    expect(owner.snapshot().phase).toBe('paused');
  });
  it('rejects fullgraph/envelope attacks and isolates admitted caller mutations', () => {
    const f = fixture(1);
    expect(() =>
      validateBoundedScanResumePlan({ ...f.plan, review: { candidates: Array(1000).fill(null) } }),
    ).toThrow();
    const plan = validateBoundedScanResumePlan(f.plan);
    f.plan.sourcePolicies[0].fingerprint = 'changed';
    expect(plan.sourcePolicies[0].fingerprint).toBe('captured');
    const row: BoundedScanCandidateRow = {
      candidateIndex: 0,
      candidate: candidate(0),
      work: 'probe',
      originToken: 'origin',
      reservationId: 'reservation',
    };
    const raw = { schemaVersion: 1, planId: 'plan', rows: [row], exhausted: true };
    const page = validateBoundedScanCandidatePage(raw, plan, 1, []);
    row.candidate.channel.name = 'changed';
    expect(page.rows[0].candidate.channel.name).toBe('Channel 0');
    expect(() => validateBoundedScanCandidatePage(raw, plan, 1, ['origin'])).toThrow();
    expect(() =>
      validateBoundedScanCandidatePage({ ...raw, rows: [row, row] }, plan, 2, []),
    ).toThrow();
  });
});

describe('negotiated atomic publication windows', () => {
  it('retains a cooling Take after the first ACK and continues without reprobes or a polling loop', async () => {
    vi.useFakeTimers();
    const f = fixture(3, false, true),
      take = f.host.take;
    let cooled = false;
    let issued = false;
    f.host.take = vi.fn(async (id, request, signal) => {
      if (issued && !f.batches.length)
        return {
          schemaVersion: 1 as const,
          planId: 'plan',
          rows: [],
          exhausted: false,
          capacityBlocked: true as const,
        };
      if (f.batches.length && !cooled) {
        await new Promise<void>((resolve) => setTimeout(resolve, 350));
        cooled = true;
      }
      issued = true;
      return take(id, { ...request, limit: 1 }, signal);
    });
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    try {
      const running = owner.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(f.batches).toHaveLength(1);
      expect(f.host.take).toHaveBeenCalledTimes(3);
      expect(f.host.probe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(349);
      expect(f.host.take).toHaveBeenCalledTimes(3);
      expect(f.host.probe).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      await running;
      expect(owner.snapshot()).toMatchObject({
        phase: 'completed',
        counts: { checked: 3, published: 3 },
      });
      expect(new Set(vi.mocked(f.host.probe).mock.calls.map(([c]) => c.key)).size).toBe(3);
      expect(vi.getTimerCount()).toBe(0);
      await owner.dispose();
    } finally {
      vi.useRealTimers();
    }
  });
  it('Stop cancels cooling Take but waits for its original native cleanup to settle', async () => {
    const f = fixture(3, false, true),
      take = f.host.take,
      entered = gate(),
      joined = gate();
    let canceled = false;
    let issued = false;
    f.host.take = vi.fn(async (id, request, signal) => {
      if (issued && !f.batches.length)
        return {
          schemaVersion: 1 as const,
          planId: 'plan',
          rows: [],
          exhausted: false,
          capacityBlocked: true as const,
        };
      if (f.batches.length) {
        entered.resolve();
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              canceled = true;
              resolve();
            },
            { once: true },
          ),
        );
        await joined.promise;
        throw new DOMException('Native Take joined after cancellation.', 'AbortError');
      }
      issued = true;
      return take(id, { ...request, limit: 1 }, signal);
    });
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    const running = owner.start();
    await entered.promise;
    let stopped = false;
    const stop = owner.suspend().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(canceled).toBe(true);
    expect(stopped).toBe(false);
    expect(f.host.close).not.toHaveBeenCalled();
    joined.resolve();
    await stop;
    await running;
    expect(f.host.close).toHaveBeenCalledTimes(1);
    expect(owner.snapshot()).toMatchObject({
      phase: 'paused',
      active: 0,
      ownedReservations: 0,
      counts: { checked: 1, published: 1 },
    });
    await owner.dispose();
  });
  it('publishes the first positive promptly, then admits a 240-row window within 256 held rows', async () => {
    const f = fixture(600, false, true);
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    await owner.start();
    expect(f.batches[0].publicationIndices.length).toBeGreaterThan(0);
    expect(f.batches[0].observations.length).toBeLessThanOrEqual(16);
    expect(f.batches.some((b) => b.observations.length === 240)).toBe(true);
    expect(f.peak()).toBeLessThanOrEqual(256);
    expect(owner.snapshot()).toMatchObject({
      phase: 'completed',
      active: 0,
      ownedReservations: 0,
      counts: { checked: 600, published: 600 },
    });
    expect(
      new Set(f.batches.flatMap((b) => b.observations.map((o) => o.candidateIndex))).size,
    ).toBe(600);
    await owner.dispose();
  });
  it('starts negative-only publication at the single 10-second deadline while original probes remain held', async () => {
    vi.useFakeTimers();
    const f = fixture(16, false, true),
      held = gate();
    f.host.probe = vi.fn(async (c) => {
      if (c.key !== 'key-0') await held.promise;
      return observation(c, 'timeout');
    });
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    try {
      const running = owner.start();
      await vi.advanceTimersByTimeAsync(9999);
      expect(f.batches).toHaveLength(0);
      expect(owner.snapshot().active).toBe(15);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.batches).toHaveLength(1);
      expect(f.batches[0].observations.map((x) => x.candidateIndex)).toEqual([0]);
      const stopping = owner.suspend();
      let joined = false;
      void stopping.then(() => {
        joined = true;
      });
      await Promise.resolve();
      expect(joined).toBe(false);
      held.resolve();
      await stopping;
      await running;
      expect(owner.snapshot()).toMatchObject({ active: 0, ownedReservations: 0 });
      expect(vi.getTimerCount()).toBe(0);
      await owner.dispose();
    } finally {
      held.resolve();
      vi.useRealTimers();
    }
  });
  it('flushes confirmed pending records on native capacity pressure instead of retrying an empty page', async () => {
    const f = fixture(40, false, true),
      take = f.host.take;
    let pressured = false;
    f.host.probe = vi.fn(async (c) => observation(c, 'timeout'));
    f.host.take = vi.fn(async (...args: Parameters<BoundedScanResumeHost['take']>) => {
      if (!pressured && f.reserved.size >= 16) {
        pressured = true;
        return {
          schemaVersion: 1 as const,
          planId: 'plan',
          rows: [],
          exhausted: false,
          capacityBlocked: true as const,
        };
      }
      return take(...args);
    });
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    await owner.start();
    expect(pressured).toBe(true);
    expect(f.batches[0].observations.length).toBe(16);
    expect(owner.snapshot().counts.checked).toBe(40);
    expect(f.host.take).toHaveBeenCalledTimes(4);
    await owner.dispose();
  });
  it('rejects capacity pressure without negotiated authority and forbids nonempty/exhausted pressure replies', () => {
    const f = fixture(2),
      w = fixture(2, false, true);
    const page = {
      schemaVersion: 1,
      planId: 'plan',
      rows: [],
      exhausted: false,
      capacityBlocked: true as const,
    };
    expect(() => validateBoundedScanCandidatePage(page, f.plan, 16, [])).toThrow();
    expect(validateBoundedScanCandidatePage(page, w.plan, 16, []).capacityBlocked).toBe(true);
    expect(() =>
      validateBoundedScanCandidatePage({ ...page, exhausted: true }, w.plan, 16, []),
    ).toThrow();
  });
});

it('first positive starts durable publication while peers remain active and Saved waits for the actual ACK', async () => {
  const f = fixture(16, false, true),
    held = gate(),
    committing = gate(),
    dispatched = gate();
  f.host.probe = vi.fn(async (c) => {
    if (c.key !== 'key-0') await held.promise;
    return observation(c);
  });
  const commit = f.host.commit;
  f.host.commit = vi.fn(async (...args: Parameters<BoundedScanResumeHost['commit']>) => {
    dispatched.resolve();
    await committing.promise;
    return commit(...args);
  });
  const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
  const running = owner.start();
  await dispatched.promise;
  expect(owner.snapshot().counts.published).toBe(0);
  expect(owner.snapshot().active).toBe(15);
  const stopping = owner.suspend();
  let joined = false;
  void stopping.then(() => {
    joined = true;
  });
  committing.resolve();
  await Promise.resolve();
  expect(joined).toBe(false);
  held.resolve();
  await stopping;
  await running;
  expect(f.batches[0].publicationIndices).toEqual([0]);
  expect(owner.snapshot().counts.published).toBe(1);
  expect(owner.snapshot().ownedReservations).toBe(0);
  await owner.dispose();
});
it('fresh oversized capacity refusal fails once and actually closes the native lease', async () => {
  const f = fixture(2, false, true);
  f.host.take = vi.fn(async () => ({
    schemaVersion: 1 as const,
    planId: 'plan',
    rows: [],
    exhausted: false,
    capacityBlocked: true as const,
  }));
  const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
  await expect(owner.start()).rejects.toThrow('scan-resume-candidate-too-large');
  expect(f.host.take).toHaveBeenCalledTimes(1);
  expect(f.host.probe).not.toHaveBeenCalled();
  expect(f.host.close).toHaveBeenCalledTimes(1);
  await owner.dispose();
  expect(owner.snapshot().failure).toBe('admission-failed');
  expect(f.host.take).toHaveBeenCalledTimes(1);
  expect(f.host.close).toHaveBeenCalledTimes(1);
});

it('fits complete UTF8 records to the IPC budget and retains every unsent suffix without malformed-data fallback', () => {
  // Byte algorithm fixture, not a claim these synthetic large fields are admitted health identities.
  const records = Array.from({ length: 240 }, (_, id) => ({ id, value: '雪'.repeat(3000 + id) }));
  const received: typeof records = [];
  const remaining = records.slice();
  let pages = 0;
  while (remaining.length) {
    const build = (n: number) => ({
      schemaVersion: 2,
      planId: 'opaque',
      observations: remaining.slice(0, n),
    });
    const n = fitScanResumeCommitPrefix(remaining.length, build);
    expect(n).toBeGreaterThan(0);
    expect(new TextEncoder().encode(JSON.stringify(build(n))).length).toBeLessThanOrEqual(
      1048576 - 4096,
    );
    if (n < remaining.length)
      expect(new TextEncoder().encode(JSON.stringify(build(n + 1))).length).toBeGreaterThan(
        1048576 - 4096,
      );
    received.push(...remaining.splice(0, n));
    pages++;
  }
  expect(pages).toBeGreaterThan(1);
  expect(received).toEqual(records);
  expect(fitScanResumeCommitPrefix(1, () => ({ value: 'x'.repeat(1048576) }))).toBe(0);
  expect(() => fitScanResumeCommitPrefix(5, () => ({ value: NaN }))).toThrow();
});

it('commits only native-held echoes when one rejected probe precedes the first64 save', async () => {
  const f = fixture(65),
    held = new Map<number, HealthObservation>(),
    original = f.host.commit;
  f.host.probe = vi.fn(async (c) => {
    const index = Number(c.key.slice(4));
    if (index === 0) throw new Error('native-policy-refused');
    const echo = observation(c, index === 1 ? 'http' : 'recognized-media-response');
    held.set(index, structuredClone(echo));
    return echo;
  });
  f.host.commit = vi.fn(async (id, request, signal) => {
    for (const item of request.observations) {
      if (JSON.stringify(held.get(item.candidateIndex)) !== JSON.stringify(item.observation))
        throw new Error('scan-resume-commit-invalid');
    }
    return original(id, request, signal);
  });
  const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
  await owner.start();
  expect(owner.snapshot()).toMatchObject({
    phase: 'paused',
    failure: 'probe-unconfirmed',
    counts: { total: 65, checked: 64, responded: 63, published: 63 },
    ownedReservations: 0,
    active: 0,
  });
  expect(f.host.defer).toHaveBeenCalledExactlyOnceWith(
    'plan',
    ['reservation-0'],
    expect.any(AbortSignal),
  );
  expect(f.batches.flatMap((b) => b.observations).map((o) => o.candidateIndex)).not.toContain(0);
  expect(f.host.close).toHaveBeenCalledTimes(1);
  await owner.dispose();
});

it.each(['recognized-media-response', 'timeout'] as const)(
  'retains native %s echo after a delayed original reply without a competing JS deadline',
  async (kind) => {
    const f = fixture(2),
      held = gate(),
      nativeEcho = observation(candidate(0), kind);
    let now = 1000;
    f.host.probe = vi.fn(async (c) => {
      if (c.key === 'key-0') {
        await held.promise;
        return structuredClone(nativeEcho);
      }
      return observation(c);
    });
    const owner = createBoundedScanResumeOwner(f.host, { now: () => now });
    const running = owner.start();
    await vi.waitFor(() => expect(f.host.probe).toHaveBeenCalledTimes(2));
    expect(f.host.close).not.toHaveBeenCalled();
    now = 22001;
    held.resolve();
    await running;
    const committed = f.batches.flatMap((b) => b.observations).find((o) => o.candidateIndex === 0);
    expect(committed?.observation).toEqual(nativeEcho);
    expect(owner.snapshot()).toMatchObject({
      phase: 'completed',
      counts: { checked: 2, responded: kind === 'timeout' ? 1 : 2 },
    });
    expect(f.host.defer).not.toHaveBeenCalled();
    await owner.dispose();
  },
);
it('Stop retains the original late probe join and releases its reservation without a synthetic ACK', async () => {
  const f = fixture(1),
    held = gate();
  let canceled = false;
  f.host.probe = vi.fn(async (c, signal) => {
    signal.addEventListener(
      'abort',
      () => {
        canceled = true;
      },
      { once: true },
    );
    await held.promise;
    return observation(c);
  });
  const owner = createBoundedScanResumeOwner(f.host);
  const running = owner.start();
  await vi.waitFor(() => expect(f.host.probe).toHaveBeenCalledTimes(1));
  let stopped = false;
  const stopping = owner.suspend().then(() => {
    stopped = true;
  });
  await vi.waitFor(() => expect(canceled).toBe(true));
  expect(stopped).toBe(false);
  expect(f.host.close).not.toHaveBeenCalled();
  held.resolve();
  await Promise.all([running, stopping]);
  expect(f.host.commit).not.toHaveBeenCalled();
  expect(f.host.release).toHaveBeenCalledWith('plan', ['reservation-0'], expect.any(AbortSignal));
  expect(f.host.close).toHaveBeenCalledTimes(1);
  expect(owner.snapshot()).toMatchObject({
    phase: 'paused',
    ownedReservations: 0,
    active: 0,
    counts: { checked: 0, published: 0 },
  });
  await owner.dispose();
});

it('preserves an actual cancellation-join failure after Stop instead of admitting a negative', async () => {
  const f = fixture(1),
    held = gate();
  f.host.probe = vi.fn(async (_c, signal) => {
    await held.promise;
    expect(signal.aborted).toBe(true);
    throw new Error('cancellation-unconfirmed');
  });
  const owner = createBoundedScanResumeOwner(f.host),
    running = owner.start();
  const rejected = expect(running).rejects.toThrow('cancellation-unconfirmed');
  await vi.waitFor(() => expect(f.host.probe).toHaveBeenCalledTimes(1));
  const stopping = owner.suspend();
  const stopRejected = expect(stopping).rejects.toThrow('cancellation-unconfirmed');
  held.resolve();
  await Promise.all([rejected, stopRejected]);
  expect(f.host.commit).not.toHaveBeenCalled();
  expect(f.host.close).toHaveBeenCalledTimes(1);
  expect(owner.snapshot()).toMatchObject({
    failure: 'cleanup-unconfirmed',
    ownedReservations: 0,
    counts: { checked: 0 },
  });
  await expect(owner.dispose()).rejects.toThrow('cancellation-unconfirmed');
});

// Sixteen independently cooling origins exercise retained observations across real timer turns.
function coolingFixture(total: number, delay: number) {
  const f = fixture(total, false, true);
  f.host.admit = async () => ({
    ...f.plan,
    takeTiming: { schemaVersion: 1, maxCoolingDelayMs: 60000 },
  });
  const originalTake = f.host.take;
  const eligible = new Map<string, number>();
  f.host.probe = vi.fn(async (c) => {
    eligible.set(`origin-${Number(c.key.split('-')[1]) % 16}`, Date.now() + delay);
    return observation(c, 'timeout');
  });
  f.host.take = vi.fn(async (id, request, signal) => {
    const cooling = [...eligible].filter(([, at]) => at > Date.now());
    const page = await originalTake(
      id,
      {
        ...request,
        blockedOrigins: [
          ...new Set([...request.blockedOrigins, ...cooling.map(([origin]) => origin)]),
        ],
      },
      signal,
    );
    if (page.rows.length || page.exhausted) return page;
    if (f.reserved.size >= 256) return { ...page, capacityBlocked: true as const };
    // Every site busy (not cooling): an ordinary empty page.
    if (!cooling.length) return page;
    return { ...page, coolingDelayMs: Math.min(...cooling.map(([, at]) => at - Date.now())) };
  });
  return f;
}
// October 22, 2026: the page refused the native "slow" (3-second triage) and
// "host-down" results, so every one was set aside and both device scans
// stopped about 2,500 short, and the Slow list never filled. Both kinds must
// be recorded as checked like any other result.
describe('triage and host-down results', () => {
  it('records slow and host-down results as checked, never set aside', async () => {
    const f = fixture(40);
    f.host.probe = vi.fn(async (c) =>
      observation(c, Number(c.key.split('-')[1]) % 2 ? 'slow' : 'host-down'),
    );
    const owner = createBoundedScanResumeOwner(f.host, { now: () => 1000 });
    await owner.start();
    expect(owner.snapshot()).toMatchObject({
      phase: 'completed',
      failure: 'none',
      counts: { total: 40, checked: 40, responded: 0 },
    });
    expect(f.host.defer).not.toHaveBeenCalled();
    const kinds = f.batches.flatMap((b) => b.observations.map((o) => o.observation.evidence.kind));
    expect(kinds.filter((k) => k === 'slow')).toHaveLength(20);
    expect(kinds.filter((k) => k === 'host-down')).toHaveLength(20);
  });
});
describe('negotiated cooling ownership', () => {
  it('accumulates 240 fast negative observations across 16-origin cooldowns without tiny pressure ACKs', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const f = coolingFixture(600, 350),
      owner = createBoundedScanResumeOwner(f.host);
    try {
      const work = owner.start();
      await vi.advanceTimersByTimeAsync(20000);
      await work;
      expect(owner.snapshot()).toMatchObject({ phase: 'completed', counts: { checked: 600 } });
      expect(f.batches.map((b) => b.observations.length)).toEqual([240, 240, 120]);
      expect(f.peak()).toBeLessThanOrEqual(256);
      expect(
        new Set(f.batches.flatMap((b) => b.observations.map((o) => o.candidateIndex))).size,
      ).toBe(600);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await owner.dispose();
      vi.useRealTimers();
    }
  });
  it('publishes a partial window at 10s during 60s Retry-After and Stop joins and clears the owned wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const f = coolingFixture(100, 60000),
      owner = createBoundedScanResumeOwner(f.host);
    try {
      const work = owner.start();
      await vi.advanceTimersByTimeAsync(9999);
      expect(f.batches).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(1);
      expect(f.batches).toHaveLength(1);
      expect(f.batches[0].observations).toHaveLength(16);
      await owner.suspend();
      await work;
      expect(owner.snapshot()).toMatchObject({ phase: 'paused', active: 0, ownedReservations: 0 });
      expect(f.host.close).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      await owner.dispose();
      vi.useRealTimers();
    }
  });
});

it('accepts cooling only under explicit timing authority and rejects conflicting or malformed hints', () => {
  const f = fixture(1, false, true),
    plan = { ...f.plan, takeTiming: scanResumeTakeTiming };
  const page = {
    schemaVersion: 1,
    planId: 'plan',
    rows: [],
    exhausted: false,
    coolingDelayMs: 350,
  };
  expect(validateBoundedScanCandidatePage(page, plan, 16, []).coolingDelayMs).toBe(350);
  expect(() => validateBoundedScanCandidatePage(page, f.plan, 16, [])).toThrow();
  for (const coolingDelayMs of [0, -1, 1.5, 60001, Infinity, NaN, '350', null, undefined])
    expect(() =>
      validateBoundedScanCandidatePage({ ...page, coolingDelayMs }, plan, 16, []),
    ).toThrow();
  for (const extra of [
    { capacityBlocked: true },
    { exhausted: true },
    { rows: [{}] },
    { unexpected: true },
  ])
    expect(() => validateBoundedScanCandidatePage({ ...page, ...extra }, plan, 16, [])).toThrow();
  for (const takeTiming of [
    { schemaVersion: 2, maxCoolingDelayMs: 60000 },
    { schemaVersion: 1, maxCoolingDelayMs: 60001 },
    { schemaVersion: 1, maxCoolingDelayMs: 60000, extra: 1 },
  ])
    expect(() => validateBoundedScanResumePlan({ ...f.plan, takeTiming })).toThrow();
  const { commitWindow: _window, ...legacy } = f.plan;
  expect(() =>
    validateBoundedScanResumePlan({ ...legacy, takeTiming: scanResumeTakeTiming }),
  ).toThrow();
});

it('legacy window hosts keep their old pressure wire without accepting an unsolicited cooling hint', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const f = coolingFixture(64, 350);
  f.host.admit = async () => f.plan;
  const take = f.host.take;
  f.host.take = async (...args) => {
    for (;;) {
      const page = await take(...args);
      if (page.coolingDelayMs === undefined) return page;
      if (f.reserved.size) {
        const { coolingDelayMs: _delay, ...old } = page;
        return { ...old, capacityBlocked: true };
      }
      // Legacy native Take owns its timer when the cache has drained.
      await new Promise<void>((resolve) => setTimeout(resolve, page.coolingDelayMs));
    }
  };
  const owner = createBoundedScanResumeOwner(f.host);
  try {
    const work = owner.start();
    await vi.advanceTimersByTimeAsync(5000);
    await work;
    expect(f.batches[0].observations).toHaveLength(16);
    expect(f.batches.every((b) => b.observations.length <= 16)).toBe(true);
    expect(owner.snapshot().counts.checked).toBe(64);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await owner.dispose();
    vi.useRealTimers();
  }
});
