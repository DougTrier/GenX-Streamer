import { invoke, isTauri } from '@tauri-apps/api/core';
import { validateCatalog, validateSource, type Source } from '../catalog';
import { validatePreferences, type Preferences } from '../preferences';
import { validateHealthRecords, type PersistedHealthRecord } from '../catalog/health-record';
import {
  validateScanCheckpointMutation,
  type ScanCheckpointMutation,
} from '../discovery/scan-checkpoint';
import type { CatalogPatch } from '../discovery/catalog-patch';
import { boundedUtf8Text } from './bounded-text';
import {
  validateCommitReceipt,
  validateRevision,
  RecordRevisionConflictError,
  type CommitReceipt,
} from './record-transaction';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';

export interface ScanBatch {
  schemaVersion: 1;
  catalogPatch: CatalogPatch;
  authorizedSources: Source[];
  nextPreferences: Preferences;
  incomingHealth: PersistedHealthRecord[];
  expectedCatalogRevision: string;
  expectedHealthRevision: string;
  scanCheckpoint?: ScanCheckpointMutation;
  expectedCheckpointRevision?: string;
}
export interface ScanCommitRevisions {
  schemaVersion: 1;
  catalogRevision: string;
  healthRevision: string;
}
export class ScanBatchValidationError extends Error {
  readonly code = 'scan-batch-invalid';
  constructor() {
    super(
      'The compact scan commit contract is invalid. Retry the scan; your saved channels are retained.',
    );
    this.name = 'ScanBatchValidationError';
  }
}
const invalid = () => new ScanBatchValidationError();
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []) {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  )
    throw invalid();
}
function nativeFailure(error: unknown): never {
  if (error === 'catalog-revision-stale') throw new RecordRevisionConflictError('catalog');
  if (error === 'health-revision-stale') throw new RecordRevisionConflictError('health');
  if (error === 'checkpoint-revision-stale' || error === 'scan-checkpoint-revision-stale')
    throw new RecordRevisionConflictError('checkpoint');
  throw new Error('The compact scan operation could not finish. Existing channels are retained.');
}
function validateScanBatchInput(raw: unknown): ScanBatch {
  const value = object(raw);
  exact(
    value,
    [
      'schemaVersion',
      'catalogPatch',
      'authorizedSources',
      'nextPreferences',
      'incomingHealth',
      'expectedCatalogRevision',
      'expectedHealthRevision',
    ],
    ['scanCheckpoint', 'expectedCheckpointRevision'],
  );
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.authorizedSources) ||
    value.authorizedSources.length > 100
  )
    throw invalid();
  const authorizedSources = value.authorizedSources.map(validateSource);
  if (new Set(authorizedSources.map((source) => source.id)).size !== authorizedSources.length)
    throw invalid();
  const patch = object(value.catalogPatch);
  exact(patch, [
    'schemaVersion',
    'baseSourceCount',
    'baseChannelCount',
    'finalSourceCount',
    'finalChannelCount',
    'sources',
    'channels',
  ]);
  if (
    patch.schemaVersion !== 1 ||
    !Array.isArray(patch.channels) ||
    patch.channels.length > 64 ||
    !Array.isArray(patch.sources) ||
    patch.sources.length > 100
  )
    throw invalid();
  for (const key of [
    'baseSourceCount',
    'finalSourceCount',
    'baseChannelCount',
    'finalChannelCount',
  ])
    if (
      !Number.isSafeInteger(patch[key]) ||
      (patch[key] as number) < 0 ||
      (patch[key] as number) > (key.includes('Source') ? 100 : 100000)
    )
      throw invalid();
  if (
    (patch.finalSourceCount as number) < (patch.baseSourceCount as number) ||
    (patch.finalChannelCount as number) < (patch.baseChannelCount as number) ||
    (patch.finalChannelCount as number) - (patch.baseChannelCount as number) >
      patch.channels.length ||
    (patch.finalSourceCount as number) - (patch.baseSourceCount as number) > patch.sources.length
  )
    throw invalid();
  const catalog = validateCatalog({
    schemaVersion: 1,
    sources: authorizedSources,
    channels: patch.channels,
  });
  const sources = patch.sources.map(validateSource);
  if (
    new Set(sources.map((source) => source.id)).size !== sources.length ||
    sources.some((source) => {
      const admitted = authorizedSources.find((entry) => entry.id === source.id);
      return (
        !admitted ||
        source.location !== admitted.location ||
        source.kind !== admitted.kind ||
        (source.allowHttp === true) !== (admitted.allowHttp === true)
      );
    })
  )
    throw invalid();
  if (!Array.isArray(value.incomingHealth) || value.incomingHealth.length > 64) throw invalid();
  const incomingHealth = validateHealthRecords(value.incomingHealth);
  if (
    incomingHealth.some((record) => {
      const changedChannel = catalog.channels.find((channel) => channel.id === record.channelId);
      // An unchanged saved channel is intentionally absent from the patch.
      // Native validates its existence and exact target against the post-patch catalog.
      return (
        !authorizedSources.some((source) => source.id === record.sourceId) ||
        (changedChannel !== undefined && changedChannel.sourceId !== record.sourceId)
      );
    })
  )
    throw invalid();
  const nextPreferences = validatePreferences(value.nextPreferences);
  for (const entry of [patch, authorizedSources, incomingHealth])
    if (!boundedUtf8Text(JSON.stringify(entry), 20 * 1024 * 1024)) throw invalid();
  if (!boundedUtf8Text(JSON.stringify(nextPreferences), 20 * 1024 * 1024)) throw invalid();
  const expectedCatalogRevision = validateRevision(value.expectedCatalogRevision),
    expectedHealthRevision = validateRevision(value.expectedHealthRevision);
  if ((value.scanCheckpoint === undefined) !== (value.expectedCheckpointRevision === undefined))
    throw invalid();
  const scanCheckpoint =
    value.scanCheckpoint === undefined
      ? undefined
      : validateScanCheckpointMutation(value.scanCheckpoint);
  if (
    scanCheckpoint !== undefined &&
    !boundedUtf8Text(JSON.stringify(scanCheckpoint), 20 * 1024 * 1024)
  )
    throw invalid();
  return {
    schemaVersion: 1,
    catalogPatch: { ...patch, sources, channels: catalog.channels } as unknown as CatalogPatch,
    authorizedSources,
    nextPreferences,
    incomingHealth,
    expectedCatalogRevision,
    expectedHealthRevision,
    ...(scanCheckpoint === undefined
      ? {}
      : {
          scanCheckpoint,
          expectedCheckpointRevision: validateRevision(value.expectedCheckpointRevision),
        }),
  };
}
export function validateScanBatch(raw: unknown): ScanBatch {
  try {
    return validateScanBatchInput(raw);
  } catch {
    throw invalid();
  }
}
export function createScanBatchCommitAdapter(
  runtime: OwnedNativeRuntime & { isNative(): boolean },
) {
  let capability: { schemaVersion: 1; scanBatch: 1 } | null | undefined;
  return {
    async capabilities(signal?: AbortSignal): Promise<{ schemaVersion: 1; scanBatch: 1 } | null> {
      signal?.throwIfAborted();
      if (!runtime.isNative()) return null;
      if (capability !== undefined) return capability;
      capability = await invokeOwnedNative(
        runtime,
        'scan_batch_capabilities',
        {},
        {
          signal,
          validate: (raw) => {
            const value = object(raw);
            exact(value, ['schemaVersion', 'scanBatch']);
            if (value.schemaVersion !== 1 || value.scanBatch !== 1) throw invalid();
            return { schemaVersion: 1 as const, scanBatch: 1 as const };
          },
          failure(error): never {
            if (
              error === 'scan-batch-unsupported' ||
              error === 'Command scan_batch_capabilities not found'
            )
              throw new UnsupportedScanBatch();
            return nativeFailure(error);
          },
        },
      ).catch((error: unknown) => {
        if (error instanceof UnsupportedScanBatch) return null;
        throw error;
      });
      return capability;
    },
    async revisions(signal?: AbortSignal): Promise<ScanCommitRevisions> {
      if (!runtime.isNative() || capability?.scanBatch !== 1) throw invalid();
      return invokeOwnedNative(
        runtime,
        'read_scan_commit_revisions',
        {},
        {
          signal,
          failure: nativeFailure,
          validate(raw) {
            const value = object(raw);
            exact(value, ['schemaVersion', 'catalogRevision', 'healthRevision']);
            if (value.schemaVersion !== 1) throw invalid();
            return {
              schemaVersion: 1,
              catalogRevision: validateRevision(value.catalogRevision),
              healthRevision: validateRevision(value.healthRevision),
            };
          },
        },
      );
    },
    async commit(raw: ScanBatch, signal?: AbortSignal): Promise<CommitReceipt> {
      signal?.throwIfAborted();
      if (!runtime.isNative() || capability?.scanBatch !== 1) throw invalid();
      const batch = validateScanBatch(raw);
      return invokeOwnedNative(
        runtime,
        'commit_scan_batch',
        { batch },
        {
          signal,
          durable: true,
          failure: nativeFailure,
          validate(rawReceipt) {
            const value = object(rawReceipt);
            exact(
              value,
              ['committed', 'catalogRevision', 'healthRevision'],
              ['checkpointRevision'],
            );
            const receipt = validateCommitReceipt(value);
            if (
              BigInt(receipt.catalogRevision) < BigInt(batch.expectedCatalogRevision) ||
              BigInt(receipt.healthRevision) < BigInt(batch.expectedHealthRevision) ||
              (batch.scanCheckpoint !== undefined &&
                (receipt.checkpointRevision === undefined ||
                  BigInt(receipt.checkpointRevision) < BigInt(batch.expectedCheckpointRevision!)))
            )
              throw invalid();
            return receipt;
          },
        },
      );
    },
  };
}
class UnsupportedScanBatch extends Error {}
export const nativeScanBatchCommit = createScanBatchCommitAdapter({ isNative: isTauri, invoke });
