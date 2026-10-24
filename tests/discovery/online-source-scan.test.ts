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
import {
  createOnlineSourceScan,
  type OnlineSourceIndex,
} from '../../src/discovery/online-source-scan';
import type { PublishedSourceOption } from '../../src/discovery/source-index';
import { sourceDocumentUrl } from '../../src/discovery/source-index';
import { createSourceIndexService } from '../../src/discovery/source-index-service';
const repo = (id: number) => ({
  id,
  owner: 'fixture',
  name: 'directory' + id,
  branch: 'main',
  provenance: 'https://github.com/fixture/directory' + id,
});
const option = (id: number, format: 'm3u' | 'xmltv' = 'm3u'): PublishedSourceOption => ({
  label: 'Same human name',
  location: 'https://public.fixture.invalid/source' + id,
  provenance: repo(id).provenance,
  format,
  reason: 'Published source candidate; untested.',
  rights: 'unknown',
  documentSha: 'a'.repeat(40),
});
const index = (): OnlineSourceIndex => ({
  repository: vi.fn(async (id) => repo(id)),
  publishedLinks: vi.fn(async (r) => [option(r.id)]),
  openRepository: vi.fn(async () => []),
});
const contents = (id: number, path: string, body: string) => ({
  type: 'file',
  path,
  name: path,
  encoding: 'base64',
  sha: 'a'.repeat(40),
  url: sourceDocumentUrl(repo(id), path),
  size: new TextEncoder().encode(body).length,
  content: btoa(body),
});
const repositoryResponse = (id: number) => ({
  id,
  private: false,
  owner: { login: repo(id).owner },
  name: repo(id).name,
  full_name: `${repo(id).owner}/${repo(id).name}`,
  default_branch: 'main',
  html_url: repo(id).provenance,
});
it('real index adapter discovers a guide index despite a successful playlist README without payload acquisition', async () => {
  const calls: string[] = [];
  const service = createSourceIndexService({
    async json(url) {
      calls.push(url);
      if (url.endsWith('/repositories/1')) return repositoryResponse(1);
      if (url === sourceDocumentUrl(repo(1), 'README.md'))
        return contents(1, 'README.md', 'https://catalog.fixture.invalid/combined.m3u');
      if (url === sourceDocumentUrl(repo(1), 'epglist.txt'))
        return contents(1, 'epglist.txt', 'https://guide.fixture.invalid/current.xml.gz\n');
      throw new Error('unexpected-acquisition');
    },
  });
  const owner = createOnlineSourceScan(service, [1]);
  const result = await owner.start({ query: 'FOX' }, new AbortController().signal);
  expect(result.query).toBe('FOX');
  expect(result.channels).toHaveLength(1);
  expect(result.guides).toHaveLength(1);
  expect(result.guides[0]).toMatchObject({
    allowHttp: false,
    documentSha: 'a'.repeat(40),
    provenance: `${repo(1).provenance}/blob/main/epglist.txt`,
  });
  expect(result.documentOutcomes).toEqual([
    { directoryId: 1, path: 'epglist.txt', status: 'found', guideCount: 1 },
  ]);
  expect(calls).toHaveLength(3);
  expect(calls.every((url) => url.startsWith('https://api.github.com/'))).toBe(true);
  await owner.dispose();
  await service.dispose();
});
it.each(['malformed', 'overflow', 'transport'] as const)(
  'real guide-index %s refuses that whole document while playlists and the next directory remain admitted',
  async (kind) => {
    const service = createSourceIndexService({
      async json(url) {
        const id = url.includes('directory2') || url.endsWith('/repositories/2') ? 2 : 1;
        if (url.includes('/repositories/')) return repositoryResponse(id);
        if (url === sourceDocumentUrl(repo(id), 'README.md'))
          return contents(id, 'README.md', `https://catalog.fixture.invalid/source${id}.m3u`);
        if (url === sourceDocumentUrl(repo(id), 'epglist.txt')) {
          if (id === 1 && kind === 'transport') throw new Error('private-token-payload');
          const body =
            id === 2
              ? 'https://guide.fixture.invalid/valid.xml'
              : kind === 'malformed'
                ? 'https://guide.fixture.invalid/valid.xml\nhttps://user:secret@guide.fixture.invalid/private.xml'
                : Array.from(
                    { length: 1001 },
                    (_, i) => `https://guide.fixture.invalid/${i}.xml`,
                  ).join('\n');
          return contents(id, 'epglist.txt', body);
        }
        throw new Error('unexpected-acquisition');
      },
    });
    const owner = createOnlineSourceScan(service, [1, 2]);
    const result = await owner.start({ query: '' }, new AbortController().signal);
    expect(result.channels).toHaveLength(2);
    expect(result.guides.map((guide) => guide.location)).toEqual([
      'https://guide.fixture.invalid/valid.xml',
    ]);
    expect(result.documentOutcomes?.[0]).toEqual({
      directoryId: 1,
      path: 'epglist.txt',
      status: 'failed',
      guideCount: 0,
    });
    expect(result.outcomes.every((outcome) => outcome.status === 'found')).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/private-token-payload|user:secret/);
    await owner.dispose();
    await service.dispose();
  },
);
it('cancel joins the real held guide document and excludes late links and the next directory', async () => {
  let finish!: (value: unknown) => void;
  const calls: string[] = [];
  const service = createSourceIndexService({
    async json(url) {
      calls.push(url);
      if (url.endsWith('/repositories/1')) return repositoryResponse(1);
      if (url === sourceDocumentUrl(repo(1), 'README.md'))
        return contents(1, 'README.md', 'https://catalog.fixture.invalid/combined.m3u');
      return new Promise((resolve) => {
        finish = resolve;
      });
    },
  });
  const owner = createOnlineSourceScan(service, [1, 2]);
  const work = owner.start({ query: '' }, new AbortController().signal);
  for (let i = 0; i < 30 && !finish; i++) await Promise.resolve();
  expect(finish).toBeTypeOf('function');
  let joined = false;
  const refused = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  const cancellation = owner.cancel().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  finish(contents(1, 'epglist.txt', 'https://guide.fixture.invalid/late.xml'));
  await cancellation;
  await refused;
  expect(calls).toHaveLength(3);
  await owner.dispose();
  await service.dispose();
});
it('does no work before explicit action, then resolves all seven directories retaining query/region/clock', async () => {
  const host = index(),
    owner = createOnlineSourceScan(host, [1, 2, 3, 4, 5, 6, 7], () => 123);
  expect(host.repository).not.toHaveBeenCalled();
  const input = {
    query: 'FOX Chicago',
    region: { country: 'US', state: 'US-IL', origin: 'manual' as const },
  };
  const pending = owner.start(input, new AbortController().signal);
  input.query = 'changed';
  input.region.state = 'US-TX';
  const result = await pending;
  expect(result).toMatchObject({
    query: 'FOX Chicago',
    region: { state: 'US-IL' },
    startedAtMs: 123,
  });
  expect(host.repository).toHaveBeenCalledTimes(7);
  expect(result.channels).toHaveLength(7);
  expect(result.guides).toEqual([]);
  expect(result.outcomes.every((o) => o.status === 'found')).toBe(true);
  expect(result.channels.every((c) => c.allowHttp === false)).toBe(true);
  await owner.dispose();
});
it('isolates failed directories and exact-deduplicates locations while keeping provenance and different same-name files', async () => {
  const host = index();
  host.repository = vi.fn(async (id) => {
    if (id === 2) throw new Error('private-payload');
    return repo(id);
  });
  host.publishedLinks = vi.fn(async (r) =>
    r.id === 3
      ? [{ ...option(1), provenance: r.provenance }, option(3, 'xmltv'), option(4)]
      : [option(1)],
  );
  const result = await createOnlineSourceScan(host, [1, 2, 3]).start(
    { query: 'Kids' },
    new AbortController().signal,
  );
  expect(result.outcomes.map((o) => o.status)).toEqual(['found', 'failed', 'found']);
  expect(result.channels).toHaveLength(2);
  expect(result.channels[0]!.directoryIds).toEqual([1, 3]);
  expect(result.channels[0]!.provenances).toEqual([repo(1).provenance, repo(3).provenance]);
  expect(result.guides).toHaveLength(1);
  expect(JSON.stringify(result)).not.toContain('private-payload');
});
it('uses joined README fallback then tree only when no published candidates and never treats empty as availability', async () => {
  const host = index();
  host.publishedLinks = vi.fn(async () => []);
  host.openRepository = vi.fn(async () => []);
  const result = await createOnlineSourceScan(host, [1]).start(
    { query: '' },
    new AbortController().signal,
  );
  expect(host.publishedLinks).toHaveBeenCalledTimes(3);
  expect(host.openRepository).toHaveBeenCalledOnce();
  expect(result.outcomes[0]!.status).toBe('none');
  expect(result.channels).toEqual([]);
});
it('cancel joins a noncooperative active index request before settlement and never admits the next directory', async () => {
  const host = index();
  let finish!: (value: ReturnType<typeof repo>) => void;
  host.repository = vi.fn(
    () => new Promise<ReturnType<typeof repo>>((resolve) => (finish = resolve)),
  );
  const owner = createOnlineSourceScan(host, [1, 2]);
  const work = owner.start({ query: 'News' }, new AbortController().signal);
  await Promise.resolve();
  let joined = false;
  const canceled = owner.cancel().then(() => (joined = true));
  await Promise.resolve();
  expect(joined).toBe(false);
  const refused = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  finish(repo(1));
  await canceled;
  await refused;
  expect(host.repository).toHaveBeenCalledTimes(1);
  expect(host.publishedLinks).not.toHaveBeenCalled();
  await owner.dispose();
});
it.each(['http', 'credentials', 'overflow', 'wrong-repo'] as const)(
  'refuses %s directory atomically while others continue',
  async (kind) => {
    const host = index();
    if (kind === 'wrong-repo') host.repository = vi.fn(async (id) => repo(id === 1 ? 3 : id));
    host.publishedLinks = vi.fn(async (r) =>
      r.id === 1
        ? kind === 'overflow'
          ? Array.from({ length: 101 }, (_, i) => option(i))
          : [
              {
                ...option(1),
                location:
                  kind === 'http'
                    ? 'http://public.fixture.invalid/catalog'
                    : 'https://user:pass@public.fixture.invalid/catalog',
              },
            ]
        : [option(2)],
    );
    const result = await createOnlineSourceScan(host, [1, 2]).start(
      { query: 'Sports' },
      new AbortController().signal,
    );
    expect(result.outcomes[0]!.status).toBe('failed');
    expect(result.channels.map((c) => c.location)).toEqual([option(2).location]);
  },
);
it('refuses invalid scope, overlapping action and work after disposal without unowned acquisition', async () => {
  const host = index();
  expect(() =>
    createOnlineSourceScan(
      host,
      Array.from({ length: 21 }, (_, i) => i + 1),
    ),
  ).toThrow();
  expect(() => createOnlineSourceScan(host, [1, 1])).toThrow();
  const owner = createOnlineSourceScan(host, []);
  expect((await owner.start({ query: '' }, new AbortController().signal)).channels).toEqual([]);
  expect(host.repository).not.toHaveBeenCalled();
  await owner.dispose();
  await expect(owner.start({ query: '' }, new AbortController().signal)).rejects.toThrow('closed');
});

