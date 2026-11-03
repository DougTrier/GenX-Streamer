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

import { afterEach, expect, it, vi } from 'vitest';
import {
  createAutomaticGuideBuilder,
  type AutomaticGuideBuildHost,
} from '../../src/guide/automatic-build';
import {
  automaticGuideConfigurationChanged,
  createAutomaticGuidePermissions,
  isAutomaticGuidePermissionRefusal,
  previewPermittedAutomaticGuide,
} from '../../src/guide/automatic-permissions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let idle = true;
  const host: AutomaticGuideBuildHost = Object.assign(
    {
      canRun: () => true,
      isCurrent: () => true,
      capture: vi.fn(async () => ({
        catalogRevision: '7',
        channelCount: 10,
        providers: [
          { name: 'Fixture guide', location: 'https://fixture.invalid/guide', allowHttp: false },
        ],
      })),
      preview: vi.fn(async () => ({ ticket: 'preview', sourceRevision: 1 })),
      commitMatched: vi.fn(async () => ({ committed: true, matched: 1, unmatched: 9 })),
      discard: vi.fn(async () => {}),
      connectCacheOnly: vi.fn(async () => ({ catalogRevision: '7', matched: 1, unmatched: 9 })),
    },
    { canRunFull: () => idle },
  );
  return { host, idle: (value: boolean) => (idle = value) };
}
afterEach(() => vi.useRealTimers());

it('defers both full acquisition and new cached mapping writes while playback or Guide is busy', async () => {
  const f = fixture();
  f.idle(false);
  const owner = createAutomaticGuideBuilder(f.host);
  try {
    await owner.request();
    expect(f.host.capture).not.toHaveBeenCalled();
    expect(f.host.preview).not.toHaveBeenCalled();
    expect(f.host.commitMatched).not.toHaveBeenCalled();
    await owner.requestCached();
    expect(f.host.connectCacheOnly).not.toHaveBeenCalled();
  } finally {
    await owner.dispose();
  }
});

it('coalesces deferred requests, then captures fresh scope once idle rather than retaining an old snapshot', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.idle(false);
  let revision = '7';
  f.host.capture = vi.fn(async () => ({
    catalogRevision: revision,
    channelCount: 10,
    providers: [{ name: 'Fresh guide', location: 'https://fixture.invalid/new', allowHttp: true }],
  }));
  const owner = createAutomaticGuideBuilder(f.host);
  for (let n = 0; n < 500; n++) await owner.request();
  expect(f.host.capture).not.toHaveBeenCalled();
  revision = '8';
  f.idle(true);
  await vi.advanceTimersByTimeAsync(250);
  await owner.wake();
  expect(f.host.capture).toHaveBeenCalledOnce();
  expect(f.host.commitMatched).toHaveBeenCalledWith(
    { ticket: 'preview', sourceRevision: 1 },
    '8',
    expect.any(AbortSignal),
    { name: 'Fresh guide', location: 'https://fixture.invalid/new', allowHttp: true },
  );
  await owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('reports completion when a deferred cached guide connection settles', async () => {
  const f = fixture();
  f.idle(false);
  f.host.onDeferred = vi.fn();
  f.host.onProgress = vi.fn();
  const owner = createAutomaticGuideBuilder(f.host);
  try {
    await owner.requestCached();
    expect(f.host.onDeferred).toHaveBeenCalledOnce();
    f.idle(true);
    await owner.wake();
    expect(f.host.onProgress).toHaveBeenCalledWith(
      expect.objectContaining({ phase: 'completed', cacheOnly: true, connected: 1 }),
    );
    expect(f.host.capture).not.toHaveBeenCalled();
  } finally {
    await owner.dispose();
  }
});

it('visibly defers explicit Find while busy, retains its manual permission and never waits on its own Guide dialog', async () => {
  const f = fixture();
  f.idle(false);
  f.host.canRequest = () => false;
  f.host.acquisitionAllowed = vi.fn(async (_provider, _signal, context) => !context.automatic);
  f.host.onDeferred = vi.fn();
  const owner = createAutomaticGuideBuilder(f.host);
  expect(await owner.run()).toMatchObject({ checked: 0, maintenance: 'deferred' });
  expect(f.host.capture).not.toHaveBeenCalled();
  expect(f.host.onDeferred).toHaveBeenCalledOnce();
  f.idle(true);
  await owner.wake();
  expect(f.host.preview).toHaveBeenCalledOnce();
  expect(f.host.acquisitionAllowed).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
    automatic: false,
  });
  await owner.dispose();
});

