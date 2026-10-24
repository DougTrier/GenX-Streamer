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
 * Checking bounded scan resume plans and candidate pages from native code.
 * Re-exported by bounded-scan-resume.ts.
 */
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
import { createHealthObservation, type HealthObservation } from '../discovery/health';
import {
  scanResumeCommitWindow,
  validateScanResumeCommitWindow,
  validateScanResumeTakeTiming,
  type BoundedScanCandidatePage,
  type BoundedScanCandidateRow,
  type BoundedScanCounts,
  type BoundedScanResumePlan,
  type BoundedScanRevisions,
} from './bounded-scan-resume';

export const refusal = () => new Error('Bounded scan resume admission failed.');

const integer = (v: unknown, max = 100000): v is number =>
  Number.isSafeInteger(v) && Number(v) >= 0 && Number(v) <= max;

const opaque = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.trim().length > 0 &&
  v.length <= 256 &&
  !Array.from(v).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127) &&
  !/https?:\/\//iu.test(v);

export function fields(
  v: unknown,
  required: string[],
  optional: string[] = [],
): asserts v is Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).some(
      (k) => typeof k !== 'string' || ![...required, ...optional].includes(k),
    ) ||
    required.some((k) => !Object.hasOwn(v, k)) ||
    Object.values(Object.getOwnPropertyDescriptors(v)).some((d) => !('value' in d))
  )
    throw refusal();
}

export function revisions(v: unknown): asserts v is BoundedScanRevisions {
  fields(v, ['catalogRevision', 'healthRevision', 'checkpointRevision']);
  if (
    Object.values(v).some(
      (x) =>
        typeof x !== 'string' ||
        !/^(0|[1-9][0-9]{0,18})$/.test(x) ||
        BigInt(x) > 9223372036854775807n,
    )
  )
    throw refusal();
}

export function counts(v: unknown): asserts v is BoundedScanCounts {
  fields(v, ['total', 'checked', 'responded', 'published']);
  if (
    !Object.values(v).every((x) => integer(x)) ||
    Number(v.published) > Number(v.responded) ||
    Number(v.responded) > Number(v.checked) ||
    Number(v.checked) > Number(v.total)
  )
    throw refusal();
}

export function freeze<T>(v: T): T {
  if (v && typeof v === 'object') {
    for (const x of Object.values(v)) freeze(x);
    Object.freeze(v);
  }
  return v;
}

export function validateBoundedScanResumePlan(raw: unknown): BoundedScanResumePlan {
  fields(
    raw,
    [
      'schemaVersion',
      'planId',
      'jobId',
      'reviewDigest',
      'sessionRevision',
      'query',
      'createdAtMs',
      'platform',
      'observerProfile',
      'budgetMs',
      'sourcePolicies',
      'counts',
      'revisions',
    ],
    ['commitWindow', 'takeTiming'],
  );
  if (
    raw.schemaVersion !== 1 ||
    ![raw.planId, raw.jobId, raw.sessionRevision, raw.platform, raw.observerProfile].every(
      opaque,
    ) ||
    typeof raw.reviewDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(raw.reviewDigest) ||
    typeof raw.query !== 'string' ||
    raw.query.length > 256 ||
    !integer(raw.createdAtMs, 8640000000000000) ||
    ![20000, 45000, 60000].includes(Number(raw.budgetMs)) ||
    !Array.isArray(raw.sourcePolicies) ||
    raw.sourcePolicies.length > 100
  )
    throw refusal();
  counts(raw.counts);
  revisions(raw.revisions);
  if (raw.commitWindow !== undefined) validateScanResumeCommitWindow(raw.commitWindow);
  if (raw.takeTiming !== undefined) {
    if (!raw.commitWindow) throw refusal();
    validateScanResumeTakeTiming(raw.takeTiming);
  }
  const ids = new Set();
  for (const s of raw.sourcePolicies) {
    fields(s, ['sourceId', 'fingerprint', 'allowHttp']);
    if (
      !opaque(s.sourceId) ||
      !opaque(s.fingerprint) ||
      typeof s.allowHttp !== 'boolean' ||
      ids.has(s.sourceId)
    )
      throw refusal();
    ids.add(s.sourceId);
  }
  boundedJsonUtf8Bytes(raw, 1024 * 1024);
  return freeze(structuredClone(raw) as unknown as BoundedScanResumePlan);
}

export function trusted(
  raw: unknown,
  row: BoundedScanCandidateRow,
  plan: BoundedScanResumePlan,
): HealthObservation {
  fields(raw, [
    'channelId',
    'sourceId',
    'fingerprint',
    'platform',
    'observedAt',
    'verdict',
    'evidence',
  ]);
  if (
    raw.channelId !== row.candidate.key ||
    raw.sourceId !== row.candidate.sourceId ||
    raw.fingerprint !== row.candidate.sourceFingerprint ||
    raw.platform !== plan.platform ||
    typeof raw.observedAt !== 'number'
  )
    throw refusal();
  const evidence = raw.evidence as HealthObservation['evidence'];
  if (
    !evidence ||
    ![
      'http',
      'recognized-media-response',
      'decoded',
      'timeout',
      'unsupported',
      'canceled',
      'local-network-unavailable',
      'network-failure',
      'not-checked',
      // October 21, 2026: the 3-second triage and host-aware judging.
      'slow',
      'host-down',
    ].includes(evidence.kind)
  )
    throw refusal();
  const evidenceFields: Record<string, [string[], string[]]> = {
    http: [['kind', 'status'], ['contentRecognized']],
    decoded: [['kind', 'before', 'after', 'elapsedMilliseconds'], []],
  };
  const layout = evidenceFields[evidence.kind] ?? [['kind'], []];
  fields(evidence, layout[0], layout[1]);
  if (evidence.kind === 'decoded') {
    fields(evidence.before, ['mediaTime', 'decodedFrames', 'width', 'height']);
    fields(evidence.after, ['mediaTime', 'decodedFrames', 'width', 'height']);
  }
  if (
    evidence.kind === 'http' &&
    evidence.contentRecognized !== undefined &&
    typeof evidence.contentRecognized !== 'boolean'
  )
    throw refusal();
  const checked = createHealthObservation(
    {
      channelId: row.candidate.key,
      sourceId: row.candidate.sourceId,
      fingerprint: row.candidate.sourceFingerprint,
    },
    { platform: plan.platform, observedAt: Number(raw.observedAt) },
    evidence,
  );
  if (checked.verdict !== raw.verdict) throw refusal();
  // Validation may reclassify, but the committed echo must remain byte-value exact.
  return freeze(structuredClone(raw) as unknown as HealthObservation);
}

