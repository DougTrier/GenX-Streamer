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
export interface CatalogCursor {
  schemaVersion: 1;
  queryKey: string;
  catalogRevision: string;
  viewRevision: string;
  sortKey: string;
  id: string;
}
export interface CatalogRow {
  id: string;
  sourceId: string;
  providerId?: string;
  name: string;
  category: string;
  geography?: { country?: string; region?: string; state?: string };
  favorite: boolean;
}
export interface CatalogQuery {
  schemaVersion: 1;
  requestId: string;
  expectedCatalogRevision?: string | null;
  expectedViewRevision?: string | null;
  query: string;
  filter: 'all' | 'favorites' | 'news' | 'sports' | 'movies' | 'unresponsive';
  geography?: {
    country?: string | null;
    region?: string | null;
    state?: string | null;
    /** Any of these countries (2 to 64 codes). */
    countries?: readonly string[];
  };
  sort: 'source' | 'name' | 'geography';
  favoritesFirst?: boolean;
  /** Leave out channels explicitly labeled adult. */
  hideAdult?: boolean;
  after?: CatalogCursor | null;
  startIndex?: number;
  anchorId?: string | null;
  pageSize: number;
}
export interface CatalogPage {
  schemaVersion: 1;
  requestId: string;
  catalogRevision: string;
  viewRevision: string;
  queryVersion: string;
  totalCount: number;
  startIndex: number;
  anchorIndex: number | null;
  rows: CatalogRow[];
  after: CatalogCursor | null;
}
export type CatalogQueryInput = Omit<CatalogQuery, 'requestId'>;
export type CatalogQueryTransport = (
  command: 'query_catalog_page' | 'cancel_catalog_query',
  args: Record<string, unknown>,
) => Promise<unknown>;
export class CatalogQueryError extends Error {
  constructor(
    public readonly code:
      | 'invalid-query'
      | 'invalid-page'
      | 'catalog-stale'
      | 'view-stale'
      | 'cursor-stale'
      | 'unavailable'
      | 'cancel-unconfirmed',
  ) {
    super(
      code === 'cancel-unconfirmed'
        ? 'Channel query cancellation could not be confirmed.'
        : code.endsWith('stale')
          ? 'Saved channels changed. Refresh the channel list.'
          : 'The channel list could not be read. Retry when ready.',
    );
  }
}
function fail(code: CatalogQueryError['code']): never {
  throw new CatalogQueryError(code);
}
function object(
  value: unknown,
  keys: readonly string[],
  code: CatalogQueryError['code'],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    fail(code);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (
    Reflect.ownKeys(descriptors).some(
      (k) => typeof k !== 'string' || !keys.includes(k) || !('value' in descriptors[k]),
    )
  )
    fail(code);
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, empty = false): value is string {
  return (
    boundedUtf8Text(value, max, empty) &&
    ![...(value as string)].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
  );
}
function revision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^(0|[1-9][0-9]{0,18})$/.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function integer(value: unknown, max: number): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
}
function geography(value: unknown, nullable: boolean, code: CatalogQueryError['code']) {
  const v = object(value, nullable ? ['country', 'region', 'state', 'countries'] : ['country', 'region', 'state'], code);
  if ('countries' in v) {
    const list = v.countries;
    if (
      !Array.isArray(list) ||
      list.length < 2 ||
      list.length > 64 ||
      new Set(list).size !== list.length ||
      !list.every((c) => typeof c === 'string' && /^[A-Z0-9_-]{1,32}$/.test(c)) ||
      'country' in v ||
      'region' in v ||
      'state' in v
    )
      fail(code);
    return { countries: [...(list as string[])] };
  }
  for (const key of Object.keys(v))
    if (
      !(nullable && v[key] === null) &&
      !(typeof v[key] === 'string' && /^[A-Z0-9_-]{1,32}$/.test(v[key] as string))
    )
      fail(code);
  return { ...v };
}
function cursor(value: unknown, code: CatalogQueryError['code']): CatalogCursor {
  const v = object(
    value,
    ['schemaVersion', 'queryKey', 'catalogRevision', 'viewRevision', 'sortKey', 'id'],
    code,
  );
  if (
    v.schemaVersion !== 1 ||
    typeof v.queryKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.queryKey) ||
    !revision(v.catalogRevision) ||
    !revision(v.viewRevision) ||
    typeof v.sortKey !== 'string' ||
    v.sortKey.length > 256 * 1024 ||
    v.sortKey.length % 2 !== 0 ||
    !/^[a-f0-9]*$/.test(v.sortKey) ||
    !text(v.id, 16384)
  )
    fail(code);
  return { ...v } as unknown as CatalogCursor;
}
function query(input: CatalogQueryInput, requestId: string): CatalogQuery {
  const v = object(
    input,
    [
      'schemaVersion',
      'expectedCatalogRevision',
      'expectedViewRevision',
      'query',
      'filter',
      'geography',
      'sort',
      'favoritesFirst',
      'hideAdult',
      'after',
      'startIndex',
      'anchorId',
      'pageSize',
    ],
    'invalid-query',
  );
  if (
    v.schemaVersion !== 1 ||
    !boundedUtf8Text(v.query, 16384, true) ||
    !['all', 'favorites', 'news', 'sports', 'movies', 'unresponsive'].includes(String(v.filter)) ||
    !['source', 'name', 'geography'].includes(String(v.sort)) ||
    (v.favoritesFirst !== undefined && typeof v.favoritesFirst !== 'boolean') ||
    (v.hideAdult !== undefined && typeof v.hideAdult !== 'boolean') ||
    !integer(v.pageSize, 50) ||
    v.pageSize < 1 ||
    !text(requestId, 256)
  )
    fail('invalid-query');
  for (const k of ['expectedCatalogRevision', 'expectedViewRevision'])
    if (v[k] !== undefined && v[k] !== null && !revision(v[k])) fail('invalid-query');
  if (
    v.startIndex !== undefined &&
    (!integer(v.startIndex, 100000) || (v.after !== undefined && v.after !== null))
  )
    fail('invalid-query');
  if (
    v.anchorId != null &&
    (!text(v.anchorId, 16384) || v.startIndex !== undefined || v.after != null)
  )
    fail('invalid-query');
  const after = v.after == null ? v.after : cursor(v.after, 'invalid-query');
  if (
    after &&
    (v.expectedCatalogRevision !== after.catalogRevision ||
      v.expectedViewRevision !== after.viewRevision)
  )
    fail('invalid-query');
  return {
    ...v,
    requestId,
    ...(v.geography === undefined
      ? {}
      : { geography: geography(v.geography, true, 'invalid-query') }),
    ...(after == null ? {} : { after }),
  } as unknown as CatalogQuery;
}
export function validateCatalogPage(raw: unknown, q: CatalogQuery): CatalogPage {
  try {
    if (!boundedUtf8Text(JSON.stringify(raw), 1024 * 1024)) fail('invalid-page');
  } catch {
    fail('invalid-page');
  }
  const v = object(
    raw,
    [
      'schemaVersion',
      'requestId',
      'catalogRevision',
      'viewRevision',
      'queryVersion',
      'totalCount',
      'startIndex',
      'anchorIndex',
      'rows',
      'after',
    ],
    'invalid-page',
  );
  if (
    v.schemaVersion !== 1 ||
    v.requestId !== q.requestId ||
    !revision(v.catalogRevision) ||
    !revision(v.viewRevision) ||
    typeof v.queryVersion !== 'string' ||
    !/^v1-[a-f0-9]{64}$/.test(v.queryVersion) ||
    !integer(v.totalCount, 100000) ||
    !integer(v.startIndex, 100000) ||
    !(v.anchorIndex === null || integer(v.anchorIndex, 99999)) ||
    !Array.isArray(v.rows) ||
    v.rows.length > q.pageSize ||
    !(v.after === null || typeof v.after === 'object')
  )
    fail('invalid-page');
  if (q.expectedCatalogRevision != null && v.catalogRevision !== q.expectedCatalogRevision)
    fail('catalog-stale');
  if (q.expectedViewRevision != null && v.viewRevision !== q.expectedViewRevision)
    fail('view-stale');
  if (!q.after && !q.anchorId && v.startIndex !== (q.startIndex ?? 0)) fail('invalid-page');
  if (!q.anchorId && v.anchorIndex !== null) fail('invalid-page');
  if (
    q.anchorId &&
    (v.anchorIndex === null
      ? v.startIndex !== 0
      : v.startIndex !== Math.max(0, Number(v.anchorIndex) - 1) ||
        Number(v.anchorIndex) >= Number(v.totalCount))
  )
    fail('invalid-page');
  const ids = new Set<string>();
  const rows = v.rows.map((rawRow) => {
    const r = object(
      rawRow,
      ['id', 'sourceId', 'providerId', 'name', 'category', 'geography', 'favorite'],
      'invalid-page',
    );
    if (
      !text(r.id, 16384) ||
      !text(r.sourceId, 256) ||
      !text(r.name, 16384) ||
      !text(r.category, 16384, true) ||
      (r.providerId !== undefined && !text(r.providerId, 16384)) ||
      typeof r.favorite !== 'boolean' ||
      ids.has(r.id)
    )
      fail('invalid-page');
    ids.add(r.id);
    return {
      ...r,
      ...(r.geography === undefined
        ? {}
        : { geography: geography(r.geography, false, 'invalid-page') }),
    } as unknown as CatalogRow;
  });
  if (rows.length && Number(v.startIndex) + rows.length > Number(v.totalCount))
    fail('invalid-page');
  const after = v.after === null ? null : cursor(v.after, 'invalid-page');
  if (
    after &&
    (after.catalogRevision !== v.catalogRevision ||
      after.viewRevision !== v.viewRevision ||
      !rows.length ||
      after.id !== rows.at(-1)!.id ||
      (q.after && after.queryKey !== q.after.queryKey) ||
      Number(v.startIndex) + rows.length >= Number(v.totalCount))
  )
    fail('invalid-page');
  if (!after && rows.length && Number(v.startIndex) + rows.length < Number(v.totalCount))
    fail('invalid-page');
  return { ...v, rows, after } as unknown as CatalogPage;
}
const catalogQueryObservation = {
  originalPending: 0,
  cancelRequested: 0,
  cancelAckPending: 0,
  originalSettled: 0,
  abortedPending: 0,
};
/** Aggregate lifecycle counters only; no request identities or query metadata. */
export function readCatalogQueryObservation(): Readonly<typeof catalogQueryObservation> {
  return Object.freeze({ ...catalogQueryObservation });
}
if (typeof window !== 'undefined')
  Object.defineProperty(window, '__GENX_CATALOG_QUERY__', {
    enumerable: false,
    configurable: false,
    get: readCatalogQueryObservation,
  });
