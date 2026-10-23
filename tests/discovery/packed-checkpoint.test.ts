import { describe, expect, it } from 'vitest';
import { checkpointFixture, checkpointProviders } from './helpers/scan-checkpoint';
import {
  preparePackedScanCheckpoint,
  validatePackedScanCheckpoint,
  parsePackedScanCheckpoint,
  expandPackedScanCheckpoint,
  restorePackedScanCheckpoint,
  parseStoredScanCheckpoint,
  prepareReferencedScanCheckpoint,
  validateCheckpointSourceAdmission,
  canResumeScanCheckpoint,
} from '../../src/discovery/scan-checkpoint';
import {
  packedReviewDigest,
  packedHash,
  expandedHash,
} from '../../src/discovery/scan-checkpoint-packed';
async function input() {
  const {
    schemaVersion: _version,
    policyFingerprint: _policy,
    sourceDefinitions,
    ...state
  } = await checkpointFixture();
  return {
    ...state,
    sources: sourceDefinitions.map((d) => d.source),
    providers: checkpointProviders,
  };
}
describe('staged packed v3 checkpoint', () => {
  it('round-trips exact captured metadata, ordered references, evidence and ACKs without raw URLs', async () => {
    const state = await input();
    const c = state.review.candidates[0]!;
    c.channel.providerId = 'Fixture.us@SD';
    c.channel.name = 'Σ 📺 "Name"';
    c.channel.geography = { country: 'US', state: 'US-IL' };
    c.channel.geographyProvenance = [
      {
        field: 'country',
        value: 'US',
        sourceId: c.sourceId,
        providerId: c.channel.providerId,
        kind: 'provider',
        scope: 'provider-declared',
      },
    ];
    c.channel.urls = [
      'https://fixture.invalid/live/user/password/feed',
      'https://fixture.invalid/second',
    ];
    state.publishedKeys = [c.key];
    const packed = await preparePackedScanCheckpoint(state),
      wire = JSON.stringify(packed);
    expect(wire).not.toContain('password');
    expect(wire).not.toContain('fixture.invalid/live');
    expect(packed.schemaVersion).toBe(3);
    expect(packed.review.candidates[0]?.[7]).toHaveLength(43);
    expect(await parsePackedScanCheckpoint(wire)).toEqual(packed);
    const expanded = await expandPackedScanCheckpoint(packed);
    const { urls: _urls, ...metadata } = c.channel;
    expect(expanded.review.candidates[0]?.channel).toEqual(metadata);
    expect(expanded.observations).toEqual(state.observations);
    expect(expanded.publishedKeys).toEqual(state.publishedKeys);
    const runtime = await restorePackedScanCheckpoint(packed, structuredClone(state.review));
    expect(runtime.review).toEqual(state.review);
    expect(runtime.observations).toEqual(state.observations);
    expect(runtime.sourceDefinitions[0]?.source.allowHttp).toBe(false);
    const reordered = structuredClone(state.review);
    reordered.candidates[0]!.channel.urls.reverse();
    expect((await restorePackedScanCheckpoint(packed, reordered)).review).toEqual(state.review);
    await validateCheckpointSourceAdmission(runtime, [], checkpointProviders);
    expect(
      canResumeScanCheckpoint(runtime, 1001, runtime.catalogRevision, runtime.policyFingerprint),
    ).toBe(true);
    expect(canResumeScanCheckpoint(runtime, 1001, 'changed', runtime.policyFingerprint)).toBe(
      false,
    );
    expect(canResumeScanCheckpoint(runtime, 1001, runtime.catalogRevision, 'changed')).toBe(false);
    expect(
      canResumeScanCheckpoint(
        runtime,
        1000 + 24 * 60 * 60 * 1000,
        runtime.catalogRevision,
        runtime.policyFingerprint,
      ),
    ).toBe(false);
  });
  it('retains absent versus explicitly empty optional metadata', async () => {
    for (const declared of [false, true]) {
      const state = await input();
      if (declared) {
        state.review.candidates[0]!.channel.geography = {};
        state.review.candidates[0]!.channel.geographyProvenance = [];
      }
      const expanded = await expandPackedScanCheckpoint(await preparePackedScanCheckpoint(state));
      expect(Object.hasOwn(expanded.review.candidates[0]!.channel, 'geography')).toBe(declared);
      expect(Object.hasOwn(expanded.review.candidates[0]!.channel, 'geographyProvenance')).toBe(
        declared,
      );
    }
  });
  it('leaves legacy v2 parse and digest unchanged', async () => {
    const legacy = await prepareReferencedScanCheckpoint(await input());
    expect(await parseStoredScanCheckpoint(JSON.stringify(legacy))).toEqual(legacy);
  });
  it.each([
    'index',
    'tuple',
    'hash',
    'unused-category',
    'null-slot',
    'duplicate-observation',
    'duplicate-ack',
    'source-fingerprint',
    'unsafe-source',
    'unknown-field',
  ] as const)('refuses %s whole even with recomputed packed digest', async (kind) => {
    const p = await preparePackedScanCheckpoint({
      ...(await input()),
      publishedKeys: ['captured-key'],
    });
    if (kind === 'index') p.review.candidates[0]![1] = 100;
    if (kind === 'tuple') p.review.candidates[0]!.push('extra' as never);
    if (kind === 'hash') p.review.candidates[0]![7] = 'A'.repeat(42) + 'B';
    if (kind === 'unused-category') p.categoryTable.push('unused');
    if (kind === 'null-slot') p.review.candidates[0]![2] = [null] as never;
    if (kind === 'duplicate-observation') p.observations.push(p.observations[0]!);
    if (kind === 'duplicate-ack') p.publishedIndices.push(0);
    if (kind === 'source-fingerprint')
      p.sourceDefinitions[0]!.definitionFingerprint = '0'.repeat(64);
    if (kind === 'unsafe-source')
      p.sourceDefinitions[0]!.source.location = 'https://user:password@fixture.invalid/list';
    if (kind === 'unknown-field') Object.assign(p, { payload: 'secret' });
    p.reviewDigest = await packedReviewDigest(p);
    await expect(validatePackedScanCheckpoint(p)).rejects.toThrow();
  });
  it.each(['url', 'source', 'query'] as const)(
    'requires Rescan for changed reacquisition %s',
    async (kind) => {
      const state = await input(),
        p = await preparePackedScanCheckpoint(state),
        fresh = structuredClone(state.review);
      if (kind === 'url') fresh.candidates[0]!.channel.urls[0] += 'changed';
      if (kind === 'source') fresh.sources[0]!.fingerprint += 'changed';
      if (kind === 'query') fresh.query = 'other';
      await expect(restorePackedScanCheckpoint(p, fresh)).rejects.toThrow();
    },
  );
  it('uses canonical lossless 32-byte hash encoding', () => {
    for (const h of ['0'.repeat(64), 'f'.repeat(64), '0123456789abcdef'.repeat(4)])
      expect(expandedHash(packedHash(h))).toBe(h);
    expect(() => expandedHash('A'.repeat(42) + 'B')).toThrow();
  });
});

