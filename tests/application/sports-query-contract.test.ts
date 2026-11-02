// Copyright 2026 Doug Trier. SPDX-License-Identifier: Apache-2.0
import { expect, it, vi } from 'vitest';
import { createAccountBrowser } from '../../src/application/accounts/account-browser';
import { ACCOUNT_QUERY_VERSION, type AccountChannelQuery } from '../../src/platform/account-query';
import { createCatalogQueryAdapter } from '../../src/platform/catalog-query';
import { captureSportsScope } from '../../src/search/sports';

it('passes a stable, copied Free sports window through paging and admits only explicitly mixed PPV replies', async () => {
  const requests: Record<string, unknown>[] = [];
  const read = createCatalogQueryAdapter(
    async (_command, args) => {
      const q = args.query as Record<string, unknown>;
      requests.push(q);
      return {
        schemaVersion: 1,
        requestId: 'request',
        catalogRevision: '1',
        viewRevision: '1',
        ...(q.sports ? { guideRevision: '1' } : {}),
        queryVersion: `v1-${'a'.repeat(64)}`,
        totalCount: 2,
        startIndex: q.startIndex ?? 0,
        anchorIndex: null,
        rows: [
          {
            id: `row${q.startIndex ?? 0}`,
            sourceId: 'source',
            name: 'FOX',
            category: 'General',
            favorite: false,
            ppv: true,
          },
        ],
        after: q.startIndex
          ? null
          : {
              schemaVersion: 1,
              queryKey: 'b'.repeat(64),
              catalogRevision: '1',
              viewRevision: '1',
              sortKey: '',
              id: 'row0',
            },
      };
    },
    { requestId: () => 'request' },
  );
  const sports = captureSportsScope('NFL', {}, 1800001)!;
  const input = {
    schemaVersion: 1 as const,
    query: 'NFL',
    filter: 'all' as const,
    sort: 'source' as const,
    pageSize: 1,
    sports,
  };
  await read(input, new AbortController().signal);
  await read({ ...input, startIndex: 1, expectedGuideRevision: '1' }, new AbortController().signal);
  expect(requests[1].expectedGuideRevision).toBe('1');
  expect(requests.map((q) => q.sports)).toEqual([sports, sports]);
  expect(requests[0]!.sports).not.toBe(sports);
  await expect(
    read({ ...input, sports: undefined }, new AbortController().signal),
  ).rejects.toThrow();
  const count = requests.length;
  await expect(
    read(
      { ...input, sports: { ...sports, vocabularyVersion: 'stale' } },
      new AbortController().signal,
    ),
  ).rejects.toThrow();
  await expect(read({ ...input, query: 'Bears' }, new AbortController().signal)).rejects.toThrow();
  expect(requests).toHaveLength(count);
});

it('replaces a Paid sports scope as a new query owner, cancels old paging, and retains country/favorites', async () => {
  const requests: AccountChannelQuery[] = [];
  let firstSignal: AbortSignal | undefined;
  const owner = createAccountBrowser({
    query: {
      query: async (request, signal) => {
        requests.push(request);
        if (requests.length === 1) {
          if (!signal) throw new Error('Expected an owned account query signal');
          firstSignal = signal;
          await new Promise((_resolve, reject) =>
            signal.addEventListener(
              'abort',
              () => reject(new DOMException('replaced', 'AbortError')),
              { once: true },
            ),
          );
        }
        return {
          schemaVersion: 1,
          accountId: request.accountId,
          accountRevision: '1',
          mediaRevision: '1',
          preferencesRevision: '0',
          guideRevision: '0',
          queryVersion: ACCOUNT_QUERY_VERSION,
          startIndex: request.startIndex,
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
    name: 'Offline metadata',
    kind: 'xtream',
    serverOrigin: 'https://fixture.invalid',
    allowHttp: false,
    revision: '1',
    requiresSignIn: false,
  });
  const initial = {
    schemaVersion: 1 as const,
    query: '',
    filter: 'favorites' as const,
    sort: 'name' as const,
    geography: { country: 'US' },
    pageSize: 50,
    sports: captureSportsScope('', { sport: 'american-football', league: 'nfl' }, 1800001)!,
  };
  const old = owner
    .query(initial, new AbortController().signal)
    .catch((error: Error) => error.name);
  await vi.waitFor(() => expect(requests).toHaveLength(1));
  const replacement = {
    ...initial,
    sports: captureSportsScope('', { sport: 'basketball', league: 'nba' }, 1800001)!,
  };
  const next = owner.query(replacement, new AbortController().signal);
  expect(firstSignal?.aborted).toBe(true);
  expect(await old).toBe('AbortError');
  await next;
  expect(requests.map((q) => [q.sports?.league, q.country, q.filter, q.sort])).toEqual([
    ['nfl', 'US', 'favorites', 'name'],
    ['nba', 'US', 'favorites', 'name'],
  ]);
  await owner.dispose();
});
