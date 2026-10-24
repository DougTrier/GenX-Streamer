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
import { checkScanCandidates, checkOwnedScanCandidates } from '../../src/discovery/automatic-check';
import { createHealthObservation } from '../../src/discovery/health';
import { createProbeScheduler } from '../../src/discovery/probe-scheduler';
import type { ScanReview, ReviewCandidate } from '../../src/discovery/scan';
const candidate = (n: number): ReviewCandidate => ({
  key: `c${n}`,
  sourceId: 's',
  sourceFingerprint: 'fingerprint',
  sessionRevision: 'revision',
  channel: {
    sourceId: 's',
    name: `Channel ${n}`,
    category: 'General',
    urls: [`https://fixture-${n}.invalid/${n}`],
  },
});
const review = (count: number): ScanReview => ({
  sessionRevision: 'revision',
  query: '',
  status: 'completed',
  sources: [],
  candidates: Array.from({ length: count }, (_, i) => candidate(i)),
  counts: { inspected: count, matched: count, failedSources: 0, canceledSources: 0 },
});
const response = (
  c: ReviewCandidate,
  kind: 'recognized-media-response' | 'timeout' | 'not-checked' = 'recognized-media-response',
) =>
  createHealthObservation(
    { channelId: c.key, sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
    { platform: 'browser', observedAt: 1000 },
    { kind },
  );
const options = () => ({
  signal: new AbortController().signal,
  platform: 'browser',
  now: () => 1000,
});

it('checks every candidate beyond1000 with at most four response probes and preselects only freshly evidenced responses', async () => {
  let active = 0,
    max = 0;
  const probe = vi.fn(async (c: ReviewCandidate) => {
    active++;
    max = Math.max(max, active);
    await Promise.resolve();
    active--;
    return response(c);
  });
  const result = await checkScanCandidates(review(1001), { ...options(), probe });
  expect(probe).toHaveBeenCalledTimes(1001);
  expect(max).toBe(4);
  expect(result.observations).toHaveLength(1001);
  expect(result.eligibleKeys).toHaveLength(1001);
});

it('keeps exceptions/unknown checks unverified without deleting candidates or trusting a forged verdict', async () => {
  const input = review(4),
    progress = vi.fn();
  const result = await checkScanCandidates(input, {
    ...options(),
    progress,
    probe: async (c) => {
      if (c.key === 'c0') throw new Error('https://secret.invalid/token');
      if (c.key === 'c1') return { ...response(c, 'not-checked'), verdict: 'PlayedHere' };
      if (c.key === 'c2')
        return createHealthObservation(
          { channelId: c.key, sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
          { platform: 'browser', observedAt: 1000 },
          { kind: 'http', status: 200 },
        );
      return response(c);
    },
  });
  expect(result.eligibleKeys).toEqual(['c3']);
  expect(result.observations.map((x) => x.verdict)).toEqual([
    'TemporaryUnavailable',
    'NotChecked',
    'NotChecked',
    'Reachable',
  ]);
  expect(input.candidates).toHaveLength(4);
  expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ done: 4, total: 4, responded: 1 });
  expect(JSON.stringify(result)).not.toContain('secret');
});

