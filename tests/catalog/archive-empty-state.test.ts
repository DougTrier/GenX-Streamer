import { expect, it } from 'vitest';
import { archiveFavoriteEmptyState } from '../../src/ui/archive-empty-state';
const blank = {
  favoritesOnly: true,
  query: '',
  totalCount: 0,
  languageMode: 'english-first' as const,
};
it('never replaces nonfavorite views or successful results', () => {
  expect(archiveFavoriteEmptyState({ ...blank, favoritesOnly: false })).toBeNull();
  expect(archiveFavoriteEmptyState({ ...blank, totalCount: 1 })).toBeNull();
});
it('all-filter absence describes selectable titles, not the durable favorites ledger', () => {
  expect(archiveFavoriteEmptyState(blank)).toEqual({
    message: 'No favorite titles with selectable videos are available.',
    filtered: false,
  });
});
it.each([
  { query: 'Cartoon' },
  { decade: 1970 },
  { contentType: 'tv' as const },
  { languageMode: 'english' as const },
  { languageMode: 'unlisted' as const },
] as const)('explains an explicit filter without silently clearing it: %o', (options) => {
  const input = { ...blank, ...options },
    before = { ...input };
  expect(archiveFavoriteEmptyState(input)).toEqual({
    message: 'No favorite titles match the current search and filters.',
    filtered: true,
  });
  expect(input).toEqual(before);
});
it.each(['all', 'english-first'] as const)(
  'ranking mode %s excludes no languages',
  (languageMode) => {
    expect(archiveFavoriteEmptyState({ ...blank, languageMode })?.filtered).toBe(false);
  },
);
it('pending eligible-file exploration remains distinct from no saved favorite ledger entries', () => {
  expect(archiveFavoriteEmptyState({ ...blank, decade: 1970, pendingCount: 1 })).toEqual({
    message: 'No playable favorites match this view. Check the saved suggestions below.',
    filtered: true,
  });
});