export function createCatalogQueryAdapter(
  transport: CatalogQueryTransport,
  options: { requestId?: () => string } = {},
) {
  return async (input: CatalogQueryInput, signal: AbortSignal): Promise<CatalogPage> => {
    signal.throwIfAborted();
    const q = query(input, (options.requestId ?? (() => crypto.randomUUID()))());
    signal.throwIfAborted();
    let cancellation: Promise<void> | null = null,
      cancelFailed = false;
    let aborted = false;
    catalogQueryObservation.originalPending++;
    const cancel = () => {
      if (aborted) return;
      aborted = true;
      catalogQueryObservation.abortedPending++;
      catalogQueryObservation.cancelRequested++;
      catalogQueryObservation.cancelAckPending++;
      cancellation = Promise.resolve()
        .then(() => transport('cancel_catalog_query', { requestId: q.requestId }))
        .then(
          () => undefined,
          () => {
            cancelFailed = true;
          },
        )
        .finally(() => {
          catalogQueryObservation.cancelAckPending--;
        });
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      let raw: unknown;
      try {
        raw = await transport('query_catalog_page', { query: q });
      } finally {
        catalogQueryObservation.originalSettled++;
        catalogQueryObservation.originalPending--;
      }
      signal.throwIfAborted();
      return validateCatalogPage(raw, q);
    } catch (error) {
      if (signal.aborted) throw new DOMException('Channel query canceled.', 'AbortError');
      if (error instanceof CatalogQueryError) throw error;
      if (error === 'catalog-revision-stale') fail('catalog-stale');
      if (error === 'catalog-view-revision-stale') fail('view-stale');
      if (error === 'catalog-query-cursor-stale') fail('cursor-stale');
      fail('unavailable');
    } finally {
      signal.removeEventListener('abort', cancel);
      await cancellation;
      if (aborted) catalogQueryObservation.abortedPending--;
      if (cancelFailed) fail('cancel-unconfirmed');
    }
  };
}
const nativeQuery = createCatalogQueryAdapter((command, args) => invoke(command, args));
export function queryCatalogPage(
  input: CatalogQueryInput,
  signal: AbortSignal,
): Promise<CatalogPage> {
  if (!isTauri()) return Promise.reject(new CatalogQueryError('unavailable'));
  return nativeQuery(input, signal);
}
