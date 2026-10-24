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

import { isTauri, invoke } from '@tauri-apps/api/core';
import { validateCatalog, validateSource, type Source } from '../catalog';
import { boundedJsonUtf8Bytes } from '../data-transfer/json-byte-admission';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';
import type {
  IncrementalSnapshotTransport,
  SourceSnapshotBegin,
  SourceSnapshotPromotion,
  SourceSnapshotStage,
} from '../discovery/incremental-refresh';

const refused = () => new Error('Local source snapshot response could not be admitted.');
function object(raw: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    !raw ||
    typeof raw !== 'object' ||
    Array.isArray(raw) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(raw))
  )
    throw refused();
  const own = Reflect.ownKeys(raw);
  if (
    own.length !== keys.length ||
    own.some((key) => typeof key !== 'string' || !keys.includes(key))
  )
    throw refused();
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(raw, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw refused();
    out[key] = descriptor.value;
  }
  return out;
}
function decimal(raw: unknown): string {
  if (
    typeof raw !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/u.test(raw) ||
    BigInt(raw) > 9223372036854775807n
  )
    throw refused();
  return raw;
}
function count(raw: unknown): number {
  if (!Number.isSafeInteger(raw) || (raw as number) < 0 || (raw as number) > 100_000)
    throw refused();
  return raw as number;
}
function hasControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
function id(raw: unknown, limit = 256): string {
  if (
    typeof raw !== 'string' ||
    !raw ||
    new TextEncoder().encode(raw).length > limit ||
    hasControl(raw)
  )
    throw refused();
  return raw;
}
export function validateSourceSnapshotStage(raw: unknown): SourceSnapshotStage {
  const v = object(raw, [
    'schemaVersion',
    'snapshotId',
    'sourceId',
    'sourceRevision',
    'nextIndex',
    'entryCount',
  ]);
  if (v.schemaVersion !== 1) throw refused();
  const nextIndex = count(v.nextIndex),
    entryCount = count(v.entryCount);
  if (nextIndex > entryCount) throw refused();
  return Object.freeze({
    schemaVersion: 1,
    snapshotId: id(v.snapshotId, 128),
    sourceId: id(v.sourceId),
    sourceRevision: decimal(v.sourceRevision),
    nextIndex,
    entryCount,
  });
}
export function validateSourceSnapshotPromotion(raw: unknown): SourceSnapshotPromotion {
  const v = object(raw, [
    'schemaVersion',
    'committed',
    'sourceId',
    'sourceRevision',
    'added',
    'changed',
    'unchanged',
    'removed',
    'duplicates',
    'total',
  ]);
  if (v.schemaVersion !== 1 || v.committed !== true) throw refused();
  const added = count(v.added),
    changed = count(v.changed),
    unchanged = count(v.unchanged),
    removed = count(v.removed),
    duplicates = count(v.duplicates),
    total = count(v.total);
  if (added + changed + unchanged !== total || total + duplicates > 100_000) throw refused();
  return Object.freeze({
    schemaVersion: 1,
    committed: true,
    sourceId: id(v.sourceId),
    sourceRevision: decimal(v.sourceRevision),
    added,
    changed,
    unchanged,
    removed,
    duplicates,
    total,
  });
}
/** Native source authority and stable-target health proof are not client supplied. */
export interface SourceSnapshotChecksQuery {
  sourceId: string;
  expectedSourceRevision: string;
  afterOrdinal: number | null;
  limit: number;
  nowMs: number;
  positiveTtlMs: number;
  retryAfterMs: number;
  platform: string;
  observerProfile: string;
}
export interface SourceSnapshotCheckPage {
  schemaVersion: 1;
  sourceRevision: string;
  rows: readonly {
    entryId: string;
    ordinal: number;
    contentHash: string;
    addressHash: string;
    permissionFingerprint: string;
    channel: import('../catalog').Channel;
  }[];
  afterOrdinal: number | null;
  exhausted: boolean;
}
export interface SourceSnapshotStatus {
  schemaVersion: 1;
  sourceId: string;
  sourceRevision: string;
  total: number;
  missing: number;
  staging: SourceSnapshotStage | null;
}
export function validateSourceSnapshotStatus(raw: unknown): SourceSnapshotStatus {
  const v = object(raw, [
    'schemaVersion',
    'sourceId',
    'sourceRevision',
    'total',
    'missing',
    'staging',
  ]);
  if (v.schemaVersion !== 1) throw refused();
  const sourceId = id(v.sourceId),
    sourceRevision = decimal(v.sourceRevision),
    total = count(v.total),
    missing = count(v.missing);
  const staging = v.staging === null ? null : validateSourceSnapshotStage(v.staging);
  if (
    missing > total ||
    (staging && (staging.sourceId !== sourceId || staging.sourceRevision !== sourceRevision))
  )
    throw refused();
  return Object.freeze({ schemaVersion: 1, sourceId, sourceRevision, total, missing, staging });
}
export function createSourceSnapshotTransport(
  options: { runtime?: OwnedNativeRuntime; native?: () => boolean } = {},
): IncrementalSnapshotTransport & {
  listChecks(
    query: SourceSnapshotChecksQuery,
    source: Source,
    signal: AbortSignal,
  ): Promise<SourceSnapshotCheckPage>;
  status(sourceId: string, signal: AbortSignal): Promise<SourceSnapshotStatus>;
} {
  const runtime = options.runtime ?? { invoke };
  const native = options.native ?? isTauri;
  const staged = new Map<string, { source: Source; receipt: SourceSnapshotStage }>();
  const available = () => {
    if (!native())
      throw new Error('Local incremental source indexing is unavailable on this platform.');
  };
  const call = <T>(
    command: string,
    request: unknown,
    signal: AbortSignal,
    validate: (raw: unknown) => T,
    durable = false,
  ) => {
    available();
    return invokeOwnedNative(runtime, command, { request }, { signal, validate, durable });
  };
  return {
    status: async (sourceId, signal) => {
      available();
      signal.throwIfAborted();
      const expected = id(sourceId);
      return call(
        'source_snapshot_status',
        { schemaVersion: 1, sourceId: expected },
        signal,
        (raw) => {
          const result = validateSourceSnapshotStatus(raw);
          if (result.sourceId !== expected) throw refused();
          return result;
        },
      );
    },
    begin: async (input: SourceSnapshotBegin, signal) => {
      available();
      signal.throwIfAborted();
      if (staged.size >= 100 || input.schemaVersion !== 1) throw refused();
      const source = validateSource(input.source),
        expected = decimal(input.expectedSourceRevision);
      count(input.entryCount);
      id(input.platform);
      id(input.observerProfile);
      const request = {
        schemaVersion: 1,
        source,
        expectedSourceRevision: expected,
        entryCount: input.entryCount,
        platform: input.platform,
        observerProfile: input.observerProfile,
      };
      boundedJsonUtf8Bytes(request, 1024 * 1024, signal);
      const stage = await call('begin_source_snapshot', request, signal, (raw) => {
        const value = validateSourceSnapshotStage(raw);
        if (
          value.sourceId !== source.id ||
          value.sourceRevision !== expected ||
          value.nextIndex !== 0 ||
          value.entryCount !== input.entryCount
        )
          throw refused();
        return value;
      });
      staged.set(stage.snapshotId, { source, receipt: stage });
      return stage;
    },
    append: async (input, signal) => {
      available();
      signal.throwIfAborted();
      const saved = staged.get(input.snapshotId);
      if (
        !saved ||
        input.expectedNextIndex !== saved.receipt.nextIndex ||
        !input.entries.length ||
        input.entries.length > 64
      )
        throw refused();
      const entries = input.entries.map((entry) => {
        if (
          typeof entry.entryId !== 'string' ||
          new TextEncoder().encode(entry.entryId).length > 16384 ||
          hasControl(entry.entryId)
        )
          throw refused();
        // Temporary ID exists only for shared metadata validation; native whole-source
        // reconciliation ignores caller IDs and determines persisted source-index identity.
        const channel = validateCatalog({
          schemaVersion: 1,
          // This admits syntax into a private index, not network access. Native
          // checks and publication retain the unchanged saved HTTP permission.
          sources: [{ ...saved.source, allowHttp: true }],
          channels: [{ ...entry.channel, id: 'staging-admission' }],
        }).channels[0]!;
        const { id: ignoredId, ...metadata } = channel;
        void ignoredId;
        return { entryId: entry.entryId, channel: metadata };
      });
      const request = {
        snapshotId: input.snapshotId,
        expectedNextIndex: input.expectedNextIndex,
        entries,
      };
      boundedJsonUtf8Bytes(request, 1024 * 1024, signal);
      const stage = await call('append_source_snapshot', request, signal, (raw) => {
        const value = validateSourceSnapshotStage(raw);
        if (
          value.snapshotId !== input.snapshotId ||
          value.sourceId !== saved.source.id ||
          value.sourceRevision !== saved.receipt.sourceRevision ||
          value.entryCount !== saved.receipt.entryCount ||
          value.nextIndex !== input.expectedNextIndex + entries.length
        )
          throw refused();
        return value;
      });
      staged.set(stage.snapshotId, { source: saved.source, receipt: stage });
      return stage;
    },
    promote: async (input, signal) => {
      available();
      signal.throwIfAborted();
      const saved = staged.get(input.snapshotId);
      if (
        !saved ||
        input.completed !== true ||
        input.expectedSourceRevision !== saved.receipt.sourceRevision ||
        saved.receipt.nextIndex !== saved.receipt.entryCount
      )
        throw refused();
      const request = {
        snapshotId: input.snapshotId,
        expectedSourceRevision: input.expectedSourceRevision,
        completed: true,
      };
      const result = await call(
        'promote_source_snapshot',
        request,
        signal,
        (raw) => {
          const value = validateSourceSnapshotPromotion(raw);
          if (
            value.sourceId !== saved.source.id ||
            BigInt(value.sourceRevision) !== BigInt(saved.receipt.sourceRevision) + 1n ||
            value.total + value.duplicates !== saved.receipt.entryCount
          )
            throw refused();
          return value;
        },
        true,
      );
      staged.delete(input.snapshotId);
      return result;
    },
    listChecks: async (input, source, signal) => {
      available();
      signal.throwIfAborted();
      const canonical = validateSource(source);
      if (
        id(input.sourceId) !== canonical.id ||
        !Number.isInteger(input.limit) ||
        input.limit < 1 ||
        input.limit > 64 ||
        !Number.isSafeInteger(input.nowMs) ||
        input.nowMs < 0 ||
        input.nowMs > 8.64e15 ||
        [input.positiveTtlMs, input.retryAfterMs].some(
          (v, i) => !Number.isSafeInteger(v) || v < 0 || v > (i === 0 ? 7 : 1) * 86_400_000,
        )
      )
        throw refused();
      if (input.afterOrdinal !== null && count(input.afterOrdinal) >= 100_000) throw refused();
      const request = {
        sourceId: input.sourceId,
        expectedSourceRevision: decimal(input.expectedSourceRevision),
        afterOrdinal: input.afterOrdinal,
        limit: input.limit,
        nowMs: input.nowMs,
        positiveTtlMs: input.positiveTtlMs,
        retryAfterMs: input.retryAfterMs,
        platform: id(input.platform),
        observerProfile: id(input.observerProfile),
      };
      return call('list_source_snapshot_checks', request, signal, (raw) => {
        boundedJsonUtf8Bytes(raw, 1024 * 1024);
        const value = object(raw, [
          'schemaVersion',
          'sourceRevision',
          'rows',
          'afterOrdinal',
          'exhausted',
        ]);
        if (
          value.schemaVersion !== 1 ||
          decimal(value.sourceRevision) !== request.expectedSourceRevision ||
          !Array.isArray(value.rows) ||
          value.rows.length > input.limit ||
          typeof value.exhausted !== 'boolean'
        )
          throw refused();
        let prior = input.afterOrdinal ?? -1;
        const rows = value.rows.map((rawRow) => {
          const row = object(rawRow, [
            'entryId',
            'ordinal',
            'contentHash',
            'addressHash',
            'permissionFingerprint',
            'channel',
          ]);
          const ordinal = count(row.ordinal),
            entryId = id(row.entryId, 16384);
          if (ordinal >= 100_000 || ordinal <= prior) throw refused();
          prior = ordinal;
          for (const key of ['contentHash', 'addressHash', 'permissionFingerprint'])
            if (typeof row[key] !== 'string' || !/^[a-f0-9]{64}$/u.test(row[key] as string))
              throw refused();
          const channel = validateCatalog({
            schemaVersion: 1,
            sources: [canonical],
            channels: [row.channel],
          }).channels[0]!;
          if (channel.id !== entryId) throw refused();
          return Object.freeze({
            entryId,
            ordinal,
            contentHash: row.contentHash as string,
            addressHash: row.addressHash as string,
            permissionFingerprint: row.permissionFingerprint as string,
            channel,
          });
        });
        const afterOrdinal = value.afterOrdinal === null ? null : count(value.afterOrdinal);
        if (
          (rows.length && afterOrdinal !== prior) ||
          (!rows.length && (afterOrdinal !== null || !value.exhausted))
        )
          throw refused();
        return Object.freeze({
          schemaVersion: 1,
          sourceRevision: request.expectedSourceRevision,
          rows: Object.freeze(rows),
          afterOrdinal,
          exhausted: value.exhausted,
        });
      });
    },
  };
}
