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
  searchCatalog,
  SEARCH_WEEK_MS,
  type SearchMapping,
  type SearchChannel,
} from '../../src/search/catalog-search';
import type { GuideProgram } from '../../src/guide/query';
const now = 1000000;
const channel: SearchChannel = {
  id: 'fox',
  sourceId: 'catalog',
  name: 'FOX 32 Chicago',
  category: 'News',
};
const mapping: SearchMapping = {
  catalogSourceId: 'catalog',
  appChannelId: 'fox',
  guideSourceId: 'online-guide',
  xmltvChannelId: 'wfld',
};
const program = (startMs = now + 1000, stopMs: number | null = startMs + 1000): GuideProgram => ({
  guideSourceId: 'online-guide',
  channelId: 'wfld',
  startMs,
  stopMs,
  title: 'NFL Football',
  description: 'Chicago Bears vs visitors',
});
const input = (programs: GuideProgram[] = []) => ({
  query: 'Chicago Bears',
  channels: [channel],
  programs,
  mappings: [mapping],
  coverage: [],
  nowMs: now,
});
describe('shared channel and mapped guide search', () => {
  it('searches supplied program categories across title+description with AND tokens and no genre inference', () => {
    const tagged = {
      ...program(),
      categories: [{ text: 'Action', language: 'en' }, { text: 'Mystery' }],
    };
    expect(searchCatalog({ ...input([tagged]), query: 'action' }).events).toHaveLength(1);
    expect(searchCatalog({ ...input([tagged]), query: 'Bears Mystery' }).events).toHaveLength(1);
    expect(searchCatalog({ ...input([tagged]), query: 'Bears Drama' }).events).toHaveLength(0);
    expect(searchCatalog({ ...input([program()]), query: 'Action' }).events).toHaveLength(0);
    expect(
      searchCatalog({
        ...input([{ ...program(), categories: [{ text: 'Animation' }] }]),
        query: 'cartoons',
      }).events,
    ).toHaveLength(1);
    expect(
      searchCatalog({
        ...input([{ ...program(), categories: [{ text: 'Movies' }] }]),
        query: 'Drama',
      }).events,
    ).toHaveLength(0);
  });
  it('Fox matches channel names while Chicago Bears matches separate online guide descriptions', () => {
    const result = searchCatalog(input([program()]));
    expect(result.channels).toEqual([]);
    expect(result.events[0].channel.id).toBe('fox');
    expect(result.events[0].timing).toBe('upcoming');
    const fox = searchCatalog({ ...input([program()]), query: 'FOX' });
    expect(fox.channels.map((value) => value.id)).toEqual(['fox']);
    expect(fox.events).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('https://');
  });
  it('uses a half-open seven-day horizon with actual now-playing overlap and exact end exclusion', () => {
    const events = [
      program(now - 1000, now),
      program(now - 1000, now + 1000),
      program(now, now + 1000),
      program(now + SEARCH_WEEK_MS - 1, now + SEARCH_WEEK_MS + 1000),
      program(now + SEARCH_WEEK_MS, now + SEARCH_WEEK_MS + 2000),
    ];
    const result = searchCatalog(input(events));
    expect(result.events.map((value) => value.program.startMs)).toEqual([
      now - 1000,
      now,
      now + SEARCH_WEEK_MS - 1,
    ]);
    expect(result.horizonEndMs).toBe(now + SEARCH_WEEK_MS);
    expect(result.events[0].timing).toBe('overlap');
  });
  it('never extends old unknown-end events indefinitely or labels unknown current as live', () => {
    const result = searchCatalog(
      input([program(now - 1, null), program(now, null), program(now + 1000, null)]),
    );
    expect(result.events).toHaveLength(2);
    expect(result.events.map((event) => event.timing)).toEqual(['unknown-end', 'upcoming']);
    expect(result.events.every((event) => event.program.stopMs === null)).toBe(true);
  });
  it('ignores unmapped guide entries and does not create streams from guide-only channels', () => {
    const result = searchCatalog({
      ...input([program(), { ...program(), channelId: 'no-stream' }]),
      mappings: [],
    });
    expect(result.events).toEqual([]);
    expect(result.counts.unmappedChannels).toBe(1);
    expect(searchCatalog({ ...input(), query: 'Fox', mappings: [] }).channels[0].mapping).toBe(
      'unmapped',
    );
  });
  it('scopes mappings by catalog source and guide source, retains distinct feeds, rejects ambiguous targets', () => {
    const regional = { ...channel, sourceId: 'other-provider', name: 'FOX regional' };
    const shared = searchCatalog({
      ...input([program(), program()]),
      channels: [regional, channel],
      mappings: [mapping, { ...mapping, catalogSourceId: regional.sourceId }],
    });
    expect(shared.events.map((event) => event.channel.sourceId)).toEqual([
      'catalog',
      'other-provider',
    ]);
    expect(shared.counts.events).toBe(2);
    const ambiguous = searchCatalog({
      ...input([program()]),
      query: 'Fox',
      mappings: [mapping, { ...mapping, xmltvChannelId: 'another-affiliate' }],
    });
    expect(ambiguous.channels[0].mapping).toBe('ambiguous');
    expect(ambiguous.events).toEqual([]);
    expect(ambiguous.counts.ambiguousChannels).toBe(1);
  });
  it('retains stale schedule results with honest coverage and refuses a future refresh timestamp as freshness', () => {
    const coverage = {
      guideSourceId: 'online-guide',
      revision: 'guide-rev',
      updatedAtMs: now - 1000,
      windowStartMs: now,
      windowEndMs: now + 10000,
    };
    const result = searchCatalog({
      ...input([program()]),
      coverage: [coverage],
      staleAfterMs: 100,
    });
    expect(result.events[0].coverage).toMatchObject({
      freshness: 'stale',
      range: 'partial-window',
    });
    expect(
      searchCatalog({ ...input([program()]), coverage: [{ ...coverage, updatedAtMs: now + 1 }] })
        .events[0].coverage.freshness,
    ).toBe('unknown');
    expect(searchCatalog(input([program()])).events[0].coverage).toMatchObject({
      freshness: 'unknown',
      range: 'unknown',
    });
  });
  it('normalizes typed and final transcript punctuation identically and preserves deterministic paging/order', () => {
    const programs = [program(now + 3000), program(now + 1000), program(now + 2000)];
    const a = searchCatalog({
      ...input(programs),
      query: '  CHICAGO, Bears! ',
      limit: 1,
      eventOffset: 1,
    });
    const b = searchCatalog({
      ...input([...programs].reverse()),
      query: '  CHICAGO, Bears! ',
      limit: 1,
      eventOffset: 1,
    });
    expect(a).toEqual(b);
    expect(a.events[0].program.startMs).toBe(now + 2000);
    expect(a.counts.events).toBe(3);
    expect(searchCatalog({ ...input(programs), query: ' ' }).events).toEqual([]);
  });
  it('computes many-to-one mapped event counts without allocating their full cross product', () => {
    const channels = Array.from({ length: 10000 }, (_, index) => ({
      ...channel,
      id: `feed-${String(index).padStart(5, '0')}`,
    }));
    const mappings = channels.map((value) => ({ ...mapping, appChannelId: value.id }));
    const programs = Array.from({ length: 1000 }, (_, index) =>
      program(now + index * 2000 + 1, now + index * 2000 + 1000),
    );
    const result = searchCatalog({ ...input(programs), channels, mappings, eventOffset: 9000010 });
    expect(result.counts.events).toBe(10000000);
    expect(result.events).toHaveLength(50);
    expect(result.events[0].channel.id).toBe('feed-00010');
    expect(result.events[0].program.startMs).toBe(now + 900 * 2000 + 1);
  });
  it('explicitly rejects oversized query/window and invalid mapped schedule rather than returning partial success', () => {
    expect(() => searchCatalog({ ...input(), query: 'x'.repeat(257) })).toThrow('invalid');
    expect(() => searchCatalog({ ...input(), horizonMs: SEARCH_WEEK_MS + 1 })).toThrow('invalid');
    expect(() => searchCatalog(input([program(now, now)]))).toThrow('invalid');
    expect(() => searchCatalog({ ...input(), channels: Array(100001).fill(channel) })).toThrow(
      'limit',
    );
  });
});
