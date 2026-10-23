import { expect, it } from 'vitest';
import { describeGuideAvailability } from '../../src/guide/summary-reason';
import type { SelectedGuideSummary } from '../../src/guide/native';
const base: SelectedGuideSummary = {
  requestId: 'fixture',
  catalogSourceId: 's',
  appChannelId: 'c',
  atMs: 1000,
  catalogRevision: '1',
  databaseRevision: 1,
  mappingStatus: 'mapped',
  mapping: { catalogSourceId: 's', appChannelId: 'c', guideSourceId: 'g', xmltvChannelId: 'x' },
  sourceRevision: 1,
  publishedRevision: 1,
  updatedMs: 0,
  coverage: { startMs: 0, endMs: 999999 },
  cacheStatus: 'current',
  currentStatus: 'empty',
  nextStatus: 'none',
  current: null,
  next: null,
};
it.each([
  [{ mappingStatus: 'unmapped' }, 'This channel has not been matched to a saved guide'],
  [{ mappingStatus: 'source-unavailable' }, 'source is unavailable'],
  [{ cacheStatus: 'unavailable' }, 'No schedule has been saved'],
  [{ cacheStatus: 'stale' }, 'out of date'],
  [{ currentStatus: 'empty' }, 'No listings are saved for this channel'],
  [{ currentStatus: 'gap' }, 'do not cover the current time'],
  [{ currentStatus: 'overlap' }, 'Listings overlap'],
  [{ currentStatus: 'unknown-end' }, 'no end time'],
  [{ currentStatus: 'current' }, 'A current listing is available'],
  [{ mappingStatus: 'channel-unavailable' }, 'no longer saved'],
] as const)('explains exact saved reason %j without guessed coverage', (change, expected) => {
  const text = describeGuideAvailability({ ...base, ...change });
  expect(text).toContain(expected);
  expect(text).not.toMatch(/seven.day|complete coverage|stream unavailable|accuracy|https?:/);
});
it('source-wide bounds cannot turn an empty selected channel into available listings', () => {
  expect(describeGuideAvailability(base)).toContain('No listings are saved for this channel');
  expect(describeGuideAvailability({ ...base, coverage: { startMs: null, endMs: null } })).toBe(
    describeGuideAvailability(base),
  );
});
