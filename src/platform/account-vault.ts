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

export type AccountKind = 'xtream' | 'playlist';
/** Revisions stay decimal strings throughout the bridge; never convert to Number. */
export interface AccountMetadata {
  schemaVersion: 1;
  id: string;
  name: string;
  kind: AccountKind;
  serverOrigin: string;
  /** This account's own explicit grant for an unencrypted HTTP provider. */
  allowHttp: boolean;
  revision: string;
  requiresSignIn: boolean;
}
interface AccountSaveBase {
  schemaVersion: 1;
  name: string;
  allowHttp: boolean;
  accountId?: string;
  expectedRevision?: string;
}
/** Only the caller's transient form and the native save RPC receive these fields. */
export type AccountSaveRequest = AccountSaveBase &
  (
    | { kind: 'xtream'; serverUrl: string; username: string; password: string }
    | { kind: 'playlist'; playlistUrl: string }
  );
export interface AccountRemoveRequest {
  schemaVersion: 1;
  accountId: string;
  expectedRevision: string;
}
export interface AccountSaveReceipt {
  schemaVersion: 1;
  committed: true;
  metadata: AccountMetadata;
  cleanupPending: boolean;
}
export interface AccountRemoveReceipt {
  schemaVersion: 1;
  committed: true;
  cleanupPending: boolean;
}

const revisionLimit = 9223372036854775807n;
const controls = /\p{Cc}/u;
const invalid = () => new Error('The account request or response is invalid.');
function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw invalid();
  const result = value as Record<string, unknown>;
  const keys = Object.keys(result);
  if (
    keys.length > required.length + optional.length ||
    required.some((key) => !Object.hasOwn(result, key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw invalid();
  return result;
}
function text(value: unknown, limit: number): value is string {
  return boundedUtf8Text(value, limit) && !controls.test(value);
}
function credential(value: unknown): value is string {
  return boundedUtf8Text(value, 2048, true) && value.length > 0 && !controls.test(value);
}
function opaque(value: unknown): value is string {
  return typeof value === 'string' && /^[a-f0-9]{32}$/u.test(value);
}
function revision(value: unknown, mutable = false): value is string {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,18}$/u.test(value)) return false;
  const parsed = BigInt(value);
  return mutable ? parsed < revisionLimit : parsed <= revisionLimit;
}
/** HTTPS, or plain HTTP only with the account's own explicit grant. */
function tlsOrigin(value: unknown, originOnly: boolean, allowHttp = false): string {
  if (!text(value, 12 * 1024) || value !== value.trim()) throw invalid();
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid();
  }
  if (
    !(url.protocol === 'https:' || (allowHttp && url.protocol === 'http:')) ||
    !url.hostname ||
    url.username ||
    url.password ||
    value.includes('#') ||
    (originOnly && url.origin !== value)
  )
    throw invalid();
  return url.origin;
}

