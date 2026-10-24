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

import { SelectedGuideUnavailableError } from '../guide/native';
import {
  validVisibleChannels,
  validGuideRevision,
  type VisibleGuideChannel,
  type VisibleGuideQuery,
  type VisibleGuideSummary,
} from '../guide/visible-native';
import { createGuideSummaryOwner, type GuideSummaryClock } from './guide-summary-owner';

export interface VisibleGuideScope {
  channels: readonly VisibleGuideChannel[];
  catalogRevision: string;
  generation: number;
}
/** A single bounded local snapshot for the exact viewport; no network or playback actions. */
export function createVisibleGuideOwner(options: {
  fetch(query: VisibleGuideQuery, signal: AbortSignal): Promise<VisibleGuideSummary>;
  cancel?(requestId: string): Promise<unknown>;
  isCurrent(scope: Readonly<VisibleGuideScope>): boolean;
  available?(): boolean;
  clock?: GuideSummaryClock;
  requestId?(): string;
}) {
  return createGuideSummaryOwner<VisibleGuideScope, VisibleGuideQuery, VisibleGuideSummary>({
    ...options,
    validateScope: (scope) =>
      validVisibleChannels(scope.channels) &&
      validGuideRevision(scope.catalogRevision) &&
      Number.isSafeInteger(scope.generation) &&
      scope.generation >= 0,
    query: (scope, atMs, requestId) => ({ channels: scope.channels, atMs, requestId }),
    validateReply: (reply, query, scope) =>
      reply.requestId === query.requestId &&
      reply.atMs === query.atMs &&
      reply.catalogRevision === scope.catalogRevision &&
      reply.rows.length === query.channels.length &&
      reply.rows.every(
        (row, index) =>
          row.catalogSourceId === query.channels[index].catalogSourceId &&
          row.appChannelId === query.channels[index].appChannelId &&
          row.atMs === query.atMs &&
          row.requestId === query.requestId &&
          row.catalogRevision === reply.catalogRevision &&
          row.databaseRevision === reply.databaseRevision,
      ),
    boundaries: (reply) => reply.rows.flatMap((row) => [row.current?.stopMs, row.next?.startMs]),
    isUnavailable: (error) => error instanceof SelectedGuideUnavailableError,
  });
}
