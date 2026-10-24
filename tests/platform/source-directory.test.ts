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
const api = vi.hoisted(() => ({ native: false, invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: api.invoke, isTauri: () => api.native }));
import { readDirectoryJson } from '../../src/platform/source-directory';
import { SOURCE_INDEX_MAX_BYTES } from '../../src/discovery/source-index';

const endpoint = 'https://api.github.com/search/repositories?q=iptv&per_page=10';
const fetchMock = vi.fn();
beforeEach(() => {
  api.native = false;
  api.invoke.mockReset();
  fetchMock.mockReset().mockResolvedValue(new Response('{"items":[]}'));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
const read = (url: string, signal = new AbortController().signal) =>
  readDirectoryJson(url, signal, SOURCE_INDEX_MAX_BYTES);

it.each([
  'https://api.github.com/repositories/123',
  'https://api.github.com/repos/iptv-org/iptv',
  'https://api.github.com/repos/iptv-org/iptv/readme?ref=main',
  'https://api.github.com/repos/iptv-org/iptv/git/trees/feature%2Fpublic?recursive=1',
  'https://api.github.com/repos/iptv-org/iptv/contents/data/channels.json?ref=main',
  'https://api.github.com/search/repositories?q=public+iptv&sort=stars&order=desc&per_page=100&page=1000',
])('admits generated directory form %s without credentials or redirects', async (url) => {
  await expect(read(url)).resolves.toEqual({ items: [] });
  expect(fetchMock).toHaveBeenCalledWith(
    url,
    expect.objectContaining({
      redirect: 'error',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    }),
  );
});

it.each([
  'http://api.github.com/repos/o/r',
  'https://API.github.com/repos/o/r',
  'https://api.github.com:443/repos/o/r',
  'https://user@api.github.com/repos/o/r',
  'https://api.github.com/repos/o/r#',
  'https://api.github.com/repos/o/r/',
  'https://api.github.com/repos/o/r?token=secret',
  'https://api.github.com/search/repositories',
  'https://api.github.com/search/repositories?q=',
  'https://api.github.com/search/repositories?q=a&q=b',
  'https://api.github.com/search/repositories?q=a&per_page=101',
  'https://api.github.com/search/repositories?q=a&page=01',
  'https://api.github.com/search/repositories?q=a&order=random',
  'https://api.github.com/search/repositories?q=%FF',
  'https://api.github.com/search/repositories?q=%00',
  'https://api.github.com/repos/o/r/readme?',
  'https://api.github.com/repos/o/r/readme?ref=a&ref=b',
  'https://api.github.com/repos/o/r/git/trees/main/extra',
  'https://api.github.com/repos/o/r/git/trees/main?recursive=0',
  'https://api.github.com/repos/o/r/contents/%2Fprivate',
  'https://api.github.com/repos/o/r/contents/%2e%2e/private',
  'https://api.github.com/repos/o/r/contents/a%5Cb',
  'https://api.github.com/repos/o/r/contents/a%20b',
  'https://api.github.com/repos/o/r/contents/%FF',
  'https://api.github.com/repositories/0',
  'https://api.github.com/repositories/01',
  'https://api.github.com/repositories/9007199254740992',
  'https://api.github.com/repositories/1?ref=main',
])('refuses hostile endpoint before either transport %s', async (url) => {
  await expect(read(url)).rejects.toThrow('Source directory request is invalid.');
  api.native = true;
  await expect(read(url)).rejects.toThrow('Source directory request is invalid.');
  expect(fetchMock).not.toHaveBeenCalled();
  expect(api.invoke).not.toHaveBeenCalled();
});

it('bounds UTF8 query/component lengths, entire URL and caller body limit', async () => {
  for (const url of [
    `https://api.github.com/search/repositories?q=${encodeURIComponent('é'.repeat(257))}`,
    `https://api.github.com/repos/o/${'x'.repeat(101)}`,
    `https://api.github.com/repos/o/r/contents/${'x'.repeat(16_384)}`,
  ])
    await expect(read(url)).rejects.toThrow('Source directory request is invalid.');
  await expect(readDirectoryJson(endpoint, new AbortController().signal, 1)).rejects.toThrow(
    'Source directory request is invalid.',
  );
  expect(fetchMock).not.toHaveBeenCalled();
});

it('handles early cancellation rejection immediately while retaining the held native query', async () => {
  api.native = true;
  let complete!: (value: unknown) => void;
  const query = new Promise((resolve) => {
    complete = resolve;
  });
  const failure = new Error('controlled cancel transport failure');
  api.invoke.mockImplementation((command: string) =>
    command === 'cancel_playlist' ? Promise.reject(failure) : query,
  );
  const controller = new AbortController();
  let settled = false;
  const work = read(endpoint, controller.signal).then(
    () => {
      settled = true;
    },
    (error: unknown) => {
      settled = true;
      return error;
    },
  );
  controller.abort();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  complete({ httpStatus: 200, json: {} });
  expect(await work).toBe(failure);
  expect(api.invoke).toHaveBeenCalledTimes(2);
  const queryId = api.invoke.mock.calls[0]![1].requestId as string;
  expect(api.invoke.mock.calls[1]).toEqual(['cancel_playlist', { requestId: queryId }]);
});

it('joins cancellation even after query completion and removes its abort listener', async () => {
  api.native = true;
  let finishQuery!: (value: unknown) => void;
  let finishCancel!: () => void;
  api.invoke.mockImplementation((command: string) =>
    command === 'cancel_playlist'
      ? new Promise<void>((resolve) => {
          finishCancel = resolve;
        })
      : new Promise((resolve) => {
          finishQuery = resolve;
        }),
  );
  const controller = new AbortController();
  const remove = vi.spyOn(controller.signal, 'removeEventListener');
  let settled = false;
  const work = read(endpoint, controller.signal).catch((error: unknown) => {
    settled = true;
    return error;
  });
  controller.abort();
  finishQuery({ httpStatus: 200, json: {} });
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  finishCancel();
  expect(await work).toBeInstanceOf(DOMException);
  expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
});

it('never dispatches an already canceled request', async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(read(endpoint, controller.signal)).rejects.toBeInstanceOf(DOMException);
  expect(api.invoke).not.toHaveBeenCalled();
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each(['null', 'true', '1', '"secret"', '{'])(
  'refuses browser non-directory JSON %s',
  async (body) => {
    fetchMock.mockResolvedValue(new Response(body));
    await expect(read(endpoint)).rejects.toThrow();
  },
);

it('cancels and releases a browser reader on UTF8 and size refusal', async () => {
  for (const bytes of [new Uint8Array([255]), new Uint8Array(SOURCE_INDEX_MAX_BYTES + 1)]) {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
      },
      cancel,
    });
    fetchMock.mockResolvedValue(new Response(stream));
    await expect(read(endpoint)).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
    expect(stream.locked).toBe(false);
  }
});

it('does not admit a successful status other than exact 200', async () => {
  fetchMock.mockResolvedValue(new Response('{}', { status: 201 }));
  await expect(read(endpoint)).rejects.toThrow('Source directory could not respond.');
});
