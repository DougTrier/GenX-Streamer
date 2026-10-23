import { describe, expect, it } from 'vitest';
import {
  compactDiscoveryMetadata,
  discoveryMetadata,
  providerChannelId,
} from '../../src/discovery/discovery-metadata';
import { rankScanCandidates, relevanceTier } from '../../src/discovery/scan-ranking';
import { reorderScanCandidates } from '../../src/discovery/scan-priority';
import {
  scanConfiguredSources,
  type ReviewCandidate,
  type ScanReview,
} from '../../src/discovery/scan';
import type { ChannelCandidate, ParsedPlaylist } from '../../src/catalog/parser';

const channels = JSON.stringify([
  { id: 'MovieSphere.us', name: 'MovieSphere', alt_names: ['MovieSphere by Lionsgate'] },
  { id: 'FoxNews.us', name: 'Fox News Channel', alt_names: ['FNC'] },
  { id: 'OldNews.us', name: 'Old News', alt_names: [], closed: '2020-01-01' },
  { id: 'Adult.us', name: 'Adult Fox', alt_names: [], is_nsfw: true },
  { id: 'Moved.us', name: 'Moved Fox', alt_names: [], replaced_by: 'FoxNews.us' },
  { id: 'Blocked.us', name: 'Blocked Fox', alt_names: [] },
]);
const blocklist = JSON.stringify([{ channel: 'Blocked.us', reason: 'dmca', ref: 'x' }]);
const metadata = () => discoveryMetadata(compactDiscoveryMetadata(channels, blocklist));

const candidate = (
  key: string,
  name: string,
  providerId?: string,
  country?: string,
): ReviewCandidate => ({
  key,
  sourceId: 's',
  sourceFingerprint: 'f',
  sessionRevision: 'r',
  channel: {
    name,
    category: 'General',
    sourceId: 's',
    urls: [`https://${key}.invalid/live.m3u8`],
    ...(providerId ? { providerId } : {}),
    ...(country ? { geography: { country } } : {}),
  },
});
const review = (query: string, candidates: ReviewCandidate[]): ScanReview => ({
  sessionRevision: 'r',
  query,
  status: 'completed',
  sources: [],
  candidates,
  counts: {
    inspected: candidates.length,
    matched: candidates.length,
    failedSources: 0,
    canceledSources: 0,
  },
});

describe('discovery metadata', () => {
  it('indexes official and alternate names by channel id, ignoring feed suffixes', () => {
    const index = metadata();
    expect(index.size).toBe(6);
    expect(providerChannelId('MovieSphere.us@SD')).toBe('MovieSphere.us');
    expect(index.lookup('MovieSphere.us@SD')?.names).toEqual([
      'MovieSphere',
      'MovieSphere by Lionsgate',
    ]);
    expect(index.lookup('Unknown.us')).toBeUndefined();
    expect(index.lookup(undefined)).toBeUndefined();
  });
  it('demotes closed, replaced, adult and blocklisted channels without removing them', () => {
    const index = metadata();
    for (const id of ['OldNews.us', 'Adult.us', 'Moved.us', 'Blocked.us'])
      expect(index.lookup(id)?.demoted).toBe(true);
    expect(index.lookup('FoxNews.us')?.demoted).toBe(false);
  });
  it('refuses a whole malformed or oversized snapshot', () => {
    for (const bad of [
      '{}',
      'not json',
      JSON.stringify([{ id: 'A.us' }]),
      JSON.stringify([
        { id: 'A.us', name: 'A' },
        { id: 'A.us', name: 'B' },
      ]),
      JSON.stringify([{ id: 'A.us', name: 'A', alt_names: ['bad\nname'] }]),
      JSON.stringify([{ id: 'A.us', name: 'A', alt_names: Array(33).fill('x') }]),
      JSON.stringify([{ id: 'A.us', name: 'A', is_nsfw: 'yes' }]),
    ])
      expect(() => compactDiscoveryMetadata(bad)).toThrow();
    expect(() => compactDiscoveryMetadata(channels, '[{"channel":""}]')).toThrow();
    expect(() =>
      discoveryMetadata({ ids: ['A'], names: [['A']], demoted: [] as boolean[] }),
    ).toThrow();
  });
});

