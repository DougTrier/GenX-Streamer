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

import { invoke, isTauri } from '@tauri-apps/api/core';
import { boundedUtf8Text } from './bounded-text';
import {
  validateAccountChannel,
  type AccountChannel,
  type AccountCatalogFence,
} from './account-catalog';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

export const ACCOUNT_QUERY_VERSION = 'account-sqlite-ascii-v2' as const;
export interface AccountQueryChannel extends AccountChannel {
  favorite: boolean;
  originalCategory: string;
}
export interface AccountChannelQuery {
  schemaVersion: 1;
  accountId: string;
  expectedAccountRevision: string;
  /** null captures the current revision only for an initial startIndex:0 query. */
  expectedMediaRevision: string | null;
  expectedPreferencesRevision?: string | null;
  query: string;
  category: string | null;
  filter: 'all' | 'news' | 'sports' | 'favorites' | 'movies';
  sort: 'source' | 'name' | 'category' | 'country';
  favoritesFirst?: boolean;
  /** An app country code, several joined by commas ("US,CA,UK"), or '' for channels whose country is unknown. */
  country?: string | null;
  /** Leave out groups explicitly labeled adult. */
  hideAdult?: boolean;
  startIndex: number;
  pageSize: number;
  anchorId?: string | null;
}
export interface AccountChannelQueryPage extends AccountCatalogFence {
  schemaVersion: 1;
  queryVersion: typeof ACCOUNT_QUERY_VERSION;
  preferencesRevision: string;
  startIndex: number;
  anchorIndex: number | null;
  total: number;
  items: AccountQueryChannel[];
}

