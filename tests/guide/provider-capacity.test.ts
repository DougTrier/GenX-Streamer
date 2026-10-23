import { expect, it, vi } from 'vitest';
import { defaultPreferences } from '../../src/preferences';
import { prepareDiscoveredSources } from '../../src/application/discovered-source-configuration';
import { captureAutomaticGuide } from '../../src/application/automatic-guide-capture';
import { createSourceIndexService } from '../../src/discovery/source-index-service';
import { sourceDocumentUrl } from '../../src/discovery/source-index';
import { createOnlineSourceScan } from '../../src/discovery/online-source-scan';
import {
  parseProviderRegistry,
  serializeProviderRegistry,
} from '../../src/discovery/provider-registry';
import { discoverPlaylistGuides } from '../../src/guide/discovery';
import { createAutomaticGuideBuilder } from '../../src/guide/automatic-build';

const repo = {
  id: 1,
  owner: 'fixture',
  name: 'published',
  branch: 'main',
  provenance: 'https://github.com/fixture/published',
};
async function discover(count: number) {
  const service = createSourceIndexService({
    async json(url) {
      if (url.endsWith('/repositories/1'))
        return {
          id: 1,
          private: false,
          owner: { login: repo.owner },
          name: repo.name,
          full_name: 'fixture/published',
          default_branch: 'main',
          html_url: repo.provenance,
        };
      const path = url === sourceDocumentUrl(repo, 'epglist.txt') ? 'epglist.txt' : 'README.md';
      const body =
        path === 'README.md'
          ? 'https://fixture.invalid/catalog.m3u'
          : Array.from(
              { length: count },
              (_, i) => `https://fixture.invalid/guide-${i}.xml.gz`,
            ).join('\n');
      return {
        type: 'file',
        path,
        name: path,
        url,
        encoding: 'base64',
        sha: 'a'.repeat(40),
        size: body.length,
        content: btoa(body),
      };
    },
  });
  const owner = createOnlineSourceScan(service, [1]);
  try {
    return await owner.start({ query: 'FOX' }, new AbortController().signal);
  } finally {
    await owner.dispose();
    await service.dispose();
  }
}
it.each([101, 1000])(
  'admits %i declared guides through index, configuration roundtrip, capture, discovery and sequential builder',
  async (count) => {
    const result = await discover(count);
    expect(result.channels).toHaveLength(1);
    expect(result.guides).toHaveLength(count);
    let id = 0;
    const { preferences } = prepareDiscoveredSources(
      defaultPreferences(),
      result,
      () => `id-${++id}`,
    );
    const roundtrip = parseProviderRegistry(
      serializeProviderRegistry({
        schemaVersion: 1,
        reviewedChannelProviders: preferences.reviewedChannelProviders!,
        reviewedGuideProviders: preferences.reviewedGuideProviders!,
      }),
    );
    expect(roundtrip.reviewedGuideProviders).toHaveLength(count);
    const captured = captureAutomaticGuide({
      catalog: null,
      preferences: JSON.stringify(preferences),
      catalogRevision: '7',
    });
    expect(captured.registry).toHaveLength(count);
    const inspect = vi.fn();
    const discovered = await discoverPlaylistGuides([], inspect, new AbortController().signal, {
      registry: captured.registry,
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(discovered.candidates).toHaveLength(count);
    let active = 0,
      peak = 0,
      checked = 0;
    const builder = createAutomaticGuideBuilder({
      capture: async () => ({
        catalogRevision: '7',
        channelCount: 1,
        providers: discovered.candidates.map((p) => ({
          name: p.name,
          location: p.location,
          allowHttp: false,
        })),
      }),
      isCurrent: () => true,
      canRun: () => true,
      preview: async () => {
        active++;
        peak = Math.max(peak, active);
        checked++;
        await Promise.resolve();
        active--;
        return { ticket: `ticket-${checked}`, sourceRevision: 1 };
      },
      commitMatched: async () => ({ committed: false, matched: 0, unmatched: 1 }),
      discard: async () => undefined,
    });
    expect(await builder.run()).toMatchObject({ checked: count, connected: 0 });
    expect(peak).toBe(1);
    await builder.dispose();
  },
);
it('refuses all 1001 guide-index entries without hiding separately admitted channels', async () => {
  const result = await discover(1001);
  expect(result.channels).toHaveLength(1);
  expect(result.guides).toHaveLength(0);
  expect(result.documentOutcomes?.[0]?.status).toBe('failed');
});
it('retains the registry byte limit even for fewer than 1000 valid guide descriptors', () => {
  const guides = Array.from({ length: 600 }, (_, i) => ({
    id: `g-${i}`,
    name: 'Guide',
    location: `https://fixture.invalid/${i}`,
    provenance: repo.provenance,
    limitations: 'x'.repeat(2048),
  }));
  expect(() =>
    serializeProviderRegistry({
      schemaVersion: 1,
      reviewedChannelProviders: [],
      reviewedGuideProviders: guides,
    }),
  ).toThrow('1 MiB');
});