export function validateAccountMetadata(value: unknown): AccountMetadata {
  const row = record(value, [
    'schemaVersion',
    'id',
    'name',
    'kind',
    'serverOrigin',
    'allowHttp',
    'revision',
    'requiresSignIn',
  ]);
  if (
    row.schemaVersion !== 1 ||
    !opaque(row.id) ||
    !text(row.name, 160) ||
    row.name !== row.name.trim() ||
    !['xtream', 'playlist'].includes(row.kind as string) ||
    typeof row.allowHttp !== 'boolean' ||
    !revision(row.revision) ||
    typeof row.requiresSignIn !== 'boolean'
  )
    throw invalid();
  tlsOrigin(row.serverOrigin, true, row.allowHttp);
  return {
    schemaVersion: 1,
    id: row.id,
    name: row.name,
    kind: row.kind as AccountKind,
    serverOrigin: row.serverOrigin as string,
    allowHttp: row.allowHttp,
    revision: row.revision,
    requiresSignIn: row.requiresSignIn,
  };
}
export function validateAccountList(value: unknown): AccountMetadata[] {
  if (!Array.isArray(value) || value.length > 64) throw invalid();
  const seen = new Set<string>();
  return value.map((row) => {
    const metadata = validateAccountMetadata(row);
    if (seen.has(metadata.id)) throw invalid();
    seen.add(metadata.id);
    return metadata;
  });
}
export function validateAccountSaveReceipt(value: unknown): AccountSaveReceipt {
  const receipt = record(value, ['schemaVersion', 'committed', 'metadata', 'cleanupPending']);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.committed !== true ||
    typeof receipt.cleanupPending !== 'boolean'
  )
    throw invalid();
  return {
    schemaVersion: 1,
    committed: true,
    metadata: validateAccountMetadata(receipt.metadata),
    cleanupPending: receipt.cleanupPending,
  };
}
export function validateAccountRemoveReceipt(value: unknown): AccountRemoveReceipt {
  const receipt = record(value, ['schemaVersion', 'committed', 'cleanupPending']);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.committed !== true ||
    typeof receipt.cleanupPending !== 'boolean'
  )
    throw invalid();
  return { schemaVersion: 1, committed: true, cleanupPending: receipt.cleanupPending };
}
function savePayload(input: AccountSaveRequest): {
  payload: Record<string, unknown>;
  origin: string;
} {
  const candidate = record(
    input,
    ['schemaVersion', 'name', 'kind', 'allowHttp'],
    ['accountId', 'expectedRevision', 'serverUrl', 'username', 'password', 'playlistUrl'],
  );
  const row = record(
    candidate,
    candidate.kind === 'xtream'
      ? ['schemaVersion', 'name', 'kind', 'allowHttp', 'serverUrl', 'username', 'password']
      : ['schemaVersion', 'name', 'kind', 'allowHttp', 'playlistUrl'],
    ['accountId', 'expectedRevision'],
  );
  if (row.schemaVersion !== 1 || typeof row.allowHttp !== 'boolean' || !text(row.name, 160))
    throw invalid();
  const updating = row.accountId !== undefined || row.expectedRevision !== undefined;
  if (updating && (!opaque(row.accountId) || !revision(row.expectedRevision, true)))
    throw invalid();
  if (row.kind !== 'xtream' && row.kind !== 'playlist') throw invalid();
  if (row.kind === 'xtream' && (!credential(row.username) || !credential(row.password)))
    throw invalid();
  const origin = tlsOrigin(
    row.kind === 'xtream' ? row.serverUrl : row.playlistUrl,
    false,
    row.allowHttp,
  );
  // Copy only admitted fields; no secret is retained by the returned bridge or receipt.
  return { payload: { ...row }, origin };
}

export function createAccountVault(runtime?: OwnedNativeRuntime) {
  const native: OwnedNativeRuntime = runtime ?? {
    invoke: (command, args) => invoke(command, args),
  };
  const available = () => {
    if (!runtime && !isTauri())
      throw new Error('Account sign-in requires the installed application.');
  };
  return {
    async list(signal?: AbortSignal): Promise<AccountMetadata[]> {
      available();
      return invokeOwnedNative(
        native,
        'list_iptv_accounts',
        {},
        { signal, validate: validateAccountList },
      );
    },
    async save(request: AccountSaveRequest, signal?: AbortSignal): Promise<AccountSaveReceipt> {
      available();
      const { payload, origin } = savePayload(request);
      return invokeOwnedNative(
        native,
        'save_iptv_account',
        { request: payload },
        {
          signal,
          durable: true,
          validate: (value) => {
            const receipt = validateAccountSaveReceipt(value);
            const metadata = receipt.metadata;
            if (
              metadata.kind !== payload.kind ||
              metadata.name !== (payload.name as string).trim() ||
              metadata.serverOrigin !== origin ||
              metadata.allowHttp !== payload.allowHttp ||
              metadata.requiresSignIn ||
              (payload.accountId !== undefined && metadata.id !== payload.accountId) ||
              metadata.revision !==
                (payload.expectedRevision === undefined
                  ? '1'
                  : (BigInt(payload.expectedRevision as string) + 1n).toString())
            )
              throw invalid();
            return receipt;
          },
        },
      );
    },
    async remove(
      request: AccountRemoveRequest,
      signal?: AbortSignal,
    ): Promise<AccountRemoveReceipt> {
      available();
      const row = record(request, ['schemaVersion', 'accountId', 'expectedRevision']);
      if (
        row.schemaVersion !== 1 ||
        !opaque(row.accountId) ||
        !revision(row.expectedRevision, true)
      )
        throw invalid();
      return invokeOwnedNative(
        native,
        'remove_iptv_account',
        { request: { ...row } },
        {
          signal,
          durable: true,
          validate: validateAccountRemoveReceipt,
        },
      );
    },
  };
}

const vault = createAccountVault();
export const listIptvAccounts = vault.list;
export const saveIptvAccount = vault.save;
export const removeIptvAccount = vault.remove;
