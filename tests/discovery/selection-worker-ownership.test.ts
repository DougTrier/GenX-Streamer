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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { prepareScanInWorker } from '../../src/discovery/selection';
import { defaultPreferences } from '../../src/preferences';
import type { PreparedScanCommit } from '../../src/discovery/prepare-selection';
class FakeWorker {
  static current: FakeWorker;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  data: unknown;
  terminated = 0;
  constructor() {
    FakeWorker.current = this;
  }
  postMessage(data: unknown): void {
    // Model the real Worker API's synchronous snapshot, including DataCloneError.
    this.data = structuredClone(data);
  }
  terminate(): void {
    expect([this.onmessage, this.onerror, this.onmessageerror]).toEqual([null, null, null]);
    this.terminated++;
  }
}
const catalog = { schemaVersion: 1 as const, sources: [], channels: [] };
const selection = { sessionRevision: 'revision', sources: [], failedSourceIds: [] };
afterEach(() => vi.unstubAllGlobals());
describe('selection worker ownership', () => {
  it('sends an immutable health/context snapshot and returns its prepared health output', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const health = {
      previousHealth: [],
      review: {
        candidates: [],
        observations: [],
        platform: 'windows',
        observerProfile: 'inspection-v1',
      },
    };
    const pending = prepareScanInWorker(
      catalog,
      defaultPreferences(),
      selection,
      [],
      new AbortController().signal,
      health,
    );
    health.review.observerProfile = 'late-profile';
    selection.sessionRevision = 'late-revision';
    expect(
      (FakeWorker.current.data as { selection: typeof selection }).selection.sessionRevision,
    ).toBe('revision');
    expect(
      (FakeWorker.current.data as { health: typeof health }).health.review.observerProfile,
    ).toBe('inspection-v1');
    const result = {
      healthText: '{"schemaVersion":1,"records":[]}',
    } as unknown as PreparedScanCommit;
    FakeWorker.current.onmessage?.({ data: { ok: true, result } } as MessageEvent);
    expect(await pending).toBe(result);
    expect(FakeWorker.current.terminated).toBe(1);
    selection.sessionRevision = 'revision';
  });
  it('terminates on abort and ignores stale success/error callbacks', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const abort = new AbortController();
    const pending = prepareScanInWorker(catalog, defaultPreferences(), selection, [], abort.signal);
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    FakeWorker.current.onmessage?.({ data: { ok: true, result: {} } } as MessageEvent);
    FakeWorker.current.onerror?.();
    await rejected;
    expect(FakeWorker.current.terminated).toBe(1);
  });
  it('closes the worker when serialization fails', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const prefs = { ...defaultPreferences(), extra: () => undefined };
    await expect(
      prepareScanInWorker(catalog, prefs, selection, [], new AbortController().signal),
    ).rejects.toThrow('prepare-worker-clone');
    expect(FakeWorker.current.terminated).toBe(1);
  });
  it('relies on exactly one synchronous platform snapshot rather than pre-cloning', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const prefs = defaultPreferences();
    const clone = vi.spyOn(globalThis, 'structuredClone');
    try {
      const pending = prepareScanInWorker(
        catalog,
        prefs,
        selection,
        [],
        new AbortController().signal,
      );
      expect(clone).toHaveBeenCalledTimes(1); // FakeWorker models native postMessage's clone.
      FakeWorker.current.onmessage?.({ data: { ok: true, result: {} } } as MessageEvent);
      await pending;
      expect(FakeWorker.current.terminated).toBe(1);
    } finally {
      clone.mockRestore();
    }
  });
  it('retires callback roots before repeated success, transport error and abort settlements', async () => {
    vi.stubGlobal('Worker', FakeWorker);
    const retired: FakeWorker[] = [];
    for (let index = 0; index < 128; index++) {
      const controller = new AbortController();
      const add = vi.spyOn(controller.signal, 'addEventListener');
      const remove = vi.spyOn(controller.signal, 'removeEventListener');
      const pending = prepareScanInWorker(
        catalog,
        defaultPreferences(),
        selection,
        [],
        controller.signal,
      );
      const worker = FakeWorker.current;
      const staleMessage = worker.onmessage!;
      const staleError = worker.onerror!;
      expect(retired.every((entry) => entry.terminated === 1)).toBe(true);
      if (index % 3 === 0) {
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        controller.abort();
        await rejected;
      } else if (index % 3 === 1) {
        const rejected = expect(pending).rejects.toThrow('prepare-worker-protocol');
        worker.onmessageerror!();
        await rejected;
      } else {
        worker.onmessage!({ data: { ok: true, result: {} } } as MessageEvent);
        await pending;
      }
      staleMessage({ data: { ok: true, result: {} } } as MessageEvent);
      staleError();
      expect(worker.terminated).toBe(1);
      expect(add).toHaveBeenCalledTimes(1);
      expect(remove).toHaveBeenCalledWith('abort', add.mock.calls[0]![1]);
      retired.push(worker);
      expect(
        retired.every((entry) => !entry.onmessage && !entry.onerror && !entry.onmessageerror),
      ).toBe(true);
      add.mockRestore();
      remove.mockRestore();
    }
  });
});