it('preempts a held preview, waits for its real result and exact discard before playback can proceed', async () => {
  const f = fixture();
  const entered = deferred<void>();
  const preview = deferred<{ ticket: string; sourceRevision: number }>();
  const discarded = deferred<void>();
  let signal!: AbortSignal;
  f.host.preview = vi.fn(async (_provider, owned) => {
    signal = owned;
    entered.resolve();
    return preview.promise;
  });
  f.host.discard = vi.fn(async () => discarded.promise);
  const owner = createAutomaticGuideBuilder(f.host);
  const work = owner.request();
  await entered.promise;
  f.idle(false);
  let joined = false;
  const admission = owner.preparePlayback().then(() => (joined = true));
  expect(signal.aborted).toBe(true);
  await Promise.resolve();
  expect(joined).toBe(false);
  preview.resolve({ ticket: 'late-exact-ticket', sourceRevision: 1 });
  await vi.waitFor(() => expect(f.host.discard).toHaveBeenCalledWith('late-exact-ticket'));
  expect(joined).toBe(false);
  expect(f.host.commitMatched).not.toHaveBeenCalled();
  discarded.resolve();
  await admission;
  await work;
  expect(joined).toBe(true);
  await owner.dispose();
});

it('joins a late durable publication and resumes from its cache without refetching or discarding the consumed ticket', async () => {
  const f = fixture();
  const entered = deferred<void>();
  const publish = deferred<void>();
  let cached = false;
  f.host.cacheReady = vi.fn(async () => cached);
  f.host.connectLatest = vi.fn(async () => ({ catalogRevision: '7', matched: 1, unmatched: 9 }));
  f.host.publishCache = vi.fn(async () => {
    entered.resolve();
    await publish.promise;
    cached = true;
  });
  const owner = createAutomaticGuideBuilder(f.host);
  const work = owner.request();
  await entered.promise;
  f.idle(false);
  let joined = false;
  const admission = owner.preparePlayback().then(() => (joined = true));
  await Promise.resolve();
  expect(joined).toBe(false);
  publish.resolve();
  await admission;
  await work;
  expect(f.host.connectLatest).not.toHaveBeenCalled();
  expect(f.host.discard).not.toHaveBeenCalled();
  f.idle(true);
  await owner.wake();
  expect(f.host.preview).toHaveBeenCalledOnce();
  expect(f.host.publishCache).toHaveBeenCalledOnce();
  expect(f.host.connectLatest).toHaveBeenCalledOnce();
  await owner.dispose();
});

it('monitors a full build becoming busy and joins its retained native work before idle retry', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const entered = deferred<void>();
  const retained = deferred<void>();
  let signal!: AbortSignal;
  let calls = 0;
  f.host.preview = vi.fn(async (_provider, owned) => {
    if (++calls === 1) {
      signal = owned;
      entered.resolve();
      await retained.promise;
      owned.throwIfAborted();
    }
    return { ticket: 'preview', sourceRevision: 1 };
  });
  const owner = createAutomaticGuideBuilder(f.host);
  const work = owner.request();
  await entered.promise;
  f.idle(false);
  await vi.advanceTimersByTimeAsync(100);
  expect(signal.aborted).toBe(true);
  f.idle(true);
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.host.capture).toHaveBeenCalledOnce();
  retained.resolve();
  await work;
  await owner.wake();
  expect(f.host.capture).toHaveBeenCalledTimes(2);
  expect(f.host.commitMatched).toHaveBeenCalledOnce();
  await owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('does not repeat a full acquisition after final maintenance returns a definite completed receipt during preemption', async () => {
  const f = fixture();
  const entered = deferred<void>();
  const maintenance = deferred<'compacted'>();
  f.host.maintain = vi.fn(async () => {
    entered.resolve();
    return maintenance.promise;
  });
  const owner = createAutomaticGuideBuilder(f.host);
  const work = owner.request();
  await entered.promise;
  f.idle(false);
  const admission = owner.preparePlayback();
  maintenance.resolve('compacted');
  await admission;
  await work;
  f.idle(true);
  await owner.wake();
  expect(f.host.capture).toHaveBeenCalledOnce();
  expect(f.host.maintain).toHaveBeenCalledOnce();
  await owner.dispose();
});

