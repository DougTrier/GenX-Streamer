// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it } from 'vitest';
import { createAccountBrowser } from '../../src/application/accounts/account-browser';
import {
  ACCOUNT_QUERY_VERSION,
  validateAccountQueryChannel,
  type AccountChannelQuery,
} from '../../src/platform/account-query';
import { createCatalogQueryAdapter } from '../../src/platform/catalog-query';

it('Paid live browsing preserves explicit PPV with country/search through refresh and returns to a separate ordinary scope', async () => {
  const requests: AccountChannelQuery[] = [];
  const owner = createAccountBrowser({
    query: {
      query: async (request) => {
        requests.push(request);
        return {
          schemaVersion: 1,
          accountId: request.accountId,
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
    id: 'a'.repeat(32),
    name: 'Provider',
    kind: 'xtream',
    serverOrigin: 'https://provider.invalid',
    allowHttp: false,
    revision: '1',
    requiresSignIn: false,
  });
  const scope = {
    schemaVersion: 1 as const,
    query: 'boxing',
    filter: 'ppv' as const,
    geography: { country: 'US' },
    sort: 'source' as const,
    pageSize: 50,
  };
  await owner.query(scope, new AbortController().signal);
  await owner.query(scope, new AbortController().signal);
  await owner.query({ ...scope, filter: 'all' }, new AbortController().signal);
  expect(requests.map((r) => [r.filter, r.query, r.country])).toEqual([
    ['ppv', 'boxing', 'US'],
    ['ppv', 'boxing', 'US'],
    ['all', 'boxing', 'US'],
  ]);
  await owner.dispose();
});

it('Free indexed PPV uses the explicit filter token without changing typed search or geography', async () => {
  let captured: unknown;
  const read = createCatalogQueryAdapter(
    async (_command, args) => {
      captured = args.query;
      return {
        schemaVersion: 1,
        requestId: 'request',
        catalogRevision: '1',
        viewRevision: '1',
        queryVersion: `v1-${'a'.repeat(64)}`,
        totalCount: 0,
        startIndex: 0,
        anchorIndex: null,
        rows: [],
        after: null,
      };
    },
    { requestId: () => 'request' },
  );
  await read(
    {
      schemaVersion: 1,
      query: 'boxing',
      filter: 'ppv',
      geography: { country: 'US' },
      sort: 'source',
      pageSize: 50,
    },
    new AbortController().signal,
  );
  expect(captured).toMatchObject({ filter: 'ppv', query: 'boxing', geography: { country: 'US' } });
});

it('Paid query metadata retains original PPV/category evidence and validates the native classification', () => {
  const accountId = 'a'.repeat(32);
  const row = {
    id: `account-${accountId}-${'b'.repeat(64)}`,
    name: 'Event 1',
    category: 'Sports',
    originalCategory: 'PPV',
    ppv: true,
    favorite: true,
    providerId: null,
    epgId: null,
    streamReference: 'c'.repeat(32),
  };
  expect(validateAccountQueryChannel(row, accountId)).toMatchObject({
    category: 'Sports',
    originalCategory: 'PPV',
    ppv: true,
  });
  expect(() => validateAccountQueryChannel({ ...row, ppv: 'true' }, accountId)).toThrow();
});
