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

import { type PackedScanCheckpoint } from './scan-checkpoint-packed';
export type { PackedScanCheckpoint } from './scan-checkpoint-packed';
import { validateCatalog, validateSource, type CatalogRecord } from '../catalog/codec';
import type { Source } from '../catalog/parser';

import { boundedUtf8Text } from '../platform/bounded-text';
import { createHealthObservation, type HealthObservation, type HealthEvidence } from './health';
import type { ScanReview } from './scan';
import type { PreferredRegion } from '../location/region';
import { validateGeographyShape } from '../catalog/geography';
import type { ReviewedChannelProvider } from './provider-registry';

export {
  preparePackedScanCheckpoint,
  validatePackedScanCheckpoint,
  admitPackedCheckpoint,
  parsePackedScanCheckpoint,
  expandPackedScanCheckpoint,
  restorePackedScanCheckpoint,
  type ScanCandidateManifestEntry,
  MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES,
  createScanCandidateManifestDecoder,
} from './scan-checkpoint-pack';
export {
  validateStoredCheckpointPublishedTargets,
  prepareReferencedScanCheckpoint,
  parseStoredScanCheckpoint,
  validateReferencedScanCheckpoint,
  restoreReferencedScanCheckpoint,
} from './scan-checkpoint-referenced';

/** Reacquisition URL text only; counted per input URL before hashing, with no aggregate string. */
export const MAX_REACQUIRED_SCAN_URL_BYTES = 64 * 1024 * 1024;
const scanReconstructionFailures = [
  'reacquisition-limit',
  'reacquisition-admission',
  'source-scope-mismatch',
  'needed-source-failed',
  'original-url-missing',
  'candidate-digest-mismatch',
  'stored-checkpoint-invalid',
  'reconstructed-checkpoint-invalid',
] as const;
export type ScanReconstructionFailureCode = (typeof scanReconstructionFailures)[number];
export function isScanReconstructionFailureCode(
  raw: unknown,
): raw is ScanReconstructionFailureCode {
  return typeof raw === 'string' && (scanReconstructionFailures as readonly string[]).includes(raw);
}
/** Static failure code only: never source metadata, URLs, identifiers or underlying messages. */
export class ScanReconstructionError extends Error {
  readonly code: ScanReconstructionFailureCode;
  constructor(code: ScanReconstructionFailureCode) {
    super('Saved scan could not safely resume. Rescan may be required.');
    this.name = 'ScanReconstructionError';
    if (!isScanReconstructionFailureCode(code))
      throw new Error('Invalid scan reconstruction failure code.');
    this.code = code;
  }
}
export function scanReconstructionFailureCode(
  error: unknown,
): ScanReconstructionFailureCode | null {
  return error instanceof ScanReconstructionError && isScanReconstructionFailureCode(error.code)
    ? error.code
    : null;
}
export function reconstructionRefusal(
  error: unknown,
  fallback: ScanReconstructionFailureCode,
): never {
  if (error instanceof Error && error.name === 'AbortError') throw error;
  const code = scanReconstructionFailureCode(error);
  throw new ScanReconstructionError(code ?? fallback);
}
export const MAX_SCAN_CHECKPOINT_BYTES = 20 * 1024 * 1024;
export const SCAN_CHECKPOINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export interface ScanCheckpoint {
  schemaVersion: 1;
  jobId: string;
  createdAtMs: number;
  catalogRevision: string;
  policyFingerprint: string;
  sourceDefinitions: { source: Source; definitionFingerprint: string }[];
  budgetMs: 20000 | 45000 | 60000;
  platform: string;
  observerProfile: string;
  preferredRegion?: PreferredRegion;
  review: ScanReview;
  observations: HealthObservation[];
  publishedKeys: string[];
}
export interface ReferencedScanCandidate extends Omit<ScanReview['candidates'][number], 'channel'> {
  channel: Omit<ScanReview['candidates'][number]['channel'], 'urls'>;
  reference: { candidateDigest: string; urlHashes: string[] };
}
export interface ReferencedScanCheckpoint extends Omit<ScanCheckpoint, 'schemaVersion' | 'review'> {
  schemaVersion: 2;
  reviewDigest: string;
  review: Omit<ScanReview, 'candidates'> & { candidates: ReferencedScanCandidate[] };
}
export type LegacyPersistedScanCheckpoint = ScanCheckpoint | ReferencedScanCheckpoint;
export type PersistedScanCheckpoint = LegacyPersistedScanCheckpoint | PackedScanCheckpoint;
export interface ScanCheckpointAdvance {
  kind: 'advance';
  jobId: string;
  reviewDigest: string;
  observations: HealthObservation[];
  publishedKeys: string[];
}
export type ScanCheckpointMutation =
  { kind: 'save'; checkpoint: string } | { kind: 'discard'; jobId: string } | ScanCheckpointAdvance;
