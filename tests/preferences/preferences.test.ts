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

import researchProviders from '../../docs/research-reviewed-providers.json';
import { createBackup, serializeBackup, parseBackup } from '../../src/data-transfer';
import { describe, expect, it } from 'vitest';
import { defaultProviderRegistry } from '../../src/discovery/provider-registry';
import {
  defaultPreferences,
  defaultPanelWidthForViewport,
  exportPreferences,
  importPreferences,
  SerializedPreferencesStore,
  validatePreferences,
  type Preferences,
} from '../../src/preferences';

describe('preference schema and serialized durable mutations', () => {
  it('skips equal validated edits only after reading a durable record', async () => {
    const saved = { ...defaultPreferences(), contentLibrary: 'genxtra' as const };
    let writes = 0;
    let guards = 0;
    const store = new SerializedPreferencesStore({
      read: async () => saved,
      write: async () => {
        writes++;
      },
    });
    await store.load();
    const result = await store.update(
      (draft) => {
        draft.contentLibrary = 'genxtra';
      },
      async () => {
        guards++;
        return true;
      },
    );
    expect(result).toEqual(validatePreferences(saved));
    expect(writes).toBe(0);
    expect(guards).toBe(1);
    result.favorites.push('outside');
    expect(store.snapshot().favorites).toEqual([]);
    await expect(
      store.update((draft) => {
        draft.volume = NaN;
      }),
    ).rejects.toThrow('audio');
    expect(writes).toBe(0);
  });

  it('rejects stale admission even when the requested settings are equal', async () => {
    let writes = 0;
    let mutations = 0;
    const store = new SerializedPreferencesStore({
      read: async () => defaultPreferences(),
      write: async () => {
        writes++;
      },
    });
    await store.load();
    await expect(
      store.update(
        () => {
          mutations++;
        },
        async () => false,
      ),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(mutations).toBe(0);
    expect(writes).toBe(0);
  });

  it('joins the original durable write before resolving an equal queued edit', async () => {
    let finish!: () => void;
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
      started = resolve;
    });
    const writes: Preferences[] = [];
    const store = new SerializedPreferencesStore({
      read: async () => defaultPreferences(),
      write: async (value) => {
        writes.push(structuredClone(value));
        if (writes.length === 1) {
          started();
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
        }
      },
    });
    await store.load();
    const first = store.update((draft) => {
      draft.contentLibrary = 'genxtra';
    });
    await began;
    let settled = false;
    let guards = 0;
    const equal = store
      .update(
        (draft) => {
          draft.contentLibrary = 'genxtra';
        },
        async () => {
          guards++;
          return true;
        },
      )
      .then((value) => {
        settled = true;
        return value;
      });
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(guards).toBe(0);
    expect(store.snapshot().contentLibrary).toBe('live');
    finish();
    await first;
    expect((await equal).contentLibrary).toBe('genxtra');
    expect(writes).toHaveLength(1);
    expect(guards).toBe(1);
    await store.update((draft) => {
      draft.contentLibrary = 'live';
    });
    expect(writes.map((value) => value.contentLibrary)).toEqual(['genxtra', 'live']);
  });

  it('does not infer a durable baseline from constructor defaults or an absent backend', async () => {
    for (const load of [false, true]) {
      let writes = 0;
      const store = new SerializedPreferencesStore({
        read: async () => null,
        write: async () => {
          writes++;
        },
      });
      if (load) await store.load();
      await store.update(() => undefined);
      expect(writes).toBe(1);
      await store.update(() => undefined);
      expect(writes).toBe(1);
    }
  });

  it('always runs equal paired commits and waits for their accompanying transaction', async () => {
    let writes = 0;
    let finish!: () => void;
    let commits = 0;
    let auxiliaryCommitted = false;
    const store = new SerializedPreferencesStore({
      read: async () => defaultPreferences(),
      write: async () => {
        writes++;
      },
    });
    await store.load();
    const paired = store.replaceAtomically(store.snapshot(), async () => {
      commits++;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
      auxiliaryCommitted = true;
    });
    await Promise.resolve();
    let settled = false;
    const equal = store
      .update(() => undefined)
      .then(() => {
        settled = true;
      });
    await Promise.resolve();
    expect(commits).toBe(1);
    expect(settled).toBe(false);
    expect(auxiliaryCommitted).toBe(false);
    finish();
    await paired;
    await equal;
    expect(auxiliaryCommitted).toBe(true);
    expect(writes).toBe(0);
  });

  it('invalidates equality trust after an uncertain external mutation or failed reload', async () => {
    let readable = true;
    let writes = 0;
    const store = new SerializedPreferencesStore({
      read: async () => {
        if (!readable) throw new Error('read failed');
        return defaultPreferences();
      },
      write: async () => {
        writes++;
      },
    });
    await store.load();
    await expect(
      store.mutateExternally(async () => {
        throw new Error('external outcome unavailable');
      }),
    ).rejects.toThrow('external outcome');
    await store.update(() => undefined);
    expect(writes).toBe(1);
    readable = false;
    await expect(store.load()).rejects.toThrow('read failed');
    await store.update(() => undefined);
    expect(writes).toBe(2);
  });

  it('restores the chosen content library without changing legacy first launch', async () => {
    const legacy = defaultPreferences();
    delete legacy.contentLibrary;
    expect(validatePreferences(legacy).contentLibrary).toBe('live');
    for (const contentLibrary of ['live', 'genxtra'] as const) {
      const chosen = { ...defaultPreferences(), contentLibrary };
      expect(importPreferences(exportPreferences(chosen)).contentLibrary).toBe(contentLibrary);
    }
    for (const contentLibrary of [null, 'archive', '', false, 1, {}, []])
      expect(() => validatePreferences({ ...legacy, contentLibrary })).toThrow();
    let persisted: Preferences | null = null;
    const store = new SerializedPreferencesStore({
      read: async () => persisted,
      write: async (value) => {
        persisted = value;
      },
    });
    await store.load();
    await store.update((draft) => {
      draft.contentLibrary = 'genxtra';
    });
    const reopened = new SerializedPreferencesStore({
      read: async () => persisted,
      write: async () => {
        throw new Error('Reopening must not write');
      },
    });
    expect((await reopened.load()).contentLibrary).toBe('genxtra');
  });

  it('defaults legacy automatic guides on and preserves an explicit off through export and backup', () => {
    expect(defaultPreferences().automaticGuideUpdates).toBe(true);
    const legacy = defaultPreferences();
    delete legacy.automaticGuideUpdates;
    expect(validatePreferences(legacy).automaticGuideUpdates).toBe(true);
    const disabled = {
      ...defaultPreferences(),
      automaticGuideUpdates: false,
      reviewedChannelProviders: researchProviders.reviewedChannelProviders.slice(0, 2),
      reviewedGuideProviders: researchProviders.reviewedGuideProviders,
      preferredRegion: { country: 'US', state: 'US-IL', origin: 'manual' as const },
    };
    expect(importPreferences(exportPreferences(disabled))).toEqual(disabled);
    const backup = parseBackup(
      serializeBackup(createBackup({ schemaVersion: 1, sources: [], channels: [] }, disabled)),
    );
    expect(backup.preferences).toEqual(disabled);
    for (const value of [null, 0, 1, 'false', [], {}])
      expect(() => validatePreferences({ ...disabled, automaticGuideUpdates: value })).toThrow(
        'automatic guide',
      );
  });

  it('derives bounded first-run proportions without changing legacy defaults', () => {
    expect(defaultPanelWidthForViewport(1664)).toBe(600);
    expect(defaultPanelWidthForViewport(960)).toBe(350);
    expect(defaultPanelWidthForViewport(320)).toBe(240);
    expect(defaultPanelWidthForViewport(1280)).toBe(467);
    expect(defaultPreferences().panelWidth).toBe(360);
    for (const width of [NaN, Infinity, 0, -1])
      expect(() => defaultPanelWidthForViewport(width)).toThrow('Invalid viewport');
  });

  it('uses the injected width only when no persisted preferences exist', async () => {
    const writes: Preferences[] = [];
    let persisted: Preferences | null = null;
    const store = new SerializedPreferencesStore(
      {
        read: async () => persisted,
        write: async (value) => {
          persisted = value;
          writes.push(value);
        },
      },
      defaultPanelWidthForViewport(1664),
    );
    expect(store.snapshot().panelWidth).toBe(600);
    expect((await store.load()).panelWidth).toBe(600);
    expect(writes).toHaveLength(0);
    await store.update((draft) => {
      draft.panelWidth = 260;
    });
    expect((await store.load()).panelWidth).toBe(260);
    const reopened = new SerializedPreferencesStore(
      {
        read: async () => persisted,
        write: async (value) => {
          writes.push(value);
        },
      },
      defaultPanelWidthForViewport(960),
    );
    expect((await reopened.load()).panelWidth).toBe(260);
    expect(writes).toHaveLength(1);
    expect(reopened.snapshot().schemaVersion).toBe(1);
  });

  it('migrates missing provider arrays but preserves explicit user removals and HTTP grants', () => {
    const legacy = defaultPreferences();
    legacy.sources = [
      {
        id: 'retained-source',
        name: 'Retained source',
        kind: 'url',
        location: 'https://user.fixture.invalid/list',
      },
    ];
    legacy.favorites = ['retained-channel'];
    delete legacy.reviewedChannelProviders;
    delete legacy.reviewedGuideProviders;
    const migrated = validatePreferences(legacy);
    const factory = defaultProviderRegistry();
    expect(factory).toEqual({
      schemaVersion: 1,
      reviewedChannelProviders: [],
      reviewedGuideProviders: [],
    });
    expect(migrated.reviewedChannelProviders).toEqual([]);
    expect(migrated.reviewedGuideProviders).toEqual([]);
    expect(migrated.sources).toEqual(legacy.sources);
    const originalTwo = {
      ...migrated,
      reviewedChannelProviders: researchProviders.reviewedChannelProviders.slice(0, 2),
      reviewedGuideProviders: researchProviders.reviewedGuideProviders,
    };
    expect(importPreferences(exportPreferences(originalTwo))).toEqual(originalTwo);
    const removed = { ...migrated, reviewedChannelProviders: [], reviewedGuideProviders: [] };
    expect(importPreferences(exportPreferences(removed))).toEqual(removed);
    const granted = {
      ...migrated,
      reviewedChannelProviders: [
        {
          id: 'local',
          name: 'Explicit HTTP',
          location: 'http://example.invalid/list',
          provenance: 'https://publisher.invalid/docs',
          allowHttp: true,
        },
      ],
    };
    expect(importPreferences(exportPreferences(granted))).toEqual(granted);
    expect(() =>
      validatePreferences({
        ...granted,
        reviewedChannelProviders: [{ ...granted.reviewedChannelProviders[0], allowHttp: false }],
      }),
    ).toThrow('HTTP');
  });
  it('does not replace durable provider edits when validation or atomic persistence fails', async () => {
    const store = new SerializedPreferencesStore({
      read: async () => null,
      write: async () => {
        throw new Error('fixture write failure');
      },
    });
    const before = store.snapshot();
    await expect(
      store.update((draft) => {
        draft.reviewedChannelProviders = researchProviders.reviewedChannelProviders.slice(0, 2);
      }),
    ).rejects.toThrow('fixture');
    expect(store.snapshot()).toEqual(before);
    await expect(
      store.update((draft) => {
        draft.reviewedGuideProviders = [
          {
            id: 'bad',
            name: 'bad',
            location: 'file:///private',
            provenance: 'https://publisher.invalid/docs',
            limitations: 'bad',
          },
        ];
      }),
    ).rejects.toThrow();
    expect(store.snapshot()).toEqual(before);
  });
  it('stores only explicitly chosen country/state provenance and no default personal location', () => {
    expect(defaultPreferences()).not.toHaveProperty('preferredRegion');
    for (const origin of ['manual', 'ip'] as const) {
      const value = {
        ...defaultPreferences(),
        preferredRegion: { country: 'US', state: 'US-IL', postal: '00501', origin },
      };
      expect(importPreferences(exportPreferences(value))).toEqual(value);
    }
    for (const preferredRegion of [
      { country: 'US', state: 'CA-ON', origin: 'manual' },
      { country: 'US', origin: 'guessed' },
      { country: 'US', origin: 'ip', postal: '0'.repeat(33) },
      { country: 'US', origin: 'manual', postal: '\n00501' },
      { origin: 'manual' },
    ]) {
      expect(() => validatePreferences({ ...defaultPreferences(), preferredRegion })).toThrow();
    }
  });
  it('uses native byte boundaries for non-ASCII favorite and removal identities', () => {
    const value = {
      ...defaultPreferences(),
      favorites: ['😀'.repeat(4096)],
      removedChannels: ['界'.repeat(5461) + 'A'],
    };
    expect(importPreferences(exportPreferences(value))).toEqual(value);
    expect(() => validatePreferences({ ...value, favorites: [value.favorites[0] + 'A'] })).toThrow(
      'Invalid favorites',
    );
    expect(() =>
      validatePreferences({ ...value, removedChannels: [value.removedChannels[0] + 'A'] }),
    ).toThrow('Invalid removed');
    expect(() => validatePreferences({ ...value, favorites: ['\udc00'] })).toThrow(
      'Invalid favorites',
    );
  });
  it('checks remote authorization inside the queue after earlier writes settle', async () => {
    let finish!: () => void;
    const writes: Preferences[] = [];
    const store = new SerializedPreferencesStore({
      read: async () => null,
      write: async (value) => {
        writes.push(value);
        if (writes.length === 1)
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
      },
    });
    const first = store.update((draft) => {
      draft.favorites.push('local');
    });
    await Promise.resolve();
    let authorized = true;
    let mutations = 0;
    const remote = store.update(
      (draft) => {
        mutations++;
        draft.volume = 0.1;
      },
      async () => authorized,
    );
    authorized = false;
    finish();
    await first;
    await expect(remote).rejects.toMatchObject({ name: 'AbortError' });
    expect(mutations).toBe(0);
    expect(writes).toHaveLength(1);
    expect(store.snapshot()).toMatchObject({ favorites: ['local'], volume: 0.8 });
    await store.update((draft) => {
      draft.muted = true;
    });
    expect(store.snapshot().muted).toBe(true);
  });
  it('publishes paired transaction preferences only after durable success and preserves failed revisions', async () => {
    const writes: Preferences[] = [];
    const store = new SerializedPreferencesStore({
      read: async () => null,
      write: async (value) => {
        writes.push(value);
      },
    });
    const original = store.snapshot();
    await expect(
      store.replaceAtomically({ ...original, volume: 0.2 }, async () => {
        throw new Error('pair failed');
      }),
    ).rejects.toThrow('pair failed');
    expect(store.snapshot()).toEqual(original);
    let finish!: () => void;
    const paired = store.replaceAtomically(
      { ...original, volume: 0.3 },
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    await Promise.resolve();
    expect(store.snapshot()).toEqual(original);
    const queued = store.update((draft) => {
      draft.muted = true;
    });
    finish();
    await paired;
    await queued;
    expect(await store.settledSnapshot()).toMatchObject({ volume: 0.3, muted: true });
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ volume: 0.3, muted: true });
  });
  it('round trips favorites including missing channel identities', () => {
    const value = { ...defaultPreferences(), favorites: ['missing', 'provider:source:one'] };
    expect(importPreferences(exportPreferences(value))).toEqual(value);
  });
  it('round trips optional explicit HTTP permission without granting it by default', () => {
    const source = {
      id: 's',
      name: 'n',
      location: 'https://example.org/list',
      kind: 'url' as const,
    };
    const original = { ...defaultPreferences(), sources: [source] };
    expect(importPreferences(exportPreferences(original)).sources[0]!.allowHttp).toBeUndefined();
    const permitted = {
      ...original,
      sources: [{ ...source, location: 'http://example.org/list', allowHttp: true }],
    };
    expect(importPreferences(exportPreferences(permitted))).toEqual(permitted);
    expect(() =>
      validatePreferences({ ...permitted, sources: [{ ...source, allowHttp: 'true' }] }),
    ).toThrow('permission');
    expect(() =>
      validatePreferences({
        ...permitted,
        sources: [{ ...source, location: 'http://example.org/list' }],
      }),
    ).toThrow('explicit');
  });
  it.each([
    { schemaVersion: 2 },
    { volume: Infinity },
    { volume: -1 },
    { muted: 'false' },
    { panelWidth: 200 },
    { favorites: ['one', 'one'] },
    { sources: [{ id: 's', name: 'n', location: 'file:///etc/passwd', kind: 'url' }] },
  ])('rejects invalid fields (%#)', (patch) => {
    expect(() => validatePreferences({ ...defaultPreferences(), ...patch })).toThrow();
  });
  it('does not acknowledge or publish a failed write', async () => {
    const store = new SerializedPreferencesStore({
      read: async () => null,
      write: async () => {
        throw new Error('disk full');
      },
    });
    await expect(
      store.update((v) => {
        v.favorites.push('one');
      }),
    ).rejects.toThrow('disk full');
    expect(store.snapshot().favorites).toEqual([]);
  });
  it('serializes concurrent edits with no lost successful edits', async () => {
    const writes: Preferences[] = [];
    let concurrent = 0;
    const store = new SerializedPreferencesStore({
      read: async () => null,
      write: async (v) => {
        expect(++concurrent).toBe(1);
        await Promise.resolve();
        writes.push(structuredClone(v));
        concurrent--;
      },
    });
    await Promise.all([
      store.update((v) => {
        v.favorites.push('one');
      }),
      store.update((v) => {
        v.favorites.push('two');
      }),
    ]);
    expect(writes.map((v) => v.favorites)).toEqual([['one'], ['one', 'two']]);
    const copy = store.snapshot();
    copy.favorites.push('outside');
    expect(store.snapshot().favorites).toEqual(['one', 'two']);
  });
  it('keeps current data if loading a corrupt record fails', async () => {
    const store = new SerializedPreferencesStore({
      read: async () => ({ schemaVersion: 0 }),
      write: async () => undefined,
    });
    await store.update((v) => {
      v.favorites.push('saved');
    });
    await expect(store.load()).rejects.toThrow('schema');
    expect(store.snapshot().favorites).toEqual(['saved']);
  });
});

