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

import { expect, it } from 'vitest';
import { defaultPreferences, importPreferences } from '../../src/preferences';
import { parseCatalog, type CatalogRecord } from '../../src/catalog';
import {
  createProviderGeographyIndex,
  enrichProviderGeography,
} from '../../src/catalog/provider-geography';
import { scanConfiguredSources, stageScanSelection } from '../../src/discovery/scan';
import { reorderScanCandidates } from '../../src/discovery/scan-priority';
import { prepareSelectedScan } from '../../src/discovery/prepare-selection';
import { parseScanCheckpoint, serializeScanCheckpoint } from '../../src/discovery/scan-checkpoint';
import { validateRecordPair } from '../../src/platform/record-transaction';
import { checkpointFixture } from '../discovery/helpers/scan-checkpoint';

const region = { country: 'US', state: 'US-IL', origin: 'manual' as const };
const metadata = createProviderGeographyIndex({
  countries: JSON.stringify([
    { code: 'US', name: 'United States' },
    { code: 'CA', name: 'Canada' },
  ]),
  subdivisions: JSON.stringify([{ code: 'US-IL', country: 'US', name: 'Illinois' }]),
  channels: JSON.stringify([
    { id: 'Local.us', country: 'US' },
    { id: 'National.us', country: 'US' },
    { id: 'Foreign.ca', country: 'CA' },
  ]),
  feeds: JSON.stringify([
    { channel: 'Local.us', id: 'SD', broadcast_area: ['s/US-IL'] },
    { channel: 'National.us', id: 'SD', broadcast_area: ['c/US'] },
    { channel: 'Foreign.ca', id: 'SD', broadcast_area: ['c/CA'] },
  ]),
});

it('fresh region-first scan batch enriches existing Unknown identities and admits catalog/preferences together without losing user choices', async () => {
  const checkpoint = await checkpointFixture();
  const source = checkpoint.sourceDefinitions[0].source;
  const scope = [{ source, fingerprint: 'fresh' }];
  const channels = ['Foreign.ca@SD', 'National.us@SD', 'Local.us@SD'].map((providerId, index) => ({
    id: `saved-${index}`,
    sourceId: source.id,
    providerId,
    name: `Station ${index}`,
    category: 'News',
    urls: [`https://fixture.invalid/${index}`],
  }));
  const original: CatalogRecord = { schemaVersion: 1, sources: [source], channels };
  const before = structuredClone(original);
  const preferences = {
    ...defaultPreferences(),
    sources: [source],
    favorites: ['saved-2'],
    removedChannels: ['saved-2', 'saved-0'],
  };
  const review = reorderScanCandidates(
    await scanConfiguredSources(
      scope,
      async () => ({
        channels: channels.map(
          ({ id: _id, ...candidate }) =>
            enrichProviderGeography(candidate, source, metadata, {
              allowedSourceLocations: [source.location],
            }).channel,
        ),
        warnings: [],
      }),
      { sessionRevision: 'fresh-revision', query: '', signal: new AbortController().signal },
    ),
    region,
  );
  expect(review.candidates.map((item) => item.channel.providerId)).toEqual([
    'Local.us@SD',
    'National.us@SD',
    'Foreign.ca@SD',
  ]);
  // First controlled responsive batch contains only the local candidate; other saved channels must survive.
  const staged = stageScanSelection(review, [review.candidates[0].key], review.sessionRevision);
  const prepared = prepareSelectedScan(original, preferences, staged, scope);
  const pair = validateRecordPair({
    catalog: prepared.catalogText,
    preferences: prepared.preferencesText,
  });
  const admitted = parseCatalog(pair.catalog);
  const savedPreferences = importPreferences(pair.preferences);
  expect(admitted.channels.map((item) => item.id)).toEqual(channels.map((item) => item.id));
  expect(admitted.channels.find((item) => item.id === 'saved-2')?.geography).toEqual({
    country: 'US',
    state: 'US-IL',
  });
  expect(admitted.channels.find((item) => item.id === 'saved-2')?.geographyProvenance).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ field: 'state', value: 'US-IL', providerId: 'Local.us@SD' }),
    ]),
  );
  expect(admitted.channels.filter((item) => item.id !== 'saved-2')).toEqual(
    channels.filter((item) => item.id !== 'saved-2'),
  );
  expect(savedPreferences.favorites).toEqual(['saved-2']);
  expect(savedPreferences.removedChannels).toEqual(['saved-2', 'saved-0']);
  expect(original).toEqual(before);
  expect(preferences.removedChannels).toEqual(['saved-2', 'saved-0']);
});

it('restored checkpoint keeps captured Unknown geography; only fresh collection adopts newly available metadata', async () => {
  const captured = await checkpointFixture();
  const candidate = captured.review.candidates[0];
  candidate.channel.providerId = 'Local.us@SD';
  const serialized = await serializeScanCheckpoint(captured);
  const restored = await parseScanCheckpoint(serialized);
  const source = restored.sourceDefinitions[0].source;
  expect(restored.review.candidates[0].channel.geography).toBeUndefined();
  const resumed = reorderScanCandidates(restored.review, region);
  expect(resumed.candidates[0].channel.geography).toBeUndefined();
  const fresh = await scanConfiguredSources(
    [{ source, fingerprint: 'new-collection' }],
    async () => ({
      channels: [
        enrichProviderGeography(restored.review.candidates[0].channel, source, metadata, {
          allowedSourceLocations: [source.location],
        }).channel,
      ],
      warnings: [],
    }),
    { sessionRevision: 'new-revision', query: '', signal: new AbortController().signal },
  );
  expect(fresh.candidates[0].channel.geography).toEqual({ country: 'US', state: 'US-IL' });
  expect(fresh.candidates[0].sourceFingerprint).toBe('new-collection');
  expect(restored.review.candidates[0].channel.geography).toBeUndefined();
  expect(captured.review.candidates[0].channel.geography).toBeUndefined();
});
