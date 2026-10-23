import { checkpointProviders } from './helpers/scan-checkpoint';
import { validateCatalog } from '../../src/catalog';
import { checkScanCandidates } from '../../src/discovery/automatic-check';
import { createHealthObservation } from '../../src/discovery/health';
import { expect, it } from 'vitest';
import { checkpointFixture } from './helpers/scan-checkpoint';
import {
  captureStoredScanCheckpoint,
  type ScanCheckpointCaptureInput,
} from '../../src/application/scan-checkpoint-capture';
import {
  parseStoredScanCheckpoint,
  restoreReferencedScanCheckpoint,
  serializeScanCheckpoint,
  canResumeScanCheckpoint,
  validateCheckpointSourceAdmission,
  type ReferencedScanCheckpoint,
} from '../../src/discovery/scan-checkpoint';

async function fixture(): Promise<ScanCheckpointCaptureInput> {
  const {
    schemaVersion: _version,
    policyFingerprint: _policy,
    sourceDefinitions,
    ...state
  } = await checkpointFixture();
  state.review.candidates[0]!.channel.urls = [
    'https://stream.fixture.invalid/live/secret-user/secret-pass/first.ts',
    'https://backup.fixture.invalid/second.ts',
  ];
  return {
    ...state,
    sources: sourceDefinitions.map((d) => d.source),
    providers: checkpointProviders,
  };
}
async function reference(input: ScanCheckpointCaptureInput): Promise<ReferencedScanCheckpoint> {
  const text = await captureStoredScanCheckpoint(input);
  expect(text).not.toBeNull();
  const parsed = await parseStoredScanCheckpoint(text!);
  expect(parsed.schemaVersion).toBe(2);
  return parsed as ReferencedScanCheckpoint;
}
it('cold reference continuation restores exact admitted URLs only in RAM and retains settled observations without persisting secrets', async () => {
  const input = await fixture(),
    before = structuredClone(input),
    ref = await reference(input);
  const wire = JSON.stringify(ref);
  expect(wire).not.toContain('secret-user');
  expect(wire).not.toContain('secret-pass');
  expect(wire).not.toContain('stream.fixture.invalid');
  expect(ref.review.candidates[0]!.channel).not.toHaveProperty('urls');
  const runtime = await restoreReferencedScanCheckpoint(ref, structuredClone(input.review));
  expect(runtime.review).toEqual(input.review);
  expect(runtime.observations).toEqual(input.observations);
  expect(input).toEqual(before);
  const settled = new Set(runtime.observations.map((o) => o.channelId));
  expect(runtime.review.candidates.filter((c) => !settled.has(c.key))).toEqual([]);
  await expect(serializeScanCheckpoint(runtime)).rejects.toThrow('cannot safely resume');
  expect(
    JSON.parse((await captureStoredScanCheckpoint({ ...input, review: runtime.review }))!),
  ).toEqual(ref);
});
it.each(['url', 'source', 'missing'] as const)(
  'changed upstream %s requires Rescan without a partial restore',
  async (kind) => {
    const input = await fixture(),
      ref = await reference(input),
      fresh = structuredClone(input.review);
    const c = fresh.candidates[0]!;
    if (kind === 'url') c.channel.urls[0] = 'https://changed.fixture.invalid/feed';
    if (kind === 'source') c.sourceFingerprint += 'changed';
    if (kind === 'missing') {
      fresh.candidates = [];
      fresh.counts.matched = 0;
      fresh.sources[0]!.matched = 0;
    }
    await expect(restoreReferencedScanCheckpoint(ref, fresh)).rejects.toThrow();
    expect(ref.review.candidates).toHaveLength(1);
    expect(ref.observations).toHaveLength(1);
  },
);
it.each(['missing-ref', 'malformed-hash', 'raw-url', 'ref-collision', 'digest'] as const)(
  'refuses %s before any reacquisition or publication',
  async (kind) => {
    const ref = await reference(await fixture()),
      c = ref.review.candidates[0]!;
    if (kind === 'missing-ref') Reflect.deleteProperty(c, 'reference');
    if (kind === 'malformed-hash') c.reference.urlHashes[0] = 'broken';
    if (kind === 'raw-url')
      Reflect.set(c.channel, 'urls', ['https://private.fixture.invalid/live/user/password/stream']);
    if (kind === 'ref-collision') c.reference.urlHashes[1] = c.reference.urlHashes[0]!;
    if (kind === 'digest') ref.reviewDigest = '0'.repeat(64);
    await expect(parseStoredScanCheckpoint(JSON.stringify(ref))).rejects.toThrow();
  },
);
it('keeps v1 reads compatible, refuses account sources and preserves age/policy/revision gates for v2', async () => {
  const legacy = await checkpointFixture();
  expect((await parseStoredScanCheckpoint(JSON.stringify(legacy))).schemaVersion).toBe(1);
  const input = await fixture(),
    ref = await reference(input);
  expect(canResumeScanCheckpoint(ref, 1001, '0', ref.policyFingerprint)).toBe(true);
  expect(canResumeScanCheckpoint(ref, 86401000, '0', ref.policyFingerprint)).toBe(false);
  expect(canResumeScanCheckpoint(ref, 1001, '1', ref.policyFingerprint)).toBe(false);
  expect(canResumeScanCheckpoint(ref, 1001, '0', 'f'.repeat(64))).toBe(false);
  await expect(validateCheckpointSourceAdmission(ref, [], [])).rejects.toThrow();
  input.sources[0]!.location = 'https://account.fixture.invalid/get.php?username=secret';
  expect(await captureStoredScanCheckpoint(input)).toBeNull();
});

