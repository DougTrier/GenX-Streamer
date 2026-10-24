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
 * Referenced scan checkpoints: the stored form that refers to saved candidates
 * instead of copying them, and rebuilding a scan job from it. Re-exported by
 * scan-checkpoint.ts.
 */
import { type CatalogRecord } from '../catalog/codec';
import { boundedUtf8Text } from '../platform/bounded-text';
import { validateGeographyProvenance, validateGeographyShape } from '../catalog/geography';
import { createHealthObservation } from './health';
import { type ScanReview } from './scan';
import { capturePackedWire } from './scan-checkpoint-packed';
import {
  MAX_REACQUIRED_SCAN_URL_BYTES,
  MAX_SCAN_CHECKPOINT_BYTES,
  SCAN_CHECKPOINT_MAX_AGE_MS,
  ScanReconstructionError,
  admitPackedCheckpoint,
  array,
  channelTuple,
  digest,
  evidence,
  fail,
  hash,
  isScanCheckpointSourceResumable,
  object,
  opaque,
  prepareCheckpoint,
  reconstructionRefusal,
  referenceReviewTuple,
  text,
  validateCheckpoint,
  validateCheckpointPublishedTargets,
  validateScanCheckpoint,
  type CheckpointPreparationInput,
  type PersistedScanCheckpoint,
  type ReferencedScanCandidate,
  type ReferencedScanCheckpoint,
  type ScanCheckpoint,
} from './scan-checkpoint';

/** Reference ACKs bind saved URLs by hashes without persisting or substituting addresses. */
export async function validateStoredCheckpointPublishedTargets(
  checkpoint: PersistedScanCheckpoint,
  catalog: CatalogRecord,
): Promise<void> {
  if (checkpoint.schemaVersion === 1)
    return validateCheckpointPublishedTargets(checkpoint, catalog);
  if (checkpoint.schemaVersion === 3)
    return validateStoredCheckpointPublishedTargets(
      (await admitPackedCheckpoint(checkpoint)).reference,
      catalog,
    );
  const core = (c: { sourceId: string; providerId?: string; name: string; category: string }) =>
    JSON.stringify([c.sourceId, c.providerId ?? null, c.name, c.category]);
  const targets = new Map<string, CatalogRecord['channels']>();
  for (const c of catalog.channels) {
    const list = targets.get(core(c)) ?? [];
    list.push(c);
    targets.set(core(c), list);
  }
  const candidates = new Map(checkpoint.review.candidates.map((c) => [c.key, c]));
  const hashes = new Map<string, Promise<string>>();
  const hash = (url: string) => {
    let value = hashes.get(url);
    if (!value) {
      value = digest(url);
      hashes.set(url, value);
    }
    return value;
  };
  let comparisons = 0;
  for (const key of checkpoint.publishedKeys) {
    const candidate = candidates.get(key)!;
    let matched = false;
    for (const saved of targets.get(core(candidate.channel)) ?? []) {
      if (++comparisons > 1_000_000)
        throw new Error('Scan checkpoint target validation limit exceeded.');
      const urls: string[] = [];
      for (const url of saved.urls) {
        if ((await hash(url)) === candidate.reference.urlHashes[urls.length]) urls.push(url);
      }
      if (urls.length !== candidate.reference.urlHashes.length) continue;
      const channel = { ...candidate.channel, urls };
      if ((await digest(channelTuple(channel))) !== candidate.reference.candidateDigest) continue;
      try {
        validateCheckpointPublishedTargets(
          {
            ...checkpoint,
            schemaVersion: 1,
            review: { ...checkpoint.review, candidates: [{ ...candidate, channel }] },
            publishedKeys: [key],
          },
          { ...catalog, channels: [saved] },
        );
        matched = true;
        break;
      } catch {
        /* Another same-core target may be the exact admitted identity. */
      }
    }
    if (!matched) fail();
  }
}

/** A URL-free reference binds the whole captured identity, never a replacement stream address. */
export async function prepareReferencedScanCheckpoint(
  input: CheckpointPreparationInput,
): Promise<ReferencedScanCheckpoint> {
  if (
    input.sources.some(
      (source) => source.kind !== 'url' || !isScanCheckpointSourceResumable(source),
    )
  )
    throw new Error('Scan checkpoint reference source is not supported.');
  const runtime = (await prepareCheckpoint(input, false, true))!;
  const candidates: ReferencedScanCandidate[] = [];
  for (const candidate of runtime.review.candidates) {
    const { urls, ...channel } = candidate.channel;
    const urlHashes = [];
    for (const url of urls) urlHashes.push(await digest(url));
    candidates.push({
      ...candidate,
      channel,
      reference: { candidateDigest: await digest(channelTuple(candidate.channel)), urlHashes },
    });
  }
  const review = { ...runtime.review, candidates };
  return {
    ...runtime,
    schemaVersion: 2,
    review,
    reviewDigest: await digest(referenceReviewTuple(review)),
  };
}

