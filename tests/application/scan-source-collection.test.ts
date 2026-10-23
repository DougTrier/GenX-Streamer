import { describe, expect, it } from 'vitest';
import { createScanSourceCollector } from '../../src/application/scan-source-collection';
import {
  compactDiscoveryMetadata,
  discoveryMetadata,
} from '../../src/discovery/discovery-metadata';
import type { ParsedPlaylist, Source } from '../../src/catalog/parser';
import type { ScanReview } from '../../src/discovery/scan';

const sources = {
  countries: 'https://meta.invalid/countries',
  channels: 'https://meta.invalid/channels',
  subdivisions: 'https://meta.invalid/subdivisions',
  feeds: 'https://meta.invalid/feeds',
  cities: 'https://meta.invalid/cities',
  blocklist: 'https://meta.invalid/blocklist',
};
const freeTv: Source = {
  id: 'free',
  name: 'Free',
  kind: 'url',
  location: 'https://example.invalid/playlist.m3u8',
};
function harness(options: { failMetadata?: boolean } = {}) {
  const fetched: string[] = [];
  const scope = [{ source: { ...freeTv } }];
  const collector = createScanSourceCollector({
    inspectSource: async () => ({ kind: 'catalog', text: '#EXTM3U', mime: 'audio/x-mpegurl' }),
    parse: async (): Promise<ParsedPlaylist> => ({
      channels: [
        {
          name: 'Label',
          category: 'Movies',
          sourceId: 'free',
          urls: ['https://a.invalid/1'],
          providerId: 'MovieSphere.us',
        },
      ],
      warnings: [],
    }),
    fetchText: async (url) => {
      fetched.push(url);
      if (options.failMetadata) throw new Error('offline');
      if (url === sources.blocklist) return '[]';
      return JSON.stringify([
        { id: 'MovieSphere.us', name: 'MovieSphere', alt_names: ['MovieSphere by Lionsgate'] },
      ]);
    },
    buildMetadata: async (channels, blocklist) =>
      discoveryMetadata(compactDiscoveryMetadata(channels, blocklist)),
    own: async (parsed) => parsed,
    scope: () => scope,
    region: () => undefined,
    metadataSources: sources,
  });
  return { collector, fetched, scope };
}
const signal = () => new AbortController().signal;

describe('scan source collector', () => {
  it('reads published metadata once per scan and exposes aliases for matching', async () => {
    const { collector, fetched } = harness();
    await collector.collect(freeTv, signal());
    await collector.collect(freeTv, signal());
    expect(fetched).toEqual([sources.channels, sources.blocklist]);
    const channel = {
      name: 'Label',
      category: '',
      sourceId: 'free',
      urls: [],
      providerId: 'MovieSphere.us@SD',
    };
    expect(collector.aliases(channel)).toContain('MovieSphere by Lionsgate');
    // Releasing raw documents after collection keeps compact metadata for ranking.
    collector.release();
    expect(collector.aliases(channel)).toContain('MovieSphere');
    collector.reset();
    expect(collector.aliases(channel)).toEqual([]);
  });
  it('degrades to the established behavior when metadata is unavailable', async () => {
    const { collector } = harness({ failMetadata: true });
    const parsed = await collector.collect(freeTv, signal());
    expect(parsed.channels).toHaveLength(1);
    expect(collector.aliases(parsed.channels[0]!)).toEqual([]);
    const review: ScanReview = {
      sessionRevision: 'r',
      query: '',
      status: 'completed',
      sources: [],
      candidates: [],
      counts: { inspected: 0, matched: 0, failedSources: 0, canceledSources: 0 },
    };
    expect(collector.prioritize(review)).toEqual(review);
  });
  it('records the inspected content kind on the captured scope entry', async () => {
    const { collector, scope } = harness();
    await collector.collect(freeTv, signal());
    expect(scope[0]!.source.contentKind).toBe('catalog');
    expect(scope[0]!.source.mediaMime).toBe('audio/x-mpegurl');
  });
});

describe('indexed activation hints', () => {
  it('sends whole hint sets only when metadata is available', async () => {
    const { collector } = harness();
    expect(await collector.discoveryHints('lionsgate', signal())).toEqual({
      aliasProviderIds: ['MovieSphere.us'],
    });
    expect(await collector.discoveryHints('nothing matches', signal())).toEqual({});
    const offline = harness({ failMetadata: true }).collector;
    expect(await offline.discoveryHints('lionsgate', signal())).toEqual({});
  });
});
