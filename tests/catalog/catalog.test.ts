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
  MAX_PLAYLIST_BYTES,
  parseM3u,
  reconcileChannels,
  type ChannelCandidate,
  type Source,
} from '../../src/catalog/parser';
import { CatalogRefreshService, mergeInspectedSource } from '../../src/catalog/service';
import { serializeCatalog, type CatalogRecord } from '../../src/catalog/codec';
const playlist = (
  metadata = 'tvg-id="news" group-title="News"',
  name = 'World News',
  url = 'https://example.org/live.m3u8',
) => `#EXTM3U\n#EXTINF:-1 ${metadata},${name}\n${url}\n`;
const source = {
  id: 'source',
  name: 'Fixture',
  location: 'https://example.org/list.m3u',
  kind: 'url' as const,
};
const parse = async (text: string, id: string) => parseM3u(text, id);
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe('playlist limits and identity', () => {
  it('bounds Unicode metadata lines in bytes before source review or persistence', () => {
    const header = '#EXTINF:-1 ,';
    const name = '界'.repeat(5457) + 'A';
    expect(new TextEncoder().encode(header + name).byteLength).toBe(16_384);
    const text = `#EXTM3U\n${header}${name}\nhttps://example.org/live\n`;
    expect(parseM3u(text, 'source').channels[0]!.name).toBe(name);
    expect(() => parseM3u(text.replace(name, name + 'A'), 'source')).toThrow('line size limit');
  });
  it('parses BOM/CRLF, quoted comma metadata and comma titles', () => {
    const result = parseM3u(
      '\uFEFF' +
        playlist('group-title="News, World" tvg-id="n"', 'News, Live').replace(/\n/g, '\r\n'),
      'source',
    );
    expect(result.channels[0]).toMatchObject({
      providerId: 'n',
      category: 'News, World',
      name: 'News, Live',
    });
  });
  it.each([
    '#EXTM3U\n#EXTINF:-1 group-title="unfinished,Name\nhttps://example.org',
    playlist('broken="a"junk="b"'),
    playlist('', ''),
    playlist('', 'Name', 'javascript:alert(1)'),
    '#EXTM3U',
    '#EXTM3U\nhttps://example.org',
    '#EXTM3U\n#EXTINF:-1,Name',
  ])('rejects malformed input without accepting partial catalog (%#)', (text) => {
    expect(() => parseM3u(text, 'source')).toThrow();
  });
  it('rejects oversized byte input and metadata lines', () => {
    expect(() => parseM3u('a'.repeat(MAX_PLAYLIST_BYTES + 1), 'source')).toThrow('20 MiB');
    expect(() => parseM3u(playlist('', 'a'.repeat(16_385)), 'source')).toThrow('line size');
  });
  it('accepts exactly 100,000 entries, rejects the next entry', () => {
    const entry = '#EXTINF:-1,Name\nhttps://example.org\n';
    expect(parseM3u('#EXTM3U\n' + entry.repeat(100_000), 'source').channels).toHaveLength(100_000);
    expect(() => parseM3u('#EXTM3U\n' + entry.repeat(100_001), 'source')).toThrow('100,000');
  });
  it('keeps provider identity after URL/title changes and source order changes', () => {
    const initial = reconcileChannels(parseM3u(playlist(), 'source').channels, []);
    const next = reconcileChannels(
      parseM3u(playlist('tvg-id="news"', 'Renamed', 'https://example.org/new'), 'source').channels,
      initial,
    );
    expect(next[0]!.id).toBe(initial[0]!.id);
  });
  it('reconciles uniquely matching missing IDs using persisted metadata, never URL/index', () => {
    const c = parseM3u(playlist('', 'Independent'), 'source').channels;
    const old = reconcileChannels(c, [], () => 'persisted');
    expect(
      reconcileChannels([{ ...c[0]!, urls: ['https://example.org/changed'] }], old)[0]!.id,
    ).toBe('persisted');
    expect(reconcileChannels([{ ...c[0]!, name: 'Other' }], old, () => 'new')[0]!.id).toBe('new');
  });
  it('keeps ambiguous duplicates distinct rather than transferring user identity arbitrarily', () => {
    const c = parseM3u(playlist() + playlist().replace('#EXTM3U\n', ''), 'source').channels;
    let i = 0;
    const old = reconcileChannels(c, [], () => `old-${i++}`);
    const next = reconcileChannels(c, old, () => `new-${i++}`);
    expect(new Set(next.map((v) => v.id)).size).toBe(2);
    expect(next.every((v) => !old.some((o) => o.id === v.id))).toBe(true);
  });
  it('detects broken ID generators', () => {
    const candidate: ChannelCandidate = {
      sourceId: 's',
      name: 'n',
      category: '',
      urls: ['https://example.org'],
    };
    expect(() => reconcileChannels([candidate, candidate], [], () => 'same')).toThrow(
      'duplicate identity',
    );
  });
  it('reconciles a 100,000-entry ambiguous catalog without quadratic bucket copies', () => {
    const candidate: ChannelCandidate = {
      sourceId: 's',
      providerId: 'duplicate',
      name: 'Duplicate',
      category: '',
      urls: ['https://example.org'],
    };
    const candidates = Array<ChannelCandidate>(100_000).fill(candidate);
    let counter = 0;
    const previous = reconcileChannels(candidates, [], () => `old-${counter++}`);
    const refreshed = reconcileChannels(candidates, previous, () => `new-${counter++}`);
    expect(refreshed).toHaveLength(100_000);
    expect(new Set(refreshed.map((c) => c.id)).size).toBe(100_000);
    expect(refreshed.every((c) => c.id.startsWith('new-'))).toBe(true);
  });
});

