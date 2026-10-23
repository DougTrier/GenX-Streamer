import { describe, expect, it } from 'vitest';
import {
  validateArchiveDiscoveryView,
  validateArchiveDiscoverReceipt,
  type ArchiveDiscoverStep,
  type ArchiveDiscoveryView,
} from '../../src/platform/archive-catalog';

const view: ArchiveDiscoveryView = {
  schemaVersion: 1,
  languageMode: 'english',
  favoritesOnly: false,
  curatedOnly: false,
};
const request: ArchiveDiscoverStep = {
  schemaVersion: 1,
  expectedRevision: '7',
  year: null,
  page: 1,
  query: 'Gilligan',
  explicitAction: true,
};
const receipt = {
  schemaVersion: 1,
  committed: true,
  revision: '8',
  year: null,
  page: 1,
  nextPage: 2,
  examined: 20,
  admitted: 1,
  excludedUnknownYear: 0,
  unavailable: 0,
  titleCount: 10,
  confirmedDead: 0,
  transientFailures: 0,
  capacityReached: false,
  retryAfterMs: null,
  rankingPolicy: 'archive-popularity-playable-v1',
  pendingFilePages: [],
};
describe('Archive view-aware discovery capability', () => {
  it('preserves the exact legacy receipt while validating optional view-aware yield', () => {
    expect(validateArchiveDiscoverReceipt(receipt, request)).toEqual(receipt);
    const result = { ...receipt, newVisibleMatches: 0 };
    expect(validateArchiveDiscoverReceipt(result, { ...request, view })).toEqual(result);
    expect(() => validateArchiveDiscoverReceipt(receipt, { ...request, view })).toThrow();
    expect(() => validateArchiveDiscoverReceipt(result, request)).toThrow();
  });
  it.each(['all', 'english-first', 'english', 'unlisted'] as const)(
    'copies a bounded captured %s view',
    (languageMode) => {
      const source = { ...view, languageMode };
      const captured = validateArchiveDiscoveryView(source);
      expect(captured).toEqual(source);
      expect(captured).not.toBe(source);
    },
  );
  it.each([
    { schemaVersion: 2 },
    { languageMode: 'guessed-English' },
    { languageMode: undefined },
    { languageMode: null },
    { favoritesOnly: 'false' },
    { curatedOnly: 0 },
    { query: 'different' },
  ])('rejects invalid, contradictory or extra scope values: %j', (patch) => {
    expect(() =>
      validateArchiveDiscoveryView({ ...view, ...patch } as ArchiveDiscoveryView),
    ).toThrow();
  });
  it.each([-1, 21, 0.5, null, '1', Number.NaN])(
    'rejects malformed native yield %j',
    (newVisibleMatches) => {
      expect(() =>
        validateArchiveDiscoverReceipt({ ...receipt, newVisibleMatches }, { ...request, view }),
      ).toThrow();
    },
  );
  it('requires a view-aware receipt to stay inside one 20-candidate CAS step', () => {
    expect(() =>
      validateArchiveDiscoverReceipt(
        { ...receipt, newVisibleMatches: 1, examined: 21 },
        { ...request, view },
      ),
    ).toThrow();
    expect(() =>
      validateArchiveDiscoverReceipt(
        { ...receipt, newVisibleMatches: 1, revision: '9' },
        { ...request, view },
      ),
    ).toThrow();
    expect(validateArchiveDiscoverReceipt({ ...receipt, examined: 21 }, request).examined).toBe(21);
  });
});
