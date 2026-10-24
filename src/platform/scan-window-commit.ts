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
import { validateScanBatch, type ScanBatch } from './scan-batch-commit';
import { boundedUtf8Text } from './bounded-text';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';
import {
  validateCommitReceipt,
  RecordRevisionConflictError,
  type CommitReceipt,
} from './record-transaction';

export interface ScanWindow extends Omit<ScanBatch, 'catalogPatch' | 'incomingHealth'> {
  chunks: readonly Pick<ScanBatch, 'catalogPatch' | 'incomingHealth'>[];
}
export class ScanWindowValidationError extends Error {
  constructor() {
    super('Scan publication window is invalid or exceeds its storage bounds.');
    this.name = 'ScanWindowValidationError';
  }
}
function invalid(): never {
  throw new ScanWindowValidationError();
}
function object(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return invalid();
  return raw as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    invalid();
}
/** New aggregate admission; the legacy chunk validator and its 64 limit remain unchanged. */
export function validateScanWindow(raw: unknown): ScanWindow {
  try {
    const value = object(raw);
    exact(
      value,
      [
        'schemaVersion',
        'chunks',
        'authorizedSources',
        'nextPreferences',
        'expectedCatalogRevision',
        'expectedHealthRevision',
      ],
      ['scanCheckpoint', 'expectedCheckpointRevision'],
    );
    if (!Array.isArray(value.chunks) || value.chunks.length < 1 || value.chunks.length > 4)
      invalid();
    // Reserve the owned command's UUID and wrapper before dispatch.
    if (
      !boundedUtf8Text(
        JSON.stringify({ window: value, requestId: '0'.repeat(36) }),
        20 * 1024 * 1024,
      )
    )
      invalid();
    const { chunks: _chunks, ...shared } = value;
    const chunks = value.chunks.map((rawChunk) => {
      const chunk = object(rawChunk);
      exact(chunk, ['catalogPatch', 'incomingHealth']);
      const admitted = validateScanBatch({ ...shared, ...chunk });
      return { catalogPatch: admitted.catalogPatch, incomingHealth: admitted.incomingHealth };
    });
    const first = validateScanBatch({ ...shared, ...chunks[0] });
    for (let index = 1; index < chunks.length; index++) {
      const before = chunks[index - 1].catalogPatch,
        after = chunks[index].catalogPatch;
      if (
        before.finalChannelCount !== after.baseChannelCount ||
        before.finalSourceCount !== after.baseSourceCount
      )
        invalid();
    }
    if (
      new Set(chunks.flatMap((chunk) => chunk.catalogPatch.channels.map((channel) => channel.id)))
        .size > 256
    )
      invalid();
    const { catalogPatch: _patch, incomingHealth: _health, ...admitted } = first;
    return { ...admitted, chunks };
  } catch {
    return invalid();
  }
}
function nativeFailure(error: unknown): never {
  if (error === 'catalog-revision-stale') throw new RecordRevisionConflictError('catalog');
  if (error === 'health-revision-stale') throw new RecordRevisionConflictError('health');
  if (error === 'checkpoint-revision-stale' || error === 'scan-checkpoint-revision-stale')
    throw new RecordRevisionConflictError('checkpoint');
  throw new Error('The scan publication could not finish. Existing channels are retained.');
}
class UnsupportedWindow extends Error {}
const failureCodes = [
  'application-closing',
  'canceled',
  'catalog-revision-stale',
  'health-revision-stale',
  'checkpoint-revision-stale',
  'scan-checkpoint-revision-stale',
  'scan-window-invalid',
  'scan-window-too-large',
  'scan-window-chain-stale',
  'scan-batch-invalid',
  'scan-batch-base-stale',
  'scan-batch-source-refused',
  'scan-checkpoint-invalid',
  'scan-checkpoint-too-large',
  'scan-checkpoint-progress-conflict',
  'scan-checkpoint-progress-stale',
  'scan-checkpoint-target-validation-limit',
  'scan-checkpoint-unpublished-channel',
  'sqlite-busy',
  'sqlite-storage-full',
  'sqlite-operation-failed',
  'sqlite-backup-failed',
  'storage-worker-failed',
  'record-too-large',
  'health-too-large',
  'invalid-request-id',
  'duplicate-request-id',
  'network-concurrency-limit',
  'request-generation-exhausted',
  'request-lock',
  'storage-lock',
  'storage-writer-lock',
  'storage-not-ready',
  'storage-revision-exhausted',
  'catalog-revision-exhausted',
  'scan-checkpoint-revision-invalid',
  'scan-checkpoint-revision-exhausted',
  'scan-checkpoint-clear-required',
  'scan-checkpoint-advance-unavailable',
  'scan-checkpoint-advance-requires-v2',
  'scan-checkpoint-job-stale',
  'scan-checkpoint-expired',
  'scan-checkpoint-policy-stale',
  'scan-checkpoint-source-not-resumable',
  'scan-checkpoint-preferences-required',
  'health-invalid-json',
  'health-unsupported-schema',
  'health-invalid-record',
  'health-duplicate-record',
  'health-invalid-sample',
  'health-invalid-evidence',
  'health-invalid-status',
  'health-invalid-interval',
  'health-invalid-stored-record',
  'health-invalid-catalog',
  'health-target-invalid',
  'health-target-mismatch',
  'health-stored-target-mismatch',
  'health-encoding-failed',
  'health-sqlite-failed',
  'sqlite-integrity-failed',
  'sqlite-unsupported-schema',
  'scan-checkpoint-storage-failed',
  'catalog-invalid',
  'catalog-compact-scope-invalid',
  'catalog-projection-invalid-scope',
  'catalog-query-database-failed',
  'catalog-query-encoding-failed',
  'catalog-query-invalid-ordinal',
  'catalog-view-revision-exhausted',
  'record-array-too-large',
  'record-invalid-json',
  'record-unsupported-schema',
  'record-invalid-field',
  'record-invalid-array',
  'record-encoding-failed',
  'record-invalid-source-kind',
  'record-invalid-http-grant',
  'record-invalid-content-kind',
  'record-invalid-mime',
  'record-invalid-url',
  'record-invalid-identity',
  'record-duplicate-source',
  'record-duplicate-channel',
  'record-missing-source',
  'record-missing-url',
  'record-duplicate-url',
  'record-source-mirror-mismatch',
  'record-invalid-volume',
  'record-invalid-panel',
  'record-invalid-preferences',
  'record-invalid-source-refresh',
  'record-invalid-geography',
  'record-invalid-geography-provenance',
  'record-invalid-provider',
  'record-invalid-provider-url',
  'record-invalid-provider-array',
  'record-provider-limit',
  'record-invalid-provider-field',
  'record-invalid-provider-http',
  'record-duplicate-provider',
  'record-invalid-preferred-region',
  'record-invalid-automatic-guide-updates',
  'record-invalid-voice-consent',
  'record-invalid-category-override',
  'record-category-override-limit',
] as const;
export type ScanWindowFailureCode = (typeof failureCodes)[number] | 'native-refusal-unclassified';
function observeNativeFailure(error: unknown, observer?: (code: ScanWindowFailureCode) => void) {
  const code: ScanWindowFailureCode =
    typeof error === 'string' && failureCodes.includes(error as (typeof failureCodes)[number])
      ? (error as (typeof failureCodes)[number])
      : 'native-refusal-unclassified';
  // Observation cannot change write ownership, error classification or recovery.
  try {
    observer?.(code);
  } catch {
    /* Ignore diagnostic observer failures. */
  }
}
export function createScanWindowCommitAdapter(
  runtime: OwnedNativeRuntime & { isNative(): boolean },
) {
  let capability: { schemaVersion: 1; scanWindow: 1; maxChunks: 4 } | null | undefined;
  return {
    async capabilities(signal?: AbortSignal) {
      signal?.throwIfAborted();
      if (!runtime.isNative()) return null;
      if (capability !== undefined) return capability;
      capability = await invokeOwnedNative(
        runtime,
        'scan_window_capabilities',
        {},
        {
          signal,
          validate(raw) {
            const value = object(raw);
            exact(value, ['schemaVersion', 'scanWindow', 'maxChunks']);
            if (value.schemaVersion !== 1 || value.scanWindow !== 1 || value.maxChunks !== 4)
              invalid();
            return { schemaVersion: 1 as const, scanWindow: 1 as const, maxChunks: 4 as const };
          },
          failure(error): never {
            if (
              error === 'scan-window-unsupported' ||
              error === 'Command scan_window_capabilities not found'
            )
              throw new UnsupportedWindow();
            return nativeFailure(error);
          },
        },
      ).catch((error: unknown) => {
        if (error instanceof UnsupportedWindow) return null;
        throw error;
      });
      return capability;
    },
    async commit(
      raw: ScanWindow,
      signal?: AbortSignal,
      observeFailure?: (code: ScanWindowFailureCode) => void,
    ): Promise<CommitReceipt> {
      signal?.throwIfAborted();
      if (!runtime.isNative() || capability?.scanWindow !== 1) invalid();
      const window = validateScanWindow(raw);
      return invokeOwnedNative(
        runtime,
        'commit_scan_window',
        { window },
        {
          signal,
          durable: true,
          failure(error): never {
            // invokeOwnedNative has joined the actual invocation and cancellation.
            observeNativeFailure(error, observeFailure);
            return nativeFailure(error);
          },
          validate(rawReceipt) {
            const value = object(rawReceipt);
            exact(
              value,
              ['committed', 'catalogRevision', 'healthRevision'],
              ['checkpointRevision'],
            );
            const receipt = validateCommitReceipt(value);
            for (const [actual, expected] of [
              [receipt.catalogRevision, window.expectedCatalogRevision],
              [receipt.healthRevision, window.expectedHealthRevision],
            ])
              if (BigInt(actual) < BigInt(expected) || BigInt(actual) > BigInt(expected) + 1n)
                invalid();
            if (
              window.scanCheckpoint !== undefined &&
              (receipt.checkpointRevision === undefined ||
                BigInt(receipt.checkpointRevision) !==
                  BigInt(window.expectedCheckpointRevision!) + 1n)
            )
              invalid();
            if (window.scanCheckpoint === undefined && receipt.checkpointRevision !== undefined)
              invalid();
            return receipt;
          },
        },
      );
    },
  };
}
export const nativeScanWindowCommit = createScanWindowCommitAdapter({ isNative: isTauri, invoke });
