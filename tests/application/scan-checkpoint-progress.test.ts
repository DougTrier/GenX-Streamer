import { expect, it, vi } from 'vitest';
import { createScanCheckpointProgressCapture } from '../../src/application/scan-checkpoint-capture-service';
import {
  captureInitialProgressCheckpoint,
  captureInitialPackedProgressCheckpoint,
  type ScanCheckpointCaptureInput,
} from '../../src/application/scan-checkpoint-capture';
import {
  parseStoredScanCheckpoint,
  validateScanCheckpointMutation,
} from '../../src/discovery/scan-checkpoint';
import { checkpointFixture, checkpointProviders } from '../discovery/helpers/scan-checkpoint';
async function fixture(count = 4): Promise<ScanCheckpointCaptureInput> {
  const c = await checkpointFixture();
  const base = c.review.candidates[0]!;
  c.review.candidates = Array.from({ length: count }, (_, i) => ({
    ...base,
    key: 'candidate-' + i,
    channel: {
      ...base.channel,
      name: 'Channel ' + i,
      urls: ['https://public.fixture.invalid/live/test-user/test-pass/' + i + '.ts'],
    },
  }));
  c.review.sources[0]!.matched = c.review.sources[0]!.inspected = count;
  c.review.counts.matched = c.review.counts.inspected = count;
  const observation = c.observations[0]!;
  c.observations = [Object.freeze({ ...observation, channelId: 'candidate-0' })];
  c.publishedKeys = ['candidate-0'];
  const { schemaVersion: _v, policyFingerprint: _p, sourceDefinitions, ...state } = c;
  return {
    ...state,
    sources: sourceDefinitions.map((d) => d.source),
    providers: checkpointProviders,
  };
}
const add = (input: ScanCheckpointCaptureInput, index: number) => {
  input.observations.push(
    Object.freeze({ ...input.observations[0]!, channelId: 'candidate-' + index }),
  );
  input.publishedKeys.push('candidate-' + index);
};
it('one window delta publishes256 exact new keys and retains all320 settled observations until one durable ACK', async () => {
  const input = await fixture(321);
  const owner = createScanCheckpointProgressCapture({
    supportsAdvance: true,
    initial: captureInitialProgressCheckpoint,
  });
  const seed = await owner.prepareMutation(input, new AbortController().signal);
  if (!seed) throw new Error('Missing seed');
  owner.acknowledgeMutation(seed, '1');
  for (let i = 1; i <= 256; i++) add(input, i);
  for (let i = 257; i <= 320; i++)
    input.observations.push(
      Object.freeze({
        ...input.observations[0]!,
        channelId: `candidate-${i}`,
        verdict: 'TemporaryUnavailable',
        evidence: { kind: 'network-failure' as const },
      }),
    );
  const keys = input.publishedKeys.slice(1);
  const mutation = await owner.prepareWindowMutation(input, keys, new AbortController().signal);
  expect(mutation).toMatchObject({ kind: 'advance', publishedKeys: keys });
  if (mutation?.kind !== 'advance') throw new Error('Missing delta');
  expect(mutation.observations).toHaveLength(320);
  expect(await owner.prepareWindowMutation(input, keys, new AbortController().signal)).toBe(
    mutation,
  );
  owner.acknowledgeMutation(mutation, '2');
  expect(await owner.prepareWindowMutation(input, [], new AbortController().signal)).toMatchObject({
    kind: 'advance',
    publishedKeys: [],
    observations: [],
  });
  await owner.dispose();
});
it('window key bounds and exact baseline-delta membership refuse without advancing pending ownership', async () => {
  const input = await fixture(258);
  const owner = createScanCheckpointProgressCapture({
    supportsAdvance: true,
    initial: captureInitialProgressCheckpoint,
  });
  const seed = await owner.prepareMutation(input, new AbortController().signal);
  if (!seed) throw new Error('Missing seed');
  owner.acknowledgeMutation(seed, '1');
  for (let i = 1; i <= 256; i++) add(input, i);
  await expect(
    owner.prepareWindowMutation(input, input.publishedKeys.slice(2), new AbortController().signal),
  ).rejects.toThrow();
  expect(() =>
    owner.prepareWindowMutation(
      input,
      Array.from({ length: 257 }, (_, i) => `candidate-${i}`),
      new AbortController().signal,
    ),
  ).toThrow();
  expect(owner.hasPendingPreparation).toBe(false);
  const correct = await owner.prepareWindowMutation(
    input,
    input.publishedKeys.slice(1),
    new AbortController().signal,
  );
  expect(correct?.kind).toBe('advance');
  owner.acknowledgeMutation(correct!, '2');
  await owner.dispose();
});
it('one forced v2 seed then sends only new progress and acknowledges only durable receipts', async () => {
  const input = await fixture(),
    initial = vi.fn(captureInitialProgressCheckpoint),
    owner = createScanCheckpointProgressCapture({ supportsAdvance: true, initial });
  const first = await owner.prepareMutation(input, new AbortController().signal);
  expect(first?.kind).toBe('save');
  if (first?.kind !== 'save') throw new Error('Missing seed');
  expect((await parseStoredScanCheckpoint(first.checkpoint)).schemaVersion).toBe(2);
  expect(first.checkpoint).not.toContain('test-pass');
  expect(await owner.prepareMutation(input, new AbortController().signal)).toBe(first);
  owner.acknowledgeMutation(first, '1');
  add(input, 1);
  input.catalogRevision = '2';
  const second = await owner.prepareMutation(input, new AbortController().signal);
  expect(second).toMatchObject({
    kind: 'advance',
    publishedKeys: ['candidate-1'],
    observations: [{ channelId: 'candidate-1' }],
  });
  expect(JSON.stringify(second)).not.toContain('test-pass');
  expect(second).not.toHaveProperty('review');
  expect(second).not.toHaveProperty('checkpoint');
  expect(initial).toHaveBeenCalledTimes(1);
  expect(await owner.prepareMutation(input, new AbortController().signal)).toBe(second);
  owner.acknowledgeMutation(second!, '2');
  expect(await owner.prepareMutation(input, new AbortController().signal)).toMatchObject({
    kind: 'advance',
    observations: [],
    publishedKeys: [],
  });
  await owner.dispose();
});
it('delta progress gives the same complete observations and keys as a full checkpoint', async () => {
  const input = await fixture(),
    owner = createScanCheckpointProgressCapture({
      supportsAdvance: true,
      initial: captureInitialProgressCheckpoint,
    });
  const seed = await owner.prepareMutation(input, new AbortController().signal);
  if (seed?.kind !== 'save') throw new Error('Missing seed');
  const stored = await parseStoredScanCheckpoint(seed.checkpoint);
  owner.acknowledgeMutation(seed, '1');
  add(input, 1);
  add(input, 2);
  const delta = await owner.prepareMutation(input, new AbortController().signal);
  if (delta?.kind !== 'advance') throw new Error('Missing delta');
  const full = await captureInitialProgressCheckpoint(input);
  const parsed = await parseStoredScanCheckpoint(full!.checkpoint);
  if (stored.schemaVersion !== 2 || parsed.schemaVersion !== 2)
    throw new Error('Legacy producer must emit v2');
  expect([...stored.observations, ...delta.observations]).toEqual(parsed.observations);
  expect([...stored.publishedKeys, ...delta.publishedKeys]).toEqual(parsed.publishedKeys);
  expect(delta.reviewDigest).toBe(parsed.schemaVersion === 2 ? parsed.reviewDigest : '');
  await owner.dispose();
});
it.each([
  'changed-observation',
  'lost-observation',
  'review',
  'scope',
  'published',
  'pending',
] as const)('refuses stale %s input without advancing cache', async (kind) => {
  const input = await fixture(),
    owner = createScanCheckpointProgressCapture({
      supportsAdvance: true,
      initial: captureInitialProgressCheckpoint,
    });
  const seed = await owner.prepareMutation(input, new AbortController().signal);
  if (kind !== 'pending') owner.acknowledgeMutation(seed!, '1');
  if (kind === 'changed-observation')
    input.observations[0] = { ...input.observations[0]!, observedAt: 1001 };
  if (kind === 'lost-observation') input.observations = [];
  if (kind === 'review') input.review = structuredClone(input.review);
  if (kind === 'scope') input.providers = [];
  if (kind === 'published') input.publishedKeys = [];
  if (kind === 'pending') add(input, 1);
  await expect(owner.prepareMutation(input, new AbortController().signal)).rejects.toThrow(
    'acknowledgment',
  );
  await owner.dispose();
});
it('unknown and noneligible keys refuse delta and false capability keeps full save fallback', async () => {
  const input = await fixture(),
    owner = createScanCheckpointProgressCapture({
      supportsAdvance: true,
      initial: captureInitialProgressCheckpoint,
    });
  const first = await owner.prepareMutation(input, new AbortController().signal);
  owner.acknowledgeMutation(first!, '1');
  input.publishedKeys.push('unknown');
  await expect(owner.prepareMutation(input, new AbortController().signal)).rejects.toThrow();
  await owner.dispose();
  const legacy = vi.fn(async () => 'legacy full snapshot'),
    fallback = createScanCheckpointProgressCapture({ supportsAdvance: false, legacy });
  expect(await fallback.prepareMutation(input, new AbortController().signal)).toEqual({
    kind: 'save',
    checkpoint: 'legacy full snapshot',
  });
  expect(legacy).toHaveBeenCalledOnce();
  await fallback.dispose();
});
it('bounded delta rejects hostile schemas, duplicates, forged verdicts and immutable payload fields', async () => {
  const input = await fixture(),
    base = {
      kind: 'advance',
      jobId: 'fixture-job',
      reviewDigest: 'a'.repeat(64),
      observations: input.observations,
      publishedKeys: ['candidate-0'],
    };
  expect(validateScanCheckpointMutation(base)).toEqual(base);
  for (const bad of [
    { ...base, reviewDigest: 'A'.repeat(64) },
    { ...base, checkpoint: 'forbidden' },
    { ...base, review: { private: 'forbidden' } },
    { ...base, publishedKeys: ['candidate-0', 'candidate-0'] },
    { ...base, observations: [...base.observations, ...base.observations] },
    { ...base, observations: [{ ...base.observations[0], verdict: 'PlayedHere' }] },
    { ...base, publishedKeys: Array.from({ length: 100001 }, (_, i) => 'k' + i) },
  ])
    expect(() => validateScanCheckpointMutation(bad)).toThrow();
});
it('400 progressive observations prepare the immutable review only once', async () => {
  const input = await fixture(400),
    initial = vi.fn(captureInitialProgressCheckpoint),
    owner = createScanCheckpointProgressCapture({ supportsAdvance: true, initial });
  let mutation = await owner.prepareMutation(input, new AbortController().signal);
  owner.acknowledgeMutation(mutation!, '1');
  for (let i = 1; i < 400; i++) {
    add(input, i);
    mutation = await owner.prepareMutation(input, new AbortController().signal);
    expect(mutation).toMatchObject({
      kind: 'advance',
      publishedKeys: ['candidate-' + i],
      observations: [{ channelId: 'candidate-' + i }],
    });
    expect(JSON.stringify(mutation).length).toBeLessThan(1000);
    owner.acknowledgeMutation(mutation!, String(i + 1));
  }
  expect(initial).toHaveBeenCalledTimes(1);
  await owner.dispose();
});
it('dispose aborts and joins noncooperative initial worker callback with no late pending state', async () => {
  const input = await fixture();
  let finish!: (value: null) => void;
  let signal!: AbortSignal;
  const owner = createScanCheckpointProgressCapture({
    supportsAdvance: true,
    initial: async (_input, ownedSignal) => {
      signal = ownedSignal;
      return await new Promise<null>((resolve) => (finish = resolve));
    },
  });
  const work = owner.prepareMutation(input, new AbortController().signal);
  let closed = false;
  const disposed = owner.dispose().then(() => (closed = true));
  await Promise.resolve();
  expect(signal.aborted).toBe(true);
  expect(closed).toBe(false);
  const canceled = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  finish(null);
  await canceled;
  await disposed;
  await expect(owner.prepareMutation(input, new AbortController().signal)).rejects.toThrow();
});

