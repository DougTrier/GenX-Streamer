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

import type { Source } from '../catalog/parser';

/** A query search may reuse a source this app instance indexed within this window. */
export const SEARCH_INDEX_REUSE_MS = 6 * 60 * 60 * 1000;
/** A query search does not re-request a source that failed this recently. */
export const SEARCH_FAILURE_BACKOFF_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 100;

export interface IndexFreshness {
  /** Record an actual native promotion of this exact source definition for a query. */
  record(source: Source, promotedRevision: string, query?: string): void;
  /**
   * True only for a query search whose source definition and current revision
   * equal one this instance promoted recently. A plain refresh never reuses; a
   * full recheck (Rescan) reuses only for a different query, i.e. a new search.
   */
  reusable(
    source: Source,
    currentRevision: string,
    scope: { query: string; intent: 'refresh' | 'full-recheck' | 'slow' },
  ): boolean;
  /** Record a source collection failure (not cancellation). */
  recordFailure(source: Source): void;
  /** True only for a query search within the failure back-off window. */
  recentlyFailed(
    source: Source,
    scope: { query: string; intent: 'refresh' | 'full-recheck' | 'slow' },
  ): boolean;
  clear(): void;
}
const identity = (source: Source) =>
  JSON.stringify([source.id, source.kind, source.location, source.allowHttp === true]);

/** Session memory only: never persisted, so a restarted app always re-reads sources. */
export function createIndexFreshness(now: () => number = Date.now): IndexFreshness {
  const entries = new Map<string, { revision: string; atMs: number; query: string }>();
  const key = (query: string) => query.normalize('NFKC').trim().replace(/\s+/gu, ' ').toLowerCase();
  const failures = new Map<string, number>();
  return {
    record(source, promotedRevision, query = '') {
      entries.delete(identity(source));
      if (entries.size >= MAX_ENTRIES) entries.delete(entries.keys().next().value!);
      entries.set(identity(source), { revision: promotedRevision, atMs: now(), query: key(query) });
      failures.delete(identity(source));
    },
    recordFailure(source) {
      failures.delete(identity(source));
      if (failures.size >= MAX_ENTRIES) failures.delete(failures.keys().next().value!);
      failures.set(identity(source), now());
    },
    recentlyFailed(source, scope) {
      if (scope.intent !== 'refresh' || !scope.query.trim()) return false;
      const at = failures.get(identity(source));
      const age = now() - (at ?? Number.NEGATIVE_INFINITY);
      return at !== undefined && age >= 0 && age < SEARCH_FAILURE_BACKOFF_MS;
    },
    reusable(source, currentRevision, scope) {
      if (!scope.query.trim()) return false;
      const entry = entries.get(identity(source));
      // Rescan of the same query asks for fresh sources; a new query is a new search.
      if (scope.intent === 'full-recheck' && entry?.query === key(scope.query)) return false;
      const age = now() - (entry?.atMs ?? Number.NEGATIVE_INFINITY);
      return (
        !!entry && entry.revision === currentRevision && age >= 0 && age < SEARCH_INDEX_REUSE_MS
      );
    },
    clear: () => {
      entries.clear();
      failures.clear();
    },
  };
}
