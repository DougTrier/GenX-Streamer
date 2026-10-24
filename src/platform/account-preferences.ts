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
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

export interface AccountPreferencesScope {
  schemaVersion: 1;
  accountId: string;
  expectedAccountRevision: string;
  expectedMediaRevision: string;
  /** Canonical decimal string. An account without saved channel preferences has revision '0'. */
  expectedPreferencesRevision: string;
}
export type AccountPreferencesMutation =
  | { kind: 'favorite'; channelId: string; favorite: boolean }
  | { kind: 'remove'; channelId: string }
  | { kind: 'restore'; channelId: string }
  | { kind: 'category'; channelId: string; category: string | null }
  | { kind: 'restoreAll' };
export interface AccountPreferencesWriteRequest extends AccountPreferencesScope {
  mutation: AccountPreferencesMutation;
}
export interface AccountPreferencesReceipt {
  schemaVersion: 1;
  committed: true;
  accountId: string;
  accountRevision: string;
  mediaRevision: string;
  preferencesRevision: string;
  changed: boolean;
  cleanupPending: boolean;
}

const invalid = () => new Error('The account channel preferences request or response is invalid.');
const scopeKeys = [
  'schemaVersion',
  'accountId',
  'expectedAccountRevision',
  'expectedMediaRevision',
  'expectedPreferencesRevision',
] as const;
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const row = value as Record<string, unknown>;
  if (Object.keys(row).length !== keys.length || keys.some((key) => !Object.hasOwn(row, key)))
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
function scope(row: Record<string, unknown>): AccountPreferencesScope {
  if (
    row.schemaVersion !== 1 ||
    typeof row.accountId !== 'string' ||
    !/^[a-f0-9]{32}$/u.test(row.accountId) ||
    !revision(row.expectedAccountRevision) ||
    !revision(row.expectedMediaRevision) ||
    !revision(row.expectedPreferencesRevision, true)
  )
    throw invalid();
  return {
    schemaVersion: 1,
    accountId: row.accountId,
    expectedAccountRevision: row.expectedAccountRevision,
    expectedMediaRevision: row.expectedMediaRevision,
    expectedPreferencesRevision: row.expectedPreferencesRevision,
  };
}
function mutation(value: unknown, accountId: string): AccountPreferencesMutation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const kind = (value as Record<string, unknown>).kind;
  const row = record(
    value,
    kind === 'restoreAll'
      ? ['kind']
      : kind === 'favorite'
        ? ['kind', 'channelId', 'favorite']
        : kind === 'category'
          ? ['kind', 'channelId', 'category']
          : ['kind', 'channelId'],
  );
  if (row.kind === 'restoreAll') return { kind: 'restoreAll' };
  const prefix = `account-${accountId}-`;
  if (
    typeof row.channelId !== 'string' ||
    !row.channelId.startsWith(prefix) ||
    !/^[a-f0-9]{64}$/u.test(row.channelId.slice(prefix.length))
  )
    throw invalid();
  if (row.kind === 'favorite' && typeof row.favorite === 'boolean')
    return { kind: 'favorite', channelId: row.channelId, favorite: row.favorite };
  if (row.kind === 'remove' || row.kind === 'restore')
    return { kind: row.kind, channelId: row.channelId };
  if (
    row.kind === 'category' &&
    (row.category === null ||
      (boundedUtf8Text(row.category, 16_384, true) &&
        !/\p{Cc}/u.test(row.category) &&
        !row.category.includes('://')))
  )
    return { kind: 'category', channelId: row.channelId, category: row.category as string | null };
  throw invalid();
}
export function validateAccountPreferencesWriteRequest(
  value: AccountPreferencesWriteRequest,
): AccountPreferencesWriteRequest {
  const row = record(value, [...scopeKeys, 'mutation']);
  const admitted = scope(row);
  return { ...admitted, mutation: mutation(row.mutation, admitted.accountId) };
}
export function validateAccountPreferencesReceipt(
  value: unknown,
  expected: AccountPreferencesWriteRequest,
): AccountPreferencesReceipt {
  const request = validateAccountPreferencesWriteRequest(expected);
  const row = record(value, [
    'schemaVersion',
    'committed',
    'accountId',
    'accountRevision',
    'mediaRevision',
    'preferencesRevision',
    'changed',
    'cleanupPending',
  ]);
  if (
    row.schemaVersion !== 1 ||
    row.committed !== true ||
    row.accountId !== request.accountId ||
    row.accountRevision !== request.expectedAccountRevision ||
    row.mediaRevision !== request.expectedMediaRevision ||
    !revision(row.preferencesRevision, true) ||
    typeof row.changed !== 'boolean' ||
    typeof row.cleanupPending !== 'boolean' ||
    row.preferencesRevision !==
      (row.changed
        ? (BigInt(request.expectedPreferencesRevision) + 1n).toString()
        : request.expectedPreferencesRevision)
  )
    throw invalid();
  return {
    schemaVersion: 1,
    committed: true,
    accountId: request.accountId,
    accountRevision: request.expectedAccountRevision,
    mediaRevision: request.expectedMediaRevision,
    preferencesRevision: row.preferencesRevision,
    changed: row.changed,
    cleanupPending: row.cleanupPending,
  };
}

export function createAccountPreferences(runtime?: OwnedNativeRuntime) {
  const native = runtime ?? {
    invoke: (command: string, args?: Record<string, unknown>) => {
      if (!isTauri())
        return Promise.reject(
          new Error('Account channel preferences require the installed application.'),
        );
      return invoke(command, args);
    },
  };
  async function write(
    request: AccountPreferencesWriteRequest,
    signal?: AbortSignal,
  ): Promise<AccountPreferencesReceipt> {
    const admitted = validateAccountPreferencesWriteRequest(request);
    return invokeOwnedNative(
      native,
      'write_iptv_account_preferences',
      { request: admitted },
      {
        signal,
        durable: true,
        validate: (value) => validateAccountPreferencesReceipt(value, admitted),
      },
    );
  }
  return {
    write,
    /** Restores removed channels only within this account; favorite/category values are preserved. */
    async restoreAll(
      request: AccountPreferencesScope,
      signal?: AbortSignal,
    ): Promise<AccountPreferencesReceipt> {
      const admitted = scope(record(request, scopeKeys));
      return write({ ...admitted, mutation: { kind: 'restoreAll' } }, signal);
    },
  };
}
