import { describe, expect, it } from 'vitest';
import {
  createBackup,
  migrateLegacyJson,
  parseBackup,
  prepareBackupImport,
  serializeBackup,
  MAX_BACKUP_BYTES,
} from '../../src/data-transfer';
import { defaultPreferences } from '../../src/preferences';
import type { CatalogRecord, Source } from '../../src/catalog';
import {
  fingerprintHealthTarget,
  parseHealthPayload,
  healthFreshness,
  type PersistedHealthRecord,
} from '../../src/catalog/health-record';
const source: Source = {
  id: 'migration',
  name: 'Chosen legacy snapshot',
  kind: 'file',
  location: 'chosen-export.json',
};
const catalog: CatalogRecord = {
  schemaVersion: 1,
  sources: [source],
  channels: [
    {
      id: 'stable',
      sourceId: source.id,
      name: 'News',
      category: 'News',
      urls: ['https://example.org/signed?token=private'],
    },
  ],
};
const backup = () =>
  createBackup(catalog, {
    ...defaultPreferences(),
    sources: [source],
    favorites: ['stable', 'missing'],
    removedChannels: ['stable', 'removed-missing'],
  });
const old = (entries: unknown[], other: Record<string, unknown> = {}) =>
  JSON.stringify({ master_db: entries, ...other });
const channel = (name = 'News', url = 'https://example.org/live') => ({ name, url, group: 'News' });
function largeRecords(count = 1000) {
  const channels = Array.from({ length: count }, (_, index) => ({
    ...catalog.channels[0]!,
    id: `${index}-${'i'.repeat(8000)}`,
    name: 'n'.repeat(8000),
  }));
  const health: PersistedHealthRecord[] = channels.map((item) => ({
    schemaVersion: 1,
    channelId: item.id,
    sourceId: source.id,
    checkedUrlOrdinal: 0,
    targetFingerprint: 'a'.repeat(64),
    platform: 'windows',
    observerProfile: 'fixture',
    observedAt: 1000,
    verdict: 'Reachable',
    evidence: { kind: 'http', status: 200, contentRecognized: true },
    origin: 'local',
  }));
  return {
    catalog: { ...catalog, channels },
    preferences: { ...defaultPreferences(), sources: [source] },
    health,
  };
}