export interface SavedScanCheckpoint {
  checkpoint: string | null;
  checkpointStatus: 'valid' | 'invalid' | 'absent';
  jobId: string | null;
  checkpointRevision: string;
  catalogRevision: string;
}
export function fail(): never {
  throw new Error('Scan checkpoint is invalid or cannot safely resume.');
}
export function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw)) ||
    Object.keys(raw).some((key) => !keys.includes(key))
  )
    fail();
  return raw as Record<string, unknown>;
}
export function text(raw: unknown, max = 256): asserts raw is string {
  if (
    !boundedUtf8Text(raw, max) ||
    [...raw].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    fail();
}
export function opaque(raw: unknown): asserts raw is string {
  text(raw);
  if (/https?:\/\//iu.test(raw)) fail();
}
/** Explicit publication-window admission; settled observation limits are unchanged. */
export function validateScanWindowPublishedKeys(raw: unknown): readonly string[] {
  const values = array(raw, 256);
  const keys = values.map((value) => {
    opaque(value);
    return value;
  });
  if (new Set(keys).size !== keys.length) fail();
  return Object.freeze(keys);
}
function integer(raw: unknown, max = Number.MAX_SAFE_INTEGER): asserts raw is number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > max) fail();
}
export function checkpointRevision(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(raw) ||
    BigInt(raw) > 9223372036854775807n
  )
    fail();
  return raw;
}
export function hash(raw: unknown): asserts raw is string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/u.test(raw)) fail();
}
export function array(raw: unknown, max: number): unknown[] {
  if (!Array.isArray(raw) || raw.length > max) fail();
  return raw;
}
function publicUrl(raw: string, source: boolean): void {
  let url: URL, path: string;
  try {
    url = new URL(raw);
    path = decodeURIComponent(url.pathname);
  } catch {
    fail();
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (source && (url.search || url.hash || raw.includes('?') || raw.includes('#'))) ||
    /^\/(live|movie|series)\/[^/]+\/[^/]+(?:\/|$)/iu.test(path) ||
    /(?:^|\/)(get|player_api)\.php$/iu.test(path)
  )
    fail();
}
/** Source locations are persisted data, never a credential/account transport substitute. */
export function isScanCheckpointSourceResumable(source: Source): boolean {
  if (source.kind === 'file') return true;
  try {
    publicUrl(source.location, true);
    return true;
  } catch {
    return false;
  }
}
export async function digest(tuple: unknown): Promise<string> {
  const serialized = JSON.stringify(tuple);
  if (!boundedUtf8Text(serialized, MAX_SCAN_CHECKPOINT_BYTES)) fail();
  return [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
export function channelTuple(channel: ScanReview['candidates'][number]['channel']) {
  return [
    channel.sourceId,
    channel.providerId ?? null,
    channel.name,
    channel.category,
    channel.urls,
    channel.geography
      ? [
          channel.geography.country ?? null,
          channel.geography.region ?? null,
          channel.geography.state ?? null,
        ]
      : null,
    channel.geographyProvenance?.map((p) => [
      p.field,
      p.value,
      p.sourceId,
      p.providerId ?? null,
      p.kind,
      p.scope,
    ]) ?? null,
  ];
}
export function referenceReviewTuple(review: ReferencedScanCheckpoint['review']) {
  return [
    review.sessionRevision,
    review.query,
    review.status,
    review.sources.map((s) => [
      s.sourceId,
      s.fingerprint,
      s.status,
      s.inspected,
      s.matched,
      s.warnings,
    ]),
    [
      review.counts.inspected,
      review.counts.matched,
      review.counts.failedSources,
      review.counts.canceledSources,
    ],
    review.candidates.map((c) => [
      c.key,
      c.sourceId,
      c.sourceFingerprint,
      c.sessionRevision,
      channelTuple({ ...c.channel, urls: [] }),
      c.reference.candidateDigest,
      c.reference.urlHashes,
    ]),
  ];
}
export function fingerprintScanSource(source: Source): Promise<string> {
  const s = validateSource(source);
  return digest([
    s.id,
    s.name,
    s.kind,
    s.location,
    s.allowHttp === true,
    s.contentKind ?? null,
    s.mediaMime ?? null,
  ]);
}
export function fingerprintScanPolicy(input: {
  providers: readonly ReviewedChannelProvider[] | null;
  preferredRegion?: PreferredRegion;
  budgetMs: number;
  platform: string;
  observerProfile: string;
  sourceDefinitions: readonly { definitionFingerprint: string }[];
}): Promise<string> {
  const region = input.preferredRegion;
  return digest([
    input.providers?.map((provider) => [
      provider.id,
      provider.name,
      provider.location,
      provider.provenance,
      provider.allowHttp === true,
    ]) ?? null,
    region ? [region.country, region.state ?? null, region.postal ?? null, region.origin] : null,
    input.budgetMs,
    input.platform,
    input.observerProfile,
    input.sourceDefinitions.map((definition) => definition.definitionFingerprint),
  ]);
}
function region(raw: unknown): PreferredRegion {
  const value = object(raw, ['country', 'state', 'postal', 'origin']);
  const geo = validateGeographyShape({
    country: value.country,
    ...(value.state === undefined ? {} : { state: value.state }),
  });
  if (!geo.country || !['manual', 'ip'].includes(String(value.origin))) fail();
  if (value.postal !== undefined) text(value.postal, 32);
  return {
    country: geo.country,
    ...(geo.state ? { state: geo.state } : {}),
    ...(value.postal === undefined ? {} : { postal: value.postal as string }),
    origin: value.origin as 'manual' | 'ip',
  };
}
export function evidence(raw: unknown): HealthEvidence {
  const fields: Record<string, readonly string[]> = {
    http: ['kind', 'status', 'contentRecognized'],
    decoded: ['kind', 'before', 'after', 'elapsedMilliseconds'],
    'recognized-media-response': ['kind'],
    timeout: ['kind'],
    unsupported: ['kind'],
    canceled: ['kind'],
    'local-network-unavailable': ['kind'],
    'network-failure': ['kind'],
    'not-checked': ['kind'],
    slow: ['kind'],
    'host-down': ['kind'],
  };
  const candidate = object(raw, Object.values(fields).flat());
  if (typeof candidate.kind !== 'string' || !fields[candidate.kind]) fail();
  object(raw, fields[candidate.kind]);
  if (
    candidate.kind === 'http' &&
    candidate.contentRecognized !== undefined &&
    typeof candidate.contentRecognized !== 'boolean'
  )
    fail();
  if (candidate.kind === 'decoded')
    for (const sample of [candidate.before, candidate.after])
      object(sample, ['mediaTime', 'decodedFrames', 'width', 'height']);
  return candidate as unknown as HealthEvidence;
}
export async function validateScanCheckpoint(raw: unknown): Promise<ScanCheckpoint> {
  return validateCheckpoint(raw, (url) => publicUrl(url, false));
}
export async function validateCheckpoint(
  raw: unknown,
  candidateUrl: (url: string) => void,
  enforceWireBound = true,
): Promise<ScanCheckpoint> {
  const value = object(raw, [
    'schemaVersion',
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
  if (value.schemaVersion !== 1 || ![20000, 45000, 60000].includes(value.budgetMs as number))
    fail();
  opaque(value.jobId);
  integer(value.createdAtMs);
  const createdAtMs = value.createdAtMs;
  checkpointRevision(value.catalogRevision);
  hash(value.policyFingerprint);
  opaque(value.platform);
  opaque(value.observerProfile);
  const sources = new Map<string, Source>();
  const definitions = [];
  for (const rawDefinition of array(value.sourceDefinitions, 100)) {
    const definition = object(rawDefinition, ['source', 'definitionFingerprint']);
    object(definition.source, [
      'id',
      'name',
      'location',
      'kind',
      'allowHttp',
      'contentKind',
      'mediaMime',
    ]);
    const source = validateSource(definition.source);
    if (source.kind === 'url') publicUrl(source.location, true);
    if (sources.has(source.id)) fail();
    hash(definition.definitionFingerprint);
    if ((await fingerprintScanSource(source)) !== definition.definitionFingerprint) fail();
    sources.set(source.id, source);
    definitions.push({ source, definitionFingerprint: definition.definitionFingerprint });
  }
  const review = object(value.review, [
    'sessionRevision',
    'query',
    'status',
    'sources',
    'candidates',
    'counts',
  ]);
  opaque(review.sessionRevision);
  if (!boundedUtf8Text(review.query, 256, true) || review.status !== 'completed') fail();
  const fingerprints = new Map<string, string>();
  const sourceResults = array(review.sources, 100).map((rawSource) => {
    const result = object(rawSource, [
      'sourceId',
      'fingerprint',
      'status',
      'inspected',
      'matched',
      'warnings',
    ]);
    opaque(result.sourceId);
    opaque(result.fingerprint);
    if (
      !sources.has(result.sourceId) ||
      fingerprints.has(result.sourceId) ||
      !['completed', 'failed', 'canceled'].includes(String(result.status))
    )
      fail();
    for (const key of ['inspected', 'matched', 'warnings']) integer(result[key], 100000);
    fingerprints.set(result.sourceId, result.fingerprint);
    return result;
  });
  if (fingerprints.size !== sources.size) fail();
  const rawCandidates = array(review.candidates, 100000);
  const keys = new Set<string>();
  const canonical = validateCatalog({
    schemaVersion: 1,
    sources: [...sources.values()].map((source) => ({ ...source, allowHttp: true })),
    channels: rawCandidates.map((rawCandidate) => {
      const candidate = object(rawCandidate, [
        'key',
        'sourceId',
        'sourceFingerprint',
        'sessionRevision',
        'channel',
      ]);
      opaque(candidate.key);
      opaque(candidate.sourceId);
      opaque(candidate.sourceFingerprint);
      const channel = object(candidate.channel, [
        'sourceId',
        'providerId',
        'name',
        'category',
        'urls',
        'geography',
        'geographyProvenance',
      ]);
      if (
        keys.has(candidate.key) ||
        candidate.sessionRevision !== review.sessionRevision ||
        channel.sourceId !== candidate.sourceId ||
        fingerprints.get(candidate.sourceId as string) !== candidate.sourceFingerprint
      )
        fail();
      keys.add(candidate.key);
      for (const url of array(channel.urls, 16)) {
        text(url, 16384);
        candidateUrl(url);
      }
      return { ...channel, id: candidate.key };
    }),
  });
  const candidates = rawCandidates.map((rawCandidate, index) => {
    const { id: key, ...channel } = canonical.channels[index];
    const candidate = rawCandidate as Record<string, unknown>;
    return {
      key,
      sourceId: channel.sourceId,
      sourceFingerprint: candidate.sourceFingerprint as string,
      sessionRevision: review.sessionRevision as string,
      channel,
    };
  });
  const byKey = new Map(candidates.map((candidate) => [candidate.key, candidate]));
  const observed = new Set<string>();
  const observations = array(value.observations, 100000).map((rawObservation) => {
    const item = object(rawObservation, [
      'channelId',
      'sourceId',
      'fingerprint',
      'platform',
      'observedAt',
      'verdict',
      'evidence',
    ]);
    opaque(item.channelId);
    const candidate = byKey.get(item.channelId);
    if (
      !candidate ||
      observed.has(item.channelId) ||
      item.sourceId !== candidate.sourceId ||
      item.fingerprint !== candidate.sourceFingerprint ||
      item.platform !== value.platform
    )
      fail();
    const result = createHealthObservation(
      {
        channelId: candidate.key,
        sourceId: candidate.sourceId,
        fingerprint: candidate.sourceFingerprint,
      },
      { platform: value.platform as string, observedAt: item.observedAt as number },
      evidence(item.evidence),
    );
    if (
      result.observedAt < createdAtMs ||
      result.observedAt - createdAtMs >= SCAN_CHECKPOINT_MAX_AGE_MS
    )
      fail();
    if (result.verdict !== item.verdict || ['Canceled', 'NotChecked'].includes(result.verdict))
      fail();
    observed.add(item.channelId);
    return result;
  });
  const published = new Set<string>();
  const eligible = new Set(
    observations
      .filter((item) => ['Reachable', 'PlayedHere'].includes(item.verdict))
      .map((item) => item.channelId),
  );
  const publishedKeys = array(value.publishedKeys, 100000).map((key) => {
    opaque(key);
    if (published.has(key) || !eligible.has(key)) fail();
    published.add(key);
    return key;
  });
  const counts = object(review.counts, [
    'inspected',
    'matched',
    'failedSources',
    'canceledSources',
  ]);
  for (const key of ['inspected', 'matched', 'failedSources', 'canceledSources'])
    integer(counts[key], 100000);
  if (
    counts.matched !== candidates.length ||
    counts.inspected !== sourceResults.reduce((sum, item) => sum + (item.inspected as number), 0) ||
    counts.failedSources !== sourceResults.filter((item) => item.status === 'failed').length ||
    counts.canceledSources !== sourceResults.filter((item) => item.status === 'canceled').length
  )
    fail();
  const candidateCounts = new Map<string, number>();
  for (const candidate of candidates)
    candidateCounts.set(candidate.sourceId, (candidateCounts.get(candidate.sourceId) ?? 0) + 1);
  for (const result of sourceResults)
    if (
      result.matched !== (candidateCounts.get(result.sourceId as string) ?? 0) ||
      (result.matched as number) > (result.inspected as number)
    )
      fail();
  const checkpoint = {
    ...value,
    sourceDefinitions: definitions,
    review: { ...review, sources: sourceResults, candidates, counts },
    observations,
    publishedKeys,
    ...(value.preferredRegion === undefined
      ? {}
      : { preferredRegion: region(value.preferredRegion) }),
  } as unknown as ScanCheckpoint;
  if (enforceWireBound && !boundedUtf8Text(JSON.stringify(checkpoint), MAX_SCAN_CHECKPOINT_BYTES))
    fail();
  return checkpoint;
}
export async function parseScanCheckpoint(serialized: string): Promise<ScanCheckpoint> {
  if (!boundedUtf8Text(serialized, MAX_SCAN_CHECKPOINT_BYTES)) fail();
  let raw: unknown;
  try {
    raw = JSON.parse(serialized);
  } catch {
    fail();
  }
  return validateScanCheckpoint(raw);
}
export async function serializeScanCheckpoint(checkpoint: ScanCheckpoint): Promise<string> {
  return JSON.stringify(await validateScanCheckpoint(checkpoint));
}
/** Expired or changed scope requires an explicit Rescan, never an automatic source acquisition. */
export function canResumeScanCheckpoint(
  checkpoint: PersistedScanCheckpoint,
  nowMs: number,
  catalogRevision: string,
  policyFingerprint: string,
): boolean {
  return (
    Number.isSafeInteger(nowMs) &&
    nowMs >= checkpoint.createdAtMs &&
    nowMs - checkpoint.createdAtMs < SCAN_CHECKPOINT_MAX_AGE_MS &&
    checkpoint.catalogRevision === catalogRevision &&
    checkpoint.policyFingerprint === policyFingerprint
  );
}

/** Authoritative saved-source/configuration admission, separate from structural decoding. */
export async function validateCheckpointSourceAdmission(
  checkpoint: Pick<ScanCheckpoint, 'sourceDefinitions'>,
  canonicalSources: readonly Source[],
  providers: readonly ReviewedChannelProvider[] | null,
): Promise<void> {
  if (canonicalSources.length > 100 || checkpoint.sourceDefinitions.length > 100) fail();
  const canonical = new Map<string, string>();
  for (const raw of canonicalSources) {
    const source = validateSource(raw);
    if (canonical.has(source.id)) fail();
    canonical.set(source.id, await fingerprintScanSource(source));
  }
  for (const definition of checkpoint.sourceDefinitions) {
    const source = validateSource(definition.source);
    if (!isScanCheckpointSourceResumable(source)) fail();
    const actual = await fingerprintScanSource(source);
    if (actual !== definition.definitionFingerprint) fail();
    const saved = canonical.get(source.id);
    if (saved !== undefined) {
      if (saved !== actual) fail();
      continue;
    }
    const matches = (provider: ReviewedChannelProvider) =>
      provider.location === source.location &&
      (provider.allowHttp === true) === (source.allowHttp === true);
    if (source.kind !== 'url' || providers === null || !providers.some(matches)) fail();
  }
}

/** An ACK key may represent an existing channel with retained alternate URLs or geography. */
export function validateCheckpointPublishedTargets(
  checkpoint: ScanCheckpoint,
  catalog: CatalogRecord,
): void {
  const targetKey = (
    channel:
      CatalogRecord['channels'][number] | ScanCheckpoint['review']['candidates'][number]['channel'],
  ) =>
    JSON.stringify([channel.sourceId, channel.providerId ?? null, channel.name, channel.category]);
  const targets = new Map<string, CatalogRecord['channels']>();
  for (const channel of catalog.channels) {
    const key = targetKey(channel),
      list = targets.get(key) ?? [];
    list.push(channel);
    targets.set(key, list);
  }
  const byKey = new Map(
    checkpoint.review.candidates.map((candidate) => [candidate.key, candidate]),
  );
  let comparisons = 0;
  for (const key of checkpoint.publishedKeys) {
    const candidate = byKey.get(key)!.channel;
    if (
      !(targets.get(targetKey(candidate)) ?? []).some((saved) => {
        // Match the native whole-validation budget, including repeated ACK identities.
        if (++comparisons > 1_000_000)
          throw new Error('Scan checkpoint target validation limit exceeded.');
        let ordinal = 0;
        for (const url of saved.urls) if (url === candidate.urls[ordinal]) ordinal++;
        return (
          ordinal === candidate.urls.length &&
          (candidate.geographyProvenance === undefined ||
            JSON.stringify(
              candidate.geographyProvenance.map(
                ({ field, value, sourceId, providerId, kind, scope }) => [
                  field,
                  value,
                  sourceId,
                  providerId ?? null,
                  kind,
                  scope,
                ],
              ),
            ) ===
              JSON.stringify(
                saved.geographyProvenance?.map(
                  ({ field, value, sourceId, providerId, kind, scope }) => [
                    field,
                    value,
                    sourceId,
                    providerId ?? null,
                    kind,
                    scope,
                  ],
                ),
              )) &&
          Object.entries(candidate.geography ?? {}).every(
            ([field, value]) => saved.geography?.[field as keyof typeof saved.geography] === value,
          )
        );
      })
    )
      fail();
  }
}

/** Canonical strict progress evidence; source/review membership belongs to the stored job owner. */
export function validateCheckpointProgressObservation(raw: unknown): HealthObservation {
  const item = object(raw, [
    'channelId',
    'sourceId',
    'fingerprint',
    'platform',
    'observedAt',
    'verdict',
    'evidence',
  ]);
  for (const key of ['channelId', 'sourceId', 'fingerprint', 'platform']) opaque(item[key]);
  const observation = createHealthObservation(
    {
      channelId: item.channelId as string,
      sourceId: item.sourceId as string,
      fingerprint: item.fingerprint as string,
    },
    { platform: item.platform as string, observedAt: item.observedAt as number },
    evidence(item.evidence),
  );
  if (
    observation.verdict !== item.verdict ||
    ['Canceled', 'NotChecked'].includes(observation.verdict)
  )
    fail();
  return observation;
}
export function validateScanCheckpointMutation(raw: unknown): ScanCheckpointMutation {
  const value = object(raw, [
    'kind',
    'checkpoint',
    'jobId',
    'reviewDigest',
    'observations',
    'publishedKeys',
  ]);
  if (value.kind === 'save') {
    if (
      Object.keys(value).some((k) => !['kind', 'checkpoint'].includes(k)) ||
      !boundedUtf8Text(value.checkpoint, MAX_SCAN_CHECKPOINT_BYTES)
    )
      fail();
    return { kind: 'save', checkpoint: value.checkpoint };
  }
  if (value.kind === 'discard') {
    if (Object.keys(value).some((k) => !['kind', 'jobId'].includes(k))) fail();
    opaque(value.jobId);
    return { kind: 'discard', jobId: value.jobId };
  }
  if (value.kind === 'advance') {
    if (
      value.checkpoint !== undefined ||
      !boundedUtf8Text(value.jobId, 128) ||
      typeof value.reviewDigest !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(value.reviewDigest)
    )
      fail();
    opaque(value.jobId);
    if (!boundedUtf8Text(JSON.stringify(value), MAX_SCAN_CHECKPOINT_BYTES)) fail();
    const observations = array(value.observations, 100000).map(
        validateCheckpointProgressObservation,
      ),
      seen = new Set<string>();
    for (const item of observations) {
      if (seen.has(item.channelId)) fail();
      seen.add(item.channelId);
    }
    const publishedKeys = array(value.publishedKeys, 100000).map((key) => {
      opaque(key);
      return key;
    });
    if (new Set(publishedKeys).size !== publishedKeys.length) fail();
    return {
      kind: 'advance',
      jobId: value.jobId,
      reviewDigest: value.reviewDigest,
      observations,
      publishedKeys,
    };
  }
  return fail();
}

/** Preparation belongs off the UI thread; diagnostic strings never enter durable operational state. */
export type CheckpointPreparationInput = Omit<
  ScanCheckpoint,
  'schemaVersion' | 'sourceDefinitions' | 'policyFingerprint'
> & {
  sources: readonly Source[];
  providers: readonly ReviewedChannelProvider[] | null;
  canonicalSources?: readonly Source[];
};
export async function prepareScanCheckpoint(
  input: CheckpointPreparationInput,
): Promise<ScanCheckpoint> {
  const checkpoint = await prepareCheckpoint(input, false);
  if (!checkpoint) fail();
  return checkpoint;
}
/** Refuse the whole persisted job, while still validating every identity and observation. */
export function prepareSupportedScanCheckpoint(
  input: CheckpointPreparationInput,
): Promise<ScanCheckpoint | null> {
  return prepareCheckpoint(input, true);
}
export async function prepareCheckpoint(
  input: CheckpointPreparationInput,
  refuseExcludedUrls: boolean,
  runtimeOnly = false,
  enforceRuntimeWireBound = true,
): Promise<ScanCheckpoint | null> {
  const { sources, providers, canonicalSources: _canonicalSources, ...state } = input;
  if (sources.length > 100) fail();
  const sourceDefinitions = [];
  for (const source of sources)
    sourceDefinitions.push({
      source: structuredClone(source),
      definitionFingerprint: await fingerprintScanSource(source),
    });
  const review = {
    ...state.review,
    sources: state.review.sources.map((result) => ({
      sourceId: result.sourceId,
      fingerprint: result.fingerprint,
      status: result.status,
      inspected: result.inspected,
      matched: result.matched,
      warnings: result.warnings,
    })),
  };
  const checkpoint: ScanCheckpoint = {
    ...state,
    review,
    schemaVersion: 1,
    sourceDefinitions,
    policyFingerprint: await fingerprintScanPolicy({
      providers,
      preferredRegion: state.preferredRegion,
      budgetMs: state.budgetMs,
      platform: state.platform,
      observerProfile: state.observerProfile,
      sourceDefinitions,
    }),
  };
  if (runtimeOnly) return validateCheckpoint(checkpoint, () => undefined, enforceRuntimeWireBound);
  if (!refuseExcludedUrls) return validateScanCheckpoint(checkpoint);
  let excluded = false;
  const validated = await validateCheckpoint(checkpoint, (url) => {
    try {
      publicUrl(url, false);
    } catch {
      excluded = true;
    }
  });
  return excluded ? null : validated;
}
