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

/**
 * Bounded scan resume: the native resume owner.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createBoundedScanResumeOwner,
  validateBoundedScanCandidatePage,
  validateBoundedScanResumePlan,
  type BoundedScanCandidateRow,
  type BoundedScanResumeHost,
} from '../../src/application/discovery/bounded-scan-resume';
import { createHealthObservation } from '../../src/discovery/health';
import { fixture, observation, candidate, gate } from './bounded-scan-resume.fixture';

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
