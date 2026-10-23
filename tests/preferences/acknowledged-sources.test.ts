import { expect, it } from 'vitest';
import { SerializedPreferencesStore } from '../../src/preferences';
const source = {
  id: 'source',
  name: 'Owned',
  kind: 'url' as const,
  location: 'https://fixture.invalid/catalog',
  allowHttp: true,
};
const added = { ...source, id: 'added', location: 'https://fixture.invalid/added' };
function store() {
  let writes = 0;
  const value = new SerializedPreferencesStore({
    read: async () => null,
    write: async () => {
      writes++;
    },
  });
  return { value, writes: () => writes };
}
it('adopts acknowledged source upserts without another write or changing unrelated user choices', async () => {
  const f = store();
  await f.value.update((draft) => {
    draft.sources = [source];
    draft.favorites = ['favorite'];
    draft.removedChannels = ['removed'];
    draft.volume = 0.4;
    draft.channelCategoryOverrides = [{ channelId: 'favorite', category: 'Sports' }];
    draft.preferredRegion = { country: 'US', state: 'US-IL', origin: 'manual' };
  });
  const before = f.value.snapshot(),
    expected = await f.value.settledSources(),
    writes = f.writes();
  const sources = await f.value.adoptAcknowledgedSources([added], expected, () => true);
  expect(sources.map((item) => item.id)).toEqual(['source', 'added']);
  expect(f.writes()).toBe(writes);
  expect(f.value.snapshot()).toEqual({ ...before, sources: [source, added] });
});
it('a queued source grant revocation wins and refuses stale native source adoption', async () => {
  let release!: () => void,
    writes = 0;
  const value = new SerializedPreferencesStore({
    read: async () => null,
    write: async () => {
      writes++;
      if (writes === 2) await new Promise<void>((resolve) => (release = resolve));
    },
  });
  await value.update((draft) => {
    draft.sources = [source];
  });
  const expected = await value.settledSources();
  const revoke = value.update((draft) => {
    draft.sources[0]!.allowHttp = false;
  });
  const adoption = value.adoptAcknowledgedSources([added], expected, () => true);
  const refused = expect(adoption).rejects.toThrow('Source choices changed');
  await Promise.resolve();
  await Promise.resolve();
  release();
  await revoke;
  await refused;
  expect(writes).toBe(2);
  expect(value.snapshot().sources).toEqual([{ ...source, allowHttp: false }]);
});
it('latest favorite edits survive the queued adoption and a false revision guard changes nothing', async () => {
  const f = store();
  await f.value.update((draft) => {
    draft.sources = [source];
  });
  const expected = await f.value.settledSources();
  const favorite = f.value.update((draft) => {
    draft.favorites = ['new-favorite'];
  });
  await f.value.adoptAcknowledgedSources([added], expected, () => true);
  await favorite;
  expect(f.value.snapshot().favorites).toEqual(['new-favorite']);
  const before = f.value.snapshot();
  await expect(
    f.value.adoptAcknowledgedSources([{ ...source, name: 'changed' }], before.sources, () => false),
  ).rejects.toThrow();
  expect(f.value.snapshot()).toEqual(before);
  expect(f.writes()).toBe(2);
});
