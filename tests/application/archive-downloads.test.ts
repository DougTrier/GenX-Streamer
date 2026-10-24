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
import { createArchiveDownloads } from '../../src/application/archive-downloads';
import {
  createArchiveDownloadsAdapter,
  ArchiveDownloadError,
  validateArchiveDownloadList,
  validateArchiveDownloadProgress,
  type ArchiveDownloadRuntime,
  type ArchiveDownloadEntry,
  type ArchiveDownloadReceipt,
} from '../../src/platform/archive-downloads';
function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (v: unknown) => void;
  const promise = new Promise<T>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
const entry: ArchiveDownloadEntry = {
  downloadRef: 'a'.repeat(64),
  fileRef: 'b'.repeat(64),
  titleRef: 'c'.repeat(64),
  title: 'Controlled series',
  fileTitle: 'Controlled episode',
  fileName: 'episode.mp4',
  sizeBytes: '100',
  completedMs: 1000,
  integrity: 'sha1-verified',
  available: true,
};
const receipt: ArchiveDownloadReceipt = {
  schemaVersion: 1,
  committed: true,
  revision: '1',
  changed: true,
  entry,
};
function fixture() {
  let emit: (v: unknown) => void = () => {},
    scope = 'root-1';
  const done = deferred<unknown>(),
    cancel = deferred<unknown>();
  const events: string[] = [];
  const runtime: ArchiveDownloadRuntime = {
    idFactory: () => 'request-1',
    listen: async (cb) => {
      events.push('listen');
      emit = cb;
      return () => events.push('unlisten');
    },
    invoke: vi.fn(async (command) => {
      events.push(command);
      if (command === 'start_archive_download') return done.promise;
      if (command === 'cancel_playlist') return cancel.promise;
      if (command === 'stop_archive_downloads')
        return { schemaVersion: 1, stopped: true, cleanupPending: false };
      if (command === 'list_archive_downloads')
        return { schemaVersion: 1, revision: '0', entries: [] };
      throw Error('Unexpected command');
    }),
  };
  const adapter = createArchiveDownloadsAdapter(runtime),
    owner = createArchiveDownloads({ native: adapter, readyScope: () => scope });
  const progress = (phase = 'downloading', receivedBytes = '50', jobId = 'd'.repeat(64)) =>
    emit({
      schemaVersion: 1,
      requestId: 'request-1',
      fileRef: entry.fileRef,
      jobId,
      phase,
      receivedBytes,
      totalBytes: '100',
    });
  return {
    adapter,
    owner,
    done,
    cancel,
    events,
    progress,
    scope: (s: string) => {
      scope = s;
    },
  };
}
describe('native download boundary', () => {
  it('subscribes before dispatch; Saving and 100% bytes cannot publish Saved without durable receipt', async () => {
    const f = fixture();
    const work = f.owner.download(entry.fileRef, '1');
    await vi.waitFor(() => expect(f.events).toContain('start_archive_download'));
    expect(f.events.slice(0, 2)).toEqual(['listen', 'start_archive_download']);
    f.progress('downloading', '100');
    expect(f.owner.snapshot.entries).toEqual([]);
    expect(f.owner.snapshot.state).toBe('downloading');
    f.progress('saving', '100');
    expect(f.owner.snapshot.state).toBe('saving');
    expect(f.owner.snapshot.entries).toEqual([]);
    f.done.resolve(receipt);
    await work;
    expect(f.owner.snapshot.state).toBe('saved');
    expect(f.owner.snapshot.entries).toEqual([entry]);
    expect(f.events.at(-1)).toBe('unlisten');
    await f.owner.dispose();
  });
  it('ignores regressive bytes/phases and foreign job identity', async () => {
    const f = fixture(),
      work = f.owner.download(entry.fileRef, '1');
    await vi.waitFor(() => expect(f.events).toContain('start_archive_download'));
    f.progress();
    f.progress('preparing', '20');
    f.progress('saving', '90', 'e'.repeat(64));
    expect(f.owner.snapshot.progress?.receivedBytes).toBe('50');
    f.done.resolve(receipt);
    await work;
    await f.owner.dispose();
  });
  it('Cancel joins both actual original and cancel ACK, late COMMIT remains Saved', async () => {
    const f = fixture(),
      work = f.owner.download(entry.fileRef, '1');
    await vi.waitFor(() => expect(f.events).toContain('start_archive_download'));
    let settled = false;
    const stop = f.owner.cancel().then(() => {
      settled = true;
    });
    await vi.waitFor(() => expect(f.events).toContain('cancel_playlist'));
    f.cancel.resolve(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.events).not.toContain('unlisten');
    f.done.resolve(receipt);
    await work;
    await stop;
    expect(f.owner.snapshot.state).toBe('saved');
    expect(f.owner.snapshot.entries).toEqual([entry]);
    await f.owner.dispose();
  });
  it('a root replacement suppresses old completion publication without inventing cancellation of durable truth', async () => {
    const f = fixture(),
      work = f.owner.download(entry.fileRef, '1');
    await vi.waitFor(() => expect(f.events).toContain('start_archive_download'));
    f.scope('root-2');
    f.done.resolve(receipt);
    expect(await work).toEqual(receipt);
    expect(f.owner.snapshot.entries).toEqual([]);
    await f.owner.resume();
    expect(f.owner.snapshot.revision).toBe('0');
    await f.owner.dispose();
  });
  it('one active job refuses another file; browsing is not an ownership input', async () => {
    const f = fixture(),
      work = f.owner.download(entry.fileRef, '1');
    await expect(f.owner.download('e'.repeat(64), '1')).rejects.toMatchObject({ category: 'busy' });
    f.done.resolve(receipt);
    await work;
    await f.owner.dispose();
  });
  it('post-COMMIT repair-required is not masked by a late abort', async () => {
    const f = fixture(),
      abort = new AbortController();
    const work = f.adapter.start(entry.fileRef, '1', abort.signal, () => {});
    const observed = work.catch((e) => e);
    await vi.waitFor(() => expect(f.events).toContain('start_archive_download'));
    abort.abort();
    f.done.reject('archive-download-repair-required');
    f.cancel.resolve(true);
    expect(await observed).toMatchObject({ category: 'repair' });
    expect(f.events.at(-1)).toBe('unlisten');
  });
  it('removal retry preserves actual tombstone revision and joins cleanup before clearing pending', async () => {
    let calls = 0;
    const removed = vi.fn(async (ref: string, rev: string) => ({
      schemaVersion: 1 as const,
      committed: true as const,
      revision: calls++ === 0 ? '2' : rev,
      changed: calls === 1,
      downloadRef: ref,
      cleanupPending: calls === 1,
    }));
    const owner = createArchiveDownloads({
      readyScope: () => 'root',
      native: {
        list: async () => ({ schemaVersion: 1, revision: '1', entries: [entry] }),
        remove: removed,
        start: vi.fn(),
        status: async () => null,
        stop: async () => {},
      },
    });
    await owner.refresh();
    const first = await owner.remove(entry.downloadRef, '1');
    expect(first.cleanupPending).toBe(true);
    expect(owner.snapshot.entries).toEqual([{ ...entry, available: false, cleanupPending: true }]);
    await owner.cancel();
    expect(removed.mock.calls.map((c) => c[1])).toEqual(['1', '2']);
    expect(owner.snapshot.cleanupPending).toBe(false);
    await owner.dispose();
  });
  it('failed stop retains cleanup error and refuses new download until a real retry succeeds', async () => {
    let fail = true;
    const owner = createArchiveDownloads({
      readyScope: () => 'root',
      native: {
        list: async () => ({ schemaVersion: 1, revision: '0', entries: [] }),
        remove: vi.fn(),
        start: vi.fn(),
        status: async () => null,
        stop: async () => {
          if (fail) throw new ArchiveDownloadError('cleanup');
        },
      },
    });
    await expect(owner.suspend()).rejects.toMatchObject({ category: 'cleanup' });
    expect(owner.snapshot.cleanupPending).toBe(true);
    fail = false;
    await owner.suspend();
    expect(owner.snapshot.cleanupPending).toBe(false);
    await owner.dispose();
  });
});
it('strict download metadata rejects paths, overflow, extra keys and malformed progress', () => {
  expect(
    validateArchiveDownloadList({ schemaVersion: 1, revision: '1', entries: [entry] }).entries,
  ).toEqual([entry]);
  for (const value of [
    { ...entry, path: 'C:/private' },
    { ...entry, sizeBytes: '68719476737' },
    { ...entry, fileTitle: 'https://private.invalid' },
  ])
    expect(() =>
      validateArchiveDownloadList({ schemaVersion: 1, revision: '1', entries: [value] }),
    ).toThrow();
  expect(() =>
    validateArchiveDownloadProgress({
      schemaVersion: 1,
      requestId: 'x',
      fileRef: entry.fileRef,
      jobId: 'd'.repeat(64),
      phase: 'saving',
      receivedBytes: '100',
      totalBytes: null,
    }),
  ).toThrow();
});

