import type { Channel, Source } from './parser';
import { MAX_CHANNELS } from './parser';
import type { ReviewCandidate, ScanSource } from '../discovery/scan';
import {
  createHealthObservation,
  type HealthEvidence,
  type HealthObservation,
  type HealthVerdict,
} from '../discovery/health';
import { boundedUtf8Text } from '../platform/bounded-text';

export interface HealthTarget {
  channelId: string;
  sourceId: string;
  checkedUrlOrdinal: number;
  targetFingerprint: string;
}
export interface PersistedHealthRecord extends HealthTarget {
  schemaVersion: 1;
  platform: string;
  observerProfile: string;
  observedAt: number;
  verdict: HealthVerdict;
  evidence: HealthEvidence;
  /** Imported samples are historical evidence, never a new local decoder observation. */
  origin: 'local' | 'imported';
}
export const HEALTH_TTL_MS = Object.freeze({
  reachable: 3_600_000,
  failure: 600_000,
  played: 86_400_000,
});
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, max: number): asserts value is string {
  if (
    !boundedUtf8Text(value, max) ||
    [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('Health metadata is invalid.');
}
function fields(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Health record contains unsupported fields.');
}
function target(value: unknown): HealthTarget {
  if (!object(value)) throw new Error('Health target is invalid.');
  text(value.channelId, 16384);
  text(value.sourceId, 256);
  if (
    !Number.isInteger(value.checkedUrlOrdinal) ||
    (value.checkedUrlOrdinal as number) < 0 ||
    (value.checkedUrlOrdinal as number) > 15 ||
    typeof value.targetFingerprint !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.targetFingerprint)
  )
    throw new Error('Health target identity is invalid.');
  return {
    channelId: value.channelId,
    sourceId: value.sourceId,
    checkedUrlOrdinal: value.checkedUrlOrdinal as number,
    targetFingerprint: value.targetFingerprint,
  };
}
function sample(value: unknown): void {
  if (!object(value)) throw new Error('Health decoder sample is invalid.');
  fields(value, ['mediaTime', 'decodedFrames', 'width', 'height']);
  if (
    typeof value.mediaTime !== 'number' ||
    !Number.isFinite(value.mediaTime) ||
    value.mediaTime < 0 ||
    value.mediaTime > Number.MAX_SAFE_INTEGER ||
    !Number.isSafeInteger(value.decodedFrames) ||
    (value.decodedFrames as number) < 0 ||
    !Number.isInteger(value.width) ||
    (value.width as number) < 1 ||
    (value.width as number) > 32768 ||
    !Number.isInteger(value.height) ||
    (value.height as number) < 1 ||
    (value.height as number) > 32768
  )
    throw new Error('Health decoder sample is invalid.');
}
function evidence(input: unknown): HealthEvidence {
  if (!object(input)) throw new Error('Health evidence is invalid.');
  if (input.kind === 'http') {
    fields(input, ['kind', 'status', 'contentRecognized']);
    if (
      !Number.isInteger(input.status) ||
      (input.status as number) < 100 ||
      (input.status as number) > 599 ||
      (input.contentRecognized !== undefined && typeof input.contentRecognized !== 'boolean')
    )
      throw new Error('Health HTTP evidence is invalid.');
  } else if (input.kind === 'decoded') {
    fields(input, ['kind', 'before', 'after', 'elapsedMilliseconds']);
    sample(input.before);
    sample(input.after);
    if (
      typeof input.elapsedMilliseconds !== 'number' ||
      !Number.isFinite(input.elapsedMilliseconds) ||
      input.elapsedMilliseconds <= 0 ||
      input.elapsedMilliseconds > 120000
    )
      throw new Error('Health decoder interval is invalid.');
  } else {
    fields(input, ['kind']);
    if (
      ![
        'recognized-media-response',
        'timeout',
        'unsupported',
        'canceled',
        'local-network-unavailable',
        'network-failure',
        'not-checked',
        'slow',
        'host-down',
      ].includes(String(input.kind))
    )
      throw new Error('Unsupported health evidence.');
  }
  // Recompute the verdict, rather than trusting a serialized claim or external error body.
  return createHealthObservation(
    { channelId: 'validation', sourceId: 'validation', fingerprint: 'validation' },
    { platform: 'validation', observedAt: 0 },
    input as unknown as HealthEvidence,
  ).evidence;
}
export function validateHealthRecord(input: unknown): PersistedHealthRecord {
  if (!object(input) || input.schemaVersion !== 1)
    throw new Error('Unsupported health record schema.');
  fields(input, [
    'schemaVersion',
    'channelId',
    'sourceId',
    'checkedUrlOrdinal',
    'targetFingerprint',
    'platform',
    'observerProfile',
    'observedAt',
    'verdict',
    'evidence',
    'origin',
  ]);
  const identity = target(input);
  text(input.platform, 256);
  text(input.observerProfile, 256);
  if (
    !Number.isSafeInteger(input.observedAt) ||
    (input.observedAt as number) < 0 ||
    !['local', 'imported'].includes(String(input.origin))
  )
    throw new Error('Health observation metadata is invalid.');
  const admitted = evidence(input.evidence);
  const checked = createHealthObservation(
    { channelId: 'validation', sourceId: 'validation', fingerprint: 'validation' },
    { platform: 'validation', observedAt: 0 },
    admitted,
  );
  if (input.verdict !== checked.verdict)
    throw new Error('Health verdict does not match its evidence.');
  return {
    ...identity,
    schemaVersion: 1,
    platform: input.platform,
    observerProfile: input.observerProfile,
    observedAt: input.observedAt as number,
    verdict: checked.verdict,
    evidence: admitted,
    origin: input.origin as PersistedHealthRecord['origin'],
  };
}
function slot(
  record: Pick<
    PersistedHealthRecord,
    'channelId' | 'checkedUrlOrdinal' | 'platform' | 'observerProfile'
  >,
): string {
  return JSON.stringify([
    record.channelId,
    record.checkedUrlOrdinal,
    record.platform,
    record.observerProfile,
  ]);
}
const targetSlot = (record: HealthTarget) =>
  JSON.stringify([record.channelId, record.checkedUrlOrdinal]);
export function validateHealthRecords(input: unknown): PersistedHealthRecord[] {
  if (!Array.isArray(input) || input.length > 100000)
    throw new Error('Health records exceed the supported bound.');
  const result: PersistedHealthRecord[] = [];
  const seen = new Set<string>();
  let bytes = 2;
  for (const raw of input) {
    const record = validateHealthRecord(raw);
    bytes += new TextEncoder().encode(JSON.stringify(record)).byteLength + 1;
    if (bytes > 20 * 1024 * 1024) throw new Error('Health records exceed the supported bound.');
    const key = slot(record);
    if (seen.has(key)) throw new Error('Duplicate contextual health identity.');
    seen.add(key);
    result.push(record);
  }
  return result;
}
export interface HealthRecordPayload {
  schemaVersion: 1;
  records: PersistedHealthRecord[];
}
export function parseHealthPayload(serialized: string): HealthRecordPayload {
  if (!boundedUtf8Text(serialized, 20 * 1024 * 1024))
    throw new Error('Health payload exceeds its standalone20MiB bound.');
  let input: unknown;
  try {
    input = JSON.parse(serialized);
  } catch {
    throw new Error('Health payload is invalid JSON.');
  }
  if (!object(input) || input.schemaVersion !== 1)
    throw new Error('Unsupported health payload schema.');
  fields(input, ['schemaVersion', 'records']);
  return { schemaVersion: 1, records: validateHealthRecords(input.records) };
}
export function serializeHealthPayload(records: readonly PersistedHealthRecord[]): string {
  const serialized = JSON.stringify({ schemaVersion: 1, records: validateHealthRecords(records) });
  if (!boundedUtf8Text(serialized, 20 * 1024 * 1024))
    throw new Error('Health payload exceeds its standalone20MiB bound.');
  return serialized;
}
/** Exact checked URL, including signed query, and its source permission own the evidence. */
export async function fingerprintHealthTarget(
  source: Source,
  channel: Channel,
  checkedUrlOrdinal: number,
): Promise<string> {
  text(source.id, 256);
  text(source.location, 16384);
  text(channel.id, 16384);
  if (
    source.id !== channel.sourceId ||
    !['url', 'file'].includes(source.kind) ||
    (source.allowHttp !== undefined && typeof source.allowHttp !== 'boolean') ||
    !Number.isInteger(checkedUrlOrdinal) ||
    checkedUrlOrdinal < 0 ||
    checkedUrlOrdinal > 15 ||
    !Array.isArray(channel.urls) ||
    channel.urls.length > 16 ||
    checkedUrlOrdinal >= channel.urls.length
  )
    throw new Error('The checked health target is invalid.');
  const raw = channel.urls[checkedUrlOrdinal];
  text(raw, 16384);
  const url = new URL(raw);
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.protocol === 'http:' && source.allowHttp !== true)
  )
    throw new Error('The checked health URL is not admitted.');
  if (source.kind === 'url') {
    const location = new URL(source.location);
    if (
      !['https:', 'http:'].includes(location.protocol) ||
      location.username ||
      location.password ||
      (location.protocol === 'http:' && source.allowHttp !== true)
    )
      throw new Error('The checked source is not admitted.');
  }
  const tuple = JSON.stringify([
    'health-target-v1',
    source.id,
    source.kind,
    source.location,
    source.allowHttp === true,
    channel.id,
    checkedUrlOrdinal,
    raw,
  ]);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(tuple));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
