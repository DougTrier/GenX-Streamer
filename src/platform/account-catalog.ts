import { invoke, isTauri } from '@tauri-apps/api/core';
import { boundedUtf8Text } from './bounded-text';
import { validateAccountMetadata, type AccountMetadata } from './account-vault';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

/** Account channels have native stream capabilities, never frontend provider URLs. */
export interface AccountChannel {
  id: string;
  name: string;
  category: string;
  providerId: string | null;
  epgId: string | null;
  streamReference: string;
}
export interface AccountCatalogFence {
  accountId: string;
  accountRevision: string;
  mediaRevision: string;
}
export interface AccountCatalogRefreshReceipt extends AccountCatalogFence {
  schemaVersion: 1;
  committed: true;
  channels: number;
  /** Provider entries left out as unusable; absent from older native builds. */
  skipped?: number;
  cleanupPending: boolean;
}
export interface AccountChannelPageRequest {
  schemaVersion: 1;
  accountId: string;
  expectedAccountRevision: string;
  /** null captures the current media revision only on an initial afterId:'' page. */
  expectedMediaRevision: string | null;
  afterId: string;
  limit: number;
}
export interface AccountChannelPage extends AccountCatalogFence {
  schemaVersion: 1;
  channels: AccountChannel[];
  nextAfterId: string | null;
}

