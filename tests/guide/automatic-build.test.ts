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
import {
  createAutomaticGuideBuilder,
  type AutomaticGuideBuildHost,
  type AutomaticGuideBuildProgress,
} from '../../src/guide/automatic-build';
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
it('reports acquisition cooldown as skipped rather than usable and permits explicit retry', async () => {
  const f = fixture(1);
  f.host.cacheReady = async () => false;
  f.host.acquisitionAllowed = async (_provider, _signal, context) => !context.automatic;
  const progress: AutomaticGuideBuildProgress[] = [];
  f.host.onProgress = (value) => progress.push(value);
  const owner = createAutomaticGuideBuilder(f.host);
  await owner.request();
  expect(progress.at(-1)).toMatchObject({ skipped: 1, checked: 0, failed: 0 });
  expect(f.calls).toEqual([]);
  expect(await owner.run()).toMatchObject({ skipped: 0, checked: 1, failed: 0 });
  await owner.dispose();
});
it('rechecks scope after an asynchronous acquisition admission before preview', async () => {
  const f = fixture(1);
  f.host.acquisitionAllowed = async () => {
    f.current(false);
    return true;
  };
  const owner = createAutomaticGuideBuilder(f.host);
  await owner.request();
  expect(f.calls).toEqual([]);
  await owner.dispose();
});
it('does no automatic acquisition while disabled but retains an explicit manual run', async () => {
  const f = fixture(1);
  let captures = 0;
  const capture = f.host.capture;
  f.host.capture = async (signal) => {
    captures++;
    return capture(signal);
  };
  f.host.canRequest = () => false;
  const owner = createAutomaticGuideBuilder(f.host);
  await owner.request();
  expect(captures).toBe(0);
  expect(f.calls).toEqual([]);
  expect(await owner.run()).toMatchObject({ checked: 1, connected: 1 });
  expect(captures).toBe(1);
  await owner.dispose();
});

