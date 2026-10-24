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
  createIncrementalRefreshCoordinator,
  type IncrementalRefreshHost,
  type IncrementalRefreshScope,
  type SourceSnapshotStage,
} from '../../src/discovery/incremental-refresh';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const source = (id: string) => ({
  id,
  name: id,
  kind: 'url' as const,
  location: `https://fixture.invalid/${id}.m3u`,
});
const scope = (): IncrementalRefreshScope => ({
  scopeId: 'owned',
  sources: [
    { source: source('a'), sourceRevision: '0' },
    { source: source('b'), sourceRevision: '0' },
  ],
  platform: 'android',
  observerProfile: 'fixture',
  query: 'Fox',
  intent: 'refresh',
});
const entries = (id: string) =>
  [0, 1].map((i) => ({
    entryId: `${id}-${i}`,
    channel: {
      id: `${id}-${i}`,
      sourceId: id,
      name: i ? 'Other' : 'Fox',
      category: 'News',
      urls: [`https://fixture.invalid/${id}/${i}.m3u8`],
    },
  }));
function host(): IncrementalRefreshHost {
  const stages = new Map<string, SourceSnapshotStage>();
  return {
    current: () => true,
    collect: vi.fn(async (s) => ({
      entryCount: 2,
      pages: (async function* () {
        yield entries(s.id);
      })(),
      dispose: vi.fn(async () => undefined),
    })),
    snapshots: {
      begin: vi.fn(async (input) => {
        const stage = {
          schemaVersion: 1 as const,
          snapshotId: input.source.id,
          sourceId: input.source.id,
          sourceRevision: input.expectedSourceRevision,
          nextIndex: 0,
          entryCount: input.entryCount,
        };
        stages.set(stage.snapshotId, stage);
        return stage;
      }),
      append: vi.fn(async (input) => {
        const stage = {
          ...stages.get(input.snapshotId)!,
          nextIndex: input.expectedNextIndex + input.entries.length,
        };
        stages.set(stage.snapshotId, stage);
        return stage;
      }),
      promote: vi.fn(async (input) => ({
        schemaVersion: 1 as const,
        committed: true as const,
        sourceId: input.snapshotId,
        sourceRevision: String(BigInt(input.expectedSourceRevision) + 1n),
        added: 2,
        changed: 0,
        unchanged: 0,
        removed: 0,
        duplicates: 0,
        total: 2,
      })),
    },
    activateChecks: vi.fn(async () => undefined),
    continueChecks: vi.fn(async () => undefined),
    stopChecks: vi.fn(async () => undefined),
  };
}
describe('incremental refresh ownership', () => {
  it('indexes every entry before checks and captures query separately from source collection', async () => {
    const h = host(),
      owner = createIncrementalRefreshCoordinator(h),
      input = scope();
    const result = await owner.start(input);
    expect(result.status).toBe('completed');
    expect(h.snapshots.append).toHaveBeenCalledTimes(2);
    expect(
      vi.mocked(h.snapshots.append).mock.calls[0]![0].entries.map((e) => e.channel.name),
    ).toEqual(['Fox', 'Other']);
    expect(h.activateChecks).toHaveBeenCalledWith(
      expect.objectContaining({ query: 'Fox', intent: 'refresh' }),
      expect.arrayContaining([
        expect.objectContaining({ sourceId: 'a' }),
        expect.objectContaining({ sourceId: 'b' }),
      ]),
      expect.any(AbortSignal),
    );
    expect(h.continueChecks).not.toHaveBeenCalled();
    await owner.dispose();
  });
  it('keeps failed source unpromoted and continues independent source without fabricated health', async () => {
    const h = host();
    const collect = h.collect;
    h.collect = vi.fn(async (s, signal) => {
      if (s.id === 'a') throw new Error('controlled fetch failure');
      return collect(s, signal);
    });
    const owner = createIncrementalRefreshCoordinator(h),
      result = await owner.start(scope());
    expect(result.failedSourceIds).toEqual(['a']);
    expect(result.promotions.map((p) => p.sourceId)).toEqual(['b']);
    expect(h.snapshots.begin).toHaveBeenCalledTimes(1);
    expect(h.snapshots.promote).toHaveBeenCalledTimes(1);
    expect(result).not.toHaveProperty('health');
    await owner.dispose();
  });
  it('Stop waits held fetch and actual disposal, admits no promotion or checks after cancellation', async () => {
    const h = host(),
      entered = deferred<void>(),
      release = deferred<void>(),
      cleanup = deferred<void>();
    h.collect = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return {
        entryCount: 2,
        pages: (async function* () {
          yield entries('a');
        })(),
        dispose: async () => cleanup.promise,
      };
    });
    const owner = createIncrementalRefreshCoordinator(h),
      work = owner.start(scope());
    await entered.promise;
    const stop = owner.stop();
    let stopped = false;
    void stop.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release.resolve();
    await Promise.resolve();
    expect(stopped).toBe(false);
    cleanup.resolve();
    await stop;
    expect((await work).status).toBe('stopped');
    expect(h.snapshots.begin).not.toHaveBeenCalled();
    expect(h.activateChecks).not.toHaveBeenCalled();
    await owner.dispose();
  });
  it('scope drift cannot activate stale source checks and failed owner cleanup is not cancellation success', async () => {
    const h = host();
    let current = true;
    h.current = () => current;
    h.snapshots.promote = vi.fn(async () => {
      current = false;
      return {
        schemaVersion: 1 as const,
        committed: true as const,
        sourceId: 'a',
        sourceRevision: '1',
        added: 2,
        changed: 0,
        unchanged: 0,
        removed: 0,
        duplicates: 0,
        total: 2,
      };
    });
    const owner = createIncrementalRefreshCoordinator(h);
    await expect(owner.start(scope())).rejects.toThrow();
    expect(h.activateChecks).not.toHaveBeenCalled();
    await owner.dispose();
    const bad = host();
    bad.collect = async () => ({
      entryCount: 2,
      pages: (async function* () {
        yield entries('a');
      })(),
      dispose: async () => {
        throw new Error('controlled join failure');
      },
    });
    await expect(createIncrementalRefreshCoordinator(bad).start(scope())).rejects.toThrow(
      'controlled join failure',
    );
  });
  it('Continue uses only persistent owner and Stop joins its actual work', async () => {
    const h = host(),
      entered = deferred<void>(),
      release = deferred<void>();
    h.continueChecks = vi.fn(async (signal) => {
      entered.resolve();
      await release.promise;
      signal.throwIfAborted();
    });
    const owner = createIncrementalRefreshCoordinator(h),
      work = owner.continue(new AbortController().signal);
    await entered.promise;
    const stop = owner.stop();
    let done = false;
    void stop.then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    release.resolve();
    await stop;
    await work;
    expect(h.collect).not.toHaveBeenCalled();
    expect(h.snapshots.begin).not.toHaveBeenCalled();
    await owner.dispose();
  });
  it('reports failed disposal during cancellation rather than acknowledging a successful Stop', async () => {
    const h = host(),
      entered = deferred<void>(),
      release = deferred<void>(),
      failure = new Error('controlled cancellation cleanup failure');
    const dispose = vi.fn(async () => {
      throw failure;
    });
    h.collect = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return {
        entryCount: 2,
        pages: (async function* () {
          yield entries('a');
        })(),
        dispose,
      };
    });
    const owner = createIncrementalRefreshCoordinator(h),
      work = owner.start(scope());
    const rejectedWork = expect(work).rejects.toBe(failure);
    await entered.promise;
    const stopped = expect(owner.stop()).rejects.toBe(failure);
    release.resolve();
    await Promise.all([rejectedWork, stopped]);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(h.snapshots.begin).not.toHaveBeenCalled();
    expect(h.snapshots.promote).not.toHaveBeenCalled();
    expect(h.activateChecks).not.toHaveBeenCalled();
    await owner.dispose();
  });
});

