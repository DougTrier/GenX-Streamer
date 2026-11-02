// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { createCatalogQueryAdapter } from '../../src/platform/catalog-query';
import {
  ACCOUNT_QUERY_VERSION,
  validateAccountChannelQuery,
  validateAccountChannelQueryPage,
  type AccountChannelQuery,
} from '../../src/platform/account-query';
import { createAccountBrowser } from '../../src/application/accounts/account-browser';

const accountId = 'a'.repeat(32);
const paidId = (n: number) => `account-${accountId}-${String(n).padStart(64, '0')}`;
const base = {
  schemaVersion: 1 as const,
  query: '',
  filter: 'watched' as const,
  sort: 'source' as const,
  pageSize: 50,
  historyIds: ['c2', 'c1'],
};
const publicRow = (id: string) => ({
  id,
  name: id,
  sourceId: 'source',
  category: 'Sports',
  originalCategory: 'PPV',
  ppv: true,
  favorite: false,
});
const publicPage = (rows = [publicRow('c2'), publicRow('c1')]) => ({
  schemaVersion: 1,
  requestId: 'request',
  catalogRevision: '1',
  viewRevision: '1',
  queryVersion: 'v1-' + 'a'.repeat(64),
  startIndex: 0,
  anchorIndex: null,
  totalCount: rows.length,
  rows,
  after: null,
});
const free = (page: unknown) =>
  createCatalogQueryAdapter(async () => page, { requestId: () => 'request' });
const paid: AccountChannelQuery = {
  schemaVersion: 1,
  accountId,
  expectedAccountRevision: '1',
  expectedMediaRevision: '1',
  query: '',
  category: null,
  filter: 'watched',
  sort: 'source',
  startIndex: 0,
  pageSize: 50,
  historyIds: [paidId(2), paidId(1)],
};
const paidRow = (n: number) => ({
  id: paidId(n),
  name: 'Watched',
  category: 'Sports',
  originalCategory: 'PPV',
  ppv: true,
  favorite: false,
  providerId: null,
  epgId: null,
  streamReference: String(n).padStart(32, '0'),
});
const paidPage = (items = [paidRow(2), paidRow(1)]) => ({
  schemaVersion: 1,
  accountId,
  accountRevision: '1',
  mediaRevision: '1',
  preferencesRevision: '0',
  queryVersion: ACCOUNT_QUERY_VERSION,
  startIndex: 0,
  anchorIndex: null,
  total: items.length,
  items,
});

it('Free watched scope admits PPV only for exact requested IDs in acknowledged recency order', async () => {
  await expect(
    free(publicPage()).call(null, base, new AbortController().signal),
  ).resolves.toMatchObject({
    rows: [
      { id: 'c2', ppv: true },
      { id: 'c1', ppv: true },
    ],
  });
  for (const rows of [[publicRow('c1'), publicRow('c2')], [publicRow('outside')]])
    await expect(free(publicPage(rows))(base, new AbortController().signal)).rejects.toMatchObject({
      code: 'invalid-page',
    });
  await expect(
    free(publicPage())(
      { ...base, filter: 'all', historyIds: undefined },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'invalid-page' });
  await expect(
    free({ ...publicPage(), totalCount: 3 })(base, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid-page' });
});
it('both request schemas reject missing, duplicate, oversized, and nonwatched History IDs', async () => {
  for (const historyIds of [
    undefined,
    ['c1', 'c1'],
    Array.from({ length: 257 }, (_, i) => 'c' + i),
  ])
    await expect(
      free(publicPage())({ ...base, historyIds }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'invalid-query' });
  await expect(
    free(publicPage())({ ...base, filter: 'all' }, new AbortController().signal),
  ).rejects.toMatchObject({ code: 'invalid-query' });
  for (const request of [
    { ...paid, historyIds: undefined },
    { ...paid, historyIds: [paidId(1), paidId(1)] },
    { ...paid, historyIds: ['other'] },
    { ...paid, filter: 'all' as const },
  ])
    expect(() => validateAccountChannelQuery(request)).toThrow();
  expect(validateAccountChannelQuery({ ...paid, historyIds: [] })).toMatchObject({
    historyIds: [],
  });
});
it('Paid watched metadata preserves PPV/original category while rejecting cross-scope or reordered results', () => {
  expect(validateAccountChannelQueryPage(paidPage(), paid).items.map((row) => row.id)).toEqual(
    paid.historyIds,
  );
  expect(() => validateAccountChannelQueryPage(paidPage([paidRow(1), paidRow(2)]), paid)).toThrow();
  expect(() => validateAccountChannelQueryPage(paidPage([paidRow(3)]), paid)).toThrow();
  expect(() => validateAccountChannelQueryPage({ ...paidPage(), total: 3 }, paid)).toThrow();
  expect(() =>
    validateAccountChannelQueryPage(paidPage(), { ...paid, filter: 'all', historyIds: undefined }),
  ).toThrow();
});
it('Paid adapter forwards ordered History authority separately from favorites and refresh scope', async () => {
  const seen: AccountChannelQuery[] = [];
  const owner = createAccountBrowser({
    query: {
      query: async (request) => {
        seen.push(request);
        return {
          schemaVersion: 1,
          accountId,
          accountRevision: '1',
          mediaRevision: '1',
          preferencesRevision: '0',
          queryVersion: ACCOUNT_QUERY_VERSION,
          startIndex: 0,
          anchorIndex: null,
          total: 0,
          items: [],
        };
      },
    },
  });
  await owner.select({
    schemaVersion: 1,
    id: accountId,
    name: 'Offline fixture',
    kind: 'xtream',
    serverOrigin: 'https://fixture.invalid',
    allowHttp: false,
    revision: '1',
    requiresSignIn: false,
  });
  try {
    const input = {
      ...base,
      historyIds: [paidId(2), paidId(1)],
      geography: { country: 'US' },
      hideAdult: true,
    };
    await owner.query(input, new AbortController().signal);
    await owner.query({ ...input, historyIds: [paidId(1)] }, new AbortController().signal);
    await owner.query(
      { ...input, filter: 'favorites', historyIds: undefined },
      new AbortController().signal,
    );
    expect(seen.map((q) => [q.filter, q.historyIds])).toEqual([
      ['watched', [paidId(2), paidId(1)]],
      ['watched', [paidId(1)]],
      ['favorites', undefined],
    ]);
    expect(seen[0]).toMatchObject({ country: 'US', hideAdult: true });
  } finally {
    await owner.dispose();
  }
});
