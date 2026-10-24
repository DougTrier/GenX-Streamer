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
  createSelectedGuideOwner,
  type SelectedGuideScope,
  type SelectedGuideClock,
} from '../../src/application/guide/selected-guide';
import {
  SelectedGuideUnavailableError,
  type SelectedGuideQuery,
  type SelectedGuideSummary,
} from '../../src/guide/native';
const scope: SelectedGuideScope = {
  catalogSourceId: 'source',
  appChannelId: 'one',
  catalogRevision: '1',
  selectionGeneration: 1,
};
function summary(
  query: SelectedGuideQuery,
  overrides: Partial<SelectedGuideSummary> = {},
): SelectedGuideSummary {
  const mapped = !!overrides.current || !!overrides.next;
  return {
    ...query,
    catalogRevision: '1',
    databaseRevision: 1,
    mappingStatus: mapped ? 'mapped' : 'unmapped',
    mapping: mapped
      ? {
          catalogSourceId: query.catalogSourceId,
          appChannelId: query.appChannelId,
          guideSourceId: 'feed',
          xmltvChannelId: 'guide-one',
        }
      : null,
    sourceRevision: mapped ? 1 : null,
    publishedRevision: mapped ? 1 : null,
    updatedMs: mapped ? query.atMs : null,
    coverage: { startMs: null, endMs: null },
    cacheStatus: mapped ? 'current' : 'unavailable',
    currentStatus: mapped ? (overrides.current ? 'current' : 'gap') : null,
    nextStatus: mapped ? (overrides.next ? 'next' : 'none') : null,
    current: null,
    next: null,
    ...overrides,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
const tick = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve();
};
function fixture(
  fetch: (query: SelectedGuideQuery, signal: AbortSignal) => Promise<SelectedGuideSummary>,
  extra: Partial<Parameters<typeof createSelectedGuideOwner>[0]> = {},
) {
  let id = 0;
  let now = 1000;
  const timers = new Map<number, { callback: () => void; delay: number }>();
  let timerId = 0;
  const clock: SelectedGuideClock = {
    now: () => now,
    setTimeout: (callback, delay) => {
      timers.set(++timerId, { callback, delay });
      return timerId;
    },
    clearTimeout: (id) => {
      timers.delete(id as number);
    },
  };
  const owner = createSelectedGuideOwner({
    fetch,
    isCurrent: () => true,
    clock,
    requestId: () => `request-${++id}`,
    ...extra,
  });
  return {
    owner,
    timers,
    advance: (time: number) => {
      now = time;
    },
    fire: () => {
      const entry = [...timers.entries()][0];
      if (entry) {
        timers.delete(entry[0]);
        entry[1].callback();
      }
    },
  };
}
describe('selected channel guide ownership', () => {
  it('clears prior view and serializes/coalesces to latest selection until actual canceled query settles', async () => {
    const old = deferred<SelectedGuideSummary>();
    const calls: { query: SelectedGuideQuery; signal: AbortSignal }[] = [];
    const { owner } = fixture(async (query, signal) => {
      calls.push({ query, signal });
      return calls.length === 1 ? old.promise : summary(query);
    });
    const first = owner.setSelection(scope);
    await tick();
    const middle = owner.setSelection({ ...scope, appChannelId: 'two', selectionGeneration: 2 });
    const latest = owner.setSelection({ ...scope, appChannelId: 'three', selectionGeneration: 3 });
    expect(middle).toBe(first);
    expect(latest).toBe(first);
    expect(owner.snapshot.summary).toBeNull();
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls).toHaveLength(1);
    old.resolve(summary(calls[0].query));
    await latest;
    expect(calls.map((call) => call.query.appChannelId)).toEqual(['one', 'three']);
    expect(owner.snapshot.summary?.appChannelId).toBe('three');
    await owner.dispose();
  });
  it('fences request echoes, actual catalog revision and external generation changes', async () => {
    for (const changes of [
      { requestId: 'wrong' },
      { appChannelId: 'wrong' },
      { catalogSourceId: 'wrong' },
      { atMs: 0 },
      { catalogRevision: '2' },
    ]) {
      const { owner } = fixture(async (query) => summary(query, changes));
      await owner.setSelection(scope);
      expect(owner.snapshot.status).toBe('error');
      expect(owner.snapshot.summary).toBeNull();
      await owner.dispose();
    }
    const held = deferred<SelectedGuideSummary>();
    let query!: SelectedGuideQuery;
    let valid = true;
    const { owner } = fixture(
      async (value) => {
        query = value;
        return held.promise;
      },
      { isCurrent: () => valid },
    );
    const work = owner.setSelection(scope);
    await tick();
    valid = false;
    held.resolve(summary(query));
    await work;
    expect(owner.snapshot.status).toBe('idle');
    await owner.dispose();
  });
  it('suspend joins actual query despite abort and foreground return only queries SQLite', async () => {
    const held = deferred<SelectedGuideSummary>();
    let query!: SelectedGuideQuery;
    let signal!: AbortSignal;
    let calls = 0;
    const { owner, timers } = fixture(async (value, abort) => {
      query = value;
      signal = abort;
      return ++calls === 1 ? held.promise : summary(value);
    });
    const work = owner.setSelection(scope);
    await tick();
    const suspended = owner.suspend();
    let settled = false;
    void suspended.then(() => {
      settled = true;
    });
    await tick();
    expect(signal.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(timers.size).toBe(0);
    expect(owner.snapshot.status).toBe('idle');
    held.resolve(summary(query));
    await suspended;
    await work;
    expect(owner.snapshot.summary).toBeNull();
    await owner.setForeground(true);
    expect(calls).toBe(2);
    await owner.dispose();
  });
  it('dispose shares pending ownership, permanently closes admission and drains native cancellation retry', async () => {
    const held = deferred<SelectedGuideSummary>(),
      retry = deferred<void>();
    let query!: SelectedGuideQuery;
    const cancel = vi.fn(() => retry.promise);
    const { owner } = fixture(
      async (value) => {
        query = value;
        return held.promise;
      },
      { cancel },
    );
    const queryWork = owner.setSelection(scope);
    void queryWork.catch(() => undefined);
    await tick();
    const close = owner.dispose();
    expect(owner.dispose()).toBe(close);
    held.reject(new Error('Program guide cancellation could not finish. Retry closing.'));
    await expect(close).rejects.toThrow('could not settle');
    const second = owner.dispose();
    let done = false;
    void second.then(() => {
      done = true;
    });
    await tick();
    expect(cancel).toHaveBeenCalledExactlyOnceWith(query.requestId);
    expect(done).toBe(false);
    await expect(owner.setSelection(scope)).rejects.toThrow('closed');
    retry.resolve();
    await second;
    expect(done).toBe(true);
  });
  it('missing cancellation retry capability never fabricates clean disposal', async () => {
    const held = deferred<SelectedGuideSummary>();
    const { owner } = fixture(() => held.promise);
    const query = owner.setSelection(scope);
    void query.catch(() => undefined);
    await tick();
    const close = owner.dispose();
    held.reject(new Error('cancel unconfirmed'));
    await expect(close).rejects.toThrow('could not settle');
    await expect(owner.dispose()).rejects.toThrow('could not settle');
  });
  it('keeps exactly one foreground timer capped at sixty seconds or nearer program boundary', async () => {
    const fetch = vi.fn(async (query: SelectedGuideQuery) => summary(query));
    const { owner, timers, fire } = fixture(fetch);
    await owner.setSelection(scope);
    expect([...timers.values()].map((timer) => timer.delay)).toEqual([60000]);
    fire();
    await tick();
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(timers.size).toBe(1);
    await owner.suspend();
    expect(timers.size).toBe(0);
    await owner.dispose();
    const boundary = fixture(async (query) =>
      summary(query, {
        current: { title: 'Now', startMs: 0, stopMs: 1200 },
        next: { title: 'Next', startMs: 1200, stopMs: 2000 },
      }),
    );
    await boundary.owner.setSelection(scope);
    expect([...boundary.timers.values()].map((timer) => timer.delay)).toEqual([200]);
    await boundary.owner.dispose();
  });
  it('unavailable capability and ordinary errors have no automatic retry timer or fabricated schedule', async () => {
    const fetch = vi.fn(async (query: SelectedGuideQuery) => summary(query));
    const unavailable = fixture(fetch, { available: () => false });
    await unavailable.owner.setSelection(scope);
    expect(fetch).not.toHaveBeenCalled();
    expect(unavailable.owner.snapshot.status).toBe('unavailable');
    expect(unavailable.timers.size).toBe(0);
    await unavailable.owner.dispose();
    const unsupported = fixture(async () => {
      throw new SelectedGuideUnavailableError();
    });
    await unsupported.owner.setSelection(scope);
    expect(unsupported.owner.snapshot.status).toBe('unavailable');
    expect(unsupported.timers.size).toBe(0);
    await unsupported.owner.dispose();
    const failed = fixture(async () => {
      throw new Error('private error');
    });
    await failed.owner.setSelection(scope);
    expect(failed.owner.snapshot).toEqual({ status: 'error', summary: null });
    expect(failed.timers.size).toBe(0);
    await failed.owner.dispose();
  });
  it('snapshots clone selection and result, listeners unsubscribe and bounds reject before work', async () => {
    let result!: SelectedGuideSummary;
    const { owner } = fixture(async (query) => {
      result = summary(query);
      return result;
    });
    const listener = vi.fn();
    const remove = owner.subscribe(listener);
    const input = { ...scope };
    const work = owner.setSelection(input);
    input.appChannelId = 'mutated';
    await work;
    result.appChannelId = 'late mutation';
    expect(owner.snapshot.summary?.appChannelId).toBe('one');
    expect(Object.isFrozen(owner.snapshot.summary?.coverage)).toBe(true);
    remove();
    const count = listener.mock.calls.length;
    await owner.setSelection(null);
    expect(listener).toHaveBeenCalledTimes(count);
    await expect(owner.setSelection({ ...scope, selectionGeneration: -1 })).rejects.toThrow(
      'identity',
    );
    await owner.dispose();
  });
});

describe('guide delivery-clock catch-up budget', () => {
  it('never publishes crossed Now/Next while a fresh exact-scope query catches up', async () => {
    const stale = deferred<SelectedGuideSummary>();
    const seen: string[] = [];
    const queries: SelectedGuideQuery[] = [];
    const fixtureState = fixture(async (query) => {
      queries.push(query);
      if (queries.length === 1) return stale.promise;
      return summary(query, { current: { title: 'New program', startMs: 1200, stopMs: 2000 } });
    });
    fixtureState.owner.subscribe((snapshot) => {
      if (snapshot.summary?.current) seen.push(snapshot.summary.current.title);
    });
    const work = fixtureState.owner.setSelection(scope);
    await tick();
    fixtureState.advance(1300);
    stale.resolve(
      summary(queries[0], {
        current: { title: 'Expired title', startMs: 0, stopMs: 1200 },
        next: { title: 'Old Next', startMs: 1200, stopMs: 2000 },
      }),
    );
    await work;
    expect(queries.map((query) => query.atMs)).toEqual([1000, 1300]);
    expect(queries[1].catalogSourceId).toBe(queries[0].catalogSourceId);
    expect(queries[1].appChannelId).toBe(queries[0].appChannelId);
    expect(queries[1].requestId).not.toBe(queries[0].requestId);
    expect(seen).toEqual(['New program']);
    expect(fixtureState.timers.size).toBe(1);
    await fixtureState.owner.dispose();
  });
  it('second crossed reply stops with static error and no busy loop; explicit refresh resets budget', async () => {
    const first = deferred<SelectedGuideSummary>(),
      second = deferred<SelectedGuideSummary>();
    const queries: SelectedGuideQuery[] = [];
    const state = fixture(async (query) => {
      queries.push(query);
      return queries.length === 1
        ? first.promise
        : queries.length === 2
          ? second.promise
          : summary(query);
    });
    const work = state.owner.setSelection(scope);
    await tick();
    state.advance(1300);
    first.resolve(
      summary(queries[0], { next: { title: 'Crossed first', startMs: 1200, stopMs: 1400 } }),
    );
    await tick();
    expect(queries).toHaveLength(2);
    state.advance(1600);
    second.resolve(
      summary(queries[1], { current: { title: 'Crossed twice', startMs: 1200, stopMs: 1500 } }),
    );
    await work;
    await tick();
    expect(queries).toHaveLength(2);
    expect(state.owner.snapshot).toEqual({ status: 'error', summary: null });
    expect(state.timers.size).toBe(0);
    await state.owner.refresh();
    expect(queries).toHaveLength(3);
    expect(state.owner.snapshot.status).toBe('ready');
    await state.owner.dispose();
  });
  it('rollback catches up once without publishing future-clock data, and another rollback stops', async () => {
    const first = deferred<SelectedGuideSummary>(),
      second = deferred<SelectedGuideSummary>();
    const queries: SelectedGuideQuery[] = [];
    const state = fixture(async (query) => {
      queries.push(query);
      return queries.length === 1 ? first.promise : second.promise;
    });
    const work = state.owner.setSelection(scope);
    await tick();
    state.advance(900);
    first.resolve(summary(queries[0]));
    await tick();
    expect(queries.map((query) => query.atMs)).toEqual([1000, 900]);
    expect(state.owner.snapshot.summary).toBeNull();
    state.advance(800);
    second.resolve(summary(queries[1]));
    await work;
    expect(state.owner.snapshot.status).toBe('error');
    expect(queries).toHaveLength(2);
    expect(state.timers.size).toBe(0);
    await state.owner.dispose();
  });
  it('suspension still joins an actual pending catch-up and cancels publication', async () => {
    const first = deferred<SelectedGuideSummary>(),
      second = deferred<SelectedGuideSummary>();
    const queries: SelectedGuideQuery[] = [];
    const state = fixture(async (query) => {
      queries.push(query);
      return queries.length === 1 ? first.promise : second.promise;
    });
    const work = state.owner.setSelection(scope);
    await tick();
    state.advance(1300);
    first.resolve(summary(queries[0], { next: { title: 'Crossed', startMs: 1200, stopMs: 1500 } }));
    await tick();
    const suspended = state.owner.suspend();
    let done = false;
    void suspended.then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false);
    second.resolve(summary(queries[1]));
    await suspended;
    await work;
    expect(state.owner.snapshot.status).toBe('idle');
    expect(state.timers.size).toBe(0);
    await state.owner.dispose();
  });
});

it('a boundary crossed synchronously by rendering schedules one immediate clock refresh', async () => {
  const first = deferred<SelectedGuideSummary>();
  const queries: SelectedGuideQuery[] = [];
  const state = fixture(async (query) => {
    queries.push(query);
    return queries.length === 1
      ? first.promise
      : summary(query, {
          current: { title: 'Fresh program', startMs: 1200, stopMs: 2000 },
        });
  });
  state.owner.subscribe((snapshot) => {
    if (snapshot.summary?.current?.title === 'Last instant') state.advance(1201);
  });
  const work = state.owner.setSelection(scope);
  await tick();
  state.advance(1199);
  first.resolve(
    summary(queries[0], {
      current: { title: 'Last instant', startMs: 0, stopMs: 1200 },
      next: { title: 'Fresh program', startMs: 1200, stopMs: 2000 },
    }),
  );
  await work;
  expect([...state.timers.values()].map((timer) => timer.delay)).toEqual([1]);
  state.fire();
  await tick();
  expect(queries.map((query) => query.atMs)).toEqual([1000, 1201]);
  expect(state.owner.snapshot.summary?.current?.title).toBe('Fresh program');
  expect(state.timers.size).toBe(1);
  await state.owner.dispose();
});
