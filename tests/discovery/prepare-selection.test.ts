import { describe, expect, it } from 'vitest';
import { prepareSelectedScan } from '../../src/discovery/prepare-selection';
import { defaultPreferences } from '../../src/preferences';
import type { CatalogRecord, Source } from '../../src/catalog';
import type { StagedScanSelection } from '../../src/discovery/scan';
const source: Source = {
  id: 'source',
  name: 'My source',
  kind: 'url',
  location: 'https://source.test/list',
};
const old: CatalogRecord = {
  schemaVersion: 1,
  sources: [source],
  channels: [
    {
      id: 'saved',
      sourceId: 'source',
      providerId: 'one',
      name: 'Old One',
      category: 'News',
      urls: ['https://media.test/old'],
    },
    {
      id: 'unselected',
      sourceId: 'source',
      providerId: 'two',
      name: 'Keep Two',
      category: 'Sports',
      urls: ['https://media.test/two'],
    },
  ],
};
const selection: StagedScanSelection = {
  sessionRevision: 'revision',
  failedSourceIds: [],
  sources: [
    {
      sourceId: 'source',
      fingerprint: 'fingerprint',
      candidates: [
        {
          sourceId: 'source',
          providerId: 'one',
          name: 'Updated One',
          category: 'News',
          urls: ['https://media.test/new'],
        },
        {
          sourceId: 'source',
          providerId: 'three',
          name: 'Add Three',
          category: 'News',
          urls: ['https://media.test/three'],
        },
      ],
    },
  ],
};
describe('selected scan preparation', () => {
  it('updates stable identity and preserves unselected records, favorites and removal choices', () => {
    const prefs = {
      ...defaultPreferences(),
      sources: [source],
      favorites: ['saved'],
      removedChannels: ['saved'],
    };
    const prepared = prepareSelectedScan(old, prefs, selection, [
      { source, fingerprint: 'fingerprint' },
    ]);
    expect(prepared.record.catalog.channels).toHaveLength(3);
    expect(prepared.record.catalog.channels.find((c) => c.id === 'saved')?.name).toBe(
      'Updated One',
    );
    expect(prepared.record.catalog.channels.find((c) => c.id === 'unselected')).toEqual(
      old.channels[1],
    );
    expect(prepared.record.preferences.favorites).toEqual(['saved']);
    expect(prepared.record.preferences.removedChannels).toEqual(['saved']);
    expect(old.channels[0].name).toBe('Old One');
  });
  it('retains failed sources and publishes only an explicitly selected new source', () => {
    const draft = { ...source, id: 'new', name: 'New source' };
    const next = {
      ...selection,
      failedSourceIds: ['source'],
      sources: [
        {
          sourceId: 'new',
          fingerprint: 'new-fingerprint',
          candidates: [{ ...selection.sources[0].candidates[0], sourceId: 'new' }],
        },
      ],
    };
    const prepared = prepareSelectedScan(old, defaultPreferences(), next, [
      { source: draft, fingerprint: 'new-fingerprint' },
    ]);
    expect(prepared.record.catalog.channels.filter((c) => c.sourceId === 'source')).toEqual(
      old.channels,
    );
    expect(prepared.record.catalog.sources).toHaveLength(2);
    expect(prepared.record.preferences.sources).toEqual(prepared.record.catalog.sources);
  });
  it('refuses stale scope, cross-source candidates and failed-source replacement', () => {
    expect(() =>
      prepareSelectedScan(old, defaultPreferences(), selection, [
        { source, fingerprint: 'changed' },
      ]),
    ).toThrow();
    expect(() =>
      prepareSelectedScan(
        old,
        defaultPreferences(),
        { ...selection, failedSourceIds: ['source'] },
        [{ source, fingerprint: 'fingerprint' }],
      ),
    ).toThrow();
    const foreign = structuredClone(selection);
    foreign.sources[0].candidates[0].sourceId = 'foreign';
    expect(() =>
      prepareSelectedScan(old, defaultPreferences(), foreign, [
        { source, fingerprint: 'fingerprint' },
      ]),
    ).toThrow();
  });
  it('refuses ungranted HTTP rather than weakening source policy', () => {
    const http = structuredClone(selection);
    http.sources[0].candidates[0].urls = ['http://media.test/plain'];
    expect(() =>
      prepareSelectedScan(old, defaultPreferences(), http, [
        { source, fingerprint: 'fingerprint' },
      ]),
    ).toThrow();
  });
});