describe('whole backup validation and preparation', () => {
  it('round trips a combined backup above 20 MiB without shrinking either valid inner record', () => {
    const data = largeRecords();
    const serialized = serializeBackup(createBackup(data.catalog, data.preferences, data.health));
    expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(20 * 1024 * 1024);
    expect(new TextEncoder().encode(serialized).byteLength).toBeLessThan(MAX_BACKUP_BYTES);
    const prepared = prepareBackupImport(serialized);
    expect(prepared.record.catalog.channels).toHaveLength(1000);
    expect(prepared.record.health).toHaveLength(1000);
    expect(prepared.record.health![999]!.channelId).toBe(data.catalog.channels[999]!.id);
    expect(prepared.record.health![999]!.origin).toBe('imported');
    for (const text of [prepared.catalogText, prepared.preferencesText, prepared.healthText!])
      expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(20 * 1024 * 1024);
  });
  it('refuses any oversized inner record even inside a permitted larger container', () => {
    const data = largeRecords();
    expect(() => createBackup(largeRecords(1500).catalog, data.preferences)).toThrow(
      'Catalog exceeds',
    );
    const favorites = Array.from({ length: 1500 }, (_, index) => `${index}-${'f'.repeat(16000)}`);
    expect(() => createBackup(catalog, { ...data.preferences, favorites })).toThrow(
      'Preferences record exceeds',
    );
    const oversizedHealth = [0, 1, 2].flatMap((profile) =>
      data.health.map((record) => ({ ...record, observerProfile: `fixture-${profile}` })),
    );
    expect(() => createBackup(data.catalog, data.preferences, oversizedHealth)).toThrow(
      /Health records exceed/,
    );
  });
  it('treats missing and explicit false HTTP permissions equivalently after storage normalization', () => {
    const normalized = { ...catalog, sources: [{ ...source, allowHttp: false }] };
    expect(createBackup(normalized, backup().preferences).catalog).toEqual(normalized);
    expect(() =>
      createBackup({ ...catalog, sources: [{ ...source, allowHttp: true }] }, backup().preferences),
    ).toThrow(/disagree/);
  });
  it('exports contextual evidence but imports it as historical without changing the original observation', async () => {
    const observation: PersistedHealthRecord = {
      schemaVersion: 1,
      channelId: 'stable',
      sourceId: source.id,
      checkedUrlOrdinal: 0,
      targetFingerprint: await fingerprintHealthTarget(source, catalog.channels[0]!, 0),
      platform: 'windows',
      observerProfile: 'reachability-v1/native-http-v1',
      observedAt: 1000,
      verdict: 'Reachable',
      evidence: { kind: 'http', status: 200, contentRecognized: true },
      origin: 'local',
    };
    const original = createBackup(catalog, backup().preferences, [observation]);
    const prepared = prepareBackupImport(serializeBackup(original));
    expect(original.health![0]!.origin).toBe('local');
    const imported = parseHealthPayload(prepared.healthText!).records[0]!;
    expect(imported).toEqual({ ...observation, origin: 'imported' });
    expect(
      healthFreshness(imported, {
        now: 1001,
        platform: 'windows',
        observerProfile: observation.observerProfile,
      }),
    ).toBe('stale');
    expect(prepared.record.catalog).toEqual(catalog);
    expect(() =>
      createBackup(catalog, backup().preferences, [{ ...observation, checkedUrlOrdinal: 1 }]),
    ).toThrow(/missing channel or stream/);
  });
  it('preserves exact identities, removed choices and explicit HTTP grants', () => {
    const http = { ...source, allowHttp: true };
    const record = createBackup(
      {
        ...catalog,
        sources: [http],
        channels: [{ ...catalog.channels[0]!, urls: ['http://example.org/live'] }],
      },
      {
        ...defaultPreferences(),
        sources: [http],
        favorites: ['stable'],
        removedChannels: ['stable'],
      },
    );
    const prepared = prepareBackupImport(serializeBackup(record));
    expect(prepared.record).toEqual(record);
    expect(prepared.preview).toMatchObject({
      favorites: 1,
      removedChannels: 1,
      httpSourceGrants: 1,
    });
    expect(JSON.parse(prepared.catalogText).sources[0].allowHttp).toBe(true);
  });
  it('keeps unresolved stable preferences and produces separate canonical records', () => {
    const prepared = prepareBackupImport(serializeBackup(backup()));
    expect(prepared.preview).toMatchObject({
      missingFavoriteIdentities: 1,
      missingRemovedIdentities: 1,
    });
    expect(JSON.parse(prepared.preferencesText).favorites).toEqual(['stable', 'missing']);
    expect(prepared.record.catalog.channels[0]!.id).toBe('stable');
  });
  it('refuses malformed/unknown/mismatched schemas without accepting partial data', () => {
    for (const value of [
      '{',
      JSON.stringify({ ...backup(), schemaVersion: 2 }),
      JSON.stringify({ ...backup(), surprise: true }),
      JSON.stringify({ ...backup(), preferences: { ...backup().preferences, sources: [] } }),
    ])
      expect(() => parseBackup(value)).toThrow();
    expect(() =>
      parseBackup(
        JSON.stringify({
          ...backup(),
          catalog: { ...catalog, channels: [...catalog.channels, ...catalog.channels] },
        }),
      ),
    ).toThrow('Duplicate');
  });
  it('defaults HTTP permission to denied and fails rather than truncating oversized input', () => {
    const noGrant = {
      ...backup(),
      catalog: {
        ...catalog,
        channels: [{ ...catalog.channels[0]!, urls: ['http://example.org/live'] }],
      },
    };
    expect(() => parseBackup(JSON.stringify(noGrant))).toThrow('HTTP');
    expect(() => parseBackup(' '.repeat(MAX_BACKUP_BYTES + 1))).toThrow('60 MiB + 4 KiB');
  });
});

