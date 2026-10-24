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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { checkpointFixture, checkpointProviders } from './helpers/scan-checkpoint';
import {
  preparePackedScanCheckpoint,
  validatePackedScanCheckpoint,
  parsePackedScanCheckpoint,
  expandPackedScanCheckpoint,
  validateReferencedScanCheckpoint,
  type ReferencedScanCheckpoint,
} from '../../src/discovery/scan-checkpoint';
import {
  capturePackedWire,
  decodePackedReference,
  encodePackedReference,
  packedReviewDigest,
  type PackedScanCheckpoint,
} from '../../src/discovery/scan-checkpoint-packed';
afterEach(() => vi.restoreAllMocks());
async function example() {
  const {
    schemaVersion: _version,
    policyFingerprint: _policy,
    sourceDefinitions,
    ...state
  } = await checkpointFixture(true);
  const first = state.review.candidates[0]!;
  first.channel.providerId = 'Fixture.us';
  first.channel.geography = { country: 'US', state: 'US-IL' };
  first.channel.geographyProvenance = [
    {
      field: 'country',
      value: 'US',
      sourceId: first.sourceId,
      providerId: first.channel.providerId,
      kind: 'provider',
      scope: 'provider-declared',
    },
  ];
  state.review.candidates.push({
    ...first,
    key: 'second-key',
    channel: {
      sourceId: first.sourceId,
      name: 'Second',
      category: 'News',
      urls: ['https://fixture.invalid/second'],
      geography: {},
      geographyProvenance: [],
    },
  });
  state.review.sources[0]!.inspected = state.review.sources[0]!.matched = 2;
  state.review.counts.inspected = state.review.counts.matched = 2;
  return preparePackedScanCheckpoint({
    ...state,
    sources: sourceDefinitions.map((d) => d.source),
    providers: checkpointProviders,
  });
}
/** Retained canonical projection oracle: the removed encode+stable comparison,
 * with public v2 semantic admission and its documented legacy review digest. */
async function legacyCanonicalOracle(packed: PackedScanCheckpoint) {
  const { reference } = await decodePackedReference(packed);
  const r = reference.review;
  const tuple = [
    r.sessionRevision,
    r.query,
    r.status,
    r.sources.map((s) => [s.sourceId, s.fingerprint, s.status, s.inspected, s.matched, s.warnings]),
    [r.counts.inspected, r.counts.matched, r.counts.failedSources, r.counts.canceledSources],
    r.candidates.map((c) => [
      c.key,
      c.sourceId,
      c.sourceFingerprint,
      c.sessionRevision,
      [
        c.channel.sourceId,
        c.channel.providerId ?? null,
        c.channel.name,
        c.channel.category,
        [],
        c.channel.geography
          ? [
              c.channel.geography.country ?? null,
              c.channel.geography.region ?? null,
              c.channel.geography.state ?? null,
            ]
          : null,
        c.channel.geographyProvenance?.map((p) => [
          p.field,
          p.value,
          p.sourceId,
          p.providerId ?? null,
          p.kind,
          p.scope,
        ]) ?? null,
      ],
      c.reference.candidateDigest,
      c.reference.urlHashes,
    ]),
  ];
  const legacyDigest = [
    ...new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(tuple))),
    ),
  ]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('');
  const semantic: ReferencedScanCheckpoint = await validateReferencedScanCheckpoint({
    ...reference,
    reviewDigest: legacyDigest,
  });
  semantic.reviewDigest = reference.reviewDigest;
  const canonical = await encodePackedReference(semantic);
  const stable = (value: unknown) =>
    JSON.stringify(value, (_key, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
        : item,
    );
  if (stable(canonical) !== stable(packed)) throw new Error('Legacy canonical projection refused');
  return canonical;
}
async function outcome(work: Promise<unknown>) {
  try {
    await work;
    return 'accepted';
  } catch {
    return 'refused';
  }
}

