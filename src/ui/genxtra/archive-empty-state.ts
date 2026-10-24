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

import type { ArchiveQuery } from '../../platform/archive-catalog';

type EmptyView = Pick<ArchiveQuery, 'favoritesOnly' | 'decade' | 'contentType' | 'languageMode'> & {
  query: string;
  totalCount: number;
  pendingCount?: number;
};

/** Query totals describe selectable titles in this view, not the durable favorite ledger. */
export function archiveFavoriteEmptyState(
  view: EmptyView,
): { message: string; filtered: boolean } | null {
  if (!view.favoritesOnly || view.totalCount !== 0) return null;
  const filtered =
    !!view.query.trim() ||
    view.decade != null ||
    (view.contentType !== undefined && view.contentType !== 'all') ||
    view.languageMode === 'english' ||
    view.languageMode === 'unlisted';
  return {
    filtered,
    message: view.pendingCount
      ? 'No playable favorites match this view. Check the saved suggestions below.'
      : filtered
        ? 'No favorite titles match the current search and filters.'
        : 'No favorite titles with selectable videos are available.',
  };
}
