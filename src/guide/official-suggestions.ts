/* Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0 */

/** Reviewed fixed publisher adapters; this does not admit arbitrary JSON/API URLs. */
export const OFFICIAL_COMET_LOCATION = 'https://comettv.com/schedule/';
export const OFFICIAL_COMET_NAME = 'Official COMET · national main feed';
export const OFFICIAL_PBS_KIDS_LOCATION = 'https://pbskids.org/videos/watch/live';
export const OFFICIAL_PBS_KIDS_NAME = 'Official PBS KIDS · national 24/7 feed';

export function isOfficialGuideSuggestion(value: {
  name: unknown;
  location: unknown;
  channels: unknown;
}): boolean {
  return (
    ((value.location === OFFICIAL_COMET_LOCATION && value.name === OFFICIAL_COMET_NAME) ||
      (value.location === OFFICIAL_PBS_KIDS_LOCATION && value.name === OFFICIAL_PBS_KIDS_NAME)) &&
    Number.isSafeInteger(value.channels) &&
    (value.channels as number) >= 1 &&
    (value.channels as number) <= 2
  );
}
