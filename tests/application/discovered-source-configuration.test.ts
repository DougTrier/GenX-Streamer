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

import { expect, it, vi } from 'vitest';
import { prepareDiscoveredSources } from '../../src/application/discovery/discovered-source-configuration';
import { defaultPreferences } from '../../src/preferences';
import type {
  OnlineSourceCandidate,
  OnlineSourceScanResult,
} from '../../src/discovery/online-source-scan';
const option = (n: number, format: 'm3u' | 'xmltv' = 'm3u'): OnlineSourceCandidate => ({
  label: 'lists/source' + n + '.m3u',
  location: 'https://public.fixture.invalid/source' + n,
  provenance: 'https://github.com/fixture/public',
  provenances: ['https://github.com/fixture/public'],
  directoryIds: [1],
  format,
  reason: 'Published metadata only',
  rights: 'unknown',
  documentSha: 'a'.repeat(40),
  allowHttp: false,
});
const result = (
  channels: OnlineSourceCandidate[] = [],
  guides: OnlineSourceCandidate[] = [],
): OnlineSourceScanResult => ({ query: 'FOX', startedAtMs: 1000, channels, guides, outcomes: [] });
const factory = () => {
  let n = 0;
  return vi.fn(() => 'new-' + ++n);
};
it('purely prepares explicit discoveries and separate provenance; channel sources allow HTTP', () => {
  const prefs = { ...defaultPreferences(), unknownUserChoice: { kept: true } },
    before = structuredClone(prefs),
    ids = factory();
  const prepared = prepareDiscoveredSources(prefs, result([option(1)], [option(2, 'xmltv')]), ids);
  expect(prefs).toEqual(before);
  expect(prepared.preferences.unknownUserChoice).toEqual({ kept: true });
  expect(prepared.preferences.reviewedChannelProviders).toEqual([
    {
      id: 'new-1',
      name: option(1).label,
      location: option(1).location,
      provenance: option(1).provenance,
      // Included channel sources allow plain HTTP channels by default.
      allowHttp: true,
    },
  ]);
  expect(prepared.preferences.reviewedGuideProviders![0]).not.toHaveProperty('allowHttp');
  expect(prepared.preferences.reviewedGuideProviders![0]!.limitations).toContain(
    'have not been verified',
  );
  expect(prepared.audit.map((a) => a.action)).toEqual(['added', 'added']);
  expect(JSON.stringify(prepared.preferences)).not.toContain('documentSha');
});
it('deduplicates exact locations preserving old IDs grants and all metadata provenance', () => {
  const old = {
    id: 'old',
    name: 'User label',
    location: option(1).location,
    provenance: 'https://publisher.fixture.invalid/old',
    allowHttp: true,
  };
  const prefs = {
    ...defaultPreferences(),
    reviewedChannelProviders: [old],
    favorites: ['favorite'],
    removedChannels: ['removed'],
  };
  const duplicate = {
    ...option(1),
    provenance: 'https://github.com/fixture/second',
    provenances: ['https://github.com/fixture/second'],
    directoryIds: [2],
  };
  const ids = factory(),
    prepared = prepareDiscoveredSources(prefs, result([option(1), duplicate, option(3)]), ids);
  expect(prepared.preferences.reviewedChannelProviders![0]).toEqual(old);
  expect(prepared.preferences.favorites).toEqual(['favorite']);
  expect(prepared.preferences.removedChannels).toEqual(['removed']);
  expect(ids).toHaveBeenCalledTimes(1);
  expect(prepared.audit[0]).toMatchObject({
    providerId: 'old',
    action: 'existing',
    directoryIds: [1, 2],
    provenances: [option(1).provenance, duplicate.provenance],
  });
});
it('empty discovery never clears existing explicit configuration', () => {
  const prefs = {
      ...defaultPreferences(),
      reviewedChannelProviders: [
        {
          id: 'old',
          name: 'Old',
          location: option(1).location,
          provenance: option(1).provenance,
          allowHttp: false,
        },
      ],
    },
    ids = factory();
  expect(prepareDiscoveredSources(prefs, result(), ids).preferences).toEqual(prefs);
  expect(ids).not.toHaveBeenCalled();
});
it.each(['channel', 'guide'] as const)(
  'refuses %s overflow atomically without dropping old choices',
  (kind) => {
    const prefs = defaultPreferences();
    const providers = Array.from({ length: kind === 'guide' ? 1000 : 100 }, (_, i) => ({
      id: 'old-' + i,
      name: 'Old',
      location: option(i).location,
      provenance: option(i).provenance,
      ...(kind === 'channel' ? { allowHttp: false } : { limitations: 'Unknown coverage' }),
    }));
    if (kind === 'channel') prefs.reviewedChannelProviders = providers;
    else
      prefs.reviewedGuideProviders = providers as NonNullable<typeof prefs.reviewedGuideProviders>;
    const before = structuredClone(prefs),
      ids = factory();
    expect(() =>
      prepareDiscoveredSources(
        prefs,
        result(
          kind === 'channel' ? [option(101)] : [],
          kind === 'guide' ? [option(1001, 'xmltv')] : [],
        ),
        ids,
      ),
    ).toThrow('limits');
    expect(prefs).toEqual(before);
    expect(ids).not.toHaveBeenCalled();
  },
);
it.each(['duplicate', 'old', 'malformed'] as const)(
  'refuses %s generated IDs without partial mutation',
  (kind) => {
    const prefs = {
        ...defaultPreferences(),
        reviewedChannelProviders: [
          {
            id: 'old',
            name: 'Old',
            location: option(0).location,
            provenance: option(0).provenance,
            allowHttp: false,
          },
        ],
      },
      before = structuredClone(prefs);
    expect(() =>
      prepareDiscoveredSources(prefs, result([option(1), option(2)]), () =>
        kind === 'duplicate' ? 'same' : kind === 'old' ? 'old' : 'bad\n',
      ),
    ).toThrow();
    expect(prefs).toEqual(before);
  },
);
it('uses bounded display names without changing exact source identity', () => {
  const long = { ...option(1), label: 'folder/'.repeat(80) + 'source.m3u' };
  const prepared = prepareDiscoveredSources(defaultPreferences(), result([long]), factory());
  expect(prepared.preferences.reviewedChannelProviders![0]!.name).toBe('source.m3u');
  expect(prepared.preferences.reviewedChannelProviders![0]!.location).toBe(long.location);
});
it.each(['http', 'userinfo', 'grant', 'guide-format'] as const)(
  'refuses unsafe %s suggestions before publishing configuration',
  (kind) => {
    const bad = {
      ...option(1),
      ...(kind === 'http'
        ? { location: 'http://public.fixture.invalid/catalog' }
        : kind === 'userinfo'
          ? { location: 'https://user:secret@public.fixture.invalid/catalog' }
          : kind === 'grant'
            ? { allowHttp: true }
            : { format: 'xmltv' }),
    } as OnlineSourceCandidate;
    const prefs = defaultPreferences(),
      ids = factory();
    expect(() => prepareDiscoveredSources(prefs, result([bad]), ids)).toThrow();
    expect(prefs.reviewedChannelProviders).toEqual([]);
    expect(ids).not.toHaveBeenCalled();
  },
);
