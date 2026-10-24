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
import { exportPlaylistInWorker } from '../../src/catalog/playlist-export-service';
import { serializePlaylistExport } from '../../src/catalog/playlist-export';
import type { PlaylistExportInput } from '../../src/catalog/playlist-export';
class FakeWorker {
  static instances: FakeWorker[] = [];
  static failPost = false;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  input?: PlaylistExportInput;
  terminated = 0;
  constructor() {
    FakeWorker.instances.push(this);
  }
  postMessage(input: PlaylistExportInput) {
    if (FakeWorker.failPost) throw new Error('private');
    this.input = structuredClone(input);
  }
  terminate() {
    expect([this.onmessage, this.onerror, this.onmessageerror]).toEqual([null, null, null]);
    this.terminated++;
  }
}
const input = (): PlaylistExportInput => ({
  sources: [{ id: 'source', name: 'Fixture', kind: 'file', location: 'fixture.m3u' }],
  channels: [
    {
      id: 'one',
      sourceId: 'source',
      name: 'Fixture',
      category: '',
      urls: ['https://example.invalid/live'],
    },
  ],
});
const current = () => FakeWorker.instances.at(-1)!;
beforeEach(() => {
  FakeWorker.instances = [];
  FakeWorker.failPost = false;
  vi.stubGlobal('Worker', FakeWorker);
});
afterEach(() => vi.unstubAllGlobals());
it('uses one synchronous platform snapshot and terminates before exposing its result', async () => {
  const value = input(),
    controller = new AbortController();
  const clone = vi.spyOn(globalThis, 'structuredClone');
  const pending = exportPlaylistInWorker(value, controller.signal);
  expect(clone).toHaveBeenCalledTimes(1);
  clone.mockRestore();
  value.channels[0]!.name = 'late mutation';
  const worker = current(),
    result = serializePlaylistExport(worker.input!);
  expect(result.text).not.toContain('late mutation');
  worker.onmessage!({ data: { ok: true, result } } as MessageEvent);
  expect(await pending).toEqual(result);
  expect(worker.terminated).toBe(1);
});
it.each(['abort', 'error', 'messageerror', 'post', 'invalid-result', 'unsafe-error'] as const)(
  'cleans owned callbacks and listener on %s',
  async (kind) => {
    FakeWorker.failPost = kind === 'post';
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, 'addEventListener'),
      remove = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = exportPlaylistInWorker(input(), controller.signal),
      worker = current();
    const staleMessage = worker.onmessage;
    const rejected = expect(pending).rejects.toThrow(
      kind === 'abort' ? 'canceled' : /^playlist-export-/,
    );
    if (kind === 'abort') controller.abort();
    if (kind === 'error') worker.onerror!();
    if (kind === 'messageerror') worker.onmessageerror!();
    if (kind === 'invalid-result')
      worker.onmessage!({ data: { ok: true, result: { text: 'secret' } } } as MessageEvent);
    if (kind === 'unsafe-error')
      worker.onmessage!({
        data: { ok: false, code: 'private https://secret.invalid/token' },
      } as MessageEvent);
    await rejected;
    staleMessage?.({ data: { ok: true, result: {} } } as MessageEvent);
    expect(worker.terminated).toBe(1);
    expect(add).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
  },
);
it('rejects an already canceled export without acquiring a worker', () => {
  const controller = new AbortController();
  controller.abort();
  expect(() => exportPlaylistInWorker(input(), controller.signal)).toThrow();
  expect(FakeWorker.instances).toHaveLength(0);
});
it('returns only allowlisted worker refusals', async () => {
  const pending = exportPlaylistInWorker(input(), new AbortController().signal);
  current().onmessage!({ data: { ok: false, code: 'playlist-export-line-limit' } } as MessageEvent);
  await expect(pending).rejects.toThrow('playlist-export-line-limit');
});

it('redacts a worker-construction failure before admitting a listener', async () => {
  vi.stubGlobal(
    'Worker',
    class {
      constructor() {
        throw new Error('private construction payload');
      }
    },
  );
  await expect(exportPlaylistInWorker(input(), new AbortController().signal)).rejects.toThrow(
    'playlist-export-worker-failed',
  );
});
it('the actual worker handler returns canonical output and only fixed failure codes', async () => {
  const realm = {
    onmessage: undefined as ((event: MessageEvent) => void) | undefined,
    postMessage: vi.fn(),
  };
  vi.stubGlobal('self', realm);
  vi.resetModules();
  await import('../../src/catalog/playlist-export-worker');
  const value = input();
  realm.onmessage!({ data: value } as MessageEvent);
  expect(realm.postMessage).toHaveBeenLastCalledWith({
    ok: true,
    result: serializePlaylistExport(value),
  });
  realm.onmessage!({
    data: { sources: [], channels: [{ name: 'secret fixture' }] },
  } as MessageEvent);
  expect(realm.postMessage).toHaveBeenLastCalledWith({
    ok: false,
    code: 'playlist-export-catalog-invalid',
  });
});
