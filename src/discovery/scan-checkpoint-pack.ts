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
 * Preparing, checking and restoring packed scan checkpoints (the wire format
 * itself is in scan-checkpoint-packed.ts), and the candidate manifest decoder.
 * Re-exported by scan-checkpoint.ts.
 */
import {
  assertPackedCanonical,
  capturePackedWire,
  decodePackedReference,
  encodePackedReference,
  type PackedScanCheckpoint,
} from './scan-checkpoint-packed';
import {
  captureReacquisition,
  reconstructReferencedJob,
  validateReferencedValue,
} from './scan-checkpoint-referenced';
import { boundedUtf8Text } from '../platform/bounded-text';
import { type ScanReview } from './scan';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
import {
  MAX_REACQUIRED_SCAN_URL_BYTES,
  MAX_SCAN_CHECKPOINT_BYTES,
  ScanReconstructionError,
  array,
  channelTuple,
  digest,
  fail,
  isScanCheckpointSourceResumable,
  object,
  prepareCheckpoint,
  reconstructionRefusal,
  text,
  validateCheckpoint,
  type CheckpointPreparationInput,
  type ReferencedScanCandidate,
  type ReferencedScanCheckpoint,
  type ScanCheckpoint,
} from './scan-checkpoint';

/** Staged v3 only: callers must negotiate native support before emitting this wire format. */
export async function preparePackedScanCheckpoint(
  input: CheckpointPreparationInput,
): Promise<PackedScanCheckpoint> {
  if (
    input.sources.some(
      (source) => source.kind !== 'url' || !isScanCheckpointSourceResumable(source),
    )
  )
    throw new Error('Scan checkpoint reference source is not supported.');
  const runtime = (await prepareCheckpoint(input, false, true, false))!;
  return packValidatedRuntime(runtime);
}

async function packValidatedRuntime(runtime: ScanCheckpoint): Promise<PackedScanCheckpoint> {
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
  const reference: ReferencedScanCheckpoint = {
    ...runtime,
    schemaVersion: 2,
    reviewDigest: '0'.repeat(64),
    review: { ...runtime.review, candidates },
  };
  // All semantic admission happened above; generated tuples need no second expanded copy.
  return encodePackedReference(reference);
}

export async function validatePackedScanCheckpoint(raw: unknown): Promise<PackedScanCheckpoint> {
  return (await admitPackedCheckpoint(capturePackedWire(raw))).packed;
}

export async function admitPackedCheckpoint(
  raw: unknown,
): Promise<{ packed: PackedScanCheckpoint; reference: ReferencedScanCheckpoint }> {
  const decoded = await decodePackedReference(raw);
  const semantic = await validateReferencedValue(decoded.reference, false);
  const packed = assertPackedCanonical(decoded.packed, semantic);
  return { packed, reference: semantic };
}

export async function parsePackedScanCheckpoint(serialized: string): Promise<PackedScanCheckpoint> {
  if (!boundedUtf8Text(serialized, MAX_SCAN_CHECKPOINT_BYTES)) fail();
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    fail();
  }
  return (await admitPackedCheckpoint(value)).packed;
}

export async function expandPackedScanCheckpoint(
  packed: PackedScanCheckpoint,
): Promise<Omit<ReferencedScanCheckpoint, 'schemaVersion'> & { schemaVersion: 3 }> {
  const { reference } = await admitPackedCheckpoint(capturePackedWire(packed));
  return { ...reference, schemaVersion: 3 };
}

export async function restorePackedScanCheckpoint(
  packed: PackedScanCheckpoint,
  fresh: ScanReview,
  signal?: AbortSignal,
): Promise<ScanCheckpoint> {
  let pool: ReturnType<typeof captureReacquisition>;
  try {
    pool = captureReacquisition(fresh, signal);
  } catch (error) {
    reconstructionRefusal(error, 'reacquisition-admission');
  }
  let admitted: Awaited<ReturnType<typeof expandPackedScanCheckpoint>>;
  try {
    admitted = await expandPackedScanCheckpoint(packed);
  } catch (error) {
    reconstructionRefusal(error, 'stored-checkpoint-invalid');
  }
  try {
    return await reconstructReferencedJob(admitted, pool, signal);
  } catch (error) {
    reconstructionRefusal(error, 'reacquisition-admission');
  }
}

/** Private manifest rows carry URLs only; identity always comes from the authenticated checkpoint. */
export interface ScanCandidateManifestEntry {
  candidateIndex: number;
  urls: string[];
}

export const MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES = 1024 * 1024;

