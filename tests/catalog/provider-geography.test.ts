import { expect, it } from 'vitest';
import {
  createProviderGeographyIndex,
  enrichProviderGeography,
  compactProviderCities,
  prepareProviderGeographyDocuments,
} from '../../src/catalog/provider-geography';
import type { ChannelCandidate, Source } from '../../src/catalog/parser';
import { validateCatalog } from '../../src/catalog/codec';
import { prioritizeRegion, regionFromPostalResponse } from '../../src/location/region';

const source: Source = {
  id: 'source',
  name: 'Known provider',
  kind: 'url',
  location: 'https://provider.invalid/catalog',
};
const scope = { allowedSourceLocations: [source.location] };
const candidate = (providerId = 'WMAQ.us@SD'): ChannelCandidate => ({
  sourceId: source.id,
  providerId,
  name: 'Arbitrary display name',
  category: 'News',
  urls: ['https://stream.invalid/live'],
});
const documents = () => ({
  countries: JSON.stringify([
    { code: 'US', name: 'United States' },
    { code: 'CA', name: 'Canada' },
  ]),
  subdivisions: JSON.stringify([
    { code: 'US-IL', country: 'US', name: 'Illinois' },
    { code: 'US-NY', country: 'US', name: 'New York' },
    { code: 'CA-ON', country: 'CA', name: 'Ontario' },
  ]),
  channels: JSON.stringify([
    { id: 'WMAQ.us', country: 'US' },
    { id: 'Foreign.ca', country: 'CA' },
  ]),
  feeds: JSON.stringify([{ channel: 'WMAQ.us', id: 'SD', broadcast_area: ['s/US-IL'] }]),
});

it('joins exact city broadcast codes to their published subdivision before regional ranking', () => {
  const docs = {
    ...documents(),
    cities: JSON.stringify([
      { code: 'USCHI', country: 'US', subdivision: 'US-IL', name: 'Chicago' },
      { code: 'unused', country: 'US', subdivision: 'US-NY', name: 'Unrelated' },
    ]),
  };
  docs.feeds = JSON.stringify([{ channel: 'WMAQ.us', id: 'SD', broadcast_area: ['ct/USCHI'] }]);
  docs.cities = compactProviderCities(docs.cities, docs.feeds);
  expect(JSON.parse(docs.cities)).toEqual([{ code: 'USCHI', country: 'US', subdivision: 'US-IL' }]);
  const result = enrichProviderGeography(
    candidate(),
    source,
    createProviderGeographyIndex(docs),
    scope,
  );
  expect(result.channel.geography).toEqual({ country: 'US', state: 'US-IL' });
  expect(result.issues).toEqual([]);
  const region = regionFromPostalResponse(
    JSON.stringify({ 'country abbreviation': 'US', places: [{ 'state abbreviation': 'IL' }] }),
    'US',
    '60601',
  );
  expect(
    prioritizeRegion(
      [{ geography: { country: 'US' } }, result.channel],
      region,
      (entry) => entry.geography,
    )[0],
  ).toBe(result.channel);
});

it('does not infer unknown cities, multiple subdivisions, or foreign city geography', () => {
  const docs = {
    ...documents(),
    cities: JSON.stringify([
      { code: 'USCHI', country: 'US', subdivision: 'US-IL' },
      { code: 'USNYC', country: 'US', subdivision: 'US-NY' },
      { code: 'CATOR', country: 'CA', subdivision: 'CA-ON' },
    ]),
  };
  for (const areas of [['ct/missing'], ['ct/USCHI', 'ct/USNYC'], ['ct/CATOR']]) {
    docs.feeds = JSON.stringify([{ channel: 'WMAQ.us', id: 'SD', broadcast_area: areas }]);
    expect(createProviderGeographyIndex(docs).lookup('WMAQ.us@SD')?.geography).toEqual({
      country: 'US',
    });
  }
  docs.cities = JSON.stringify([{ code: 'USCHI', country: 'US', subdivision: 'CA-ON' }]);
  expect(() => createProviderGeographyIndex(docs)).toThrow('city subdivision');
});

it('bounds city projection and preserves existing aggregate geography budget', () => {
  expect(() => compactProviderCities(' '.repeat(20 * 1024 * 1024 + 1), '[]')).toThrow('20 MiB');
  expect(() =>
    compactProviderCities('[]', JSON.stringify([{ broadcast_area: Array(257).fill('ct/USCHI') }])),
  ).toThrow('broadcast area');
  expect(() => compactProviderCities('{}', '[]')).toThrow('invalid');
  expect(() =>
    prepareProviderGeographyDocuments(documents(), ' '.repeat(8 * 1024 * 1024 + 1)),
  ).toThrow('8 MiB');
  expect(() =>
    prepareProviderGeographyDocuments(
      { ...documents(), channels: ' '.repeat(20 * 1024 * 1024) },
      '[]',
    ),
  ).toThrow('20 MiB');
  const raw = JSON.stringify([
    { code: 'USCHI', country: 'US', subdivision: 'US-IL', name: 'Chicago' },
  ]);
  const docs = { ...documents(), feeds: JSON.stringify([{ broadcast_area: ['ct/USCHI'] }]) };
  expect(JSON.parse(prepareProviderGeographyDocuments(docs, raw).cities!)).toEqual([
    { code: 'USCHI', country: 'US', subdivision: 'US-IL' },
  ]);
});

