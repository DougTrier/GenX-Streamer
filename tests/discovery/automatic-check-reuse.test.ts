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
 * Automatic checks: response reuse and owned snapshots.
 */
import { expect, it, vi } from 'vitest';
import { type ReviewCandidate } from '../../src/discovery/scan';
import { checkOwnedScanCandidates, checkScanCandidates } from '../../src/discovery/automatic-check';
import { createHealthObservation } from '../../src/discovery/health';
import {
  overlappingReview,
  response,
  options,
  overlappingPolicies,
  frozen,
  review,
  candidate,
} from './automatic-check.fixture';

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