describe('session index reuse for query searches', () => {
  it('reuses only unchanged recently indexed sources for a query search', async () => {
    const { createIndexFreshness } = await import('../../src/discovery/index-freshness');
    let clock = 1_000_000;
    const freshness = createIndexFreshness(() => clock);
    const first = { ...host(), freshness };
    await createIncrementalRefreshCoordinator(first).start(scope());
    expect(first.collect).toHaveBeenCalledTimes(2);
    // Next search: both sources are now at the promoted revision '1'.
    const next = { ...host(), freshness };
    const searchScope = {
      ...scope(),
      sources: scope().sources.map((s) => ({ ...s, sourceRevision: '1' })),
    };
    await createIncrementalRefreshCoordinator(next).start(searchScope);
    expect(next.collect).not.toHaveBeenCalled();
    expect(next.activateChecks).toHaveBeenCalledWith(expect.anything(), [], expect.anything(), [
      { sourceId: 'a', sourceRevision: '1' },
      { sourceId: 'b', sourceRevision: '1' },
    ]);
    // An empty-query refresh, a full recheck, a changed revision or an old index re-collects.
    for (const variant of [
      { ...searchScope, query: '' },
      { ...searchScope, intent: 'full-recheck' as const },
      // Earlier variants re-indexed to '2'; '9' is a revision this instance never promoted.
      { ...searchScope, sources: [{ ...searchScope.sources[0]!, sourceRevision: '9' }] },
    ]) {
      const other = { ...host(), freshness };
      await createIncrementalRefreshCoordinator(other).start(variant);
      expect(other.collect).toHaveBeenCalled();
    }
    clock += 6 * 60 * 60 * 1000;
    const stale = { ...host(), freshness };
    await createIncrementalRefreshCoordinator(stale).start(searchScope);
    expect(stale.collect).toHaveBeenCalled();
  });
  it('treats a changed source definition as a different source', async () => {
    const { createIndexFreshness } = await import('../../src/discovery/index-freshness');
    const freshness = createIndexFreshness(() => 5);
    const a = source('a');
    freshness.record(a, '1');
    const scopeOf = { query: 'fox', intent: 'refresh' as const };
    expect(freshness.reusable(a, '1', scopeOf)).toBe(true);
    expect(freshness.reusable({ ...a, location: `${a.location}?v=2` }, '1', scopeOf)).toBe(false);
    expect(freshness.reusable({ ...a, allowHttp: true }, '1', scopeOf)).toBe(false);
    freshness.clear();
    expect(freshness.reusable(a, '1', scopeOf)).toBe(false);
  });
});