it('drops queued automatic work when the preference is disabled and cleanup joins the active run', async () => {
  const f = fixture(1),
    held = deferred<void>();
  let enabled = true,
    captures = 0;
  const capture = f.host.capture;
  f.host.canRequest = () => enabled;
  f.host.capture = async (signal) => {
    captures++;
    return capture(signal);
  };
  f.host.preview = async () => {
    await held.promise;
    return { ticket: 'held', sourceRevision: 1 };
  };
  const owner = createAutomaticGuideBuilder(f.host),
    active = owner.request();
  await Promise.resolve();
  await Promise.resolve();
  void owner.request();
  enabled = false;
  const cleanup = owner.suspend();
  held.resolve();
  await cleanup;
  await active;
  expect(captures).toBe(1);
  await owner.request();
  expect(captures).toBe(1);
  await owner.dispose();
});
it('publishes a useful cache across catalog changes, connects the fresh revision and never discards its consumed ticket', async () => {
  const f = fixture(1);
  f.host.preview = async () => {
    f.current(false);
    return { ticket: 'saved-cache', sourceRevision: 1 };
  };
  f.host.publishCache = async (preview) => {
    f.calls.push('cache:' + preview.ticket);
  };
  f.host.connectLatest = async () => {
    f.current(true);
    return { catalogRevision: '8', matched: 0, unmatched: 10 };
  };
  const owner = createAutomaticGuideBuilder(f.host);
  expect(await owner.run()).toMatchObject({ checked: 1, failed: 0, connected: 0 });
  expect(f.calls).toEqual(['cache:saved-cache']);
  await owner.dispose();
});
it('coalesces many scan acknowledgments and reuses the published cache for the latest catalog', async () => {
  const f = fixture(1),
    held = deferred<void>();
  let captures = 0,
    cached = false;
  const capture = f.host.capture;
  f.host.capture = async (signal) => {
    captures++;
    return capture(signal);
  };
  f.host.publishCache = async () => {
    await held.promise;
    cached = true;
  };
  f.host.cacheReady = async () => cached;
  f.host.connectLatest = async () => ({ catalogRevision: '8', matched: 1, unmatched: 9 });
  const owner = createAutomaticGuideBuilder(f.host);
  const work = owner.request();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  for (let i = 0; i < 500; i++) expect(owner.request()).toBe(work);
  held.resolve();
  await work;
  expect(captures).toBe(2);
  expect(f.calls).toEqual(['preview:Guide 0']);
  await owner.dispose();
});
function fixture(count = 2) {
  const calls: string[] = [];
  let current = true,
    allowed = true;
  const host: AutomaticGuideBuildHost = {
    capture: async () => ({
      catalogRevision: '7',
      channelCount: 10,
      providers: Array.from({ length: count }, (_, i) => ({
        name: 'Guide ' + i,
        location: 'https://fixture.invalid/' + i,
        allowHttp: false,
      })),
    }),
    isCurrent: () => current,
    canRun: () => allowed,
    preview: async (provider) => {
      calls.push('preview:' + provider.name);
      return { ticket: provider.name, sourceRevision: 1 };
    },
    commitMatched: async (preview, revision) => {
      calls.push('commit:' + preview.ticket + ':' + revision);
      return { committed: true, matched: 1, unmatched: 9 };
    },
    discard: async (ticket) => {
      calls.push('discard:' + ticket);
    },
  };
  return {
    host,
    calls,
    current: (value: boolean) => (current = value),
    allowed: (value: boolean) => (allowed = value),
  };
}
it('maintenance follows publication and connection, with its own progress and receipt', async () => {
  const f = fixture(1);
  const phases: string[] = [];
  f.host.onProgress = (p) => phases.push(p.phase);
  f.host.maintain = async () => {
    expect(f.calls).toEqual(['preview:Guide 0', 'commit:Guide 0:7']);
    return 'deferred';
  };
  const owner = createAutomaticGuideBuilder(f.host);
  expect(await owner.run()).toMatchObject({ checked: 1, failed: 0, maintenance: 'deferred' });
  expect(phases.slice(-2)).toEqual(['optimizing', 'completed']);
  await owner.dispose();
});
it('startup cache-only connection never compacts or starts maintenance', async () => {
  const f = fixture(0);
  f.host.connectCacheOnly = async () => ({ catalogRevision: '7', matched: 0, unmatched: 10 });
  f.host.maintain = async () => {
    throw new Error('startup must not maintain');
  };
  const owner = createAutomaticGuideBuilder(f.host);
  await owner.requestCached();
  expect(f.calls).toEqual([]);
  await owner.dispose();
});
it('maintenance failure cannot erase already published guide counts or invent a feed failure', async () => {
  const f = fixture(1);
  f.host.maintain = async () => {
    throw new Error('fixture storage busy');
  };
  const owner = createAutomaticGuideBuilder(f.host);
  expect(await owner.run()).toMatchObject({ checked: 1, failed: 0, maintenance: 'failed' });
  await owner.dispose();
});
it('late cancellation retains the returned durable maintenance result and joins disposal', async () => {
  const f = fixture(1),
    held = deferred<'compacted'>();
  const entered = deferred<void>();
  f.host.maintain = async () => {
    entered.resolve();
    return held.promise;
  };
  const owner = createAutomaticGuideBuilder(f.host);
  const work = owner.run();
  await entered.promise;
  let disposed = false;
  const stop = owner.dispose().then(() => {
    disposed = true;
  });
  await Promise.resolve();
  expect(disposed).toBe(false);
  held.resolve('compacted');
  expect(await work).toMatchObject({ checked: 1, maintenance: 'compacted' });
  await stop;
});
it('reports real phases and counts each settled feed once despite overlapping success/skip totals', async () => {
  const f = fixture(3);
  const capture = f.host.capture;
  f.host.capture = async (signal, phase) => {
    phase?.('reading-playlists');
    const value = await capture(signal);
    return {
      ...value,
      discoveryFailed: 1,
      providers: value.providers.map((p, index) =>
        index === 0 ? { ...p, location: 'http://fixture.invalid/permission-needed' } : p,
      ),
    };
  };
  const preview = f.host.preview;
  f.host.preview = async (provider, signal) => {
    if (provider.name === 'Guide 1') throw new Error('fixture download unavailable');
    return preview(provider, signal);
  };
  f.host.commitMatched = async () => ({ committed: false, matched: 0, unmatched: 10 });
  const progress: Readonly<AutomaticGuideBuildProgress>[] = [];
  f.host.onProgress = (value) => progress.push(value);
  const owner = createAutomaticGuideBuilder(f.host);
  expect(await owner.run()).toMatchObject({
    checked: 1,
    failed: 1,
    skipped: 2,
    discoveryFailed: 1,
  });
  expect(progress[0]).toMatchObject({ phase: 'capturing', attempted: 0, total: 0 });
  expect(progress.some((p) => p.phase === 'reading-playlists')).toBe(true);
  expect(progress.some((p) => p.phase === 'fetching')).toBe(true);
  expect(progress.some((p) => p.phase === 'publishing')).toBe(true);
  expect(progress.at(-1)).toMatchObject({ phase: 'completed', attempted: 3, total: 3, failed: 1 });
  expect(
    progress.every(
      (p, i) => p.attempted <= p.total && (i === 0 || p.attempted >= progress[i - 1]!.attempted),
    ),
  ).toBe(true);
  await owner.dispose();
});

