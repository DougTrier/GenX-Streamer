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
import {
  captureAutomaticGuide,
  validateAutomaticGuideCapture,
  automaticGuidePreferenceKey,
} from '../../src/application/automatic-guide-capture';
import { defaultPreferences } from '../../src/preferences';
import { emptyCatalog, type CatalogRecord } from '../../src/catalog';
function saved() {
  const catalog: CatalogRecord = {
    schemaVersion: 1,
    sources: [
      {
        id: 'source',
        name: 'Saved sports',
        kind: 'url',
        location: 'https://fixture.invalid/catalog',
      },
    ],
    channels: [
      'PGATour.us@SD',
      'CBSSportsGolazoNetwork.us@SD',
      'WorldPokerTour.us@US',
      'PGATour.us',
    ].map((providerId, index) => ({
      id: `app-${index}`,
      sourceId: 'source',
      providerId,
      name: 'Unrelated label',
      category: 'Sports',
      urls: ['https://fixture.invalid/media'],
    })),
  };
  const preferences = {
    ...defaultPreferences(),
    sources: catalog.sources,
    removedChannels: ['app-1'],
    preferredRegion: { country: 'US', state: 'US-IL', postal: '00501', origin: 'manual' as const },
  };
  return {
    catalog,
    preferences,
    snapshot: {
      catalog: JSON.stringify(catalog),
      preferences: JSON.stringify(preferences),
      catalogRevision: '7',
    },
  };
}
it('captures exact saved identity and removals while omitting full channels from worker reply', () => {
  const { snapshot, preferences } = saved();
  const result = captureAutomaticGuide(snapshot);
  expect(result.catalogRevision).toBe('7');
  expect(result.channelCount).toBe(3);
  expect(result.aliases[0]?.pairs.map((p) => p.appChannelId)).toEqual(['app-0', 'app-2']);
  expect(result.aliases[0]?.pairs[0]?.providerId).toBe('PGATour.us@SD');
  expect(result.preferredRegion).toEqual(preferences.preferredRegion);
  expect(result.preferenceKey).toBe(automaticGuidePreferenceKey(preferences));
  expect(result).not.toHaveProperty('channels');
  expect(result).not.toHaveProperty('catalog');
});
it('preserves user-empty providers instead of silently restoring defaults', () => {
  const { snapshot, preferences } = saved();
  preferences.reviewedGuideProviders = [];
  const result = captureAutomaticGuide({ ...snapshot, preferences: JSON.stringify(preferences) });
  expect(result.registry).toEqual([]);
});
it('retains automatic Off through worker validation so manual guide work remains available', () => {
  const { snapshot, preferences } = saved();
  const disabled = { ...preferences, automaticGuideUpdates: false };
  const result = captureAutomaticGuide({ ...snapshot, preferences: JSON.stringify(disabled) });
  expect(result.automaticGuideUpdates).toBe(false);
  expect(result.preferenceKey).toBe(automaticGuidePreferenceKey(disabled));
  expect(validateAutomaticGuideCapture(result)).toEqual(result);
  expect(() => validateAutomaticGuideCapture({ ...result, automaticGuideUpdates: true })).toThrow(
    'inconsistent',
  );
});
it('normalizes legacy absence to enabled while rejecting malformed worker policy', () => {
  const { snapshot, preferences } = saved();
  const { automaticGuideUpdates: _legacyAbsent, ...legacy } = preferences;
  const result = captureAutomaticGuide({ ...snapshot, preferences: JSON.stringify(legacy) });
  expect(result.automaticGuideUpdates).toBe(true);
  for (const automaticGuideUpdates of [undefined, null, 'false', 0])
    expect(() => validateAutomaticGuideCapture({ ...result, automaticGuideUpdates })).toThrow();
});
it('admits true empty legacy pair and refuses corrupt individual records', () => {
  expect(
    captureAutomaticGuide({ catalog: null, preferences: null, catalogRevision: '0' }).channelCount,
  ).toBe(0);
  const { snapshot } = saved();
  expect(() => captureAutomaticGuide({ ...snapshot, catalog: '{bad' })).toThrow();
  expect(() => captureAutomaticGuide({ ...snapshot, preferences: '{bad' })).toThrow();
  expect(() =>
    captureAutomaticGuide({
      ...snapshot,
      catalog: JSON.stringify({
        ...emptyCatalog(),
        channels: [{ id: 'orphan', sourceId: 'missing' }],
      }),
    }),
  ).toThrow();
});
it('rejects byte-bound overflow and invalid UTF-16 rather than truncating saved records', () => {
  const { snapshot } = saved();
  expect(() =>
    captureAutomaticGuide({ ...snapshot, catalog: 'x'.repeat(20 * 1024 * 1024 + 1) }),
  ).toThrow();
  expect(() =>
    captureAutomaticGuide({ ...snapshot, preferences: 'é'.repeat(11 * 1024 * 1024) }),
  ).toThrow();
  expect(() =>
    captureAutomaticGuide({ ...snapshot, catalog: String.fromCharCode(0xd800) }),
  ).toThrow();
});
it('rejects noncanonical and above-i64 durable revision identities on both boundaries', () => {
  const { snapshot } = saved();
  const capture = captureAutomaticGuide(snapshot);
  for (const revision of ['', '-1', '01', '1.5', '9223372036854775808', '9999999999999999999']) {
    expect(() => captureAutomaticGuide({ ...snapshot, catalogRevision: revision })).toThrow();
    expect(() =>
      validateAutomaticGuideCapture({ ...capture, catalogRevision: revision }),
    ).toThrow();
  }
  expect(
    captureAutomaticGuide({ ...snapshot, catalogRevision: '9223372036854775807' }).catalogRevision,
  ).toBe('9223372036854775807');
});
it('uses canonical catalog identities despite a harmless stale preference source mirror', () => {
  const { snapshot, preferences } = saved();
  preferences.sources = [
    {
      id: 'stale-source',
      name: 'Stale mirror',
      kind: 'url',
      location: 'https://obsolete.invalid/catalog',
    },
  ];
  const captured = captureAutomaticGuide({ ...snapshot, preferences: JSON.stringify(preferences) });
  expect(captured.sources.map((source) => source.id)).toEqual(['source']);
  expect(captured.aliases[0]?.pairs.every((pair) => pair.catalogSourceId === 'source')).toBe(true);
  expect(captured.channelCount).toBe(3);
});
it('independently refuses malformed worker reply counts, keys, aliases and encoded bounds', () => {
  const result = captureAutomaticGuide(saved().snapshot);
  for (const channelCount of [-1, 100001, 0.5, NaN])
    expect(() => validateAutomaticGuideCapture({ ...result, channelCount })).toThrow();
  expect(() => validateAutomaticGuideCapture({ ...result, preferenceKey: 'obsolete' })).toThrow();
  expect(() =>
    validateAutomaticGuideCapture({ ...result, aliases: [...result.aliases, ...result.aliases] }),
  ).toThrow();
  const forged = {
    ...result,
    aliases: result.aliases.map((alias) => ({ ...alias, provenanceSha256: '0'.repeat(64) })),
  };
  expect(() => validateAutomaticGuideCapture(forged)).toThrow();
  expect(() =>
    validateAutomaticGuideCapture({ ...result, extra: 'x'.repeat(8 * 1024 * 1024) }),
  ).toThrow();
});
it('derives bounded catalog countries from declared geography and provider ID suffixes', () => {
  const { catalog, preferences } = saved();
  catalog.channels.push(
    {
      id: 'uk',
      sourceId: 'source',
      providerId: 'BBCOne.uk@London',
      name: 'BBC One',
      category: '',
      urls: ['https://fixture.invalid/uk'],
    },
    {
      id: 'geo',
      sourceId: 'source',
      name: 'Declared',
      category: '',
      urls: ['https://fixture.invalid/ca'],
      geography: { country: 'CA' },
    },
    {
      id: 'gone',
      sourceId: 'source',
      providerId: 'Removed.fr',
      name: 'Removed',
      category: '',
      urls: ['https://fixture.invalid/fr'],
    },
    {
      id: 'odd',
      sourceId: 'source',
      providerId: 'NoCountry',
      name: 'Odd',
      category: '',
      urls: ['https://fixture.invalid/x'],
    },
  );
  preferences.removedChannels = [...preferences.removedChannels, 'gone'];
  const captured = captureAutomaticGuide({
    catalog: JSON.stringify(catalog),
    preferences: JSON.stringify(preferences),
    catalogRevision: '4',
  });
  expect(captured.catalogCountries).toEqual(['CA', 'UK', 'US']);
  expect(() =>
    validateAutomaticGuideCapture({ ...captured, catalogCountries: ['united states'] }),
  ).toThrow();
});
