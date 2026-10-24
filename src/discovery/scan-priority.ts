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
import type { ScanReview } from './scan';

/** Reorders the complete review across sources; exact candidate identities remain unchanged. */
export function reorderScanCandidates(
  review: ScanReview,
  preferredRegion: PreferredRegion | undefined,
): ScanReview {
  if (review.candidates.length > MAX_CHANNELS)
    throw new Error('Scan priority scope exceeds 100,000 channels.');
  return {
    ...review,
    candidates: prioritizeRegion(
      review.candidates,
      preferredRegion,
      (item) => item.channel.geography,
    ),
  };
}