it('a failing progress observer cannot erase a durable successful guide receipt', async () => {
  const f = fixture(1);
  f.host.onProgress = () => {
    throw new Error('fixture observer unavailable');
  };
  const owner = createAutomaticGuideBuilder(f.host);
  expect(await owner.run()).toMatchObject({ checked: 1, failed: 0, connected: 1 });
  expect(f.calls).toEqual(['preview:Guide 0', 'commit:Guide 0:7']);
  await owner.dispose();
});
it('a retired capture callback cannot regress completed or newer run progress', async () => {
  const f = fixture(1);
  const capture = f.host.capture;
  const reports: NonNullable<Parameters<AutomaticGuideBuildHost['capture']>[1]>[] = [];
  const progress: Readonly<AutomaticGuideBuildProgress>[] = [];
  f.host.onProgress = (value) => progress.push(value);
  f.host.capture = async (signal, report) => {
    if (report) reports.push(report);
    return capture(signal);
  };
  const owner = createAutomaticGuideBuilder(f.host);
  await owner.run();
  const completed = progress.at(-1);
  reports[0]!('reading-playlists');
  expect(progress.at(-1)).toBe(completed);
  const held = deferred<void>();
  const entered = deferred<void>();
  f.host.capture = async (signal) => {
    entered.resolve();
    await held.promise;
    return capture(signal);
  };
  const newer = owner.run();
  await entered.promise;
  const pending = progress.at(-1);
  expect(pending?.phase).toBe('capturing');
  reports[0]!('reading-playlists');
  expect(progress.at(-1)).toBe(pending);
  held.resolve();
  await newer;
  await owner.dispose();
});
it('1000 failed uncached providers are not reacquired by repeated automatic catalog publications', async () => {
  const f = fixture(1000);
  let clock = 1000,
    revision = 7,
    acquisitions = 0;
  let last: { skipped: number; failed: number } | null = null;
  const capture = f.host.capture;
  f.host.capture = async (signal) => ({
    ...(await capture(signal)),
    catalogRevision: String(++revision),
  });
  f.host.isScopeCurrent = () => true;
  f.host.connectScopeLatest = async () => ({
    catalogRevision: String(revision),
    matched: 0,
    unmatched: 10,
  });
  f.host.preview = async () => {
    acquisitions++;
    throw new Error('Controlled acquisition failure');
  };
  f.host.onProgress = (progress) => {
    last = progress;
  };
  const owner = createAutomaticGuideBuilder(f.host, { now: () => clock });
  await owner.request();
  expect(acquisitions).toBe(1000);
  expect(last).toMatchObject({ failed: 1000, skipped: 0 });
  for (let index = 0; index < 10; index++) {
    clock++;
    await owner.request();
  }
  expect(acquisitions).toBe(1000);
  expect(last).toMatchObject({ failed: 0, skipped: 1000 });
  await owner.dispose();
});
it('manual run bypasses cooldown and a successful publication resets its failure entry', async () => {
  const f = fixture(1);
  let acquisitions = 0,
    succeeds = false;
  f.host.preview = async () => {
    acquisitions++;
    if (!succeeds) throw new Error('Controlled acquisition failure');
    return { ticket: 'fresh', sourceRevision: 1 };
  };
  const owner = createAutomaticGuideBuilder(f.host, { now: () => 1000 });
  await owner.request();
  await owner.request();
  expect(acquisitions).toBe(1);
  succeeds = true;
  expect(await owner.run()).toMatchObject({ checked: 1, failed: 0 });
  expect(acquisitions).toBe(2);
  await owner.request();
  expect(acquisitions).toBe(3);
  await owner.dispose();
});
it('expiry and backward clock changes permit new attempts without a timer or permanent suppression', async () => {
  const f = fixture(1);
  let clock = 1000,
    acquisitions = 0;
  f.host.preview = async () => {
    acquisitions++;
    throw new Error('Controlled failure');
  };
  const owner = createAutomaticGuideBuilder(f.host, { now: () => clock });
  await owner.request();
  clock = 60999;
  await owner.request();
  expect(acquisitions).toBe(1);
  clock = 61000;
  await owner.request();
  expect(acquisitions).toBe(2);
  clock = 999;
  await owner.request();
  expect(acquisitions).toBe(3);
  await owner.request();
  expect(acquisitions).toBe(3);
  await owner.dispose();
});
it.each(['name', 'location', 'grant', 'legacy-revision', 'global-scope'] as const)(
  'changed %s invalidates the exact failed-provider scope',
  async (change) => {
    const f = fixture(1);
    let changed = false,
      acquisitions = 0,
      scopeCurrent = true;
    const capture = f.host.capture;
    if (change === 'global-scope') {
      f.host.isScopeCurrent = () => scopeCurrent;
      f.host.connectScopeLatest = async () => ({ catalogRevision: '7', matched: 0, unmatched: 10 });
    }
    f.host.capture = async (signal) => {
      const original = await capture(signal);
      scopeCurrent = true;
      return {
        ...original,
        catalogRevision: changed && change === 'legacy-revision' ? '8' : '7',
        providers: original.providers.map((provider) => ({
          ...provider,
          ...(changed && change === 'name' ? { name: 'New name' } : {}),
          ...(changed && change === 'location' ? { location: 'https://fixture.invalid/new' } : {}),
          ...(changed && change === 'grant' ? { allowHttp: true } : {}),
        })),
      };
    };
    f.host.preview = async () => {
      acquisitions++;
      throw new Error('Controlled failure');
    };
    const owner = createAutomaticGuideBuilder(f.host, { now: () => 1000 });
    await owner.request();
    await owner.request();
    expect(acquisitions).toBe(1);
    changed = true;
    if (change === 'global-scope') scopeCurrent = false;
    await owner.request();
    expect(acquisitions).toBe(2);
    await owner.dispose();
  },
);
it('canceled actual acquisition is joined but never creates a negative cache entry', async () => {
  const f = fixture(1),
    entered = deferred<void>(),
    held = deferred<void>();
  let acquisitions = 0;
  f.host.preview = async (_provider, signal) => {
    acquisitions++;
    if (acquisitions === 1) {
      entered.resolve();
      await held.promise;
      signal.throwIfAborted();
    }
    return { ticket: 'retry', sourceRevision: 1 };
  };
  const owner = createAutomaticGuideBuilder(f.host, { now: () => 1000 });
  const work = owner.request();
  await entered.promise;
  let joined = false;
  const suspension = owner.suspend().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  held.resolve();
  await Promise.all([suspension, work]);
  await owner.request();
  expect(acquisitions).toBe(2);
  expect(f.calls).toEqual(['commit:retry:7']);
  await owner.dispose();
});
it('failed publication does not suppress subsequent acquisition as if the provider were unavailable', async () => {
  const f = fixture(1);
  let acquisitions = 0;
  f.host.preview = async () => {
    acquisitions++;
    return { ticket: `ticket-${acquisitions}`, sourceRevision: 1 };
  };
  f.host.commitMatched = async () => {
    throw new Error('Controlled storage failure');
  };
  const owner = createAutomaticGuideBuilder(f.host, { now: () => 1000 });
  await owner.request();
  await owner.request();
  expect(acquisitions).toBe(2);
  expect(f.calls).toEqual(['discard:ticket-1', 'discard:ticket-2']);
  await owner.dispose();
});
it.each([NaN, Infinity, -1, 0.5])(
  'invalid retry clock %s refuses before acquisition',
  async (instant) => {
    const f = fixture(1),
      owner = createAutomaticGuideBuilder(f.host, { now: () => instant });
    await expect(owner.request()).rejects.toThrow('retry clock is invalid');
    expect(f.calls).toEqual([]);
    await owner.dispose();
  },
);
it('oversized retry-key scope remains wholly attempted instead of retaining a partial negative cache', async () => {
  const f = fixture(100),
    capture = f.host.capture;
  let acquisitions = 0;
  f.host.capture = async (signal) => {
    const captured = await capture(signal);
    return {
      ...captured,
      providers: captured.providers.map((provider) => ({
        ...provider,
        location: 'https://fixture.invalid/' + 'x'.repeat(16000),
      })),
    };
  };
  f.host.preview = async () => {
    acquisitions++;
    throw new Error('Controlled failure');
  };
  const owner = createAutomaticGuideBuilder(f.host, { now: () => 1000 });
  await owner.request();
  await owner.request();
  expect(acquisitions).toBe(200);
  await owner.dispose();
});
it.each(['application-closing', 'canceled', 'guide-cancelled'])(
  'joins held native %s refusal on close without treating it as a guide failure',
  async (code) => {
    const f = fixture(0);
    const entered = deferred<void>();
    const held = deferred<void>();
    f.host.capture = async () => {
      entered.resolve();
      await held.promise;
      throw code;
    };
    const owner = createAutomaticGuideBuilder(f.host);
    const work = owner.request();
    const failedOperation = expect(work).rejects.toBe(code);
    await entered.promise;
    let disposed = false;
    const cleanup = owner.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    held.resolve();
    await cleanup;
    await failedOperation;
    expect(disposed).toBe(true);
    expect(f.calls).toEqual([]);
    await owner.dispose();
  },
);

