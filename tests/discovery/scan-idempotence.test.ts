import { describe, expect, it } from 'vitest';
import {
  scanConfiguredSources,
  scanReconciliationScopes,
  stageScanSelection,
  type ScanReview,
} from '../../src/discovery/scan';
import { prepareSelectedScan } from '../../src/discovery/prepare-selection';
import {
  channelReconciliationScope,
  reconcileChannels,
  type ChannelCandidate,
} from '../../src/catalog/parser';
import type { CatalogRecord } from '../../src/catalog';
import { defaultPreferences } from '../../src/preferences';

const source = {
  id: 'source',
  name: 'Source',
  kind: 'url' as const,
  location: 'https://source.test/list',
};
const scope = [{ source, fingerprint: 'fingerprint' }];
const channel = (url: string, extra: Partial<ChannelCandidate> = {}): ChannelCandidate => ({
  sourceId: source.id,
  providerId: 'one',
  name: 'Station',
  category: 'Sports',
  urls: [`https://media.test/${url}`],
  ...extra,
});
const empty = (): CatalogRecord => ({ schemaVersion: 1, sources: [source], channels: [] });
async function review(channels: ChannelCandidate[], revision = 'one') {
  return scanConfiguredSources(scope, async () => ({ channels, warnings: [] }), {
    sessionRevision: revision,
    query: '',
    signal: new AbortController().signal,
  });
}
function save(
  catalog: CatalogRecord,
  captured: ScanReview,
  indices = captured.candidates.map((_, i) => i),
) {
  const batch = { ...captured, candidates: indices.map((i) => captured.candidates[i]!) };
  return prepareSelectedScan(
    catalog,
    {
      ...defaultPreferences(),
      sources: [source],
      favorites: catalog.channels.map((c) => c.id),
      removedChannels: catalog.channels.map((c) => c.id),
    },
    stageScanSelection(
      batch,
      batch.candidates.map((c) => c.key),
      captured.sessionRevision,
      scanReconciliationScopes(captured),
    ),
    scope,
  ).record;
}
describe('scan reconciliation across publication batches', () => {
  it('deduplicates repeated entries and preserves IDs on a fresh review', async () => {
    const first = await review([channel('a'), channel('a')]);
    expect(first.candidates).toHaveLength(1);
    const saved = save(empty(), first).catalog;
    const next = save(saved, await review([channel('a')], 'two'));
    expect(next.catalog.channels).toEqual(saved.channels);
    expect(next.preferences.favorites).toEqual([saved.channels[0].id]);
    expect(next.preferences.removedChannels).toEqual([saved.channels[0].id]);
  });
  it('keeps full-review variants distinct across split batches and repeat scans', async () => {
    const captured = await review([channel('a'), channel('b')]);
    const a = save(empty(), captured, [0]).catalog;
    const both = save(a, captured, [1]).catalog;
    expect(both.channels).toHaveLength(2);
    expect(new Set(both.channels.map((c) => c.id)).size).toBe(2);
    const repeated = save(save(both, captured, [0]).catalog, captured, [1]).catalog;
    expect(repeated.channels).toEqual(both.channels);
    expect(save(empty(), captured).catalog.channels.map((c) => c.urls)).toEqual(
      both.channels.map((c) => c.urls),
    );
  });
  it('retains omitted geography and provenance for unchanged variants', async () => {
    const geo = {
      geography: { country: 'US' },
      geographyProvenance: [
        {
          field: 'country' as const,
          value: 'US',
          sourceId: 'source',
          providerId: 'one',
          kind: 'm3u' as const,
          scope: 'channel-origin' as const,
        },
      ],
    };
    const previous = save(empty(), await review([channel('a', geo), channel('b', geo)])).catalog;
    const next = save(previous, await review([channel('a'), channel('b')])).catalog;
    expect(next.channels).toEqual(previous.channels);
  });
  it('never uses conflicting declared geography as an exact variant match', () => {
    const candidate = channel('a', { geography: { country: 'CA' } });
    const previous = [{ ...channel('a', { geography: { country: 'US' } }), id: 'old' }];
    const descriptor = channelReconciliationScope([candidate, channel('b')], 'source');
    expect(reconcileChannels([candidate], previous, () => 'new', descriptor)[0].id).toBe('new');
  });
  it('stops growth of existing identical copies without deleting their IDs or choices', async () => {
    const previous = {
      ...empty(),
      channels: [
        { ...channel('a'), id: 'z' },
        { ...channel('a'), id: 'a' },
      ],
    };
    const captured = await review([channel('a')]);
    const next = save(previous, captured);
    expect(next.catalog.channels).toEqual(previous.channels);
    expect(next.preferences.favorites).toEqual(['z', 'a']);
    expect(next.preferences.removedChannels).toEqual(['z', 'a']);
    expect(save(next.catalog, captured).catalog.channels).toHaveLength(2);
    const manual = stageScanSelection(
      captured,
      captured.candidates.map((c) => c.key),
      captured.sessionRevision,
    );
    expect(
      prepareSelectedScan(previous, { ...defaultPreferences(), sources: [source] }, manual, scope)
        .record.catalog.channels,
    ).toEqual(previous.channels);
    expect(
      reconcileChannels(
        [channel('a')],
        previous.channels,
        () => 'new',
        scanReconciliationScopes(captured).get('source'),
      )[0].id,
    ).toBe('a');
  });
  it('retains unique provider URL rotation and source-scoped identity', () => {
    const prior = [{ ...channel('old'), id: 'saved' }];
    expect(
      reconcileChannels(
        [channel('new')],
        prior,
        () => 'new',
        channelReconciliationScope([channel('new')], 'source'),
      )[0].id,
    ).toBe('saved');
    expect(
      reconcileChannels([channel('old', { sourceId: 'other' })], prior, () => 'new')[0].id,
    ).not.toBe('saved');
  });
  it('rejects foreign and malformed descriptors before reconciliation', () => {
    const descriptor = channelReconciliationScope([channel('a')], 'source');
    expect(() =>
      reconcileChannels([channel('a')], [], () => 'new', { ...descriptor, sourceId: 'foreign' }),
    ).toThrow();
    expect(() =>
      reconcileChannels([channel('a')], [], () => 'new', {
        ...descriptor,
        ambiguousProviderKeys: ['["source","one"]', '["source","one"]'],
      }),
    ).toThrow();
  });
});
