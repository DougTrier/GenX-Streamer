import {
  encodePackedReference,
  decodePackedReference,
  assertPackedCanonical,
  capturePackedWire,
  type PackedScanCheckpoint,
} from './scan-checkpoint-packed';
export type { PackedScanCheckpoint } from './scan-checkpoint-packed';
import { validateCatalog, validateSource, type CatalogRecord } from '../catalog/codec';
import type { Source } from '../catalog/parser';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
import { boundedUtf8Text } from '../platform/bounded-text';
import { createHealthObservation, type HealthObservation, type HealthEvidence } from './health';
import type { ScanReview } from './scan';
import type { PreferredRegion } from '../location/region';
import { validateGeographyShape, validateGeographyProvenance } from '../catalog/geography';
import type { ReviewedChannelProvider } from './provider-registry';

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
function reconstructionRefusal(error: unknown, fallback: ScanReconstructionFailureCode): never {
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
function fail(): never {
  throw new Error('Scan checkpoint is invalid or cannot safely resume.');
}
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
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
function text(raw: unknown, max = 256): asserts raw is string {
  if (
    !boundedUtf8Text(raw, max) ||
    [...raw].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    fail();
}
function opaque(raw: unknown): asserts raw is string {
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
function hash(raw: unknown): asserts raw is string {
  if (typeof raw !== 'string' || !/^[a-f0-9]{64}$/u.test(raw)) fail();
}
function array(raw: unknown, max: number): unknown[] {
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
async function digest(tuple: unknown): Promise<string> {
  const serialized = JSON.stringify(tuple);
  if (!boundedUtf8Text(serialized, MAX_SCAN_CHECKPOINT_BYTES)) fail();
  return [
    ...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized))),
  ]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
function channelTuple(channel: ScanReview['candidates'][number]['channel']) {
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
function referenceReviewTuple(review: ReferencedScanCheckpoint['review']) {
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
function evidence(raw: unknown): HealthEvidence {
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
async function validateCheckpoint(
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
type CheckpointPreparationInput = Omit<
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
async function prepareCheckpoint(
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
async function validateReferencedValue(
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
function captureReacquisition(fresh: ScanReview, signal?: AbortSignal) {
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
async function reconstructReferencedJob(
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
async function admitPackedCheckpoint(
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