it('uses the exact published feed ID and known subdivision to add provenance that survives catalog validation', () => {
  const index = createProviderGeographyIndex(documents());
  const input = candidate();
  const result = enrichProviderGeography(input, source, index, scope);
  expect(input.geography).toBeUndefined();
  expect(result.issues).toEqual([]);
  expect(result.channel.geography).toEqual({ country: 'US', state: 'US-IL' });
  expect(result.channel.geographyProvenance).toEqual([
    {
      field: 'country',
      value: 'US',
      sourceId: 'source',
      providerId: 'WMAQ.us@SD',
      kind: 'provider',
      scope: 'channel-origin',
    },
    {
      field: 'state',
      value: 'US-IL',
      sourceId: 'source',
      providerId: 'WMAQ.us@SD',
      kind: 'provider',
      scope: 'provider-declared',
    },
  ]);
  expect(
    validateCatalog({
      schemaVersion: 1,
      sources: [source],
      channels: [{ ...result.channel, id: 'canonical' }],
    }).channels[0]?.geography,
  ).toEqual(result.channel.geography);
});

it('does not infer feed variants, geography from names, URL hosts, or unadmitted provider namespaces', () => {
  const index = createProviderGeographyIndex(documents());
  expect(
    enrichProviderGeography(candidate('WMAQ.us'), source, index, scope).channel.geography,
  ).toEqual({ country: 'US' });
  for (const providerId of ['WMAQ.us@HD', 'wmaq.us@SD', 'opaque-WMAQ.us@SD']) {
    const input = {
      ...candidate(providerId),
      name: 'Illinois US-IL WMAQ',
      urls: ['https://illinois.invalid/US-IL'],
    };
    expect(enrichProviderGeography(input, source, index, scope)).toEqual({
      channel: input,
      issues: ['provider-not-found'],
    });
  }
  const other = { ...source, location: 'https://unrelated.invalid/catalog' };
  expect(enrichProviderGeography(candidate(), other, index, scope).issues).toEqual([
    'source-not-admitted',
  ]);
  expect(
    enrichProviderGeography(candidate(), { ...source, contentKind: 'hls' }, index, scope).issues,
  ).toEqual(['source-not-admitted']);
});

it('preserves the entire existing declaration on conflict and adds only missing consistent fields', () => {
  const index = createProviderGeographyIndex(documents());
  const input = { ...candidate(), geography: { country: 'US', state: 'US-NY' } };
  const result = enrichProviderGeography(input, source, index, scope);
  expect(result.channel).toBe(input);
  expect(result.issues).toEqual(['declared-geography-conflict']);
  const same = {
    ...candidate(),
    geography: { country: 'US' },
    geographyProvenance: [
      {
        field: 'country' as const,
        value: 'US',
        sourceId: 'source',
        kind: 'm3u' as const,
        scope: 'provider-declared' as const,
      },
    ],
  };
  expect(
    enrichProviderGeography(same, source, index, scope).channel.geographyProvenance?.[0],
  ).toEqual(same.geographyProvenance[0]);
});

it('reports ambiguous, unknown, unsupported and origin-conflicting broadcast areas without inventing a state', () => {
  for (const [areas, issue] of [
    [['s/US-IL', 's/US-NY'], 'ambiguous-broadcast-area'],
    [['s/US-XX'], 'unknown-subdivision'],
    [['r/NAM', 'ct/US-CHI'], 'unsupported-broadcast-area'],
    [['s/CA-ON'], 'inconsistent-geography'],
    [['c/XX'], 'unknown-country'],
  ] as const) {
    const docs = documents();
    docs.feeds = JSON.stringify([{ channel: 'WMAQ.us', id: 'SD', broadcast_area: areas }]);
    const result = enrichProviderGeography(
      candidate(),
      source,
      createProviderGeographyIndex(docs),
      scope,
    );
    expect(result.issues).toContain(issue);
    expect(result.channel.geography).toEqual({ country: 'US' });
  }
});

