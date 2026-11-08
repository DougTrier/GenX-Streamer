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

import { createOwnedAbortSignals } from '../../platform/abort';
import { boundedUtf8Text } from '../../platform/bounded-text';
import {
  type CatalogPage,
  type CatalogQueryInput,
  type CatalogRow,
} from '../../platform/catalog-query';
import {
  createAccountQuery,
  AccountGuideRevisionConflict,
  validateAccountChannelQueryPage,
  type AccountChannelQuery,
  type AccountQueryChannel,
} from '../../platform/account-query';
import { validateAccountMetadata, type AccountMetadata } from '../../platform/account-vault';
import type { AccountChannel, AccountCatalogFence } from '../../platform/account-catalog';
import { validateSportsScope } from '../../search/sports';
import { validateHistoryIds } from '../../playback/watch-history';

export interface AccountBrowserOptions {
  query?: Pick<ReturnType<typeof createAccountQuery>, 'query'> &
    Partial<Pick<ReturnType<typeof createAccountQuery>, 'countries'>>;
  idFactory?(): string;
  pageChanged?(): void;
}
export interface AccountBrowserSelection {
  ppv?: boolean;
  channel: Readonly<AccountChannel>;
  fence: Readonly<AccountCatalogFence>;
  favorite: boolean;
  originalCategory: string;
  preferencesRevision: string;
}
export interface AccountBrowserPreferencesScope extends AccountCatalogFence {
  preferencesRevision: string;
}
const canceled = () => new DOMException('Account browsing was canceled.', 'AbortError');
const invalid = () => new Error('The account browsing request is invalid.');
const stale = () => new Error('Account channels changed. Reload the channel list.');
function viewRevision(value: string): {
  mediaRevision: string;
  preferencesRevision: string;
  guideRevision?: string;
} {
  if (typeof value !== 'string') throw invalid();
  const match = /^m:([1-9][0-9]{0,18});p:(0|[1-9][0-9]{0,18})(?:;g:(0|[1-9][0-9]{0,18}))?$/u.exec(
    value,
  );
  if (
    !match ||
    BigInt(match[1]) > 9223372036854775807n ||
    BigInt(match[2]) > 9223372036854775807n ||
    (match[3] !== undefined && BigInt(match[3]) > 9223372036854775807n)
  )
    throw invalid();
  return {
    mediaRevision: match[1],
    preferencesRevision: match[2],
    ...(match[3] === undefined ? {} : { guideRevision: match[3] }),
  };
}
function input(value: CatalogQueryInput): CatalogQueryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const keys = ['schemaVersion', 'query', 'filter', 'sort', 'pageSize'];
  const optional = [
    'expectedCatalogRevision',
    'expectedViewRevision',
    'expectedGuideRevision',
    'geography',
    'favoritesFirst',
    'favoritesOnly',
    'hideAdult',
    'sports',
    'historyIds',
    'after',
    'startIndex',
    'anchorId',
  ];
  if (
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key)) ||
    value.schemaVersion !== 1 ||
    !boundedUtf8Text(value.query, 256, true) ||
    !['all', 'favorites', 'news', 'sports', 'movies', 'ppv', 'watched'].includes(value.filter) ||
    !['source', 'name', 'geography'].includes(value.sort) ||
    !Number.isSafeInteger(value.pageSize) ||
    value.pageSize < 1 ||
    value.pageSize > 50 ||
    (value.startIndex !== undefined &&
      (!Number.isSafeInteger(value.startIndex) ||
        value.startIndex < 0 ||
        value.startIndex > 100_000)) ||
    (value.anchorId != null && value.startIndex !== undefined) ||
    (value.favoritesFirst !== undefined && typeof value.favoritesFirst !== 'boolean') ||
    (value.favoritesOnly !== undefined && typeof value.favoritesOnly !== 'boolean') ||
    (value.hideAdult !== undefined && typeof value.hideAdult !== 'boolean')
  )
    throw invalid();
  let historyIds: string[] | undefined;
  try {
    if (value.filter === 'watched') historyIds = validateHistoryIds(value.historyIds);
    else if (value.historyIds !== undefined) throw invalid();
  } catch {
    throw invalid();
  }
  if (value.after != null)
    throw new Error(
      'Account browsing requires an offset or channel anchor. Reload the channel list.',
    );
  if (value.geography !== undefined) {
    if (
      !value.geography ||
      typeof value.geography !== 'object' ||
      Array.isArray(value.geography) ||
      Object.keys(value.geography).some(
        (key) => !['country', 'region', 'state', 'countries'].includes(key),
      )
    )
      throw invalid();
    // Paid channels have a country (from their provider group) but no region or state.
    const { country, region, state, countries } = value.geography;
    if (
      (countries !== undefined &&
        (!Array.isArray(countries) ||
          countries.length < 2 ||
          countries.length > 64 ||
          new Set(countries).size !== countries.length ||
          !countries.every((c) => typeof c === 'string' && /^[A-Z]{2}$/u.test(c)) ||
          country !== undefined)) ||
      (country !== undefined && country !== null && !/^[A-Z]{2}$/u.test(country)) ||
      (region !== undefined && region !== null) ||
      (state !== undefined && state !== null)
    )
      throw new Error('Paid channels can be filtered by country only. Clear the region or state.');
  }
  const revision = (value: unknown) =>
    typeof value === 'string' &&
    /^[1-9][0-9]{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n;
  if (value.expectedCatalogRevision != null && !revision(value.expectedCatalogRevision))
    throw invalid();
  if (value.expectedViewRevision != null) viewRevision(value.expectedViewRevision);
  if (
    value.expectedGuideRevision !== undefined &&
    (!value.sports ||
      typeof value.expectedGuideRevision !== 'string' ||
      !/^(0|[1-9][0-9]{0,18})$/.test(value.expectedGuideRevision) ||
      BigInt(value.expectedGuideRevision) > 9223372036854775807n)
  )
    throw invalid();
  return {
    ...value,
    ...(historyIds === undefined ? {} : { historyIds }),
    ...(value.sports === undefined
      ? {}
      : { sports: validateSportsScope(value.sports, value.query) }),
    ...(value.geography
      ? {
          geography: {
            ...value.geography,
            ...(value.geography.countries ? { countries: [...value.geography.countries] } : {}),
          },
        }
      : {}),
  };
}

