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

import { describe, expect, it, vi } from 'vitest';
import {
  createArchiveBookmarks,
  validateArchiveBookmarkRead,
  validateArchiveBookmarkSave,
} from '../../src/platform/archive-bookmarks';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => (resolve = yes));
  return { promise, resolve };
}
const read = {
  schemaVersion: 1,
  sessionGeneration: '2',
  supported: true,
  revision: '0',
  position: { positionMs: 1000, durationMs: 2000, completed: false, observedMs: 0 },
};
const request = {
  schemaVersion: 1 as const,
  sessionGeneration: '2',
  expectedRevision: '0',
  positionMs: 1000,
  durationMs: 2000,
  completed: false,
};
const committed = {
  schemaVersion: 1,
  sessionGeneration: '2',
  committed: true,
  revision: '1',
  changed: true,
};
describe('Archive bookmark strict native bridge', () => {
  it('accepts exact proof metadata and protects CAS and all numeric bounds', () => {
    expect(validateArchiveBookmarkRead(read, '2')).toEqual(read);
    expect(validateArchiveBookmarkSave(committed, request)).toEqual(committed);
    for (const patch of [
      { revision: '00' },
      { revision: '9223372036854775808' },
      { sessionGeneration: '3' },
      { url: 'private' },
      { supported: false },
    ])
      expect(() => validateArchiveBookmarkRead({ ...read, ...patch }, '2')).toThrow();
    for (const patch of [
      { positionMs: -1 },
      { positionMs: 2001 },
      { durationMs: 0 },
      { observedMs: Number.MAX_SAFE_INTEGER + 1 },
      { extra: true },
    ])
      expect(() =>
        validateArchiveBookmarkRead({ ...read, position: { ...read.position, ...patch } }, '2'),
      ).toThrow();
    for (const patch of [
      { revision: '2' },
      { changed: false },
      { committed: false },
      { extra: true },
    ])
      expect(() => validateArchiveBookmarkSave({ ...committed, ...patch }, request)).toThrow();
    expect(
      validateArchiveBookmarkSave({ ...committed, revision: '0', changed: false }, request).changed,
    ).toBe(false);
  });
  it('cancellation joins both original read and exact cancel before rejecting', async () => {
    const original = deferred<unknown>(),
      cancel = deferred<unknown>();
    const abort = new AbortController();
    const invoke = vi.fn((command: string) =>
      command === 'cancel_playlist' ? cancel.promise : original.promise,
    );
    const vault = createArchiveBookmarks({ invoke, idFactory: () => 'read-exact' });
    let settled = false;
    const outcome = vault.read('2', abort.signal).finally(() => (settled = true));
    const rejection = expect(outcome).rejects.toMatchObject({ name: 'AbortError' });
    abort.abort();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('cancel_playlist', { requestId: 'read-exact' });
    original.resolve(read);
    await Promise.resolve();
    expect(settled).toBe(false);
    cancel.resolve(true);
    await rejection;
  });
  it('late canceled save retains actual COMMIT and joins cancellation; fresh calls own fresh IDs', async () => {
    const original = deferred<unknown>(),
      cancel = deferred<unknown>();
    const abort = new AbortController();
    let id = 0;
    const invoke = vi.fn((command: string) =>
      command === 'cancel_playlist' ? cancel.promise : original.promise,
    );
    const vault = createArchiveBookmarks({ invoke, idFactory: () => `fresh-${++id}` });
    let settled = false;
    const result = vault.save(request, abort.signal).finally(() => (settled = true));
    abort.abort();
    await Promise.resolve();
    original.resolve(committed);
    await Promise.resolve();
    expect(settled).toBe(false);
    cancel.resolve(true);
    expect(await result).toEqual(committed);
    await vault.save(request);
    expect(invoke.mock.calls.map((c) => c[0])).toEqual([
      'save_archive_bookmark',
      'cancel_playlist',
      'save_archive_bookmark',
    ]);
    expect(id).toBe(2);
  });
  it('exports only safe known failure classification and never arbitrary provider text', async () => {
    for (const [value, category] of [
      ['archive-bookmark-revision-stale', 'stale'],
      ['archive-bookmark-identity-unproven', 'unproven'],
      ['https://private.invalid/token', 'failed'],
    ]) {
      const vault = createArchiveBookmarks({
        invoke: async () => {
          throw value;
        },
      });
      const error = await vault.read('2').catch((e) => e);
      expect(error.category).toBe(category);
      expect(error.message).not.toContain('private');
      expect(error.cause).toBeUndefined();
    }
  });
});