export async function parseStoredScanCheckpoint(
  serialized: string,
): Promise<PersistedScanCheckpoint> {
  if (!boundedUtf8Text(serialized, MAX_SCAN_CHECKPOINT_BYTES)) fail();
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    fail();
  }
  if ((raw as { schemaVersion?: unknown })?.schemaVersion === 1) return validateScanCheckpoint(raw);
  if ((raw as { schemaVersion?: unknown })?.schemaVersion === 3)
    return (await admitPackedCheckpoint(raw)).packed;
  return validateReferencedScanCheckpoint(raw);
}

export async function validateReferencedScanCheckpoint(
  raw: unknown,
): Promise<ReferencedScanCheckpoint> {
  return validateReferencedValue(raw, true);
}

export async function validateReferencedValue(
  raw: unknown,
  verifyLegacyDigest: boolean,
): Promise<ReferencedScanCheckpoint> {
  const value = object(raw, [
    'schemaVersion',
    'reviewDigest',
    'jobId',
    'createdAtMs',
    'catalogRevision',
    'policyFingerprint',
    'sourceDefinitions',
    'budgetMs',
    'platform',
    'observerProfile',
    'preferredRegion',
    'review',
    'observations',
    'publishedKeys',
  ]);
  if (value.schemaVersion !== 2) fail();
  hash(value.reviewDigest);
  const review = object(value.review, [
    'sessionRevision',
    'query',
    'status',
    'sources',
    'candidates',
    'counts',
  ]);
  const references = new Map<string, ReferencedScanCandidate['reference']>();
  const metadata = array(review.candidates, 100000).map((item) => {
    const candidate = object(item, [
      'key',
      'sourceId',
      'sourceFingerprint',
      'sessionRevision',
      'channel',
      'reference',
    ]);
    opaque(candidate.key);
    opaque(candidate.sourceId);
    opaque(candidate.sourceFingerprint);
    const channel = object(candidate.channel, [
      'sourceId',
      'providerId',
      'name',
      'category',
      'geography',
      'geographyProvenance',
    ]);
    text(channel.sourceId);
    text(channel.name, 16384);
    if (
      !boundedUtf8Text(channel.category, 16384, true) ||
      [...channel.category].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
    )
      fail();
    if (channel.providerId !== undefined) text(channel.providerId, 16384);
    const geography =
      channel.geography === undefined ? undefined : validateGeographyShape(channel.geography);
    if (channel.geographyProvenance !== undefined)
      validateGeographyProvenance(channel.geographyProvenance, geography ?? {}, channel.sourceId);
    const reference = object(candidate.reference, ['candidateDigest', 'urlHashes']);
    hash(reference.candidateDigest);
    const urlHashes = array(reference.urlHashes, 16);
    if (!urlHashes.length) fail();
    for (const urlHash of urlHashes) hash(urlHash);
    if (new Set(urlHashes).size !== urlHashes.length || references.has(candidate.key)) fail();
    references.set(candidate.key, {
      candidateDigest: reference.candidateDigest,
      urlHashes: urlHashes as string[],
    });
    return { candidate, channel };
  });
  // Header/outcome/observation validation is shared with v1. Candidate metadata is
  // validated above; URL-free references are never passed off as playable URLs.
  const base = {
    ...value,
    schemaVersion: 1,
    review: {
      ...review,
      sources: (review.sources as Array<Record<string, unknown>>).map((source) => ({
        ...source,
        matched: 0,
      })),
      counts: { ...(review.counts as Record<string, unknown>), matched: 0 },
      candidates: [],
    },
    observations: [],
    publishedKeys: [],
  };
  delete (base as Record<string, unknown>).reviewDigest;
  const header = await validateCheckpoint(base, () => undefined);
  if (header.sourceDefinitions.some((d) => d.source.kind !== 'url')) fail();
  const fingerprints = new Map(header.review.sources.map((s) => [s.sourceId, s.fingerprint]));
  for (const { candidate, channel } of metadata)
    if (
      candidate.sessionRevision !== header.review.sessionRevision ||
      candidate.sourceId !== channel.sourceId ||
      fingerprints.get(candidate.sourceId as string) !== candidate.sourceFingerprint
    )
      fail();
  const candidates = metadata.map(({ candidate, channel }) => ({
    ...candidate,
    channel,
    reference: references.get(candidate.key as string)!,
  })) as ReferencedScanCandidate[];
  const byKey = new Map(candidates.map((c) => [c.key, c]));
  const seen = new Set<string>();
  const observations = array(value.observations, 100000).map((item) => {
    const observation = object(item, [
      'channelId',
      'sourceId',
      'fingerprint',
      'platform',
      'observedAt',
      'verdict',
      'evidence',
    ]);
    opaque(observation.channelId);
    const candidate = byKey.get(observation.channelId);
    if (
      !candidate ||
      seen.has(observation.channelId) ||
      observation.sourceId !== candidate.sourceId ||
      observation.fingerprint !== candidate.sourceFingerprint ||
      observation.platform !== header.platform
    )
      fail();
    const checked = createHealthObservation(
      {
        channelId: candidate.key,
        sourceId: candidate.sourceId,
        fingerprint: candidate.sourceFingerprint,
      },
      { platform: header.platform, observedAt: observation.observedAt as number },
      evidence(observation.evidence),
    );
    if (
      checked.verdict !== observation.verdict ||
      checked.observedAt < header.createdAtMs ||
      checked.observedAt - header.createdAtMs >= SCAN_CHECKPOINT_MAX_AGE_MS ||
      ['Canceled', 'NotChecked'].includes(checked.verdict)
    )
      fail();
    seen.add(candidate.key);
    return checked;
  });
  const published = new Set<string>();
  const observed = new Map(observations.map((o) => [o.channelId, o]));
  for (const key of array(value.publishedKeys, 100000)) {
    opaque(key);
    if (
      published.has(key) ||
      !['Reachable', 'PlayedHere'].includes(observed.get(key)?.verdict ?? '')
    )
      fail();
    published.add(key);
  }
  const counts = review.counts as ScanReview['counts'];
  if (counts.matched !== candidates.length) fail();
  const sourceCounts = new Map<string, number>();
  for (const candidate of candidates)
    sourceCounts.set(candidate.sourceId, (sourceCounts.get(candidate.sourceId) ?? 0) + 1);
  const sourceResults = review.sources as ScanReview['sources'];
  for (const source of sourceResults)
    if (
      source.matched !== (sourceCounts.get(source.sourceId) ?? 0) ||
      source.matched > source.inspected
    )
      fail();
  const result: ReferencedScanCheckpoint = {
    ...header,
    schemaVersion: 2,
    review: { ...header.review, sources: sourceResults, counts, candidates },
    reviewDigest: value.reviewDigest,
    observations,
    publishedKeys: [...published],
  };
  if (
    verifyLegacyDigest &&
    (await digest(referenceReviewTuple(result.review))) !== result.reviewDigest
  )
    fail();
  return result;
}

