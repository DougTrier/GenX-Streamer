import { describe, expect, it, vi } from 'vitest';
import {
  createCollectionPipeline,
  stagePipelineSelection,
  type PipelineDependencies,
  type PipelineOptions,
  type PipelineTimer,
  type ProbeResult,
} from '../../src/discovery/pipeline';
import type { ReviewCandidate, ScanSource } from '../../src/discovery/scan';
import type { ParsedPlaylist } from '../../src/catalog/parser';
const source = (id = 'a'): ScanSource => ({
  source: { id, name: id, kind: 'url', location: `https://fixture.invalid/${id}` },
  fingerprint: `fingerprint-${id}`,
});
const playlist = (id = 'a', count = 2): ParsedPlaylist => ({
  channels: Array.from({ length: count }, (_, index) => ({
    sourceId: id,
    name: `Channel ${index}`,
    category: 'News',
    urls: [`https://fixture.invalid/${id}/${index}`],
  })),
  warnings: [],
});
const probe = (candidate: ReviewCandidate): ProbeResult => ({
  candidateKey: candidate.key,
  sourceId: candidate.sourceId,
  sourceFingerprint: candidate.sourceFingerprint,
  platform: 'Windows',
  evidence: { kind: 'recognized-media-response' },
});
const options = (patch: Partial<PipelineOptions> = {}): PipelineOptions => ({
  sources: [source()],
  guides: [{ id: 'guide', fingerprint: 'guide-revision' }],
  query: '',
  platform: 'Windows',
  checks: 'all',
  deadlineMs: 20_000,
  ...patch,
});
const dependencies = (patch: Partial<PipelineDependencies> = {}): PipelineDependencies => ({
  collect: async (s) => playlist(s.id),
  probe: async (c) => probe(c),
  enrich: async (c, guides) =>
    guides.map((g) => ({
      candidateKey: c.key,
      guideSourceId: g.id,
      guideChannelId: 'xml',
      status: 'suggested',
    })),
  revision: () => 'catalog-1',
  now: () => 100,
  ...patch,
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await Promise.resolve();
  expect(check()).toBe(true);
}
function manualTimer() {
  let fire: (() => void) | null = null;
  const clear = vi.fn(() => {
    fire = null;
  });
  const timer: PipelineTimer = {
    set: (callback) => {
      fire = callback;
      return 0;
    },
    clear,
  };
  return { timer, clear, fire: () => fire?.() };
}
describe('owned read-only collection/check/enrichment jobs', () => {
  it('handles reentrant cancel from a newly started reader without acknowledging unfinished cleanup', async () => {
    const gate = deferred<ParsedPlaylist>();
    let acknowledged = false;
    let canceling: Promise<void> | undefined;
    const job = createCollectionPipeline(
      dependencies({
        collect: async () => {
          canceling = job.cancel().then(() => {
            acknowledged = true;
          });
          return gate.promise;
        },
      }),
    );
    const pending = job.run(options());
    await until(() => canceling !== undefined);
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    gate.resolve(playlist());
    const review = await pending;
    await canceling;
    expect(acknowledged).toBe(true);
    expect(review.status).toBe('canceled');
  });
  it('settles safely when a timer cleanup adapter fails instead of leaving cancel pending', async () => {
    const job = createCollectionPipeline(
      dependencies({
        timer: {
          set: () => undefined,
          clear: () => {
            throw new Error('https://private.invalid');
          },
        },
      }),
    );
    const review = await job.run(options());
    expect(review.status).toBe('failed');
    expect(review.publishable).toBe(false);
    expect(review.error).toContain('cleanup');
    expect(review.error).not.toContain('private');
    await job.cancel();
  });
  it('runs every phase with stable results and at most four probes/enrichments', async () => {
    let active = 0;
    let maximum = 0;
    const phases: string[] = [];
    const job = createCollectionPipeline(
      dependencies({
        collect: async (s) => playlist(s.id, 12),
        probe: async (c) => {
          active++;
          maximum = Math.max(maximum, active);
          await Promise.resolve();
          active--;
          return probe(c);
        },
      }),
    );
    const result = await job.run(options({ progress: (p) => phases.push(p.phase) }));
    expect(maximum).toBe(4);
    expect([...new Set(phases)]).toEqual(['collect', 'check', 'enrich', 'review']);
    expect(result.status).toBe('review');
    expect(result.publishable).toBe(true);
    expect(result.observations.map((o) => o.channelId)).toEqual(
      result.scan.candidates.map((c) => c.key),
    );
    expect(result.enrichment).toHaveLength(12);
    expect(result.allNotCheckedKeys).toEqual([]);
    expect(result.unenrichedKeys).toEqual([]);
    const staged = stagePipelineSelection(result, [result.scan.candidates[0].key], 'catalog-1');
    expect(staged.sources[0].candidates).toHaveLength(1);
    expect(result.observations.every((o) => o.verdict === 'Reachable')).toBe(true); // Controlled evidence is not decoder or hardware proof.
  });
  it('keeps failed sources, contextual failures and unselected candidates without deleting anything', async () => {
    const collect = vi.fn(async (s: { id: string }) => {
      if (s.id === 'b') throw new Error('https://private.invalid/token');
      return playlist(s.id);
    });
    const job = createCollectionPipeline(
      dependencies({
        collect,
        probe: async (c) => ({
          ...probe(c),
          evidence:
            c.channel.name === 'Channel 0' ? { kind: 'http', status: 403 } : { kind: 'timeout' },
        }),
      }),
    );
    const review = await job.run(
      options({
        sources: [source('a'), source('b')],
        checks: ['catalog-1:0:0'],
        expectedCandidates: [
          {
            key: 'catalog-1:0:0',
            sourceId: 'a',
            sourceFingerprint: 'fingerprint-a',
            sessionRevision: 'catalog-1',
            channel: playlist().channels[0],
          },
        ],
      }),
    );
    expect(review.scan.sources[1].status).toBe('failed');
    expect(JSON.stringify(review.scan.sources)).not.toContain('private');
    expect(review.observations[0].verdict).toBe('AccessDenied');
    expect(review.allNotCheckedKeys).toEqual(['catalog-1:0:1']);
    expect(stagePipelineSelection(review, ['catalog-1:0:0'], 'catalog-1').failedSourceIds).toEqual([
      'b',
    ]);
  });
  it('reports oversize checks explicitly and permits a later finite selection without sampling', async () => {
    const inspect = vi.fn(async (c: ReviewCandidate) => probe(c));
    const enrich = vi.fn(dependencies().enrich);
    const job = createCollectionPipeline(
      dependencies({ collect: async () => playlist('a', 1001), probe: inspect, enrich }),
    );
    const first = await job.run(options());
    expect(first.status).toBe('requires-selection');
    expect(first.publishable).toBe(false);
    expect(first.scan.candidates).toHaveLength(1001);
    expect(first.allNotCheckedKeys).toHaveLength(1001);
    expect(inspect).not.toHaveBeenCalled();
    expect(enrich).not.toHaveBeenCalled();
    expect(() => stagePipelineSelection(first, [], 'catalog-1')).toThrow('incomplete');
    const second = await job.run(
      options({
        checks: [first.scan.candidates[1000].key],
        expectedCandidates: [first.scan.candidates[1000]],
      }),
    );
    expect(second.status).toBe('review');
    expect(inspect).toHaveBeenCalledTimes(1);
    expect(second.allNotCheckedKeys).toHaveLength(1000);
  });
  it('rejects changed reviewed candidate tuples before any probe or enrichment', async () => {
    const inspect = vi.fn(async (c: ReviewCandidate) => probe(c));
    const enrich = vi.fn(dependencies().enrich);
    let changed = false;
    const job = createCollectionPipeline(
      dependencies({
        collect: async () => {
          const parsed = playlist();
          if (changed) parsed.channels.reverse();
          return parsed;
        },
        probe: inspect,
        enrich,
      }),
    );
    const initial = await job.run(options({ checks: [] }));
    changed = true;
    const review = await job.run(
      options({
        checks: [initial.scan.candidates[0].key],
        expectedCandidates: [initial.scan.candidates[0]],
      }),
    );
    expect(review.status).toBe('stale');
    expect(review.publishable).toBe(false);
    expect(review.scan.status).toBe('canceled');
    expect(inspect).not.toHaveBeenCalled();
    expect(enrich).not.toHaveBeenCalled();
  });
  it('requires exact selected snapshots before starting collection', async () => {
    const collect = vi.fn(dependencies().collect);
    const job = createCollectionPipeline(dependencies({ collect }));
    expect(() => job.run(options({ checks: ['catalog-1:0:0'] }))).toThrow('snapshots');
    expect(collect).not.toHaveBeenCalled();
  });
  it.each(['candidateKey', 'sourceId', 'sourceFingerprint', 'platform'] as const)(
    'refuses health identity mismatch in %s',
    async (field) => {
      const job = createCollectionPipeline(
        dependencies({ probe: async (c) => ({ ...probe(c), [field]: 'wrong' }) }),
      );
      const review = await job.run(options());
      expect(review.status).toBe('failed');
      expect(review.observations).toEqual([]);
      expect(review.scan.status).toBe('canceled');
      expect(() => stagePipelineSelection(review, [], 'catalog-1')).toThrow();
    },
  );
  it('reclassifies evidence and rejects raw extra evidence fields', async () => {
    const fabricated = createCollectionPipeline(
      dependencies({
        probe: async (c) => ({
          ...probe(c),
          verdict: 'PlayedHere',
          evidence: { kind: 'http', status: 403 },
        }),
      }),
    );
    expect((await fabricated.run(options())).observations[0].verdict).toBe('AccessDenied');
    const leaking = createCollectionPipeline(
      dependencies({
        probe: async (c) =>
          ({
            ...probe(c),
            evidence: { kind: 'network-failure', url: 'https://private.invalid' },
          }) as ProbeResult,
      }),
    );
    const result = await leaking.run(options());
    expect(result.status).toBe('failed');
    expect(JSON.stringify(result.observations)).not.toContain('private');
    expect(result.error).not.toContain('private');
  });
  it('admits only registered guide outcomes and does not choose an ambiguous target', async () => {
    const missing = createCollectionPipeline(
      dependencies({
        enrich: async (c) => [
          {
            candidateKey: c.key,
            guideSourceId: 'unregistered',
            status: 'suggested',
            guideChannelId: 'xml',
          },
        ],
      }),
    );
    expect((await missing.run(options())).status).toBe('failed');
    const ambiguous = createCollectionPipeline(
      dependencies({
        enrich: async (c) => [{ candidateKey: c.key, guideSourceId: 'guide', status: 'ambiguous' }],
      }),
    );
    const review = await ambiguous.run(options());
    expect(review.status).toBe('review');
    expect(review.enrichment.every((e) => e.guideChannelId === undefined)).toBe(true);
    const choosing = createCollectionPipeline(
      dependencies({
        enrich: async (c) => [
          {
            candidateKey: c.key,
            guideSourceId: 'guide',
            status: 'ambiguous',
            guideChannelId: 'xml',
          },
        ],
      }),
    );
    expect((await choosing.run(options())).status).toBe('failed');
  });
  it('waits for ignored probe abort to settle and discards its late result', async () => {
    const gate = deferred<ProbeResult>();
    let started: ReviewCandidate | null = null;
    const progress = vi.fn();
    const job = createCollectionPipeline(
      dependencies({
        collect: async () => playlist('a', 1),
        probe: async (c) => {
          started = c;
          return gate.promise;
        },
      }),
    );
    const pending = job.run(options({ progress }));
    await until(() => started !== null);
    let acknowledged = false;
    const canceled = job.cancel().then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    const events = progress.mock.calls.length;
    gate.resolve(probe(started!));
    await canceled;
    const result = await pending;
    expect(result.status).toBe('canceled');
    expect(result.observations).toEqual([]);
    expect(progress.mock.calls).toHaveLength(events);
    expect(result.publishable).toBe(false);
  });
  it('owns a whole-job deadline and joins source cleanup before acknowledging expiry', async () => {
    const clock = manualTimer();
    const gate = deferred<ParsedPlaylist>();
    let started = false;
    let aborted = false;
    const job = createCollectionPipeline(
      dependencies({
        timer: clock.timer,
        collect: async (_s, signal) => {
          started = true;
          signal.addEventListener(
            'abort',
            () => {
              aborted = true;
            },
            { once: true },
          );
          return gate.promise;
        },
      }),
    );
    let settled = false;
    const pending = job.run(options()).then((review) => {
      settled = true;
      return review;
    });
    await until(() => started);
    clock.fire();
    expect(aborted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    gate.resolve(playlist());
    const result = await pending;
    expect(result.status).toBe('canceled');
    expect(result.error).toContain('deadline');
    expect(clock.clear).toHaveBeenCalledWith(0);
  });
  it('rejects a stale catalog after enrichment and prevents nested scan publication', async () => {
    let revision = 'catalog-1';
    const gate = deferred<[]>();
    let started = false;
    const job = createCollectionPipeline(
      dependencies({
        revision: () => revision,
        enrich: async () => {
          started = true;
          return gate.promise;
        },
      }),
    );
    const pending = job.run(options());
    await until(() => started);
    revision = 'catalog-2';
    gate.resolve([]);
    const review = await pending;
    expect(review.status).toBe('stale');
    expect(review.enrichment).toEqual([]);
    expect(review.scan.status).toBe('canceled');
    revision = 'catalog-1';
    expect(() => stagePipelineSelection(review, [], 'catalog-1')).toThrow('obsolete');
  });
  it('supersedes an owned run only after its dependencies settle, preserving the next input snapshot', async () => {
    const gate = deferred<ParsedPlaylist>();
    const locations: string[] = [];
    let calls = 0;
    const job = createCollectionPipeline(
      dependencies({
        collect: async (s) => {
          locations.push(s.location);
          calls++;
          return calls === 1 ? gate.promise : playlist(s.id);
        },
      }),
    );
    const first = job.run(options());
    await until(() => calls === 1);
    const nextOptions = options();
    const second = job.run(nextOptions);
    expect(() => job.run(options())).toThrow('already restarting');
    nextOptions.sources[0].source.location = 'https://changed.invalid';
    await Promise.resolve();
    expect(calls).toBe(1);
    gate.resolve(playlist());
    expect((await first).status).toBe('canceled');
    expect((await second).status).toBe('review');
    expect(locations).toEqual(['https://fixture.invalid/a', 'https://fixture.invalid/a']);
  });
  it('refuses invalid scopes before starting readers and redacts dependency failures', async () => {
    const collect = vi.fn(dependencies().collect);
    const job = createCollectionPipeline(
      dependencies({
        collect,
        enrich: async () => {
          throw new Error('https://private.invalid');
        },
        probe: async () => {
          throw new Error('https://private.invalid');
        },
      }),
    );
    expect(() =>
      job.run(options({ sources: Array.from({ length: 101 }, (_, i) => source(String(i))) })),
    ).toThrow('scope');
    expect(collect).not.toHaveBeenCalled();
    const review = await job.run(options());
    expect(review.status).toBe('review');
    expect(review.observations[0].verdict).toBe('TemporaryUnavailable');
    expect(review.enrichment[0].status).toBe('unavailable');
    expect(JSON.stringify(review.observations)).not.toContain('private');
  });
});
