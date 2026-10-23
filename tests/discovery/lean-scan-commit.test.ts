import { afterEach, expect, it, vi } from 'vitest';
import { defaultPreferences } from '../../src/preferences';
import type { CatalogRecord, Channel, Source } from '../../src/catalog';
import type { StagedScanSelection } from '../../src/discovery/scan';
import {
  prepareSelectedScan,
  prepareSelectedScanWithHealth,
  prepareOwnedScanCommit,
  type PreparedScanCommit,
} from '../../src/discovery/prepare-selection';
import { fingerprintHealthTarget } from '../../src/catalog/health-record';
import { createHealthObservation } from '../../src/discovery/health';

const source: Source = {
  id: 'public',
  name: 'Owned public fixture',
  kind: 'url',
  location: 'https://fixture.invalid/index.m3u',
};
const channel: Channel = {
  id: 'saved',
  sourceId: source.id,
  providerId: 'known',
  name: 'Saved',
  category: 'News',
  urls: ['https://fixture.invalid/saved.ts'],
};
const catalog: CatalogRecord = { schemaVersion: 1, sources: [source], channels: [channel] };
const selection: StagedScanSelection = {
  sessionRevision: '7',
  failedSourceIds: [],
  sources: [
    {
      sourceId: source.id,
      fingerprint: 'captured',
      candidates: [
        {
          sourceId: source.id,
          providerId: 'new',
          name: 'New',
          category: 'Sports',
          urls: ['https://fixture.invalid/new.ts'],
        },
      ],
    },
  ],
};
const scope = [{ source, fingerprint: 'captured' }];
function context() {
  const candidate = {
    key: 'candidate',
    sourceId: source.id,
    sourceFingerprint: 'captured',
    sessionRevision: '7',
    channel: structuredClone(selection.sources[0]!.candidates[0]!),
  };
  return {
    previousHealth: [],
    review: {
      candidates: [candidate],
      observations: [
        createHealthObservation(
          { channelId: candidate.key, sourceId: source.id, fingerprint: 'captured' },
          { platform: 'windows', observedAt: 100 },
          { kind: 'http', status: 200, contentRecognized: true },
        ),
      ],
      platform: 'windows',
      observerProfile: 'fixture',
    },
  };
}
afterEach(() => vi.unstubAllGlobals());
function leanKeys(result: PreparedScanCommit) {
  expect(Object.keys(result).sort()).toEqual(
    ['catalogText', 'healthText', 'preferencesText', 'record'].sort(),
  );
  expect(result).not.toHaveProperty('backupText');
  expect(result).not.toHaveProperty('preview');
  expect(result).not.toHaveProperty('healthRecords');
}
it('lean commit bytes match the complete public preparation, retaining health mapping and old rows', async () => {
  const full = await prepareSelectedScanWithHealth(
    catalog,
    defaultPreferences(),
    selection,
    scope,
    context(),
  );
  const lean = await prepareOwnedScanCommit(
    catalog,
    defaultPreferences(),
    selection,
    scope,
    context(),
  );
  leanKeys(lean);
  expect(lean.record).toEqual(full.record);
  expect(lean.catalogText).toBe(full.catalogText);
  expect(lean.preferencesText).toBe(full.preferencesText);
  expect(lean.healthText).toBe(full.healthText);
  expect(full.backupText).toBeTruthy();
  expect(full.preview.channels).toBe(2);
  expect(full.healthRecords).toHaveLength(1);
});
it('non-health worker commits keep canonical admission without export fields', async () => {
  const full = prepareSelectedScan(catalog, defaultPreferences(), selection, scope);
  const lean = await prepareOwnedScanCommit(catalog, defaultPreferences(), selection, scope);
  expect(Object.keys(lean).sort()).toEqual(['catalogText', 'preferencesText', 'record']);
  expect(lean.catalogText).toBe(full.catalogText);
  expect(lean.preferencesText).toBe(full.preferencesText);
  await expect(
    prepareOwnedScanCommit(catalog, defaultPreferences(), selection, [
      { source, fingerprint: 'wrong' },
    ]),
  ).rejects.toThrow('reviewed source changed');
});
it('actual worker handler sends only lean commit fields for a 13,241-row saved catalog', async () => {
  const large: CatalogRecord = {
    ...catalog,
    channels: Array.from({ length: 13241 }, (_, i) => ({
      ...channel,
      id: 'saved-' + i,
      providerId: 'provider-' + i,
      name: 'Saved ' + i,
      urls: ['https://fixture.invalid/' + i + '.ts'],
    })),
  };
  const full = await prepareSelectedScanWithHealth(
    large,
    defaultPreferences(),
    selection,
    scope,
    context(),
  );
  let resolve!: (value: { ok: boolean; result: PreparedScanCommit }) => void;
  const reply = new Promise<{ ok: boolean; result: PreparedScanCommit }>((done) => {
    resolve = done;
  });
  const worker: { onmessage: ((event: MessageEvent) => void) | null; postMessage: typeof resolve } =
    { onmessage: null, postMessage: resolve };
  vi.stubGlobal('self', worker);
  vi.resetModules();
  await import('../../src/discovery/selection-worker');
  worker.onmessage!({
    data: structuredClone({
      catalog: large,
      preferences: defaultPreferences(),
      selection,
      scope,
      health: context(),
    }),
  } as MessageEvent);
  const message = await reply;
  expect(message.ok).toBe(true);
  leanKeys(message.result);
  expect(message.result.record.catalog.channels).toHaveLength(13242);
  expect(message.result.catalogText).toBe(full.catalogText);
  expect(message.result.preferencesText).toBe(full.preferencesText);
  expect(message.result.healthText).toBe(full.healthText);
  expect(new TextEncoder().encode(JSON.stringify(message.result)).length).toBeLessThan(
    new TextEncoder().encode(JSON.stringify(full)).length,
  );
});
it('public asynchronous API still snapshots mutable inputs before held digests', async () => {
  const ctx = context();
  const releases: Array<() => void> = [];
  const digest = vi
    .spyOn(crypto.subtle, 'digest')
    .mockImplementation(
      () =>
        new Promise<ArrayBuffer>((resolve) => releases.push(() => resolve(new ArrayBuffer(32)))),
    );
  try {
    const pending = prepareSelectedScanWithHealth(
      catalog,
      defaultPreferences(),
      selection,
      scope,
      ctx,
    );
    await vi.waitFor(() => expect(releases.length).toBeGreaterThan(0));
    ctx.review.candidates[0]!.channel.urls[0] = 'https://fixture.invalid/mutated';
    ctx.review.observations[0]!.platform = 'android';
    // Each released phase can schedule the next owned digest.
    let done = false;
    void pending.then(() => {
      done = true;
    });
    await vi.waitFor(() => {
      releases.splice(0).forEach((release) => release());
      expect(done).toBe(true);
    });
    const result = await pending;
    expect(result.healthRecords?.[0]?.platform).toBe('windows');
    expect(
      result.record.catalog.channels.some((row) =>
        row.urls.includes('https://fixture.invalid/mutated'),
      ),
    ).toBe(false);
  } finally {
    digest.mockRestore();
  }
});
it('owned lean health path joins in-flight hashes before canceled rejection', async () => {
  const previous = {
    schemaVersion: 1 as const,
    channelId: channel.id,
    sourceId: source.id,
    checkedUrlOrdinal: 0,
    targetFingerprint: await fingerprintHealthTarget(source, channel, 0),
    platform: 'windows',
    observerProfile: 'fixture',
    observedAt: 50,
    verdict: 'Reachable' as const,
    evidence: { kind: 'recognized-media-response' as const },
    origin: 'local' as const,
  };
  let release!: () => void;
  const digest = vi.spyOn(crypto.subtle, 'digest').mockImplementation(
    () =>
      new Promise<ArrayBuffer>((resolve) => {
        release = () => resolve(new ArrayBuffer(32));
      }),
  );
  try {
    const controller = new AbortController();
    let settled = false;
    const pending = prepareOwnedScanCommit(
      catalog,
      defaultPreferences(),
      { ...selection, sources: [] },
      scope,
      { previousHealth: [previous] },
      controller.signal,
    ).finally(() => {
      settled = true;
    });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    await rejected;
  } finally {
    digest.mockRestore();
  }
});