it('retries after a settled native cancellation of the preempted owner', async () => {
  const f = fixture();
  const entered = deferred<void>();
  const held = deferred<void>();
  const preview = f.host.preview;
  f.host.preview = vi.fn(preview).mockImplementationOnce(async () => {
    entered.resolve();
    await held.promise;
    throw 'canceled';
  });
  const observed = vi.fn();
  f.host.onDeferredError = observed;
  const owner = createAutomaticGuideBuilder(f.host);
  const work = owner.request();
  await entered.promise;
  f.idle(false);
  const admission = owner.preparePlayback();
  held.resolve();
  await admission;
  await work;
  f.idle(true);
  await owner.wake();
  expect(f.host.preview).toHaveBeenCalledTimes(2);
  expect(observed).not.toHaveBeenCalled();
  await owner.dispose();
});

it.each(['native-cancel-unconfirmed', 'publication-receipt-unknown'])(
  'retains %s after preemption and blocks new work instead of inventing a clean abort',
  async (reason) => {
    const f = fixture();
    const entered = deferred<void>();
    const held = deferred<void>();
    const failure = new Error(reason);
    f.host.preview = vi.fn(async () => {
      entered.resolve();
      await held.promise;
      throw failure;
    });
    const observed = vi.fn();
    f.host.onDeferredError = observed;
    const owner = createAutomaticGuideBuilder(f.host);
    const work = expect(owner.request()).rejects.toBe(failure);
    await entered.promise;
    f.idle(false);
    const admission = expect(owner.preparePlayback()).rejects.toBe(failure);
    held.resolve();
    await admission;
    await work;
    f.idle(true);
    await expect(owner.wake()).rejects.toBe(failure);
    await expect(owner.request()).rejects.toBe(failure);
    expect(f.host.capture).toHaveBeenCalledOnce();
    expect(observed).toHaveBeenCalledWith(failure);
    await owner.suspend();
    await owner.dispose();
  },
);

it('suspension clears deferred intent and timers so hidden, closed or disabled work cannot restart later', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.idle(false);
  const owner = createAutomaticGuideBuilder(f.host);
  await owner.request();
  expect(vi.getTimerCount()).toBe(1);
  await owner.suspend();
  expect(vi.getTimerCount()).toBe(0);
  f.idle(true);
  await vi.advanceTimersByTimeAsync(1000);
  await owner.wake();
  expect(f.host.capture).not.toHaveBeenCalled();
  await owner.dispose();
});

