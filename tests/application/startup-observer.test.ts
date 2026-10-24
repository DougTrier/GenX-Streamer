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

import { expect, it } from 'vitest';
import {
  createStartupObserver,
  type StartupStage,
  startupStages,
} from '../../src/application/startup-observer';
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
it('reports nested pending stages and actual completion with an injected monotonic clock', async () => {
  let time = 100;
  const observer = createStartupObserver(() => time);
  const attempt = observer.begin();
  const held = deferred<string>();
  const work = attempt.run('close-bridge', () =>
    attempt.run('close-start-listen', () => held.promise),
  );
  time = 125;
  expect(observer.snapshot().pendingStages).toEqual(['close-bridge', 'close-start-listen']);
  held.resolve('secret payload');
  expect(await work).toBe('secret payload');
  attempt.finish('completed');
  expect(observer.snapshot()).toMatchObject({
    schemaVersion: 1,
    generation: 1,
    state: 'completed',
    elapsedMs: 25,
    pendingStages: [],
  });
  expect(observer.snapshot().stages.every((s) => s.enteredMs === 0 && s.settledMs === 25)).toBe(
    true,
  );
  expect(JSON.stringify(observer.snapshot())).not.toContain('secret payload');
  time = 999;
  expect(observer.snapshot().elapsedMs).toBe(25);
});
it('an obsolete operation in the same stage cannot complete its replacement', async () => {
  const observer = createStartupObserver(() => 1),
    attempt = observer.begin();
  const first = deferred<number>(),
    second = deferred<number>();
  const a = attempt.run('health-decode', () => first.promise);
  const b = attempt.run('health-decode', () => second.promise);
  first.resolve(1);
  await a;
  expect(observer.snapshot().pendingStages).toEqual(['health-decode']);
  second.resolve(2);
  await b;
  expect(observer.snapshot().pendingStages).toEqual([]);
});
it('redacts failures and cancellation while rejecting stages outside the fixed enum', async () => {
  const observer = createStartupObserver(() => 1),
    attempt = observer.begin();
  await expect(
    attempt.run('health-decode', () => {
      throw new Error('https://user:password@private.invalid');
    }),
  ).rejects.toThrow();
  await expect(
    attempt.run('preferences', () => {
      throw new DOMException('private data', 'AbortError');
    }),
  ).rejects.toThrow();
  await expect(attempt.run('private-url' as StartupStage, () => 1)).rejects.toThrow(
    'Startup stage is invalid.',
  );
  expect(observer.snapshot().stages.map((s) => s.state)).toEqual(['failed', 'cancelled']);
  expect(JSON.stringify(observer.snapshot())).not.toMatch(/password|private|https/);
});
it('latest retry ignores obsolete completion and failure without dropping either operation', async () => {
  const observer = createStartupObserver(() => 1),
    old = observer.begin(),
    held = deferred<number>();
  const oldWork = old.run('read-record-pair', () => held.promise);
  const next = observer.begin(),
    current = deferred<number>();
  const nextWork = next.run('health-decode', () => current.promise);
  held.resolve(7);
  expect(await oldWork).toBe(7);
  old.finish('failed');
  expect(observer.snapshot()).toMatchObject({
    generation: 2,
    state: 'pending',
    pendingStages: ['health-decode'],
  });
  current.resolve(8);
  expect(await nextWork).toBe(8);
  next.finish('completed');
  expect(observer.snapshot().state).toBe('completed');
});
it('bounds retry history, freezes snapshots and tolerates regressing clock values', async () => {
  let time = 10;
  const observer = createStartupObserver(() => time);
  for (let i = 0; i < 100; i++) {
    const attempt = observer.begin();
    await attempt.run('ready', () => true);
    attempt.finish('completed');
  }
  time = 0;
  const snap = observer.snapshot();
  expect(snap.stages).toHaveLength(1);
  expect(snap.elapsedMs).toBe(0);
  expect(Object.isFrozen(snap)).toBe(true);
  expect(Object.isFrozen(snap.stages[0])).toBe(true);
  expect(snap.stages.every((s) => startupStages.includes(s.stage))).toBe(true);
});
