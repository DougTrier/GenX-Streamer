import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareNativeScanBatchInWorker } from '../../src/discovery/selection';
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
import {
  prepareOwnedNativeScanBatch,
  prepareOwnedScanCommit,
} from '../../src/discovery/prepare-selection';
import { applyCatalogPatch } from '../../src/discovery/catalog-patch';
import { defaultPreferences } from '../../src/preferences';
import type { CatalogRecord, Source } from '../../src/catalog';
import type { StagedScanSelection } from '../../src/discovery/scan';
import { createHealthObservation } from '../../src/discovery/health';
const source: Source = {
  id: 's',
  name: 'Public',
  kind: 'url',
  location: 'https://catalog.test/list',
};
const channel = (i: number) => ({
  id: `saved-${i}`,
  sourceId: 's',
  providerId: `p-${i}`,
  name: `Channel ${i}`,
  category: 'Sports',
  urls: [`https://media.test/${i}`],
});
const base = (): CatalogRecord => ({
  schemaVersion: 1,
  sources: [source],
  channels: Array.from({ length: 13000 }, (_, i) => channel(i)),
});
const selection = (n = 64): StagedScanSelection => ({
  sessionRevision: '7',
  failedSourceIds: [],
  sources: [
    {
      sourceId: 's',
      fingerprint: 'scope',
      candidates: Array.from({ length: n }, (_, i) => ({ ...channel(i), name: `Updated ${i}` })),
    },
  ],
});
const scope = [{ source, fingerprint: 'scope' }];
const prefs = () => ({
  ...defaultPreferences(),
  sources: [source],
  favorites: ['saved-0'],
  removedChannels: ['saved-1'],
});
describe('native scan batch preparation', () => {
  it('never serializes the aggregate13k catalog, while legacy preparation still does', async () => {
    const initial = base();
    const original = JSON.stringify;
    const fullCatalogCalls: number[] = [];
    let refuse = true;
    vi.spyOn(JSON, 'stringify').mockImplementation((value, replacer, space) => {
      if (value && typeof value === 'object' && 'channels' in value && 'sources' in value) {
        fullCatalogCalls.push(value.channels.length);
        if (refuse) throw new Error('Aggregate catalog serialization forbidden');
      }
      return original(value, replacer as never, space);
    });
    const result = await prepareOwnedNativeScanBatch(initial, prefs(), selection(), scope);
    expect(result.catalogPatch.channels).toHaveLength(64);
    expect(fullCatalogCalls).toEqual([]);
    refuse = false;
    const legacy = await prepareOwnedScanCommit(initial, prefs(), selection(), scope);
    expect(fullCatalogCalls).toEqual([13000, 13000]);
    expect(JSON.parse(legacy.catalogText).channels).toHaveLength(13000);
    expect(applyCatalogPatch(initial, result.catalogPatch, [source])).toEqual(
      legacy.record.catalog,
    );
  });
  it('returns only bounded patch/preferences/incoming health with exact full admission parity', async () => {
    const initial = base(),
      chosen = selection();
    const review = {
      candidates: chosen.sources[0]!.candidates.map((c, i) => ({
        key: `key-${i}`,
        sourceId: 's',
        sourceFingerprint: 'scope',
        sessionRevision: '7',
        channel: c,
      })),
      observations: Array.from({ length: 64 }, (_, i) =>
        createHealthObservation(
          { channelId: `key-${i}`, sourceId: 's', fingerprint: 'scope' },
          { platform: 'windows', observedAt: 100 },
          { kind: 'recognized-media-response' },
        ),
      ),
      platform: 'windows',
      observerProfile: 'resource-v1',
    };
    const result = await prepareOwnedNativeScanBatch(initial, prefs(), chosen, scope, review);
    const full = await prepareOwnedScanCommit(initial, prefs(), chosen, scope, {
      previousHealth: [],
      review,
    });
    expect(Object.keys(result).sort()).toEqual(
      ['schemaVersion', 'catalogPatch', 'nextPreferences', 'incomingHealth'].sort(),
    );
    expect(result.catalogPatch.channels).toHaveLength(64);
    expect(result.incomingHealth).toHaveLength(64);
    expect(applyCatalogPatch(initial, result.catalogPatch, [source])).toEqual(full.record.catalog);
    expect(result.nextPreferences).toEqual(full.record.preferences);
    expect(
      [...result.incomingHealth].sort((a, b) => a.channelId.localeCompare(b.channelId)),
    ).toEqual(
      JSON.parse(full.healthText!).records.sort(
        (a: { channelId: string }, b: { channelId: string }) =>
          a.channelId.localeCompare(b.channelId),
      ),
    );
    expect(JSON.stringify(result).length).toBeLessThan(JSON.stringify(initial).length / 4);
    expect(initial.channels[0]?.name).toBe('Channel 0');
  });
  it('refuses 65 selected channels and oversized review rather than truncating', async () => {
    await expect(
      prepareOwnedNativeScanBatch(base(), prefs(), selection(65), scope),
    ).rejects.toThrow('64 channel bound');
    const review = {
      candidates: [],
      observations: Array(65).fill({}),
      platform: 'windows',
      observerProfile: 'resource-v1',
    };
    await expect(
      prepareOwnedNativeScanBatch(base(), prefs(), selection(1), scope, review as never),
    ).rejects.toThrow('64 channel bound');
  });
  it('retains malformed catalog, source grant and cancellation refusal', async () => {
    await expect(
      prepareOwnedNativeScanBatch(
        { ...base(), channels: [{ ...channel(0), urls: ['javascript:bad'] }] },
        prefs(),
        selection(1),
        scope,
      ),
    ).rejects.toThrow();
    const denied = selection(1);
    denied.sources[0]!.candidates[0]!.urls = ['http://media.test/denied'];
    await expect(prepareOwnedNativeScanBatch(base(), prefs(), denied, scope)).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      prepareOwnedNativeScanBatch(
        base(),
        prefs(),
        selection(1),
        scope,
        undefined,
        controller.signal,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

it('native worker dispatch omits old health and joins cancellation with handlers cleared', async () => {
  let captured: Record<string, unknown> | undefined;
  const workers: {
    onmessage: unknown;
    onerror: unknown;
    onmessageerror: unknown;
    terminate: ReturnType<typeof vi.fn>;
  }[] = [];
  vi.stubGlobal(
    'Worker',
    class {
      onmessage = null;
      onerror = null;
      onmessageerror = null;
      terminate = vi.fn();
      postMessage(value: Record<string, unknown>) {
        captured = structuredClone(value);
      }
      constructor() {
        workers.push(this);
      }
    },
  );
  const controller = new AbortController();
  const operation = prepareNativeScanBatchInWorker(
    base(),
    prefs(),
    selection(),
    scope,
    controller.signal,
  );
  expect(captured?.operation).toBe('native-batch');
  expect(captured).not.toHaveProperty('health');
  controller.abort();
  await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
  expect(workers[0]?.terminate).toHaveBeenCalledOnce();
  expect(workers[0]?.onmessage).toBeNull();
  expect(workers[0]?.onerror).toBeNull();
  expect(workers[0]?.onmessageerror).toBeNull();
});
