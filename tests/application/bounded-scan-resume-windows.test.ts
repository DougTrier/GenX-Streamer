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
 * Bounded scan resume: negotiated publication windows, triage results and
 * cooling ownership.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createBoundedScanResumeOwner,
  fitScanResumeCommitPrefix,
  scanResumeTakeTiming,
  validateBoundedScanCandidatePage,
  validateBoundedScanResumePlan,
  type BoundedScanResumeHost,
} from '../../src/application/bounded-scan-resume';
import { type HealthObservation } from '../../src/discovery/health';
import {
  fixture,
  gate,
  observation,
  candidate,
  coolingFixture,
} from './bounded-scan-resume.fixture';

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