it.each([
  new Error('application-closing'),
  new Error('Program guide cancellation could not be confirmed.'),
  'sqlite-storage-full',
])('retains an opaque failure after joining the actual guide pipeline', async (error) => {
  const f = fixture(0);
  const entered = deferred<void>();
  const held = deferred<void>();
  f.host.capture = async () => {
    entered.resolve();
    await held.promise;
    throw error;
  };
  const owner = createAutomaticGuideBuilder(f.host);
  const work = owner.request();
  const operation = expect(work).rejects.toBe(error);
  await entered.promise;
  const cleanup = expect(owner.dispose()).rejects.toBe(error);
  held.resolve();
  await cleanup;
  await operation;
});

it('retains an unconfirmed late-ticket discard after native close refusal until explicit retry', async () => {
  const f = fixture(1);
  const entered = deferred<void>();
  const held = deferred<void>();
  let discards = 0;
  f.host.preview = async () => {
    entered.resolve();
    await held.promise;
    return { ticket: 'late', sourceRevision: 1 };
  };
  f.host.discard = async () => {
    discards++;
    if (discards < 3) throw new Error('Ticket cleanup unconfirmed');
  };
  const owner = createAutomaticGuideBuilder(f.host);
  const operation = expect(owner.request()).rejects.toThrow('Ticket cleanup unconfirmed');
  await entered.promise;
  const cleanup = expect(owner.dispose()).rejects.toThrow('Ticket cleanup unconfirmed');
  held.resolve();
  await operation;
  await cleanup;
  expect(discards).toBe(2);
  await owner.dispose();
  expect(discards).toBe(3);
});
describe('automatic exact-match guide owner', () => {
  it('checks every provider sequentially and duplicates share one real pipeline', async () => {
    const f = fixture(100),
      held = deferred<{ ticket: string; sourceRevision: number }>();
    const preview = f.host.preview;
    f.host.preview = async (provider, signal) =>
      provider.name === 'Guide 0' ? held.promise : preview(provider, signal);
    const owner = createAutomaticGuideBuilder(f.host),
      first = owner.run();
    expect(owner.run()).toBe(first);
    await Promise.resolve();
    await Promise.resolve();
    expect(f.calls).toEqual([]);
    held.resolve({ ticket: 'first', sourceRevision: 1 });
    const result = await first;
    expect(result.connected).toBe(100);
    expect(result.checked).toBe(100);
    expect(f.calls[0]).toBe('commit:first:7');
    await owner.dispose();
  });
  it('retains prior schedules when a provider fails or has no exact matches', async () => {
    const f = fixture(3);
    f.host.preview = async (provider) => {
      if (provider.name === 'Guide 0') throw new Error('secret URL');
      return { ticket: provider.name, sourceRevision: 1 };
    };
    f.host.commitMatched = async (preview) =>
      preview.ticket === 'Guide 1'
        ? { committed: false, matched: 0, unmatched: 10 }
        : { committed: true, matched: 2, unmatched: 8 };
    const owner = createAutomaticGuideBuilder(f.host);
    expect(await owner.run()).toEqual({
      connected: 2,
      unmatched: 10,
      unmappedAmbiguous: null,
      mappingConflictAssessment: 'not-assessed',
      preservedMappingConflicts: null,
      checked: 2,
      failed: 1,
      skipped: 1,
    });
    await owner.dispose();
  });
  it('catalog change after preview discards ticket before any commit', async () => {
    const f = fixture();
    f.host.preview = async () => {
      f.current(false);
      return { ticket: 'late', sourceRevision: 1 };
    };
    const owner = createAutomaticGuideBuilder(f.host);
    await expect(owner.run()).rejects.toHaveProperty('name', 'AbortError');
    expect(f.calls).toEqual(['discard:late']);
    await owner.dispose();
  });
  it('cancellation joins the real preview and late ticket discard before close settles', async () => {
    const f = fixture(),
      held = deferred<{ ticket: string; sourceRevision: number }>(),
      discard = deferred<void>();
    f.host.preview = () => held.promise;
    f.host.discard = () => discard.promise;
    const owner = createAutomaticGuideBuilder(f.host);
    const run = owner.run();
    void run.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    let closed = false;
    const cleanup = owner.dispose().then(() => (closed = true));
    held.resolve({ ticket: 'late', sourceRevision: 1 });
    await Promise.resolve();
    await Promise.resolve();
    expect(closed).toBe(false);
    discard.resolve();
    await cleanup;
    expect(closed).toBe(true);
    expect(f.calls).toEqual([]);
    await expect(owner.run()).rejects.toHaveProperty('name', 'AbortError');
  });
  it('failed cleanup remains owned and explicit disposal retry drains it', async () => {
    const f = fixture();
    let discards = 0;
    f.host.preview = async () => {
      f.current(false);
      return { ticket: 'late', sourceRevision: 1 };
    };
    f.host.discard = async () => {
      discards++;
      if (discards === 1) throw new Error('failed');
    };
    const owner = createAutomaticGuideBuilder(f.host);
    await expect(owner.run()).rejects.toThrow('failed');
    await owner.dispose();
    expect(discards).toBe(2);
  });
  it('definite commit wins cancellation while settlement prevents further providers', async () => {
    const f = fixture(),
      commit = deferred<{ committed: boolean; matched: number; unmatched: number }>();
    f.host.commitMatched = () => commit.promise;
    const controller = new AbortController(),
      owner = createAutomaticGuideBuilder(f.host);
    const run = owner.run(controller.signal);
    void run.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    controller.abort();
    commit.resolve({ committed: true, matched: 1, unmatched: 9 });
    await expect(run).rejects.toHaveProperty('name', 'AbortError');
    expect(f.calls).toEqual(['preview:Guide 0']);
    await owner.dispose();
  });
  it('refuses over-limit snapshots and skips ungranted HTTP before preview', async () => {
    const f = fixture(1001),
      owner = createAutomaticGuideBuilder(f.host);
    await expect(owner.run()).rejects.toThrow('snapshot');
    expect(f.calls).toEqual([]);
    await owner.dispose();
    const g = fixture(1);
    g.host.capture = async () => ({
      catalogRevision: '7',
      channelCount: 1,
      providers: [{ name: 'HTTP', location: 'http://fixture.invalid/guide', allowHttp: false }],
    });
    const next = createAutomaticGuideBuilder(g.host);
    expect((await next.run()).skipped).toBe(1);
    expect(g.calls).toEqual([]);
    await next.dispose();
  });
});

