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
  allowIncludedHttp,
  providerScanSources,
} from '../../src/application/discovery/included-sources';
import { emptyCatalog, type Source } from '../../src/catalog';
import { defaultPreferences } from '../../src/preferences';

const source = (id: string, location: string, allowHttp = false): Source => ({
  id,
  name: id,
  kind: 'url',
  location,
  allowHttp,
});
const included = source('included', 'https://included.fixture.invalid/list.m3u');
const custom = source('custom', 'https://custom.fixture.invalid/list.m3u');
const setup = () => {
  const preferences = {
    ...defaultPreferences(),
    sources: [included, custom],
    reviewedChannelProviders: [
      {
        id: 'included',
        name: 'Included',
        location: included.location,
        provenance: 'https://directory.fixture.invalid/',
        allowHttp: false,
      },
      {
        id: 'unsaved',
        name: 'Unsaved',
        location: 'https://unsaved.fixture.invalid/list.m3u',
        provenance: 'https://directory.fixture.invalid/',
        allowHttp: false,
      },
    ],
  };
  return { catalog: { ...emptyCatalog(), sources: [included, custom] }, preferences };
};

it('allows HTTP for included sources only, in both saved records, without mutating them', () => {
  const { catalog, preferences } = setup();
  const before = structuredClone({ catalog, preferences });
  const next = allowIncludedHttp(catalog, preferences)!;
  expect({ catalog, preferences }).toEqual(before);
  expect(next.catalog.sources.map((s) => [s.id, s.allowHttp])).toEqual([
    ['included', true],
    ['custom', false],
  ]);
  expect(next.preferences.sources.map((s) => [s.id, s.allowHttp])).toEqual([
    ['included', true],
    ['custom', false],
  ]);
  expect(next.preferences.reviewedChannelProviders!.map((p) => p.allowHttp)).toEqual([true, true]);
  // Applied once: the adopted records need no further write.
  expect(allowIncludedHttp(next.catalog, next.preferences)).toBeNull();
});

it('scans with the adopted grant for saved and not-yet-saved included sources', () => {
  const { catalog, preferences } = setup();
  const next = allowIncludedHttp(catalog, preferences)!;
  expect(
    providerScanSources(next.catalog, next.preferences).map((s) => [s.id, s.allowHttp]),
  ).toEqual([
    ['included', true],
    ['custom', false],
    ['unsaved', true],
  ]);
});