it('rejects duplicate or inconsistent registry identities and malformed whole documents', () => {
  const docs = documents();
  for (const change of [
    {
      channels: JSON.stringify([
        { id: 'WMAQ.us', country: 'US' },
        { id: 'WMAQ.us', country: 'CA' },
      ]),
    },
    { subdivisions: JSON.stringify([{ code: 'CA-ON', country: 'US' }]) },
    { feeds: JSON.stringify([{ channel: 'missing.us', id: 'SD', broadcast_area: ['c/US'] }]) },
    {
      feeds: JSON.stringify([
        { channel: 'WMAQ.us', id: 'SD', broadcast_area: ['c/US'] },
        { channel: 'WMAQ.us', id: 'SD', broadcast_area: ['c/US'] },
      ]),
    },
    { countries: '[broken' },
  ])
    expect(() => createProviderGeographyIndex({ ...docs, ...change })).toThrow();
});

it('enforces whole 20MiB/100k admission without truncating entries or trusting giant area lists', () => {
  const docs = documents();
  expect(() =>
    createProviderGeographyIndex({ ...docs, countries: ' '.repeat(20 * 1024 * 1024 + 1) }),
  ).toThrow('20 MiB');
  expect(() =>
    createProviderGeographyIndex({
      ...docs,
      channels: JSON.stringify(
        Array.from({ length: 100001 }, () => ({ id: 'bounded.us', country: 'US' })),
      ),
    }),
  ).toThrow('record limit');
  expect(() =>
    createProviderGeographyIndex({
      ...docs,
      feeds: JSON.stringify([
        { channel: 'WMAQ.us', id: 'SD', broadcast_area: Array(257).fill('c/US') },
      ]),
    }),
  ).toThrow('limit');
});

it('does not expose mutable index internals or assume broadcast area from channel-level legacy fields', () => {
  const docs = documents();
  delete (docs as { feeds?: string }).feeds;
  docs.channels = JSON.stringify([{ id: 'WMAQ.us', country: 'US', broadcast_area: ['s/US-IL'] }]);
  const index = createProviderGeographyIndex(docs);
  const first = index.lookup('WMAQ.us');
  (first!.geography as { country: string }).country = 'CA';
  expect(index.lookup('WMAQ.us')?.geography).toEqual({ country: 'US' });
  expect(index.lookup('WMAQ.us@SD')).toBeUndefined();
});

it('normalizes only declared official UK/GB subdivisions, preserving US metadata and exact feed IDs', () => {
  const docs = documents();
  docs.countries = JSON.stringify([...JSON.parse(docs.countries), { code: 'UK' }]);
  docs.subdivisions = JSON.stringify([
    ...JSON.parse(docs.subdivisions),
    { code: 'GB-ENG', country: 'UK' },
  ]);
  docs.channels = JSON.stringify([
    ...JSON.parse(docs.channels),
    { id: 'British.uk', country: 'UK' },
  ]);
  docs.feeds = JSON.stringify([
    ...JSON.parse(docs.feeds),
    { channel: 'British.uk', id: 'SD', broadcast_area: ['s/GB-ENG'] },
  ]);
  const index = createProviderGeographyIndex(docs);
  expect(index.lookup('WMAQ.us@SD')?.geography).toEqual({ country: 'US', state: 'US-IL' });
  expect(index.lookup('British.uk@SD')?.geography).toEqual({ country: 'UK', state: 'UK-ENG' });
  expect(index.lookup('British.uk@sd')).toBeUndefined();
  const enriched = enrichProviderGeography(
    candidate('British.uk@SD'),
    source,
    index,
    scope,
  ).channel;
  expect(enriched.geography).toEqual({ country: 'UK', state: 'UK-ENG' });
  expect(enriched.geographyProvenance?.find((value) => value.field === 'state')?.value).toBe(
    'UK-ENG',
  );
});

it('resolves official UK city subdivision references without accepting arbitrary country-prefix conflicts', () => {
  const docs = {
    ...documents(),
    cities: JSON.stringify([{ code: 'GBLON', country: 'UK', subdivision: 'GB-ENG' }]),
  };
  docs.countries = JSON.stringify([...JSON.parse(docs.countries), { code: 'UK' }]);
  docs.subdivisions = JSON.stringify([
    ...JSON.parse(docs.subdivisions),
    { code: 'GB-ENG', country: 'UK' },
  ]);
  docs.channels = JSON.stringify([
    ...JSON.parse(docs.channels),
    { id: 'British.uk', country: 'UK' },
  ]);
  docs.feeds = JSON.stringify([{ channel: 'British.uk', id: 'SD', broadcast_area: ['ct/GBLON'] }]);
  expect(createProviderGeographyIndex(docs).lookup('British.uk@SD')?.geography).toEqual({
    country: 'UK',
    state: 'UK-ENG',
  });
  docs.subdivisions = JSON.stringify([{ code: 'GB-ENG', country: 'US' }]);
  expect(() => createProviderGeographyIndex(docs)).toThrow('subdivision');
});