describe('direct packed canonical admission parity', () => {
  it('retains optional slots, declared empty metadata, object order and negative-zero JSON semantics', async () => {
    const packed = await example();
    packed.review.candidates[0]![1] = -0;
    const variants = [
      packed,
      JSON.parse(
        JSON.stringify(packed, (_key, value: unknown) =>
          value && typeof value === 'object' && !Array.isArray(value)
            ? Object.fromEntries(Object.entries(value).reverse())
            : value,
        ),
      ) as PackedScanCheckpoint,
    ];
    for (const value of variants) {
      expect(await validatePackedScanCheckpoint(value)).toEqual(await legacyCanonicalOracle(value));
      expect(value.review.candidates[1]![5]).toEqual([[[], [], []]]);
      expect(value.review.candidates[1]![6]).toEqual([[]]);
    }
  });
  it.each([
    'provider-slot',
    'geography-slot',
    'provenance-slot',
    'duplicate-provenance',
    'extra-header',
    'extra-review',
    'extra-source',
    'duplicate-category',
    'category-order',
    'hash',
    'observation',
    'published-index',
    'digest',
  ] as const)('matches legacy refusal for authenticated hostile JSON wire %s', async (kind) => {
    const p = await example();
    if (kind === 'provider-slot') p.review.candidates[0]![2] = [null] as never;
    if (kind === 'geography-slot') p.review.candidates[0]![5] = [[[], []]] as never;
    if (kind === 'provenance-slot') p.review.candidates[0]![6] = [null] as never;
    if (kind === 'duplicate-provenance')
      p.review.candidates[0]![6][0]!.push(p.review.candidates[0]![6][0]![0]!);
    if (kind === 'extra-header') Object.assign(p, { payload: 'untrusted' });
    if (kind === 'extra-review') Object.assign(p.review, { payload: 'untrusted' });
    if (kind === 'extra-source')
      Object.assign(p.sourceDefinitions[0]!.source, { payload: 'untrusted' });
    if (kind === 'duplicate-category') p.categoryTable.push(p.categoryTable[0]!);
    if (kind === 'category-order') {
      p.categoryTable.reverse();
      p.review.candidates[0]![4] = 1;
      p.review.candidates[1]![4] = 0;
    }
    if (kind === 'hash') p.review.candidates[0]![7] = 'A'.repeat(42) + 'B';
    if (kind === 'observation') p.observations[0]![2] = 'NotChecked';
    if (kind === 'published-index') p.publishedIndices = [2];
    p.reviewDigest = await packedReviewDigest(p);
    if (kind === 'digest') p.review.candidates[0]![3] += 'changed';
    const wire = JSON.parse(JSON.stringify(p)) as PackedScanCheckpoint;
    expect(await outcome(legacyCanonicalOracle(wire))).toBe('refused');
    expect(await outcome(validatePackedScanCheckpoint(wire))).toBe('refused');
  });
  it.each([
    'undefined-slot',
    'sparse-slot',
    'tuple-prototype',
    'tuple-extra',
    'root-prototype',
  ] as const)('fails closed for non-JSON raw tuple shape %s', async (kind) => {
    const p = await example();
    if (kind === 'undefined-slot') p.review.candidates[0]![2] = [undefined] as never;
    if (kind === 'sparse-slot') p.review.candidates[0]![2] = new Array(1) as never;
    if (kind === 'tuple-prototype')
      Object.setPrototypeOf(p.review.candidates[0]!, Object.create(Array.prototype));
    if (kind === 'tuple-extra') Object.assign(p.review.candidates[0]!, { payload: 'untrusted' });
    if (kind === 'root-prototype') Object.setPrototypeOf(p, { foreign: true });
    p.reviewDigest = await packedReviewDigest(p);
    await expect(validatePackedScanCheckpoint(p)).rejects.toThrow();
  });
  it('does not reencode or build full stable JSON comparisons after admission', async () => {
    const packed = await example();
    const stringify = JSON.stringify;
    let fullWireCalls = 0;
    vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      if (
        value &&
        typeof value === 'object' &&
        value.schemaVersion === 3 &&
        Array.isArray(value.review?.candidates)
      ) {
        fullWireCalls++;
        if (fullWireCalls > 1) throw new Error('Extra aggregate packed serialization forbidden');
      }
      return stringify(value, replacer as never, space);
    });
    expect(await validatePackedScanCheckpoint(packed)).toEqual(packed);
    expect(fullWireCalls).toBe(1); // existing bounded input admission only
    fullWireCalls = 0;
    await expect(legacyCanonicalOracle(packed)).rejects.toThrow(
      'Extra aggregate packed serialization forbidden',
    );
  });
});

