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

import { describe, it, expect, vi } from 'vitest';
import { createPageInput, validatePageUrl } from '../../src/discovery/page-input';
import { extractPageCandidates, type DiscoveryPage } from '../../src/discovery/candidates';
function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
const page: DiscoveryPage = {
  pageUrl: 'https://fixture.invalid/page',
  responseUrl: 'https://fixture.invalid/base/',
  html: '<html><a href="source?token=keep#fragment">Channels</a></html>',
};
function workers(hold = false) {
  const terminate = vi.fn();
  let message: ((event: MessageEvent) => void) | null = null;
  const worker = {
    onmessage: null,
    onerror: null,
    terminate,
    postMessage: vi.fn((input: { page: DiscoveryPage }) => {
      if (!hold)
        queueMicrotask(() =>
          message?.({
            data: { ok: true, result: extractPageCandidates(input.page) },
          } as MessageEvent),
        );
    }),
  };
  Object.defineProperty(worker, 'onmessage', {
    get: () => message,
    set: (v) => {
      message = v;
    },
  });
  return {
    factory: () => worker as unknown as Worker,
    terminate,
    worker,
    deliver: () =>
      message?.({ data: { ok: true, result: extractPageCandidates(page) } } as MessageEvent),
  };
}
describe('finite owned page input', () => {
  it('requires explicit HTTP permission and refuses credentials/nonweb URLs', () => {
    expect(() => validatePageUrl('http://fixture.invalid', false)).toThrow('HTTP');
    expect(() => validatePageUrl('https://user:secret@fixture.invalid', true)).toThrow(
      'credentials',
    );
    expect(() => validatePageUrl('file:///private', true)).toThrow('HTTP');
    expect(validatePageUrl('https://fixture.invalid/a?token=keep#fragment', false)).toBe(
      'https://fixture.invalid/a?token=keep',
    );
  });
  it('reads streams, validates final URL, and uses a disposable parser worker', async () => {
    const w = workers();
    const fetcher = vi.fn(async () => {
      const r = new Response(page.html, { headers: { 'content-type': 'text/html' } });
      Object.defineProperty(r, 'url', { value: page.responseUrl });
      return r;
    });
    const result = await createPageInput({ fetch: fetcher, workerFactory: w.factory }).inspect(
      page.pageUrl,
      false,
    );
    expect(result.candidates[0].url).toBe('https://fixture.invalid/base/source?token=keep');
    expect(fetcher.mock.calls[0]).toHaveLength(2);
    expect(w.terminate).toHaveBeenCalledOnce();
  });
  it('refuses downgrade redirects before following and refuses opaque browser redirects', async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, { status: 302, headers: { location: 'http://fixture.invalid/source' } }),
    );
    await expect(createPageInput({ fetch: fetcher }).inspect(page.pageUrl, false)).rejects.toThrow(
      'HTTP',
    );
    expect(fetcher).toHaveBeenCalledOnce();
    const opaque = new Response();
    Object.defineProperty(opaque, 'type', { value: 'opaqueredirect' });
    await expect(
      createPageInput({ fetch: async () => opaque }).inspect(page.pageUrl, false),
    ).rejects.toThrow('redirect safely');
  });
  it('fails whole input on oversized streaming body, invalid UTF8 and nonHTML', async () => {
    for (const response of [
      new Response(new Uint8Array(2 * 1024 * 1024 + 1)),
      new Response(new Uint8Array([255])),
      new Response('#EXTM3U'),
    ]) {
      await expect(
        createPageInput({ fetch: async () => response }).inspect(page.pageUrl, false),
      ).rejects.toThrow();
    }
  });
  it('native cancel joins inspect settlement AND cancellation cleanup before acknowledging', async () => {
    const input = deferred<DiscoveryPage>(),
      cleanup = deferred<void>();
    const inspect = vi.fn(() => input.promise),
      cancel = vi.fn(() => cleanup.promise);
    const w = workers();
    const owner = createPageInput({ native: { inspect, cancel }, workerFactory: w.factory });
    const pending = owner.inspect(page.pageUrl, false);
    const rejected = expect(pending).rejects.toThrow('canceled');
    let acknowledged = false;
    const stopping = owner.cancel().then(() => {
      acknowledged = true;
    });
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
    input.resolve(page);
    await Promise.resolve();
    await Promise.resolve();
    expect(acknowledged).toBe(false);
    cleanup.resolve();
    await stopping;
    await rejected;
    expect(w.worker.postMessage).not.toHaveBeenCalled();
  });
  it('worker cancellation terminates ownership and discards late messages', async () => {
    const w = workers(true);
    const owner = createPageInput({
      native: { inspect: async () => page, cancel: async () => undefined },
      workerFactory: w.factory,
    });
    const pending = owner.inspect(page.pageUrl, false);
    const rejected = expect(pending).rejects.toThrow('canceled');
    for (let i = 0; i < 10 && !w.worker.postMessage.mock.calls.length; i++) await Promise.resolve();
    expect(w.worker.postMessage).toHaveBeenCalledOnce();
    await owner.cancel();
    w.deliver();
    await rejected;
    expect(w.terminate).toHaveBeenCalledOnce();
  });
  it('redacts raw fetch/native diagnostics and rejects mismatched native request identity', async () => {
    await expect(
      createPageInput({
        fetch: async () => {
          throw new Error('https://secret.invalid/?token=private');
        },
      }).inspect(page.pageUrl, false),
    ).rejects.not.toThrow('private');
    await expect(
      createPageInput({
        native: {
          inspect: async () => ({ ...page, pageUrl: 'https://other.invalid' }),
          cancel: async () => undefined,
        },
      }).inspect(page.pageUrl, false),
    ).rejects.toThrow('another request');
  });
  it('deadline cancels native work and still joins its settlement', async () => {
    vi.useFakeTimers();
    try {
      const input = deferred<DiscoveryPage>();
      const cancel = vi.fn(async () => undefined);
      const owner = createPageInput({ native: { inspect: () => input.promise, cancel } });
      const pending = owner.inspect(page.pageUrl, false);
      const rejected = expect(pending).rejects.toThrow('20 second');
      await vi.advanceTimersByTimeAsync(20_000);
      expect(cancel).toHaveBeenCalledOnce();
      input.resolve(page);
      await rejected;
    } finally {
      vi.useRealTimers();
    }
  });
});
