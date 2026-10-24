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

import { nativeGuide, nativeGuideAvailable } from '../../guide/native';
import type {
  GuideSource,
  SourceCoverage,
  GuideSuggestionQuery,
  GuideSuggestions,
} from '../../guide/native';
import type { GuideEnrichment, RegisteredGuide } from '../../discovery/pipeline';
import type { ReviewCandidate } from '../../discovery/scan';

export interface ScanGuideGateway {
  available(): boolean;
  sources(): Promise<GuideSource[]>;
  coverage(sourceId: string): Promise<SourceCoverage>;
  suggestions(query: GuideSuggestionQuery): Promise<GuideSuggestions>;
}
/** Independently published guide caches only. Suggestions never publish or tune channels. */
export function createScanGuideHost(
  gateway: ScanGuideGateway = {
    available: nativeGuideAvailable,
    ...nativeGuide,
  },
): {
  guides(signal: AbortSignal): Promise<RegisteredGuide[]>;
  enrich(
    candidate: ReviewCandidate,
    guides: readonly RegisteredGuide[],
    signal: AbortSignal,
  ): Promise<GuideEnrichment[]>;
} {
  return {
    async guides(signal) {
      signal.throwIfAborted();
      if (!gateway.available()) return [];
      const sources = await gateway.sources();
      signal.throwIfAborted();
      if (sources.length > 100) throw new Error('Review at most 100 configured guides per scan.');
      const registered: RegisteredGuide[] = [];
      for (const source of sources) {
        const coverage = await gateway.coverage(source.id);
        signal.throwIfAborted();
        registered.push({
          id: source.id,
          fingerprint: JSON.stringify([source.revision, coverage.publishedRevision]),
        });
      }
      return registered;
    },
    async enrich(candidate, guides, signal) {
      const result: GuideEnrichment[] = [];
      for (const guide of guides) {
        signal.throwIfAborted();
        const revisions: unknown = JSON.parse(guide.fingerprint);
        if (
          !Array.isArray(revisions) ||
          revisions.length !== 2 ||
          !Number.isSafeInteger(revisions[0]) ||
          revisions[0] < 1 ||
          (revisions[1] !== null && (!Number.isSafeInteger(revisions[1]) || revisions[1] < 1))
        )
          throw new Error('The reviewed guide revision is invalid.');
        const suggestion = await gateway.suggestions({
          guideSourceId: guide.id,
          expectedSourceRevision: revisions[0],
          expectedPublishedRevision: revisions[1],
          providerId: candidate.channel.providerId ?? null,
          name: candidate.channel.name,
        });
        signal.throwIfAborted();
        if (
          suggestion.sourceRevision !== revisions[0] ||
          suggestion.publishedRevision !== revisions[1] ||
          suggestion.reviewRequired !== true
        )
          throw new Error('The reviewed guide changed. Scan again.');
        const identity = { candidateKey: candidate.key, guideSourceId: guide.id };
        if (suggestion.cacheStatus !== 'current')
          result.push({ ...identity, status: 'unavailable' });
        else if (suggestion.match === 'ambiguous')
          result.push({ ...identity, status: 'ambiguous' });
        else if (suggestion.match === 'unmatched')
          result.push({ ...identity, status: 'unmatched' });
        else {
          if (
            suggestion.candidateCount !== 1 ||
            !suggestion.previewComplete ||
            suggestion.candidatesPreview.length !== 1
          )
            throw new Error('Guide suggestions are incomplete. Review the guide directly.');
          result.push({
            ...identity,
            status: 'suggested',
            guideChannelId: suggestion.candidatesPreview[0].xmltvChannelId,
          });
        }
      }
      return result;
    },
  };
}