it('accepts idempotent empty ACK and detects canonical source grant drift without hashing the review', async () => {
  const input = await fixture(),
    initial = vi.fn(captureInitialProgressCheckpoint),
    owner = createScanCheckpointProgressCapture({ supportsAdvance: true, initial });
  const seed = await owner.prepareMutation(input, new AbortController().signal);
  owner.acknowledgeMutation(seed!, '1');
  const empty = await owner.prepareMutation(input, new AbortController().signal);
  owner.acknowledgeMutation(empty!, '1');
  input.canonicalSources = [{ ...input.sources[0]!, allowHttp: true }];
  await expect(owner.prepareMutation(input, new AbortController().signal)).rejects.toThrow(
    'acknowledgment',
  );
  expect(initial).toHaveBeenCalledTimes(1);
  await owner.dispose();
});

it('new job clears acknowledged progress and stale receipts cannot acknowledge its preparation', async () => {
  const input = await fixture(),
    initial = vi.fn(captureInitialProgressCheckpoint),
    owner = createScanCheckpointProgressCapture({ supportsAdvance: true, initial });
  const old = await owner.prepareMutation(input, new AbortController().signal);
  owner.acknowledgeMutation(old!, '1');
  input.jobId = 'new-job';
  input.observations = [];
  input.publishedKeys = [];
  const next = await owner.prepareMutation(input, new AbortController().signal);
  expect(next?.kind).toBe('save');
  expect(initial).toHaveBeenCalledTimes(2);
  expect(() => owner.acknowledgeMutation(old!, '2')).toThrow('acknowledgment');
  owner.acknowledgeMutation(next!, '2');
  expect(await owner.prepareMutation(input, new AbortController().signal)).toMatchObject({
    kind: 'advance',
    jobId: 'new-job',
    observations: [],
    publishedKeys: [],
  });
  await owner.dispose();
});

