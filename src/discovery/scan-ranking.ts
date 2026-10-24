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

import { MAX_CHANNELS } from '../catalog/parser';
import { prioritizeRegion, type PreferredRegion } from '../location/region';
import type { DiscoveryMetadata } from './discovery-metadata';
import type { ReviewCandidate, ScanReview } from './scan';

const normalize = (text: string) =>
  text.normalize('NFKC').toLowerCase().trim().replace(/\s+/gu, ' ');
const words = (text: string) => text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/**
 * 0 exact name, 1 name prefix, 2 every word starts a name word, 3 any other admitted match.
 * Names include published alternates. Matching admission itself is unchanged.
 */
export function relevanceTier(query: string, names: readonly string[]): number {
  const key = normalize(query);
  if (!key) return 3;
  const tokens = words(key);
  let best = 3;
  for (const raw of names) {
    const name = normalize(raw);
    if (name === key) return 0;
    if (name.startsWith(key)) best = Math.min(best, 1);
    else if (tokens.length) {
      const nameWords = words(name);
      if (tokens.every((token) => nameWords.some((word) => word.startsWith(token))))
        best = Math.min(best, 2);
    }
  }
  return best;
}

/**
 * New-review ordering only: best query matches first, then the saved region, with
 * closed/replaced/blocklisted channels last. The candidate set and identities are
 * unchanged; resume reconstruction never depends on this order.
 */
export function rankScanCandidates(
  review: ScanReview,
  preferredRegion: PreferredRegion | undefined,
  metadata?: DiscoveryMetadata,
): ScanReview {
  if (review.candidates.length > MAX_CHANNELS)
    throw new Error('Scan priority scope exceeds 100,000 channels.');
  const tiers = new Map<number, ReviewCandidate[]>();
  for (const candidate of review.candidates) {
    const info = metadata?.lookup(candidate.channel.providerId);
    const names = info ? [candidate.channel.name, ...info.names] : [candidate.channel.name];
    const tier = relevanceTier(review.query, names) + (info?.demoted ? 10 : 0);
    const bucket = tiers.get(tier) ?? [];
    bucket.push(candidate);
    tiers.set(tier, bucket);
  }
  const candidates: ReviewCandidate[] = [];
  for (const tier of [...tiers.keys()].sort((a, b) => a - b))
    candidates.push(
      ...prioritizeRegion(tiers.get(tier)!, preferredRegion, (item) => item.channel.geography),
    );
  return { ...review, candidates };
}
