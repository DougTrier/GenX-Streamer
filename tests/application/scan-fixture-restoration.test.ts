import { describe, expect, it } from 'vitest';
import {
  admitScanFixtureRestoration,
  restorationFailureCode,
  // @ts-expect-error The root-executed JavaScript helper has no declaration file.
} from '../../scripts/scan-fixture-restoration.mjs';

const source = {
  id: 'fixture-source',
  kind: 'url',
  name: 'Owned fixture',
  location: 'http://127.0.0.1:4000/catalog.m3u',
  allowHttp: true,
};
const descriptors = Array.from({ length: 80 }, (_, index) => ({
  providerId: `fixture-${index}`,
  name: `Fixture ${index}`,
  url: `http://127.0.0.1:4000/channel/${index}/index.m3u8`,
}));
const fixture = {
  name: source.name,
  location: source.location,
  allowHttp: true,
  channels: descriptors,
};
const originalCatalog = {
  schemaVersion: 1,
  sources: [
    {
      id: 'user',
      kind: 'url',
      name: 'User',
      location: 'https://user.invalid/list',
      allowHttp: false,
    },
  ],
  channels: [
    {
      id: 'saved',
      sourceId: 'user',
      name: 'Saved',
      urls: ['https://user.invalid/stream'],
      category: 'News',
    },
  ],
  metadata: { retained: true },
};
const preferences = {
  sources: originalCatalog.sources,
  favorites: ['saved'],
  removed: ['removed'],
  refresh: 'off',
};
const oldHealth = {
  schemaVersion: 1,
  records: [{ channelId: 'saved', sourceId: 'user', platform: 'android', status: 'Reachable' }],
};
const original = {
  catalog: JSON.stringify(originalCatalog),
  preferences: JSON.stringify(preferences),
  health: JSON.stringify(oldHealth),
  catalogRevision: '5',
  healthRevision: '6',
};
function current(count = 0, sourceAdded = true) {
  const channels = descriptors.slice(0, count).map((entry, index) => ({
    id: `added-${index}`,
    sourceId: source.id,
    providerId: entry.providerId,
    name: entry.name,
    urls: [entry.url],
    category: 'Fixture',
  }));
  const catalog = {
    ...originalCatalog,
    sources: [...originalCatalog.sources, ...(sourceAdded ? [source] : [])],
    channels: [...originalCatalog.channels, ...channels],
  };
  return {
    catalog: JSON.stringify(catalog),
    preferences: JSON.stringify({ ...preferences, sources: catalog.sources }),
    health: JSON.stringify({
      ...oldHealth,
      records: [
        ...oldHealth.records,
        ...channels.map((channel) => ({
          sourceId: source.id,
          channelId: channel.id,
          platform: 'android',
          status: 'Reachable',
        })),
      ],
    }),
    catalogRevision: '9',
    healthRevision: '10',
    checkpointRevision: '11',
  };
}
function mutate(
  pair: ReturnType<typeof current>,
  field: 'catalog' | 'preferences' | 'health',
  change: (value: {
    sources: Record<string, unknown>[];
    channels: { id: string; name: string; providerId: string; urls: string[]; category: string }[];
    metadata: { retained: boolean };
    favorites: string[];
    removed: string[];
    records: { sourceId: string; status: string }[];
  }) => void,
) {
  const value = JSON.parse(pair[field]);
  change(value);
  return { ...pair, [field]: JSON.stringify(value) };
}
function refused(pair: ReturnType<typeof current>, code: string) {
  try {
    admitScanFixtureRestoration(original, pair, fixture);
    throw new Error('Expected refusal');
  } catch (error) {
    expect(restorationFailureCode(error)).toBe(code);
    expect(String(error)).not.toContain('http');
  }
}
describe('read-only scan fixture restoration admission', () => {
  it.each([0, 16, 80])(
    'admits source-only/partial/full %i and uses fresh revisions without mutation',
    (count) => {
      const pair = current(count),
        before = JSON.stringify(pair);
      const admitted = admitScanFixtureRestoration(original, pair, fixture);
      expect(admitted.channelIds).toHaveLength(count);
      expect(admitted).toMatchObject({
        sourceId: source.id,
        expectedCatalogRevision: '9',
        expectedHealthRevision: '10',
        expectedCheckpointRevision: '11',
      });
      expect(JSON.stringify(pair)).toBe(before);
      expect(Object.isFrozen(admitted.channelIds)).toBe(true);
    },
  );
  it('preserves a zero-addition baseline', () => {
    expect(
      admitScanFixtureRestoration(original, { ...original, checkpointRevision: '0' }, fixture),
    ).toMatchObject({ sourceId: null, channelIds: [], expectedCatalogRevision: '5' });
  });
  it('rejects foreign source names, locations, grants, and extra sources', () => {
    for (const [key, value] of [
      ['name', 'Foreign'],
      ['location', 'http://foreign.invalid/catalog'],
      ['allowHttp', false],
    ] as const)
      refused(
        mutate(current(1), 'catalog', (c) => {
          c.sources[1][key] = value;
        }),
        'fixture-source-mismatch',
      );
    refused(
      mutate(current(1), 'catalog', (c) => {
        c.sources.push({ ...source, id: 'other' });
      }),
      'fixture-source-mismatch',
    );
  });
  it('rejects unknown tuple, duplicate tuple under another ID, or alternate URLs', () => {
    refused(
      mutate(current(1), 'catalog', (c) => {
        c.channels[1].providerId = 'foreign';
      }),
      'fixture-channel-mismatch',
    );
    refused(
      mutate(current(1), 'catalog', (c) => {
        c.channels.push({ ...c.channels[1], id: 'duplicate' });
      }),
      'fixture-channel-mismatch',
    );
    refused(
      mutate(current(1), 'catalog', (c) => {
        c.channels[1].urls.push('http://foreign.invalid/alternate');
      }),
      'fixture-channel-mismatch',
    );
  });
  it('rejects original metadata changes, removed originals, duplicate IDs, and order changes', () => {
    refused(
      mutate(current(1), 'catalog', (c) => {
        c.channels[0].name = 'Changed';
      }),
      'original-rows-changed',
    );
    refused(
      mutate(current(1), 'catalog', (c) => {
        c.channels.shift();
      }),
      'original-rows-changed',
    );
    refused(
      mutate(current(1), 'catalog', (c) => {
        c.channels.push(c.channels[0]);
      }),
      'duplicate-or-invalid-row',
    );
    refused(
      mutate(current(1), 'catalog', (c) => {
        c.metadata.retained = false;
      }),
      'catalog-metadata-changed',
    );
  });
  it('preserves favorites/removals and nonfixture health', () => {
    refused(
      mutate(current(1), 'preferences', (p) => {
        p.favorites = [];
      }),
      'preferences-changed',
    );
    refused(
      mutate(current(1), 'preferences', (p) => {
        p.removed = [];
      }),
      'preferences-changed',
    );
    refused(
      mutate(current(1), 'health', (h) => {
        h.records[0].status = 'Unavailable';
      }),
      'health-changed',
    );
    refused(
      mutate(current(1), 'health', (h) => {
        h.records[1].sourceId = 'user';
      }),
      'fixture-health-mismatch',
    );
  });
  it('rejects duplicated health and regressed or malformed CAS revisions', () => {
    refused(
      mutate(current(1), 'health', (h) => {
        h.records.push(h.records[1]);
      }),
      'fixture-health-mismatch',
    );
    refused({ ...current(), catalogRevision: '4' }, 'revision-regressed');
    refused({ ...current(), healthRevision: '01' }, 'invalid-revision');
  });
  it('requires unique expected descriptors and exact category', () => {
    expect(() =>
      admitScanFixtureRestoration(original, current(1), {
        ...fixture,
        channels: [descriptors[0], descriptors[0]],
      }),
    ).toThrow('Scan fixture restoration refused.');
    refused(
      mutate(current(1), 'catalog', (c) => {
        c.channels[1].category = 'Sports';
      }),
      'fixture-channel-mismatch',
    );
  });
  it('refuses reordered original rows even when their IDs and data are unchanged', () => {
    const catalog = {
      ...originalCatalog,
      channels: [...originalCatalog.channels, { ...originalCatalog.channels[0], id: 'second' }],
    };
    const before = { ...original, catalog: JSON.stringify(catalog) };
    const after = {
      ...before,
      catalog: JSON.stringify({ ...catalog, channels: [...catalog.channels].reverse() }),
    };
    expect(() => admitScanFixtureRestoration(before, after, fixture)).toThrow(
      'Scan fixture restoration refused.',
    );
  });
  it('admits a 13256-row full scan without dropping a row', () => {
    const large = Array.from({ length: 13256 }, (_, index) => ({
      providerId: `large-${index}`,
      name: `Large ${index}`,
      url: `http://127.0.0.1:4000/channel/${index}/index.m3u8`,
    }));
    const pair = current(0);
    const catalog = JSON.parse(pair.catalog);
    catalog.channels.push(
      ...large.map((entry, index) => ({
        id: `large-id-${index}`,
        sourceId: source.id,
        providerId: entry.providerId,
        name: entry.name,
        urls: [entry.url],
        category: 'Fixture',
      })),
    );
    const result = admitScanFixtureRestoration(
      original,
      { ...pair, catalog: JSON.stringify(catalog) },
      { ...fixture, channels: large },
    );
    expect(result.channelIds).toHaveLength(13256);
    expect(result.channelIds[13255]).toBe('large-id-13255');
  });
});
