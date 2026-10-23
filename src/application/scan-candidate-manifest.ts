import { invokeOwnedNative, type OwnedNativeRuntime } from '../platform/owned-native-command';
import { validateCommitReceipt, type CommitReceipt } from '../platform/record-transaction';
import {
  checkpointRevision,
  MAX_SCAN_CHECKPOINT_BYTES,
  MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES,
  type ScanCandidateManifestEntry,
} from '../discovery/scan-checkpoint';
import { boundedUtf8Text } from '../platform/bounded-text';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
export type { ScanCandidateManifestEntry };
export interface ManifestCas {
  expectedCatalogRevision: string;
  expectedCheckpointRevision: string;
}
export interface ScanCandidateManifestHeader {
  schemaVersion: 1;
  manifestId: string;
  manifestRevision: string;
  jobId: string;
  reviewDigest: string;
  candidateCount: number;
  nextIndex: number;
}
export interface ScanCandidateManifestPage {
  schemaVersion: 1;
  manifestId: string;
  manifestRevision: string;
  jobId: string;
  reviewDigest: string;
  startIndex: number;
  nextIndex: number;
  entries: ScanCandidateManifestEntry[];
}
export class ScanCandidateManifestError extends Error {
  constructor() {
    super('Saved scan candidates could not be safely stored or read.');
    this.name = 'ScanCandidateManifestError';
  }
}
function fail(): never {
  throw new ScanCandidateManifestError();
}
function record(value: unknown, keys: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Reflect.ownKeys(value).some(
      (k) =>
        typeof k !== 'string' ||
        !keys.includes(k) ||
        !('value' in Object.getOwnPropertyDescriptor(value, k)!),
    )
  )
    fail();
  return value as Record<string, unknown>;
}
function opaque(value: unknown, max = 256): value is string {
  return (
    boundedUtf8Text(value, max) &&
    !/https?:\/\//iu.test(value as string) &&
    ![...(value as string)].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 100000;
function header(raw: unknown): ScanCandidateManifestHeader {
  const v = record(raw, [
    'schemaVersion',
    'manifestId',
    'manifestRevision',
    'jobId',
    'reviewDigest',
    'candidateCount',
    'nextIndex',
  ]);
  if (
    v.schemaVersion !== 1 ||
    !opaque(v.manifestId, 128) ||
    !/^[a-zA-Z0-9_-]{1,128}$/u.test(v.manifestId) ||
    !opaque(v.jobId) ||
    typeof v.reviewDigest !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(v.reviewDigest) ||
    !count(v.candidateCount) ||
    !count(v.nextIndex) ||
    v.nextIndex > v.candidateCount
  )
    fail();
  checkpointRevision(v.manifestRevision);
  return { ...v } as unknown as ScanCandidateManifestHeader;
}
function cas(value: ManifestCas) {
  checkpointRevision(value.expectedCatalogRevision);
  checkpointRevision(value.expectedCheckpointRevision);
  return {
    expectedCatalogRevision: value.expectedCatalogRevision,
    expectedCheckpointRevision: value.expectedCheckpointRevision,
  };
}
export function validateScanCandidateManifestEntries(raw: unknown): ScanCandidateManifestEntry[] {
  if (!Array.isArray(raw) || raw.length > 64) fail();
  boundedJsonUtf8Bytes(raw, MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES);
  return raw.map((row) => {
    const v = record(row, ['candidateIndex', 'urls']);
    if (!count(v.candidateIndex) || !Array.isArray(v.urls) || !v.urls.length || v.urls.length > 16)
      fail();
    const urls = v.urls.map((url) => {
      if (
        !boundedUtf8Text(url, 16384) ||
        [...(url as string)].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      )
        fail();
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        fail();
      }
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password)
        fail();
      return url as string;
    });
    if (new Set(urls).size !== urls.length) fail();
    return { candidateIndex: v.candidateIndex, urls };
  });
}
/** Native commands use the shared cancellation registry and await actual work and cancel replies. */
export function createScanCandidateManifestTransport(runtime: OwnedNativeRuntime) {
  const call = <T>(
    command: string,
    request: unknown,
    signal: AbortSignal,
    validate: (raw: unknown) => T,
    durable = false,
  ) =>
    invokeOwnedNative(runtime, command, { request }, { signal, validate, durable, failure: fail });
  return {
    async capabilities(
      signal: AbortSignal,
    ): Promise<{ schemaVersion: 1; candidateManifest: 0 | 1 }> {
      return invokeOwnedNative(
        runtime,
        'scan_candidate_manifest_capabilities',
        {},
        {
          signal,
          validate(raw) {
            const value = record(raw, ['schemaVersion', 'candidateManifest']);
            if (
              value.schemaVersion !== 1 ||
              (value.candidateManifest !== 0 && value.candidateManifest !== 1)
            )
              fail();
            return { schemaVersion: 1, candidateManifest: value.candidateManifest };
          },
          failure: fail,
        },
      );
    },
    async begin(checkpoint: string, revisions: ManifestCas, signal: AbortSignal) {
      if (!boundedUtf8Text(checkpoint, MAX_SCAN_CHECKPOINT_BYTES)) fail();
      return call(
        'begin_scan_candidate_manifest',
        { schemaVersion: 1, checkpoint, ...cas(revisions) },
        signal,
        (raw) => {
          const value = header(raw);
          if (value.nextIndex !== 0) fail();
          return value;
        },
      );
    },
    async append(
      current: ScanCandidateManifestHeader,
      entries: readonly ScanCandidateManifestEntry[],
      revisions: ManifestCas,
      signal: AbortSignal,
    ) {
      current = header(current);
      const rows = validateScanCandidateManifestEntries(entries);
      if (
        !rows.length ||
        rows.some((r, i) => r.candidateIndex !== current.nextIndex + i) ||
        current.nextIndex + rows.length > current.candidateCount
      )
        fail();
      const request = {
        manifestId: current.manifestId,
        expectedManifestRevision: current.manifestRevision,
        ...cas(revisions),
        entries: rows,
      };
      boundedJsonUtf8Bytes(
        { request, requestId: '00000000-0000-4000-8000-000000000000' },
        MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES,
      );
      return call('append_scan_candidate_manifest_page', request, signal, (raw) => {
        const result = header(raw);
        if (
          result.manifestId !== current.manifestId ||
          result.jobId !== current.jobId ||
          result.reviewDigest !== current.reviewDigest ||
          result.candidateCount !== current.candidateCount ||
          result.nextIndex !== current.nextIndex + rows.length ||
          BigInt(result.manifestRevision) !== BigInt(current.manifestRevision) + 1n
        )
          fail();
        return result;
      });
    },
    async seal(
      current: ScanCandidateManifestHeader,
      revisions: ManifestCas,
      signal: AbortSignal,
    ): Promise<CommitReceipt> {
      current = header(current);
      if (current.nextIndex !== current.candidateCount) fail();
      return call(
        'seal_scan_candidate_manifest',
        {
          manifestId: current.manifestId,
          expectedManifestRevision: current.manifestRevision,
          ...cas(revisions),
        },
        signal,
        (raw) => {
          const receipt = validateCommitReceipt(raw);
          checkpointRevision(receipt.checkpointRevision);
          return receipt;
        },
        true,
      );
    },
    async lookup(
      jobId: string,
      reviewDigest: string,
      revisions: ManifestCas,
      signal: AbortSignal,
    ): Promise<ScanCandidateManifestHeader | null> {
      if (!opaque(jobId) || !/^[a-f0-9]{64}$/u.test(reviewDigest)) fail();
      return call(
        'find_scan_candidate_manifest',
        { jobId, reviewDigest, ...cas(revisions) },
        signal,
        (raw) => {
          const v = record(raw, [
            'schemaVersion',
            'status',
            'manifestId',
            'manifestRevision',
            'jobId',
            'reviewDigest',
            'candidateCount',
            'nextIndex',
          ]);
          if (v.schemaVersion !== 1) fail();
          if (v.status === 'absent') {
            if (Object.keys(v).length !== 2) fail();
            return null;
          }
          if (v.status !== 'sealed') fail();
          const { status: _status, ...fields } = v;
          const value = header(fields);
          if (
            value.nextIndex !== value.candidateCount ||
            value.jobId !== jobId ||
            value.reviewDigest !== reviewDigest
          )
            fail();
          return value;
        },
      );
    },
    async readPage(
      current: ScanCandidateManifestHeader,
      startIndex: number,
      revisions: ManifestCas,
      signal: AbortSignal,
    ): Promise<ScanCandidateManifestPage> {
      current = header(current);
      if (!count(startIndex) || startIndex >= current.candidateCount) fail();
      return call(
        'read_scan_candidate_manifest_page',
        {
          manifestId: current.manifestId,
          jobId: current.jobId,
          reviewDigest: current.reviewDigest,
          startIndex,
          ...cas(revisions),
        },
        signal,
        (raw) => {
          boundedJsonUtf8Bytes(raw, MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES);
          const v = record(raw, [
            'schemaVersion',
            'manifestId',
            'jobId',
            'reviewDigest',
            'manifestRevision',
            'startIndex',
            'nextIndex',
            'entries',
          ]);
          const entries = validateScanCandidateManifestEntries(v.entries);
          if (
            v.schemaVersion !== 1 ||
            v.manifestId !== current.manifestId ||
            v.jobId !== current.jobId ||
            v.reviewDigest !== current.reviewDigest ||
            v.manifestRevision !== current.manifestRevision ||
            v.startIndex !== startIndex ||
            !entries.length ||
            v.nextIndex !== startIndex + entries.length ||
            Number(v.nextIndex) > current.candidateCount ||
            entries.some((r, i) => r.candidateIndex !== startIndex + i)
          )
            fail();
          return { ...v, entries } as unknown as ScanCandidateManifestPage;
        },
      );
    },
  };
}