it('deadline retains one occupied slot until actual settlement and rejects its late success', async () => {
  const callbacks: (() => void)[] = [],
    finishes: (() => void)[] = [],
    signals: AbortSignal[] = [];
  const clear = vi.fn();
  const probe = vi.fn(async (c: ReviewCandidate, signal: AbortSignal) => {
    signals.push(signal);
    if (c.key !== 'c4') await new Promise<void>((resolve) => finishes.push(resolve));
    return response(c);
  });
  const pending = checkScanCandidates(review(5), {
    ...options(),
    probe,
    timer: {
      set(callback) {
        callbacks.push(callback);
        return callback;
      },
      clear,
    },
  });
  expect(probe).toHaveBeenCalledTimes(4);
  callbacks[0]!();
  expect(signals[0]!.aborted).toBe(true);
  await Promise.resolve();
  expect(probe).toHaveBeenCalledTimes(4);
  finishes[0]!();
  for (let n = 0; n < 6; n++) await Promise.resolve();
  expect(probe).toHaveBeenCalledTimes(5);
  finishes.slice(1).forEach((f) => f());
  const result = await pending;
  expect(result.observations[0]?.verdict).toBe('TimedOut');
  expect(result.eligibleKeys).toEqual(['c1', 'c2', 'c3', 'c4']);
  expect(clear).toHaveBeenCalledTimes(5);
});
it.each([4, 16])(
  'Cancel joins all %i noncooperative operations, removes deadlines and suppresses late progress/admission',
  async (maxConcurrency) => {
    const abort = new AbortController(),
      progress = vi.fn(),
      finishes: (() => void)[] = [],
      timers = new Set<unknown>();
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const probe = vi.fn(async (c: ReviewCandidate) => {
      await new Promise<void>((resolve) => finishes.push(resolve));
      return response(c);
    });
    const pending = checkScanCandidates(review(maxConcurrency + 2), {
      maxConcurrency,
      ...options(),
      signal: abort.signal,
      probe,
      progress,
      timer: {
        set(callback) {
          timers.add(callback);
          return callback;
        },
        clear(handle) {
          timers.delete(handle);
        },
      },
    });
    let settled = false;
    void pending.catch(() => {
      settled = true;
    });
    abort.abort();
    finishes[0]!();
    for (let n = 0; n < 6; n++) await Promise.resolve();
    expect(settled).toBe(false);
    expect(probe).toHaveBeenCalledTimes(maxConcurrency);
    finishes.slice(1).forEach((f) => f());
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(progress).toHaveBeenCalledTimes(1);
    expect(timers.size).toBe(0);
    expect(remove).toHaveBeenCalledTimes(1);
  },
);
it('out-of-order completion reports accurate completed counts while final results follow input order', async () => {
  const finishes: Map<string, () => void> = new Map(),
    events: { done: number; responded: number; key?: string }[] = [];
  const pending = checkScanCandidates(review(4), {
    ...options(),
    progress: (p) =>
      events.push({ done: p.done, responded: p.responded, key: p.observation?.channelId }),
    probe: async (c) => {
      await new Promise<void>((r) => finishes.set(c.key, r));
      return response(c, c.key === 'c1' ? 'timeout' : 'recognized-media-response');
    },
  });
  for (const key of ['c3', 'c1', 'c2', 'c0']) {
    finishes.get(key)!();
    for (let n = 0; n < 5; n++) await Promise.resolve();
  }
  const result = await pending;
  expect(result.observations.map((o) => o.channelId)).toEqual(['c0', 'c1', 'c2', 'c3']);
  expect(result.eligibleKeys).toEqual(['c0', 'c2', 'c3']);
  expect(events.map((e) => e.done)).toEqual([0, 1, 2, 3, 4]);
  expect(events.map((e) => e.responded)).toEqual([0, 1, 1, 2, 3]);
});
it.each(['source', 'platform', 'timestamp', 'extra-evidence'])(
  'refuses unsafe %s evidence for one channel and finishes its healthy peers',
  async (kind) => {
    const result = await checkScanCandidates(review(3), {
      ...options(),
      maxConcurrency: 1,
      probe: async (c) => {
        const r = response(c);
        if (c.key !== 'c1') return r;
        if (kind === 'source') r.sourceId = 'other';
        if (kind === 'platform') r.platform = 'android';
        if (kind === 'timestamp') r.observedAt = 999;
        if (kind === 'extra-evidence')
          Reflect.set(r.evidence, 'url', 'https://secret.invalid/token');
        return r;
      },
    });
    expect(result.eligibleKeys).toEqual(['c0', 'c2']);
    expect(result.observations.map((o) => o.verdict)).toEqual([
      'Reachable',
      'NotChecked',
      'Reachable',
    ]);
    expect(result.observations[1]).toMatchObject({
      channelId: 'c1',
      sourceId: 's',
      platform: 'browser',
      evidence: { kind: 'not-checked' },
    });
    expect(JSON.stringify(result)).not.toContain('secret');
    expect(JSON.stringify(result)).not.toContain('other');
  },
);
it('skips invalid destinations without fetching them or stopping valid channels', async () => {
  const input = review(5);
  input.candidates[0]!.channel.urls = [];
  input.candidates[1]!.channel.urls = ['https://user:secret@private.invalid/token'];
  input.candidates[2]!.channel.urls = ['javascript:alert(1)'];
  const probe = vi.fn(async (c: ReviewCandidate) => response(c));
  const result = await checkScanCandidates(input, { ...options(), probe });
  expect(probe.mock.calls.map((call) => call[0].key)).toEqual(['c3', 'c4']);
  expect(result.eligibleKeys).toEqual(['c3', 'c4']);
  expect(result.observations.map((o) => o.verdict)).toEqual([
    'UnsupportedHere',
    'UnsupportedHere',
    'UnsupportedHere',
    'Reachable',
    'Reachable',
  ]);
  expect(JSON.stringify(result)).not.toContain('secret');
});