describe('catalog refresh ownership', () => {
  it.each(['parse-failure', 'commit-failure', 'cancel'] as const)(
    'retains runtime and persisted source hints after inspected %s',
    async (mode) => {
      const admitted: Source = {
        ...source,
        contentKind: 'hls',
        mediaMime: 'application/vnd.apple.mpegurl',
      };
      let runtime: CatalogRecord = { schemaVersion: 1, sources: [admitted], channels: [] };
      let persisted = serializeCatalog(runtime);
      const original = structuredClone(runtime);
      const inspected = deferred<void>();
      const parsed = deferred<ReturnType<typeof parseM3u>>();
      let writes = 0;
      const service = new CatalogRefreshService(
        {
          read: async () => [],
          commit: async (_id, channels, signal, staged) => {
            signal.throwIfAborted();
            writes++;
            if (mode === 'commit-failure') throw new Error('Fixture storage failure');
            const next: CatalogRecord = {
              schemaVersion: 1,
              sources: [mergeInspectedSource(runtime.sources[0], staged)],
              channels,
            };
            persisted = serializeCatalog(next);
            runtime = next;
          },
        },
        async (staged) => {
          expect(staged).not.toBe(admitted);
          staged.contentKind = 'catalog';
          staged.mediaMime = 'text/plain';
          inspected.resolve();
          return mode === 'parse-failure' ? '#EXTM3U\n#EXTINF:-1,Broken' : playlist();
        },
        mode === 'cancel' ? () => parsed.promise : parse,
      );
      const work = service.refresh(admitted);
      if (mode === 'cancel') {
        await inspected.promise;
        service.cancel(admitted.id);
        parsed.resolve(parseM3u(playlist(), admitted.id));
        expect(await work).toEqual({ status: 'canceled' });
      } else await expect(work).rejects.toThrow();
      expect(runtime).toEqual(original);
      expect(persisted).toBe(serializeCatalog(original));
      expect(writes).toBe(mode === 'commit-failure' ? 1 : 0);
    },
  );
  it('publishes inspected hints only with atomic success and preserves current source name', async () => {
    const admitted: Source = { ...source, contentKind: 'hls' };
    let runtime: CatalogRecord = { schemaVersion: 1, sources: [admitted], channels: [] };
    let persisted = serializeCatalog(runtime);
    const service = new CatalogRefreshService(
      {
        read: async () => [],
        commit: async (_id, channels, _signal, staged) => {
          expect(runtime.sources[0].contentKind).toBe('hls');
          runtime.sources[0] = { ...runtime.sources[0], name: 'Current source name' };
          const next: CatalogRecord = {
            schemaVersion: 1,
            sources: [mergeInspectedSource(runtime.sources[0], staged)],
            channels,
          };
          persisted = serializeCatalog(next);
          runtime = next;
          service.cancel(source.id); // The acknowledged publication remains successful.
        },
      },
      async (staged) => {
        staged.contentKind = 'catalog';
        staged.mediaMime = 'text/plain';
        expect(admitted.contentKind).toBe('hls');
        return playlist();
      },
      parse,
    );
    expect((await service.refresh(admitted)).status).toBe('completed');
    expect(runtime.sources[0]).toMatchObject({
      name: 'Current source name',
      contentKind: 'catalog',
      mediaMime: 'text/plain',
    });
    expect(JSON.parse(persisted).sources).toEqual(runtime.sources);
    expect(admitted.contentKind).toBe('hls');
  });
  it.each([
    { location: 'https://example.org/changed' },
    { kind: 'file' as const },
    { allowHttp: true },
    { id: 'another-source' },
  ])('refuses staged hints when current source admission changed (%j)', (change) => {
    const current = { ...source, ...change };
    const before = structuredClone(current);
    expect(() => mergeInspectedSource(current, { ...source, contentKind: 'catalog' })).toThrow(
      'Import source changed',
    );
    expect(current).toEqual(before);
  });
  it('background drain waits superseded parser ownership and remains reusable', async () => {
    const late = deferred<ReturnType<typeof parseM3u>>();
    let calls = 0;
    const saved: string[] = [];
    const service = new CatalogRefreshService(
      {
        read: async () => [],
        commit: async (_id, channels) => {
          saved.push(channels[0]!.name);
        },
      },
      undefined,
      async (text, id) => (++calls === 1 ? late.promise : parseM3u(text, id)),
    );
    const obsolete = service.refresh(source, playlist('', 'Obsolete'));
    expect((await service.refresh(source, playlist('', 'Current'))).status).toBe('completed');
    let drained = false;
    const drain = service.cancelAll().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    late.resolve(parseM3u(playlist('', 'Obsolete'), source.id));
    expect((await obsolete).status).toBe('canceled');
    await drain;
    expect(saved).toEqual(['Current']);
    expect((await service.refresh(source, playlist('', 'Explicit retry'))).status).toBe(
      'completed',
    );
    expect(saved).toEqual(['Current', 'Explicit retry']);
  });
  it('terminal drain waits crossed publication and rejects new admission', async () => {
    const entered = deferred<void>();
    const receipt = deferred<void>();
    const service = new CatalogRefreshService(
      {
        read: async () => [],
        commit: async () => {
          entered.resolve();
          await receipt.promise;
        },
      },
      undefined,
      parse,
    );
    const publication = service.refresh(source, playlist());
    await entered.promise;
    let disposed = false;
    const closing = service.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposed).toBe(false);
    await expect(service.refresh(source, playlist())).rejects.toThrow('closed');
    receipt.resolve();
    expect((await publication).status).toBe('completed');
    await closing;
    expect(disposed).toBe(true);
  });
  it('cancels late parser results before commit', async () => {
    const late = deferred<ReturnType<typeof parseM3u>>();
    let writes = 0;
    const service = new CatalogRefreshService(
      {
        read: async () => [],
        commit: async () => {
          writes++;
        },
      },
      undefined,
      () => late.promise,
    );
    const pending = service.refresh(source, playlist());
    service.cancel(source.id);
    late.resolve(parseM3u(playlist(), source.id));
    expect(await pending).toEqual({ status: 'canceled' });
    expect(writes).toBe(0);
  });
  it('retains last catalog when validation fails', async () => {
    let writes = 0;
    const service = new CatalogRefreshService(
      {
        read: async () => [],
        commit: async () => {
          writes++;
        },
      },
      undefined,
      parse,
    );
    await expect(service.refresh(source, '#EXTM3U')).rejects.toThrow('no channels');
    expect(writes).toBe(0);
  });
  it('reports completion if cancellation occurs after atomic publication', async () => {
    const service = new CatalogRefreshService(
      {
        read: async () => [],
        commit: async () => {
          service.cancel(source.id);
        },
      },
      undefined,
      parse,
    );
    expect((await service.refresh(source, playlist())).status).toBe('completed');
  });
  it('rejects failed commits, and the serialized queue remains usable', async () => {
    let writes = 0;
    const service = new CatalogRefreshService(
      {
        read: async () => [],
        commit: async () => {
          if (++writes === 1) throw new Error('disk full');
        },
      },
      undefined,
      parse,
    );
    await expect(service.refresh(source, playlist())).rejects.toThrow('disk full');
    expect((await service.refresh(source, playlist())).status).toBe('completed');
  });
  it('superseded refresh cannot publish a late result', async () => {
    const late = deferred<ReturnType<typeof parseM3u>>();
    let calls = 0;
    const names: string[] = [];
    const service = new CatalogRefreshService(
      {
        read: async () => [],
        commit: async (_id, channels) => {
          names.push(channels[0]!.name);
        },
      },
      undefined,
      async (text, id) => (++calls === 1 ? late.promise : parseM3u(text, id)),
    );
    const first = service.refresh(source, playlist('', 'First'));
    const second = service.refresh(source, playlist('', 'Second'));
    expect((await second).status).toBe('completed');
    late.resolve(parseM3u(playlist('', 'First'), source.id));
    expect((await first).status).toBe('canceled');
    expect(names).toEqual(['Second']);
  });
});