const invalid = () => new Error('The account channel query or response is invalid.');
/** The account is saved but its channels have not been imported yet. */
export class AccountChannelsNotImported extends Error {
  readonly code = 'account-not-imported';
  constructor() {
    super('This account has no channels yet. Choose Refresh channels in Settings.');
  }
}
const pageLimit = 1024 * 1024;
function record(
  value: unknown,
  keys: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const row = value as Record<string, unknown>;
  const present = Object.keys(row);
  if (
    present.length > keys.length + optional.length ||
    keys.some((key) => !Object.hasOwn(row, key)) ||
    present.some((key) => !keys.includes(key) && !optional.includes(key))
  )
    throw invalid();
  return row;
}
function revision(value: unknown, zero = false): value is string {
  return (
    typeof value === 'string' &&
    (zero ? /^(?:0|[1-9][0-9]{0,18})$/u : /^[1-9][0-9]{0,18}$/u).test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function text(value: unknown, limit: number): value is string {
  return boundedUtf8Text(value, limit, true) && !/\p{Cc}/u.test(value) && !value.includes('://');
}
function channelId(value: unknown, accountId: string): value is string {
  const prefix = `account-${accountId}-`;
  return (
    typeof value === 'string' &&
    value.startsWith(prefix) &&
    /^[a-f0-9]{64}$/u.test(value.slice(prefix.length))
  );
}
export function validateAccountQueryChannel(
  value: unknown,
  accountId: string,
): AccountQueryChannel {
  const row = record(value, [
    'id',
    'name',
    'category',
    'providerId',
    'epgId',
    'streamReference',
    'favorite',
    'originalCategory',
  ]);
  if (typeof row.favorite !== 'boolean' || !text(row.originalCategory, 16_384)) throw invalid();
  const channel = validateAccountChannel(
    {
      id: row.id,
      name: row.name,
      category: row.category,
      providerId: row.providerId,
      epgId: row.epgId,
      streamReference: row.streamReference,
    },
    accountId,
  );
  return { ...channel, favorite: row.favorite, originalCategory: row.originalCategory };
}
export function validateAccountChannelQuery(value: AccountChannelQuery): AccountChannelQuery {
  const row = record(
    value,
    [
      'schemaVersion',
      'accountId',
      'expectedAccountRevision',
      'expectedMediaRevision',
      'query',
      'category',
      'filter',
      'sort',
      'startIndex',
      'pageSize',
    ],
    ['anchorId', 'expectedPreferencesRevision', 'favoritesFirst', 'country', 'hideAdult'],
  );
  if (
    row.schemaVersion !== 1 ||
    typeof row.accountId !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(row.accountId) ||
    !revision(row.expectedAccountRevision) ||
    !(
      revision(row.expectedMediaRevision) ||
      (row.expectedMediaRevision === null && row.startIndex === 0)
    ) ||
    !(
      revision(row.expectedPreferencesRevision, true) ||
      (row.expectedPreferencesRevision == null && row.startIndex === 0)
    ) ||
    !text(row.query, 256) ||
    (row.category !== null && !text(row.category, 16_384)) ||
    !['all', 'news', 'sports', 'favorites', 'movies'].includes(row.filter as string) ||
    !['source', 'name', 'category', 'country'].includes(row.sort as string) ||
    (row.country != null &&
      (typeof row.country !== 'string' ||
        !/^(?:[A-Z]{2}(?:,[A-Z]{2}){0,63})?$/u.test(row.country))) ||
    (row.hideAdult !== undefined && typeof row.hideAdult !== 'boolean') ||
    !Number.isSafeInteger(row.startIndex) ||
    (row.startIndex as number) < 0 ||
    (row.startIndex as number) > 100_000 ||
    !Number.isSafeInteger(row.pageSize) ||
    (row.pageSize as number) < 1 ||
    (row.pageSize as number) > 64 ||
    (row.favoritesFirst !== undefined && typeof row.favoritesFirst !== 'boolean') ||
    (row.anchorId != null && !channelId(row.anchorId, row.accountId))
  )
    throw invalid();
  return {
    schemaVersion: 1,
    accountId: row.accountId,
    expectedAccountRevision: row.expectedAccountRevision,
    expectedMediaRevision: row.expectedMediaRevision as string | null,
    expectedPreferencesRevision:
      row.expectedPreferencesRevision == null ? null : (row.expectedPreferencesRevision as string),
    query: row.query,
    category: row.category as string | null,
    filter: row.filter as AccountChannelQuery['filter'],
    sort: row.sort as AccountChannelQuery['sort'],
    favoritesFirst: row.favoritesFirst === undefined ? true : (row.favoritesFirst as boolean),
    startIndex: row.startIndex as number,
    pageSize: row.pageSize as number,
    ...(row.anchorId == null ? {} : { anchorId: row.anchorId as string }),
    ...(row.country == null ? {} : { country: row.country as string }),
    ...(row.hideAdult === undefined ? {} : { hideAdult: row.hideAdult as boolean }),
  };
}
/** Channel counts per resolved country; code null is "country unknown". */
export interface AccountCountrySummary {
  total: number;
  countries: { code: string | null; count: number }[];
}
export function validateAccountCountries(
  value: unknown,
  account: { id: string; revision: string },
): AccountCountrySummary {
  const row = record(value, [
    'schemaVersion',
    'accountId',
    'accountRevision',
    'total',
    'countries',
  ]);
  const count = (n: unknown) => Number.isSafeInteger(n) && (n as number) >= 0;
  if (
    row.schemaVersion !== 1 ||
    row.accountId !== account.id ||
    row.accountRevision !== account.revision ||
    !count(row.total) ||
    !Array.isArray(row.countries) ||
    row.countries.length > 300
  )
    throw invalid();
  const seen = new Set<string | null>();
  const countries = row.countries.map((entry) => {
    const item = record(entry, ['code', 'count']);
    if (
      !(item.code === null || (typeof item.code === 'string' && /^[A-Z]{2}$/u.test(item.code))) ||
      !count(item.count) ||
      seen.has(item.code as string | null)
    )
      throw invalid();
    seen.add(item.code as string | null);
    return { code: item.code as string | null, count: item.count as number };
  });
  if (countries.reduce((sum, item) => sum + item.count, 0) !== row.total) throw invalid();
  return { total: row.total as number, countries };
}
export function validateAccountChannelQueryPage(
  value: unknown,
  expected: AccountChannelQuery,
): AccountChannelQueryPage {
  const request = validateAccountChannelQuery(expected);
  const row = record(value, [
    'schemaVersion',
    'accountId',
    'accountRevision',
    'mediaRevision',
    'preferencesRevision',
    'queryVersion',
    'startIndex',
    'anchorIndex',
    'total',
    'items',
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.accountId !== request.accountId ||
    row.accountRevision !== request.expectedAccountRevision ||
    !revision(row.mediaRevision) ||
    (request.expectedMediaRevision !== null &&
      row.mediaRevision !== request.expectedMediaRevision) ||
    !revision(row.preferencesRevision, true) ||
    (request.expectedPreferencesRevision != null &&
      row.preferencesRevision !== request.expectedPreferencesRevision) ||
    row.queryVersion !== ACCOUNT_QUERY_VERSION ||
    !Number.isSafeInteger(row.startIndex) ||
    (row.startIndex as number) < 0 ||
    (row.startIndex as number) > 100_000 ||
    !Number.isSafeInteger(row.total) ||
    (row.total as number) < 0 ||
    (row.total as number) > 100_000 ||
    !Array.isArray(row.items) ||
    row.items.length > request.pageSize ||
    row.items.length > Math.max(0, (row.total as number) - (row.startIndex as number)) ||
    ((row.startIndex as number) < (row.total as number) && row.items.length === 0) ||
    (row.anchorIndex !== null &&
      (!request.anchorId ||
        !Number.isSafeInteger(row.anchorIndex) ||
        (row.anchorIndex as number) < 0 ||
        (row.anchorIndex as number) >= (row.total as number))) ||
    row.startIndex !==
      (row.anchorIndex === null ? request.startIndex : Math.max((row.anchorIndex as number) - 1, 0))
  )
    throw invalid();
  const identities = new Set<string>();
  const references = new Set<string>();
  const encoder = new TextEncoder();
  let bytes = 0;
  const items = row.items.map((value) => {
    const item = validateAccountQueryChannel(value, request.accountId);
    if (request.filter === 'favorites' && !item.favorite) throw invalid();
    if (identities.has(item.id) || references.has(item.streamReference)) throw invalid();
    identities.add(item.id);
    references.add(item.streamReference);
    bytes += encoder.encode(JSON.stringify(item)).byteLength;
    if (bytes > pageLimit) throw invalid();
    return item;
  });
  const page: AccountChannelQueryPage = {
    schemaVersion: 1,
    accountId: request.accountId,
    accountRevision: request.expectedAccountRevision,
    mediaRevision: row.mediaRevision,
    preferencesRevision: row.preferencesRevision,
    queryVersion: ACCOUNT_QUERY_VERSION,
    startIndex: row.startIndex as number,
    anchorIndex: row.anchorIndex as number | null,
    total: row.total as number,
    items,
  };
  if (page.anchorIndex !== null) {
    const index = page.anchorIndex - page.startIndex;
    if (index < page.items.length && page.items[index]?.id !== request.anchorId) throw invalid();
  }
  if (!boundedUtf8Text(JSON.stringify(page), pageLimit)) throw invalid();
  return page;
}

export function createAccountQuery(runtime?: OwnedNativeRuntime) {
  const native = runtime ?? {
    invoke: (command: string, args?: Record<string, unknown>) => {
      if (!isTauri())
        return Promise.reject(
          new Error('Account channel browsing requires the installed application.'),
        );
      return invoke(command, args);
    },
  };
  return {
    async query(
      request: AccountChannelQuery,
      signal?: AbortSignal,
    ): Promise<AccountChannelQueryPage> {
      const admitted = validateAccountChannelQuery(request);
      return invokeOwnedNative(
        native,
        'query_iptv_account_channels',
        { request: admitted },
        {
          signal,
          validate: (value) => validateAccountChannelQueryPage(value, admitted),
          failure: (error) => {
            throw String(error).includes('account-media-not-collected')
              ? new AccountChannelsNotImported()
              : new Error('Native command could not finish.');
          },
        },
      );
    },
    countries(
      account: { id: string; revision: string },
      hideAdult: boolean,
      signal?: AbortSignal,
    ): Promise<AccountCountrySummary> {
      return invokeOwnedNative(
        native,
        'list_iptv_account_countries',
        {
          request: {
            schemaVersion: 1,
            accountId: account.id,
            expectedAccountRevision: account.revision,
            hideAdult,
          },
        },
        { signal, validate: (value) => validateAccountCountries(value, account) },
      );
    },
  };
}
