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

import { describe, expect, it } from 'vitest';
import { createJoinedWorkTimings } from '../../src/application/joined-work-timings';

describe('passive joined work timing', () => {
  it('reports actual held work, immutable snapshots and the identical result/error', async () => {
    let now = 10,
      release!: (value: object) => void;
    const observer = createJoinedWorkTimings(() => now);
    const value = {};
    const task = observer.run(
      'archive-bookmark-save',
      7,
      () =>
        new Promise<object>((resolve) => {
          release = resolve;
        }),
    );
    now = 35;
    const pending = observer.snapshot();
    expect(pending.active[0]).toMatchObject({ generation: 7, outcome: 'pending', elapsedMs: 25 });
    expect(Object.isFrozen(pending.active[0])).toBe(true);
    now = 60;
    release(value);
    expect(await task).toBe(value);
    expect(observer.snapshot().completed[0]).toMatchObject({ outcome: 'fulfilled', elapsedMs: 50 });
    expect(pending.active[0].elapsedMs).toBe(25);
    const failure = new Error('https://private.invalid/token');
    await expect(
      observer.run('archive-native-stop', 8, () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(observer.snapshot().completed.at(-1)?.outcome).toBe('rejected');
    expect(JSON.stringify(observer.snapshot())).not.toContain('private');
  });
  it('caps active/completed observations explicitly without skipping actual work', async () => {
    const observer = createJoinedWorkTimings(() => 10);
    const finish = Array.from({ length: 65 }, () => observer.begin('close-owner', 2, 1));
    expect(observer.snapshot()).toMatchObject({ droppedActive: 1, active: { length: 64 } });
    for (const end of finish) {
      end('fulfilled');
      end('rejected');
    }
    let invoked = 0;
    for (let i = 0; i < 70; i++) await observer.run('archive-native-retry', 3, () => ++invoked);
    expect(invoked).toBe(70);
    expect(observer.snapshot()).toMatchObject({
      droppedCompleted: 70,
      completed: { length: 64 },
      active: [],
    });
  });
  it('isolates invalid/backward/throwing clocks and rejects unbounded metadata observation', async () => {
    let now = 10;
    const observer = createJoinedWorkTimings(() => {
      if (now === 99) throw Error('secret');
      return now;
    });
    const done = observer.begin('archive-stop-total', 1);
    for (now of [NaN, Infinity, -1, 5, 99]) expect(observer.snapshot().observedMs).toBe(10);
    now = 20;
    done('fulfilled');
    expect(observer.snapshot().completed[0].elapsedMs).toBe(10);
    observer.begin('private-identity' as 'close-owner', 1)('fulfilled');
    observer.begin('close-owner', NaN)('fulfilled');
    observer.begin('close-owner', 1, 128)('fulfilled');
    expect(observer.snapshot()).toMatchObject({ clockFaults: 5, droppedActive: 3 });
    expect(JSON.stringify(observer.snapshot())).not.toContain('secret');
  });
});
