import { describe, expect, it, vi } from 'vitest';
import { createArchiveDiscovery } from '../../src/application/archive-discovery';
import { createArchiveCatalog } from '../../src/platform/archive-catalog';
import type {
  ArchiveDiscoverReceipt,
  ArchiveDiscoverStep,
  ArchiveDiscoveryView,
  ArchiveProgress,
} from '../../src/platform/archive-catalog';
import type {
  PublicArchiveDiscoverRequest,
  PublicArchiveDiscoverReceipt,
} from '../../src/platform/archive-public-providers';

const english: ArchiveDiscoveryView = {
  schemaVersion: 1,
  languageMode: 'english',
  favoritesOnly: false,
  curatedOnly: false,
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
}
function fixture(yields: number[], change?: Partial<ArchiveDiscoverReceipt>) {
  let revision = 0,
    nextPage = 1,
    scope = 'root-A';
  const progress = vi.fn(async (): Promise<ArchiveProgress> => ({
    schemaVersion: 1,
    revision: String(revision),
    year: null,
    nextPage,
    complete: false,
    capacityReached: false,
    retryAfterMs: null,
    titleCount: 60,
  }));
  const discoverStep = vi.fn(
    async (request: ArchiveDiscoverStep): Promise<ArchiveDiscoverReceipt> => {
      expect(request.expectedRevision).toBe(String(revision));
      expect(request.page).toBe(nextPage);
      revision++;
      nextPage++;
      return {
        schemaVersion: 1,
        committed: true,
        revision: String(revision),
        year: null,
        page: request.page,
        nextPage,
        examined: 20,
        admitted: 1,
        excludedUnknownYear: 0,
        unavailable: 0,
        titleCount: 60,
        confirmedDead: 0,
        transientFailures: 0,
        capacityReached: false,
        retryAfterMs: null,
        rankingPolicy: 'archive-popularity-playable-v1',
        pendingFilePages: [],
        ...(request.view ? { newVisibleMatches: yields[request.page - 1] ?? 0 } : {}),
        ...change,
      };
    },
  );
  const committed = vi.fn();
  const host = { catalog: { progress, discoverStep }, readyScope: () => scope, committed };
  return { host, progress, discoverStep, committed, replaceRoot: () => (scope = 'root-B') };
}