it('authoritatively unchanged rollback releases only pending work and retains the acknowledged baseline', async () => {
  const input = await fixture(),
    initial = vi.fn(captureInitialProgressCheckpoint),
    owner = createScanCheckpointProgressCapture({ supportsAdvance: true, initial });
  const first = await owner.prepareMutation(input, new AbortController().signal);
  owner.acknowledgeMutation(first!, '43');
  expect(owner.hasPendingPreparation).toBe(false);
  add(input, 1);
  const abandoned = await owner.prepareMutation(input, new AbortController().signal);
  expect(owner.hasPendingPreparation).toBe(true);
  // Prepared batch did not publish. Stop preserves its new observation but not its future ACK key.
  input.publishedKeys.pop();
  add(input, 2);
  input.publishedKeys.pop();
  await expect(owner.prepareMutation(input, new AbortController().signal)).rejects.toThrow(
    'acknowledgment',
  );
  owner.releaseUncommittedPreparation('43', '43');
  expect(owner.hasPendingPreparation).toBe(false);
  const stopped = await owner.prepareMutation(input, new AbortController().signal);
  expect(stopped).toMatchObject({
    kind: 'advance',
    publishedKeys: [],
    observations: [{ channelId: 'candidate-1' }, { channelId: 'candidate-2' }],
  });
  expect(initial).toHaveBeenCalledTimes(1);
  expect(() => owner.acknowledgeMutation(abandoned!, '44')).toThrow();
  owner.acknowledgeMutation(stopped!, '44');
  input.publishedKeys.push('candidate-1', 'candidate-2');
  const retried = await owner.prepareMutation(input, new AbortController().signal);
  expect(retried).toMatchObject({
    kind: 'advance',
    observations: [],
    publishedKeys: ['candidate-1', 'candidate-2'],
  });
  owner.acknowledgeMutation(retried!, '45');
  const empty = await owner.prepareMutation(input, new AbortController().signal);
  expect(empty).toMatchObject({ kind: 'advance', observations: [], publishedKeys: [] });
  await owner.dispose();
});
it.each(['44', '42', '043', 'invalid', '9223372036854775808'])(
  'does not release uncertain or invalid actual revision %s',
  async (actual) => {
    const input = await fixture(),
      owner = createScanCheckpointProgressCapture({
        supportsAdvance: true,
        initial: captureInitialProgressCheckpoint,
      });
    const seed = await owner.prepareMutation(input, new AbortController().signal);
    owner.acknowledgeMutation(seed!, '43');
    add(input, 1);
    const pending = await owner.prepareMutation(input, new AbortController().signal);
    expect(() => owner.releaseUncommittedPreparation('43', actual)).toThrow();
    expect(owner.hasPendingPreparation).toBe(true);
    expect(await owner.prepareMutation(input, new AbortController().signal)).toBe(pending);
    await owner.dispose();
  },
);
it('matching actual and expected revisions still refuse when different from the acknowledged baseline', async () => {
  const input = await fixture(),
    owner = createScanCheckpointProgressCapture({
      supportsAdvance: true,
      initial: captureInitialProgressCheckpoint,
    });
  const seed = await owner.prepareMutation(input, new AbortController().signal);
  owner.acknowledgeMutation(seed!, '43');
  add(input, 1);
  await owner.prepareMutation(input, new AbortController().signal);
  expect(() => owner.releaseUncommittedPreparation('44', '44')).toThrow();
  expect(owner.hasPendingPreparation).toBe(true);
  await owner.dispose();
});
it('initial uncommitted save can be recaptured after unchanged authority, with no fake ACK', async () => {
  const input = await fixture(),
    initial = vi.fn(captureInitialProgressCheckpoint),
    owner = createScanCheckpointProgressCapture({ supportsAdvance: true, initial });
  const old = await owner.prepareMutation(input, new AbortController().signal);
  add(input, 1);
  owner.releaseUncommittedPreparation('0', '0');
  const next = await owner.prepareMutation(input, new AbortController().signal);
  expect(next?.kind).toBe('save');
  expect(initial).toHaveBeenCalledTimes(2);
  if (next?.kind !== 'save') throw new Error('Missing recapture');
  expect((await parseStoredScanCheckpoint(next.checkpoint)).observations).toHaveLength(2);
  expect(() => owner.acknowledgeMutation(old!, '1')).toThrow();
  owner.acknowledgeMutation(next, '1');
  await owner.dispose();
});
it('release refuses while owned work is held, after disposal, and without a pending preparation', async () => {
  const input = await fixture();
  let settle!: (value: null) => void;
  const owner = createScanCheckpointProgressCapture({
    supportsAdvance: true,
    initial: async () => await new Promise<null>((resolve) => (settle = resolve)),
  });
  expect(() => owner.releaseUncommittedPreparation('0', '0')).toThrow();
  const work = owner.prepareMutation(input, new AbortController().signal);
  expect(() => owner.releaseUncommittedPreparation('0', '0')).toThrow();
  const disposal = owner.dispose(),
    aborted = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  settle(null);
  await aborted;
  await disposal;
  expect(() => owner.releaseUncommittedPreparation('0', '0')).toThrow();
  expect(owner.hasPendingPreparation).toBe(false);
});

