// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import {
  createSourceCleanupTransport,
  isSourceCleanupNotCommitted,
  validateSourceCleanupReceipt,
} from '../../src/platform/source-cleanup';
const roundId = 'a'.repeat(64);
const begun = { schemaVersion: 1, roundId, sourceCount: 2 };
const receipt = {
  schemaVersion: 1,
  committed: true,
  status: 'completed',
  archivedCount: 1,
  expiredEventIds: [],
  checkedTargets: 1,
  deferredCount: 0,
  catalogRevision: '4',
  healthRevision: '8',
  viewRevision: '9',
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
function transport(
  invoke = vi.fn(async (command: string, _args?: Record<string, unknown>): Promise<unknown> => {
    if (command === 'begin_source_cleanup') return begun;
    if (command === 'finish_source_cleanup') return receipt;
    if (command === 'cancel_source_cleanup') return { schemaVersion: 1, canceled: true };
    return undefined;
  }),
) {
  return {
    invoke,
    client: createSourceCleanupTransport({
      runtime: { invoke, idFactory: () => 'owned-request' },
      native: () => true,
    }),
  };
}
it('sends only native catalog authority and an issued opaque round, then consumes its receipt', async () => {
  const f = transport();
  const signal = new AbortController().signal;
  expect(await f.client.begin('4', signal)).toEqual(begun);
  expect(await f.client.finish(roundId, signal)).toEqual(receipt);
  expect(f.invoke.mock.calls).toEqual([
    [
      'begin_source_cleanup',
      { request: { schemaVersion: 1, expectedCatalogRevision: '4' }, requestId: 'owned-request' },
    ],
    [
      'finish_source_cleanup',
      { request: { schemaVersion: 1, roundId }, requestId: 'owned-request' },
    ],
  ]);
  await f.client.cancel(roundId);
  expect(f.invoke).toHaveBeenCalledTimes(2);
});
it('rejects malformed or impossible cleanup receipts', () => {
  for (const update of [
    { committed: false },
    { archivedCount: -1 },
    { expiredEventIds: ['duplicate', 'duplicate'] },
    { checkedTargets: 257 },
    { catalogRevision: '04' },
    { viewRevision: '9223372036854775808' },
    { status: 'coverage-incomplete' },
    { unexpected: 'field' },
  ])
    expect(() => validateSourceCleanupReceipt({ ...receipt, ...update })).toThrow();
});
it('rescues a late begin acknowledgment and joins independent proof revocation after abort', async () => {
  const begin = deferred<unknown>(),
    cancel = deferred<unknown>();
  const invoke = vi.fn(async (command: string): Promise<unknown> => {
    if (command === 'begin_source_cleanup') return begin.promise;
    if (command === 'cancel_source_cleanup') return cancel.promise;
    return undefined;
  });
  const f = transport(invoke),
    abort = new AbortController();
  const work = f.client.begin('4', abort.signal);
  abort.abort();
  begin.resolve(begun);
  let settled = false;
  const result = work
    .catch((error) => error)
    .finally(() => {
      settled = true;
    });
  await vi.waitFor(() =>
    expect(invoke.mock.calls.some(([command]) => command === 'cancel_source_cleanup')).toBe(true),
  );
  expect(settled).toBe(false);
  cancel.resolve({ schemaVersion: 1, canceled: true });
  expect(await result).toMatchObject({ name: 'AbortError' });
  expect(invoke.mock.calls.map(([command]) => command)).toEqual([
    'begin_source_cleanup',
    'cancel_playlist',
    'cancel_source_cleanup',
  ]);
});
it('retains a real COMMIT receipt when abort loses the finish race', async () => {
  const finish = deferred<unknown>();
  const f = transport(
    vi.fn(async (command: string): Promise<unknown> =>
      command === 'begin_source_cleanup'
        ? begun
        : command === 'finish_source_cleanup'
          ? finish.promise
          : undefined,
    ),
  );
  const abort = new AbortController();
  await f.client.begin('4', abort.signal);
  const work = f.client.finish(roundId, abort.signal);
  abort.abort();
  finish.resolve(receipt);
  expect(await work).toEqual(receipt);
});
it('brands only exact joined native noncommit errors, not names or an unknown failure', async () => {
  for (const raw of ['canceled', 'application-closing', 'unknown-error', new Error('canceled')]) {
    const f = transport(
      vi.fn(async (command: string): Promise<unknown> => {
        if (command === 'begin_source_cleanup') return begun;
        if (command === 'finish_source_cleanup') throw raw;
        return undefined;
      }),
    );
    const signal = new AbortController().signal;
    await f.client.begin('4', signal);
    const error = await f.client.finish(roundId, signal).catch((error) => error);
    expect(isSourceCleanupNotCommitted(error)).toBe(
      raw === 'canceled' || raw === 'application-closing',
    );
  }
});
it('cancellation of an issued round is deduplicated and joined', async () => {
  const cancel = deferred<unknown>();
  const f = transport(
    vi.fn(async (command: string): Promise<unknown> =>
      command === 'begin_source_cleanup'
        ? begun
        : command === 'cancel_source_cleanup'
          ? cancel.promise
          : undefined,
    ),
  );
  await f.client.begin('4', new AbortController().signal);
  const one = f.client.cancel(roundId),
    two = f.client.cancel(roundId);
  expect(one).toBe(two);
  expect(
    f.invoke.mock.calls.filter(([command]) => command === 'cancel_source_cleanup'),
  ).toHaveLength(1);
  cancel.resolve({ schemaVersion: 1, canceled: true });
  await one;
  await expect(f.client.finish(roundId, new AbortController().signal)).rejects.toThrow();
});