describe('bounded Archive discovery visible yield', () => {
  it('continues past admitted duplicates and filtered items until page three adds a visible match', async () => {
    const f = fixture([0, 0, 1]);
    const owner = createArchiveDiscovery(f.host);
    expect(await owner.discover('Gilligan', undefined, 'continue', 1960, english)).toMatchObject({
      revision: '3',
      outcome: 'partial',
      examined: 60,
      admitted: 3,
    });
    expect(f.discoverStep).toHaveBeenCalledTimes(3);
    expect(f.discoverStep.mock.calls.map(([r]) => [r.page, r.decade, r.view])).toEqual([
      [1, 1960, english],
      [2, 1960, english],
      [3, 1960, english],
    ]);
    await owner.dispose();
  });
  it('stops on the first atomic newly visible match without sweeping further pages', async () => {
    const f = fixture([1, 1, 1]);
    const owner = createArchiveDiscovery(f.host);
    await owner.discover('Cartoon', undefined, 'search', null, english);
    expect(f.discoverStep).toHaveBeenCalledTimes(1);
    await owner.dispose();
  });
  it('keeps three pages/60 candidates per click and resumes the acknowledged fourth page', async () => {
    const f = fixture([0, 0, 0, 1]);
    const owner = createArchiveDiscovery(f.host);
    expect(await owner.discover('Cartoon', undefined, 'search', null, english)).toMatchObject({
      examined: 60,
      revision: '3',
    });
    expect(f.discoverStep).toHaveBeenCalledTimes(3);
    await owner.discover('Cartoon', undefined, 'continue', null, english);
    expect(f.discoverStep.mock.calls[3][0].page).toBe(4);
    await owner.dispose();
  });
  it('preserves legacy admission stopping and request/receipt shapes without a view', async () => {
    const f = fixture([0, 0, 1]);
    const owner = createArchiveDiscovery(f.host);
    await owner.discover('Gilligan');
    expect(f.discoverStep).toHaveBeenCalledTimes(1);
    expect(f.discoverStep.mock.calls[0][0]).not.toHaveProperty('view');
    expect(f.committed.mock.calls[0][0]).not.toHaveProperty('newVisibleMatches');
    await owner.dispose();
  });
  it('captures the view before queued work and does not observe later filter mutations', async () => {
    const f = fixture([1]);
    const gate = deferred<void>();
    const read = f.progress.getMockImplementation()!;
    f.progress.mockImplementation(async () => {
      await gate.promise;
      return read();
    });
    const view = { ...english };
    const owner = createArchiveDiscovery(f.host);
    const work = owner.discover('Gilligan', undefined, 'search', 1960, view);
    view.languageMode = 'all';
    view.favoritesOnly = true;
    gate.resolve();
    await work;
    expect(f.discoverStep.mock.calls[0][0].view).toEqual(english);
    await owner.dispose();
  });
  it.each(['transient', 'capacity', 'complete'] as const)(
    'keeps the %s terminal gate before another page',
    async (kind) => {
      const change =
        kind === 'transient'
          ? { transientFailures: 1, retryAfterMs: 100_000, nextPage: 1 }
          : kind === 'capacity'
            ? { capacityReached: true }
            : { nextPage: null };
      const f = fixture([0], change);
      const owner = createArchiveDiscovery({ ...f.host, now: () => 1 });
      const result = await owner.discover('Cartoon', undefined, 'search', null, english);
      expect(result.outcome).toBe(kind === 'transient' ? 'waiting' : kind);
      expect(f.discoverStep).toHaveBeenCalledTimes(1);
      await owner.dispose();
    },
  );
  it('retains a late committed receipt but does not continue after cancellation', async () => {
    const f = fixture([0, 1]);
    const cancel = new AbortController();
    f.committed.mockImplementation(() => cancel.abort());
    const owner = createArchiveDiscovery(f.host);
    expect(await owner.discover('Cartoon', cancel.signal, 'search', null, english)).toMatchObject({
      outcome: 'canceled',
      revision: '1',
    });
    expect(f.discoverStep).toHaveBeenCalledTimes(1);
    expect(f.committed).toHaveBeenCalledTimes(1);
    await owner.dispose();
  });
  it('does not publish a completed step into a replaced storage root', async () => {
    const f = fixture([0]);
    const run = f.discoverStep.getMockImplementation()!;
    f.discoverStep.mockImplementation(async (request) => {
      const receipt = await run(request);
      f.replaceRoot();
      return receipt;
    });
    const owner = createArchiveDiscovery(f.host);
    expect(await owner.discover('Cartoon', undefined, 'search', null, english)).toMatchObject({
      outcome: 'canceled',
      revision: '1',
    });
    expect(f.committed).not.toHaveBeenCalled();
    expect(f.discoverStep).toHaveBeenCalledTimes(1);
    await owner.dispose();
  });
  it('fails closed when a native response omits the requested view-aware capability', async () => {
    const f = fixture([0], { newVisibleMatches: undefined });
    const owner = createArchiveDiscovery(f.host);
    await expect(owner.discover('Cartoon', undefined, 'search', null, english)).rejects.toThrow(
      'Archive discovery stopped',
    );
    expect(f.discoverStep).toHaveBeenCalledTimes(1);
    await owner.dispose();
  });
  it('reloads a refused CAS once without retrying discovery or guessing a cursor', async () => {
    const f = fixture([0]);
    f.discoverStep.mockRejectedValue(new Error('archive-revision-stale'));
    const owner = createArchiveDiscovery(f.host);
    await expect(owner.discover('Cartoon', undefined, 'search', null, english)).rejects.toThrow(
      'Archive discovery stopped',
    );
    expect(f.discoverStep).toHaveBeenCalledTimes(1);
    expect(f.progress).toHaveBeenCalledTimes(2);
    expect(f.committed).not.toHaveBeenCalled();
    await owner.dispose();
  });
  it('does not expand blank curation into modern browse decades', async () => {
    const f = fixture([1]);
    const owner = createArchiveDiscovery(f.host);
    await expect(owner.discover('', undefined, 'search', 2020)).rejects.toThrow(
      'curation covers 1960 through 1999',
    );
    expect(f.progress).not.toHaveBeenCalled();
    expect(f.discoverStep).not.toHaveBeenCalled();
    await owner.dispose();
  });
});