it('refuses >100k and repeated candidates before any probe', async () => {
  const probe = vi.fn(async (c: ReviewCandidate) => response(c));
  const input = review(1);
  input.candidates.length = 100001;
  await expect(checkScanCandidates(input, { ...options(), probe })).rejects.toThrow('100,000');
  expect(probe).not.toHaveBeenCalled();
  const duplicate = review(2);
  duplicate.candidates[1] = candidate(0);
  await expect(checkScanCandidates(duplicate, { ...options(), probe })).rejects.toThrow(
    'ownership',
  );
  expect(probe).not.toHaveBeenCalled();
});

it('retains the captured snapshot while checking and propagates uncertain cancellation cleanup', async () => {
  const input = review(2);
  let finish!: () => void;
  const checked: string[] = [];
  const pending = checkScanCandidates(input, {
    ...options(),
    probe: async (c) => {
      checked.push(c.channel.name);
      if (c.key === 'c0')
        await new Promise<void>((resolve) => {
          finish = resolve;
        });
      return response(c);
    },
  });
  input.candidates[1]!.channel.name = 'Changed after scan';
  finish();
  await pending;
  expect(checked).toEqual(['Channel 0', 'Channel 1']);
  const cancel = new AbortController();
  let fail!: (error: Error) => void;
  const uncertain = checkScanCandidates(review(1), {
    ...options(),
    signal: cancel.signal,
    probe: () =>
      new Promise((_, reject) => {
        fail = reject;
      }),
  });
  cancel.abort();
  fail(new Error('native cleanup failed secret'));
  await expect(uncertain).rejects.toThrow('cancellation could not be confirmed');
});

it('sixteen response slots retain provider RetryAfter pacing without truncating queued candidates', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  const scheduler = createProbeScheduler(),
    starts: string[] = [],
    cancel = new AbortController();
  try {
    const input = review(16);
    for (const item of input.candidates) item.channel.urls = ['https://fixture.invalid/live'];
    const pending = checkScanCandidates(input, {
      ...options(),
      maxConcurrency: 16,
      signal: cancel.signal,
      now: Date.now,
      probe: (c, signal) =>
        scheduler.run(c.channel.urls[0]!, signal, async () => {
          starts.push(c.key);
          if (c.key === 'c0') scheduler.noteRetryAfter(c.channel.urls[0]!, '2', 429);
          return createHealthObservation(
            { channelId: c.key, sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
            { platform: 'browser', observedAt: Date.now() },
            c.key === 'c0' ? { kind: 'http', status: 429 } : { kind: 'recognized-media-response' },
          );
        }),
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(starts).toEqual(['c0']);
    await vi.advanceTimersByTimeAsync(1);
    expect(starts).toEqual(['c0', 'c1']);
    await vi.advanceTimersByTimeAsync(4900);
    const result = await pending;
    expect(starts).toEqual(Array.from({ length: 16 }, (_, index) => `c${index}`));
    expect(result.eligibleKeys).toEqual(Array.from({ length: 15 }, (_, index) => `c${index + 1}`));
    expect(result.observations).toHaveLength(16);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    cancel.abort();
    await scheduler.dispose();
    vi.useRealTimers();
  }
});

it('explicit sixteen slots reach the bounded peak and retain deterministic results after reverse completion', async () => {
  let active = 0,
    peak = 0;
  const finishes = new Map<string, () => void>();
  const pending = checkScanCandidates(review(16), {
    ...options(),
    maxConcurrency: 16,
    probe: async (c) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise<void>((resolve) => finishes.set(c.key, resolve));
      active--;
      return response(c);
    },
  });
  expect(active).toBe(16);
  for (let index = 15; index >= 0; index--) {
    finishes.get(`c${index}`)!();
    for (let tick = 0; tick < 5; tick++) await Promise.resolve();
  }
  const result = await pending;
  expect(peak).toBe(16);
  expect(active).toBe(0);
  expect(result.eligibleKeys).toEqual(Array.from({ length: 16 }, (_, index) => `c${index}`));
  expect(result.observations.map((item) => item.channelId)).toEqual(result.eligibleKeys);
});
it.each([0, 17, 24, 1.5, Infinity, NaN])(
  'refuses invalid concurrency %s before admission',
  async (maxConcurrency) => {
    const probe = vi.fn(async (c: ReviewCandidate) => response(c));
    await expect(
      checkScanCandidates(review(1), { ...options(), maxConcurrency, probe }),
    ).rejects.toThrow('concurrency');
    expect(probe).not.toHaveBeenCalled();
  },
);

it('awaits owned observation publication before next admission and isolates callback mutations', async () => {
  let release!: () => void;
  const publishing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probe = vi.fn(async (c: ReviewCandidate) => response(c));
  const progress = vi.fn();
  const pending = checkScanCandidates(review(2), {
    ...options(),
    maxConcurrency: 1,
    probe,
    progress,
    onObservation: async (c, observation) => {
      if (c.key === 'c0') {
        c.key = 'mutated';
        observation.verdict = 'NotChecked';
        await publishing;
      }
    },
  });
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  expect(probe).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenCalledTimes(1);
  release();
  const result = await pending;
  expect(result.eligibleKeys).toEqual(['c0', 'c1']);
  expect(result.observations.map((item) => item.verdict)).toEqual(['Reachable', 'Reachable']);
});

it('cancel joins an admitted publication and suppresses its late progress or successor', async () => {
  const cancel = new AbortController(),
    progress = vi.fn();
  let release!: () => void;
  const publishing = new Promise<void>((resolve) => {
    release = resolve;
  });
  const probe = vi.fn(async (c: ReviewCandidate) => response(c));
  const pending = checkScanCandidates(review(2), {
    ...options(),
    maxConcurrency: 1,
    signal: cancel.signal,
    probe,
    progress,
    onObservation: async () => publishing,
  });
  let settled = false;
  void pending.catch(() => {
    settled = true;
  });
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  cancel.abort();
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(probe).toHaveBeenCalledTimes(1);
  expect(progress).toHaveBeenCalledTimes(1);
});

it('a publication failure aborts peers and joins actual probe settlement before rejecting', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const signals: AbortSignal[] = [];
  const pending = checkScanCandidates(review(3), {
    ...options(),
    maxConcurrency: 2,
    probe: async (c, signal) => {
      signals.push(signal);
      if (c.key === 'c1') await held;
      return response(c);
    },
    onObservation: async () => {
      throw new Error('Publication refused.');
    },
  });
  let settled = false;
  void pending.catch(() => {
    settled = true;
  });
  for (let tick = 0; tick < 12; tick++) await Promise.resolve();
  expect(signals[1]!.aborted).toBe(true);
  expect(settled).toBe(false);
  release();
  await expect(pending).rejects.toThrow('Publication refused');
  expect(signals).toHaveLength(2);
});