it('uses fixed UTF-8 tuple hashes shared with the native validator', async () => {
  const input = await fixture();
  input.review.candidates[0]!.channel.name = 'Σήμα 📺';
  const ref = await reference(input);
  expect(ref.review.candidates[0]!.reference).toEqual({
    candidateDigest: '002a3e171a51536b5ea5fb6d5c6d4ae45cdda25972aeb49265824608379c892b',
    urlHashes: [
      '758da0a233e1396f0aa1e3428fc897189ea25679559b88ddfab6c993eed7f019',
      'ce826b1bc21e777cf5231d3e82a28306403dafa4685791c75d88bfbaff6c7827',
    ],
  });
  expect(ref.reviewDigest).toBe('da0bb844d3f9deaeb39343b4eb138c797d8e1a3e22fa0b14dfb4fd2c58bcc627');
});

it('retains all 13256 ordered candidates within the unchanged persisted bound', async () => {
  const input = await fixture(),
    original = input.review.candidates[0]!;
  input.review.candidates = Array.from({ length: 13256 }, (_, i) => ({
    ...original,
    key: 'candidate-' + i,
    channel: {
      ...original.channel,
      name: 'Channel ' + i,
      urls: ['https://public.fixture.invalid/live/test-user/test-pass/' + i + '.ts'],
    },
  }));
  input.review.counts.inspected = input.review.counts.matched = 13256;
  input.review.sources[0]!.inspected = input.review.sources[0]!.matched = 13256;
  input.observations = [];
  const text = await captureStoredScanCheckpoint(input);
  expect(text).not.toBeNull();
  expect(new TextEncoder().encode(text!).length).toBeLessThan(20 * 1024 * 1024);
  expect(text).not.toContain('test-pass');
  const ref = (await parseStoredScanCheckpoint(text!)) as ReferencedScanCheckpoint;
  expect(ref.review.candidates).toHaveLength(13256);
  const restored = await restoreReferencedScanCheckpoint(ref, input.review);
  expect(restored.review.candidates.map((c) => c.key)).toEqual(
    input.review.candidates.map((c) => c.key),
  );
  expect(restored.review.candidates.at(-1)!.channel.urls).toEqual(
    input.review.candidates.at(-1)!.channel.urls,
  );
}, 30000);

it('v2 cold restoration keeps denied HTTP pending without granting eligibility or publication', async () => {
  const input = await fixture(),
    first = input.review.candidates[0]!;
  first.channel.urls = ['http://public.fixture.invalid/feed'];
  input.review.candidates.push({
    ...first,
    key: 'https-key',
    channel: {
      ...first.channel,
      name: 'HTTPS channel',
      urls: ['https://secure.fixture.invalid/live/test-user/test-pass/stream.ts'],
    },
  });
  input.review.counts.inspected = input.review.counts.matched = 2;
  input.review.sources[0]!.inspected = input.review.sources[0]!.matched = 2;
  input.observations = [];
  input.publishedKeys = [];
  const ref = await reference(input);
  expect(ref.sourceDefinitions[0]!.source.allowHttp).toBe(false);
  const restored = await restoreReferencedScanCheckpoint(ref, structuredClone(input.review));
  expect(restored.sourceDefinitions[0]!.source.allowHttp).toBe(false);
  expect(restored.review.candidates[0]!.channel.urls).toEqual([
    'http://public.fixture.invalid/feed',
  ]);
  const sources = restored.sourceDefinitions.map((d) => d.source),
    admitted: string[] = [];
  const checked = await checkScanCandidates(restored.review, {
    signal: new AbortController().signal,
    platform: restored.platform,
    now: () => 1000,
    probe: async (candidate) => {
      let permitted = false;
      try {
        validateCatalog({
          schemaVersion: 1,
          sources,
          channels: [{ ...candidate.channel, id: candidate.key }],
        });
        permitted = true;
      } catch {
        /* Actual catalog transport policy refuses this pending address. */
      }
      if (permitted) admitted.push(candidate.key);
      return createHealthObservation(
        {
          channelId: candidate.key,
          sourceId: candidate.sourceId,
          fingerprint: candidate.sourceFingerprint,
        },
        { platform: restored.platform, observedAt: 1000 },
        { kind: permitted ? 'recognized-media-response' : 'unsupported' },
      );
    },
  });
  expect(admitted).toEqual(['https-key']);
  expect(checked.eligibleKeys).toEqual(['https-key']);
  expect(checked.observations[0]!.verdict).not.toBe('Reachable');
  const published = validateCatalog({
    schemaVersion: 1,
    sources,
    channels: restored.review.candidates
      .filter((c) => checked.eligibleKeys.includes(c.key))
      .map((c) => ({ ...c.channel, id: c.key })),
  });
  expect(published.channels.map((c) => c.id)).toEqual(['https-key']);
  expect(() =>
    validateCatalog({
      schemaVersion: 1,
      sources,
      channels: restored.review.candidates.map((c) => ({ ...c.channel, id: c.key })),
    }),
  ).toThrow('HTTP requires explicit source permission');
  expect(published.sources[0]!.allowHttp).toBe(false);
});
