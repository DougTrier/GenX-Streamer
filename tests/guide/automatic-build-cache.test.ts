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
  createAutomaticGuideBuilder,
  type AutomaticGuideBuildHost,
} from '../../src/guide/automatic-build';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const receipt = () => ({ catalogRevision: '7', matched: 1, unmatched: 9 });
function fixture() {
  let enabled = true;
  const host: AutomaticGuideBuildHost = {
    canRun: () => true,
    canRequest: () => enabled,
    isCurrent: () => true,
    capture: vi.fn(async () => ({
      catalogRevision: '7', channelCount: 10,
      providers: [{ name: 'Fixture guide', location: 'https://fixture.invalid/guide', allowHttp: false }],
    })),
    preview: vi.fn(async () => ({ ticket: 'fixture-ticket', sourceRevision: 1 })),
    commitMatched: vi.fn(async () => ({ committed: true, matched: 1, unmatched: 9 })),
    discard: vi.fn(async () => {}),
    connectCacheOnly: vi.fn(async () => receipt()),
  };
  return { host, enable: (value: boolean) => { enabled = value; } };
}

describe('cache-only automatic guide owner', () => {
  it('never invokes acquisition/capture/preview publication hooks', async () => {
    const f = fixture();
    f.host.publishCache = vi.fn(async () => {});
    f.host.cacheReady = vi.fn(async () => false);
    f.host.connectScopeLatest = vi.fn(async () => receipt());
    const owner = createAutomaticGuideBuilder(f.host);
    await owner.requestCached();
    expect(f.host.connectCacheOnly).toHaveBeenCalledOnce();
    for (const hook of [f.host.capture, f.host.preview, f.host.commitMatched,
      f.host.publishCache, f.host.cacheReady, f.host.connectScopeLatest])
      expect(hook).not.toHaveBeenCalled();
    await owner.dispose();
  });

  it('coalesces changes during held work into one latest cache pass', async () => {
    const f = fixture(), started = deferred<void>(), release = deferred<void>();
    let calls = 0, revision = 7;
    const seen: number[] = [];
    f.host.connectCacheOnly = async () => {
      seen.push(revision);
      if (++calls === 1) { started.resolve(); await release.promise; }
      return { ...receipt(), catalogRevision: String(revision) };
    };
    const owner = createAutomaticGuideBuilder(f.host), work = owner.requestCached();
    await started.promise;
    for (let n = 0; n < 500; n++) {
      revision++;
      expect(owner.requestCached()).toBe(work);
    }
    release.resolve();
    await work;
    expect(seen).toEqual([7, 507]);
    expect(f.host.capture).not.toHaveBeenCalled();
    await owner.dispose();
  });

  it('respects Off and drops queued automatic passes while joining an active callback', async () => {
    const f = fixture(), started = deferred<void>(), release = deferred<void>();
    f.enable(false);
    const owner = createAutomaticGuideBuilder(f.host);
    await owner.requestCached();
    expect(f.host.connectCacheOnly).not.toHaveBeenCalled();
    let signal!: AbortSignal, calls = 0;
    f.host.connectCacheOnly = async (owned) => {
      calls++; signal = owned; started.resolve(); await release.promise;
      owned.throwIfAborted(); return receipt();
    };
    f.enable(true);
    const work = owner.requestCached();
    await started.promise;
    void owner.requestCached();
    f.enable(false);
    let joined = false;
    const cleanup = owner.suspend().then(() => { joined = true; });
    await Promise.resolve();
    expect(signal.aborted).toBe(true);
    expect(joined).toBe(false);
    release.resolve();
    await cleanup; await work;
    await owner.requestCached();
    expect(calls).toBe(1);
    await owner.dispose();
  });

  it('queues an explicit full Find behind a held cache pass instead of treating it as a full run', async () => {
    const f = fixture(), started = deferred<void>(), release = deferred<void>();
    f.host.connectCacheOnly = async () => { started.resolve(); await release.promise; return receipt(); };
    const owner = createAutomaticGuideBuilder(f.host), cached = owner.requestCached();
    await started.promise;
    const manual = owner.run();
    expect(f.host.capture).not.toHaveBeenCalled();
    release.resolve();
    await cached;
    expect(await manual).toMatchObject({ checked: 1, connected: 1 });
    expect(f.host.capture).toHaveBeenCalledOnce();
    expect(f.host.preview).toHaveBeenCalledOnce();
    expect(f.host.commitMatched).toHaveBeenCalledOnce();
    await owner.dispose();
  });

  it('joins and cancels a queued manual continuation on suspension', async () => {
    const f = fixture(), started = deferred<void>(), release = deferred<void>();
    f.host.connectCacheOnly = async (signal) => {
      started.resolve(); await release.promise; signal.throwIfAborted(); return receipt();
    };
    const owner = createAutomaticGuideBuilder(f.host), cached = owner.requestCached();
    await started.promise;
    const manual = owner.run();
    const manualStopped = expect(manual).rejects.toMatchObject({ name: 'AbortError' });
    let joined = false;
    const cleanup = owner.suspend().then(() => { joined = true; });
    await Promise.resolve();
    expect(joined).toBe(false);
    release.resolve();
    await cleanup; await cached; await manualStopped;
    expect(f.host.capture).not.toHaveBeenCalled();
    await owner.dispose();
  });

  it('allows a real retry after cache connection failure', async () => {
    const f = fixture();
    let calls = 0;
    f.host.connectCacheOnly = async () => {
      if (++calls === 1) throw new Error('Fixture cache unavailable');
      return receipt();
    };
    const owner = createAutomaticGuideBuilder(f.host);
    await expect(owner.requestCached()).rejects.toThrow('Fixture cache unavailable');
    await owner.requestCached();
    expect(calls).toBe(2);
    expect(f.host.capture).not.toHaveBeenCalled();
    await owner.dispose();
  });
});
