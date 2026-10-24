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

import researchProviders from '../../docs/research-reviewed-providers.json';
import { expect, it } from 'vitest';
import {
  buildReviewedGuideAliases,
  validateReviewedGuideAliases,
} from '../../src/guide/reviewed-aliases';
import { defaultProviderRegistry } from '../../src/discovery/provider-registry';
import { defaultPreferences, validatePreferences } from '../../src/preferences';
import type { CatalogRecord } from '../../src/catalog/codec';
const location = 'https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/PlutoTV/us.xml.gz';
function catalog(count = 3): CatalogRecord {
  const ids = ['PGATour.us@SD', 'CBSSportsGolazoNetwork.us@SD', 'WorldPokerTour.us@US'];
  return {
    schemaVersion: 1,
    sources: [
      { id: 'one', name: 'One', kind: 'url', location: 'https://fixture.invalid/playlist' },
      { id: 'two', name: 'Two', kind: 'file', location: 'chosen.m3u' },
    ],
    channels: Array.from({ length: count }, (_, index) => ({
      id: `app-${index}`,
      sourceId: index % 2 ? 'two' : 'one',
      providerId: ids[index % 3],
      name: 'Same unrelated label',
      category: 'Sports',
      urls: ['https://fixture.invalid/live'],
    })),
  };
}
it('binds three exact full provider identifiers to scoped canonical channels without names', () => {
  const result = buildReviewedGuideAliases(location, catalog(), []);
  expect(result?.pairs).toEqual([
    {
      catalogSourceId: 'one',
      appChannelId: 'app-0',
      providerId: 'PGATour.us@SD',
      xmltvChannelId: '5de94dacb394a300099fa22a',
    },
    {
      catalogSourceId: 'two',
      appChannelId: 'app-1',
      providerId: 'CBSSportsGolazoNetwork.us@SD',
      xmltvChannelId: '63a0e33a45264d000850ed7e',
    },
    {
      catalogSourceId: 'one',
      appChannelId: 'app-2',
      providerId: 'WorldPokerTour.us@US',
      xmltvChannelId: '5616f9c0ada51f8004c4b091',
    },
  ]);
  expect(buildReviewedGuideAliases(`${location}?variant=other`, catalog(), [])).toBeUndefined();
  expect(
    buildReviewedGuideAliases('https://different.invalid/us.xml.gz', catalog(), []),
  ).toBeUndefined();
});
it('refuses name/suffix/case guesses and excludes removed channels', () => {
  const value = catalog(5);
  value.channels[0]!.providerId = 'PGATour.us';
  value.channels[1]!.providerId = 'cbssportsgolazonetwork.us@SD';
  value.channels[2]!.providerId = 'WorldPokerTour.us@SD';
  expect(
    buildReviewedGuideAliases(location, value, ['app-3'])?.pairs.map((pair) => pair.appChannelId),
  ).toEqual(['app-4']);
});
it('captures immutable copies and preserves multiple exact stream identities across sources', () => {
  const value = catalog(4);
  const result = buildReviewedGuideAliases(location, value, [])!;
  value.channels[0]!.providerId = 'changed';
  value.channels[3]!.id = 'changed';
  expect(result.pairs[0]!.providerId).toBe('PGATour.us@SD');
  expect(result.pairs[3]!.appChannelId).toBe('app-3');
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.pairs)).toBe(true);
  expect(Object.isFrozen(result.pairs[0])).toBe(true);
});
it('rejects malformed catalog source references and duplicate canonical channels', () => {
  const value = catalog();
  value.channels[0]!.sourceId = 'missing';
  expect(() => buildReviewedGuideAliases(location, value, [])).toThrow();
  value.channels[0]!.sourceId = 'one';
  value.channels[1]!.id = value.channels[0]!.id;
  expect(() => buildReviewedGuideAliases(location, value, [])).toThrow();
});
it('fails whole admission at pair and byte bounds rather than truncating', () => {
  expect(buildReviewedGuideAliases(location, catalog(1024), [])?.pairs).toHaveLength(1024);
  expect(() => buildReviewedGuideAliases(location, catalog(1025), [])).toThrow();
  const value = catalog(40);
  value.channels.forEach((channel, index) => {
    channel.id = `${index}-${'x'.repeat(16000)}`;
  });
  expect(() => buildReviewedGuideAliases(location, value, [])).toThrow();
});
it('validates installed authority and exact pair schema rather than trusting supplied provenance', () => {
  const valid = buildReviewedGuideAliases(location, catalog(), [])!;
  for (const changes of [
    { guideLocation: `${location}?edit=1` },
    { provenanceSha256: 'a'.repeat(64) },
    { schemaVersion: 2 },
    { unknown: true },
    { pairs: [{ ...valid.pairs[0], xmltvChannelId: 'other' }] },
    { pairs: [{ ...valid.pairs[0], providerId: 'PGATour.us' }] },
    { pairs: [valid.pairs[0], valid.pairs[0]] },
    { pairs: [{ ...valid.pairs[0], extra: 'untrusted' }] },
  ]) {
    expect(() => validateReviewedGuideAliases({ ...valid, ...changes })).toThrow();
  }
  expect(() =>
    validateReviewedGuideAliases(Object.assign(Object.create({ inherited: true }), valid)),
  ).toThrow();
  expect(validateReviewedGuideAliases(JSON.parse(JSON.stringify(valid)))).toEqual(valid);
});
it('has no fresh guide providers and preserves existing user-approved or explicit empty choices', () => {
  expect(defaultProviderRegistry().reviewedGuideProviders).toEqual([]);
  const previous = researchProviders.reviewedGuideProviders.filter(
    (provider) => provider.id !== 'pluto-us-reviewed',
  );
  expect(
    validatePreferences({ ...defaultPreferences(), reviewedGuideProviders: previous })
      .reviewedGuideProviders,
  ).toEqual(previous);
  expect(
    validatePreferences({ ...defaultPreferences(), reviewedGuideProviders: [] })
      .reviewedGuideProviders,
  ).toEqual([]);
});
