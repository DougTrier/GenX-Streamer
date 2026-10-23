import { expect, it } from 'vitest';
import { allowIncludedHttp, providerScanSources } from '../../src/application/included-sources';
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