/** Snapshot only source identity and exact URL strings; fresh labels/keys never replace saved identity. */
export function captureReacquisition(fresh: ScanReview, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (
    !fresh ||
    fresh.status !== 'completed' ||
    !Array.isArray(fresh.sources) ||
    !Array.isArray(fresh.candidates)
  )
    fail();
  if (fresh.sources.length > 100 || fresh.candidates.length > 100000)
    throw new ScanReconstructionError('reacquisition-limit');
  opaque(fresh.sessionRevision);
  if (!boundedUtf8Text(fresh.query, 256, true)) fail();
  const sources = new Map<string, { fingerprint: string; status: string; urls: Set<string> }>();
  for (const source of fresh.sources) {
    signal?.throwIfAborted();
    opaque(source.sourceId);
    opaque(source.fingerprint);
    if (
      sources.has(source.sourceId) ||
      !['completed', 'failed', 'canceled'].includes(source.status)
    )
      fail();
    sources.set(source.sourceId, {
      fingerprint: source.fingerprint,
      status: source.status,
      urls: new Set(),
    });
  }
  const keys = new Set<string>();
  const encoder = new TextEncoder();
  let urlBytes = 0;
  for (const candidate of fresh.candidates) {
    signal?.throwIfAborted();
    const source = sources.get(candidate.sourceId);
    opaque(candidate.key);
    if (
      !source ||
      candidate.sourceFingerprint !== source.fingerprint ||
      candidate.sessionRevision !== fresh.sessionRevision ||
      candidate.channel.sourceId !== candidate.sourceId
    )
      throw new ScanReconstructionError('source-scope-mismatch');
    if (source.status !== 'completed') throw new ScanReconstructionError('needed-source-failed');
    if (
      keys.has(candidate.key) ||
      !Array.isArray(candidate.channel.urls) ||
      !candidate.channel.urls.length ||
      candidate.channel.urls.length > 16
    )
      fail();
    keys.add(candidate.key);
    const urls = new Set<string>();
    for (const url of candidate.channel.urls) {
      text(url, 16384);
      urlBytes += encoder.encode(url).byteLength;
      if (urlBytes > MAX_REACQUIRED_SCAN_URL_BYTES)
        throw new ScanReconstructionError('reacquisition-limit');
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        fail();
      }
      if (
        !['https:', 'http:'].includes(parsed.protocol) ||
        parsed.username ||
        parsed.password ||
        urls.has(url)
      )
        fail();
      urls.add(url);
      source.urls.add(url);
    }
  }
  return { sessionRevision: fresh.sessionRevision, query: fresh.query, sources };
}

