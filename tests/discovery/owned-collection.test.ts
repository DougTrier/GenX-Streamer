import { describe, expect, it, vi } from 'vitest';
import { ownCollectedPlaylist, consumeOwnedCollection } from '../../src/catalog/owned-collection';
import { scanConfiguredSources, type ScanSource } from '../../src/discovery/scan';
import type { ParsedPlaylist } from '../../src/catalog/parser';

const signal = () => new AbortController().signal;
const source: ScanSource = {
  source: {
    id: 'source',
    name: 'Fixture',
    kind: 'url',
    location: 'https://fixture.invalid/catalog',
  },
  fingerprint: 'fingerprint',
};
const options = (abort = signal()) => ({ sessionRevision: 'revision', query: '', signal: abort });
const fixture = (count: number): ParsedPlaylist => ({
  channels: Array.from({ length: count }, (_, i) => ({
    sourceId: 'source',
    providerId: `provider-${i}`,
    name: `Channel ${i}`,
    category: 'Animation',
    urls: [`https://fixture.invalid/${i}`],
    geography: { country: 'US', state: 'US-IL' },
  })),
  warnings: ['Controlled warning'],
});

describe('owned post-enrichment collection handoff', () => {
  for (const count of [13256, 63193]) {
    it(`preserves exact ${count}-candidate public equivalence without copying the owned graph`, async () => {
      const publicInput = fixture(count),
        ownedInput = fixture(count);
      const publicReview = await scanConfiguredSources(
        [source],
        async () => publicInput,
        options(),
      );
      const receipt = await ownCollectedPlaylist(ownedInput, signal());
      const clone = vi.spyOn(globalThis, 'structuredClone');
      let ownedReview;
      try {
        ownedReview = await scanConfiguredSources([source], async () => receipt, options());
        expect(clone).not.toHaveBeenCalled();
      } finally {
        clone.mockRestore();
      }
      expect(ownedReview).toEqual(publicReview);
      expect(ownedReview.candidates[0]!.channel).toBe(ownedInput.channels[0]);
      expect(publicReview.candidates[0]!.channel).not.toBe(publicInput.channels[0]);
      publicInput.channels[0]!.name = 'Caller changed';
      publicInput.channels[0]!.urls.push('https://fixture.invalid/changed');
      publicInput.warnings.push('Caller changed');
      expect(publicReview.candidates[0]!.channel.name).toBe('Channel 0');
      expect(publicReview.candidates[0]!.channel.urls).toHaveLength(1);
      expect(publicReview.sources[0]!.warningMessages).toEqual(['Controlled warning']);
      expect(() => {
        ownedInput.channels[0]!.name = 'Caller changed';
      }).toThrow(TypeError);
      expect(() => ownedInput.channels[0]!.urls.push('https://fixture.invalid/changed')).toThrow(
        TypeError,
      );
      expect(() => ownedInput.warnings.push('Caller changed')).toThrow(TypeError);
      expect(consumeOwnedCollection(receipt)).toBeNull();
    });
  }
  it('deduplicates exact enriched metadata once while preserving source-local ordering and distinct metadata', async () => {
    const input = fixture(2);
    input.channels.splice(1, 0, structuredClone(input.channels[0]!));
    input.channels.push({ ...input.channels[0]!, geography: { country: 'US', state: 'US-NY' } });
    const reference = await scanConfiguredSources([source], async () => input, options());
    const owned = await ownCollectedPlaylist(input, signal());
    const review = await scanConfiguredSources([source], async () => owned, options());
    expect(review).toEqual(reference);
    expect(review.candidates.map((c) => c.channel.geography?.state)).toEqual([
      'US-IL',
      'US-IL',
      'US-NY',
    ]);
  });
  it('arbitrary frozen caller DTOs cannot claim ownership or bypass defensive cloning', async () => {
    const input = fixture(1);
    Object.freeze(input);
    expect(consumeOwnedCollection(input)).toBeNull();
    const review = await scanConfiguredSources([source], async () => input, options());
    input.channels[0]!.name = 'Changed';
    expect(review.candidates[0]!.channel.name).toBe('Channel 0');
  });
  it('retains the existing raw aggregate budget even when owned source duplicates collapse', async () => {
    const sources = ['source-a', 'source-b'].map((id) => ({
      ...source,
      source: { ...source.source, id },
    }));
    await expect(
      scanConfiguredSources(
        sources,
        async (entry, abort) => {
          const channel = { ...fixture(1).channels[0]!, sourceId: entry.id };
          return ownCollectedPlaylist(
            { channels: Array(60000).fill(channel), warnings: [] },
            abort,
          );
        },
        options(),
      ),
    ).rejects.toThrow('100,000 candidate limit');
  });
  it('refuses accessors/cycles and applies existing candidate bounds before graph work', async () => {
    const getter = vi.fn();
    const input = fixture(1);
    Object.defineProperty(input.channels[0], 'extra', { get: getter, enumerable: true });
    await expect(ownCollectedPlaylist(input, signal())).rejects.toThrow('plain');
    expect(getter).not.toHaveBeenCalled();
    const cyclic = fixture(1) as ParsedPlaylist & { cycle?: unknown };
    cyclic.cycle = cyclic;
    await expect(ownCollectedPlaylist(cyclic, signal())).rejects.toThrow('plain');
    await expect(
      ownCollectedPlaylist({ channels: new Array(100001), warnings: [] }, signal()),
    ).rejects.toThrow('plain');
  });
  it('cancellation joins all admitted held collectors without later admission or review effects', async () => {
    const controller = new AbortController(),
      releases: Array<() => void> = [];
    const starts: string[] = [];
    const sources = Array.from({ length: 8 }, (_, i) => ({
      ...source,
      source: { ...source.source, id: `source-${i}` },
    }));
    let settled = false;
    const work = scanConfiguredSources(
      sources,
      async (entry, abort) => {
        starts.push(entry.id);
        await new Promise<void>((resolve) => releases.push(resolve));
        const input = fixture(1);
        input.channels[0]!.sourceId = entry.id;
        return ownCollectedPlaylist(input, abort);
      },
      options(controller.signal),
    ).finally(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(starts).toHaveLength(4));
    controller.abort();
    await Promise.resolve();
    expect(settled).toBe(false);
    releases.forEach((release) => release());
    const review = await work;
    expect(review.status).toBe('canceled');
    expect(review.candidates).toEqual([]);
    expect(starts).toHaveLength(4);
    expect(settled).toBe(true);
  });
});
