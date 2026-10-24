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

import { expect, it, vi } from 'vitest';
import { createStartupObserver } from '../../src/application/startup-view';
import { createStartupObserver as core } from '../../src/application/startup-observer';
import type { StartupSnapshot, StartupStatusView } from '../../src/ui/startup-status';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function harness() {
  const target = new EventTarget();
  const add = vi.spyOn(target, 'addEventListener');
  const remove = vi.spyOn(target, 'removeEventListener');
  const views: { renders: StartupSnapshot[]; disposed: number }[] = [];
  const view = (): StartupStatusView => {
    const state = { renders: [] as StartupSnapshot[], disposed: 0 };
    views.push(state);
    return {
      render: (snapshot) => state.renders.push(snapshot),
      dispose: () => {
        state.disposed++;
      },
    };
  };
  const observer = createStartupObserver(() => 10, { view, lifecycle: target });
  return { observer, target, add, remove, views };
}

it('shows actual held stages, preserves the complete observer contract and joins the producer', async () => {
  let time = 10;
  const renders: StartupSnapshot[] = [];
  const actual = createStartupObserver(() => time, {
    view: () => ({ render: (s) => renders.push(s), dispose() {} }),
  });
  const expected = core(() => time);
  const a = actual.begin(),
    b = expected.begin();
  const held = deferred<string>();
  const aw = a.run('close-bridge', () => a.run('read-record-pair', () => held.promise));
  const bw = b.run('close-bridge', () => b.run('read-record-pair', () => held.promise));
  time = 25;
  expect(actual.snapshot()).toEqual(expected.snapshot());
  expect(renders.at(-1)?.pendingStages).toEqual(['close-bridge', 'read-record-pair']);
  expect(actual.snapshot().state).toBe('pending');
  held.resolve('private media metadata');
  expect(await aw).toBe('private media metadata');
  expect(await bw).toBe('private media metadata');
  a.finish('completed');
  b.finish('completed');
  expect(actual.snapshot()).toEqual(expected.snapshot());
  expect(JSON.stringify(renders)).not.toContain('private media metadata');
});

it('old completion or failure cannot clear a retry view or replace its stage', async () => {
  const { observer, views, add, remove } = harness();
  const old = observer.begin(),
    held = deferred<number>();
  const oldWork = old.run('read-record-pair', () => held.promise);
  const next = observer.begin(),
    current = deferred<number>();
  const nextWork = next.run('health-decode', () => current.promise);
  held.resolve(1);
  await oldWork;
  old.finish('failed');
  expect(views[0]!.disposed).toBe(1);
  expect(views[1]!.disposed).toBe(0);
  expect(views[1]!.renders.at(-1)).toMatchObject({
    generation: 2,
    state: 'pending',
    pendingStages: ['health-decode'],
  });
  current.resolve(2);
  await nextWork;
  next.finish('completed');
  expect(views[1]!.disposed).toBe(1);
  expect(add).toHaveBeenCalledTimes(2);
  expect(remove).toHaveBeenCalledTimes(2);
});

it('failure remains honest until retry and cancellation disposes without claiming ready', async () => {
  const { observer, views, remove } = harness();
  const attempt = observer.begin();
  const error = new Error('private-token');
  await expect(attempt.run('preferences', () => Promise.reject(error))).rejects.toBe(error);
  attempt.finish('failed');
  expect(views[0]!.renders.at(-1)?.state).toBe('failed');
  expect(views[0]!.disposed).toBe(0);
  const retry = observer.begin();
  await expect(
    retry.run('retry-storage', () => {
      throw new DOMException('private', 'AbortError');
    }),
  ).rejects.toMatchObject({ name: 'AbortError' });
  retry.finish('cancelled');
  expect(observer.snapshot().state).toBe('cancelled');
  expect(views.every((view) => view.disposed === 1)).toBe(true);
  expect(remove).toHaveBeenCalledTimes(2);
  expect(JSON.stringify(views)).not.toContain('private');
});

it('pagehide disposes its listener once and late producers cannot remount presentation', async () => {
  const { observer, views, target, remove, add } = harness();
  const attempt = observer.begin(),
    held = deferred<number>();
  const work = attempt.run('read-record-pair', () => held.promise);
  target.dispatchEvent(new Event('pagehide'));
  target.dispatchEvent(new Event('pagehide'));
  const rendered = views[0]!.renders.length;
  held.resolve(7);
  expect(await work).toBe(7);
  attempt.finish('cancelled');
  observer.begin();
  expect(views).toHaveLength(1);
  expect(views[0]!.renders).toHaveLength(rendered);
  expect(views[0]!.disposed).toBe(1);
  expect(add).toHaveBeenCalledTimes(1);
  expect(remove).toHaveBeenCalledTimes(1);
});

it('a broken view cannot change or suppress the saved-data operation or error', async () => {
  const observer = createStartupObserver(() => 1, {
    view: () => ({
      render() {
        throw new Error('view failed');
      },
      dispose() {
        throw new Error('view failed');
      },
    }),
  });
  const attempt = observer.begin();
  expect(await attempt.run('read-record-pair', () => 4)).toBe(4);
  const error = new Error('saved data failed');
  await expect(
    attempt.run('preferences', () => {
      throw error;
    }),
  ).rejects.toBe(error);
  expect(() => attempt.finish('cancelled')).not.toThrow();
  expect(observer.snapshot().state).toBe('cancelled');
});