it('one stalled origin cannot occupy every slot or delay another region-prioritized origin', async () => {
  const input = review(19);
  for (let i = 0; i < 16; i++) input.candidates[i]!.channel.urls = [`https://stalled.invalid/${i}`];
  input.candidates[17]!.channel.urls = ['https://fixture-16.invalid/second'];
  const starts: string[] = [];
  const finishes = new Map<string, () => void>();
  const active = new Set<string>();
  let peak = 0;
  const deadlines = new Set<unknown>();
  const pending = checkScanCandidates(input, {
    ...options(),
    maxConcurrency: 16,
    timer: {
      set(callback) {
        deadlines.add(callback);
        return callback;
      },
      clear(handle) {
        deadlines.delete(handle);
      },
    },
    probe: async (c) => {
      const origin = new URL(c.channel.urls[0]!).origin;
      expect(active.has(origin)).toBe(false);
      active.add(origin);
      peak = Math.max(peak, active.size);
      starts.push(c.key);
      if (c.key === 'c0') await new Promise<void>((resolve) => finishes.set(c.key, resolve));
      active.delete(origin);
      return response(c);
    },
  });
  for (let tick = 0; tick < 12; tick++) await Promise.resolve();
  expect(starts).toEqual(['c0', 'c16', 'c18', 'c17']);
  expect(deadlines.size).toBe(1);
  finishes.get('c0')!();
  const result = await pending;
  expect(starts.filter((key) => Number(key.slice(1)) < 16)).toEqual(
    Array.from({ length: 16 }, (_, i) => `c${i}`),
  );
  expect(result.eligibleKeys).toEqual(input.candidates.map((c) => c.key));
  expect(peak).toBeLessThanOrEqual(16);
  expect(deadlines.size).toBe(0);
});

it('Stop wakes idle origin waiters but joins the actual stalled probe with no successor or late callback', async () => {
  const input = review(18);
  for (const c of input.candidates) c.channel.urls = ['https://stalled.invalid/live'];
  const cancel = new AbortController();
  const progress = vi.fn(),
    publication = vi.fn();
  let release!: () => void;
  const probe = vi.fn(async (c: ReviewCandidate) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return response(c);
  });
  const pending = checkScanCandidates(input, {
    ...options(),
    signal: cancel.signal,
    maxConcurrency: 16,
    probe,
    progress,
    onObservation: publication,
  });
  let settled = false;
  void pending.catch(() => {
    settled = true;
  });
  expect(probe).toHaveBeenCalledTimes(1);
  cancel.abort();
  for (let tick = 0; tick < 8; tick++) await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(probe).toHaveBeenCalledTimes(1);
  expect(publication).not.toHaveBeenCalled();
  expect(progress).toHaveBeenCalledTimes(1);
});