export function reconcileHealthRecords(
  previous: readonly PersistedHealthRecord[],
  incoming: readonly PersistedHealthRecord[],
  currentTargets: readonly HealthTarget[],
): PersistedHealthRecord[] {
  const old = validateHealthRecords(previous);
  const updates = validateHealthRecords(incoming);
  if (currentTargets.length > 100000) throw new Error('Health target count exceeds bound.');
  const targets = new Map<string, HealthTarget>();
  for (const raw of currentTargets) {
    const value = target(raw);
    const key = targetSlot(value);
    if (targets.has(key)) throw new Error('Duplicate current health target.');
    targets.set(key, value);
  }
  const accepted = (record: PersistedHealthRecord) => {
    const current = targets.get(targetSlot(record));
    return (
      current?.sourceId === record.sourceId &&
      current.targetFingerprint === record.targetFingerprint
    );
  };
  const records = new Map(old.filter(accepted).map((record) => [slot(record), record]));
  for (const record of updates) {
    if (
      !accepted(record) ||
      ['NotChecked', 'Canceled'].includes(record.verdict) ||
      record.evidence.kind === 'local-network-unavailable'
    )
      continue;
    const last = records.get(slot(record));
    if (
      last &&
      (record.observedAt <= last.observedAt ||
        (record.origin === 'imported' && last.origin === 'local'))
    )
      continue;
    records.set(slot(record), record);
  }
  return validateHealthRecords(
    [...records.values()].sort((a, b) => (slot(a) < slot(b) ? -1 : slot(a) > slot(b) ? 1 : 0)),
  );
}
export function healthFreshness(
  record: PersistedHealthRecord,
  context: { now: number; platform: string; observerProfile: string },
): 'current' | 'stale' | 'different-platform' | 'different-profile' {
  const checked = validateHealthRecord(record);
  text(context.platform, 256);
  text(context.observerProfile, 256);
  if (!Number.isSafeInteger(context.now) || context.now < 0)
    throw new Error('Health clock is invalid.');
  if (record.platform !== context.platform) return 'different-platform';
  if (record.observerProfile !== context.observerProfile) return 'different-profile';
  const ttl =
    checked.verdict === 'PlayedHere'
      ? HEALTH_TTL_MS.played
      : checked.verdict === 'Reachable'
        ? HEALTH_TTL_MS.reachable
        : HEALTH_TTL_MS.failure;
  return checked.origin === 'imported' ||
    ['NotChecked', 'Canceled'].includes(checked.verdict) ||
    context.now < checked.observedAt ||
    context.now - checked.observedAt >= ttl
    ? 'stale'
    : 'current';
}
export interface ReviewedHealthMapping {
  candidate: ReviewCandidate;
  channel: Channel;
  source: ScanSource;
  /** Ordinal in the final canonical channel; defaults to candidate primary URL as the probe input. */
  checkedUrlOrdinal: number;
  candidateCheckedUrlOrdinal?: number;
}
export async function remapReviewedHealth(input: {
  mappings: readonly ReviewedHealthMapping[];
  observations: readonly HealthObservation[];
  platform: string;
  observerProfile: string;
  signal?: AbortSignal;
}): Promise<{ records: PersistedHealthRecord[]; ignoredCandidateKeys: string[] }> {
  text(input.platform, 256);
  text(input.observerProfile, 256);
  input.signal?.throwIfAborted();
  if (input.mappings.length > MAX_CHANNELS || input.observations.length > MAX_CHANNELS)
    throw new Error('Reviewed health batch exceeds bound.');
  const captured = structuredClone({
    mappings: input.mappings,
    observations: input.observations,
    platform: input.platform,
    observerProfile: input.observerProfile,
  });
  const mappings = new Map<string, ReviewedHealthMapping>();
  const canonical = new Set<string>();
  for (const mapping of captured.mappings) {
    const { candidate, channel, source } = mapping;
    text(candidate.key, 256);
    text(candidate.sourceFingerprint, 256);
    text(source.fingerprint, 256);
    const candidateOrdinal = mapping.candidateCheckedUrlOrdinal ?? 0;
    if (
      mappings.has(candidate.key) ||
      canonical.has(channel.id) ||
      candidate.sourceId !== source.source.id ||
      candidate.sourceFingerprint !== source.fingerprint ||
      candidate.channel.sourceId !== channel.sourceId ||
      candidate.sourceId !== channel.sourceId ||
      candidate.channel.name !== channel.name ||
      candidate.channel.category !== channel.category ||
      candidate.channel.providerId !== channel.providerId ||
      !Number.isInteger(candidateOrdinal) ||
      candidateOrdinal < 0 ||
      candidateOrdinal > 15 ||
      !Number.isInteger(mapping.checkedUrlOrdinal) ||
      mapping.checkedUrlOrdinal < 0 ||
      mapping.checkedUrlOrdinal > 15 ||
      !candidate.channel.urls[candidateOrdinal] ||
      candidate.channel.urls[candidateOrdinal] !== channel.urls[mapping.checkedUrlOrdinal]
    )
      throw new Error('Reviewed health ownership or canonical mapping changed.');
    mappings.set(candidate.key, mapping);
    canonical.add(channel.id);
  }
  const records: PersistedHealthRecord[] = [];
  const ignoredCandidateKeys: string[] = [];
  const seen = new Set<string>();
  for (const observed of captured.observations) {
    input.signal?.throwIfAborted();
    text(observed.channelId, 256);
    if (seen.has(observed.channelId)) throw new Error('Repeated reviewed health candidate.');
    seen.add(observed.channelId);
    const mapping = mappings.get(observed.channelId);
    if (!mapping) {
      ignoredCandidateKeys.push(observed.channelId);
      continue;
    }
    if (
      observed.sourceId !== mapping.candidate.sourceId ||
      observed.fingerprint !== mapping.candidate.sourceFingerprint ||
      observed.platform !== input.platform
    )
      throw new Error('Reviewed health observation is obsolete.');
    const checked = createHealthObservation(
      { channelId: 'validation', sourceId: 'validation', fingerprint: 'validation' },
      { platform: 'validation', observedAt: 0 },
      evidence(observed.evidence),
    );
    if (observed.verdict !== checked.verdict)
      throw new Error('Reviewed verdict lacks its claimed evidence.');
    records.push(
      validateHealthRecord({
        schemaVersion: 1,
        channelId: mapping.channel.id,
        sourceId: mapping.source.source.id,
        checkedUrlOrdinal: mapping.checkedUrlOrdinal,
        targetFingerprint: await fingerprintHealthTarget(
          mapping.source.source,
          mapping.channel,
          mapping.checkedUrlOrdinal,
        ),
        platform: captured.platform,
        observerProfile: captured.observerProfile,
        observedAt: observed.observedAt,
        verdict: checked.verdict,
        evidence: checked.evidence,
        origin: 'local',
      }),
    );
    input.signal?.throwIfAborted();
  }
  return { records: validateHealthRecords(records), ignoredCandidateKeys };
}
