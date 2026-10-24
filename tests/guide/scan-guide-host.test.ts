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

import { describe, expect, it, vi } from 'vitest';
import {
  createScanGuideHost,
  type ScanGuideGateway,
} from '../../src/application/discovery/scan-guide-host';
import type { ReviewCandidate } from '../../src/discovery/scan';
import type { GuideSuggestions } from '../../src/guide/native';

const candidate: ReviewCandidate = {
  key: 'candidate',
  sourceId: 'catalog',
  sourceFingerprint: 'source-revision',
  sessionRevision: '1',
  channel: {
    sourceId: 'catalog',
    providerId: 'FOX@Chicago',
    name: 'FOX Chicago',
    category: 'News',
    urls: ['https://media.invalid/channel'],
  },
};
function fixture(value: Partial<GuideSuggestions> = {}) {
  const suggestions = vi.fn(async (): Promise<GuideSuggestions> => ({
    sourceRevision: 3,
    publishedRevision: 3,
    cacheStatus: 'current',
    match: 'provider-id',
    candidateCount: 1,
    candidatesPreview: [{ xmltvChannelId: 'FOX@Chicago', displayName: 'FOX Chicago' }],
    previewComplete: true,
    reviewRequired: true,
    ...value,
  }));
  const gateway: ScanGuideGateway = {
    available: () => true,
    sources: async () => [
      {
        id: 'guide',
        name: 'Guide',
        location: 'https://guide.invalid/feed',
        kind: 'url',
        allowHttp: false,
        revision: 3,
        updatedMs: 1,
      },
    ],
    coverage: async () => ({
      sourceRevision: 3,
      publishedRevision: 3,
      channelCount: 1,
      programCount: 1,
      firstStartMs: 1,
      lastStartMs: 2,
      lastStopMs: 3,
      unknownEndCount: 0,
    }),
    suggestions,
  };
  return { gateway, suggestions, host: createScanGuideHost(gateway) };
}
describe('configured native guide enrichment adapter', () => {
  it('binds independent guide publication revision and exact full provider/feed identity', async () => {
    const { host, suggestions } = fixture();
    const signal = new AbortController().signal;
    const guides = await host.guides(signal);
    expect(guides).toEqual([{ id: 'guide', fingerprint: '[3,3]' }]);
    expect(await host.enrich(candidate, guides, signal)).toEqual([
      {
        candidateKey: 'candidate',
        guideSourceId: 'guide',
        status: 'suggested',
        guideChannelId: 'FOX@Chicago',
      },
    ]);
    expect(suggestions).toHaveBeenCalledWith({
      guideSourceId: 'guide',
      expectedSourceRevision: 3,
      expectedPublishedRevision: 3,
      providerId: 'FOX@Chicago',
      name: 'FOX Chicago',
    });
  });
  it.each(['stale', 'unavailable'] as const)(
    'keeps %s caches unavailable without returning a station identity',
    async (cacheStatus) => {
      const { host } = fixture({ cacheStatus });
      expect(
        await host.enrich(
          candidate,
          [{ id: 'guide', fingerprint: '[3,3]' }],
          new AbortController().signal,
        ),
      ).toEqual([{ candidateKey: 'candidate', guideSourceId: 'guide', status: 'unavailable' }]);
    },
  );
  it('preserves complete ambiguity instead of selecting the first preview', async () => {
    const { host } = fixture({ match: 'ambiguous', candidateCount: 25, previewComplete: false });
    expect(
      await host.enrich(
        candidate,
        [{ id: 'guide', fingerprint: '[3,3]' }],
        new AbortController().signal,
      ),
    ).toEqual([{ candidateKey: 'candidate', guideSourceId: 'guide', status: 'ambiguous' }]);
  });
  it('rejects changed revision or incomplete unique suggestion', async () => {
    const signal = new AbortController().signal;
    await expect(
      fixture({ sourceRevision: 4 }).host.enrich(
        candidate,
        [{ id: 'guide', fingerprint: '[3,3]' }],
        signal,
      ),
    ).rejects.toThrow('changed');
    await expect(
      fixture({ candidateCount: 2 }).host.enrich(
        candidate,
        [{ id: 'guide', fingerprint: '[3,3]' }],
        signal,
      ),
    ).rejects.toThrow('incomplete');
  });
  it('checks cancellation after native lookup settlement and never admits its late suggestion', async () => {
    const { gateway } = fixture();
    const controller = new AbortController();
    gateway.suggestions = async () => {
      controller.abort();
      return {
        sourceRevision: 3,
        publishedRevision: 3,
        cacheStatus: 'current',
        match: 'unmatched',
        candidateCount: 0,
        candidatesPreview: [],
        previewComplete: true,
        reviewRequired: true,
      };
    };
    await expect(
      createScanGuideHost(gateway).enrich(
        candidate,
        [{ id: 'guide', fingerprint: '[3,3]' }],
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
