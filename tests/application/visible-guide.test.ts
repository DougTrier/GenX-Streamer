import { describe, it, expect, vi } from 'vitest';
import { createVisibleGuideOwner } from '../../src/application/visible-guide';
import {
  createVisibleGuideAdapter,
  validateVisibleGuideSummary,
  type VisibleGuideQuery,
  type VisibleGuideSummary,
} from '../../src/guide/visible-native';
const channels = [
  { catalogSourceId: 'source', appChannelId: 'one' },
  { catalogSourceId: 'source', appChannelId: 'two' },
];
const scope = { channels, catalogRevision: '1', generation: 1 };
function summary(query: VisibleGuideQuery): VisibleGuideSummary {
  return {
    requestId: query.requestId,
    atMs: query.atMs,
    catalogRevision: '1',
    databaseRevision: 2,
    rows: query.channels.map((channel) => ({
      ...channel,
      requestId: query.requestId,
      atMs: query.atMs,
      catalogRevision: '1',
      databaseRevision: 2,
      mappingStatus: 'unmapped',
      mapping: null,
      sourceRevision: null,
      publishedRevision: null,
      updatedMs: null,
      coverage: { startMs: null, endMs: null },
      cacheStatus: 'unavailable',
      currentStatus: null,
      nextStatus: null,
      current: null,
      next: null,
    })),
  };
}
const query: VisibleGuideQuery = { channels, requestId: 'request', atMs: 1000 };
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
async function tick() {
  for (let n = 0; n < 8; n++) await Promise.resolve();
}
describe('visible guide batch boundary', () => {
  it('refuses the whole oversized reply instead of returning a partial viewport', () => {
    const wideQuery = {
      ...query,
      channels: Array.from({ length: 64 }, (_, index) => ({
        catalogSourceId: 'source',
        appChannelId: `${index}-${'x'.repeat(8192)}`,
      })),
    };
    expect(() => validateVisibleGuideSummary(summary(wideQuery), wideQuery)).toThrow();
  });
  it('accepts only complete ordered exact-snapshot rows; never publishes mixed or extra identities', () => {
    expect(validateVisibleGuideSummary(summary(query), query).rows).toHaveLength(2);
    for (const mutate of [
      (r: VisibleGuideSummary) => r.rows.reverse(),
      (r: VisibleGuideSummary) => r.rows.pop(),
      (r: VisibleGuideSummary) => {
        r.rows[1].catalogRevision = '2';
      },
      (r: VisibleGuideSummary) => {
        r.rows[1].databaseRevision = 3;
      },
      (r: VisibleGuideSummary) => {
        r.rows[1].requestId = 'other';
      },
      (r: VisibleGuideSummary) => {
        r.rows[1].atMs++;
      },
    ]) {
      const r = summary(query);
      mutate(r);
      expect(() => validateVisibleGuideSummary(r, query)).toThrow();
    }
    expect(() =>
      validateVisibleGuideSummary({ ...summary(query), url: 'https://private.invalid' }, query),
    ).toThrow();
  });
  it('refuses invalid or excessive viewport admission before invoking native code', async () => {
    const invoke = vi.fn();
    const read = createVisibleGuideAdapter({ isNative: () => true, invoke });
    for (const invalid of [
      [],
      [...channels, channels[0]],
      Array.from({ length: 65 }, (_, i) => ({
        catalogSourceId: 'source',
        appChannelId: String(i),
      })),
      [{ catalogSourceId: 'bad\nsource', appChannelId: 'id' }],
    ])
      await expect(
        read({ ...query, channels: invalid }, new AbortController().signal),
      ).rejects.toThrow();
    expect(invoke).not.toHaveBeenCalled();
  });
  it('joins both real query and cancellation acknowledgment, refusing failed cleanup', async () => {
    const work = deferred<unknown>(),
      ack = deferred<unknown>();
    const invoke = vi.fn((command: string) =>
      command === 'cancel_playlist' ? ack.promise : work.promise,
    );
    const read = createVisibleGuideAdapter({ isNative: () => true, invoke });
    const controller = new AbortController();
    let settled = false;
    const pending = read(query, controller.signal).finally(() => {
      settled = true;
    });
    const rejected = expect(pending).rejects.toThrow('cancellation could not finish');
    controller.abort();
    await tick();
    ack.reject(new Error('private token'));
    await tick();
    expect(settled).toBe(false);
    work.resolve(summary(query));
    await rejected;
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      'guide_visible_summaries',
      'cancel_playlist',
    ]);
  });
  it('does not invoke in browser capability fallback', async () => {
    const invoke = vi.fn();
    const read = createVisibleGuideAdapter({ isNative: () => false, invoke });
    await expect(read(query, new AbortController().signal)).rejects.toThrow('installed app');
    expect(invoke).not.toHaveBeenCalled();
  });
  it('coalesces rapid scroll and joins obsolete work before querying the latest viewport', async () => {
    const old = deferred<VisibleGuideSummary>();
    const calls: { query: VisibleGuideQuery; signal: AbortSignal }[] = [];
    const owner = createVisibleGuideOwner({
      fetch: async (query, signal) => {
        calls.push({ query, signal });
        return calls.length === 1 ? old.promise : summary(query);
      },
      isCurrent: () => true,
    });
    const first = owner.setScope(scope);
    await tick();
    const middle = owner.setScope({ ...scope, channels: [channels[1]], generation: 2 });
    const latest = owner.setScope({
      ...scope,
      channels: [{ catalogSourceId: 'source', appChannelId: 'three' }],
      generation: 3,
    });
    expect(middle).toBe(first);
    expect(latest).toBe(first);
    expect(calls).toHaveLength(1);
    expect(calls[0].signal.aborted).toBe(true);
    expect(owner.snapshot.summary).toBeNull();
    old.resolve(summary(calls[0].query));
    await latest;
    expect(calls.map((c) => c.query.channels.map((x) => x.appChannelId))).toEqual([
      ['one', 'two'],
      ['three'],
    ]);
    await owner.dispose();
  });
  it('clears a hidden viewport immediately while retaining its actual pending query until settlement', async () => {
    const old = deferred<VisibleGuideSummary>();
    const calls: { query: VisibleGuideQuery; signal: AbortSignal }[] = [];
    const owner = createVisibleGuideOwner({
      fetch: async (query, signal) => {
        calls.push({ query, signal });
        return old.promise;
      },
      isCurrent: () => true,
    });
    const pending = owner.setScope(scope);
    await tick();
    let settled = false;
    const hidden = owner.setScope(null).then(() => {
      settled = true;
    });
    await tick();
    expect(owner.snapshot.status).toBe('idle');
    expect(owner.snapshot.summary).toBeNull();
    expect(calls[0].signal.aborted).toBe(true);
    expect(settled).toBe(false);
    old.resolve(summary(calls[0].query));
    await Promise.all([pending, hidden]);
    expect(owner.snapshot.status).toBe('idle');
    expect(calls).toHaveLength(1);
    await owner.dispose();
  });
  it('uses the earliest boundary from every row, including one crossed during rendering', async () => {
    let now = 1000,
      id = 0;
    const timers = new Map<number, { callback: () => void; delay: number }>();
    const calls: VisibleGuideQuery[] = [];
    const owner = createVisibleGuideOwner({
      fetch: async (q) => {
        calls.push(q);
        const r = summary(q);
        if (calls.length === 1) r.rows[1].next = { title: 'Next', startMs: 1200, stopMs: 1400 };
        return r;
      },
      isCurrent: () => true,
      clock: {
        now: () => now,
        setTimeout: (callback, delay) => {
          timers.set(++id, { callback, delay });
          return id;
        },
        clearTimeout: (id) => {
          timers.delete(id as number);
        },
      },
    });
    owner.subscribe((s) => {
      if (s.status === 'ready' && calls.length === 1) now = 1201;
    });
    await owner.setScope(scope);
    expect([...timers.values()].map((x) => x.delay)).toEqual([1]);
    const [timerKey, timer] = [...timers.entries()][0];
    timers.delete(timerKey);
    timer.callback();
    await tick();
    expect(calls).toHaveLength(2);
    expect(calls[1].atMs).toBe(1201);
    await owner.suspend();
    expect(timers.size).toBe(0);
    expect(owner.snapshot.status).toBe('idle');
    await owner.dispose();
  });
  it('clears an obsolete catalog response and leaves an error without polling or retrying', async () => {
    const fetch = vi.fn(async (q: VisibleGuideQuery) => ({ ...summary(q), catalogRevision: '2' }));
    const owner = createVisibleGuideOwner({ fetch, isCurrent: () => true });
    await owner.setScope(scope);
    expect(owner.snapshot.status).toBe('error');
    expect(owner.snapshot.summary).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    await owner.dispose();
  });
});