it('finishes a 13,241-channel scan with intermittent bad channels and no leaked deadlines', async () => {
  const input = review(13241);
  for (let i = 0; i < input.candidates.length; i++)
    input.candidates[i]!.channel.urls = [`https://provider-${i % 127}.invalid/${i}`];
  const timers = new Set<unknown>();
  let checked = 0,
    published = 0;
  const result = await checkScanCandidates(input, {
    ...options(),
    maxConcurrency: 16,
    timer: {
      set(callback) {
        timers.add(callback);
        return callback;
      },
      clear(handle) {
        timers.delete(handle);
      },
    },
    probe: async (c) => {
      const index = Number(c.key.slice(1));
      if (index % 10 === 0) throw new Error('private provider response');
      return response(c);
    },
    onObservation: async (_candidate, observation) => {
      checked++;
      if (observation.verdict === 'Reachable') published++;
    },
  });
  expect(checked).toBe(13241);
  expect(published).toBe(11916);
  expect(result.observations).toHaveLength(13241);
  expect(result.eligibleKeys).toHaveLength(11916);
  expect(result.observations.at(-1)?.verdict).toBe('TemporaryUnavailable');
  expect(timers.size).toBe(0);
  expect(JSON.stringify(result)).not.toContain('private provider');
});

it('a timed-out occupied origin and malformed peers do not prevent healthy successors or duplicate completed checks', async () => {
  const input = review(6);
  for (const [index, entry] of input.candidates.entries())
    entry.channel.urls = [
      `https://${[0, 1, 5].includes(index) ? 'held' : 'fast'}.fixture.invalid/${index}`,
    ];
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [],
    active = new Map<string, number>();
  const timers = new Set<() => void>(),
    deadlines: Array<() => void> = [];
  const progress = vi.fn(),
    published = vi.fn();
  let peak = 0;
  const pending = checkScanCandidates(input, {
    ...options(),
    maxConcurrency: 4,
    progress,
    onObservation: published,
    timer: {
      set(callback) {
        deadlines.push(callback);
        timers.add(callback);
        return callback;
      },
      clear(handle) {
        timers.delete(handle as () => void);
      },
    },
    probe: async (entry, signal) => {
      const origin = new URL(entry.channel.urls[0]!).origin;
      active.set(origin, (active.get(origin) ?? 0) + 1);
      expect(active.get(origin)).toBe(1);
      peak = Math.max(
        peak,
        [...active.values()].reduce((sum, count) => sum + count, 0),
      );
      started.push(entry.key);
      try {
        if (entry.key === 'c0') {
          await held;
          expect(signal.aborted).toBe(true);
        }
        if (entry.key === 'c2') throw new Error('private upstream payload');
        if (entry.key === 'c3') return { ...response(entry), sourceId: 'unrelated-source' };
        return response(entry);
      } finally {
        active.set(origin, active.get(origin)! - 1);
      }
    },
  });
  try {
    await vi.waitFor(() => expect(started).toEqual(['c0', 'c2', 'c3', 'c4']));
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ done: 3, total: 6, responded: 1 });
    deadlines[0]!();
    await Promise.resolve();
    expect(started).not.toContain('c1'); // Abort is not a cleanup acknowledgement.
  } finally {
    release();
  }
  const result = await pending;
  expect(started).toEqual(['c0', 'c2', 'c3', 'c4', 'c1', 'c5']);
  expect(new Set(started).size).toBe(6);
  expect(peak).toBe(2);
  expect(result.observations.map((entry) => entry.verdict)).toEqual([
    'TimedOut',
    'Reachable',
    'TemporaryUnavailable',
    'NotChecked',
    'Reachable',
    'Reachable',
  ]);
  expect(result.eligibleKeys).toEqual(['c1', 'c4', 'c5']);
  expect(progress.mock.calls.map((call) => call[0].done)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(published).toHaveBeenCalledTimes(6);
  expect(timers.size).toBe(0);
  expect([...active.values()].every((count) => count === 0)).toBe(true);
  expect(JSON.stringify(result)).not.toContain('private upstream payload');
});

