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
