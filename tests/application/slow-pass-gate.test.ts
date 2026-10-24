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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSlowPassGate } from '../../src/application/slow-pass-gate';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('Slow list gate', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('runs one check at a time with a rest after each', async () => {
    vi.useFakeTimers();
    const gate = createSlowPassGate(() => false, { restMs: 3000 });
    const holds = Array.from({ length: 3 }, deferred);
    const started: number[] = [];
    const runs = holds.map((h, i) =>
      gate.run(async () => {
        started.push(i);
        await h.promise;
        return i;
      }),
    );
    await flush();
    expect(started).toEqual([0]);
    expect(gate.active).toBe(1);
    holds[0]!.resolve();
    await flush();
    // The next check waits out the rest.
    await vi.advanceTimersByTimeAsync(2999);
    expect(started).toEqual([0]);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toEqual([0, 1]);
    holds[1]!.resolve();
    holds[2]!.resolve();
    await vi.advanceTimersByTimeAsync(3000);
    expect(started).toEqual([0, 1, 2]);
    await expect(Promise.all(runs)).resolves.toEqual([0, 1, 2]);
  });

  it('waits while something plays or the app is out of sight', async () => {
    vi.useFakeTimers();
    let blocked = true;
    const gate = createSlowPassGate(() => blocked, { restMs: 0, pollMs: 500 });
    let ran = false;
    const run = gate.run(async () => {
      ran = true;
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(ran).toBe(false);
    blocked = false;
    await vi.advanceTimersByTimeAsync(500);
    expect(ran).toBe(true);
    await run;
  });

  it('a stopped waiter leaves promptly and does not hold the queue', async () => {
    vi.useFakeTimers();
    let blocked = true;
    const gate = createSlowPassGate(() => blocked, { restMs: 0, pollMs: 500 });
    const controller = new AbortController();
    const stopped = gate.run(async () => 'never', controller.signal);
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(new DOMException('Scan stopped.', 'AbortError'));
    await expect(stopped).rejects.toThrow('Scan stopped.');
    blocked = false;
    await expect(gate.run(async () => 'next')).resolves.toBe('next');
  });

  it('a failed check still rests and frees the queue', async () => {
    vi.useFakeTimers();
    const gate = createSlowPassGate(() => false, { restMs: 1000 });
    const failed = gate.run(async () => {
      throw new Error('no answer');
    });
    await expect(failed).rejects.toThrow('no answer');
    let ran = false;
    const next = gate.run(async () => {
      ran = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(ran).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(ran).toBe(true);
    await next;
  });
});