function overlappingReview(): ScanReview {
  const input = review(2);
  input.candidates = ['a', 'b'].map((sourceId) => ({
    ...candidate(0),
    key: sourceId,
    sourceId,
    sourceFingerprint: 'fingerprint-' + sourceId,
    channel: {
      ...candidate(0).channel,
      sourceId,
      providerId: 'station',
      urls: [
        'https://shared.fixture.invalid/feed?token=one',
        'https://backup.fixture.invalid/feed',
      ],
      geography: { country: 'US' },
    },
  }));
  return input;
}
const overlappingPolicies = () =>
  ['a', 'b'].map((sourceId) => ({
    sourceId,
    fingerprint: 'fingerprint-' + sourceId,
    allowHttp: false,
    headers: { Accept: 'application/vnd.apple.mpegurl' },
  }));
it('reuses only exact compatible responses while rebuilding every source and fingerprint observation', async () => {
  const input = overlappingReview();
  const probe = vi.fn(async (c: ReviewCandidate) => response(c));
  const result = await checkScanCandidates(input, {
    ...options(),
    sourcePolicies: overlappingPolicies(),
    probe,
  });
  expect(probe).toHaveBeenCalledTimes(1);
  expect(result.eligibleKeys).toEqual(['a', 'b']);
  expect(
    result.observations.map((o) => [o.channelId, o.sourceId, o.fingerprint, o.observedAt]),
  ).toEqual([
    ['a', 'a', 'fingerprint-a', 1000],
    ['b', 'b', 'fingerprint-b', 1000],
  ]);
  expect(input.candidates.map((c) => c.sourceId)).toEqual(['a', 'b']);
});
it.each([
  'grant',
  'headers',
  'provider',
  'geography',
  'name',
  'url-order',
  'signed-query',
  'fingerprint',
])('does not reuse incompatible %s scope', async (difference) => {
  const input = overlappingReview(),
    policies = overlappingPolicies();
  const second = input.candidates[1]!;
  if (difference === 'grant') policies[1]!.allowHttp = true;
  if (difference === 'headers') policies[1]!.headers.Accept = 'different';
  if (difference === 'provider') second.channel.providerId = 'different';
  if (difference === 'geography') second.channel.geography = { country: 'CA' };
  if (difference === 'name') second.channel.name = 'Different station';
  if (difference === 'url-order') second.channel.urls.reverse();
  if (difference === 'signed-query') second.channel.urls[0] += '&other=1';
  if (difference === 'fingerprint') policies[1]!.fingerprint = 'foreign';
  const probe = vi.fn(async (c: ReviewCandidate) => response(c));
  await checkScanCandidates(input, { ...options(), sourcePolicies: policies, probe });
  expect(probe).toHaveBeenCalledTimes(2);
});
it.each(['timeout', 'stale', 'throw', 'decoded'] as const)(
  'does not reuse %s probe results',
  async (mode) => {
    const probe = vi.fn(async (c: ReviewCandidate) => {
      if (mode === 'throw') throw new Error('private provider error');
      if (mode === 'timeout') return response(c, 'timeout');
      if (mode === 'stale') return { ...response(c), observedAt: 999 };
      return createHealthObservation(
        { channelId: c.key, sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
        { platform: 'browser', observedAt: 1000 },
        {
          kind: 'decoded',
          before: { mediaTime: 0, decodedFrames: 0, width: 640, height: 360 },
          after: { mediaTime: 2, decodedFrames: 60, width: 640, height: 360 },
          elapsedMilliseconds: 2000,
        },
      );
    });
    const result = await checkScanCandidates(overlappingReview(), {
      ...options(),
      sourcePolicies: overlappingPolicies(),
      probe,
    });
    expect(probe).toHaveBeenCalledTimes(2);
    if (mode === 'decoded')
      expect(result.observations.map((value) => value.verdict)).toEqual([
        'PlayedHere',
        'PlayedHere',
      ]);
    if (mode === 'stale') expect(result.eligibleKeys).toEqual([]);
  },
);
it('reuse expires at the original response budget and cannot manufacture a new observation timestamp', async () => {
  let time = 1000;
  const probe = vi.fn(async (c: ReviewCandidate) => ({ ...response(c), observedAt: time }));
  const result = await checkScanCandidates(overlappingReview(), {
    ...options(),
    now: () => time,
    sourcePolicies: overlappingPolicies(),
    probe,
    onObservation: async () => {
      time += 20000;
    },
  });
  expect(probe).toHaveBeenCalledTimes(2);
  expect(result.observations.map((o) => o.observedAt)).toEqual([1000, 21000]);
});
it('aborted shared origin joins the actual probe and never reuses or starts its duplicate', async () => {
  const owner = new AbortController();
  let release!: () => void;
  const probe = vi.fn(async (_c: ReviewCandidate, signal: AbortSignal) => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    signal.throwIfAborted();
    return response(_c);
  });
  const pending = checkScanCandidates(overlappingReview(), {
    ...options(),
    signal: owner.signal,
    sourcePolicies: overlappingPolicies(),
    probe,
  });
  owner.abort();
  let settled = false;
  void pending
    .catch(() => undefined)
    .finally(() => {
      settled = true;
    });
  await Promise.resolve();
  expect(settled).toBe(false);
  release();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(probe).toHaveBeenCalledTimes(1);
  const freshProbe = vi.fn(async (c: ReviewCandidate) => response(c));
  await checkScanCandidates(overlappingReview(), {
    ...options(),
    sourcePolicies: overlappingPolicies(),
    probe: freshProbe,
  });
  expect(freshProbe).toHaveBeenCalledTimes(1);
});