/** Offset/anchor account metadata projection for the existing three-page CatalogWindow. */
export function createAccountBrowser(options: AccountBrowserOptions = {}) {
  const native = options.query ?? createAccountQuery();
  let selected: AccountMetadata | null = null;
  let selectionController = new AbortController();
  const selectionListeners = new Set<() => void>();
  let capturedFence: Readonly<AccountCatalogFence> | null = null;
  let preferencesRevision: string | null = null;
  let guideRevision: string | null = null;
  let selectionEpoch = 0;
  let preferenceEpoch = 0;
  let scopeEpoch = 0;
  let scopeKey = '';
  let closed = false;
  let work: Promise<unknown> = Promise.resolve();
  const owners = new Set<AbortController>();
  const pages = new Map<number, readonly Readonly<AccountQueryChannel>[]>();
  const capabilities = new Map<string, Readonly<AccountQueryChannel>>();
  const clearPages = () => {
    pages.clear();
    capabilities.clear();
  };
  const abortReads = () => {
    for (const owner of owners) owner.abort();
  };
  const cache = (start: number, channels: readonly AccountQueryChannel[]) => {
    pages.delete(start);
    pages.set(
      start,
      channels.map((channel) => Object.freeze({ ...channel })),
    );
    while (pages.size > 3) pages.delete(pages.keys().next().value!);
    capabilities.clear();
    for (const page of pages.values())
      for (const channel of page) capabilities.set(channel.id, channel);
  };
  async function select(account: AccountMetadata | null): Promise<void> {
    if (closed) throw new Error('Account browsing is closed.');
    const admitted = account === null ? null : validateAccountMetadata(account);
    selectionController.abort();
    selectionController = new AbortController();
    ++selectionEpoch;
    ++scopeEpoch;
    selected = admitted;
    capturedFence = null;
    preferencesRevision = null;
    guideRevision = null;
    scopeKey = '';
    clearPages();
    abortReads();
    const previous = work;
    await previous.catch(() => undefined);
    for (const listener of selectionListeners) listener();
  }
  return {
    /** Account-owned background reads cancel immediately when selection changes. */
    get selectionSignal(): AbortSignal {
      return selectionController.signal;
    },
    subscribeSelection(listener: () => void): () => void {
      selectionListeners.add(listener);
      return () => selectionListeners.delete(listener);
    },
    get selectedAccount(): Readonly<AccountMetadata> | null {
      return selected ? Object.freeze({ ...selected }) : null;
    },
    revision(): string {
      return selected?.revision ?? '0';
    },
    identity(): string {
      return selected ? `account/${selected.id}/${selected.revision}/${selectionEpoch}` : 'public';
    },
    preferenceEpoch(): number {
      return preferenceEpoch;
    },
    acknowledgeFavorite(receipt: AccountBrowserPreferencesScope): boolean {
      if (
        closed ||
        !selected ||
        !capturedFence ||
        selected.id !== receipt.accountId ||
        selected.revision !== receipt.accountRevision ||
        capturedFence.mediaRevision !== receipt.mediaRevision ||
        preferencesRevision === null ||
        BigInt(receipt.preferencesRevision) < BigInt(preferencesRevision)
      )
        return false;
      if (preferencesRevision === receipt.preferencesRevision) return true;
      preferencesRevision = receipt.preferencesRevision;
      preferenceEpoch++;
      scopeEpoch++;
      abortReads();
      clearPages();
      return true;
    },
    preferenceScope(): Readonly<AccountBrowserPreferencesScope> | undefined {
      if (
        !selected ||
        !capturedFence ||
        preferencesRevision === null ||
        capturedFence.accountId !== selected.id ||
        capturedFence.accountRevision !== selected.revision
      )
        return undefined;
      return Object.freeze({ ...capturedFence, preferencesRevision });
    },
    selectionFor(id: string): AccountBrowserSelection | undefined {
      const channel = capabilities.get(id);
      if (
        !channel ||
        !selected ||
        !capturedFence ||
        preferencesRevision === null ||
        capturedFence.accountId !== selected.id ||
        capturedFence.accountRevision !== selected.revision
      )
        return undefined;
      const raw: AccountChannel = {
        id: channel.id,
        name: channel.name,
        category: channel.category,
        providerId: channel.providerId,
        epgId: channel.epgId,
        streamReference: channel.streamReference,
      };
      return {
        channel: Object.freeze(raw),
        fence: Object.freeze({ ...capturedFence }),
        favorite: channel.favorite,
        ...(channel.ppv === undefined ? {} : { ppv: channel.ppv }),
        originalCategory: channel.originalCategory,
        preferencesRevision,
      };
    },
    select,
    /** Channel counts per country for the selected account, or null without one. */
    async countries(hideAdult: boolean, signal: AbortSignal) {
      if (closed || !selected || !native.countries) return null;
      const account = { id: selected.id, revision: selected.revision };
      const summary = await native.countries(account, hideAdult, signal);
      // A summary for an account that is no longer selected is never shown.
      if (selected?.id !== account.id || selected.revision !== account.revision) throw canceled();
      return summary;
    },
    query(raw: CatalogQueryInput, signal: AbortSignal): Promise<CatalogPage> {
      if (closed || !selected)
        return Promise.reject(new Error('Select a saved account before browsing its channels.'));
      let admitted: CatalogQueryInput;
      try {
        admitted = input(raw);
      } catch (error) {
        return Promise.reject(error);
      }
      if (signal.aborted) return Promise.reject(canceled());
      const account = { ...selected };
      if (
        admitted.expectedCatalogRevision != null &&
        admitted.expectedCatalogRevision !== account.revision
      )
        return Promise.reject(stale());
      // undefined = all countries; null = country unknown ('' natively);
      // several countries travel as one comma-separated list ("US,CA,UK").
      const country = admitted.geography?.country;
      const several = admitted.geography?.countries;
      const nativeCountry = several
        ? several.join(',')
        : country === undefined
          ? undefined
          : (country ?? '');
      const key = JSON.stringify([
        admitted.query,
        admitted.filter,
        admitted.historyIds ?? null,
        admitted.sports ?? null,
        admitted.sort,
        admitted.favoritesFirst ?? true,
        admitted.favoritesOnly ?? false,
        nativeCountry ?? null,
        admitted.hideAdult ?? false,
      ]);
      if (scopeKey !== key) {
        scopeKey = key;
        ++scopeEpoch;
        abortReads();
        clearPages();
        guideRevision = null;
      }
      const epoch = selectionEpoch;
      const scope = scopeEpoch;
      const owned = new AbortController();
      owners.add(owned);
      const combined = createOwnedAbortSignals([owned.signal, signal]);
      const current = () =>
        !closed &&
        !combined.signal.aborted &&
        epoch === selectionEpoch &&
        scope === scopeEpoch &&
        selected?.id === account.id &&
        selected.revision === account.revision;
      const prior = work;
      const task = (async (): Promise<CatalogPage> => {
        await prior.catch(() => undefined);
        try {
          if (!current()) throw canceled();
          const requestedView =
            admitted.expectedViewRevision == null
              ? null
              : viewRevision(admitted.expectedViewRevision);
          const mediaRevision =
            requestedView?.mediaRevision ?? capturedFence?.mediaRevision ?? null;
          const expectedPreferencesRevision =
            requestedView?.preferencesRevision ?? preferencesRevision;
          const expectedGuideRevision = admitted.sports
            ? (admitted.expectedGuideRevision ??
              requestedView?.guideRevision ??
              (admitted.expectedViewRevision == null && (admitted.startIndex ?? 0) === 0
                ? undefined
                : (guideRevision ?? undefined)))
            : undefined;
          if (admitted.sports && requestedView && requestedView.guideRevision === undefined)
            throw new AccountGuideRevisionConflict();
          if (
            admitted.expectedGuideRevision !== undefined &&
            requestedView?.guideRevision !== undefined &&
            admitted.expectedGuideRevision !== requestedView.guideRevision
          )
            throw new AccountGuideRevisionConflict();
          if (capturedFence && mediaRevision !== capturedFence.mediaRevision) throw stale();
          if (preferencesRevision !== null && expectedPreferencesRevision !== preferencesRevision)
            throw stale();
          const request: AccountChannelQuery = {
            schemaVersion: 1,
            accountId: account.id,
            expectedAccountRevision: account.revision,
            expectedMediaRevision: mediaRevision,
            expectedPreferencesRevision,
            ...(expectedGuideRevision === undefined ? {} : { expectedGuideRevision }),
            query: admitted.query,
            category: null,
            // Not responding is Free TV only; the admission above refuses it here.
            filter: admitted.filter as AccountChannelQuery['filter'],
            ...(admitted.historyIds === undefined ? {} : { historyIds: admitted.historyIds }),
            ...(admitted.sports ? { sports: admitted.sports } : {}),
            sort:
              admitted.sort === 'name'
                ? 'name'
                : admitted.sort === 'geography'
                  ? 'country'
                  : 'source',
            favoritesFirst: admitted.favoritesFirst ?? true,
            ...(admitted.favoritesOnly ? { favoritesOnly: true } : {}),
            ...(nativeCountry === undefined ? {} : { country: nativeCountry }),
            ...(admitted.hideAdult ? { hideAdult: true } : {}),
            startIndex: admitted.startIndex ?? 0,
            pageSize: admitted.pageSize,
            ...(admitted.anchorId == null ? {} : { anchorId: admitted.anchorId }),
          };
          const result = await native.query(request, combined.signal);
          const page = validateAccountChannelQueryPage(result, request);
          if (!current()) throw canceled();
          capturedFence = Object.freeze({
            accountId: page.accountId,
            accountRevision: page.accountRevision,
            mediaRevision: page.mediaRevision,
          });
          preferencesRevision = page.preferencesRevision;
          if (
            guideRevision !== null &&
            page.guideRevision !== undefined &&
            guideRevision !== page.guideRevision
          )
            clearPages();
          guideRevision = page.guideRevision ?? null;
          const rows: CatalogRow[] = page.items.map((channel) => ({
            id: channel.id,
            sourceId: `account-${account.id}`,
            name: channel.name,
            category: channel.category,
            originalCategory: channel.originalCategory,
            ...(channel.ppv === undefined ? {} : { ppv: channel.ppv }),
            favorite: channel.favorite,
            ...(channel.providerId === null ? {} : { providerId: channel.providerId }),
          }));
          const resultPage: CatalogPage = {
            schemaVersion: 1,
            requestId: (options.idFactory ?? (() => crypto.randomUUID()))(),
            catalogRevision: page.accountRevision,
            viewRevision: `m:${page.mediaRevision};p:${page.preferencesRevision}${page.guideRevision === undefined ? '' : `;g:${page.guideRevision}`}`,
            ...(page.guideRevision === undefined ? {} : { guideRevision: page.guideRevision }),
            queryVersion: page.queryVersion,
            totalCount: page.total,
            startIndex: page.startIndex,
            anchorIndex: page.anchorIndex,
            rows,
            after: null,
          };
          if (!boundedUtf8Text(JSON.stringify(resultPage), 1024 * 1024)) throw invalid();
          cache(page.startIndex, page.items);
          options.pageChanged?.();
          return resultPage;
        } catch (error) {
          if (!current()) throw canceled();
          clearPages();
          if (error instanceof AccountGuideRevisionConflict) {
            guideRevision = null;
            throw error;
          }
          throw new Error(
            'Account channels could not be read. Reload the account channel list and try again.',
            { cause: error },
          );
        } finally {
          owners.delete(owned);
          combined.dispose();
        }
      })();
      work = task;
      return task;
    },
    async dispose(): Promise<void> {
      if (!closed) {
        closed = true;
        selectionController.abort();
        selectionListeners.clear();
        ++selectionEpoch;
        ++scopeEpoch;
        selected = null;
        capturedFence = null;
        preferencesRevision = null;
        guideRevision = null;
        clearPages();
        abortReads();
      }
      await work.catch(() => undefined);
    },
  };
}