export async function reconstructReferencedJob(
  admitted:
    | ReferencedScanCheckpoint
    | (Omit<ReferencedScanCheckpoint, 'schemaVersion'> & { schemaVersion: 3 }),
  pool: ReturnType<typeof captureReacquisition>,
  signal?: AbortSignal,
): Promise<ScanCheckpoint> {
  signal?.throwIfAborted();
  if (
    pool.sessionRevision !== admitted.review.sessionRevision ||
    (pool.query !== '' && pool.query !== admitted.review.query) ||
    pool.sources.size !== admitted.review.sources.length
  )
    throw new ScanReconstructionError('source-scope-mismatch');
  const expected = new Map<string, Set<string>>();
  for (const source of admitted.review.sources) {
    const fresh = pool.sources.get(source.sourceId);
    if (!fresh || fresh.fingerprint !== source.fingerprint)
      throw new ScanReconstructionError('source-scope-mismatch');
    expected.set(source.sourceId, new Set());
  }
  for (const candidate of admitted.review.candidates) {
    const source = pool.sources.get(candidate.sourceId)!;
    if (source.status !== 'completed') throw new ScanReconstructionError('needed-source-failed');
    for (const hash of candidate.reference.urlHashes) expected.get(candidate.sourceId)!.add(hash);
  }
  const resolved = new Map<string, Map<string, string>>();
  let checked = 0;
  for (const [sourceId, source] of pool.sources) {
    const needed = expected.get(sourceId)!;
    const matches = new Map<string, string>();
    resolved.set(sourceId, matches);
    if (!needed.size) continue;
    for (const url of source.urls) {
      signal?.throwIfAborted();
      const hash = await digest(url);
      signal?.throwIfAborted();
      if (needed.has(hash)) {
        const old = matches.get(hash);
        if (old !== undefined && old !== url)
          throw new ScanReconstructionError('candidate-digest-mismatch');
        matches.set(hash, url);
      }
      if (++checked % 256 === 0) {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        signal?.throwIfAborted();
      }
    }
    source.urls.clear();
    if (matches.size !== needed.size) throw new ScanReconstructionError('original-url-missing');
  }
  const candidates: ScanReview['candidates'] = [];
  for (const candidate of admitted.review.candidates) {
    signal?.throwIfAborted();
    const urls = candidate.reference.urlHashes.map((hash) =>
      resolved.get(candidate.sourceId)!.get(hash)!,
    );
    const channel = { ...candidate.channel, urls };
    if ((await digest(channelTuple(channel))) !== candidate.reference.candidateDigest)
      throw new ScanReconstructionError('candidate-digest-mismatch');
    const { reference: _reference, ...identity } = candidate;
    candidates.push({ ...identity, channel });
  }
  signal?.throwIfAborted();
  const { reviewDigest: _digest, schemaVersion: _version, ...header } = admitted;
  // Validate the original metadata/evidence and exact recovered URLs, not a freshly rebased review.
  let runtime: ScanCheckpoint;
  try {
    runtime = await validateCheckpoint(
      { ...header, schemaVersion: 1, review: { ...admitted.review, candidates } },
      () => undefined,
      admitted.schemaVersion === 2,
    );
  } catch (error) {
    reconstructionRefusal(error, 'reconstructed-checkpoint-invalid');
  }
  signal?.throwIfAborted();
  return runtime;
}

/** Reacquire exact URLs source-locally and reconstruct the immutable original job, never new work. */
export async function restoreReferencedScanCheckpoint(
  reference: ReferencedScanCheckpoint,
  fresh: ScanReview,
  signal?: AbortSignal,
): Promise<ScanCheckpoint> {
  let pool: ReturnType<typeof captureReacquisition>;
  try {
    pool = captureReacquisition(fresh, signal);
  } catch (error) {
    reconstructionRefusal(error, 'reacquisition-admission');
  }
  let admitted: ReferencedScanCheckpoint;
  try {
    admitted = await validateReferencedScanCheckpoint(capturePackedWire(reference));
  } catch (error) {
    reconstructionRefusal(error, 'stored-checkpoint-invalid');
  }
  try {
    return await reconstructReferencedJob(admitted, pool, signal);
  } catch (error) {
    reconstructionRefusal(error, 'reacquisition-admission');
  }
}
