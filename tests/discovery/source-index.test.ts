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
  parseSourceRepositories,
  parseSourceTree,
  sourceSearchUrl,
  sourceTreeUrl,
  SOURCE_INDEX_MAX_BYTES,
  parsePublishedSourceLinks,
  parseSourceRepository,
  sourceDocumentUrl,
  sourceRepositoryIdUrl,
} from '../../src/discovery/source-index';
import { createSourceIndexService } from '../../src/discovery/source-index-service';

const sha = 'a'.repeat(40);
const response = () => ({
  total_count: 1,
  incomplete_results: false,
  items: [
    {
      id: 1,
      private: false,
      owner: { login: 'Example' },
      name: 'sources',
      full_name: 'Example/sources',
      default_branch: 'release/current',
      html_url: 'https://github.com/Example/sources',
    },
  ],
});
const repository = () => parseSourceRepositories(response()).repositories[0]!;
const tree = () => ({
  sha,
  url: `https://api.github.com/repos/Example/sources/git/trees/${sha}`,
  truncated: false,
  tree: [
    { path: 'US/News list.m3u8', type: 'blob', mode: '100644', sha, size: 50 },
    { path: 'guides/current.xml.gz', type: 'blob', mode: '100644', sha, size: 60 },
    { path: 'linked.m3u', type: 'blob', mode: '120000', sha, size: 20 },
  ],
});
const signal = () => new AbortController().signal;
const document = (body: string, path = 'README.md') => ({
  type: 'file',
  path,
  name: path,
  url: sourceDocumentUrl(repository(), path),
  encoding: 'base64',
  sha,
  size: new TextEncoder().encode(body).length,
  content: btoa(String.fromCharCode(...new TextEncoder().encode(body))),
});

