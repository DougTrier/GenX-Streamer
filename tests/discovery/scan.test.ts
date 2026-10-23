import { describe, expect, it, vi } from 'vitest';
import {
  scanConfiguredSources,
  stageScanSelection,
  scanReconciliationScopes,
  type ScanSource,
} from '../../src/discovery/scan';
import type { ChannelCandidate, ParsedPlaylist } from '../../src/catalog/parser';
const source = (id: string): ScanSource => ({
  source: { id, name: id, kind: 'url', location: `https://fixture.invalid/${id}` },
  fingerprint: `revision-${id}`,
});
const candidate = (sourceId: string, index = 0): ChannelCandidate => ({
  sourceId,
  name: `Channel ${index}`,
  category: 'News',
  urls: [`https://fixture.invalid/${index}`],
});
const options = (signal = new AbortController().signal) => ({
  sessionRevision: 'review-1',
  query: '',
  signal,
});
describe('configured source scan review', () => {
  it('collects every source at most four at a time and presents stable input order', async () => {
    const sources = Array.from({ length: 21 }, (_, index) => source(String(index)));
    let active = 0;
    let maximum = 0;
    const review = await scanConfiguredSources(
      sources,
      async (entry) => {
        active++;
        maximum = Math.max(active, maximum);
        await new Promise((resolve) => setTimeout(resolve, Number(entry.id) % 3));
        active--;
        return { channels: [candidate(entry.id)], warnings: [] };
      },
      options(),
    );
    expect(maximum).toBe(4);
    expect(review.sources.map((entry) => entry.sourceId)).toEqual(
      sources.map((entry) => entry.source.id),
    );
    expect(review.candidates.map((entry) => entry.sourceId)).toEqual(
      sources.map((entry) => entry.source.id),
    );
  });
  it('retains partial failures with safe diagnostics and stages only chosen provenance', async () => {
    const review = await scanConfiguredSources(
      [source('a'), source('b')],
      async (entry) => {
        if (entry.id === 'b') throw new Error('https://private.invalid/secret');
        return { channels: [candidate('a', 1), candidate('a', 2)], warnings: ['warning'] };
      },
      options(),
    );
    expect(review.counts.failedSources).toBe(1);
    expect(review.sources[0].warningMessages).toEqual(['warning']);
    expect(review.sources[1].error).not.toContain('private');
    const staged = stageScanSelection(review, [review.candidates[1].key], 'review-1');
    expect(staged.sources).toEqual([
      {
        sourceId: 'a',
        fingerprint: 'revision-a',
        candidates: [candidate('a', 2)],
        reconciliationScope: scanReconciliationScopes(review).get('a'),
      },
    ]);
    expect(staged.failedSourceIds).toEqual(['b']);
  });

  it('a delayed failed source retains its own prior records while healthy source slots continue exactly once', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const configured = Array.from({ length: 7 }, (_, index) => source(String(index)));
    const started: string[] = [],
      progress = vi.fn();
    let active = 0,
      peak = 0;
    const pending = scanConfiguredSources(
      configured,
      async (entry) => {
        started.push(entry.id);
        peak = Math.max(peak, ++active);
        try {
          if (entry.id === '0') {
            await held;
            throw new Error('private source address');
          }
          await Promise.resolve(); // Real reader admission yields before settling its slot.
          return { channels: [candidate(entry.id)], warnings: [] };
        } finally {
          active--;
        }
      },
      { ...options(), progress },
    );
    try {
      await vi.waitFor(() => expect(started).toHaveLength(7));
      expect(progress).toHaveBeenCalledTimes(6);
      expect(active).toBe(1);
    } finally {
      release();
    }
    const result = await pending;
    expect(peak).toBe(4);
    expect(active).toBe(0);
    expect(new Set(started).size).toBe(7);
    expect(result.status).toBe('completed');
    expect(result.counts).toMatchObject({ failedSources: 1, canceledSources: 0, matched: 6 });
    expect(result.candidates.map((entry) => entry.sourceId)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    const selection = stageScanSelection(
      result,
      result.candidates.map((entry) => entry.key),
      'review-1',
    );
    expect(selection.failedSourceIds).toEqual(['0']);
    expect(selection.sources.map((entry) => entry.sourceId)).toEqual([
      '1',
      '2',
      '3',
      '4',
      '5',
      '6',
    ]);
    expect(JSON.stringify(result)).not.toContain('private source address');
  });
  it('queries declared metadata and retains distinct records without random sampling', async () => {
    const records = [
      candidate('a', 0),
      { ...candidate('a', 1), name: 'SPORTS Extra', category: 'Live' },
      { ...candidate('a', 1), name: 'Sports Regional', category: 'Live' },
    ];
    const operation = async (): Promise<ParsedPlaylist> => ({
      channels: [...records, records[1]],
      warnings: [],
    });
    const review = await scanConfiguredSources([source('a')], operation, {
      ...options(),
      query: 'sports LIVE',
    });
    expect(review.counts.inspected).toBe(3);
    expect(review.candidates.map((entry) => entry.channel.name)).toEqual([
      'SPORTS Extra',
      'Sports Regional',
    ]);
    expect(
      await scanConfiguredSources([source('a')], operation, { ...options(), query: 'sports LIVE' }),
    ).toEqual(review);
    expect(
      (
        await scanConfiguredSources([source('a')], operation, {
          ...options(),
          query: 'fixture.invalid',
        })
      ).candidates,
    ).toEqual([]);
  });
  it('matches declared genre aliases and official geography without inventing genre, city or source-wide location', async () => {
    const records: ChannelCandidate[] = [
      { ...candidate('a', 0), category: 'Animation', geography: { country: 'US', state: 'US-IL' } },
      { ...candidate('a', 1), category: 'Children', geography: { country: 'US', state: 'US-NY' } },
      { ...candidate('a', 2), category: 'Movies' },
      { ...candidate('a', 3), category: 'Animation' },
    ];
    const configured = source('a');
    configured.source.name = 'Illinois Chicago Drama Action source';
    const find = async (query: string) =>
      (
        await scanConfiguredSources(
          [configured],
          async () => ({ channels: records, warnings: [] }),
          { ...options(), query },
        )
      ).candidates.map((entry) => entry.channel.name);
    expect(await find('cartoons')).toEqual(['Channel 0', 'Channel 3']);
    expect(await find('kids')).toEqual(['Channel 1']);
    expect(await find('United States Illinois cartoons')).toEqual(['Channel 0']);
    expect(await find('US-IL')).toEqual(['Channel 0']);
    expect(await find('Chicago')).toEqual([]);
    expect(await find('Drama')).toEqual([]);
    expect(await find('Action')).toEqual([]);
    expect(await find('Illinois kids')).toEqual([]);
  });
  it('accepts an exact published provider ID but never an opaque ID substring or stream hostname', async () => {
    const records = [{ ...candidate('a'), providerId: 'OpaqueAffiliation.us@HD' }];
    const find = async (query: string) =>
      (
        await scanConfiguredSources(
          [source('a')],
          async () => ({ channels: records, warnings: [] }),
          { ...options(), query },
        )
      ).candidates;
    expect(await find('opaqueaffiliation.US@hd')).toHaveLength(1);
    expect(await find('OpaqueAffiliation')).toEqual([]);
    expect(await find('HD')).toEqual([]);
    expect(await find('fixture.invalid')).toEqual([]);
  });
  it('cancellation waits for all owned readers and never permits staged commit or postcancel progress', async () => {
    const controller = new AbortController();
    const closed: string[] = [];
    const progress = vi.fn();
    let started = 0;
    const pending = scanConfiguredSources(
      Array.from({ length: 10 }, (_, index) => source(String(index))),
      async (entry, signal) => {
        started++;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              setTimeout(() => {
                closed.push(entry.id);
                resolve();
              }, 5);
            },
            { once: true },
          ),
        );
        return { channels: [candidate(entry.id)], warnings: [] };
      },
      { ...options(controller.signal), progress },
    );
    expect(started).toBe(4);
    controller.abort();
    const review = await pending;
    expect(closed).toHaveLength(4);
    expect(progress).not.toHaveBeenCalled();
    expect(review.counts.canceledSources).toBe(10);
    expect(() => stageScanSelection(review, [], 'review-1')).toThrow('canceled');
  });
  it('rejects obsolete/repeated review selection and protects operation-owned arrays', async () => {
    const records = [candidate('a')];
    const review = await scanConfiguredSources(
      [source('a')],
      async () => ({ channels: records, warnings: [] }),
      options(),
    );
    records[0].name = 'changed';
    expect(review.candidates[0].channel.name).toBe('Channel 0');
    expect(() => stageScanSelection(review, [], 'review-2')).toThrow('obsolete');
    expect(() =>
      stageScanSelection(review, [review.candidates[0].key, review.candidates[0].key], 'review-1'),
    ).toThrow('repeated');
    expect(() => stageScanSelection(review, ['missing'], 'review-1')).toThrow('obsolete');
    expect(stageScanSelection(review, [], 'review-1').sources).toEqual([]);
  });
  it('accepts 100,000 aggregate candidates and explicitly rejects overflow even with restrictive query', async () => {
    const operation = async (entry: { id: string }) => ({
      channels: Array.from({ length: 50000 }, (_, index) => candidate(entry.id, index)),
      warnings: [],
    });
    const review = await scanConfiguredSources([source('a'), source('b')], operation, {
      ...options(),
      query: 'absent',
    });
    expect(review.counts.inspected).toBe(100000);
    expect(review.candidates).toEqual([]);
    await expect(
      scanConfiguredSources([source('a'), source('b'), source('c')], operation, {
        ...options(),
        query: 'absent',
      }),
    ).rejects.toThrow('100,000');
  });
});