it('revokes queued explicit intent on caller cancellation and on lifecycle suspension', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.idle(false);
  const owner = createAutomaticGuideBuilder(f.host);
  const caller = new AbortController();
  expect(await owner.run(caller.signal)).toMatchObject({ deferred: true });
  caller.abort();
  f.idle(true);
  await owner.wake();
  expect(f.host.capture).not.toHaveBeenCalled();
  f.idle(false);
  expect(await owner.run()).toMatchObject({ deferred: true });
  await owner.suspend();
  f.idle(true);
  await vi.advanceTimersByTimeAsync(1000);
  await owner.wake();
  expect(f.host.capture).not.toHaveBeenCalled();
  await owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it.each([null, undefined])(
  'keeps opaque %s preemption failures visible and blocks automatic retry',
  async (failure) => {
    const f = fixture();
    const entered = deferred<void>();
    const held = deferred<void>();
    f.host.preview = vi.fn(async () => {
      entered.resolve();
      await held.promise;
      throw failure;
    });
    const owner = createAutomaticGuideBuilder(f.host);
    const work = expect(owner.request()).rejects.toBe(failure);
    await entered.promise;
    f.idle(false);
    const admission = expect(owner.preparePlayback()).rejects.toBe(failure);
    held.resolve();
    await admission;
    await work;
    await expect(owner.wake()).rejects.toBe(failure);
    await owner.suspend();
    await owner.dispose();
  },
);

it('joins concurrent playback preparation and suspension without duplicating owned cleanup', async () => {
  const f = fixture();
  const entered = deferred<void>();
  const held = deferred<void>();
  const discard = deferred<void>();
  f.host.preview = vi.fn(async () => {
    entered.resolve();
    await held.promise;
    return { ticket: 'late-ticket', sourceRevision: 1 };
  });
  f.host.discard = vi.fn(async () => discard.promise);
  const owner = createAutomaticGuideBuilder(f.host);
  const work = owner.request();
  await entered.promise;
  f.idle(false);
  const admission = owner.preparePlayback();
  const suspended = owner.suspend();
  held.resolve();
  await vi.waitFor(() => expect(f.host.discard).toHaveBeenCalledOnce());
  discard.resolve();
  await Promise.all([work, admission, suspended]);
  expect(f.host.discard).toHaveBeenCalledOnce();
  f.idle(true);
  await owner.wake();
  expect(f.host.capture).toHaveBeenCalledOnce();
  await owner.dispose();
});

it('delegates a canceled maintenance tail to its exact owner without rerunning the full feed pipeline', async () => {
  const f = fixture();
  const entered = deferred<void>();
  const retained = deferred<void>();
  const prepared = deferred<void>();
  let signal!: AbortSignal;
  f.host.maintain = Object.assign(
    vi.fn(async (owned: AbortSignal) => {
      signal = owned;
      entered.resolve();
      await retained.promise;
      owned.throwIfAborted();
      return 'compacted' as const;
    }),
    { preparePlayback: vi.fn(async () => prepared.promise) },
  );
  const owner = createAutomaticGuideBuilder(f.host);
  const work = owner.request();
  await entered.promise;
  f.idle(false);
  let joined = false;
  const admission = owner.preparePlayback().then(() => (joined = true));
  expect(signal.aborted).toBe(true);
  expect(f.host.maintain.preparePlayback).toHaveBeenCalledOnce();
  retained.resolve();
  await Promise.resolve();
  expect(joined).toBe(false);
  prepared.resolve();
  await admission;
  await work;
  f.idle(true);
  await owner.wake();
  expect(f.host.capture).toHaveBeenCalledOnce();
  expect(f.host.preview).toHaveBeenCalledOnce();
  await owner.dispose();
});

it('revokes a deferred manual request when the app loses its lifecycle admission before idle', async () => {
  vi.useFakeTimers();
  const f = fixture();
  let foreground = true;
  f.host.canRun = () => foreground;
  f.idle(false);
  const owner = createAutomaticGuideBuilder(f.host);
  expect(await owner.run()).toMatchObject({ deferred: true });
  foreground = false;
  await vi.advanceTimersByTimeAsync(250);
  expect(vi.getTimerCount()).toBe(0);
  foreground = true;
  f.idle(true);
  await owner.wake();
  expect(f.host.capture).not.toHaveBeenCalled();
  await owner.dispose();
});

it('joins the active cached mapping writer but defers its queued latest pass until playback is idle', async () => {
  const f = fixture();
  const first = deferred<void>();
  const second = deferred<void>();
  const entered = deferred<void>();
  let calls = 0;
  f.host.connectCacheOnly = vi.fn(async () => {
    if (++calls === 1) {
      entered.resolve();
      await first.promise;
    } else await second.promise;
    return { catalogRevision: '7', matched: 1, unmatched: 9 };
  });
  const owner = createAutomaticGuideBuilder(f.host);
  const cached = owner.requestCached();
  await entered.promise;
  void owner.requestCached();
  f.idle(false);
  let joined = false;
  const admission = owner.preparePlayback().then(() => (joined = true));
  await Promise.resolve();
  expect(joined).toBe(false);
  first.resolve();
  await admission;
  await cached;
  expect(joined).toBe(true);
  expect(calls).toBe(1);
  f.idle(true);
  const resumed = owner.wake();
  await vi.waitFor(() => expect(calls).toBe(2));
  second.resolve();
  await resumed;
  expect(f.host.capture).not.toHaveBeenCalled();
  await owner.dispose();
});

it('coalesces busy cached mapping requests and reconnects only the latest scope once idle without acquisition', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.idle(false);
  let latest = '7';
  const seen: string[] = [];
  f.host.connectCacheOnly = vi.fn(async () => {
    seen.push(latest);
    return { catalogRevision: latest, matched: 1, unmatched: 9 };
  });
  const owner = createAutomaticGuideBuilder(f.host);
  for (let n = 0; n < 500; n++) {
    latest = String(7 + n);
    await owner.requestCached();
  }
  expect(f.host.connectCacheOnly).not.toHaveBeenCalled();
  f.idle(true);
  await vi.advanceTimersByTimeAsync(250);
  await owner.wake();
  expect(seen).toEqual(['506']);
  expect(f.host.capture).not.toHaveBeenCalled();
  expect(f.host.preview).not.toHaveBeenCalled();
  await owner.dispose();
  expect(vi.getTimerCount()).toBe(0);
});

