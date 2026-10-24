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

import { createAutomaticGuidePermissions } from '../guide/automatic-permissions';
import { assessGuideCache } from '../guide/cache-policy';
import type { GuideSource, SourceCoverage } from '../guide/native';
import { guideFeedCountry } from '../guide/provider-order';

/** A saved feed that serves none of the current channels is refreshed at most weekly. */
export const IRRELEVANT_GUIDE_BACKOFF_MS = 7 * 24 * 60 * 60 * 1000;

/** Explicit Find can renew exhausted saved guides even when automatic updates are off.
 * This assessment performs read-only calls; acquisition stays with the existing Find owner.
 */
export function createGuideCacheReady(
  host: {
    sources(): Promise<GuideSource[]>;
    coverage(sourceId: string): Promise<SourceCoverage>;
  },
  now: () => number = Date.now,
) {
  return async (provider: { location: string }, signal: AbortSignal): Promise<boolean> => {
    signal.throwIfAborted();
    const sources = await host.sources();
    signal.throwIfAborted();
    const source = createAutomaticGuidePermissions(sources).forLocation(provider.location).source;
    if (!source) return false;
    const coverage = await host.coverage(source.id);
    signal.throwIfAborted();
    return assessGuideCache({
      source,
      expectedSourceRevision: source.revision,
      coverage,
      nowMs: now(),
      maxAgeMs: 24 * 60 * 60 * 1000,
      signal,
    }).usable;
  };
}

/** Scan-triggered acquisition observes the persisted publication/attempt cooldown.
 * Manual Find remains an explicit retry. Refusal never makes an exhausted cache usable.
 */
export function createGuideAcquisitionAllowed(
  host: {
    sources(): Promise<GuideSource[]>;
    coverage(sourceId: string): Promise<SourceCoverage>;
  },
  now: () => number = Date.now,
) {
  return async (
    provider: { location: string },
    signal: AbortSignal,
    context: { automatic: boolean; catalogCountries?: readonly string[] },
  ): Promise<boolean> => {
    signal.throwIfAborted();
    if (!context.automatic) return true;
    const sources = await host.sources();
    signal.throwIfAborted();
    const source = createAutomaticGuidePermissions(sources).forLocation(provider.location).source;
    if (!source) {
      // A never-fetched per-country directory file for a country with no saved
      // channels cannot serve this catalog. Explicit Find still acquires it.
      const country = guideFeedCountry(provider.location);
      return !(
        country &&
        context.catalogCountries &&
        !context.catalogCountries.includes(country === 'GB' ? 'UK' : country)
      );
    }
    if (source.updatedMs === null) return true;
    const coverage = await host.coverage(source.id);
    signal.throwIfAborted();
    const instant = now();
    const assessment = assessGuideCache({
      source,
      expectedSourceRevision: source.revision,
      coverage,
      nowMs: instant,
      maxAgeMs: 24 * 60 * 60 * 1000,
      signal,
    });
    if (
      assessment.reason === 'invalid' ||
      assessment.reason === 'clock' ||
      assessment.reason === 'revision'
    )
      return false;
    // The native projection compares this feed's retained channel headers with
    // the current catalog. No interested channel means a refresh cannot help.
    if (coverage.projectionCompatible === true && coverage.projectionInterestCount === 0)
      return instant - source.updatedMs >= IRRELEVANT_GUIDE_BACKOFF_MS;
    return (
      coverage.mappedTargets === undefined ||
      coverage.mappedTargets.targetCount === 0 ||
      instant >= coverage.mappedTargets.cooldownUntilMs
    );
  };
}