it('overlapping actions are refused and disposal joins pending publication-free metadata work', async () => {
  const host = index();
  let settle!: (options: readonly PublishedSourceOption[]) => void;
  host.publishedLinks = vi.fn(
    () => new Promise<readonly PublishedSourceOption[]>((resolve) => (settle = resolve)),
  );
  const owner = createOnlineSourceScan(host, [1, 2]);
  const work = owner.start({ query: 'FOX' }, new AbortController().signal);
  for (let i = 0; i < 5 && !settle; i++) await Promise.resolve();
  await expect(owner.start({ query: 'ABC' }, new AbortController().signal)).rejects.toThrow(
    'already running',
  );
  let joined = false;
  const disposal = owner.dispose().then(() => (joined = true));
  await Promise.resolve();
  expect(joined).toBe(false);
  const canceled = expect(work).rejects.toMatchObject({ name: 'AbortError' });
  settle([option(1)]);
  await disposal;
  await canceled;
  expect(host.repository).toHaveBeenCalledTimes(1);
  expect(host.openRepository).not.toHaveBeenCalled();
});
it('pre-aborted action and malformed query start no directory request', async () => {
  const host = index(),
    owner = createOnlineSourceScan(host, [1]);
  const controller = new AbortController();
  controller.abort();
  expect(() => owner.start({ query: 'News' }, controller.signal)).toThrow();
  await expect(
    owner.start({ query: 'x'.repeat(257) }, new AbortController().signal),
  ).rejects.toThrow('bounds');
  expect(host.repository).not.toHaveBeenCalled();
});
it('reports quota refusals separately from unavailable directories, with the published reset', async () => {
  const { emptyOnlineDiscoveryText } = await import('../../src/ui/online-discovery-text');
  const limited = JSON.stringify({ code: 'http-rate-limited', rateLimitReset: '1760000000' });
  const failing: OnlineSourceIndex = {
    repository: vi.fn(async (id: number) => {
      if (id === 1) throw limited;
      if (id === 2) throw new Error('unavailable');
      return repo(id);
    }),
    publishedLinks: vi.fn(async () => []),
    openRepository: vi.fn(async () => []),
  };
  const result = await createOnlineSourceScan(failing, [1, 2]).start(
    { query: '' },
    new AbortController().signal,
  );
  expect(result.outcomes).toEqual([
    {
      directoryId: 1,
      status: 'failed',
      channelCount: 0,
      guideCount: 0,
      reason: 'rate-limited',
      retryAtMs: 1760000000000,
    },
    { directoryId: 2, status: 'failed', channelCount: 0, guideCount: 0 },
  ]);
  expect(result.rateLimited).toEqual({ retryAtMs: 1760000000000 });
  expect(emptyOnlineDiscoveryText(result, 1759999000000)).toContain('rate-limited until');
  expect(emptyOnlineDiscoveryText(result, 1760000000001)).toContain('about an hour');
  expect(emptyOnlineDiscoveryText({})).toContain('No public channel sources could be found');
  const unknownReset = await createOnlineSourceScan(
    {
      ...failing,
      repository: vi.fn(async () => {
        throw JSON.stringify({ code: 'http-rate-limited' });
      }),
    },
    [3],
  ).start({ query: '' }, new AbortController().signal);
  expect(unknownReset.rateLimited).toEqual({ retryAtMs: null });
  const fine = await createOnlineSourceScan(index(), [4]).start(
    { query: '' },
    new AbortController().signal,
  );
  expect(fine.rateLimited).toBeUndefined();
});
