import { expect, it, vi } from 'vitest';
import {
  createCatalogQueryAdapter,
  readCatalogQueryObservation,
  type CatalogPage,
  type CatalogQueryInput,
  type CatalogQueryTransport,
} from '../../src/platform/catalog-query';
const input: CatalogQueryInput = {
  schemaVersion: 1,
  query: '',
  filter: 'all',
  sort: 'source',
  pageSize: 50,
};
it('redacted observation distinguishes joined original work from a still pending cancel acknowledgment', async () => {
  const baseline = readCatalogQueryObservation(),
    work = deferred(),
    cancel = deferred(),
    abort = new AbortController();
  const read = createCatalogQueryAdapter(
    (command) => (command === 'query_catalog_page' ? work.promise : cancel.promise),
    { requestId: () => 'private-request' },
  );
  const result = read({ ...input, query: 'private-query' }, abort.signal).catch((e) => e);
  expect(readCatalogQueryObservation().originalPending).toBe(baseline.originalPending + 1);
  abort.abort();
  await Promise.resolve();
  expect(readCatalogQueryObservation().cancelAckPending).toBe(baseline.cancelAckPending + 1);
  work.reject('canceled');
  await Promise.resolve();
  await Promise.resolve();
  const snapshot = readCatalogQueryObservation();
  expect(snapshot.originalPending).toBe(baseline.originalPending);
  expect(snapshot.originalSettled).toBe(baseline.originalSettled + 1);
  expect(snapshot.abortedPending).toBe(baseline.abortedPending + 1);
  expect(JSON.stringify(snapshot)).not.toContain('private');
  cancel.resolve(undefined);
  expect((await result).name).toBe('AbortError');
  expect(readCatalogQueryObservation().cancelAckPending).toBe(baseline.cancelAckPending);
  expect(readCatalogQueryObservation().abortedPending).toBe(baseline.abortedPending);
});
const row = { id: 'channel', sourceId: 'source', name: 'News', category: 'News', favorite: false };
function page(id = 'request'): CatalogPage {
  return {
    schemaVersion: 1,
    requestId: id,
    catalogRevision: '7',
    viewRevision: '2',
    queryVersion: 'v1-' + 'a'.repeat(64),
    totalCount: 1,
    startIndex: 0,
    anchorIndex: null,
    rows: [{ ...row }],
    after: null,
  };
}
function deferred() {
  let resolve!: (v: unknown) => void, reject!: (e: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function adapter(raw: unknown) {
  const transport = vi.fn<CatalogQueryTransport>(async () => raw);
  return { transport, read: createCatalogQueryAdapter(transport, { requestId: () => 'request' }) };
}
it('passes exact URL-free metadata and distinguishes omitted All from null Unknown geography', async () => {
  const a = adapter(page());
  const result = await a.read(
    { ...input, geography: { country: null, state: 'US-IL' } },
    new AbortController().signal,
  );
  expect(result).toEqual(page());
  expect(a.transport).toHaveBeenCalledWith('query_catalog_page', {
    query: { ...input, geography: { country: null, state: 'US-IL' }, requestId: 'request' },
  });
  expect(JSON.stringify(result)).not.toMatch(/urls|location/);
});
it.each([
  { pageSize: 0 },
  { pageSize: 51 },
  { startIndex: -1 },
  { startIndex: 100001 },
  { query: 'x'.repeat(16385) },
  { filter: 'broken' },
  { geography: { country: 'us' } },
  { geography: { postal: '60601' } },
  { expectedCatalogRevision: '9223372036854775808' },
  { schemaVersion: 2 },
  { urls: ['https://private.invalid'] },
])('rejects invalid query before dispatch %j', async (delta) => {
  const a = adapter(page());
  await expect(
    a.read({ ...input, ...delta } as CatalogQueryInput, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid-query' });
  expect(a.transport).not.toHaveBeenCalled();
});
it.each([
  { requestId: 'other' },
  { schemaVersion: 2 },
  { queryVersion: 'v2-' + 'a'.repeat(64) },
  { catalogRevision: '07' },
  { viewRevision: '9223372036854775808' },
  { totalCount: 100001 },
  { startIndex: 1 },
  { anchorIndex: 0 },
  { rows: [{ ...row, urls: ['https://secret.invalid'] }] },
  { rows: [row, row] },
  { rows: [{ ...row, favorite: 'yes' }] },
  { rows: [{ ...row, geography: { country: null } }] },
  { rows: [{ ...row, name: 'x'.repeat(16385) }] },
  { after: { schemaVersion: 1 } },
])('rejects malformed response without surfacing payload %j', async (delta) => {
  const a = adapter({ ...page(), ...delta });
  const error = await a.read(input, new AbortController().signal).catch((e) => e);
  expect(error.code).toBe('invalid-page');
  expect(String(error)).not.toContain('secret.invalid');
});
it('bounds entire reply1MiB even with individually admitted row fields', async () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({
    ...row,
    id: `c${i}`,
    name: 'n'.repeat(16384),
    category: 'c'.repeat(16384),
  }));
  await expect(
    adapter({ ...page(), rows, totalCount: 50 }).read(input, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid-page' });
});
it('validates keyset cursor revisions and last-row identity', async () => {
  const cursor = {
    schemaVersion: 1 as const,
    queryKey: 'b'.repeat(64),
    catalogRevision: '7',
    viewRevision: '2',
    sortKey: 'a0',
    id: 'channel',
  };
  const a = adapter({ ...page(), totalCount: 2, after: cursor });
  expect((await a.read(input, new AbortController().signal)).after).toEqual(cursor);
  await expect(
    a.read(
      {
        ...input,
        after: cursor,
        expectedCatalogRevision: '7',
        expectedViewRevision: '2',
        startIndex: 0,
      },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'invalid-query' });
  await expect(
    a.read({ ...input, after: cursor }, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid-query' });
  await expect(
    adapter({ ...page(), totalCount: 2, after: { ...cursor, id: 'other' } }).read(
      input,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'invalid-page' });
});
it('accepts authoritative random window and anchor rank, rejects query-mode conflicts', async () => {
  const cursor = {
    schemaVersion: 1 as const,
    queryKey: 'b'.repeat(64),
    catalogRevision: '7',
    viewRevision: '2',
    sortKey: 'a0',
    id: 'channel',
  };
  const a = adapter({ ...page(), startIndex: 19, totalCount: 30, after: cursor });
  expect(
    (await a.read({ ...input, startIndex: 19 }, new AbortController().signal)).startIndex,
  ).toBe(19);
  const anchored = adapter({
    ...page(),
    startIndex: 19,
    anchorIndex: 20,
    totalCount: 30,
    after: cursor,
  });
  expect(
    (await anchored.read({ ...input, anchorId: 'target' }, new AbortController().signal))
      .anchorIndex,
  ).toBe(20);
  await expect(
    anchored.read({ ...input, anchorId: 'target', startIndex: 19 }, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid-query' });
  expect(
    (await adapter(page()).read({ ...input, anchorId: 'missing' }, new AbortController().signal))
      .anchorIndex,
  ).toBeNull();
});
it('refuses stale revision replies and redacts unknown native diagnostics', async () => {
  await expect(
    adapter(page()).read({ ...input, expectedCatalogRevision: '8' }, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'catalog-stale' });
  const read = createCatalogQueryAdapter(
    async () => {
      throw 'https://private.invalid/token';
    },
    { requestId: () => 'request' },
  );
  const e = await read(input, new AbortController().signal).catch((e) => e);
  expect(e.code).toBe('unavailable');
  expect(String(e)).not.toContain('private');
});
it('cancellation signals exact request but awaits actual query and cancellation settlement', async () => {
  const work = deferred(),
    cancel = deferred(),
    abort = new AbortController();
  const transport = vi.fn<CatalogQueryTransport>((command) =>
    command === 'query_catalog_page' ? work.promise : cancel.promise,
  );
  const read = createCatalogQueryAdapter(transport, { requestId: () => 'request' });
  let settled = false;
  const result = read(input, abort.signal).catch((e) => {
    settled = true;
    return e;
  });
  abort.abort();
  await Promise.resolve();
  expect(transport).toHaveBeenLastCalledWith('cancel_catalog_query', { requestId: 'request' });
  cancel.resolve(undefined);
  await Promise.resolve();
  expect(settled).toBe(false);
  work.resolve(page());
  expect((await result).name).toBe('AbortError');
});
it('failed cancellation is static unconfirmed only after actual query settles', async () => {
  const work = deferred(),
    abort = new AbortController();
  const read = createCatalogQueryAdapter(
    (command) => (command === 'query_catalog_page' ? work.promise : Promise.reject('private')),
    { requestId: () => 'request' },
  );
  let settled = false;
  const result = read(input, abort.signal).catch((e) => {
    settled = true;
    return e;
  });
  abort.abort();
  await Promise.resolve();
  expect(settled).toBe(false);
  work.reject('canceled');
  const error = await result;
  expect(error.code).toBe('cancel-unconfirmed');
  expect(String(error)).not.toContain('private');
});
it('concurrent deferred queries have distinct identities and cannot consume each other reply', async () => {
  const first = deferred(),
    second = deferred();
  let n = 0;
  const read = createCatalogQueryAdapter(
    (_command, args) =>
      (Reflect.get(args, 'query') as { requestId: string }).requestId === 'r1'
        ? first.promise
        : second.promise,
    { requestId: () => `r${++n}` },
  );
  const a = read(input, new AbortController().signal),
    b = read(input, new AbortController().signal);
  second.resolve(page('r2'));
  expect((await b).requestId).toBe('r2');
  first.resolve(page('r2'));
  await expect(a).rejects.toMatchObject({ code: 'invalid-page' });
});
it('preaborted work dispatches nothing and malformed accessor objects are refused', async () => {
  const a = adapter(page()),
    abort = new AbortController();
  abort.abort();
  await expect(a.read(input, abort.signal)).rejects.toMatchObject({ name: 'AbortError' });
  expect(a.transport).not.toHaveBeenCalled();
  const forged = { ...input };
  Object.defineProperty(forged, 'query', {
    get() {
      throw new Error('private');
    },
    enumerable: true,
  });
  await expect(a.read(forged, new AbortController().signal)).rejects.toMatchObject({
    code: 'invalid-query',
  });
});

it('query settlement cannot return cancellation before the cancel transport actually joins', async () => {
  const work = deferred(),
    cancel = deferred(),
    abort = new AbortController();
  const read = createCatalogQueryAdapter(
    (command) => (command === 'query_catalog_page' ? work.promise : cancel.promise),
    { requestId: () => 'request' },
  );
  let settled = false;
  const result = read(input, abort.signal).catch((e) => {
    settled = true;
    return e;
  });
  abort.abort();
  work.resolve(page());
  await Promise.resolve();
  await Promise.resolve();
  expect(settled).toBe(false);
  cancel.resolve(undefined);
  expect((await result).name).toBe('AbortError');
});
it.each([
  ['catalog-revision-stale', 'catalog-stale'],
  ['catalog-view-revision-stale', 'view-stale'],
  ['catalog-query-cursor-stale', 'cursor-stale'],
])('maps only exact native %s to a static stale code', async (native, code) => {
  const read = createCatalogQueryAdapter(
    async () => {
      throw native;
    },
    { requestId: () => 'request' },
  );
  await expect(read(input, new AbortController().signal)).rejects.toMatchObject({ code });
});

it.each([true, false])(
  'serializes explicit favoritesFirst %s without client sorting',
  async (favoritesFirst) => {
    const a = adapter(page());
    const result = await a.read({ ...input, favoritesFirst }, new AbortController().signal);
    expect(a.transport).toHaveBeenCalledWith('query_catalog_page', {
      query: { ...input, favoritesFirst, requestId: 'request' },
    });
    expect(result).toEqual(page());
  },
);
it.each([null, 1, 'true', {}, []])(
  'refuses malformed favoritesFirst %j before dispatch',
  async (favoritesFirst) => {
    const a = adapter(page());
    await expect(
      a.read(
        { ...input, favoritesFirst } as unknown as CatalogQueryInput,
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'invalid-query' });
    expect(a.transport).not.toHaveBeenCalled();
  },
);