it('confirmed packed capability seeds3 once, Stop captures onlynew deltas and oldnative defaults2', async () => {
  const input = await fixture(),
    packedInitial = vi.fn(captureInitialPackedProgressCheckpoint);
  const owner = createScanCheckpointProgressCapture({
    supportsAdvance: true,
    supportsPackedReference: true,
    packedInitial,
  });
  const seed = await owner.prepareMutation(input, new AbortController().signal);
  if (seed?.kind !== 'save') throw new Error('Missingseed');
  const parsed = await parseStoredScanCheckpoint(seed.checkpoint);
  expect(parsed.schemaVersion).toBe(3);
  owner.acknowledgeMutation(seed, '1');
  add(input, 1);
  const stop = await owner.prepareMutation(input, new AbortController().signal);
  expect(stop).toMatchObject({
    kind: 'advance',
    observations: [{ channelId: 'candidate-1' }],
    publishedKeys: ['candidate-1'],
    reviewDigest: parsed.schemaVersion === 3 ? parsed.reviewDigest : '',
  });
  expect(await owner.prepareMutation(input, new AbortController().signal)).toBe(stop);
  owner.acknowledgeMutation(stop!, '2');
  expect(packedInitial).toHaveBeenCalledOnce();
  await owner.dispose();
  const old = createScanCheckpointProgressCapture({
    supportsAdvance: true,
    initial: captureInitialProgressCheckpoint,
    packedInitial,
  });
  const oldSeed = await old.prepareMutation(input, new AbortController().signal);
  if (oldSeed?.kind !== 'save') throw new Error('Missingoldseed');
  expect((await parseStoredScanCheckpoint(oldSeed.checkpoint)).schemaVersion).toBe(2);
  expect(packedInitial).toHaveBeenCalledOnce();
  await old.dispose();
});
it('packed-capable owner accepts pinnedv2 initial callback for samejob continuation withoutmigration', async () => {
  const input = await fixture();
  const saved = await captureInitialProgressCheckpoint(input);
  const owner = createScanCheckpointProgressCapture({
    supportsAdvance: true,
    supportsPackedReference: true,
    packedInitial: captureInitialProgressCheckpoint,
  });
  const seed = await owner.prepareMutation(input, new AbortController().signal);
  if (seed?.kind !== 'save') throw new Error('Missingseed');
  expect((await parseStoredScanCheckpoint(seed.checkpoint)).schemaVersion).toBe(2);
  expect(JSON.parse(seed.checkpoint).reviewDigest).toBe(saved!.reviewDigest);
  owner.acknowledgeMutation(seed, '7');
  add(input, 1);
  const mutation = await owner.prepareMutation(input, new AbortController().signal);
  expect(mutation).toMatchObject({
    kind: 'advance',
    reviewDigest: saved!.reviewDigest,
    publishedKeys: ['candidate-1'],
  });
  await owner.dispose();
});
it.each([13256, 63193])(
  'productionpacked initial capture/restore admits%i expanded candidates withoutv2 wirecap bypass',
  async (count) => {
    const input = await fixture(count);
    for (const c of input.review.candidates) c.channel.name += ' ' + 'S'.repeat(120);
    const expandedBytes = new TextEncoder().encode(JSON.stringify(input)).byteLength;
    if (count === 63193) {
      expect(expandedBytes).toBeGreaterThan(20 * 1024 * 1024);
      expect(await captureInitialProgressCheckpoint(input)).toBeNull();
    }
    const captured = await captureInitialPackedProgressCheckpoint(input);
    expect(captured).not.toBeNull();
    expect(captured!.checkpoint).not.toContain('test-pass');
    expect(new TextEncoder().encode(captured!.checkpoint).byteLength).toBeLessThanOrEqual(
      20 * 1024 * 1024,
    );
    const packed = await parseStoredScanCheckpoint(captured!.checkpoint);
    if (packed.schemaVersion !== 3) throw new Error('Expectedpacked');
    const { restorePackedScanCheckpoint } = await import('../../src/discovery/scan-checkpoint');
    const runtime = await restorePackedScanCheckpoint(packed, input.review);
    expect(runtime.review).toEqual(input.review);
    expect(runtime.observations).toEqual(input.observations);
    expect(runtime.publishedKeys).toEqual(input.publishedKeys);
  },
  30000,
);

it('packed production capture refuses unsupportedauthority/oversize whole while malformedmetadata fails', async () => {
  const unsupported = await fixture();
  unsupported.providers = [];
  expect(await captureInitialPackedProgressCheckpoint(unsupported)).toBeNull();
  const huge = await fixture(2000);
  for (const c of huge.review.candidates) c.channel.name = 'S'.repeat(16384);
  expect(await captureInitialPackedProgressCheckpoint(huge)).toBeNull();
  const malformed = await fixture();
  malformed.review.candidates[0]!.channel.name = 'S'.repeat(16385);
  await expect(captureInitialPackedProgressCheckpoint(malformed)).rejects.toThrow();
}, 30000);
