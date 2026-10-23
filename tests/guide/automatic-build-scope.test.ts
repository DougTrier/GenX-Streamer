import { expect, it, vi } from 'vitest';
import {
  createAutomaticGuideBuilder,
  type AutomaticGuideBuildHost,
} from '../../src/guide/automatic-build';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}
function fixture(count: number, allCached = false) {
  const caches = new Set<string>();
  const published: string[] = [];
  const connections: { published: number; revision: string }[] = [];
  let revision = '7',
    scope = true,
    allowed = true;
  const providers = Array.from({ length: count }, (_, i) => ({
    name: `Guide ${i}`,
    location: `https://fixture.invalid/${i}.xml`,
    allowHttp: false,
  }));
  if (allCached) providers.forEach((provider) => caches.add(provider.location));
  const host: AutomaticGuideBuildHost = {
    capture: vi.fn(async () => ({ catalogRevision: revision, channelCount: 1, providers })),
    isCurrent: () => false, // Catalog advancement is not a permission change.
    isScopeCurrent: () => scope,
    canRun: () => allowed,
    cacheReady: async (provider) => caches.has(provider.location),
    preview: vi.fn(async (provider) => ({ ticket: provider.location, sourceRevision: 1 })),
    publishCache: async (_preview, provider) => {
      caches.add(provider.location);
      published.push(provider.location);
    },
    connectScopeLatest: vi.fn(async () => {
      connections.push({ published: published.length, revision });
      return { catalogRevision: revision, matched: 1, unmatched: 0 };
    }),
    connectLatest: vi.fn(async () => {
      throw new Error('legacy-subset-must-not-run');
    }),
    commitMatched: vi.fn(async () => {
      throw new Error('legacy-publication-must-not-run');
    }),
    discard: vi.fn(async () => undefined),
  };
  return {
    host,
    caches,
    published,
    connections,
    revision(value: string) {
      revision = value;
    },
    scope(value: boolean) {
      scope = value;
    },
    allowed(value: boolean) {
      allowed = value;
    },
  };
}
it.each([101, 1000])(
  'connects all %i retained caches once without downloading or per-provider matching',
  async (count) => {
    const f = fixture(count, true),
      owner = createAutomaticGuideBuilder(f.host);
    expect(await owner.run()).toMatchObject({ checked: count, connected: 1 });
    expect(f.host.capture).toHaveBeenCalledOnce();
    expect(f.host.connectScopeLatest).toHaveBeenCalledOnce();
    expect(f.host.preview).not.toHaveBeenCalled();
    expect(f.host.connectLatest).not.toHaveBeenCalled();
    await owner.dispose();
  },
);
it('connects retained scope and progressively exposes new caches within four publications under a request storm', async () => {
  const f = fixture(101),
    held = deferred<void>(),
    entered = deferred<void>();
  const preview = f.host.preview;
  f.host.preview = async (provider, signal) => {
    if (provider.name === 'Guide 0') {
      entered.resolve();
      await held.promise;
    }
    return preview(provider, signal);
  };
  const owner = createAutomaticGuideBuilder(f.host),
    work = owner.request();
  await entered.promise;
  expect(f.connections).toEqual([{ published: 0, revision: '7' }]);
  f.revision('88');
  for (let i = 0; i < 500; i++) expect(owner.request()).toBe(work);
  held.resolve();
  await work;
  const published = f.connections.map((connection) => connection.published);
  expect(published.slice(0, 2)).toEqual([0, 1]);
  expect(published.at(-1)).toBe(101);
  expect(
    published.every(
      (value, index) =>
        index === 0 || (value > published[index - 1]! && value - published[index - 1]! <= 4),
    ),
  ).toBe(true);
  expect(f.connections.at(-1)?.revision).toBe('88');
  expect(f.host.capture).toHaveBeenCalledOnce();
  expect(f.published).toHaveLength(101);
  await owner.dispose();
});
it('requests arriving during final connection cause a later cached pass without duplicate acquisition', async () => {
  const f = fixture(2),
    held = deferred<void>(),
    entered = deferred<void>();
  const connect = f.host.connectScopeLatest!;
  let calls = 0;
  f.host.connectScopeLatest = async (signal) => {
    calls++;
    const receipt = await connect(signal);
    if (calls === 3) {
      entered.resolve();
      await held.promise;
    }
    return receipt;
  };
  const owner = createAutomaticGuideBuilder(f.host),
    work = owner.request();
  await entered.promise;
  f.revision('99');
  owner.request();
  held.resolve();
  await work;
  expect(f.host.capture).toHaveBeenCalledTimes(2);
  expect(f.published).toHaveLength(2);
  expect(f.connections.at(-1)?.revision).toBe('99');
  await owner.dispose();
});
it.each(['cancel', 'permission', 'lifecycle'] as const)(
  'joins held acquisition on %s without a late final connection and retains published caches',
  async (reason) => {
    const f = fixture(2),
      held = deferred<void>(),
      entered = deferred<void>();
    const preview = f.host.preview;
    f.host.preview = async (provider, signal) => {
      if (provider.name === 'Guide 1') {
        entered.resolve();
        await held.promise;
      }
      return preview(provider, signal);
    };
    const owner = createAutomaticGuideBuilder(f.host),
      work = owner.run();
    const refused = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await entered.promise;
    if (reason === 'permission') f.scope(false);
    if (reason === 'lifecycle') f.allowed(false);
    let joined = false;
    const suspended = owner.suspend().then(() => {
      joined = true;
    });
    await Promise.resolve();
    expect(joined).toBe(false);
    held.resolve();
    await suspended;
    await refused;
    expect(f.caches.size).toBe(1);
    expect(f.connections.map((connection) => connection.published)).toEqual([0, 1]);
    expect(f.host.discard).toHaveBeenCalledTimes(1);
    await owner.dispose();
  },
);
it('failed full-scope connection retains dirty progress for final retry without fabricated matches', async () => {
  const f = fixture(2),
    connect = f.host.connectScopeLatest!;
  let calls = 0;
  f.host.connectScopeLatest = async (signal) => {
    if (++calls === 2) throw new Error('controlled-catalog-CAS-refusal');
    return connect(signal);
  };
  const owner = createAutomaticGuideBuilder(f.host);
  expect(await owner.run()).toMatchObject({ checked: 2, connected: 2, failed: 1 });
  expect(calls).toBe(3);
  expect(f.caches.size).toBe(2);
  await owner.dispose();
});
it('a rejected initial connection is retryable and does not begin downloads or fabricate acknowledgement', async () => {
  const f = fixture(101, true),
    connect = f.host.connectScopeLatest!;
  f.host.connectScopeLatest = vi
    .fn()
    .mockRejectedValueOnce(new Error('CAS'))
    .mockImplementation(connect);
  const owner = createAutomaticGuideBuilder(f.host);
  await expect(owner.request()).rejects.toThrow('CAS');
  expect(f.host.preview).not.toHaveBeenCalled();
  await owner.request();
  expect(f.connections).toHaveLength(1);
  expect(f.host.capture).toHaveBeenCalledTimes(2);
  await owner.dispose();
});

