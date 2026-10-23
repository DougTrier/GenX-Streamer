import type { ArchiveQuery } from '../platform/archive-catalog';

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
