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

import { describe, expect, it, vi } from 'vitest';
import {
  createSourceSnapshotTransport,
  validateSourceSnapshotPromotion,
  validateSourceSnapshotStage,
  validateSourceSnapshotStatus,
} from '../../src/platform/source-snapshot';
const source = {
  id: 's',
  name: 'Fixture',
  kind: 'url' as const,
  location: 'https://fixture.invalid/catalog.m3u',
};
const initial = {
  schemaVersion: 1 as const,
  snapshotId: 'stage',
  sourceId: 's',
  sourceRevision: '0',
  nextIndex: 0,
  entryCount: 2,
};
const promotion = {
  schemaVersion: 1,
  committed: true,
  sourceId: 's',
  sourceRevision: '1',
  added: 1,
  changed: 0,
  unchanged: 0,
  removed: 0,
  duplicates: 1,
  total: 1,
};
const input = {
  schemaVersion: 1 as const,
  source,
  expectedSourceRevision: '0',
  entryCount: 2,
  platform: 'android',
  observerProfile: 'fixture',
};
const channel = {
  id: 'provisional',
  sourceId: 's',
  name: 'Fox',
  category: 'News',
  urls: ['https://fixture.invalid/fox.m3u8'],
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
describe('native source snapshot transport', () => {
  it('stages duplicate raw entries without inventing health and accepts only actual promotion', async () => {
    const invoke = vi.fn(async (command: string) =>
      command === 'begin_source_snapshot'
        ? initial
        : command === 'append_source_snapshot'
          ? { ...initial, nextIndex: 2 }
          : promotion,
    );
    const adapter = createSourceSnapshotTransport({
      runtime: { invoke, idFactory: () => 'fixture' },
      native: () => true,
    });
    const signal = new AbortController().signal;
    await adapter.begin(input, signal);
    await adapter.append(
      {
        snapshotId: 'stage',
        expectedNextIndex: 0,
        entries: [
          { entryId: channel.id, channel },
          { entryId: channel.id, channel },
        ],
      },
      signal,
    );
    const result = await adapter.promote(
      { snapshotId: 'stage', expectedSourceRevision: '0', completed: true },
      signal,
    );
    expect(result.duplicates).toBe(1);
    expect(result).not.toHaveProperty('health');
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      'begin_source_snapshot',
      'append_source_snapshot',
      'promote_source_snapshot',
    ]);
  });
  it('rejects unknown fields, unsafe revisions, incomplete staging and fabricated committed state', () => {
    expect(() => validateSourceSnapshotStage({ ...initial, nextIndex: 3 })).toThrow();
    expect(() => validateSourceSnapshotStage({ ...initial, sourceRevision: '01' })).toThrow();
    expect(() => validateSourceSnapshotStage({ ...initial, health: 'Reachable' })).toThrow();
    expect(() => validateSourceSnapshotPromotion({ ...promotion, committed: false })).toThrow();
    expect(() => validateSourceSnapshotPromotion({ ...promotion, duplicates: 100_000 })).toThrow();
  });
  it('rejects every C0 and DEL character while preserving the adjacent opaque ID boundaries', async () => {
    const invoke = vi.fn(async (command: string) =>
      command === 'begin_source_snapshot' ? initial : { ...initial, nextIndex: 1 },
    );
    const adapter = createSourceSnapshotTransport({ runtime: { invoke }, native: () => true }),
      signal = new AbortController().signal;
    await adapter.begin(input, signal);
    invoke.mockClear();
    for (const code of [...Array.from({ length: 32 }, (_, index) => index), 127]) {
      const control = String.fromCharCode(code);
      expect(() =>
        validateSourceSnapshotStage({ ...initial, snapshotId: `a${control}b` }),
      ).toThrow();
      await expect(
        adapter.append(
          {
            snapshotId: 'stage',
            expectedNextIndex: 0,
            entries: [{ entryId: `a${control}b`, channel }],
          },
          signal,
        ),
      ).rejects.toThrow();
    }
    expect(invoke).not.toHaveBeenCalled();
    for (const code of [32, 126, 128]) {
      const snapshotId = `a${String.fromCharCode(code)}b`;
      expect(validateSourceSnapshotStage({ ...initial, snapshotId }).snapshotId).toBe(snapshotId);
    }
  });
  it('does not dispatch on browser preview or already-aborted requests', async () => {
    const invoke = vi.fn();
    const adapter = createSourceSnapshotTransport({ runtime: { invoke }, native: () => false });
    await expect(adapter.begin(input, new AbortController().signal)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
    const native = createSourceSnapshotTransport({ runtime: { invoke }, native: () => true });
    const controller = new AbortController();
    controller.abort();
    await expect(native.begin(input, controller.signal)).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('held native main and cancellation are both joined before abort is acknowledged', async () => {
    const entered = deferred<void>(),
      read = deferred<unknown>(),
      cancel = deferred<unknown>();
    const invoke = vi.fn(async (command: string) => {
      if (command === 'cancel_playlist') return cancel.promise;
      entered.resolve();
      return read.promise;
    });
    const adapter = createSourceSnapshotTransport({
        runtime: { invoke, idFactory: () => 'held' },
        native: () => true,
      }),
      controller = new AbortController();
    const work = adapter.begin(input, controller.signal);
    await entered.promise;
    controller.abort();
    let done = false;
    void work
      .catch(() => undefined)
      .finally(() => {
        done = true;
      });
    read.resolve(initial);
    await Promise.resolve();
    expect(done).toBe(false);
    cancel.resolve(null);
    await expect(work).rejects.toThrow();
    expect(invoke).toHaveBeenCalledWith('cancel_playlist', { requestId: 'held' });
  });
  it('late abort cannot replace an admitted durable source promotion receipt', async () => {
    const controller = new AbortController();
    const invoke = vi.fn(async (command: string) => {
      if (command === 'begin_source_snapshot') return { ...initial, entryCount: 0 };
      if (command === 'promote_source_snapshot') {
        controller.abort();
        return { ...promotion, added: 0, duplicates: 0, total: 0 };
      }
      return null;
    });
    const adapter = createSourceSnapshotTransport({
      runtime: { invoke, idFactory: () => 'late' },
      native: () => true,
    });
    await adapter.begin({ ...input, entryCount: 0 }, controller.signal);
    await expect(
      adapter.promote(
        { snapshotId: 'stage', expectedSourceRevision: '0', completed: true },
        controller.signal,
      ),
    ).resolves.toMatchObject({ committed: true, sourceRevision: '1' });
  });
  it('reads structural source status without claiming stream health and rejects mismatched staging', async () => {
    const invoke = vi.fn(async () => ({
      schemaVersion: 1,
      sourceId: 's',
      sourceRevision: '0',
      total: 0,
      missing: 0,
      staging: initial,
    }));
    const adapter = createSourceSnapshotTransport({
      runtime: { invoke, idFactory: () => 'status' },
      native: () => true,
    });
    const result = await adapter.status('s', new AbortController().signal);
    expect(invoke).toHaveBeenCalledWith('source_snapshot_status', {
      request: { schemaVersion: 1, sourceId: 's' },
      requestId: 'status',
    });
    expect(result.staging?.nextIndex).toBe(0);
    expect(result).not.toHaveProperty('resumable');
    expect(() =>
      validateSourceSnapshotStatus({ ...result, staging: { ...initial, sourceRevision: '1' } }),
    ).toThrow();
  });
  it('accepts no due checks without inventing Reachable and refuses a nonprogressing truncated page', async () => {
    const invoke = vi.fn(async () => ({
      schemaVersion: 1,
      sourceRevision: '1',
      rows: [],
      afterOrdinal: null,
      exhausted: true,
    }));
    const adapter = createSourceSnapshotTransport({ runtime: { invoke }, native: () => true });
    const query = {
      sourceId: 's',
      expectedSourceRevision: '1',
      afterOrdinal: null,
      limit: 64,
      nowMs: 100_000,
      positiveTtlMs: 3_600_000,
      retryAfterMs: 600_000,
      platform: 'android',
      observerProfile: 'fixture',
    };
    expect((await adapter.listChecks(query, source, new AbortController().signal)).rows).toEqual(
      [],
    );
    invoke.mockImplementation(async () => ({
      schemaVersion: 1,
      sourceRevision: '1',
      rows: [],
      afterOrdinal: null,
      exhausted: false,
    }));
    await expect(adapter.listChecks(query, source, new AbortController().signal)).rejects.toThrow();
  });
});
