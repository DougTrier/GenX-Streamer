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
  createOwnedWork,
  createResourceOwners,
  resourceKinds,
} from '../../src/playback/resource-owners';

describe('redacted application owner registry', () => {
  it('counts leases exactly once and returns independent immutable fixed snapshots', () => {
    const owners = createResourceOwners();
    owners.cover('browser-engine');
    const a = owners.acquire('videoListeners');
    const b = owners.acquire('videoListeners');
    const captured = owners.snapshot();
    a();
    a();
    b();
    expect(captured.counts.videoListeners).toBe(2);
    expect(Object.isFrozen(captured.counts)).toBe(true);
    expect(Object.keys(captured.counts)).toEqual([...resourceKinds]);
    expect(owners.snapshot().counts.videoListeners).toBe(0);
    expect(owners.snapshot().acquired.videoListeners).toBe(2);
    expect(owners.snapshot().released.videoListeners).toBe(2);
    expect(owners.snapshot().highWater.videoListeners).toBe(2);
    expect(owners.snapshot().coveredDomains).toEqual(['browser-engine']);
  });
  it('times out only its wait, retaining actual work for a successful later join', async () => {
    vi.useFakeTimers();
    const owners = createResourceOwners();
    const work = createOwnedWork(owners);
    let complete!: () => void;
    const job = work.run(
      'nativeLoads',
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    try {
      const waiting = expect(work.settled()).rejects.toThrow('did not settle');
      await vi.advanceTimersByTimeAsync(5000);
      await waiting;
      expect(work.pending()).toBe(1);
      expect(owners.snapshot().counts.nativeLoads).toBe(1);
      expect(owners.snapshot().counts.drainTimers).toBe(0);
      const retry = work.settled();
      complete();
      await job;
      await retry;
      expect(work.pending()).toBe(0);
      expect(owners.snapshot().counts.nativeLoads).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      complete();
      await job;
      vi.useRealTimers();
    }
  });
  it('releases synchronous throws and rejected operations through actual settlement', async () => {
    const owners = createResourceOwners();
    const work = createOwnedWork(owners);
    await expect(
      work.run('nativeLoads', () => {
        throw new Error('fixture');
      }),
    ).rejects.toThrow();
    await expect(
      work.run('nativeCancels', () => Promise.reject(new Error('fixture'))),
    ).rejects.toThrow();
    expect(work.pending()).toBe(0);
    expect(owners.snapshot().counts.nativeLoads).toBe(0);
    expect(owners.snapshot().counts.nativeCancels).toBe(0);
    expect(JSON.stringify(owners.snapshot())).not.toContain('fixture');
  });
});