it('close joins a held first-cache connection and preserves its cancellation uncertainty', async () => {
  const f = fixture(1);
  const entered = deferred<void>();
  const held = deferred<void>();
  const cancellation = deferred<void>();
  let calls = 0;
  let operationSettled = false;
  const failure = new Error('Program guide cancellation could not be confirmed.');
  f.host.connectScopeLatest = async () => {
    if (++calls === 1) return { catalogRevision: '7', matched: 0, unmatched: 1 };
    entered.resolve();
    await held.promise;
    await cancellation.promise;
    operationSettled = true;
    throw failure;
  };
  const owner = createAutomaticGuideBuilder(f.host);
  const work = owner.request();
  const operation = expect(work).rejects.toBe(failure);
  await entered.promise;
  let cleanupSettled = false;
  const cleanup = owner.dispose().finally(() => {
    cleanupSettled = true;
  });
  const refusal = expect(cleanup).rejects.toBe(failure);
  held.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(operationSettled).toBe(false);
  expect(cleanupSettled).toBe(false);
  cancellation.resolve();
  await operation;
  await refusal;
  expect(operationSettled).toBe(true);
  expect(f.published).toHaveLength(1);
  expect(f.host.discard).not.toHaveBeenCalled();
  expect(f.connections).toHaveLength(0);
});
it('source/provider/removal scope drift during preview refuses publication without requiring lifecycle cancellation', async () => {
  const f = fixture(1),
    held = deferred<void>(),
    entered = deferred<void>();
  f.host.preview = async (provider) => {
    entered.resolve();
    await held.promise;
    return { ticket: provider.location, sourceRevision: 1 };
  };
  const owner = createAutomaticGuideBuilder(f.host),
    work = owner.run();
  const refused = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  await entered.promise;
  f.scope(false);
  held.resolve();
  await refused;
  expect(f.caches.size).toBe(0);
  expect(f.connections).toHaveLength(1);
  expect(f.host.discard).toHaveBeenCalledOnce();
  await owner.dispose();
});
it('reports preserved conflicts separately from unmapped ambiguity without selecting or rewriting a target', async () => {
  const f = fixture(2),
    mappings = Object.freeze({ saved: 'guide-a' });
  f.host.connectScopeLatest = async () => ({
    catalogRevision: '7',
    matched: 0,
    unmatched: 2,
    ambiguous: 1,
    mappingConflictAssessment: 'complete',
    preservedMappingConflicts: f.caches.size > 1 ? 1 : 0,
  });
  const owner = createAutomaticGuideBuilder(f.host);
  expect(await owner.run()).toMatchObject({
    unmappedAmbiguous: 1,
    mappingConflictAssessment: 'complete',
    preservedMappingConflicts: 1,
  });
  expect(mappings).toEqual({ saved: 'guide-a' });
  expect(f.host.commitMatched).not.toHaveBeenCalled();
  await owner.dispose();
});
it('old or bounded-unassessed receipts never imply zero preserved conflicts', async () => {
  const f = fixture(1, true),
    owner = createAutomaticGuideBuilder(f.host);
  expect(await owner.run()).toMatchObject({
    unmappedAmbiguous: null,
    mappingConflictAssessment: 'not-assessed',
    preservedMappingConflicts: null,
  });
  f.host.connectScopeLatest = async () => ({
    catalogRevision: '7',
    matched: 0,
    unmatched: 1,
    ambiguous: 1,
    mappingConflictAssessment: 'not-assessed',
    preservedMappingConflicts: null,
  });
  expect(await owner.run()).toMatchObject({
    unmappedAmbiguous: 1,
    mappingConflictAssessment: 'not-assessed',
    preservedMappingConflicts: null,
  });
  await owner.dispose();
});
it.each([
  { mappingConflictAssessment: 'complete', preservedMappingConflicts: null },
  { mappingConflictAssessment: 'not-assessed', preservedMappingConflicts: 0 },
  { preservedMappingConflicts: 1 },
  { ambiguous: 2 },
  { mappingConflictAssessment: 'complete', preservedMappingConflicts: -1 },
])(
  'refuses malformed conflict receipts without acquisition or fabricated status: %j',
  async (fields) => {
    const f = fixture(1);
    f.host.connectScopeLatest = async () =>
      ({ catalogRevision: '7', matched: 0, unmatched: 1, ...fields }) as Awaited<
        ReturnType<NonNullable<AutomaticGuideBuildHost['connectScopeLatest']>>
      >;
    const owner = createAutomaticGuideBuilder(f.host);
    await expect(owner.run()).rejects.toThrow('receipt is invalid');
    expect(f.host.preview).not.toHaveBeenCalled();
    await owner.dispose();
  },
);