it('bounded response reuse evicts old entries instead of retaining every stream in a large scan', async () => {
  const input = overlappingReview();
  const first = input.candidates[0]!;
  input.candidates = Array.from({ length: 257 }, (_, index) => ({
    ...first,
    key: 'key-' + index,
    channel: {
      ...first.channel,
      name: 'Station ' + index,
      urls: ['https://shared.fixture.invalid/' + index],
    },
  }));
  input.candidates.push({
    ...input.candidates[0]!,
    key: 'duplicate',
    sourceId: 'b',
    sourceFingerprint: 'fingerprint-b',
    channel: { ...input.candidates[0]!.channel, sourceId: 'b' },
  });
  const probe = vi.fn(async (c: ReviewCandidate) => response(c));
  const result = await checkScanCandidates(input, {
    ...options(),
    maxConcurrency: 1,
    sourcePolicies: overlappingPolicies(),
    probe,
  });
  expect(result.observations).toHaveLength(258);
  expect(probe).toHaveBeenCalledTimes(258);
});

function frozen<T>(input: T, seen = new WeakSet<object>()): T {
  if (input && typeof input === 'object' && !seen.has(input)) {
    seen.add(input);
    for (const child of Object.values(input)) frozen(child, seen);
    Object.freeze(input);
  }
  return input;
}
it('owned snapshot stays immutable while only admittedprobe copies canbemutated', async () => {
  const input = frozen(review(4)),
    seen: ReviewCandidate[] = [];
  expect(() => {
    input.candidates[0]!.channel.name = 'Caller mutation';
  }).toThrow();
  const result = await checkOwnedScanCandidates(input, {
    ...options(),
    maxConcurrency: 4,
    probe: async (c) => {
      expect(c).not.toBe(input.candidates[seen.length]);
      seen.push(c);
      c.channel.name = 'Probe privatecopy';
      return response(c);
    },
    onObservation: async (c) => {
      c.channel.name = 'Callback privatecopy';
    },
  });
  expect(result.eligibleKeys).toEqual(['c0', 'c1', 'c2', 'c3']);
  expect(input.candidates.map((c) => c.channel.name)).toEqual([
    'Channel 0',
    'Channel 1',
    'Channel 2',
    'Channel 3',
  ]);
});
it.each(['mutable', 'nested', 'accessor', 'custom', 'cycle'] as const)(
  'owned admission refuses %s without anyprobe',
  async (mode) => {
    const input = review(1);
    let reads = 0;
    if (mode === 'nested') {
      Object.freeze(input);
      Object.freeze(input.candidates);
      Object.freeze(input.candidates[0]);
    }
    if (mode === 'accessor') {
      Object.defineProperty(input.candidates[0]!.channel, 'name', {
        get: () => {
          reads++;
          return 'Live';
        },
        enumerable: true,
      });
      frozen(input);
      reads = 0;
    }
    if (mode === 'custom') {
      Object.setPrototypeOf(input.candidates[0]!.channel, { inherited: 'unknown' });
      frozen(input);
    }
    if (mode === 'cycle') {
      Object.assign(input.candidates[0]!.channel, { cycle: input });
      frozen(input);
    }
    const probe = vi.fn(async (c) => response(c));
    await expect(checkOwnedScanCandidates(input, { ...options(), probe })).rejects.toThrow(
      'deeply frozen',
    );
    expect(probe).not.toHaveBeenCalled();
    expect(reads).toBe(0);
  },
);
it('63k owned snapshot doesnotcloneallcandidates andCanceljoins16 admittedcopies beforeterminal', async () => {
  const input = frozen(review(63193)),
    cancel = new AbortController();
  const actualClone = structuredClone,
    clone = vi.spyOn(globalThis, 'structuredClone');
  clone.mockImplementation((value) => actualClone(value));
  const releases: (() => void)[] = [];
  let active = 0,
    peak = 0,
    progress = 0;
  try {
    const pending = checkOwnedScanCandidates(input, {
      ...options(),
      signal: cancel.signal,
      maxConcurrency: 16,
      progress: () => progress++,
      probe: async (c) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        return response(c);
      },
    });
    await vi.waitFor(() => expect(releases).toHaveLength(16));
    expect(peak).toBe(16);
    expect(clone.mock.calls.some(([value]) => Array.isArray(value) && value.length === 63193)).toBe(
      false,
    );
    expect(
      clone.mock.calls.filter(
        ([value]) => value && typeof value === 'object' && Object.hasOwn(value, 'key'),
      ),
    ).toHaveLength(16);
    const before = progress;
    let settled = false;
    const outcome = pending.then(
      () => {
        settled = true;
      },
      (error) => {
        settled = true;
        throw error;
      },
    );
    const refusal = expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    cancel.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    releases.forEach((release) => release());
    await refusal;
    expect(active).toBe(0);
    await vi.waitFor(() => expect(releases).toHaveLength(16));
    expect(progress).toBe(before);
  } finally {
    clone.mockRestore();
  }
}, 30000);
it('owned originfairness keepseligiblepriority/inputordered observations despiteoutoforder completion', async () => {
  const input = review(4);
  input.candidates[1]!.channel.urls = input.candidates[0]!.channel.urls;
  const immutable = frozen(input),
    started: string[] = [],
    release = new Map<string, () => void>();
  const pending = checkOwnedScanCandidates(immutable, {
    ...options(),
    maxConcurrency: 2,
    probe: async (c) => {
      started.push(c.key);
      await new Promise<void>((resolve) => release.set(c.key, resolve));
      return response(c);
    },
  });
  await vi.waitFor(() => expect(started).toEqual(['c0', 'c2']));
  release.get('c2')!();
  await vi.waitFor(() => expect(started).toEqual(['c0', 'c2', 'c3']));
  release.get('c3')!();
  release.get('c0')!();
  await vi.waitFor(() => expect(started).toEqual(['c0', 'c2', 'c3', 'c1']));
  release.get('c1')!();
  expect((await pending).eligibleKeys).toEqual(['c0', 'c1', 'c2', 'c3']);
});

