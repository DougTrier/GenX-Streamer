import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  applyCatalogPatch,
  deriveCatalogPatch,
  type CatalogPatch,
} from '../../src/discovery/catalog-patch';
import {
  prepareOwnedCompactScanCommit,
  prepareOwnedScanCommit,
} from '../../src/discovery/prepare-selection';
import { emptyCatalog, parseCatalog, type CatalogRecord, type Source } from '../../src/catalog';
import { defaultPreferences } from '../../src/preferences';
import type { StagedScanSelection } from '../../src/discovery/scan';
import { prepareCompactScanInWorker } from '../../src/discovery/selection';

const source: Source = {
  id: 's',
  name: 'Source',
  kind: 'url',
  location: 'https://catalog.test/list',
};
const channel = (index: number) => ({
  id: `saved-${index}`,
  sourceId: source.id,
  providerId: `provider-${index}`,
  name: `Channel ${index}`,
  category: 'Sports',
  urls: [`https://media.test/${index}`],
});
const base = (): CatalogRecord => ({
  schemaVersion: 1,
  sources: [source],
  channels: [channel(0), channel(1)],
});
const selection = (count = 1): StagedScanSelection => ({
  sessionRevision: '7',
  failedSourceIds: [],
  sources: [
    {
      sourceId: source.id,
      fingerprint: 'fingerprint',
      candidates: Array.from({ length: count }, (_, index) => ({
        ...channel(index),
        name: `New ${index}`,
        urls: [`https://media.test/rotated-${index}`],
      })),
    },
  ],
});
const scope = [{ source, fingerprint: 'fingerprint' }];
const prefs = () => ({
  ...defaultPreferences(),
  sources: [source],
  favorites: ['saved-0'],
  removedChannels: ['saved-1'],
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('compact scan reply parity and admission', () => {
  it('matches full preparation including health, normalized sources, favorites and removals', async () => {
    const initial = base(),
      preferences = prefs();
    const before = structuredClone({ initial, preferences });
    const health = { previousHealth: [] };
    const full = await prepareOwnedScanCommit(initial, preferences, selection(), scope, health);
    const compact = await prepareOwnedCompactScanCommit(
      initial,
      preferences,
      selection(),
      scope,
      health,
    );
    expect(compact.catalogText).toBe(full.catalogText);
    expect(compact.preferencesText).toBe(full.preferencesText);
    expect(compact.healthText).toBe(full.healthText);
    expect(compact.preferences).toEqual(full.record.preferences);
    expect(applyCatalogPatch(initial, compact.catalogPatch, [source])).toEqual(full.record.catalog);
    expect(compact).not.toHaveProperty('record');
    expect({ initial, preferences }).toEqual(before);
  });

  it('preserves stable old ordinals and appends exact new IDs/sources in prepared order', async () => {
    const initial = base();
    const second: Source = { id: 'second', name: 'File', kind: 'file', location: 'captured.m3u' };
    const next: CatalogRecord = {
      schemaVersion: 1,
      sources: [source, second],
      channels: [
        { ...channel(0), name: 'Updated' },
        channel(1),
        { ...channel(2), id: 'new', sourceId: second.id },
      ],
    };
    const patch = deriveCatalogPatch(initial, next);
    const applied = applyCatalogPatch(initial, patch, [source, second]);
    expect(applied).toEqual(next);
    expect(applied.channels[1]).toBe(initial.channels[1]);
    expect(applied.channels.map((c) => c.id)).toEqual(['saved-0', 'saved-1', 'new']);
    expect(applyCatalogPatch(initial, patch, [source, second])).toEqual(applied);
  });

  it('removes the full13k structured object reply while retaining native serialized admission', async () => {
    const initial: CatalogRecord = {
      schemaVersion: 1,
      sources: [source],
      channels: Array.from({ length: 13000 }, (_, i) => channel(i)),
    };
    const compact = await prepareOwnedCompactScanCommit(initial, prefs(), selection(64), scope);
    expect(compact.catalogPatch.channels).toHaveLength(64);
    expect(JSON.stringify(compact.catalogPatch).length).toBeLessThan(
      JSON.stringify(initial).length / 20,
    );
    const applied = applyCatalogPatch(initial, compact.catalogPatch, [source]);
    expect(applied).toEqual(parseCatalog(compact.catalogText));
    expect(applied.channels).toHaveLength(13000);
    expect(applied.channels[12999]).toBe(initial.channels[12999]);
    expect(compact.preferences.favorites).toEqual(['saved-0']);
    expect(compact.preferences.removedChannels).toEqual(['saved-1']);
  });

  it('normalizes granted source MIME exactly without permitting a new grant', async () => {
    const definition = { ...source, mediaMime: 'Application/X-MpegURL' };
    const compact = await prepareOwnedCompactScanCommit(base(), prefs(), selection(), [
      { source: definition, fingerprint: 'fingerprint' },
    ]);
    expect(
      applyCatalogPatch(base(), compact.catalogPatch, [definition]).sources[0]?.mediaMime,
    ).toBe('application/x-mpegurl');
    expect(() =>
      applyCatalogPatch(base(), compact.catalogPatch, [{ ...definition, allowHttp: true }]),
    ).toThrow();
  });

  it('rejects removal, reordering and source retarget during derivation', () => {
    const initial = base();
    for (const next of [
      { ...initial, channels: [channel(0)] },
      { ...initial, channels: [channel(1), channel(0)] },
      { ...initial, channels: [{ ...channel(0), sourceId: 'foreign' }, channel(1)] },
      { ...initial, sources: [] },
    ])
      expect(() => deriveCatalogPatch(initial, next)).toThrow();
  });

  it('rejects forged counts, duplicate updates, foreign ownership, protocol/grant and extra fields', () => {
    const initial = base();
    const valid = deriveCatalogPatch(initial, {
      ...initial,
      channels: [{ ...channel(0), name: 'Updated' }, channel(1)],
    });
    const cases: CatalogPatch[] = [
      { ...valid, baseChannelCount: 3 },
      { ...valid, finalChannelCount: 3 },
      { ...valid, finalSourceCount: 0 },
      { ...valid, channels: [valid.channels[0]!, valid.channels[0]!] },
      { ...valid, channels: [{ ...valid.channels[0]!, sourceId: 'foreign' }] },
      { ...valid, channels: [{ ...valid.channels[0]!, urls: ['http://media.test/no-grant'] }] },
      { ...valid, sources: [{ ...source, location: 'https://foreign.test/list' }] },
      { ...valid, sources: [source, source] },
      { ...valid, sources: [{ ...source, arbitrary: 'unadmitted' } as Source] },
      {
        ...valid,
        channels: [
          { ...valid.channels[0]!, arbitrary: 'unadmitted' } as (typeof valid.channels)[number],
        ],
      },
      { ...valid, channels: [{ ...valid.channels[0]!, urls: ['javascript:unsafe'] }] },
      { ...valid, finalChannelCount: 100001 },
      { ...valid, extra: 'unadmitted' } as CatalogPatch,
    ];
    for (const patch of cases) expect(() => applyCatalogPatch(initial, patch, [source])).toThrow();
    expect(() => applyCatalogPatch(initial, valid, [])).toThrow();
    expect(() => applyCatalogPatch(initial, valid, [source, source])).toThrow();
    expect(initial.channels[0]?.name).toBe('Channel 0');
  });

  it('accepts empty no-op and refuses canceled preparation before any reply', async () => {
    const initial = emptyCatalog();
    expect(applyCatalogPatch(initial, deriveCatalogPatch(initial, initial), [])).toEqual(initial);
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareOwnedCompactScanCommit(
        base(),
        prefs(),
        selection(),
        scope,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('worker service captures compact operation input synchronously and joins owned cancellation', async () => {
    const workers: {
      onmessage: ((event: MessageEvent) => void) | null;
      terminate: ReturnType<typeof vi.fn>;
      postMessage: ReturnType<typeof vi.fn>;
    }[] = [];
    vi.stubGlobal(
      'Worker',
      class {
        onmessage = null;
        onerror = null;
        onmessageerror = null;
        terminate = vi.fn();
        postMessage = vi.fn((value: unknown) => {
          captured = structuredClone(value);
        });
        constructor() {
          workers.push(this);
        }
      },
    );
    let captured: unknown;
    const initial = base();
    const controller = new AbortController();
    const operation = prepareCompactScanInWorker(
      initial,
      prefs(),
      selection(),
      scope,
      controller.signal,
    );
    initial.channels[0]!.name = 'Mutated after dispatch';
    expect(captured).toMatchObject({
      operation: 'compact',
      catalog: { channels: [{ name: 'Channel 0' }, { name: 'Channel 1' }] },
    });
    controller.abort();
    await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    expect(workers[0]!.onmessage).toBeNull();
  });
});
