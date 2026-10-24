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

import {
  SelectedGuideUnavailableError,
  type SelectedGuideQuery,
  type SelectedGuideSummary,
} from '../../guide/native';
import { boundedUtf8Text } from '../../platform/bounded-text';
import {
  createGuideSummaryOwner,
  type GuideSummaryClock,
  type GuideSummarySnapshot,
} from './guide-summary-owner';
export interface SelectedGuideScope {
  catalogSourceId: string;
  appChannelId: string;
  catalogRevision: string;
  selectionGeneration: number;
}
export type SelectedGuideSnapshot = GuideSummarySnapshot<SelectedGuideSummary>;
export type SelectedGuideClock = GuideSummaryClock;
function safeIdentity(value: unknown, bytes: number): value is string {
  if (!boundedUtf8Text(value, bytes)) return false;
  for (let index = 0; index < value.length; index++)
    if (value.charCodeAt(index) < 32 || value.charCodeAt(index) === 127) return false;
  return true;
}
function validScope(scope: SelectedGuideScope): boolean {
  return (
    safeIdentity(scope.catalogSourceId, 256) &&
    safeIdentity(scope.appChannelId, 16384) &&
    typeof scope.catalogRevision === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/.test(scope.catalogRevision) &&
    BigInt(scope.catalogRevision) <= 9223372036854775807n &&
    Number.isSafeInteger(scope.selectionGeneration) &&
    scope.selectionGeneration >= 0
  );
}
/** Selected-channel adapter over the shared foreground query lifecycle. */
export function createSelectedGuideOwner(options: {
  fetch(query: SelectedGuideQuery, signal: AbortSignal): Promise<SelectedGuideSummary>;
  cancel?(requestId: string): Promise<unknown>;
  isCurrent(scope: Readonly<SelectedGuideScope>): boolean;
  available?(): boolean;
  clock?: SelectedGuideClock;
  requestId?(): string;
}) {
  const owner = createGuideSummaryOwner<
    SelectedGuideScope,
    SelectedGuideQuery,
    SelectedGuideSummary
  >({
    ...options,
    validateScope: validScope,
    query: (scope, atMs, requestId) => ({
      catalogSourceId: scope.catalogSourceId,
      appChannelId: scope.appChannelId,
      atMs,
      requestId,
    }),
    validateReply: (reply, query, scope) =>
      reply.catalogSourceId === query.catalogSourceId &&
      reply.appChannelId === query.appChannelId &&
      reply.requestId === query.requestId &&
      reply.atMs === query.atMs &&
      reply.catalogRevision === scope.catalogRevision,
    boundaries: (reply) => [reply.current?.stopMs, reply.next?.startMs],
    isUnavailable: (error) => error instanceof SelectedGuideUnavailableError,
  });
  return {
    setSelection: owner.setScope,
    refresh: owner.refresh,
    setForeground: owner.setForeground,
    suspend: owner.suspend,
    dispose: owner.dispose,
    subscribe: owner.subscribe,
    get snapshot() {
      return owner.snapshot;
    },
  };
}