export function validateBoundedScanCandidatePage(
  raw: unknown,
  plan: BoundedScanResumePlan,
  limit: number,
  blocked: readonly string[],
): BoundedScanCandidatePage {
  fields(
    raw,
    ['schemaVersion', 'planId', 'rows', 'exhausted'],
    ['capacityBlocked', 'coolingDelayMs'],
  );
  if (
    raw.capacityBlocked !== undefined &&
    (!plan.commitWindow ||
      raw.capacityBlocked !== true ||
      raw.exhausted !== false ||
      !Array.isArray(raw.rows) ||
      raw.rows.length !== 0)
  )
    throw refusal();
  if (
    raw.schemaVersion !== 1 ||
    raw.planId !== plan.planId ||
    typeof raw.exhausted !== 'boolean' ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > limit ||
    limit < 1 ||
    limit > scanResumeCommitWindow.maxActiveProbes
  )
    throw refusal();
  if (
    Object.hasOwn(raw, 'coolingDelayMs') &&
    (!plan.takeTiming ||
      !integer(raw.coolingDelayMs, 60000) ||
      raw.coolingDelayMs === 0 ||
      raw.exhausted !== false ||
      raw.capacityBlocked !== undefined ||
      raw.rows.length !== 0)
  )
    throw refusal();
  const indices = new Set(),
    keys = new Set(),
    origins = new Set(blocked),
    reservations = new Set();
  let previous = -1;
  for (const r of raw.rows) {
    fields(
      r,
      ['candidateIndex', 'candidate', 'work', 'originToken', 'reservationId'],
      ['observation'],
    );
    if (
      !integer(r.candidateIndex) ||
      Number(r.candidateIndex) >= plan.counts.total ||
      Number(r.candidateIndex) <= previous ||
      indices.has(r.candidateIndex) ||
      !opaque(r.originToken) ||
      String(r.originToken).length > 128 ||
      origins.has(r.originToken) ||
      !opaque(r.reservationId) ||
      String(r.reservationId).length > 128 ||
      reservations.has(r.reservationId) ||
      !['probe', 'publish'].includes(String(r.work))
    )
      throw refusal();
    previous = Number(r.candidateIndex);
    indices.add(r.candidateIndex);
    origins.add(r.originToken);
    reservations.add(r.reservationId);
    fields(r.candidate, ['key', 'sourceId', 'sourceFingerprint', 'sessionRevision', 'channel']);
    const c = r.candidate;
    const policy = plan.sourcePolicies.find(
      (p) => p.sourceId === c.sourceId && p.fingerprint === c.sourceFingerprint,
    );
    if (!opaque(c.key) || keys.has(c.key) || !policy || c.sessionRevision !== plan.sessionRevision)
      throw refusal();
    keys.add(c.key);
    fields(
      c.channel,
      ['sourceId', 'name', 'category', 'urls'],
      ['providerId', 'geography', 'geographyProvenance'],
    );
    if (
      c.channel.sourceId !== c.sourceId ||
      typeof c.channel.name !== 'string' ||
      c.channel.name.length > 16384 ||
      typeof c.channel.category !== 'string' ||
      c.channel.category.length > 16384 ||
      !Array.isArray(c.channel.urls) ||
      !c.channel.urls.length ||
      c.channel.urls.length > 16
    )
      throw refusal();
    for (const u of c.channel.urls) {
      if (typeof u !== 'string' || new TextEncoder().encode(u).length > 16384) throw refusal();
      const url = new URL(u);
      if (
        !['https:', 'http:'].includes(url.protocol) ||
        !url.hostname ||
        url.username ||
        url.password
      )
        throw refusal();
    }
    if (r.work === 'publish') {
      const o = trusted(r.observation, r as unknown as BoundedScanCandidateRow, plan);
      if (!['Reachable', 'PlayedHere'].includes(o.verdict)) throw refusal();
    } else if (Object.hasOwn(r, 'observation')) throw refusal();
  }
  boundedJsonUtf8Bytes(raw, 1024 * 1024);
  return freeze(structuredClone(raw) as unknown as BoundedScanCandidatePage);
}

export function sameIndices(left: readonly number[], right: readonly number[]): boolean {
  return (
    left.length === right.length &&
    new Set(left).size === left.length &&
    [...left].sort((a, b) => a - b).every((v, i) => v === [...right].sort((a, b) => a - b)[i])
  );
}