it('owned verification refuses >100k before traversing candidatechildren and cancancel beforeprobes', async () => {
  const oversized = review(0);
  oversized.candidates = new Array(100001);
  let reads = 0;
  Object.defineProperty(oversized.candidates, '0', {
    get: () => {
      reads++;
      return candidate(0);
    },
    enumerable: true,
  });
  Object.freeze(oversized.candidates);
  Object.freeze(oversized);
  const probe = vi.fn(async (c) => response(c));
  await expect(checkOwnedScanCandidates(oversized, { ...options(), probe })).rejects.toThrow(
    'deeply frozen',
  );
  expect(reads).toBe(0);
  expect(probe).not.toHaveBeenCalled();
  const input = frozen(review(63193)),
    cancel = new AbortController();
  const pending = checkOwnedScanCandidates(input, { ...options(), signal: cancel.signal, probe });
  cancel.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(probe).not.toHaveBeenCalled();
}, 30000);

it('public defensive snapshot isolates mutations to candidates notyetadmitted', async () => {
  const input = review(5),
    names: string[] = [],
    urls: string[] = [];
  let release!: () => void;
  const pending = checkScanCandidates(input, {
    ...options(),
    maxConcurrency: 1,
    probe: async (c) => {
      names.push(c.channel.name);
      urls.push(c.channel.urls[0]!);
      if (c.key === 'c0')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return response(c);
    },
  });
  expect(names).toEqual(['Channel 0']);
  input.candidates[1]!.key = 'changed';
  input.candidates[1]!.channel.name = 'Changed after admission';
  input.candidates[1]!.channel.urls[0] = 'https://changed.invalid/live';
  release();
  const result = await pending;
  expect(names).toEqual(['Channel 0', 'Channel 1', 'Channel 2', 'Channel 3', 'Channel 4']);
  expect(urls[1]).toBe('https://fixture-1.invalid/1');
  expect(result.eligibleKeys).toEqual(['c0', 'c1', 'c2', 'c3', 'c4']);
});