describe('session failure back-off for query searches', () => {
  it('reports a just-failed source unavailable without a new request, then retries later', async () => {
    const { createIndexFreshness } = await import('../../src/discovery/index-freshness');
    let clock = 10;
    const freshness = createIndexFreshness(() => clock);
    const failing = (h: IncrementalRefreshHost) => {
      const collect = h.collect;
      h.collect = vi.fn(async (s, signal) => {
        if (s.id === 'b') throw new Error('unavailable');
        return collect(s, signal);
      });
      return h;
    };
    const first = failing({ ...host(), freshness });
    await createIncrementalRefreshCoordinator(first).start(scope());
    expect(vi.mocked(first.collect).mock.calls.map(([s]) => s.id)).toEqual(['a', 'b']);
    const searchScope = {
      ...scope(),
      sources: [
        { source: source('a'), sourceRevision: '1' },
        { source: source('b'), sourceRevision: '0' },
      ],
    };
    const second = failing({ ...host(), freshness });
    const result = await createIncrementalRefreshCoordinator(second).start(searchScope);
    expect(second.collect).not.toHaveBeenCalled();
    expect(result.failedSourceIds).toEqual(['b']);
    // A plain refresh, or the same search after the back-off window, asks again.
    const refresh = failing({ ...host(), freshness });
    await createIncrementalRefreshCoordinator(refresh).start({ ...searchScope, query: '' });
    expect(vi.mocked(refresh.collect).mock.calls.map(([s]) => s.id)).toContain('b');
    clock += 30 * 60 * 1000;
    const later = failing({ ...host(), freshness });
    await createIncrementalRefreshCoordinator(later).start(searchScope);
    expect(vi.mocked(later.collect).mock.calls.map(([s]) => s.id)).toContain('b');
  });
});

