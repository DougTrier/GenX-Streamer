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
 * What the automatic check tests share: candidates, reviews, responses and
 * options.
 */
import { type ReviewCandidate, type ScanReview } from '../../src/discovery/scan';
import { createHealthObservation } from '../../src/discovery/health';

export const candidate = (n: number): ReviewCandidate => ({
  key: `c${n}`,
  sourceId: 's',
  sourceFingerprint: 'fingerprint',
  sessionRevision: 'revision',
  channel: {
    sourceId: 's',
    name: `Channel ${n}`,
    category: 'General',
    urls: [`https://fixture-${n}.invalid/${n}`],
  },
});

export const review = (count: number): ScanReview => ({
  sessionRevision: 'revision',
  query: '',
  status: 'completed',
  sources: [],
  candidates: Array.from({ length: count }, (_, i) => candidate(i)),
  counts: { inspected: count, matched: count, failedSources: 0, canceledSources: 0 },
});

export const response = (
  c: ReviewCandidate,
  kind: 'recognized-media-response' | 'timeout' | 'not-checked' = 'recognized-media-response',
) =>
  createHealthObservation(
    { channelId: c.key, sourceId: c.sourceId, fingerprint: c.sourceFingerprint },
    { platform: 'browser', observedAt: 1000 },
    { kind },
  );

export const options = () => ({
  signal: new AbortController().signal,
  platform: 'browser',
  now: () => 1000,
});

export function overlappingReview(): ScanReview {
  const input = review(2);
  input.candidates = ['a', 'b'].map((sourceId) => ({
    ...candidate(0),
    key: sourceId,
    sourceId,
    sourceFingerprint: 'fingerprint-' + sourceId,
    channel: {
      ...candidate(0).channel,
      sourceId,
      providerId: 'station',
      urls: [
        'https://shared.fixture.invalid/feed?token=one',
        'https://backup.fixture.invalid/feed',
      ],
      geography: { country: 'US' },
    },
  }));
  return input;
}

export const overlappingPolicies = () =>
  ['a', 'b'].map((sourceId) => ({
    sourceId,
    fingerprint: 'fingerprint-' + sourceId,
    allowHttp: false,
    headers: { Accept: 'application/vnd.apple.mpegurl' },
  }));

export function frozen<T>(input: T, seen = new WeakSet<object>()): T {
  if (input && typeof input === 'object' && !seen.has(input)) {
    seen.add(input);
    for (const child of Object.values(input)) frozen(child, seen);
    Object.freeze(input);
  }
  return input;
}