describe('daily source refresh preferences', () => {
  it('defaults missing schema1 fields to disabled/never and roundtrips full backups', () => {
    const legacy = { ...defaultPreferences() } as Record<string, unknown>;
    delete legacy.automaticSourceRefresh;
    delete legacy.sourceRefreshAttemptAt;
    expect(validatePreferences(legacy)).toMatchObject({
      automaticSourceRefresh: false,
      sourceRefreshAttemptAt: 0,
    });
    const value = {
      ...defaultPreferences(),
      automaticSourceRefresh: true,
      sourceRefreshCadence: 'daily' as const,
      sourceRefreshAttemptAt: 1_791_700_000_000,
    };
    expect(importPreferences(exportPreferences(value))).toEqual(value);
    expect(
      parseBackup(
        serializeBackup(createBackup({ schemaVersion: 1, sources: [], channels: [] }, value)),
      ).preferences,
    ).toEqual(value);
  });
  it.each([-1, 0.5, NaN, Infinity, 8_640_000_000_000_001, null, '1'])(
    'rejects invalid attempt timestamp %s',
    (timestamp) => {
      expect(() =>
        validatePreferences({ ...defaultPreferences(), sourceRefreshAttemptAt: timestamp }),
      ).toThrow('Invalid automatic');
    },
  );
  it('refuses nonboolean flags without silently enabling refresh', () => {
    for (const flag of [null, 1, 'true'])
      expect(() =>
        validatePreferences({ ...defaultPreferences(), automaticSourceRefresh: flag }),
      ).toThrow('Invalid automatic');
  });
});
describe('source refresh cadence compatibility', () => {
  it('migrates actual legacy daily boolean and gives explicit cadence authority', () => {
    const legacy = { ...defaultPreferences() } as Record<string, unknown>;
    delete legacy.sourceRefreshCadence;
    expect(validatePreferences({ ...legacy, automaticSourceRefresh: true })).toMatchObject({
      sourceRefreshCadence: 'daily',
      automaticSourceRefresh: true,
    });
    expect(validatePreferences({ ...legacy, automaticSourceRefresh: false })).toMatchObject({
      sourceRefreshCadence: 'off',
      automaticSourceRefresh: false,
    });
    expect(
      validatePreferences({ ...legacy, automaticSourceRefresh: true, sourceRefreshCadence: 'off' }),
    ).toMatchObject({ automaticSourceRefresh: false });
    expect(
      validatePreferences({
        ...legacy,
        automaticSourceRefresh: false,
        sourceRefreshCadence: 'weekly',
      }),
    ).toMatchObject({ automaticSourceRefresh: true, sourceRefreshCadence: 'weekly' });
  });
  it.each(['off', 'hourly', 'every6hours', 'daily', 'weekly', 'every2weeks', 'monthly'] as const)(
    'roundtrips cadence %s and canonical mirror',
    (sourceRefreshCadence) => {
      const canonical = validatePreferences({ ...defaultPreferences(), sourceRefreshCadence });
      expect(importPreferences(exportPreferences(canonical))).toEqual(canonical);
    },
  );
  it.each([null, 'every-six-hours', 1, true])(
    'refuses invalid explicit cadence %s',
    (sourceRefreshCadence) => {
      expect(() => validatePreferences({ ...defaultPreferences(), sourceRefreshCadence })).toThrow(
        'Invalid refresh cadence',
      );
    },
  );
});
