/*
 * Copyright 2026 Doug Trier
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { describe, expect, it } from 'vitest';
import { parseM3u, reconcileChannels } from '../../src/catalog/parser';
import { parseCatalog, serializeCatalog } from '../../src/catalog/codec';
import { createBackup, serializeBackup, prepareBackupImport } from '../../src/data-transfer';
import { defaultPreferences } from '../../src/preferences';
import { prepareSelectedScan } from '../../src/discovery/prepare-selection';
import {
  compareGeographicChannels,
  createGeographyRegistry,
  geographyLabel,
  matchesGeography,
  resolveProviderGeography,
  validateGeography,
  type GeographicChannel,
} from '../../src/catalog/geography';
const data = {
  countries: [
    { code: 'US', name: 'United States' },
    { code: 'CA', name: 'Canada' },
  ],
  regions: [{ code: 'NORAM', name: 'North America', countries: ['US', 'CA'] }],
  states: [
    { code: 'US-IL', country: 'US', name: 'Illinois' },
    { code: 'CA-ON', country: 'CA', name: 'Ontario' },
  ],
};
const registry = createGeographyRegistry(data);
describe('explicit channel geography', () => {
  it('round trips declarations through reconciliation and canonical export without losing fields on refresh', () => {
    const playlist = (tags: string) =>
      `#EXTM3U\n#EXTINF:-1 tvg-id="station" ${tags},Station\nhttps://fixture.invalid/live`;
    const parsed = parseM3u(
      playlist('tvg-country="us" tvg-region="noram" tvg-state="us-il"'),
      'source',
    );
    const channels = reconcileChannels(parsed.channels, []);
    const saved = parseCatalog(
      serializeCatalog({
        schemaVersion: 1,
        sources: [
          { id: 'source', name: 'Source', kind: 'url', location: 'https://fixture.invalid/list' },
        ],
        channels,
      }),
    );
    expect(saved.channels[0]?.geography).toEqual({
      country: 'US',
      region: 'NORAM',
      state: 'US-IL',
    });
    expect(saved.channels[0]?.geographyProvenance).toHaveLength(3);
    const refreshed = reconcileChannels(parseM3u(playlist(''), 'source').channels, saved.channels);
    expect(refreshed[0]?.geography).toEqual(saved.channels[0]?.geography);
    expect(refreshed[0]?.geographyProvenance).toEqual(saved.channels[0]?.geographyProvenance);
    expect(refreshed[0]?.id).toBe(saved.channels[0]?.id);
    const preferences = {
      ...defaultPreferences(),
      sources: saved.sources,
      favorites: [saved.channels[0]!.id],
    };
    const restored = prepareBackupImport(serializeBackup(createBackup(saved, preferences)));
    expect(restored.record.catalog.channels[0]?.geographyProvenance).toEqual(
      saved.channels[0]?.geographyProvenance,
    );
    const staged = prepareSelectedScan(
      saved,
      preferences,
      {
        sessionRevision: 'review',
        sources: [
          {
            sourceId: 'source',
            fingerprint: 'revision',
            candidates: parseM3u(playlist(''), 'source').channels,
          },
        ],
        failedSourceIds: [],
      },
      [{ source: saved.sources[0]!, fingerprint: 'revision' }],
    );
    expect(staged.record.catalog.channels[0]?.geography).toEqual(saved.channels[0]?.geography);
    expect(staged.record.preferences.favorites).toEqual(preferences.favorites);
  });
  it('keeps malformed or multi-country declarations Unknown with safe warnings and no name inference', () => {
    const parsed = parseM3u(
      '#EXTM3U\n#EXTINF:-1 tvg-country="US;CA" tvg-state="US-IL",Chicago United States\nhttps://fixture.invalid/live',
      'source',
    );
    expect(parsed.channels[0]?.geography).toBeUndefined();
    expect(parsed.warnings).toHaveLength(2);
    expect(parsed.warnings.join(' ')).not.toContain('https:');
  });
  it('rejects cross-source, mismatching and oversized provenance at the record boundary', () => {
    const base = {
      schemaVersion: 1,
      sources: [
        { id: 'source', name: 'Source', kind: 'url', location: 'https://fixture.invalid/list' },
      ],
      channels: [
        {
          id: 'station',
          sourceId: 'source',
          name: 'Station',
          category: '',
          urls: ['https://fixture.invalid/live'],
          geography: { country: 'US' },
          geographyProvenance: [
            {
              field: 'country',
              value: 'US',
              sourceId: 'other',
              kind: 'm3u',
              scope: 'provider-declared',
            },
          ],
        },
      ],
    };
    expect(() => parseCatalog(JSON.stringify(base))).toThrow('provenance');
    base.channels[0]!.geographyProvenance[0]!.sourceId = 'source';
    base.channels[0]!.geographyProvenance[0]!.value = 'CA';
    expect(() => parseCatalog(JSON.stringify(base))).toThrow('provenance');
  });
  it('maps exact provider origin and explicit state with scoped provenance', () => {
    const result = resolveProviderGeography(
      {
        sourceId: 'source-a',
        providerId: 'WFLD.us',
        providerChannel: { id: 'WFLD.us', country: 'US' },
        attributes: { 'tvg-state': 'us-il' },
      },
      registry,
    );
    expect(result.geography).toEqual({ country: 'US', region: 'NORAM', state: 'US-IL' });
    expect(result.provenance.map((p) => [p.field, p.kind, p.scope, p.sourceId])).toEqual([
      ['country', 'provider', 'channel-origin', 'source-a'],
      ['state', 'm3u', 'provider-declared', 'source-a'],
      ['region', 'registry', 'country-group', 'source-a'],
    ]);
    expect(result.issues).toEqual([]);
  });
  it('never guesses from identifiers, names, IP addresses or unknown metadata', () => {
    expect(
      resolveProviderGeography({ sourceId: 'source', providerId: 'Chicago.us' }, registry)
        .geography,
    ).toEqual({});
    const result = resolveProviderGeography(
      {
        sourceId: 'source',
        providerId: 'one',
        providerChannel: { id: 'other', country: 'US' },
        attributes: { 'tvg-country': 'ZZ', 'tvg-state': 'US-XX' },
      },
      registry,
    );
    expect(result.geography).toEqual({});
    expect(result.issues).toEqual(['provider-mismatch', 'unknown-country', 'unknown-state']);
  });
  it('does not choose the first country or first overlapping region', () => {
    expect(
      resolveProviderGeography(
        { sourceId: 'source', attributes: { 'tvg-country': 'US;CA' } },
        registry,
      ).geography,
    ).toEqual({});
    const overlap = createGeographyRegistry({
      ...data,
      regions: [...data.regions, { code: 'AMER', name: 'Americas', countries: ['US', 'CA'] }],
    });
    const result = resolveProviderGeography(
      { sourceId: 'source', attributes: { 'tvg-country': 'US' } },
      overlap,
    );
    expect(result.geography).toEqual({ country: 'US' });
    expect(result.issues).toContain('ambiguous-region');
  });
  it('rejects canonical inconsistent, unknown, unnormalized and extra fields', () => {
    for (const value of [
      { country: 'US', state: 'CA-ON' },
      { country: 'us' },
      { country: 'ZZ' },
      { state: 'US-IL' },
      { country: 'US', cdn: 'private' },
    ])
      expect(() => validateGeography(value, registry)).toThrow();
    expect(validateGeography({}, registry)).toEqual({});
    expect(() =>
      createGeographyRegistry({ ...data, countries: [...data.countries, data.countries[0]!] }),
    ).toThrow();
    expect(() =>
      createGeographyRegistry({
        ...data,
        regions: [{ code: 'BAD', name: 'Bad', countries: ['ZZ'] }],
      }),
    ).toThrow();
  });
  it('retains origin when contradictory provider-declared geography is encountered', () => {
    const result = resolveProviderGeography(
      {
        sourceId: 'source',
        providerId: 'id',
        providerChannel: { id: 'id', country: 'US' },
        attributes: { 'tvg-country': 'CA', 'tvg-state': 'CA-ON' },
      },
      registry,
    );
    expect(result.geography).toEqual({ country: 'US', region: 'NORAM' });
    expect(result.issues).toContain('inconsistent-geography');
    expect(result.provenance.some((p) => p.field === 'state')).toBe(false);
  });
  it('sorts deterministic country/region/state/name with stable source/ID ties and Unknown last', () => {
    const records: GeographicChannel[] = [
      {
        sourceId: 'b',
        id: '2',
        name: 'FOX',
        geography: { country: 'US', region: 'NORAM', state: 'US-IL' },
      },
      {
        sourceId: 'a',
        id: '2',
        name: 'FOX',
        geography: { country: 'US', region: 'NORAM', state: 'US-IL' },
      },
      { sourceId: 'a', id: '1', name: 'Unknown' },
      { sourceId: 'a', id: 'ca', name: 'Zulu', geography: { country: 'CA' } },
      { sourceId: 'a', id: 'us', name: 'Alpha', geography: { country: 'US' } },
    ];
    const sort = (values: GeographicChannel[]) =>
      values
        .sort((a, b) => compareGeographicChannels(a, b, registry))
        .map((c) => c.sourceId + '/' + c.id);
    expect(sort([...records])).toEqual(['a/ca', 'a/2', 'b/2', 'a/us', 'a/1']);
    expect(sort([...records].reverse())).toEqual(sort([...records]));
    expect(compareGeographicChannels(records[0]!, records[0]!, registry)).toBe(0);
  });
  it('filters All and Unknown separately while preserving repeated provider identities', () => {
    const channel = {
      id: 'id',
      sourceId: 'source',
      name: 'Station',
      geography: { country: 'US', state: 'US-IL' },
    };
    expect(matchesGeography(channel, {})).toBe(true);
    expect(matchesGeography(channel, { country: 'US', region: null, state: 'US-IL' })).toBe(true);
    expect(matchesGeography(channel, { country: null })).toBe(false);
    expect(matchesGeography(channel, { country: 'CA' })).toBe(false);
    expect(
      matchesGeography({ id: 'id', sourceId: 'other', name: 'Station' }, { country: null }),
    ).toBe(true);
    expect(geographyLabel('country', undefined, registry, 'Not supplied')).toBe('Not supplied');
  });
  it('copies registry memberships and applies explicit metadata bounds', () => {
    const local = { ...data, regions: [{ code: 'LOCAL', name: 'Local', countries: ['US'] }] };
    const copied = createGeographyRegistry(local);
    local.regions[0]!.countries.push('CA');
    expect(copied.regions.get('LOCAL')?.countries).toEqual(['US']);
    expect(() =>
      resolveProviderGeography(
        { sourceId: 'source', attributes: { 'tvg-country': 'x'.repeat(257) } },
        registry,
      ),
    ).toThrow();
    expect(() =>
      createGeographyRegistry({
        ...data,
        states: Array.from({ length: 10001 }, () => data.states[0]!),
      }),
    ).toThrow();
  });
});