describe('explicit selected old TMG JSON migration', () => {
  it('creates deterministic identity and maps URL favorites/removals to that same channel', async () => {
    const input = old([channel()], {
      favorites: ['https://example.org/live'],
      blacklist: ['https://example.org/live'],
      offline: ['https://example.org/live'],
      pins: ['https://example.org/live'],
      privateSecret: 'never-in-preview',
    });
    const first = await migrateLegacyJson(input, { source });
    const again = await migrateLegacyJson(input, { source });
    expect(first.record).toEqual(again.record);
    const id = first.record.catalog.channels[0]!.id;
    expect(first.record.preferences.favorites).toEqual([id]);
    expect(first.record.preferences.removedChannels).toEqual([id]);
    expect(first.legacyPreview).toMatchObject({
      matchedFavorites: 1,
      matchedRemovedChannels: 1,
      unsupportedRootFields: 3,
      unsupportedRootItems: 3,
    });
    expect(JSON.stringify(first.legacyPreview)).not.toContain('never-in-preview');
    expect(JSON.stringify(first.record)).not.toContain('offline');
  });
  it('deduplicates exact imported metadata only and keeps ambiguous favorites detached', async () => {
    const input = old([channel('First'), channel('First'), channel('Second')], {
      favorites: ['https://example.org/live'],
      blacklist: ['https://example.org/live'],
    });
    const migrated = await migrateLegacyJson(input, { source });
    expect(migrated.record.catalog.channels).toHaveLength(2);
    expect(migrated.legacyPreview).toMatchObject({
      exactDuplicatesRemoved: 1,
      ambiguousFavorites: 1,
      ambiguousRemovedChannels: 1,
    });
    expect(migrated.record.preferences.favorites[0]).toMatch(/^legacy-ref:/);
    expect(migrated.record.catalog.channels.map((c) => c.id)).not.toContain(
      migrated.record.preferences.favorites[0],
    );
  });
  it('does not match source-isolated existing channels by their URL', async () => {
    const other = { ...source, id: 'other' };
    const base = createBackup(
      {
        schemaVersion: 1,
        sources: [other],
        channels: [
          { ...catalog.channels[0]!, sourceId: 'other', urls: ['https://example.org/live'] },
        ],
      },
      {
        ...defaultPreferences(),
        sources: [other],
        favorites: ['stable'],
        removedChannels: ['stable'],
      },
    );
    const migrated = await migrateLegacyJson(
      old([channel()], { favorites: ['https://example.org/live'] }),
      { source, base },
    );
    expect(migrated.record.catalog.channels).toHaveLength(2);
    expect(migrated.record.catalog.channels[0]!.id).toBe('stable');
    expect(migrated.record.catalog.channels[1]!.id).not.toBe('stable');
    expect(migrated.record.preferences.favorites).toContain('stable');
    expect(migrated.record.preferences.removedChannels).toContain('stable');
  });
  it('reconciles changed stream URLs by unique metadata and preserves prior identity', async () => {
    const first = await migrateLegacyJson(old([channel()]), { source });
    const second = await migrateLegacyJson(old([channel('News', 'https://example.org/changed')]), {
      source,
      base: first.record,
    });
    expect(second.record.catalog.channels[0]!.id).toBe(first.record.catalog.channels[0]!.id);
  });
  it('retains missing legacy references as opaque identities and resolves them on explicit reimport', async () => {
    const first = await migrateLegacyJson(
      old([], {
        favorites: ['https://example.org/missing?secret=private'],
        blacklist: ['https://example.org/missing?secret=private'],
      }),
      { source },
    );
    expect(first.legacyPreview.unmatchedFavorites).toBe(1);
    expect(first.record.preferences.favorites[0]).not.toContain('private');
    const second = await migrateLegacyJson(
      old([channel('Recovered', 'https://example.org/missing?secret=private')], {
        favorites: ['https://example.org/missing?secret=private'],
        blacklist: ['https://example.org/missing?secret=private'],
      }),
      { source, base: first.record },
    );
    expect(second.record.preferences.favorites).toEqual([second.record.catalog.channels[0]!.id]);
    expect(second.record.preferences.removedChannels).toEqual(second.record.preferences.favorites);
  });
  it('imports old user source lists only with explicitly selected metadata and grants', async () => {
    const input = old([channel()], {
      custom_sources: ['http://example.org/list'],
      user_m3u_lists: [{ url: 'https://example.org/second', name: 'User source' }],
    });
    const plain = await migrateLegacyJson(input, { source });
    expect(plain.record.catalog.sources).toHaveLength(1);
    expect(plain.legacyPreview.unselectedSourceEntries).toBe(2);
    await expect(
      migrateLegacyJson(input, {
        source,
        sourceBindings: [
          {
            field: 'custom_sources',
            index: 0,
            source: {
              id: 'list',
              name: 'Chosen source',
              kind: 'url',
              location: 'http://example.org/list',
            },
          },
        ],
      }),
    ).rejects.toThrow('HTTP');
    const granted = await migrateLegacyJson(input, {
      source,
      sourceBindings: [
        {
          field: 'custom_sources',
          index: 0,
          source: {
            id: 'list',
            name: 'Chosen source',
            kind: 'url',
            location: 'http://example.org/list',
            allowHttp: true,
          },
        },
      ],
    });
    expect(granted.record.catalog.sources[1]!.allowHttp).toBe(true);
    expect(granted.legacyPreview).toMatchObject({
      selectedSourceEntries: 1,
      unselectedSourceEntries: 1,
    });
    expect(granted.record.preferences.sources).toEqual(granted.record.catalog.sources);
  });
  it('refuses invalid migration schemas, entry shapes, permissions and ambiguous source bindings', async () => {
    for (const input of [
      '{',
      JSON.stringify({ master_db: [], schemaVersion: 999 }),
      old([{}]),
      old([channel('News', 'file:///private')]),
      old([channel('News', 'http://example.org/live')]),
      old([], { favorites: [7] }),
      old([], { user_m3u_lists: [{}] }),
    ])
      await expect(migrateLegacyJson(input, { source })).rejects.toThrow();
    await expect(
      migrateLegacyJson(old([], { custom_sources: ['https://example.org/list'] }), {
        source,
        sourceBindings: [
          {
            field: 'custom_sources',
            index: 0,
            source: {
              ...source,
              id: 'another',
              kind: 'url',
              location: 'https://example.org/incorrect',
            },
          },
        ],
      }),
    ).rejects.toThrow('match');
    await expect(migrateLegacyJson(' '.repeat(20 * 1024 * 1024 + 1), { source })).rejects.toThrow(
      '20 MiB',
    );
  });
  it('fails explicitly above channel limits before any migration result', async () => {
    await expect(
      migrateLegacyJson(old(Array.from({ length: 100001 }, () => channel())), { source }),
    ).rejects.toThrow('limit');
  });
});

