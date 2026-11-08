// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { createAccountBrowser } from '../../src/application/accounts/account-browser';
import {
  ACCOUNT_QUERY_VERSION,
  AccountGuideRevisionConflict,
  createAccountQuery,
  validateAccountChannelQuery,
  validateAccountChannelQueryPage,
  type AccountChannelQuery,
} from '../../src/platform/account-query';
import { captureSportsScope } from '../../src/search/sports';

const accountId = 'a'.repeat(32);
const sports = captureSportsScope('NFL', {}, 1800001)!;
const request: AccountChannelQuery = {
  schemaVersion: 1,
  accountId,
  expectedAccountRevision: '1',
  expectedMediaRevision: '1',
  expectedPreferencesRevision: '0',
  query: 'NFL',
  sports,
  category: null,
  filter: 'all',
  sort: 'source',
  startIndex: 0,
  pageSize: 1,
};
const row = (index: number) => ({
  id: `account-${accountId}-${String(index + 1).padStart(64, '0')}`,
  name: `NFL ${index}`,
  category: 'Sports',
  originalCategory: 'NFL',
  favorite: false,
  providerId: null,
  epgId: 'shared',
  streamReference: String(index + 1).padStart(32, '0'),
});
const page = (q = request, guideRevision = '0') => ({
  schemaVersion: 1 as const,
  accountId,
  accountRevision: '1',
  mediaRevision: '1',
  preferencesRevision: '0',
  queryVersion: ACCOUNT_QUERY_VERSION,
  guideRevision,
  startIndex: q.startIndex,
  anchorIndex: null,
  total: 2,
  items: [row(q.startIndex)],
});

it('requires a captured Guide revision for sport continuation and validates the exact response fence', () => {
  expect(() => validateAccountChannelQuery({ ...request, startIndex: 1 })).toThrow();
  expect(
    validateAccountChannelQuery({ ...request, startIndex: 1, expectedGuideRevision: '0' }),
  ).toMatchObject({ expectedGuideRevision: '0' });
  for (const expectedGuideRevision of ['01', '-1', '9223372036854775808'])
    expect(() => validateAccountChannelQuery({ ...request, expectedGuideRevision })).toThrow();
  expect(() =>
    validateAccountChannelQuery({ ...request, sports: undefined, expectedGuideRevision: '0' }),
  ).toThrow();
  expect(validateAccountChannelQueryPage(page(), request).guideRevision).toBe('0');
  expect(() =>
    validateAccountChannelQueryPage({ ...page(), guideRevision: undefined }, request),
  ).toThrow();
  expect(() =>
    validateAccountChannelQueryPage(page(request, '2'), { ...request, expectedGuideRevision: '1' }),
  ).toThrow();
  expect(() =>
    validateAccountChannelQueryPage(page(), { ...request, sports: undefined }),
  ).toThrow();
});

it('preserves a typed native Guide conflict after owned command settlement', async () => {
  const native = createAccountQuery({
    invoke: async () => {
      throw 'account-guide-revision-conflict';
    },
    idFactory: () => 'guide-fence',
  });
  await expect(native.query(request)).rejects.toBeInstanceOf(AccountGuideRevisionConflict);
});

it('binds Paid page offsets to saved Guide data and permits a fresh anchored recapture after a refresh', async () => {
  const requests: AccountChannelQuery[] = [];
  let revision = '1';
  const owner = createAccountBrowser({
    query: {
      query: async (q) => {
        requests.push(q);
        if (q.expectedGuideRevision !== undefined && q.expectedGuideRevision !== revision)
          throw new AccountGuideRevisionConflict();
        return { ...page(q, revision), ...(q.anchorId ? { anchorIndex: 0 } : {}) };
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
  const scope = {
    schemaVersion: 1 as const,
    query: 'NFL',
    sports,
    filter: 'all' as const,
    sort: 'source' as const,
    pageSize: 1,
  };
  const first = await owner.query(scope, new AbortController().signal);
  expect(first.viewRevision).toBe('m:1;p:0;g:1');
  expect(requests[0].expectedGuideRevision).toBeUndefined();
  await owner.query(
    { ...scope, startIndex: 1, expectedViewRevision: first.viewRevision },
    new AbortController().signal,
  );
  expect(requests[1].expectedGuideRevision).toBe('1');
  expect(owner.selectionFor(row(0).id)).toBeDefined();
  revision = '2';
  await expect(
    owner.query(
      { ...scope, startIndex: 1, expectedViewRevision: first.viewRevision },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: 'view-stale' });
  expect(owner.selectionFor(row(0).id)).toBeUndefined();
  const fresh = await owner.query({ ...scope, anchorId: row(0).id }, new AbortController().signal);
  expect(fresh.viewRevision).toBe('m:1;p:0;g:2');
  expect(requests.at(-1)?.expectedGuideRevision).toBeUndefined();
  await owner.dispose();
});

it('recaptures Paid rows after a favorite write without reselecting the account', async () => {
  const requests: AccountChannelQuery[] = [];
  let preferencesRevision = '0';
  const owner = createAccountBrowser({
    query: {
      query: async (q) => {
        requests.push(q);
        return {
          ...page(q, '1'),
          preferencesRevision,
          anchorIndex: q.anchorId ? 0 : null,
          items: [{ ...row(0), favorite: preferencesRevision === '1' }],
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
  const scope = {
    schemaVersion: 1 as const,
    query: 'NFL',
    sports,
    filter: 'all' as const,
    sort: 'source' as const,
    favoritesFirst: false,
    pageSize: 1,
  };
  const signal = owner.selectionSignal;
  const identity = owner.identity();
  await owner.query(scope, signal);
  const receipt = owner.preferenceScope()!;
  for (const [revision, favorite] of [
    ['1', true],
    ['2', false],
  ] as const) {
    preferencesRevision = revision;
    expect(owner.acknowledgeFavorite({ ...receipt, preferencesRevision })).toBe(true);
    expect(owner.preferenceEpoch()).toBe(Number(revision));
    expect(owner.identity()).toBe(identity);
    expect(signal.aborted).toBe(false);
    expect(owner.selectionFor(row(0).id)).toBeUndefined();
    const refreshed = await owner.query({ ...scope, anchorId: row(0).id }, signal);
    expect(refreshed.anchorIndex).toBe(0);
    expect(owner.selectionFor(row(0).id)).toMatchObject({ favorite });
    expect(requests.at(-1)).toMatchObject({
      anchorId: row(0).id,
      expectedPreferencesRevision: preferencesRevision,
      favoritesFirst: false,
    });
  }
  expect(owner.acknowledgeFavorite(receipt)).toBe(false);
  await owner.dispose();
});