function reviewedAliases() {
  return {
    schemaVersion: 1 as const,
    guideLocation:
      'https://raw.githubusercontent.com/matthuisman/i.mjh.nz/master/PlutoTV/us.xml.gz',
    provenanceLocation:
      'https://raw.githubusercontent.com/iptv-org/epg/master/sites/pluto.tv/pluto.tv_us.channels.xml',
    provenanceSha256: 'dc1eaca8b90b1d227850f81fb02793c74a804c473eb26dd674cd1eaa8084c89e',
    pairs: [
      {
        catalogSourceId: 'saved-source',
        appChannelId: 'canonical-channel',
        providerId: 'PGATour.us@SD',
        xmltvChannelId: '5de94dacb394a300099fa22a',
      },
    ],
  };
}
it('retains the immutable scoped alias snapshot through an asynchronous preview', async () => {
  const f = fixture(0);
  const aliases = reviewedAliases();
  const provider = {
    name: 'Reviewed Pluto',
    location: aliases.guideLocation,
    allowHttp: false,
    aliases,
  };
  const entered = deferred<void>();
  const held = deferred<{ ticket: string; sourceRevision: number }>();
  let captured: Parameters<AutomaticGuideBuildHost['preview']>[0] | undefined;
  let committed: Parameters<AutomaticGuideBuildHost['commitMatched']>[3] | undefined;
  f.host.capture = async () => ({ catalogRevision: '7', channelCount: 1, providers: [provider] });
  f.host.preview = async (snapshot) => {
    captured = snapshot;
    entered.resolve();
    return held.promise;
  };
  f.host.commitMatched = async (_preview, revision, _signal, snapshot) => {
    expect(revision).toBe('7');
    committed = snapshot;
    return { committed: true, matched: 1, unmatched: 0 };
  };
  const owner = createAutomaticGuideBuilder(f.host);
  const run = owner.run();
  await entered.promise;
  provider.location = 'https://edited.invalid/guide';
  aliases.pairs[0]!.appChannelId = 'other-channel';
  aliases.pairs[0]!.providerId = 'different';
  aliases.pairs.length = 0;
  held.resolve({ ticket: 'reviewed-ticket', sourceRevision: 2 });
  expect((await run).connected).toBe(1);
  expect(committed).toBe(captured);
  expect(committed?.aliases?.pairs).toEqual([
    {
      catalogSourceId: 'saved-source',
      appChannelId: 'canonical-channel',
      providerId: 'PGATour.us@SD',
      xmltvChannelId: '5de94dacb394a300099fa22a',
    },
  ]);
  expect(Object.isFrozen(committed)).toBe(true);
  expect(Object.isFrozen(committed?.aliases)).toBe(true);
  expect(Object.isFrozen(committed?.aliases?.pairs)).toBe(true);
  expect(Object.isFrozen(committed?.aliases?.pairs[0])).toBe(true);
  await owner.dispose();
});
it('refuses a reviewed alias attached to a different provider URL before any preview', async () => {
  const f = fixture(0);
  f.host.capture = async () => ({
    catalogRevision: '7',
    channelCount: 1,
    providers: [
      {
        name: 'Edited provider',
        location: 'https://other.invalid/guide',
        allowHttp: false,
        aliases: reviewedAliases(),
      },
    ],
  });
  const owner = createAutomaticGuideBuilder(f.host);
  await expect(owner.run()).rejects.toThrow('alias scope is invalid');
  expect(f.calls).toEqual([]);
  await owner.dispose();
});

