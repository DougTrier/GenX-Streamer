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

import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openPagedParser } from '../../src/catalog/paged-parser-service';
import type {
  PagedParserRequest,
  PagedParserResponse,
} from '../../src/catalog/paged-parser-protocol';
import { createPagedSourceCollection } from '../../src/discovery/paged-source-collection';

const source = {
  id: 'fixture',
  name: 'Fixture',
  kind: 'url' as const,
  location: 'https://example.invalid/list',
};
const playlist = (count: number) =>
  '#EXTM3U\n' +
  Array.from(
    { length: count },
    () =>
      '#EXTINF:-1 tvg-id="same" group-title="News",Same channel\nhttps://example.invalid/live\n',
  ).join('');
let makeOwner: () => (request: PagedParserRequest) => PagedParserResponse;
class FixtureWorker {
  static instances: FixtureWorker[] = [];
  owner = makeOwner();
  onmessage: ((event: MessageEvent<PagedParserResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  posted: PagedParserRequest[] = [];
  terminated = 0;
  constructor(
    readonly url: URL,
    readonly options: WorkerOptions,
  ) {
    FixtureWorker.instances.push(this);
  }
  postMessage(request: PagedParserRequest) {
    this.posted.push(structuredClone(request));
    const response = this.owner(structuredClone(request));
    queueMicrotask(() =>
      this.onmessage?.({ data: structuredClone(response) } as MessageEvent<PagedParserResponse>),
    );
  }
  terminate() {
    expect([this.onmessage, this.onerror, this.onmessageerror]).toEqual([null, null, null]);
    this.terminated++;
  }
}
beforeEach(async () => {
  vi.stubGlobal('self', { onmessage: null, postMessage: vi.fn() });
  const module = await import('../../src/catalog/paged-parser-worker');
  makeOwner = module.createPagedParserOwner;
  FixtureWorker.instances = [];
  vi.stubGlobal('Worker', FixtureWorker);
});
afterEach(() => vi.unstubAllGlobals());

it('retains all duplicate raw entries behind the default worker and pulls one page per demand', async () => {
  const collected = await openPagedParser(
    { text: playlist(130), source },
    new AbortController().signal,
  );
  const worker = FixtureWorker.instances[0]!;
  expect(worker.options).toEqual({ type: 'module' });
  expect(worker.url.pathname).toContain('paged-parser-worker.ts');
  expect(collected.entryCount).toBe(130);
  expect(Object.keys(collected)).not.toContain('channels');
  expect(worker.posted.map((value) => value.kind)).toEqual(['open']);
  const pages = collected.pages[Symbol.asyncIterator]();
  const first = await pages.next();
  expect(first.value).toHaveLength(64);
  expect(worker.posted.map((value) => value.kind)).toEqual(['open', 'next']);
  expect((await pages.next()).value).toHaveLength(64);
  expect((await pages.next()).value).toHaveLength(2);
  expect(await pages.next()).toEqual({ value: undefined, done: true });
  expect(worker.terminated).toBe(1);
  await collected.dispose();
  expect(worker.terminated).toBe(1);
});

it('rejects malformed final input before any source page can be promoted', async () => {
  await expect(
    openPagedParser(
      { text: playlist(2) + '#EXTINF:-1,Missing URL\n', source },
      new AbortController().signal,
    ),
  ).rejects.toThrow('invalid or unsupported');
  expect(FixtureWorker.instances[0]!.posted.map((request) => request.kind)).toEqual(['open']);
  expect(FixtureWorker.instances[0]!.terminated).toBe(1);
});

it('marks warning-preview omissions explicitly without reducing the raw source count', async () => {
  const collected = await openPagedParser(
    {
      text: playlist(1),
      source,
      warnings: Array.from({ length: 50 }, (_, index) => `Warning ${index}`),
    },
    new AbortController().signal,
  );
  expect(collected.warningCount).toBe(50);
  expect(collected.warnings).toHaveLength(32);
  expect(collected.entryCount).toBe(1);
  await collected.dispose();
});

it('joins the actual pending input promise when cancellation cannot immediately settle fetch', async () => {
  let settle!: () => void;
  const inspected = new Promise<{ kind: 'catalog'; text: string }>((resolve) => {
    settle = () => resolve({ kind: 'catalog', text: playlist(1) });
  });
  const owner = createPagedSourceCollection({ inspectSource: () => inspected });
  const result = owner.collect(source, new AbortController().signal);
  const rejection = expect(result).rejects.toMatchObject({ name: 'AbortError' });
  await Promise.resolve();
  let joined = false;
  const stopping = owner.cancel().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  settle();
  await rejection;
  await stopping;
  expect(joined).toBe(true);
  expect(FixtureWorker.instances).toHaveLength(0);
});
