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

import type { SelectedGuideSummary } from '../../guide/native';
import { formatLocalGuideTime } from '../../guide/time';

export interface VisibleGuideChannel {
  catalogSourceId: string;
  appChannelId: string;
}
export interface ChannelGuideRow extends VisibleGuideChannel {
  status: 'idle' | 'loading' | 'ready' | 'unavailable' | 'error' | 'capacity';
  summary: SelectedGuideSummary | null;
}
export interface ChannelGuideHost {
  onVisibleGuideRows(rows: readonly VisibleGuideChannel[]): void;
}
export function channelGuideText(
  row: ChannelGuideRow | undefined,
  formatTime: (milliseconds: number) => string = formatLocalGuideTime,
): { current: string; next: string } {
  if (!row || row.status === 'idle') return { current: 'Guide not loaded', next: '' };
  if (row.status === 'loading') return { current: 'Guide loading…', next: '' };
  if (row.status === 'capacity')
    return { current: 'Guide view too large; reduce window height.', next: '' };
  if (row.status !== 'ready' || !row.summary) return { current: 'Guide unavailable', next: '' };
  const summary = row.summary;
  if (summary.mappingStatus === 'unmapped')
    return { current: 'No program guide connected yet', next: '' };
  if (summary.mappingStatus !== 'mapped') return { current: 'Guide unavailable', next: '' };
  const prefix = summary.cacheStatus === 'stale' ? 'Cached · ' : '';
  if (summary.cacheStatus === 'unavailable') return { current: 'No cached schedule', next: '' };
  const current =
    summary.currentStatus === 'current' && summary.current
      ? `Now: ${summary.current.title}`
      : summary.currentStatus === 'unknown-end'
        ? 'Current program end unknown'
        : summary.currentStatus === 'overlap'
          ? 'Current listings overlap'
          : 'No current listing';
  const next =
    summary.nextStatus === 'next' && summary.next
      ? `Next: ${formatTime(summary.next.startMs)} · ${summary.next.title}`
      : summary.nextStatus === 'overlap'
        ? 'Next listings overlap'
        : 'No upcoming listing';
  return { current: prefix + current, next };
}