/** One admitted immutable checkpoint per worker. Pages are validated in original order only. */
export async function createScanCandidateManifestDecoder(
  packed: PackedScanCheckpoint,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  let admitted: Awaited<ReturnType<typeof expandPackedScanCheckpoint>>;
  try {
    admitted = await expandPackedScanCheckpoint(packed);
  } catch (error) {
    reconstructionRefusal(error, 'stored-checkpoint-invalid');
  }
  let nextIndex = 0,
    urlBytes = 0,
    closed = false,
    active = false;
  const accepted: ScanReview['candidates'] = [];
  return {
    candidateCount: admitted.review.candidates.length,
    jobId: admitted.jobId,
    reviewDigest: admitted.reviewDigest,
    async append(
      entries: readonly ScanCandidateManifestEntry[],
      options: {
        retain?: boolean;
        original?: readonly ScanReview['candidates'][number][];
        identities?: readonly Pick<
          ScanReview['candidates'][number],
          'key' | 'sourceId' | 'sourceFingerprint' | 'sessionRevision'
        >[];
        signal?: AbortSignal;
      } = {},
    ) {
      const owner = options.signal ?? signal;
      owner?.throwIfAborted();
      if (
        closed ||
        active ||
        !Array.isArray(entries) ||
        !entries.length ||
        entries.length > 64 ||
        nextIndex + entries.length > admitted.review.candidates.length ||
        (options.original && options.original.length !== entries.length) ||
        (options.identities && options.identities.length !== entries.length)
      )
        throw new ScanReconstructionError('source-scope-mismatch');
      // No whole-review JSON/string; own only one admitted <=1MiB page before asynchronous hashes.
      boundedJsonUtf8Bytes(entries, MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES, owner);
      const page = structuredClone(entries);
      if (options.original)
        boundedJsonUtf8Bytes(options.original, MAX_SCAN_CHECKPOINT_BYTES, owner);
      const original = options.original ? structuredClone(options.original) : undefined;
      if (options.identities)
        boundedJsonUtf8Bytes(options.identities, MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES, owner);
      const identities = options.identities ? structuredClone(options.identities) : undefined;
      active = true;
      try {
        const candidates: ScanReview['candidates'] = [];
        let addedBytes = 0;
        for (let ordinal = 0; ordinal < page.length; ordinal++) {
          owner?.throwIfAborted();
          const row = object(page[ordinal], ['candidateIndex', 'urls']);
          if (row.candidateIndex !== nextIndex + ordinal)
            throw new ScanReconstructionError('source-scope-mismatch');
          const expected = admitted.review.candidates[nextIndex + ordinal]!;
          const urls = array(row.urls, 16);
          if (!urls.length || urls.length !== expected.reference.urlHashes.length)
            throw new ScanReconstructionError('original-url-missing');
          const captured = original?.[ordinal];
          const capturedIdentity = captured ?? identities?.[ordinal];
          if (
            capturedIdentity &&
            (capturedIdentity.key !== expected.key ||
              capturedIdentity.sourceId !== expected.sourceId ||
              capturedIdentity.sourceFingerprint !== expected.sourceFingerprint ||
              capturedIdentity.sessionRevision !== expected.sessionRevision)
          )
            throw new ScanReconstructionError('source-scope-mismatch');
          for (let i = 0; i < urls.length; i++) {
            const url = urls[i];
            text(url, 16384);
            addedBytes += new TextEncoder().encode(url).byteLength;
            if (urlBytes + addedBytes > MAX_REACQUIRED_SCAN_URL_BYTES)
              throw new ScanReconstructionError('reacquisition-limit');
            if ((await digest(url)) !== expected.reference.urlHashes[i])
              throw new ScanReconstructionError('candidate-digest-mismatch');
            owner?.throwIfAborted();
          }
          const channel = { ...expected.channel, urls: urls as string[] };
          if (
            (await digest(channelTuple(channel))) !== expected.reference.candidateDigest ||
            (captured &&
              (await digest(channelTuple(captured.channel))) !== expected.reference.candidateDigest)
          )
            throw new ScanReconstructionError('candidate-digest-mismatch');
          const { reference: _reference, ...identity } = expected;
          candidates.push({ ...identity, channel });
        }
        owner?.throwIfAborted();
        if (closed) throw new DOMException('Scan manifest closed.', 'AbortError');
        if (options.retain) accepted.push(...candidates);
        urlBytes += addedBytes;
        nextIndex += page.length;
        return { nextIndex, urlBytes };
      } catch (error) {
        closed = true;
        reconstructionRefusal(error, 'reacquisition-admission');
      } finally {
        active = false;
      }
    },
    async finish(): Promise<ScanCheckpoint> {
      signal?.throwIfAborted();
      if (
        closed ||
        active ||
        nextIndex !== admitted.review.candidates.length ||
        accepted.length !== nextIndex
      )
        throw new ScanReconstructionError('original-url-missing');
      closed = true;
      const { schemaVersion: _version, reviewDigest: _digest, ...header } = admitted;
      try {
        const runtime = await validateCheckpoint(
          { ...header, schemaVersion: 1, review: { ...admitted.review, candidates: accepted } },
          () => undefined,
          false,
        );
        signal?.throwIfAborted();
        return runtime;
      } catch (error) {
        reconstructionRefusal(error, 'reconstructed-checkpoint-invalid');
      }
    },
    complete() {
      if (closed || active || nextIndex !== admitted.review.candidates.length)
        throw new ScanReconstructionError('original-url-missing');
    },
    dispose() {
      closed = true;
      accepted.length = 0;
    },
  };
}