it('root replacement waits the exact held old read before accepting a lower new-root revision', async () => {
  const old = deferred<{ schemaVersion: 1; revision: string; entries: ArchiveDownloadEntry[] }>();
  let scope = 'old',
    read = 0;
  const owner = createArchiveDownloads({
    readyScope: () => scope,
    native: {
      list: async () =>
        read++ === 0 ? old.promise : { schemaVersion: 1, revision: '0', entries: [] },
      start: vi.fn(),
      remove: vi.fn(),
      status: async () => null,
      stop: async () => {},
    },
  });
  const first = owner.refresh();
  await vi.waitFor(() => expect(read).toBe(1));
  scope = 'new';
  let joined = false;
  const second = owner.resume().then(() => {
    joined = true;
  });
  await Promise.resolve();
  expect(joined).toBe(false);
  old.resolve({ schemaVersion: 1, revision: '5', entries: [entry] });
  await first;
  await second;
  expect(owner.snapshot.entries).toEqual([]);
  expect(owner.snapshot.revision).toBe('0');
  await owner.dispose();
});
it('root replacement aborts and joins the old producer before presenting its empty saved library', async () => {
  const f = fixture(),
    work = f.owner.download(entry.fileRef, '1');
  const observed = work.catch((e) => e);
  await vi.waitFor(() => expect(f.events).toContain('start_archive_download'));
  f.scope('root-2');
  let settled = false;
  const second = f.owner.resume().then(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(f.events).toContain('cancel_playlist'));
  f.cancel.resolve(true);
  await Promise.resolve();
  expect(settled).toBe(false);
  f.done.resolve(receipt);
  await observed;
  await second;
  expect(f.owner.snapshot.entries).toEqual([]);
  expect(f.owner.snapshot.revision).toBe('0');
  await f.owner.dispose();
});