describe('scan ranking', () => {
  it('assigns exact, prefix, word and other tiers', () => {
    expect(relevanceTier('fox news channel', ['Fox News Channel'])).toBe(0);
    expect(relevanceTier('fox', ['Fox News Channel'])).toBe(1);
    expect(relevanceTier('news chan', ['Fox News Channel'])).toBe(2);
    expect(relevanceTier('ox', ['Fox News Channel'])).toBe(3);
    expect(relevanceTier('', ['Anything'])).toBe(3);
    expect(relevanceTier('lionsgate', ['MovieSphere', 'MovieSphere by Lionsgate'])).toBe(2);
  });
  it('orders best matches first, then region, demoted last, keeping the exact candidate set', () => {
    const input = review('fox', [
      candidate('substring', 'Firefox Live'),
      candidate('blocked', 'Blocked Fox', 'Blocked.us'),
      candidate('word', 'The Fox Network'),
      candidate('prefix-foreign', 'Fox Sports', undefined, 'MX'),
      candidate('prefix-home', 'Fox Sports', undefined, 'US'),
      candidate('exact', 'Fox'),
      candidate('alias', 'Unrelated label', 'FoxNews.us@SD'),
    ]);
    const ranked = rankScanCandidates(input, { country: 'US', origin: 'manual' }, metadata());
    expect(ranked.candidates.map((c) => c.key)).toEqual([
      'exact',
      'prefix-home',
      'prefix-foreign',
      'alias',
      'word',
      'substring',
      'blocked',
    ]);
    expect(new Set(ranked.candidates)).toEqual(new Set(input.candidates));
    expect(ranked.counts).toEqual(input.counts);
  });
  it('matches the established region order when there is no query or metadata', () => {
    const input = review('', [
      candidate('a', 'A', undefined, 'MX'),
      candidate('b', 'B'),
      candidate('c', 'C', undefined, 'US'),
    ]);
    const region = { country: 'US', origin: 'manual' as const };
    expect(rankScanCandidates(input, region).candidates).toEqual(
      reorderScanCandidates(input, region).candidates,
    );
  });
});

describe('alias query matching', () => {
  const parsed = (list: ChannelCandidate[]): ParsedPlaylist => ({ channels: list, warnings: [] });
  const source = { id: 's', name: 'S', kind: 'url' as const, location: 'https://s.invalid/p.m3u' };
  const run = (query: string, aliases?: (c: ChannelCandidate) => readonly string[]) =>
    scanConfiguredSources(
      [{ source, fingerprint: 'f' }],
      async () =>
        parsed([
          {
            name: 'MovieSphere',
            category: 'Movies',
            sourceId: 's',
            urls: ['https://a.invalid/1'],
            providerId: 'MovieSphere.us@SD',
          },
          { name: 'Other', category: 'Movies', sourceId: 's', urls: ['https://a.invalid/2'] },
        ]),
      {
        sessionRevision: 'r',
        query,
        signal: new AbortController().signal,
        ...(aliases ? { aliases } : {}),
      },
    );
  it('admits published alternate names only when supplied', async () => {
    const index = metadata();
    const aliases = (c: ChannelCandidate) => index.lookup(c.providerId)?.names ?? [];
    expect((await run('lionsgate')).candidates).toHaveLength(0);
    const found = await run('lionsgate', aliases);
    expect(found.candidates.map((c) => c.channel.name)).toEqual(['MovieSphere']);
    // Empty query still admits every candidate and never consults aliases.
    let calls = 0;
    expect(
      (
        await run('', (c) => {
          calls++;
          return aliases(c);
        })
      ).candidates,
    ).toHaveLength(2);
    expect(calls).toBe(0);
  });
});

describe('native activation hints', () => {
  it('matches every query word in any published name and reports demoted IDs', () => {
    const index = metadata();
    expect(index.matchIds('lionsgate', 10)).toEqual(['MovieSphere.us']);
    expect(index.matchIds('FOX news', 10)).toEqual(['FoxNews.us']);
    expect(index.matchIds('', 10)).toEqual([]);
    // Over-broad queries yield no partial hint set.
    expect(index.matchIds('fox', 1)).toBeNull();
    expect(index.demotedIds().sort()).toEqual(['Adult.us', 'Blocked.us', 'Moved.us', 'OldNews.us']);
  });
});