describe('index freshness windows', () => {
  it('reuses an index for under six hours and backs off failures for under thirty minutes', async () => {
    const { createIndexFreshness, SEARCH_INDEX_REUSE_MS, SEARCH_FAILURE_BACKOFF_MS } =
      await import('../../src/discovery/index-freshness');
    let clock = 100;
    const freshness = createIndexFreshness(() => clock);
    const a = source('a'),
      b = source('b');
    const search = { query: 'fox', intent: 'refresh' as const };
    freshness.record(a, '3');
    freshness.recordFailure(b);
    clock += SEARCH_FAILURE_BACKOFF_MS - 1;
    expect(freshness.recentlyFailed(b, search)).toBe(true);
    clock += 1;
    expect(freshness.recentlyFailed(b, search)).toBe(false);
    clock = 100 + SEARCH_INDEX_REUSE_MS - 1;
    expect(freshness.reusable(a, '3', search)).toBe(true);
    clock += 1;
    expect(freshness.reusable(a, '3', search)).toBe(false);
    // A later success clears the failure; a clock moving backward never reuses.
    freshness.recordFailure(a);
    freshness.record(a, '4');
    expect(freshness.recentlyFailed(a, search)).toBe(false);
    clock -= 10;
    expect(freshness.reusable(a, '4', search)).toBe(false);
  });
});

describe('Rescan with a new query', () => {
  it('reuses recent sources for a different query but re-collects for the same query', async () => {
    const { createIndexFreshness } = await import('../../src/discovery/index-freshness');
    const freshness = createIndexFreshness(() => 1_000);
    const a = source('a');
    freshness.record(a, '4', 'Bloomberg');
    expect(freshness.reusable(a, '4', { query: 'CNN', intent: 'full-recheck' })).toBe(true);
    expect(freshness.reusable(a, '4', { query: ' bloomberg ', intent: 'full-recheck' })).toBe(
      false,
    );
    expect(freshness.reusable(a, '4', { query: '', intent: 'full-recheck' })).toBe(false);
    expect(freshness.reusable(a, '4', { query: 'Bloomberg', intent: 'refresh' })).toBe(true);
  });
});
describe('Slow list check', () => {
  it('reads no source and checks only sources already read', async () => {
    const h = host(),
      owner = createIncrementalRefreshCoordinator(h);
    // Source a was read (revision 4); b never was (revision 0): no snapshot.
    const input = scope();
    const result = await owner.start({
      ...input,
      intent: 'slow',
      sources: [
        { ...input.sources[0]!, sourceRevision: '4' },
        { ...input.sources[1]!, sourceRevision: '0' },
      ],
    });
    expect(result.status).toBe('completed');
    expect(h.collect).not.toHaveBeenCalled();
    expect(h.snapshots.begin).not.toHaveBeenCalled();
    expect(h.activateChecks).toHaveBeenCalledWith(
      expect.objectContaining({ intent: 'slow' }),
      [],
      expect.any(AbortSignal),
      [{ sourceId: 'a', sourceRevision: '4' }],
    );
    await owner.dispose();
  });
  // October 22, 2026: the S25's Slow pass failed at its start because two of
  // its sources had never been read and the native activation found no snapshot.
  it('with no source read yet there is nothing to activate', async () => {
    const h = host(),
      owner = createIncrementalRefreshCoordinator(h);
    const result = await owner.start({ ...scope(), intent: 'slow' });
    expect(result.status).toBe('completed');
    expect(h.activateChecks).not.toHaveBeenCalled();
    await owner.dispose();
  });
});
