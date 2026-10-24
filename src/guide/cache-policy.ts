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

import type { GuideSource, SourceCoverage } from './native';

export type GuideCacheReason =
  | 'missing'
  | 'invalid'
  | 'revision'
  | 'scope'
  | 'clock'
  | 'aged'
  | 'expired'
  | 'unknown-end'
  | 'renewal-due'
  | 'unneeded'
  | 'usable';

export interface GuideCacheAssessment {
  readonly usable: boolean;
  readonly reason: GuideCacheReason;
}

export interface GuideCacheInput {
  readonly source: Pick<GuideSource, 'revision' | 'updatedMs'> | null;
  readonly expectedSourceRevision: number;
  readonly coverage: SourceCoverage | null;
  readonly nowMs: number;
  readonly maxAgeMs: number;
  readonly signal?: AbortSignal;
}

const instant = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 8.64e15;
const count = (value: unknown): value is number =>
  Number.isSafeInteger(value) && (value as number) >= 0;
const revision = (value: unknown): value is number => count(value) && value > 0;
const nullableInstant = (value: unknown): value is number | null =>
  value === null || instant(value);
const targetCount = (value: unknown): value is number => count(value) && value <= 100000;
const result = (reason: GuideCacheReason): GuideCacheAssessment =>
  Object.freeze({ usable: reason === 'usable' || reason === 'unneeded', reason });

/** Cache admission only: mapped target horizons do not establish continuous or seven-day coverage.
 * A future start with no known end is insufficient. No I/O, clock reads, retries or timers.
 */
export function assessGuideCache(input: GuideCacheInput): GuideCacheAssessment {
  input.signal?.throwIfAborted();
  const { source, coverage, expectedSourceRevision, nowMs, maxAgeMs } = input;
  if (
    !instant(nowMs) ||
    !Number.isSafeInteger(maxAgeMs) ||
    maxAgeMs < 0 ||
    maxAgeMs > 8.64e15 ||
    !revision(expectedSourceRevision)
  )
    return result('invalid');
  if (!source || !coverage) return result('missing');
  const mapped = coverage.mappedTargets;
  if (
    mapped !== undefined &&
    (mapped === null ||
      typeof mapped !== 'object' ||
      mapped.version !== 1 ||
      !instant(mapped.assessedMs) ||
      mapped.assessedMs > nowMs ||
      !instant(mapped.cooldownUntilMs) ||
      !targetCount(mapped.targetCount) ||
      !targetCount(mapped.knownEndCount) ||
      !targetCount(mapped.missingEndCount) ||
      !targetCount(mapped.expiredCount) ||
      mapped.targetCount !== mapped.knownEndCount + mapped.missingEndCount ||
      mapped.expiredCount > mapped.knownEndCount ||
      !nullableInstant(mapped.earliestLastStopMs) ||
      (mapped.knownEndCount === 0) !== (mapped.earliestLastStopMs === null) ||
      (mapped.knownEndCount > 0 &&
        mapped.earliestLastStopMs !== null &&
        mapped.expiredCount > 0 !== mapped.earliestLastStopMs <= mapped.assessedMs))
  )
    return result('invalid');
  if (
    (coverage.projectionCompatible !== undefined &&
      typeof coverage.projectionCompatible !== 'boolean') ||
    (coverage.projectionInterestCount !== undefined &&
      (!count(coverage.projectionInterestCount) ||
        typeof coverage.projectionCompatible !== 'boolean')) ||
    !revision(source.revision) ||
    !nullableInstant(source.updatedMs) ||
    (mapped && source.updatedMs !== null && mapped.cooldownUntilMs < source.updatedMs + 3600000) ||
    !revision(coverage.sourceRevision) ||
    !(coverage.publishedRevision === null || revision(coverage.publishedRevision)) ||
    !count(coverage.channelCount) ||
    !count(coverage.programCount) ||
    !count(coverage.unknownEndCount) ||
    coverage.unknownEndCount > coverage.programCount ||
    !nullableInstant(coverage.firstStartMs) ||
    !nullableInstant(coverage.lastStartMs) ||
    !nullableInstant(coverage.lastStopMs) ||
    (coverage.firstStartMs !== null &&
      coverage.lastStartMs !== null &&
      coverage.firstStartMs > coverage.lastStartMs) ||
    (coverage.lastStopMs !== null &&
      coverage.firstStartMs !== null &&
      coverage.lastStopMs <= coverage.firstStartMs)
  )
    return result('invalid');
  if (
    source.revision !== expectedSourceRevision ||
    coverage.sourceRevision !== expectedSourceRevision ||
    coverage.publishedRevision !== expectedSourceRevision
  )
    return result('revision');
  if (coverage.projectionCompatible === false) return result('scope');
  const unneeded = coverage.projectionCompatible === true && coverage.projectionInterestCount === 0;
  if (unneeded && coverage.programCount !== 0) return result('invalid');
  if (
    source.updatedMs === null ||
    (!unneeded && (coverage.channelCount === 0 || coverage.programCount === 0))
  )
    return result('missing');
  if (source.updatedMs > nowMs) return result('clock');
  if (nowMs - source.updatedMs >= maxAgeMs) return result('aged');
  if (mapped && mapped.targetCount > 0) {
    if (unneeded) return result('invalid');
    if (mapped.missingEndCount > 0) return result('unknown-end');
    if (mapped.earliestLastStopMs! <= nowMs) return result('expired');
    if (mapped.earliestLastStopMs! - nowMs <= 15 * 60000) return result('renewal-due');
  }
  if (unneeded) return result('unneeded');
  if (coverage.firstStartMs === null || coverage.lastStartMs === null) return result('invalid');
  if (coverage.lastStopMs === null) return result('unknown-end');
  if (coverage.lastStopMs <= nowMs) return result('expired');
  return result('usable');
}
