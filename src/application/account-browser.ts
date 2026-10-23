import { createOwnedAbortSignals } from '../platform/abort';
import { boundedUtf8Text } from '../platform/bounded-text';
import type { CatalogPage, CatalogQueryInput, CatalogRow } from '../platform/catalog-query';
import {
  createAccountQuery,
  validateAccountChannelQueryPage,
  type AccountChannelQuery,
  type AccountQueryChannel,
} from '../platform/account-query';
import { validateAccountMetadata, type AccountMetadata } from '../platform/account-vault';
import type { AccountChannel, AccountCatalogFence } from '../platform/account-catalog';

export interface AccountBrowserOptions {
  query?: Pick<ReturnType<typeof createAccountQuery>, 'query'> &
    Partial<Pick<ReturnType<typeof createAccountQuery>, 'countries'>>;
  idFactory?(): string;
  pageChanged?(): void;
}
export interface AccountBrowserSelection {
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
function viewRevision(value: string): { mediaRevision: string; preferencesRevision: string } {
  if (typeof value !== 'string') throw invalid();
  const match = /^m:([1-9][0-9]{0,18});p:(0|[1-9][0-9]{0,18})$/u.exec(value);
  if (!match || BigInt(match[1]) > 9223372036854775807n || BigInt(match[2]) > 9223372036854775807n)
    throw invalid();
  return { mediaRevision: match[1], preferencesRevision: match[2] };
}
function input(value: CatalogQueryInput): CatalogQueryInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const keys = ['schemaVersion', 'query', 'filter', 'sort', 'pageSize'];
  const optional = [
    'expectedCatalogRevision',
    'expectedViewRevision',
    'geography',
    'favoritesFirst',
    'hideAdult',
    'after',
    'startIndex',
    'anchorId',
  ];
  if (
    keys.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !keys.includes(key) && !optional.includes(key)) ||
    value.schemaVersion !== 1 ||
    !boundedUtf8Text(value.query, 256, true) ||
    !['all', 'favorites', 'news', 'sports', 'movies'].includes(value.filter) ||
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
    (value.hideAdult !== undefined && typeof value.hideAdult !== 'boolean')
  )
    throw invalid();
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
  return {
    ...value,
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
  let capturedFence: Readonly<AccountCatalogFence> | null = null;
  let preferencesRevision: string | null = null;
  let selectionEpoch = 0;
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
    ++selectionEpoch;
    ++scopeEpoch;
    selected = admitted;
    capturedFence = null;
    preferencesRevision = null;
    scopeKey = '';
    clearPages();
    abortReads();
    const previous = work;
    await previous.catch(() => undefined);
  }
  return {
    get selectedAccount(): Readonly<AccountMetadata> | null {
      return selected ? Object.freeze({ ...selected }) : null;
    },
    revision(): string {
      return selected?.revision ?? '0';
    },
    identity(): string {
      return selected ? `account/${selected.id}/${selected.revision}/${selectionEpoch}` : 'public';
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
        admitted.sort,
        admitted.favoritesFirst ?? true,
        nativeCountry ?? null,
        admitted.hideAdult ?? false,
      ]);
      if (scopeKey !== key) {
        scopeKey = key;
        ++scopeEpoch;
        abortReads();
        clearPages();
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
          if (capturedFence && mediaRevision !== capturedFence.mediaRevision) throw stale();
          if (preferencesRevision !== null && expectedPreferencesRevision !== preferencesRevision)
            throw stale();
          const request: AccountChannelQuery = {
            schemaVersion: 1,
            accountId: account.id,
            expectedAccountRevision: account.revision,
            expectedMediaRevision: mediaRevision,
            expectedPreferencesRevision,
            query: admitted.query,
            category: null,
            // Not responding is Free TV only; the admission above refuses it here.
            filter: admitted.filter as AccountChannelQuery['filter'],
            sort:
              admitted.sort === 'name'
                ? 'name'
                : admitted.sort === 'geography'
                  ? 'country'
                  : 'source',
            favoritesFirst: admitted.favoritesFirst ?? true,
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
          const rows: CatalogRow[] = page.items.map((channel) => ({
            id: channel.id,
            sourceId: `account-${account.id}`,
            name: channel.name,
            category: channel.category,
            favorite: channel.favorite,
            ...(channel.providerId === null ? {} : { providerId: channel.providerId }),
          }));
          const resultPage: CatalogPage = {
            schemaVersion: 1,
            requestId: (options.idFactory ?? (() => crypto.randomUUID()))(),
            catalogRevision: page.accountRevision,
            viewRevision: `m:${page.mediaRevision};p:${page.preferencesRevision}`,
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
        } catch {
          if (!current()) throw canceled();
          clearPages();
          throw new Error(
            'Account channels could not be read. Reload the account channel list and try again.',
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
        ++selectionEpoch;
        ++scopeEpoch;
        selected = null;
        capturedFence = null;
        preferencesRevision = null;
        clearPages();
        abortReads();
      }
      await work.catch(() => undefined);
    },
  };
}