it('durable save keeps its receipt when local event cleanup fails, and a real retry releases the retained callback', async () => {
  let fail = true,
    removed = 0;
  const adapter = createArchiveDownloadsAdapter({
    listen: async () => () => {
      if (fail) throw Error('Held local observer cleanup');
      removed++;
    },
    invoke: async (command) =>
      command === 'start_archive_download'
        ? receipt
        : { schemaVersion: 1, stopped: true, cleanupPending: false },
  });
  const owner = createArchiveDownloads({ readyScope: () => 'root', native: adapter });
  expect(await owner.download(entry.fileRef, '1')).toEqual(receipt);
  expect(owner.snapshot.state).toBe('saved');
  expect(owner.snapshot.cleanupPending).toBe(true);
  await expect(owner.download('e'.repeat(64), '1')).rejects.toMatchObject({ category: 'cleanup' });
  fail = false;
  await owner.cancel();
  expect(removed).toBe(1);
  expect(owner.snapshot.cleanupPending).toBe(false);
  await owner.dispose();
});

it('beforeRemove retains the actual matching decoder stop and rechecks root before native mutation', async () => {
  const held = deferred<void>();
  let scope = 'root';
  const beforeRemove = vi.fn(async () => held.promise),
    remove = vi.fn();
  const owner = createArchiveDownloads({
    readyScope: () => scope,
    beforeRemove,
    native: {
      list: async () => ({ schemaVersion: 1, revision: '1', entries: [entry] }),
      remove,
      start: vi.fn(),
      status: async () => null,
      stop: async () => {},
    },
  });
  await owner.refresh();
  const original = owner.remove(entry.downloadRef, '1');
  const observed = original.catch((e) => e);
  await vi.waitFor(() => expect(beforeRemove).toHaveBeenCalledTimes(1));
  expect(remove).not.toHaveBeenCalled();
  scope = 'new-root';
  let settled = false;
  const stop = owner.suspend().then(() => {
    settled = true;
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  held.resolve();
  await stop;
  expect(await observed).toMatchObject({ name: 'AbortError' });
  expect(remove).not.toHaveBeenCalled();
  await owner.dispose();
});
it('failed matching playback cleanup prevents tombstone/unlink and only a real stop retry clears failure', async () => {
  let fail = true;
  const beforeRemove = vi.fn(async () => {
      if (fail) throw Error('Controlled decoder cleanup failure');
    }),
    remove = vi.fn();
  const owner = createArchiveDownloads({
    readyScope: () => 'root',
    beforeRemove,
    native: {
      list: async () => ({ schemaVersion: 1, revision: '1', entries: [entry] }),
      remove,
      start: vi.fn(),
      status: async () => null,
      stop: async () => {},
    },
  });
  await owner.refresh();
  await expect(owner.remove(entry.downloadRef, '1')).rejects.toMatchObject({ category: 'cleanup' });
  expect(remove).not.toHaveBeenCalled();
  expect(owner.snapshot.entries).toEqual([entry]);
  expect(owner.snapshot.cleanupPending).toBe(true);
  await expect(owner.cancel()).rejects.toThrow();
  fail = false;
  await owner.cancel();
  expect(beforeRemove).toHaveBeenCalledTimes(3);
  expect(owner.snapshot.cleanupPending).toBe(false);
  expect(remove).not.toHaveBeenCalled();
  await owner.dispose();
});
it('cold tombstone list admits explicit same-revision removal retry but never local playback authority', async () => {
  const tombstone = { ...entry, available: false, cleanupPending: true as const };
  const removed = vi.fn(async (ref: string, rev: string) => ({
    schemaVersion: 1 as const,
    committed: true as const,
    revision: rev,
    changed: false,
    downloadRef: ref,
    cleanupPending: false,
  }));
  const owner = createArchiveDownloads({
    readyScope: () => 'root',
    native: {
      list: async () => ({ schemaVersion: 1, revision: '2', entries: [tombstone] }),
      remove: removed,
      start: vi.fn(),
      status: async () => null,
      stop: async () => {},
    },
  });
  await owner.refresh();
  expect(owner.snapshot.entries[0]).toMatchObject({ available: false, cleanupPending: true });
  await owner.remove(entry.downloadRef, '2');
  expect(removed).toHaveBeenCalledWith(entry.downloadRef, '2', expect.any(AbortSignal));
  expect(owner.snapshot.entries).toEqual([]);
  await owner.dispose();
  expect(() =>
    validateArchiveDownloadList({
      schemaVersion: 1,
      revision: '2',
      entries: [{ ...entry, cleanupPending: true }],
    }),
  ).toThrow();
  expect(() =>
    validateArchiveDownloadList({
      schemaVersion: 1,
      revision: '2',
      entries: [{ ...entry, available: false, cleanupPending: false }],
    }),
  ).toThrow();
});