it('rechecks idle after retained cleanup before admitting the cached mapping native operation', async () => {
  const f = fixture();
  const entered = deferred<void>();
  const retained = deferred<void>();
  f.host.settlePreviews = vi.fn(async () => {
    entered.resolve();
    await retained.promise;
  });
  const owner = createAutomaticGuideBuilder(f.host);
  const cached = owner.requestCached();
  await entered.promise;
  f.idle(false);
  retained.resolve();
  await cached;
  expect(f.host.connectCacheOnly).not.toHaveBeenCalled();
  f.idle(true);
  await owner.wake();
  expect(f.host.connectCacheOnly).toHaveBeenCalledOnce();
  expect(f.host.capture).not.toHaveBeenCalled();
  await owner.dispose();
});

it('retains a cached mapping connection refusal at the playback barrier', async () => {
  const f = fixture();
  const entered = deferred<void>();
  const held = deferred<void>();
  const failure = new Error('cached-connection-receipt-unknown');
  f.host.connectCacheOnly = vi.fn(async () => {
    entered.resolve();
    await held.promise;
    throw failure;
  });
  const owner = createAutomaticGuideBuilder(f.host);
  const cached = expect(owner.requestCached()).rejects.toBe(failure);
  await entered.promise;
  const admission = expect(owner.preparePlayback()).rejects.toBe(failure);
  held.resolve();
  await cached;
  await admission;
  await expect(owner.request()).rejects.toBe(failure);
  await owner.suspend();
  await owner.dispose();
});

