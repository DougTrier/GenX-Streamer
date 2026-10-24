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
import { createPlaybackProbeGate } from '../../src/application/health/playback-probe-gate';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};

describe('playback-aware probe gate', () => {
  it('runs everything at once when nothing is playing', async () => {
    const gate = createPlaybackProbeGate(() => false);
    const holds = Array.from({ length: 6 }, deferred);
    const runs = holds.map((h) => gate.run(() => h.promise));
    await Promise.resolve();
    expect(gate.active).toBe(6);
    holds.forEach((h) => h.resolve());
    await Promise.all(runs);
  });

  it('limits concurrent checks while viewing and releases them when playback stops', async () => {
    vi.useFakeTimers();
    let viewing = true;
    const gate = createPlaybackProbeGate(() => viewing, { limit: 2, pollMs: 100 });
    const holds = Array.from({ length: 5 }, deferred);
    const started: number[] = [];
    const runs = holds.map((h, i) =>
      gate.run(async () => {
        started.push(i);
        await h.promise;
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1]);
    holds[0].resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toEqual([0, 1, 2]);
    viewing = false;
    await vi.advanceTimersByTimeAsync(100);
    expect(started.sort()).toEqual([0, 1, 2, 3, 4]);
    holds.forEach((h) => h.resolve());
    await Promise.all(runs);
    vi.useRealTimers();
  });

  it('a waiting check cancels promptly without consuming a slot', async () => {
    vi.useFakeTimers();
    const gate = createPlaybackProbeGate(() => true, { limit: 1, pollMs: 100 });
    const hold = deferred();
    const first = gate.run(() => hold.promise);
    const controller = new AbortController();
    const work = vi.fn(async () => undefined);
    const waiting = gate.run(work, controller.signal);
    controller.abort(new DOMException('stop', 'AbortError'));
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' });
    expect(work).not.toHaveBeenCalled();
    expect(gate.active).toBe(1);
    hold.resolve();
    await first;
    expect(gate.active).toBe(0);
    vi.useRealTimers();
  });
});
