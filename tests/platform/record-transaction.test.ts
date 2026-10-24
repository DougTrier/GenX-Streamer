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

import { checkpointProviders } from '../discovery/helpers/scan-checkpoint';
import { captureStoredScanCheckpoint } from '../../src/application/discovery/scan-checkpoint-capture';
import { parseStoredScanCheckpoint } from '../../src/discovery/scan-checkpoint';
import { checkpointFixture as createCheckpointFixture } from '../discovery/helpers/scan-checkpoint';
const checkpointFixture = (published = false) =>
  createCheckpointFixture(published, 'checkpoint-source');
import { serializeScanCheckpoint, parseScanCheckpoint } from '../../src/discovery/scan-checkpoint';
import {
  readIndexedDbScanCheckpoint,
  writeIndexedDbScanCheckpoint,
} from '../../src/platform/record-transaction';
import { describe, expect, it } from 'vitest';
import { emptyCatalog, serializeCatalog } from '../../src/catalog';
import { defaultPreferences } from '../../src/preferences';
import {
  readIndexedDbRecordPair,
  writeIndexedDbRecordPair,
  writeIndexedDbRecord,
  validateRecordPair,
  validateRevision,
  writeIndexedDbHealth,
  isRecordRevisionConflict,
} from '../../src/platform/record-transaction';
import {
  fingerprintHealthTarget,
  serializeHealthPayload,
  parseHealthPayload,
  type PersistedHealthRecord,
} from '../../src/catalog/health-record';
const catalog = {
  schemaVersion: 1 as const,
  sources: [
    { id: 'source', name: 'Fixture', location: 'https://example.test/list', kind: 'url' as const },
  ],
  channels: [
    {
      id: 'channel',
      sourceId: 'source',
      name: 'One',
      category: '',
      urls: ['https://example.test/live'],
    },
  ],
};
const initial = {
  catalog: serializeCatalog(catalog),
  preferences: JSON.stringify({
    ...defaultPreferences(),
    reviewedChannelProviders: checkpointProviders,
    sources: catalog.sources,
  }),
};
const pair = {
  catalog: serializeCatalog({
    ...catalog,
    channels: [{ ...catalog.channels[0], name: 'Updated' }],
  }),
  preferences: initial.preferences,
};
async function observation(): Promise<PersistedHealthRecord> {
  return {
    schemaVersion: 1,
    channelId: 'channel',
    sourceId: 'source',
    checkedUrlOrdinal: 0,
    targetFingerprint: await fingerprintHealthTarget(catalog.sources[0], catalog.channels[0], 0),
    platform: 'windows',
    observerProfile: 'fixture',
    observedAt: 1000,
    verdict: 'Reachable',
    evidence: { kind: 'http', status: 200, contentRecognized: true },
    origin: 'local',
  };
}
// Controlled transaction lifecycle fixtures; actual Chromium gates separately prove IndexedDB.
function fixture(seed: Map<string, unknown> = new Map(Object.entries(initial)), failPut?: string) {
  const saved = new Map(seed);
  const calls: unknown[][] = [];
  const puts: string[] = [];
  let latest: ReturnType<typeof transaction> | undefined;
  function transaction(mode: string) {
    const staged = new Map<string, unknown>();
    const deleted = new Set<string>();
    const gets: Array<{ onsuccess: (() => void) | null; readonly result: unknown }> = [];
    let complete = false,
      aborted = false;
    const tx = {
      oncomplete: null as (() => void) | null,
      onabort: null as (() => void) | null,
      objectStore: () => ({
        get: (key: string) => {
          const request = {
            onsuccess: null as (() => void) | null,
            get result() {
              return saved.get(key);
            },
          };
          gets.push(request);
          return request;
        },
        put: (value: unknown, key: string) => {
          puts.push(key);
          if (key === failPut) throw new Error('Controlled storage failure');
          staged.set(key, value);
        },
        delete: (key: string) => {
          deleted.add(key);
        },
      }),
      abort: () => {
        if (complete) throw new DOMException('Already committed', 'InvalidStateError');
        aborted = true;
        staged.clear();
        queueMicrotask(() => tx.onabort?.());
      },
    };
    const admit = () => {
      for (const request of gets) request.onsuccess?.();
    };
    const commit = (deliver = true) => {
      if (aborted) throw new Error('Aborted fixture');
      complete = true;
      for (const key of deleted) saved.delete(key);
      for (const [key, value] of staged) saved.set(key, value);
      if (deliver) tx.oncomplete?.();
    };
    if (mode === 'readonly') queueMicrotask(() => tx.oncomplete?.());
    return { tx, admit, commit };
  }
  const database = {
    transaction: (...args: unknown[]) => {
      calls.push(args);
      const created = transaction(args[1] as string);
      if (args[1] === 'readwrite') latest = created;
      return created.tx;
    },
  } as unknown as IDBDatabase;
  async function ready() {
    for (let i = 0; i < 100 && !latest; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    if (!latest) throw new Error('Missing write transaction');
    return latest;
  }
  return { saved, calls, puts, database, ready };
}
describe('paired separate health publication', () => {
  it('reports typed browser conflicts only for guarded revisions, including precommit races', async () => {
    const f = fixture();
    const initialConflict = await writeIndexedDbRecordPair(f.database, {
      ...pair,
      expectedCatalogRevision: '1',
    }).catch((error: unknown) => error);
    expect(isRecordRevisionConflict(initialConflict)).toBe(true);
    const pending = writeIndexedDbRecordPair(f.database, pair);
    const tx = await f.ready();
    f.saved.set('healthRevision', '1');
    tx.admit();
    const conflict = await pending.catch((error: unknown) => error);
    expect(isRecordRevisionConflict(conflict)).toBe(true);
    const invalid = await writeIndexedDbRecordPair(f.database, {
      ...pair,
      expectedHealthRevision: '01',
    }).catch((error: unknown) => error);
    expect(isRecordRevisionConflict(invalid)).toBe(false);
    const broken = fixture(undefined, 'catalog');
    const failed = writeIndexedDbRecordPair(broken.database, pair);
    const failedTx = await broken.ready();
    failedTx.admit();
    expect(isRecordRevisionConflict(await failed.catch((error: unknown) => error))).toBe(false);
  });
  it('rolls back health-only admission failure and cancellation but confirms a late-aborted commit', async () => {
    const health = serializeHealthPayload([await observation()]);
    const failed = fixture(undefined, 'healthRevision');
    const failure = writeIndexedDbHealth(failed.database, health, '0', '0');
    const failedTx = await failed.ready();
    failedTx.admit();
    await expect(failure).rejects.toThrow('Previous data retained');
    expect(failed.saved.has('health')).toBe(false);
    for (const commitFirst of [false, true]) {
      const f = fixture();
      const controller = new AbortController();
      const pending = writeIndexedDbHealth(f.database, health, '0', '0', controller.signal);
      const tx = await f.ready();
      tx.admit();
      if (commitFirst) tx.commit(false);
      controller.abort();
      if (commitFirst) {
        tx.tx.oncomplete?.();
        expect(await pending).toEqual({
          committed: true,
          catalogRevision: '0',
          healthRevision: '1',
        });
      } else {
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(f.saved.has('health')).toBe(false);
      }
      expect(f.saved.get('catalog')).toBe(initial.catalog);
      expect(f.saved.get('preferences')).toBe(initial.preferences);
    }
  });
  it('merges a guarded health delta without rewriting catalog, preferences or catalog revision', async () => {
    const old = await observation();
    const f = fixture(
      new Map([
        ...Object.entries(initial),
        ['health', serializeHealthPayload([old])],
        ['catalogRevision', '7'],
        ['healthRevision', '3'],
      ]),
    );
    const incoming = { ...old, observerProfile: 'fixture-60000', observedAt: 2000 };
    const pending = writeIndexedDbHealth(f.database, serializeHealthPayload([incoming]), '7', '3');
    const tx = await f.ready();
    tx.admit();
    tx.commit();
    expect(await pending).toEqual({ committed: true, catalogRevision: '7', healthRevision: '4' });
    expect(f.puts).toEqual(['health', 'healthRevision']);
    expect(parseHealthPayload(f.saved.get('health') as string).records).toHaveLength(2);
    expect(f.saved.get('catalog')).toBe(initial.catalog);
    expect(f.saved.get('preferences')).toBe(initial.preferences);
  });
  it('refuses missing/stale health guards and retains all admitted contexts without truncation', async () => {
    const record = await observation();
    const f = fixture(new Map([...Object.entries(initial), ['healthRevision', '4']]));
    await expect(
      writeIndexedDbRecordPair(f.database, {
        ...initial,
        health: serializeHealthPayload([record]),
      }),
    ).rejects.toThrow('both saved revisions');
    await expect(
      writeIndexedDbHealth(f.database, serializeHealthPayload([record]), '0', '3'),
    ).rejects.toThrow('health changed');
    const previous = [0, 1, 2, 3].map((index) => ({
      ...record,
      observerProfile: `fixture-${index}`,
    }));
    const bounded = fixture(
      new Map([...Object.entries(initial), ['health', serializeHealthPayload(previous)]]),
    );
    const pending = writeIndexedDbHealth(
      bounded.database,
      serializeHealthPayload([{ ...record, observerProfile: 'fifth' }]),
      '0',
      '0',
    );
    const tx = await bounded.ready();
    tx.admit();
    tx.commit();
    expect(await pending).toEqual({ committed: true, catalogRevision: '0', healthRevision: '1' });
    expect(parseHealthPayload(bounded.saved.get('health') as string).records).toHaveLength(5);
  });
  it('keeps newer useful local evidence when a delta is imported, older or canceled', async () => {
    const old = { ...(await observation()), observedAt: 3000 };
    for (const delta of [
      { ...old, origin: 'imported' as const, observedAt: 4000 },
      { ...old, observedAt: 2000 },
      {
        ...old,
        observedAt: 4000,
        verdict: 'Canceled' as const,
        evidence: { kind: 'canceled' as const },
      },
    ]) {
      const f = fixture(
        new Map([
          ...Object.entries(initial),
          ['health', serializeHealthPayload([old])],
          ['healthRevision', '3'],
        ]),
      );
      const pending = writeIndexedDbHealth(f.database, serializeHealthPayload([delta]), '0', '3');
      const tx = await f.ready();
      tx.admit();
      tx.commit();
      expect(await pending).toEqual({ committed: true, catalogRevision: '0', healthRevision: '3' });
      expect(parseHealthPayload(f.saved.get('health') as string).records).toEqual([old]);
    }
  });
  it('rolls back earlier puts when a later health write fails', async () => {
    const f = fixture(undefined, 'health');
    const before = new Map(f.saved);
    const pending = writeIndexedDbRecordPair(f.database, {
      ...pair,
      health: serializeHealthPayload([await observation()]),
      expectedCatalogRevision: '0',
      expectedHealthRevision: '0',
    });
    const tx = await f.ready();
    tx.admit();
    await expect(pending).rejects.toThrow('Previous data retained');
    expect(f.saved).toEqual(before);
  });
  it('uses persistent revisions and one strict atomic write after snapshot admission', async () => {
    const f = fixture();
    const pending = writeIndexedDbRecordPair(f.database, { ...pair, expectedCatalogRevision: '0' });
    const tx = await f.ready();
    tx.admit();
    expect(f.saved.get('catalog')).toBe(initial.catalog);
    tx.commit();
    expect(await pending).toEqual({ committed: true, catalogRevision: '1', healthRevision: '0' });
    expect(f.calls).toEqual([
      ['records', 'readonly'],
      ['records', 'readwrite', { durability: 'strict' }],
    ]);
  });
  it('rolls back all payloads/revisions when canceled before publication', async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = writeIndexedDbRecordPair(f.database, pair, controller.signal);
    const tx = await f.ready();
    tx.admit();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.saved.get('catalog')).toBe(initial.catalog);
    expect(f.saved.has('catalogRevision')).toBe(false);
  });
  it('reports truthful durable receipt when abort arrives after actual commit', async () => {
    const f = fixture();
    const controller = new AbortController();
    const pending = writeIndexedDbRecordPair(f.database, pair, controller.signal);
    const tx = await f.ready();
    tx.admit();
    tx.commit(false);
    controller.abort();
    tx.tx.oncomplete?.();
    expect(await pending).toEqual({ committed: true, catalogRevision: '1', healthRevision: '0' });
  });
  it('rejects stale expected CAS and races during preparation without overwriting', async () => {
    const f = fixture();
    await expect(
      writeIndexedDbRecordPair(f.database, { ...pair, expectedCatalogRevision: '2' }),
    ).rejects.toThrow('changed');
    expect(f.calls).toHaveLength(1);
    const other = fixture();
    const pending = writeIndexedDbRecordPair(other.database, pair);
    const tx = await other.ready();
    other.saved.set('catalogRevision', '1');
    tx.admit();
    await expect(pending).rejects.toThrow('changed');
    expect(other.saved.get('catalog')).toBe(initial.catalog);
  });
  it('persists separate health and filters changed URL targets atomically', async () => {
    const health = serializeHealthPayload([await observation()]);
    const f = fixture();
    const pending = writeIndexedDbRecordPair(f.database, {
      ...initial,
      health,
      expectedCatalogRevision: '0',
      expectedHealthRevision: '0',
    });
    let tx = await f.ready();
    tx.admit();
    tx.commit();
    expect(await pending).toEqual({ committed: true, catalogRevision: '0', healthRevision: '1' });
    expect(parseHealthPayload(f.saved.get('health') as string).records).toHaveLength(1);
    const changed = fixture(f.saved);
    const next = {
      ...catalog,
      channels: [{ ...catalog.channels[0], urls: ['https://example.test/changed'] }],
    };
    const update = writeIndexedDbRecord(changed.database, 'catalog', serializeCatalog(next));
    tx = await changed.ready();
    tx.admit();
    tx.commit();
    expect(await update).toEqual({ committed: true, catalogRevision: '1', healthRevision: '2' });
    expect(parseHealthPayload(changed.saved.get('health') as string).records).toEqual([]);
    expect(changed.saved.get('preferences')).toBe(initial.preferences);
  });
  it('preferences-only and identical canonical catalog writes retain health and catalog revision', async () => {
    const health = serializeHealthPayload([await observation()]);
    const f = fixture(
      new Map([
        ...Object.entries(initial),
        ['health', health],
        ['catalogRevision', '9007199254740993'],
        ['healthRevision', '3'],
      ]),
    );
    const pending = writeIndexedDbRecord(
      f.database,
      'preferences',
      JSON.stringify({
        ...defaultPreferences(),
        reviewedChannelProviders: checkpointProviders,
        volume: 0.5,
      }),
    );
    const tx = await f.ready();
    tx.admit();
    tx.commit();
    expect(await pending).toEqual({
      committed: true,
      catalogRevision: '9007199254740993',
      healthRevision: '3',
    });
    expect(f.saved.get('health')).toBe(health);
  });
  it('rejects explicit wrongtarget health rather than silently dropping it', async () => {
    const f = fixture();
    const health = serializeHealthPayload([
      { ...(await observation()), targetFingerprint: 'a'.repeat(64) },
    ]);
    await expect(
      writeIndexedDbRecordPair(f.database, {
        ...initial,
        health,
        expectedCatalogRevision: '0',
        expectedHealthRevision: '0',
      }),
    ).rejects.toThrow('target');
    expect(f.calls).toHaveLength(1);
  });
  it('refuses health races, invalid revisions and separate oversized payloads', async () => {
    const f = fixture();
    const pending = writeIndexedDbRecordPair(f.database, pair);
    const tx = await f.ready();
    f.saved.set('healthRevision', '1');
    tx.admit();
    await expect(pending).rejects.toThrow('changed');
    for (const revision of ['01', '-1', '1.1', '9223372036854775808'])
      expect(() => validateRevision(revision)).toThrow();
    const bounded = fixture();
    await expect(
      writeIndexedDbRecordPair(bounded.database, {
        ...pair,
        health: 'é'.repeat(10 * 1024 * 1024 + 1),
      }),
    ).rejects.toThrow('bounds');
    expect(bounded.calls).toHaveLength(0);
  });
  it('startup nulls and legacy missing revisions are one coherent read; corrupt stored types refused', async () => {
    const f = fixture(new Map());
    expect(await readIndexedDbRecordPair(f.database)).toEqual({
      catalog: null,
      preferences: null,
      health: null,
      catalogRevision: '0',
      healthRevision: '0',
    });
    f.saved.set('catalogRevision', null);
    await expect(readIndexedDbRecordPair(f.database)).rejects.toThrow('invalid');
  });
  it('pre-canceled queued work never opens any transaction', async () => {
    const f = fixture();
    const abort = new AbortController();
    abort.abort();
    await expect(writeIndexedDbRecordPair(f.database, pair, abort.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(f.calls).toHaveLength(0);
  });
  it('validates paired domain/mirror and separate health without shrinking catalog capacity', () => {
    const input = {
      catalog: JSON.stringify(emptyCatalog()),
      preferences: JSON.stringify(defaultPreferences()),
    };
    expect(validateRecordPair(input)).toEqual(input);
    expect(() => validateRecordPair({ ...input, catalog: '{"schemaVersion":99}' })).toThrow();
    const preferences = defaultPreferences();
    preferences.sources = [{ id: 'source', name: 'Fixture', location: 'fixture', kind: 'file' }];
    expect(() =>
      validateRecordPair({ ...input, preferences: JSON.stringify(preferences) }),
    ).toThrow();
  });
});

describe('durable operational scan checkpoint', () => {
  it('stores checkpoint-only without rewriting catalog/preferences/health and retains a discard tombstone revision', async () => {
    const f = fixture(),
      checkpoint = await checkpointFixture();
    expect(await readIndexedDbScanCheckpoint(f.database)).toEqual({
      checkpoint: null,
      checkpointStatus: 'absent',
      jobId: null,
      checkpointRevision: '0',
      catalogRevision: '0',
    });
    const pending = writeIndexedDbScanCheckpoint(
      f.database,
      { kind: 'save', checkpoint: await serializeScanCheckpoint(checkpoint) },
      '0',
      '0',
    );
    const tx = await f.ready();
    tx.admit();
    tx.commit();
    expect(await pending).toEqual({
      committed: true,
      catalogRevision: '0',
      healthRevision: '0',
      checkpointRevision: '1',
    });
    expect(f.puts).toEqual(['scanCheckpoint', 'checkpointJobId', 'checkpointRevision']);
    const other = fixture(f.saved);
    const discard = writeIndexedDbScanCheckpoint(
      other.database,
      { kind: 'discard', jobId: checkpoint.jobId },
      '0',
      '1',
    );
    const removal = await other.ready();
    removal.admit();
    removal.commit();
    expect((await discard).checkpointRevision).toBe('2');
    expect(await readIndexedDbScanCheckpoint(other.database)).toEqual({
      checkpoint: null,
      checkpointStatus: 'absent',
      jobId: null,
      checkpointRevision: '2',
      catalogRevision: '0',
    });
  });
  it('publishes paired catalog plus acknowledged checkpoint atomically and stamps actual postcommit revision', async () => {
    const c = await checkpointFixture(true);
    const nextCatalog = {
      schemaVersion: 1 as const,
      sources: [c.sourceDefinitions[0].source],
      channels: [{ ...c.review.candidates[0].channel, id: 'new-canonical' }],
    };
    const f = fixture();
    const pending = writeIndexedDbRecordPair(f.database, {
      catalog: serializeCatalog(nextCatalog),
      preferences: JSON.stringify({
        ...defaultPreferences(),
        reviewedChannelProviders: checkpointProviders,
        sources: nextCatalog.sources,
      }),
      expectedCatalogRevision: '0',
      expectedCheckpointRevision: '0',
      scanCheckpoint: { kind: 'save', checkpoint: await serializeScanCheckpoint(c) },
    });
    const tx = await f.ready();
    tx.admit();
    tx.commit();
    expect((await pending).catalogRevision).toBe('1');
    expect(
      (await parseScanCheckpoint(f.saved.get('scanCheckpoint') as string)).catalogRevision,
    ).toBe('1');
    expect(JSON.parse(f.saved.get('catalog') as string).channels[0].id).toBe('new-canonical');
  });
  it('rollback preserves paired data and old checkpoint when checkpoint write fails', async () => {
    const f = fixture(undefined, 'checkpointRevision'),
      c = await checkpointFixture();
    const before = new Map(f.saved);
    const pending = writeIndexedDbRecordPair(f.database, {
      ...pair,
      expectedCatalogRevision: '0',
      expectedCheckpointRevision: '0',
      scanCheckpoint: { kind: 'save', checkpoint: await serializeScanCheckpoint(c) },
    });
    const tx = await f.ready();
    tx.admit();
    await expect(pending).rejects.toThrow('Previous data retained');
    expect(f.saved).toEqual(before);
  });
  it('rejects stale checkpoints, wrong discard owners and concurrent preferences changes before commit', async () => {
    const c = await checkpointFixture(),
      checkpoint = await serializeScanCheckpoint(c);
    const f = fixture(
      new Map([
        ...Object.entries(initial),
        ['scanCheckpoint', checkpoint],
        ['checkpointJobId', 'fixture-job'],
        ['checkpointRevision', '1'],
      ]),
    );
    await expect(
      writeIndexedDbScanCheckpoint(f.database, { kind: 'save', checkpoint }, '0', '0'),
    ).rejects.toThrow('changed');
    await expect(
      writeIndexedDbScanCheckpoint(f.database, { kind: 'discard', jobId: 'different' }, '0', '1'),
    ).rejects.toThrow('changed');
    const pending = writeIndexedDbScanCheckpoint(
      f.database,
      { kind: 'save', checkpoint },
      '0',
      '1',
    );
    const tx = await f.ready();
    f.saved.set(
      'preferences',
      JSON.stringify({
        ...defaultPreferences(),
        reviewedChannelProviders: checkpointProviders,
        muted: true,
      }),
    );
    tx.admit();
    await expect(pending).rejects.toThrow('changed');
    expect(f.saved.get('scanCheckpoint')).toBe(checkpoint);
  });
});

it('checkpoint cancellation rolls back, while abort after durable commit returns the true receipt', async () => {
  const checkpoint = await serializeScanCheckpoint(await checkpointFixture());
  for (const commitFirst of [false, true]) {
    const f = fixture(),
      abort = new AbortController();
    const pending = writeIndexedDbScanCheckpoint(
      f.database,
      { kind: 'save', checkpoint },
      '0',
      '0',
      abort.signal,
    );
    const tx = await f.ready();
    tx.admit();
    if (commitFirst) tx.commit(false);
    abort.abort();
    if (commitFirst) {
      tx.tx.oncomplete?.();
      expect((await pending).checkpointRevision).toBe('1');
      expect(f.saved.get('scanCheckpoint')).toBe(checkpoint);
    } else {
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      expect(f.saved.has('scanCheckpoint')).toBe(false);
      expect(f.saved.has('checkpointRevision')).toBe(false);
    }
  }
});
it('checkpoint precommit CAS refuses a newer owner without clearing or overwriting it', async () => {
  const f = fixture(),
    checkpoint = await serializeScanCheckpoint(await checkpointFixture());
  const pending = writeIndexedDbScanCheckpoint(f.database, { kind: 'save', checkpoint }, '0', '0');
  const tx = await f.ready();
  f.saved.set('checkpointRevision', '1');
  f.saved.set('scanCheckpoint', 'newer-owner');
  tx.admit();
  await expect(pending).rejects.toThrow('changed');
  expect(f.saved.get('scanCheckpoint')).toBe('newer-owner');
});

it('invalid checkpoint is reported and preserved, and exact job metadata permits guarded explicit discard', async () => {
  const f = fixture(
    new Map([
      ...Object.entries(initial),
      ['scanCheckpoint', 'corrupt-body'],
      ['checkpointJobId', 'fixture-job'],
      ['checkpointRevision', '3'],
    ]),
  );
  expect(await readIndexedDbScanCheckpoint(f.database)).toEqual({
    checkpoint: null,
    checkpointStatus: 'invalid',
    jobId: 'fixture-job',
    catalogRevision: '0',
    checkpointRevision: '3',
  });
  expect(f.saved.get('scanCheckpoint')).toBe('corrupt-body');
  const discard = writeIndexedDbScanCheckpoint(
    f.database,
    { kind: 'discard', jobId: 'fixture-job' },
    '0',
    '3',
  );
  const tx = await f.ready();
  tx.admit();
  tx.commit();
  expect((await discard).checkpointRevision).toBe('4');
  expect(f.saved.has('scanCheckpoint')).toBe(false);
  expect(f.saved.has('checkpointJobId')).toBe(false);
});

it('checkpoint admission refuses a saved source ID reused for a different URL', async () => {
  const f = fixture();
  const checkpoint = await createCheckpointFixture(false, 'source');
  const before = new Map(f.saved);
  await expect(
    writeIndexedDbScanCheckpoint(
      f.database,
      {
        kind: 'save',
        checkpoint: await serializeScanCheckpoint(checkpoint),
      },
      '0',
      '0',
    ),
  ).rejects.toThrow();
  expect(f.saved).toEqual(before);
  expect(f.puts).toEqual([]);
});

it('atomically saves and reopens a URL-free v2 checkpoint, refusing a changed acknowledged target', async () => {
  const c = await checkpointFixture(true);
  c.review.candidates[0]!.channel.urls = [
    'https://fixture.invalid/live/test-user/test-pass/first.ts',
  ];
  const { schemaVersion: _v, policyFingerprint: _p, sourceDefinitions, ...state } = c;
  const wire = await captureStoredScanCheckpoint({
    ...state,
    sources: sourceDefinitions.map((d) => d.source),
    providers: checkpointProviders,
  });
  expect(wire).not.toBeNull();
  expect(wire).not.toContain('test-pass');
  const nextCatalog = {
    schemaVersion: 1 as const,
    sources: [sourceDefinitions[0]!.source],
    channels: [{ ...c.review.candidates[0]!.channel, id: 'canonical' }],
  };
  const f = fixture();
  const pending = writeIndexedDbRecordPair(f.database, {
    catalog: serializeCatalog(nextCatalog),
    preferences: JSON.stringify({
      ...defaultPreferences(),
      reviewedChannelProviders: checkpointProviders,
      sources: nextCatalog.sources,
    }),
    expectedCatalogRevision: '0',
    expectedCheckpointRevision: '0',
    scanCheckpoint: { kind: 'save', checkpoint: wire! },
  });
  const tx = await f.ready();
  tx.admit();
  tx.commit();
  expect(await pending).toMatchObject({ catalogRevision: '1', checkpointRevision: '1' });
  const read = await readIndexedDbScanCheckpoint(f.database);
  expect(read).toMatchObject({ checkpointStatus: 'valid', jobId: c.jobId, catalogRevision: '1' });
  expect(await parseStoredScanCheckpoint(read.checkpoint!)).toMatchObject({
    schemaVersion: 2,
    catalogRevision: '1',
    publishedKeys: c.publishedKeys,
  });
  const before = new Map(f.saved);
  await expect(
    writeIndexedDbRecordPair(f.database, {
      preferences: JSON.stringify({
        ...defaultPreferences(),
        reviewedChannelProviders: checkpointProviders,
        sources: nextCatalog.sources,
      }),
      catalog: serializeCatalog({
        ...nextCatalog,
        channels: [{ ...nextCatalog.channels[0]!, urls: ['https://different.invalid/live'] }],
      }),
      expectedCatalogRevision: '1',
      expectedCheckpointRevision: '1',
      scanCheckpoint: { kind: 'save', checkpoint: read.checkpoint! },
    }),
  ).rejects.toThrow();
  expect(f.saved).toEqual(before);
});

it('browser paired and standalone writes refuse native-only advance without erasing any saved records', async () => {
  const c = await checkpointFixture(),
    checkpoint = await serializeScanCheckpoint(c);
  c.review.candidates[0]!.channel.urls = [
    'https://public.fixture.invalid/live/test-user/test-pass/stream.ts',
  ];
  const { schemaVersion: _v, policyFingerprint: _p, sourceDefinitions, ...state } = c;
  const reference = await captureStoredScanCheckpoint({
    ...state,
    sources: sourceDefinitions.map((d) => d.source),
    providers: checkpointProviders,
  });
  expect(reference).not.toBeNull();
  for (const stored of [checkpoint, reference!]) {
    const seed = new Map<string, unknown>([
      ...Object.entries(initial),
      ['scanCheckpoint', stored],
      ['checkpointJobId', c.jobId],
      ['checkpointRevision', '1'],
      ['healthRevision', '0'],
      ['catalogRevision', '0'],
    ]);
    for (const paired of [false, true]) {
      const f = fixture(new Map(seed)),
        before = new Map(f.saved);
      const mutation = {
        kind: 'advance' as const,
        jobId: c.jobId,
        reviewDigest: 'a'.repeat(64),
        observations: [],
        publishedKeys: [],
      };
      const pending = paired
        ? writeIndexedDbRecordPair(f.database, {
            ...initial,
            expectedCatalogRevision: '0',
            expectedCheckpointRevision: '1',
            scanCheckpoint: mutation,
          })
        : writeIndexedDbScanCheckpoint(f.database, mutation, '0', '1');
      await expect(pending).rejects.toThrow('Invalid scan checkpoint mutation');
      expect(f.saved).toEqual(before);
      expect(f.puts).toEqual([]);
      expect(f.calls.every((call) => call[1] === 'readonly')).toBe(true);
      expect(await readIndexedDbScanCheckpoint(f.database)).toMatchObject({
        checkpointStatus: 'valid',
        checkpoint: stored,
        jobId: c.jobId,
        checkpointRevision: '1',
        catalogRevision: '0',
      });
    }
  }
});

it('staged v3 browser consumer saves/reopens packed metadata atomically and rejects changed targets', async () => {
  const { preparePackedScanCheckpoint } = await import('../../src/discovery/scan-checkpoint');
  const c = await checkpointFixture(true);
  c.review.candidates[0]!.channel.urls = [
    'https://fixture.invalid/live/private-user/private-password/first.ts',
  ];
  const { schemaVersion: _v, policyFingerprint: _p, sourceDefinitions, ...state } = c;
  const packed = await preparePackedScanCheckpoint({
    ...state,
    sources: sourceDefinitions.map((d) => d.source),
    providers: checkpointProviders,
  });
  const wire = JSON.stringify(packed);
  expect(wire).not.toContain('private-password');
  const nextCatalog = {
    schemaVersion: 1 as const,
    sources: [sourceDefinitions[0]!.source],
    channels: [{ ...c.review.candidates[0]!.channel, id: 'canonical' }],
  };
  const f = fixture();
  const pending = writeIndexedDbRecordPair(f.database, {
    catalog: serializeCatalog(nextCatalog),
    preferences: JSON.stringify({
      ...defaultPreferences(),
      reviewedChannelProviders: checkpointProviders,
      sources: nextCatalog.sources,
    }),
    expectedCatalogRevision: '0',
    expectedCheckpointRevision: '0',
    scanCheckpoint: { kind: 'save', checkpoint: wire },
  });
  const tx = await f.ready();
  tx.admit();
  tx.commit();
  expect(await pending).toMatchObject({ catalogRevision: '1', checkpointRevision: '1' });
  const read = await readIndexedDbScanCheckpoint(f.database);
  expect(read).toMatchObject({ checkpointStatus: 'valid', catalogRevision: '1' });
  expect(await parseStoredScanCheckpoint(read.checkpoint!)).toMatchObject({
    schemaVersion: 3,
    catalogRevision: '1',
    publishedIndices: [0],
  });
  const before = new Map(f.saved),
    putsBefore = [...f.puts];
  await expect(
    writeIndexedDbRecordPair(f.database, {
      catalog: serializeCatalog({
        ...nextCatalog,
        channels: [{ ...nextCatalog.channels[0]!, name: 'Changed' }],
      }),
      preferences: JSON.stringify({
        ...defaultPreferences(),
        reviewedChannelProviders: checkpointProviders,
        sources: nextCatalog.sources,
      }),
      expectedCatalogRevision: '1',
      expectedCheckpointRevision: '1',
      scanCheckpoint: { kind: 'save', checkpoint: read.checkpoint! },
    }),
  ).rejects.toThrow();
  expect(f.saved).toEqual(before);
  expect(f.puts).toEqual(putsBefore);
});