const invalid = () => new Error('The account catalog request or response is invalid.');
const controls = /\p{Cc}/u;
const pageLimit = 1024 * 1024;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
    throw invalid();
  return row;
}
function opaque(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
}
function revision(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[1-9][0-9]{0,18}$/u.test(value) &&
    BigInt(value) <= 9223372036854775807n
  );
}
function channelId(value: unknown, accountId: string): value is string {
  const prefix = `account-${accountId}-`;
  return (
    typeof value === 'string' &&
    value.startsWith(prefix) &&
    /^[a-f0-9]{64}$/u.test(value.slice(prefix.length))
  );
}
function text(value: unknown, empty = false): value is string {
  return boundedUtf8Text(value, 16_384, empty) && !controls.test(value) && !value.includes('://');
}
export function validateAccountChannel(value: unknown, accountId: string): AccountChannel {
  if (!opaque(accountId)) throw invalid();
  const row = record(value, ['id', 'name', 'category', 'providerId', 'epgId', 'streamReference']);
  if (
    !channelId(row.id, accountId) ||
    !text(row.name) ||
    !text(row.category, true) ||
    (row.providerId !== null && !text(row.providerId)) ||
    (row.epgId !== null && !text(row.epgId)) ||
    !opaque(row.streamReference)
  )
    throw invalid();
  return {
    id: row.id,
    name: row.name,
    category: row.category,
    providerId: row.providerId as string | null,
    epgId: row.epgId as string | null,
    streamReference: row.streamReference,
  };
}
export function validateAccountCatalogRefreshReceipt(
  value: unknown,
  accountId: string,
  accountRevision: string,
): AccountCatalogRefreshReceipt {
  if (!opaque(accountId) || !revision(accountRevision)) throw invalid();
  const counted =
    !!value && typeof value === 'object' && Object.hasOwn(value as object, 'skipped');
  const row = record(value, [
    'schemaVersion',
    'committed',
    'accountId',
    'accountRevision',
    'mediaRevision',
    'channels',
    ...(counted ? ['skipped'] : []),
    'cleanupPending',
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.committed !== true ||
    row.accountId !== accountId ||
    row.accountRevision !== accountRevision ||
    !revision(row.mediaRevision) ||
    !Number.isSafeInteger(row.channels) ||
    (row.channels as number) < 0 ||
    (row.channels as number) > 100_000 ||
    (counted &&
      (!Number.isSafeInteger(row.skipped) ||
        (row.skipped as number) < 0 ||
        (row.skipped as number) > 100_000)) ||
    typeof row.cleanupPending !== 'boolean'
  )
    throw invalid();
  return {
    schemaVersion: 1,
    committed: true,
    accountId,
    accountRevision,
    mediaRevision: row.mediaRevision,
    channels: row.channels as number,
    ...(counted ? { skipped: row.skipped as number } : {}),
    cleanupPending: row.cleanupPending,
  };
}
function pageRequest(value: AccountChannelPageRequest): AccountChannelPageRequest {
  const row = record(value, [
    'schemaVersion',
    'accountId',
    'expectedAccountRevision',
    'expectedMediaRevision',
    'afterId',
    'limit',
  ]);
  if (
    row.schemaVersion !== 1 ||
    !opaque(row.accountId) ||
    !revision(row.expectedAccountRevision) ||
    !(
      revision(row.expectedMediaRevision) ||
      (row.expectedMediaRevision === null && row.afterId === '')
    ) ||
    !(row.afterId === '' || channelId(row.afterId, row.accountId)) ||
    !Number.isSafeInteger(row.limit) ||
    (row.limit as number) < 1 ||
    (row.limit as number) > 64
  )
    throw invalid();
  return {
    schemaVersion: 1,
    accountId: row.accountId,
    expectedAccountRevision: row.expectedAccountRevision,
    expectedMediaRevision: row.expectedMediaRevision as string | null,
    afterId: row.afterId as string,
    limit: row.limit as number,
  };
}
export function validateAccountChannelPage(
  value: unknown,
  expected: AccountChannelPageRequest,
): AccountChannelPage {
  const request = pageRequest(expected);
  const row = record(value, [
    'schemaVersion',
    'accountId',
    'accountRevision',
    'mediaRevision',
    'channels',
    'nextAfterId',
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.accountId !== request.accountId ||
    row.accountRevision !== request.expectedAccountRevision ||
    !revision(row.mediaRevision) ||
    (request.expectedMediaRevision !== null &&
      row.mediaRevision !== request.expectedMediaRevision) ||
    !Array.isArray(row.channels) ||
    row.channels.length > request.limit
  )
    throw invalid();
  const references = new Set<string>();
  const encoder = new TextEncoder();
  let previousId = request.afterId;
  let bytes = 0;
  const channels = row.channels.map((value) => {
    const channel = validateAccountChannel(value, request.accountId);
    if (channel.id <= previousId || references.has(channel.streamReference)) throw invalid();
    previousId = channel.id;
    references.add(channel.streamReference);
    bytes += encoder.encode(JSON.stringify(channel)).byteLength;
    if (bytes > pageLimit) throw invalid();
    return channel;
  });
  if (row.nextAfterId !== null && (!channels.length || row.nextAfterId !== channels.at(-1)?.id))
    throw invalid();
  const page: AccountChannelPage = {
    schemaVersion: 1,
    accountId: request.accountId,
    accountRevision: request.expectedAccountRevision,
    mediaRevision: row.mediaRevision,
    channels,
    nextAfterId: row.nextAfterId as string | null,
  };
  if (!boundedUtf8Text(JSON.stringify(page), pageLimit)) throw invalid();
  return page;
}

export function createAccountCatalog(runtime?: OwnedNativeRuntime) {
  const native = runtime ?? {
    invoke: (command: string, args?: Record<string, unknown>) => {
      if (!isTauri())
        return Promise.reject(new Error('Account channels require the installed application.'));
      return invoke(command, args);
    },
  };
  return {
    async refresh(
      account: AccountMetadata,
      signal?: AbortSignal,
    ): Promise<AccountCatalogRefreshReceipt> {
      const admitted = validateAccountMetadata(account);
      return invokeOwnedNative(
        native,
        'refresh_iptv_account',
        {
          request: {
            schemaVersion: 1,
            accountId: admitted.id,
            expectedRevision: admitted.revision,
          },
        },
        {
          signal,
          durable: true,
          validate: (value) =>
            validateAccountCatalogRefreshReceipt(value, admitted.id, admitted.revision),
        },
      );
    },
    async page(
      request: AccountChannelPageRequest,
      signal?: AbortSignal,
    ): Promise<AccountChannelPage> {
      const admitted = pageRequest(request);
      return invokeOwnedNative(
        native,
        'list_iptv_account_channels',
        { request: admitted },
        {
          signal,
          validate: (value) => validateAccountChannelPage(value, admitted),
        },
      );
    },
  };
}