describe('independent public archive acquisition', () => {
  it.each(['archive-network-unavailable', 'archive-database-failed'])(
    'preserves public matches across a known network failure without masking %s',
    async (failure) => {
      const f = fixture([]);
      let revision = '0';
      const progress = f.progress.getMockImplementation()!;
      f.progress.mockImplementation(async () => ({ ...(await progress()), revision }));
      const native = createArchiveCatalog({
        invoke: async () => {
          throw failure;
        },
      });
      const owner = createArchiveDiscovery({
        ...f.host,
        catalog: {
          progress: f.progress,
          discoverStep: (r, s) => native.discoverStep(r, s),
          publicDiscoverStep: async () => {
            revision = '1';
            return publicReceipt('1', 3, 1);
          },
        },
      });
      if (failure === 'archive-network-unavailable')
        expect(await owner.discover('Moon', undefined, 'search', null, english)).toMatchObject({
          revision: '1',
          outcome: 'waiting',
          admitted: 1,
        });
      else
        await expect(owner.discover('Moon', undefined, 'search', null, english)).rejects.toThrow(
          'Archive discovery stopped',
        );
      expect(owner.snapshot.admitted).toBe(1);
      await owner.dispose();
    },
  );
  function publicReceipt(
    revision: string,
    examined = 0,
    admitted = 0,
  ): PublicArchiveDiscoverReceipt {
    return {
      schemaVersion: 1,
      committed: true,
      revision,
      examined,
      admitted,
      more: true,
      providers: [
        {
          providerId: 'loc',
          state: 'partial',
          examined: examined / 3,
          admitted,
          retryAfterMs: null,
          reason: null,
        },
        {
          providerId: 'nasa',
          state: 'partial',
          examined: examined / 3,
          admitted: 0,
          retryAfterMs: null,
          reason: null,
        },
        {
          providerId: 'commons',
          state: 'waiting',
          examined: examined / 3,
          admitted: 0,
          retryAfterMs: 1000,
          reason: 'public-contact-required',
        },
      ],
    };
  }
  it('checks other providers even after IA is complete and reads the committed revision', async () => {
    const f = fixture([]);
    let revision = '2';
    f.progress.mockImplementation(async () => ({
      schemaVersion: 1,
      revision,
      year: null,
      nextPage: 3,
      complete: true,
      capacityReached: false,
      retryAfterMs: null,
      titleCount: 60,
    }));
    const publicStep = vi.fn(async (request: PublicArchiveDiscoverRequest) => {
      expect(request).toMatchObject({
        expectedRevision: '2',
        explicitAction: true,
        query: 'Moon',
        languageMode: 'english',
      });
      revision = '3';
      return publicReceipt('3', 3, 1);
    });
    const committed = vi.fn();
    const owner = createArchiveDiscovery({
      ...f.host,
      catalog: { ...f.host.catalog, publicDiscoverStep: publicStep },
      publicCommitted: committed,
    });
    expect(await owner.discover('Moon', undefined, 'search', null, english)).toMatchObject({
      revision: '3',
      examined: 3,
      admitted: 1,
      outcome: 'partial',
    });
    expect(publicStep).toHaveBeenCalledTimes(1);
    expect(committed).toHaveBeenCalledTimes(1);
    expect(f.discoverStep).not.toHaveBeenCalled();
    await owner.dispose();
  });
  it('reserves the public-source budget and keeps each explicit search under60 candidates', async () => {
    const f = fixture([0, 0, 1]);
    const publicStep = vi.fn(async (r: PublicArchiveDiscoverRequest) =>
      publicReceipt(r.expectedRevision, 12),
    );
    const owner = createArchiveDiscovery({
      ...f.host,
      catalog: { ...f.host.catalog, publicDiscoverStep: publicStep },
    });
    expect(await owner.discover('Moon', undefined, 'search', null, english)).toMatchObject({
      examined: 52,
      revision: '2',
    });
    expect(f.discoverStep).toHaveBeenCalledTimes(2);
    await owner.discover('Moon', undefined, 'continue', null, english);
    expect(publicStep.mock.calls[1][0].expectedRevision).toBe('2');
    expect(f.discoverStep.mock.calls[2][0].page).toBe(3);
    await owner.dispose();
  });
  it('captures a late public COMMIT before cancellation without starting IA', async () => {
    const f = fixture([]),
      cancel = new AbortController();
    const publicStep = vi.fn(async () => publicReceipt('1', 3, 1));
    const owner = createArchiveDiscovery({
      ...f.host,
      catalog: { ...f.host.catalog, publicDiscoverStep: publicStep },
      publicCommitted: () => cancel.abort(),
    });
    expect(await owner.discover('Moon', cancel.signal, 'search', null, english)).toMatchObject({
      outcome: 'canceled',
      revision: '1',
      admitted: 1,
    });
    expect(f.discoverStep).not.toHaveBeenCalled();
    await owner.dispose();
  });
  it('never acquires new public results from a Favorites-only search', async () => {
    const f = fixture([1]),
      publicStep = vi.fn(async () => publicReceipt('0'));
    const owner = createArchiveDiscovery({
      ...f.host,
      catalog: { ...f.host.catalog, publicDiscoverStep: publicStep },
    });
    await owner.discover('Moon', undefined, 'search', null, { ...english, favoritesOnly: true });
    expect(publicStep).not.toHaveBeenCalled();
    await owner.dispose();
  });
});
