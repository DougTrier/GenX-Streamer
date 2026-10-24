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

import { expect, it, vi } from 'vitest';
import { discoverPlaylistGuides } from '../../src/guide/discovery';
import { createAutomaticGuideBuilder } from '../../src/guide/automatic-build';
import type { Source } from '../../src/catalog/parser';
import type { ReviewedGuideProvider } from '../../src/guide/discovery';
const source = (id: string, overrides: Partial<Source> = {}): Source => ({
  id,
  name: id,
  kind: 'url',
  location: `https://fixture.invalid/${id}`,
  ...overrides,
});
const signal = () => new AbortController().signal;
const provider = (id = 'reviewed'): ReviewedGuideProvider => ({
  id,
  name: 'Reviewed local schedules',
  location: `https://guide.invalid/${id}`,
  provenance: 'https://publisher.invalid/documentation',
  limitations: 'Station IDs require review; coverage varies.',
});

it('isolates fragmented playlist guide hints so a valid source still reaches automatic mapping', async () => {
  const inspect = vi.fn(async (url: string) => ({
    kind: 'catalog',
    text: url.endsWith('/bad')
      ? '#EXTM3U tvg-url="https://guide.invalid/rejected.xml#private-fragment"'
      : '#EXTM3U tvg-url="https://guide.invalid/valid.xml"',
  }));
  const discovered = await discoverPlaylistGuides(
    [source('bad'), source('good')],
    inspect,
    signal(),
  );
  expect(discovered.outcomes.map((entry) => [entry.sourceId, entry.status])).toEqual([
    ['bad', 'failed'],
    ['good', 'found'],
  ]);
  expect(discovered.candidates.map((candidate) => candidate.location)).toEqual([
    'https://guide.invalid/valid.xml',
  ]);
  expect(JSON.stringify(discovered)).not.toContain('private-fragment');
  const preview = vi.fn(async (_provider: { location: string }) => ({
    ticket: 'valid-preview',
    sourceRevision: 1,
  }));
  const commitMatched = vi.fn(async () => ({ committed: true, matched: 1, unmatched: 1 }));
  const owner = createAutomaticGuideBuilder({
    capture: async () => ({
      catalogRevision: '7',
      channelCount: 2,
      providers: discovered.candidates.map((candidate) => ({
        name: candidate.name,
        location: candidate.location,
        allowHttp: false,
      })),
    }),
    isCurrent: () => true,
    canRun: () => true,
    preview,
    commitMatched,
    discard: async () => {
      throw new Error('A consumed preview must not be discarded.');
    },
  });
  expect(await owner.run()).toMatchObject({ checked: 1, connected: 1, failed: 0 });
  expect(preview).toHaveBeenCalledTimes(1);
  expect(preview.mock.calls[0]![0]).toMatchObject({ location: 'https://guide.invalid/valid.xml' });
  expect(commitMatched).toHaveBeenCalledTimes(1);
  await owner.dispose();
});

it('fragment rejection is whole-source atomic while encoded path hashes and other providers remain valid', async () => {
  const discovered = await discoverPlaylistGuides(
    [source('mixed'), source('encoded')],
    async (url) => ({
      kind: 'catalog',
      text: url.endsWith('/mixed')
        ? '#EXTM3U x-tvg-url="https://guide.invalid/first.xml,https://guide.invalid/invalid.xml#fragment"'
        : '#EXTM3U tvg-url="https://guide.invalid/path%23literal.xml"',
    }),
    signal(),
    { registry: [provider()] },
  );
  expect(discovered.outcomes.map((entry) => entry.status)).toEqual(['failed', 'found']);
  expect(discovered.candidates.map((candidate) => candidate.location)).toEqual([
    provider().location,
    'https://guide.invalid/path%23literal.xml',
  ]);
  expect(
    discovered.candidates.some(
      (candidate) => candidate.location === 'https://guide.invalid/first.xml',
    ),
  ).toBe(false);
});

