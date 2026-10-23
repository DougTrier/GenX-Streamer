import { describe, expect, it, vi } from 'vitest';
import {
  collectSources,
  exactCandidateDedup,
  type SourceOperationResult,
} from '../../src/catalog/collector';
import type { ChannelCandidate } from '../../src/catalog/parser';
const candidate = (id: number): ChannelCandidate => ({
  sourceId: 'source-a',
  providerId: `provider-${id}`,
  name: `Channel ${id}`,
  category: 'News',
  urls: [`stream-${id}`],
});
const sources = (count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: `source-${index}` }));
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};
describe('exact candidate deduplication', () => {
  it('keeps every candidate beyond the legacy 400/5000 sampling limits', () => {
    const original = Array.from({ length: 5001 }, (_, index) => candidate(index));
    expect(exactCandidateDedup(original)).toEqual(original);
    expect(exactCandidateDedup(original)).toEqual(exactCandidateDedup(original));
  });
  it('deduplicates only identical complete metadata tuples within one source', () => {
    const a = candidate(1);
    const duplicate = {
      urls: [...a.urls],
      category: a.category,
      name: a.name,
      providerId: a.providerId,
      sourceId: a.sourceId,
    };
    const distinct = [
      { ...a, sourceId: 'source-b' },
      { ...a, providerId: 'different' },
      { ...a, category: 'Sports' },
      { ...a, name: 'CHANNEL 1' },
      { ...a, urls: ['alternate'] },
      { ...a, language: 'French' },
      { ...a, providerId: undefined },
    ];
    expect(exactCandidateDedup([a, duplicate, ...distinct])).toEqual([a, ...distinct]);
    expect(a.urls).toEqual(['stream-1']);
  });
  it('supports 100,000 entries and explicitly rejects overflow instead of truncating', () => {
    const maximum = Array.from({ length: 100_000 }, (_, index) => candidate(index));
    expect(exactCandidateDedup(maximum)).toHaveLength(100_000);
    expect(() => exactCandidateDedup([...maximum, candidate(100_000)])).toThrow('100,000');
    expect(() => exactCandidateDedup([{ ...candidate(1), name: 'x'.repeat(16_385) }])).toThrow(
      'size limit',
    );
  });
});
describe('configured source collection', () => {
  it('visits all 5001 configured sources and returns results in configured order', async () => {
    const input = sources(5001);
    const operation = vi.fn(async (source: (typeof input)[number]) => ({
      status: 'completed' as const,
      value: source.id,
    }));
    const first = await collectSources(input, operation, new AbortController().signal);
    expect(operation).toHaveBeenCalledTimes(5001);
    expect(first.map((result) => result.value)).toEqual(input.map((source) => source.id));
    expect(await collectSources(input, operation, new AbortController().signal)).toEqual(first);
  });
  it('keeps at most four requests in flight with independent failure results', async () => {
    const input = sources(13);
    let active = 0;
    let maximum = 0;
    const releases: Array<() => void> = [];
    const collection = collectSources(
      input,
      async (source) => {
        active++;
        maximum = Math.max(active, maximum);
        await new Promise<void>((resolve) => releases.push(resolve));
        active--;
        if (source.id === 'source-3') throw new Error('private-provider-location-secret');
        return { status: 'completed', value: source.id };
      },
      new AbortController().signal,
    );
    for (let batch = 0; batch < 4; batch++) {
      await flush();
      expect(active).toBeLessThanOrEqual(4);
      for (const release of releases.splice(0)) release();
    }
    const result = await collection;
    expect(maximum).toBe(4);
    expect(result.filter((item) => item.status === 'completed')).toHaveLength(12);
    expect(result[3]).toMatchObject({ sourceId: 'source-3', status: 'failed' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('waits for owned cancellation cleanup and suppresses all subsequent progress', async () => {
    const abort = new AbortController();
    const progress = vi.fn();
    let settled = false;
    let active = 0;
    const releases: Array<() => void> = [];
    const collection = collectSources(
      sources(10),
      async (_source, signal) => {
        active++;
        await new Promise<void>((resolve) => {
          signal.addEventListener('abort', () => releases.push(resolve), { once: true });
        });
        active--;
        return { status: 'completed', value: 'late uncommitted output' };
      },
      abort.signal,
      progress,
    ).then((result) => {
      settled = true;
      return result;
    });
    await flush();
    expect(active).toBe(4);
    abort.abort();
    await flush();
    expect(settled).toBe(false);
    expect(releases).toHaveLength(4);
    for (const release of releases) release();
    const result = await collection;
    expect(active).toBe(0);
    expect(result.every((item) => item.status === 'canceled')).toBe(true);
    expect(progress).not.toHaveBeenCalled();
  });
  it('preserves a completed atomic publication receipt when cancel happens during settlement', async () => {
    const abort = new AbortController();
    const result = await collectSources(
      sources(1),
      async () => {
        abort.abort();
        return { status: 'completed', value: 'durable revision', published: true };
      },
      abort.signal,
    );
    expect(result[0]).toMatchObject({ status: 'completed', value: 'durable revision' });
  });
  it('keeps independent superseding runs isolated without obsolete progress publication', async () => {
    const old = new AbortController();
    const oldProgress = vi.fn();
    let finish!: (value: SourceOperationResult<string>) => void;
    const previous = collectSources(
      sources(1),
      () =>
        new Promise<SourceOperationResult<string>>((resolve) => {
          finish = resolve;
        }),
      old.signal,
      oldProgress,
    );
    old.abort();
    const current = await collectSources(
      sources(1),
      async () => ({ status: 'completed', value: 'new' }),
      new AbortController().signal,
    );
    finish({ status: 'completed', value: 'obsolete' });
    const prior = await previous;
    expect(current[0]?.value).toBe('new');
    expect(prior[0]?.status).toBe('canceled');
    expect(oldProgress).not.toHaveBeenCalled();
  });
  it('does not silently add later configuration edits to an active collection', async () => {
    const input = sources(1);
    let release!: () => void;
    const result = collectSources(
      input,
      async (source) => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { status: 'completed', value: source.id };
      },
      new AbortController().signal,
    );
    input.push({ id: 'later-source' });
    release();
    expect(await result).toHaveLength(1);
  });
  it('waits for other operations to close when a progress subscriber fails', async () => {
    const result = collectSources(
      sources(4),
      async (source, signal) => {
        if (source.id !== 'source-0')
          await new Promise<void>((resolve) =>
            signal.addEventListener('abort', () => resolve(), { once: true }),
          );
        return { status: 'completed', value: source.id };
      },
      new AbortController().signal,
      () => {
        throw new Error('callback bug');
      },
    );
    await expect(result).rejects.toThrow('after resource cleanup');
  });
});