describe('bounded inert source index', () => {
  it('admits an exact publisher guide index with gzip links and document provenance', () => {
    const links = parsePublishedSourceLinks(
      document(
        'https://guide.example/current.xml.gz\n\nhttps://guide.example/next.xml\nhttps://guide.example/current.xml.gz\n',
        'epglist.txt',
      ),
      repository(),
      'epglist.txt',
    );
    expect(links).toHaveLength(2);
    expect(links.every((option) => option.format === 'xmltv' && option.rights === 'unknown')).toBe(
      true,
    );
    expect(links[0]).toMatchObject({
      provenance: 'https://github.com/Example/sources/blob/release%2Fcurrent/epglist.txt',
      documentSha: sha,
    });
  });
  it.each([
    'not a URL',
    'http://guide.example/current.xml',
    'https://user:secret@guide.example/current.xml',
    'https://guide.example/current.xml?token=secret',
    'https://guide.example/current.xml#fragment',
    'https://guide.example/list.m3u',
    'https://127.0.0.1/current.xml',
    'https://guide.example/current.xml,',
  ])('refuses the whole guide index containing an inadmissible line: %s', (line) => {
    expect(() =>
      parsePublishedSourceLinks(
        document(`https://guide.example/valid.xml\n${line}\n`, 'epglist.txt'),
        repository(),
        'epglist.txt',
      ),
    ).toThrow();
  });
  it('looks up a known numeric repository with exact public identity admission', () => {
    expect(sourceRepositoryIdUrl(42)).toBe('https://api.github.com/repositories/42');
    expect(parseSourceRepository(response().items[0], 1)).toEqual(repository());
    for (const value of [
      { ...response().items[0], private: true },
      { ...response().items[0], id: 2 },
    ])
      expect(() => parseSourceRepository(value, 1)).toThrow();
    expect(() => sourceRepositoryIdUrl(-1)).toThrow();
  });
  it('resolves published document links without reading playlists or executing HTML', () => {
    const options = parsePublishedSourceLinks(
      document(
        '[Combined](https://catalog.example/index.m3u)\n' +
          '`https://catalog.example/index.m3u`\n<a href="https://guide.example/current.xml.gz">Guide</a>\n' +
          'https://github.com/Example/sources/blob/main/not-payload.m3u\n' +
          'http://catalog.example/ungranted.m3u\nhttps://user:secret@catalog.example/private.m3u\n' +
          'https://127.0.0.1/private.m3u\nhttps://catalog.example/private.m3u?token=secret',
      ),
      repository(),
      'README.md',
    );
    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({
      location: 'https://catalog.example/index.m3u',
      rights: 'unknown',
      documentSha: sha,
    });
    expect(options[1]?.format).toBe('xmltv');
    expect(Object.isFrozen(options)).toBe(true);
  });
  it('refuses malformed base64, mismatched contents path, wrong encoding and byte size', () => {
    const valid = document('https://catalog.example/index.m3u');
    for (const value of [
      { ...valid, content: '!!!!' },
      { ...valid, content: 'Zh==' },
      { ...valid, path: 'scripts/install.js' },
      { ...valid, size: valid.size + 1 },
      { ...valid, encoding: 'none' },
      { ...valid, url: 'https://evil.example/README.md' },
    ])
      expect(() => parsePublishedSourceLinks(value, repository(), 'README.md')).toThrow();
    expect(() => sourceDocumentUrl(repository(), '../README.md')).toThrow();
  });
  it('repository admission permits document discovery with one bounded contents operation', async () => {
    const calls: string[] = [];
    const service = createSourceIndexService({
      async json(url) {
        calls.push(url);
        return calls.length === 1
          ? response().items[0]
          : document('https://catalog.example/index.m3u');
      },
    });
    const repo = await service.repository(1, signal());
    const options = await service.publishedLinks(repo, 'README.md', signal());
    expect(calls).toEqual([
      'https://api.github.com/repositories/1',
      sourceDocumentUrl(repo, 'README.md'),
    ]);
    expect(options).toHaveLength(1);
    await service.dispose();
  });
  it('document cancellation joins transport and refuses the late contents without publishing', async () => {
    let release!: (value: unknown) => void;
    const service = createSourceIndexService({
      json(url) {
        if (url.includes('/repositories/')) return Promise.resolve(response().items[0]);
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const repo = await service.repository(1, signal()),
      controller = new AbortController();
    const work = service.publishedLinks(repo, 'README.md', controller.signal);
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    let settled = false;
    const disposal = service.dispose().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release(document('https://catalog.example/index.m3u'));
    await rejected;
    await disposal;
  });
  it('constructs simple encoded repository queries without user qualifiers', () => {
    expect(sourceSearchUrl('Ｆｏｘ sports')).toContain(
      'Fox%20sports%20in%3Aname%2Cdescription%2Creadme',
    );
    for (const query of ['', 'user:private', 'https://example.com', 'x'.repeat(129)])
      expect(() => sourceSearchUrl(query)).toThrow();
  });
  it('reports incomplete search and more results without claiming exhaustive discovery', () => {
    expect(
      parseSourceRepositories({ ...response(), total_count: 30, incomplete_results: true }),
    ).toMatchObject({ incomplete: true, moreAvailable: true });
    expect(() =>
      parseSourceRepositories({ ...response(), items: Array(11).fill(response().items[0]) }),
    ).toThrow();
    expect(() =>
      parseSourceRepositories({
        ...response(),
        items: [{ ...response().items[0], html_url: 'https://evil.example' }],
      }),
    ).toThrow();
  });
  it('encodes exact branch and file segments, retains snapshot hashes, excludes symlinks', () => {
    expect(sourceTreeUrl(repository())).toContain('release%2Fcurrent?recursive=1');
    const options = parseSourceTree(tree(), repository());
    expect(options).toHaveLength(2);
    expect(options[0]).toMatchObject({
      location:
        'https://raw.githubusercontent.com/Example/sources/release%2Fcurrent/US/News%20list.m3u8',
      rights: 'unknown',
      treeSha: sha,
      blobSha: sha,
    });
    expect(options[0]?.reason).toContain('HLS manifest');
    expect(Object.isFrozen(options[0])).toBe(true);
    expect(options[1]?.format).toBe('xmltv');
  });
  it('refuses truncated, foreign identity, traversal, duplicate paths and malformed hashes', () => {
    for (const altered of [
      { ...tree(), truncated: true },
      { ...tree(), url: 'https://api.github.com/repos/Other/repo/git/trees/' + sha },
      { ...tree(), sha: 'not-a-sha' },
      { ...tree(), tree: [{ ...tree().tree[0], path: '../x.m3u' }] },
      { ...tree(), tree: [tree().tree[0], tree().tree[0]] },
    ])
      expect(() => parseSourceTree(altered, repository())).toThrow();
  });
  it('fetches one search then one explicit tree only, and rejects invented/stale choices', async () => {
    const calls: string[] = [];
    const service = createSourceIndexService({
      async json(url, _signal, bytes) {
        expect(bytes).toBe(SOURCE_INDEX_MAX_BYTES);
        calls.push(url);
        return calls.length === 1 ? response() : tree();
      },
    });
    await expect(service.openRepository(repository(), signal())).rejects.toThrow();
    const found = await service.search('news', signal());
    expect(calls).toHaveLength(1);
    await service.openRepository(found.repositories[0]!, signal());
    expect(calls).toHaveLength(2);
    expect(calls.every((url) => new URL(url).hostname === 'api.github.com')).toBe(true);
    await expect(
      service.openRepository({ ...repository(), branch: 'other' }, signal()),
    ).rejects.toThrow();
    await service.dispose();
  });
  it('cancel and dispose join actual deferred transport and never publish its late result', async () => {
    let release!: (value: unknown) => void;
    let nativeSignal!: AbortSignal;
    const service = createSourceIndexService({
      json(_url, captured) {
        nativeSignal = captured;
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    });
    const controller = new AbortController();
    const work = service.search('sports', controller.signal);
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    await Promise.resolve();
    controller.abort();
    let closed = false;
    const close = service.dispose().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(nativeSignal.aborted).toBe(true);
    expect(closed).toBe(false);
    release(response());
    await rejected;
    await close;
    await expect(service.search('news', signal())).rejects.toThrow();
  });
  it('allows no overlap and refuses oversized JSON without partial results', async () => {
    let release!: (value: unknown) => void;
    const service = createSourceIndexService({
      json: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const work = service.search('sports', signal());
    const refused = expect(work).rejects.toThrow('limit');
    await Promise.resolve();
    await expect(service.search('news', signal())).rejects.toThrow('already running');
    release({ ...response(), padding: 'x'.repeat(SOURCE_INDEX_MAX_BYTES) });
    await refused;
    await service.dispose();
  });
});