it('public admission captures before awaited hashing and owns output tuples after return', async () => {
  const input = await example();
  const expected = await legacyCanonicalOracle(structuredClone(input));
  const original = crypto.subtle.digest.bind(crypto.subtle);
  let release: (() => void) | undefined;
  let first = true;
  vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (algorithm, data) => {
    if (first) {
      first = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return original(algorithm, data);
  });
  const pending = validatePackedScanCheckpoint(input);
  await vi.waitFor(() => expect(release).toBeTypeOf('function'));
  input.review.candidates[0]![3] = 'Changed during hashing';
  input.sourceDefinitions[0]!.source.name = 'Changed source';
  input.review.sources[0]!.fingerprint = 'Changed fingerprint';
  release!();
  const result = await pending;
  expect(result).toEqual(expected);
  expect(result.review.candidates).not.toBe(input.review.candidates);
  input.categoryTable[0] = 'Changed after return';
  input.review.candidates[0]![8][0] = 'A'.repeat(43);
  input.observations[0]![3] = { kind: 'network-failure' };
  input.publishedIndices.length = 0;
  expect(result).toEqual(expected);
});
it('public expansion owns header and nested metadata independently of its input', async () => {
  const input = await example();
  const expanded = await expandPackedScanCheckpoint(input);
  const before = structuredClone(expanded);
  input.review.candidates[0]![6][0]![0]![1] = 'Changed';
  input.sourceDefinitions[0]!.source.location = 'https://changed.invalid/list';
  expect(expanded).toEqual(before);
});
it('owned string admission retains wire parity without a second full packed serialization', async () => {
  const input = await example(),
    wire = JSON.stringify(input);
  const stringify = JSON.stringify;
  let calls = 0;
  vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
    if (
      value &&
      typeof value === 'object' &&
      value.schemaVersion === 3 &&
      Array.isArray(value.review?.candidates)
    ) {
      calls++;
      if (calls > 1) throw new Error('Second aggregate wire rejected');
    }
    return stringify(value, replacer as never, space);
  });
  expect(await parsePackedScanCheckpoint(wire)).toEqual(input);
  expect(calls).toBe(1);
});
it('public raw capture refuses accessors without invoking them', async () => {
  const input = await example();
  let getters = 0;
  Object.defineProperty(input.review.candidates[0]!, 3, {
    get() {
      getters++;
      return 'untrusted';
    },
    enumerable: true,
  });
  await expect(validatePackedScanCheckpoint(input)).rejects.toThrow();
  expect(getters).toBe(0);
});

it.each(['oversized', 'huge-sparse', 'bounded-sparse', 'undefined-record'] as const)(
  'refuses raw structural abuse before output copying or hashing: %s',
  async (kind) => {
    const input = await example();
    let getters = 0;
    if (kind === 'oversized') input.review.candidates = new Array(100001);
    if (kind === 'huge-sparse') input.review.candidates = new Array(4294967295);
    if (kind === 'bounded-sparse') input.review.candidates = new Array(100000);
    if (kind === 'undefined-record') {
      const fields = Object.fromEntries(
        Array.from({ length: 33 }, (_, i) => [`field${i}`, undefined]),
      );
      Object.assign(input.sourceDefinitions[0]!.source, fields);
    }
    if (kind === 'oversized' || kind === 'huge-sparse')
      Object.defineProperty(input, 'untrustedAccessor', {
        enumerable: true,
        get() {
          getters++;
          return 'never read';
        },
      });
    const define = vi.spyOn(Object, 'defineProperty');
    const digest = vi.spyOn(crypto.subtle, 'digest');
    define.mockClear();
    let refused = false;
    try {
      capturePackedWire(input);
    } catch {
      refused = true;
    }
    const copies = define.mock.calls.length;
    expect(refused).toBe(true);
    expect(copies).toBe(0);
    expect(getters).toBe(0);
    expect(digest).not.toHaveBeenCalled();
  },
);
it('counts omitted undefined edges without changing valid wire byte admission', async () => {
  const input = await example();
  Object.defineProperty(input.sourceDefinitions[0]!.source, 'omitted', {
    value: undefined,
    enumerable: true,
  });
  const captured = capturePackedWire(input);
  expect(JSON.stringify(captured)).toBe(JSON.stringify(input));
});
