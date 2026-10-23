import { expect, it } from 'vitest';
import { reorderScanCandidates } from '../../src/discovery/scan-priority';
import type { ScanReview } from '../../src/discovery/scan';
const input = (): ScanReview => ({
  sessionRevision: 'revision',
  query: '',
  status: 'completed',
  sources: [],
  counts: { inspected: 5, matched: 5, failedSources: 0, canceledSources: 0 },
  candidates: [
    {
      key: 'foreign',
      sourceId: 'first',
      sourceFingerprint: 'a',
      sessionRevision: 'revision',
      channel: {
        name: 'Illinois in name',
        category: 'General',
        sourceId: 'first',
        urls: ['https://a.invalid'],
        geography: { country: 'CA' },
      },
    },
    {
      key: 'unknown',
      sourceId: 'first',
      sourceFingerprint: 'a',
      sessionRevision: 'revision',
      channel: {
        name: 'Local station',
        category: 'General',
        sourceId: 'first',
        urls: ['https://b.invalid'],
      },
    },
    {
      key: 'national',
      sourceId: 'second',
      sourceFingerprint: 'b',
      sessionRevision: 'revision',
      channel: {
        name: 'US',
        category: 'General',
        sourceId: 'second',
        urls: ['https://c.invalid'],
        geography: { country: 'US' },
      },
    },
    {
      key: 'local1',
      sourceId: 'second',
      sourceFingerprint: 'b',
      sessionRevision: 'revision',
      channel: {
        name: 'Declared local',
        category: 'General',
        sourceId: 'second',
        urls: ['https://d.invalid'],
        geography: { country: 'US', state: 'US-IL' },
      },
    },
    {
      key: 'local2',
      sourceId: 'third',
      sourceFingerprint: 'c',
      sessionRevision: 'revision',
      channel: {
        name: 'Declared local second',
        category: 'General',
        sourceId: 'third',
        urls: ['https://e.invalid'],
        geography: { country: 'US', state: 'US-IL' },
      },
    },
  ],
});
it('prioritizes declared local channels globally across sources without renaming identities or inferring names', () => {
  const review = input(),
    before = structuredClone(review);
  const ordered = reorderScanCandidates(review, {
    country: 'US',
    state: 'US-IL',
    origin: 'manual',
  });
  expect(ordered.candidates.map((item) => item.key)).toEqual([
    'local1',
    'local2',
    'national',
    'foreign',
    'unknown',
  ]);
  for (const candidate of ordered.candidates)
    expect(candidate).toEqual(before.candidates.find((item) => item.key === candidate.key));
  expect(review).toEqual(before);
  expect(ordered.counts).toEqual(before.counts);
});
it('absent location preserves the original order and all candidates, including unknown geography', () => {
  const review = input();
  expect(reorderScanCandidates(review, undefined)).toEqual(review);
});
it('refuses an oversized review without truncating candidates', () => {
  const review = input();
  review.candidates.length = 100001;
  expect(() => reorderScanCandidates(review, undefined)).toThrow('100,000');
});