it('revokes a preempted active manual Find when its original caller aborts before idle retry', async () => {
  const f = fixture();
  const entered = deferred<void>();
  const retained = deferred<void>();
  const capture = f.host.capture;
  f.host.capture = vi.fn(async (signal, report) => {
    entered.resolve();
    await retained.promise;
    return capture(signal, report);
  });
  const caller = new AbortController();
  const owner = createAutomaticGuideBuilder(f.host);
  const work = expect(owner.run(caller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  f.idle(false);
  const admission = owner.preparePlayback();
  caller.abort();
  retained.resolve();
  await admission;
  await work;
  f.idle(true);
  await owner.wake();
  expect(f.host.capture).toHaveBeenCalledOnce();
  expect(f.host.preview).not.toHaveBeenCalled();
  await owner.dispose();
});

it.each(['manual', 'cached'] as const)(
  'reports an unowned permission AbortError from queued %s work instead of declaring a quiet cancellation',
  async (kind) => {
    const f = fixture();
    f.idle(false);
    const refused = new DOMException('Program guide permission changed.', 'AbortError');
    expect(isAutomaticGuidePermissionRefusal(refused)).toBe(false);
    f.host.preview = vi.fn(async () => {
      throw refused;
    });
    f.host.connectCacheOnly = vi.fn(async () => {
      throw refused;
    });
    const visible = vi.fn();
    f.host.onDeferredError = visible;
    const owner = createAutomaticGuideBuilder(f.host);
    try {
      if (kind === 'manual') expect(await owner.run()).toMatchObject({ deferred: true });
      else await owner.requestCached();
      f.idle(true);
      await expect(owner.wake()).rejects.toBe(refused);
      expect(visible).toHaveBeenCalledWith(refused);
      expect(f.host.commitMatched).not.toHaveBeenCalled();
      await expect(owner.preparePlayback()).rejects.toBe(refused);
    } finally {
      await owner.suspend();
      await owner.dispose();
    }
  },
);

it('keeps an actually owned queued cancellation quiet after joining its native preview and cleanup', async () => {
  const f = fixture();
  const entered = deferred<void>();
  const retained = deferred<void>();
  const visible = vi.fn();
  f.host.onDeferredError = visible;
  f.host.preview = vi.fn(async (_provider, signal) => {
    entered.resolve();
    await retained.promise;
    signal.throwIfAborted();
    return { ticket: 'never-published', sourceRevision: 1 };
  });
  f.idle(false);
  const owner = createAutomaticGuideBuilder(f.host);
  expect(await owner.run()).toMatchObject({ deferred: true });
  f.idle(true);
  const work = owner.wake();
  await entered.promise;
  f.idle(false);
  const stopped = owner.preparePlayback();
  retained.resolve();
  await Promise.all([work, stopped]);
  expect(visible).not.toHaveBeenCalled();
  expect(f.host.commitMatched).not.toHaveBeenCalled();
  await owner.suspend();
  await owner.dispose();
});

it.each([false, true])(
  'reports a genuine pre-preview refusal without poisoning media unless cleanup fails: %s',
  async (cleanupFails) => {
    const f = fixture();
    const source = {
      id: 'saved',
      name: 'Saved guide',
      location: 'http://fixture.invalid/guide',
      kind: 'url' as const,
      allowHttp: true,
      revision: 1,
      updatedMs: null,
    };
    const permission = createAutomaticGuidePermissions([source]).forLocation(source.location);
    const gateway = {
      sources: vi.fn(async () => [{ ...source, allowHttp: false, revision: 2 }]),
      previewSource: vi.fn(async () => ({ ticket: 'forbidden', sourceRevision: 2 })),
      previewProposedSource: vi.fn(async () => ({
        ticket: 'forbidden-proposed',
        sourceRevision: 0,
      })),
    };
    f.host.preview = (_provider, signal) =>
      previewPermittedAutomaticGuide(permission, source.name, gateway, signal);
    const cleanup = new Error('Owned preview cleanup unconfirmed');
    let cleanupAllowed = !cleanupFails;
    let cleanups = 0;
    f.host.settlePreviews = vi.fn(async () => {
      if (++cleanups > 1 && !cleanupAllowed) throw cleanup;
    });
    const visible = vi.fn();
    f.host.onDeferredError = visible;
    f.idle(false);
    const owner = createAutomaticGuideBuilder(f.host);
    try {
      expect(await owner.run()).toMatchObject({ deferred: true });
      f.idle(true);
      if (cleanupFails) await expect(owner.wake()).rejects.toBe(cleanup);
      else await expect(owner.wake()).resolves.toBeUndefined();
      expect(visible).toHaveBeenCalledOnce();
      expect(isAutomaticGuidePermissionRefusal(visible.mock.calls[0]?.[0])).toBe(!cleanupFails);
      expect(gateway.previewSource).not.toHaveBeenCalled();
      expect(gateway.previewProposedSource).not.toHaveBeenCalled();
      expect(f.host.commitMatched).not.toHaveBeenCalled();
      if (cleanupFails) await expect(owner.preparePlayback()).rejects.toBe(cleanup);
      else await expect(owner.preparePlayback()).resolves.toBeUndefined();
    } finally {
      cleanupAllowed = true;
      await owner.suspend();
      await owner.dispose();
    }
  },
);

it.each([false, true])(
  'settles a known refusal overlapping cached media admission, retaining any later cleanup failure: %s',
  async (cleanupFails) => {
    const f = fixture();
    const source = {
      id: 'saved',
      name: 'Saved guide',
      location: 'http://fixture.invalid/guide',
      kind: 'url' as const,
      allowHttp: true,
      revision: 1,
      updatedMs: null,
    };
    const permission = createAutomaticGuidePermissions([source]).forLocation(source.location);
    const entered = deferred<void>();
    const retained = deferred<void>();
    const gateway = {
      sources: vi.fn(async () => {
        entered.resolve();
        await retained.promise;
        return [{ ...source, allowHttp: false, revision: 2 }];
      }),
      previewSource: vi.fn(async () => ({})),
      previewProposedSource: vi.fn(async () => ({})),
    };
    f.host.connectCacheOnly = async (signal) => {
      await previewPermittedAutomaticGuide(permission, source.name, gateway, signal);
      return { catalogRevision: '7', matched: 1, unmatched: 9 };
    };
    const cleanup = new Error('Unknown first cleanup outcome');
    let cleanups = 0;
    f.host.settlePreviews = vi.fn(async () => {
      if (++cleanups === 2 && cleanupFails) throw cleanup;
    });
    const owner = createAutomaticGuideBuilder(f.host);
    const work = owner.requestCached();
    const refused = cleanupFails
      ? expect(work).rejects.toBe(cleanup)
      : expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    f.idle(false);
    const barrier = owner.preparePlayback();
    const admission = cleanupFails
      ? expect(barrier).rejects.toBe(cleanup)
      : expect(barrier).resolves.toBeUndefined();
    retained.resolve();
    await refused;
    await admission;
    expect(gateway.previewSource).not.toHaveBeenCalled();
    expect(gateway.previewProposedSource).not.toHaveBeenCalled();
    expect(f.host.commitMatched).not.toHaveBeenCalled();
    await owner.suspend();
    await owner.dispose();
  },
);

it('allows a later tune when a deferred cached connection detects a changed scope before writing', async () => {
  const f = fixture();
  const refused = automaticGuideConfigurationChanged();
  const visible = vi.fn();
  f.host.onDeferredError = visible;
  f.host.connectCacheOnly = vi.fn(async () => {
    throw refused;
  });
  f.idle(false);
  const owner = createAutomaticGuideBuilder(f.host);
  await owner.requestCached();
  f.idle(true);
  await expect(owner.wake()).resolves.toBeUndefined();
  expect(visible).toHaveBeenCalledExactlyOnceWith(refused);
  await expect(owner.preparePlayback()).resolves.toBeUndefined();
  await owner.dispose();
});

it('never waives a cleanup failure merely because its error object carries a preflight refusal brand', async () => {
  const f = fixture();
  const source = {
    id: 'saved',
    name: 'Saved guide',
    location: 'http://fixture.invalid/guide',
    kind: 'url' as const,
    allowHttp: true,
    revision: 1,
    updatedMs: null,
  };
  let refusal: unknown;
  try {
    await previewPermittedAutomaticGuide(
      createAutomaticGuidePermissions([source]).forLocation(source.location),
      source.name,
      {
        sources: async () => [{ ...source, allowHttp: false }],
        previewSource: async () => ({}),
        previewProposedSource: async () => ({}),
      },
      new AbortController().signal,
    );
  } catch (error) {
    refusal = error;
  }
  expect(isAutomaticGuidePermissionRefusal(refusal)).toBe(true);
  let cleanups = 0;
  f.host.settlePreviews = async () => {
    if (++cleanups === 2) throw refusal;
  };
  f.host.preview = async () => {
    throw refusal;
  };
  f.idle(false);
  const owner = createAutomaticGuideBuilder(f.host);
  await owner.run();
  f.idle(true);
  await expect(owner.wake()).rejects.toBe(refusal);
  await expect(owner.preparePlayback()).rejects.toBe(refusal);
  await owner.suspend();
  await owner.dispose();
});