it('offers only injected providers without network, permissions, invented mappings or defaults', async () => {
  const inspect = vi.fn();
  expect((await discoverPlaylistGuides([], inspect, signal())).candidates).toEqual([]);
  const result = await discoverPlaylistGuides([], inspect, signal(), {
    registry: [provider(), { ...provider('http'), location: 'http://guide.invalid/legacy' }],
  });
  expect(inspect).not.toHaveBeenCalled();
  expect(result.candidates[0]).toEqual({
    location: 'https://guide.invalid/reviewed',
    name: 'Reviewed local schedules',
    playlistNames: [],
    allowHttp: false,
    requiresHttpPermission: false,
    registryId: 'reviewed',
    provenance: 'https://publisher.invalid/documentation',
    limitations: 'Station IDs require review; coverage varies.',
  });
  expect(result.candidates[1]).toMatchObject({ allowHttp: false, requiresHttpPermission: true });
});

it('snapshots provider provenance across acquisition and merges exact header references', async () => {
  const entry = provider();
  const inspect = vi.fn(async () => {
    entry.name = 'Changed after admission';
    entry.limitations = 'Wrong new scope';
    return { kind: 'catalog', text: '#EXTM3U tvg-url=https://guide.invalid/reviewed' };
  });
  const result = await discoverPlaylistGuides([source('saved')], inspect, signal(), {
    registry: [entry],
  });
  expect(result.candidates).toHaveLength(1);
  expect(result.candidates[0]).toMatchObject({
    name: 'Reviewed local schedules',
    playlistNames: ['saved'],
    limitations: 'Station IDs require review; coverage varies.',
  });
});

it('refuses invalid or oversized complete registries before acquisition without silent truncation', async () => {
  const inspect = vi.fn();
  for (const registry of [
    Array.from({ length: 1001 }, (_, index) => provider(String(index))),
    [provider(), provider()],
    [provider(), { ...provider('other'), location: provider().location }],
    [{ ...provider(), location: 'https://user:password@guide.invalid/a' }],
    [{ ...provider(), provenance: 'http://publisher.invalid/docs' }],
    [{ ...provider(), limitations: 'x'.repeat(2049) }],
    [{ ...provider(), location: 'https://guide.invalid/a,https://guide.invalid/b' }],
  ]) {
    await expect(
      discoverPlaylistGuides([source('saved')], inspect, signal(), { registry }),
    ).rejects.toThrow('registry');
  }
  expect(inspect).not.toHaveBeenCalled();
});

it('keeps a full reviewed registry when additional playlist references exceed the shared limit', async () => {
  const result = await discoverPlaylistGuides(
    [source('saved')],
    async () => ({ kind: 'catalog', text: '#EXTM3U tvg-url=https://extra.invalid/guide' }),
    signal(),
    { registry: Array.from({ length: 1000 }, (_, index) => provider(String(index))) },
  );
  expect(result.candidates).toHaveLength(1000);
  expect(result.outcomes[0]?.status).toBe('failed');
  expect(result.candidates.some((entry) => entry.location === 'https://extra.invalid/guide')).toBe(
    false,
  );
});

it('extracts only the bounded first header, preserves exact query URLs, and deduplicates provenance in order', async () => {
  const inspect = vi.fn(async (url: string) => ({
    kind: 'catalog',
    text: url.endsWith('/one')
      ? '\uFEFF#EXTM3U x-tvg-url="https://guide.invalid/one?key=a%2Cb, https://guide.invalid/two" unrelated="data"\r\n#EXTINF:-1 tvg-url="https://ignored.invalid/guide",Channel\nhttps://stream.invalid/a'
      : '#EXTM3U\tURL-TVG=https://guide.invalid/two tvg-url="https://guide.invalid/three"\n',
  }));
  const result = await discoverPlaylistGuides([source('one'), source('two')], inspect, signal());
  expect(result.candidates.map((x) => x.location)).toEqual([
    'https://guide.invalid/one?key=a%2Cb',
    'https://guide.invalid/two',
    'https://guide.invalid/three',
  ]);
  expect(result.candidates[1]?.playlistNames).toEqual(['one', 'two']);
  expect(result.outcomes.map((x) => x.status)).toEqual(['found', 'found']);
  expect(inspect.mock.calls.map((x) => x[0])).toEqual([
    'https://fixture.invalid/one',
    'https://fixture.invalid/two',
  ]);
});