it('admits revision zero only for a tagged proposed preview', async () => {
  const f = fixture(1);
  f.host.preview = async () => ({ ticket: 'proposed', sourceRevision: 0, proposed: true });
  const owner = createAutomaticGuideBuilder(f.host);
  expect(await owner.run()).toMatchObject({ checked: 1, failed: 0, connected: 1 });
  expect(f.calls).toEqual(['commit:proposed:7']);
  await owner.dispose();
});
it.each([{ sourceRevision: 0 }, { sourceRevision: 1, proposed: true as const }])(
  'refuses contradictory proposal revision %j without publication',
  async (preview) => {
    const f = fixture(1);
    f.host.preview = async () => ({ ticket: 'invalid', ...preview });
    const owner = createAutomaticGuideBuilder(f.host);
    expect(await owner.run()).toMatchObject({ checked: 0, failed: 1, connected: 0 });
    expect(f.calls.every((call) => !call.startsWith('commit:'))).toBe(true);
    await owner.dispose();
  },
);
it('escalates automatic retry after consecutive failures and resets after success', async () => {
  const f = fixture(1);
  let clock = 1000,
    acquisitions = 0,
    fail = true;
  f.host.preview = async () => {
    acquisitions++;
    if (fail) throw new Error('Controlled failure');
    return { ticket: `ticket-${acquisitions}`, sourceRevision: 1 };
  };
  const owner = createAutomaticGuideBuilder(f.host, { now: () => clock });
  const attemptAt = async (advanceMs: number) => {
    clock += advanceMs;
    await owner.request();
    return acquisitions;
  };
  expect(await attemptAt(0)).toBe(1); // cooldown 1 min
  expect(await attemptAt(59_999)).toBe(1);
  expect(await attemptAt(1)).toBe(2); // cooldown 2 min
  expect(await attemptAt(60_000)).toBe(2);
  expect(await attemptAt(60_000)).toBe(3); // cooldown 4 min
  expect(await attemptAt(180_000)).toBe(3);
  fail = false;
  expect(await attemptAt(60_000)).toBe(4); // success forgets the failure history
  fail = true;
  expect(await attemptAt(1)).toBe(5);
  expect(await attemptAt(60_000)).toBe(6); // back to a 1 min first cooldown
  await owner.dispose();
});
it('passes validated catalog countries to the acquisition gate and refuses malformed codes', async () => {
  const f = fixture(1);
  const capture = f.host.capture;
  const seen: unknown[] = [];
  f.host.acquisitionAllowed = async (_provider, _signal, context) => {
    seen.push(context);
    return true;
  };
  f.host.capture = async (signal) => ({
    ...(await capture(signal)),
    catalogCountries: ['UK', 'US'],
  });
  const owner = createAutomaticGuideBuilder(f.host);
  await owner.request();
  expect(seen).toEqual([{ automatic: true, catalogCountries: ['UK', 'US'] }]);
  f.host.capture = async (signal) => ({ ...(await capture(signal)), catalogCountries: ['usa'] });
  await expect(owner.run()).rejects.toThrow('snapshot is invalid');
  await owner.dispose();
});
