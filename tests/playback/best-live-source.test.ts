import { it, expect, vi } from 'vitest';
import { createBestLiveSource } from '../../src/platform/best-live-source';
const one = {
  id: 'one',
  name: 'One',
  sourceId: 'a',
  category: 'Sports',
  urls: ['https://a.invalid/live'],
};
const two = { ...one, id: 'two', name: 'Two', sourceId: 'b', urls: ['https://b.invalid/live'] };
const selection = { id: one.id, name: one.name, url: one.urls[0] };
const reply = {
  channelId: 'one',
  catalogRevision: '7',
  validUntilMs: 100000,
  candidates: ['one', 'two'],
};
it('ranks only an admitted current equivalent set and selects the actual source identity', async () => {
  const query = vi.fn(async () => reply),
    rank = vi.fn((rows: readonly (typeof selection)[]) => [...rows].reverse());
  const resolve = createBestLiveSource({
    channels: () => [one, two],
    revision: () => '7',
    now: () => 2000,
    query,
    rank,
  });
  expect(await resolve(selection)).toMatchObject({ id: 'two', name: 'Two', url: two.urls[0] });
  expect(query).toHaveBeenCalledTimes(1);
});
it('does not combine matching names without native feed admission or expired programming', async () => {
  for (const result of [
    { ...reply, candidates: ['one'], validUntilMs: null },
    { ...reply, validUntilMs: 1000 },
    { ...reply, catalogRevision: '6' },
    { ...reply, candidates: ['two', 'one'] },
  ]) {
    const resolve = createBestLiveSource({
      channels: () => [one, { ...two, name: 'One' }],
      revision: () => '7',
      now: () => 2000,
      query: async () => result,
      rank: (rows) => [...rows].reverse(),
    });
    expect(await resolve(selection)).toEqual(selection);
  }
});
it('does not substitute a source after a catalog change or query failure', async () => {
  let revision = '7';
  const unavailable = vi.fn();
  const resolve = createBestLiveSource({
    channels: () => [one, two],
    revision: () => revision,
    now: () => 2000,
    query: async () => {
      revision = '8';
      return reply;
    },
    rank: (rows) => [...rows].reverse(),
    unavailable,
  });
  expect(await resolve(selection)).toEqual(selection);
  const failed = createBestLiveSource({
    channels: () => [one, two],
    revision: () => '7',
    query: async () => {
      throw Error('offline');
    },
    rank: (rows) => [...rows],
    unavailable,
  });
  expect(await failed(selection)).toEqual(selection);
  expect(unavailable).toHaveBeenCalledTimes(1);
});