it('does not collapse distinct legacy metadata that the new schema cannot represent', async () => {
  const migrated = await migrateLegacyJson(
    old([
      { ...channel(), lang: 'English', resolution: 'HD' },
      { ...channel(), lang: 'French', resolution: 'HD' },
      { ...channel(), lang: 'English', resolution: 'SD' },
    ]),
    { source },
  );
  expect(migrated.record.catalog.channels).toHaveLength(3);
  expect(migrated.legacyPreview.exactDuplicatesRemoved).toBe(0);
  expect(migrated.legacyPreview.unsupportedChannelFields).toBe(3);
});

it('permits independently bounded catalog and preferences above the old combined limit', () => {
  const record = createBackup(
    {
      schemaVersion: 1,
      sources: [source],
      channels: Array.from({ length: 1000 }, (_, index) => ({
        id: `channel-${index}`,
        sourceId: source.id,
        name: 'n'.repeat(12000),
        category: '',
        urls: ['https://example.org/live'],
      })),
    },
    {
      ...defaultPreferences(),
      sources: [source],
      favorites: Array.from({ length: 1000 }, (_, index) => `${index}:${'f'.repeat(12000)}`),
    },
  );
  const serialized = serializeBackup(record);
  expect(new TextEncoder().encode(serialized).byteLength).toBeGreaterThan(20 * 1024 * 1024);
  expect(parseBackup(serialized)).toEqual(record);
});