it('never inherits playlist HTTP permission or fetches guides, and skips saved file/direct media sources', async () => {
  const inspect = vi.fn(async () => ({
    kind: 'catalog',
    text: '#EXTM3U tvg-url=http://guide.invalid/guide.xml',
  }));
  const result = await discoverPlaylistGuides(
    [
      source('online', { allowHttp: true }),
      source('file', { kind: 'file' }),
      source('direct', { contentKind: 'hls' }),
    ],
    inspect,
    signal(),
  );
  expect(inspect).toHaveBeenCalledExactlyOnceWith(
    'https://fixture.invalid/online',
    true,
    expect.any(AbortSignal),
  );
  expect(result.candidates[0]).toMatchObject({
    location: 'http://guide.invalid/guide.xml',
    allowHttp: false,
    requiresHttpPermission: true,
  });
  expect(result.outcomes.map((x) => x.status)).toEqual(['found', 'none', 'none']);
});

it.each([
  'javascript:alert(1)',
  'file:///guide.xml',
  'https://user:secret@guide.invalid/a',
  'https://guide.invalid/%zz',
  'https:\\guide.invalid/a',
  'https://guide.invalid/a,',
  '',
])('refuses unsafe/malformed reference %s without partial source publication', async (hint) => {
  const result = await discoverPlaylistGuides(
    [source('bad')],
    async () => ({ kind: 'catalog', text: `#EXTM3U tvg-url="https://good.invalid/a,${hint}"` }),
    signal(),
  );
  expect(result.candidates).toEqual([]);
  expect(result.outcomes[0]?.status).toBe('failed');
  expect(JSON.stringify(result.outcomes)).not.toContain('secret');
});

it('retains other sources after unavailable or malformed results without exposing raw diagnostics', async () => {
  const result = await discoverPlaylistGuides(
    [source('bad'), source('malformed'), source('good'), source('none')],
    async (url) => {
      if (url.endsWith('/bad')) throw new Error('https://private.invalid/?secret=token');
      return {
        kind: 'catalog',
        text: url.endsWith('/malformed')
          ? '#EXTM3UBAD tvg-url=https://guide.invalid/a'
          : url.endsWith('/good')
            ? '#EXTM3U tvg-url=https://guide.invalid/a'
            : '#EXTM3U',
      };
    },
    signal(),
  );
  expect(result.outcomes.map((x) => x.status)).toEqual(['failed', 'failed', 'found', 'none']);
  expect(result.candidates).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('secret');
});

it('refuses per-playlist/global overflow completely for that source and rejects >100 sources before requests', async () => {
  const hints = (offset: number, count: number) =>
    Array.from({ length: count }, (_, i) => `https://guide.invalid/${offset + i}`).join(',');
  let result = await discoverPlaylistGuides(
    [source('too-many')],
    async () => ({ kind: 'catalog', text: `#EXTM3U x-tvg-url="${hints(0, 21)}"` }),
    signal(),
  );
  expect(result.candidates).toHaveLength(0);
  expect(result.outcomes[0]?.status).toBe('failed');
  const sources = Array.from({ length: 51 }, (_, i) => source(String(i)));
  result = await discoverPlaylistGuides(
    sources,
    async (url) => ({
      kind: 'catalog',
      text: `#EXTM3U tvg-url="${hints(Number(url.split('/').at(-1)) * 20, 20)}"`,
    }),
    signal(),
  );
  expect(result.candidates).toHaveLength(1000);
  expect(result.outcomes.map((x) => x.status)).toEqual([
    ...Array.from({ length: 50 }, () => 'found'),
    'failed',
  ]);
  const inspect = vi.fn();
  await expect(
    discoverPlaylistGuides(
      Array.from({ length: 101 }, (_, i) => source(String(i))),
      inspect,
      signal(),
    ),
  ).rejects.toThrow('100');
  expect(inspect).not.toHaveBeenCalled();
});

it('rejects oversized/control headers and propagates cancellation after an actual in-flight inspector settles', async () => {
  for (const text of [
    '#EXTM3U tvg-url="https://guide.invalid/a"' + ' '.repeat(16384),
    '#EXTM3U tvg-url="https://guide.invalid/a"\u0000',
  ]) {
    const result = await discoverPlaylistGuides(
      [source('a')],
      async () => ({ kind: 'catalog', text }),
      signal(),
    );
    expect(result.outcomes[0]?.status).toBe('failed');
  }
  const controller = new AbortController();
  let release!: () => void;
  const inspect = vi.fn(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return { kind: 'catalog', text: '#EXTM3U tvg-url=https://guide.invalid/a' };
  });
  const pending = discoverPlaylistGuides([source('a'), source('b')], inspect, controller.signal);
  controller.abort();
  release();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(inspect).toHaveBeenCalledTimes(1);
});
