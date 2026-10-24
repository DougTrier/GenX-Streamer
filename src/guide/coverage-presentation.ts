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

import type { ChannelCoverageReply } from './channel-coverage';

/** Present only validated interval evidence; never claim programme accuracy. */
export function describeChannelCoverage(
  coverage: ChannelCoverageReply,
  formatTime: (instant: number) => string,
  period = 'this window',
): string {
  if (coverage.status !== 'assessed') {
    switch (coverage.reason) {
      case 'source-stale':
        return 'Guide changed. Refresh it to check this period.';
      case 'source-missing':
        return 'Saved guide source is unavailable. Review its source or map another guide.';
      case 'channel-missing':
        return 'This channel is absent from the saved guide. Review its mapping.';
      default:
        return "Couldn't check this period. Try a shorter period.";
    }
  }
  const gaps = coverage.gapCount!,
    ends = coverage.unknownEndCount!;
  const firstGap = coverage.gaps[0];
  const availability =
    coverage.coveredMs === 0
      ? `No listings available in ${period}.`
      : !firstGap || firstGap.startMs > coverage.startMs
        ? `Schedule available through ${formatTime(firstGap?.startMs ?? coverage.endMs)}.`
        : `Schedule has a gap at the start of ${period}.`;
  const gapText =
    gaps === 0
      ? `No schedule gaps in ${period}.`
      : `Schedule has ${gaps} ${gaps === 1 ? 'gap' : 'gaps'} in ${period}.${firstGap ? ` First gap: ${formatTime(firstGap.startMs)} – ${formatTime(firstGap.endMs)}.` : ''}`;
  const unknown = ends ? ` ${ends} program end ${ends === 1 ? 'time' : 'times'} unknown.` : '';
  return `${availability} ${gapText}${unknown}`;
}