it.each([13256, 63193, 100000])(
  'validates actual packed codec byte bounds for %i fully settled synthetic candidates',
  async (count) => {
    const { encodePackedReference } = await import('../../src/discovery/scan-checkpoint-packed');
    const reference = await prepareReferencedScanCheckpoint(await input());
    const template = reference.review.candidates[0]!;
    reference.review.candidates = Array.from({ length: count }, (_, i) => {
      const providerId = `Fixture${i}.us@SD`,
        geo = i % 5 === 0;
      return {
        ...template,
        key: `candidate-${i.toString(16).padStart(32, '0')}`,
        channel: {
          sourceId: template.sourceId,
          providerId,
          name: `Controlled Channel ${i} Σ 📺`,
          category: ['Sports', 'News', 'Animation', 'General'][i % 4]!,
          ...(geo
            ? {
                geography: { country: 'US', state: 'US-IL' },
                geographyProvenance: [
                  {
                    field: 'country' as const,
                    value: 'US',
                    sourceId: template.sourceId,
                    providerId,
                    kind: 'provider' as const,
                    scope: 'provider-declared' as const,
                  },
                  {
                    field: 'state' as const,
                    value: 'US-IL',
                    sourceId: template.sourceId,
                    providerId,
                    kind: 'provider' as const,
                    scope: 'provider-declared' as const,
                  },
                ],
              }
            : {}),
        },
      };
    });
    reference.review.counts.inspected = count;
    reference.review.counts.matched = count;
    reference.review.sources[0]!.inspected = count;
    reference.review.sources[0]!.matched = count;
    reference.observations = reference.review.candidates.map((c, i) => ({
      ...reference.observations[0]!,
      channelId: c.key,
      observedAt: 1000 + i,
    }));
    reference.publishedKeys = reference.review.candidates.map((c) => c.key);
    if (count === 100000) {
      await expect(encodePackedReference(reference)).rejects.toThrow();
      return;
    }
    const packed = await encodePackedReference(reference);
    expect(new TextEncoder().encode(JSON.stringify(packed)).byteLength).toBeLessThanOrEqual(
      20 * 1024 * 1024,
    );
    const expanded = await expandPackedScanCheckpoint(packed);
    expect(expanded.review.candidates).toEqual(reference.review.candidates);
    expect(expanded.observations).toEqual(reference.observations);
    expect(expanded.publishedKeys).toEqual(reference.publishedKeys);
  },
  30000,
);

it('accepts reordered JSON object properties without changing tuple/digest identity', async () => {
  const packed = await preparePackedScanCheckpoint(await input());
  const reversed = JSON.parse(
    JSON.stringify(packed, (_key, item: unknown) =>
      item && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(Object.entries(item).reverse())
        : item,
    ),
  );
  expect(await validatePackedScanCheckpoint(reversed)).toEqual(packed);
});

it('matches the independently generated native packedreview digest vector', async () => {
  const packed = await preparePackedScanCheckpoint(await input());
  expect(packed.review.candidates[0]?.[7]).toBe('askvdn5LeQlLZPKYyL8DVAXLJ8hn6GH_osbrqNXMFlA');
  expect(packed.review.candidates[0]?.[8]).toEqual(['RDpwfxEObcvLRQAPGkYdxlPLzdyF7FPmlH7DLedY5yc']);
  expect(packed.reviewDigest).toBe(
    '30d78a2c2000257f0655e83c6c6a803699c475f5aee17d04a667ec65e15626ee',
  );
});
