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

import type { SelectedGuideSummary } from './native';

/** A reason for this exact channel/time. No source-wide span implies channel coverage. */
export function describeGuideAvailability(summary: SelectedGuideSummary): string {
  if (summary.mappingStatus === 'channel-unavailable')
    return 'This channel is no longer saved. Return to Guide to refresh.';
  if (summary.mappingStatus === 'unmapped')
    return 'This channel has not been matched to a saved guide. Choose Map guide to review schedules.';
  if (summary.mappingStatus === 'source-unavailable')
    return 'The saved guide source is unavailable. Choose another schedule.';
  if (summary.cacheStatus === 'unavailable')
    return 'No schedule has been saved from this guide. Refresh it or choose another schedule.';
  if (summary.cacheStatus === 'stale')
    return 'The saved schedule is out of date. Refresh the guide or choose another schedule.';
  if (summary.currentStatus === 'empty')
    return 'No listings are saved for this channel. Try another guide.';
  if (summary.currentStatus === 'gap')
    return 'Saved listings do not cover the current time. Refresh the guide or choose another schedule.';
  if (summary.currentStatus === 'overlap')
    return 'Listings overlap at the current time, so the current program is uncertain.';
  if (summary.currentStatus === 'unknown-end')
    return 'A listing has no end time, so the current program is uncertain.';
  if (summary.currentStatus === 'current') return 'A current listing is available.';
  return 'The current schedule could not be confirmed. Try refreshing the guide.';
}
