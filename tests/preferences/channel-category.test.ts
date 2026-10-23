import { expect, it } from 'vitest';
import {
  defaultPreferences,
  validatePreferences,
  importPreferences,
  exportPreferences,
  SerializedPreferencesStore,
  createChannelCategoryResolver,
  effectiveChannelCategory,
  validateChannelCategoryOverrides,
} from '../../src/preferences';
import { createBackup, serializeBackup, parseBackup } from '../../src/data-transfer';
it('keeps legacy defaults and source categories unchanged while resolving exact IDs', () => {
  const prefs = defaultPreferences();
  expect(prefs).not.toHaveProperty('channelCategoryOverrides');
  const one = { id: 'one', category: 'Provider sports' },
    sameNameVariant = { id: 'two', category: 'Provider sports' };
  expect(effectiveChannelCategory(one, prefs)).toBe('Provider sports');
  prefs.channelCategoryOverrides = [
    { channelId: 'one', category: 'My News' },
    { channelId: 'orphan', category: 'Music' },
  ];
  const resolve = createChannelCategoryResolver(prefs);
  expect(resolve(one)).toBe('My News');
  expect(resolve(sameNameVariant)).toBe('Provider sports');
  expect(one.category).toBe('Provider sports');
  prefs.channelCategoryOverrides[0]!.category = 'Late mutation';
  expect(resolve(one)).toBe('My News');
});
it('round-trips overrides through preference and full JSON backup APIs', () => {
  const prefs = {
    ...defaultPreferences(),
    channelCategoryOverrides: [{ channelId: 'missing', category: 'Documentary & Culture' }],
  };
  expect(importPreferences(exportPreferences(prefs))).toEqual(prefs);
  expect(
    parseBackup(
      serializeBackup(createBackup({ schemaVersion: 1, sources: [], channels: [] }, prefs)),
    ).preferences,
  ).toEqual(prefs);
  expect(
    validatePreferences({ ...defaultPreferences(), channelCategoryOverrides: [] })
      .channelCategoryOverrides,
  ).toEqual([]);
});
it('persists exact user intent and resets by removing the entry', async () => {
  let saved: unknown = null;
  const store = new SerializedPreferencesStore({
    read: async () => saved,
    write: async (value) => {
      saved = value;
    },
  });
  await store.update((prefs) => {
    prefs.channelCategoryOverrides = [{ channelId: 'one', category: 'News' }];
  });
  expect((await store.load()).channelCategoryOverrides).toEqual([
    { channelId: 'one', category: 'News' },
  ]);
  await store.update((prefs) => {
    prefs.channelCategoryOverrides = [];
  });
  expect(effectiveChannelCategory({ id: 'one', category: 'Original' }, await store.load())).toBe(
    'Original',
  );
});
it.each([
  null,
  {},
  [{ channelId: 'one', category: '' }],
  [{ channelId: 'one', category: ' leading' }],
  [{ channelId: 'one', category: 'News\nInjected' }],
  [{ channelId: 'one', category: 'News', unexpected: 'ignored?' }],
  [
    { channelId: 'one', category: 'News' },
    { channelId: 'one', category: 'Sports' },
  ],
  [{ channelId: '界'.repeat(5462), category: 'News' }],
  [{ channelId: 'one', category: '界'.repeat(171) }],
])('refuses malformed or nonportable overrides %# without partial acceptance', (raw) => {
  expect(() => validateChannelCategoryOverrides(raw)).toThrow('Invalid channel category');
});
it('refuses count and aggregate byte overflow rather than truncating', () => {
  expect(() =>
    validateChannelCategoryOverrides(
      Array.from({ length: 100001 }, (_, i) => ({ channelId: String(i), category: 'News' })),
    ),
  ).toThrow('Invalid');
  const prefix = 'x'.repeat(16000);
  expect(() =>
    validateChannelCategoryOverrides(
      Array.from({ length: 1400 }, (_, i) => ({ channelId: prefix + i, category: 'News' })),
    ),
  ).toThrow('20 MiB');
});
it('invalid queued category edits cannot acknowledge or alter stored intent', async () => {
  let writes = 0;
  const store = new SerializedPreferencesStore({
    read: async () => null,
    write: async () => {
      writes++;
    },
  });
  const before = store.snapshot();
  await expect(
    store.update((prefs) => {
      prefs.channelCategoryOverrides = [{ channelId: 'one', category: 'bad\nvalue' }];
    }),
  ).rejects.toThrow('Invalid channel category');
  expect(writes).toBe(0);
  expect(store.snapshot()).toEqual(before);
});
