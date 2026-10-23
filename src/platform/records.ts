import {
  checkpointRevision,
  validateScanCheckpointMutation,
  type SavedScanCheckpoint,
  type ScanCheckpointMutation,
} from '../discovery/scan-checkpoint';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  readConfiguredSource,
  normalizeSourceMime,
  SourceRequestError,
  type ConfiguredSource,
} from '../sources';
import {
  readIndexedDbRecordPair,
  writeIndexedDbRecordPair,
  writeIndexedDbRecord,
  validateCommitReceipt,
  validateSavedRecordPair,
  type CommitReceipt,
  type RecordPair,
  type SavedRecordPair,
  validateRevision,
  validateUpdateRevisions,
  writeIndexedDbHealth,
  RecordRevisionConflictError,
  readIndexedDbScanCheckpoint,
  writeIndexedDbScanCheckpoint,
} from './record-transaction';
import { boundedUtf8Text } from './bounded-text';
import { readGuideCaptureRecord } from './guide-capture-record';
import { invokeOwnedNative } from './owned-native-command';
import { isNativeWriteNotCommittedError } from './native-write-refusal';
export type { CommitReceipt, RecordPair, SavedRecordPair } from './record-transaction';
export { isRecordRevisionConflict, RecordRevisionConflictError } from './record-transaction';
export type RecordName = 'preferences' | 'catalog';

let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('tmg-tv', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('records');
    request.onsuccess = () => {
      request.result.onversionchange = () => {
        request.result.close();
        database = undefined;
      };
      resolve(request.result);
    };
    request.onerror = () => {
      database = undefined;
      reject(new Error('Browser storage could not open.'));
    };
    request.onblocked = () => {
      database = undefined;
      reject(new Error('Close other GenX Streamer tabs to update storage.'));
    };
  });
  return database;
}
export async function readRecord(name: RecordName): Promise<string | null> {
  if (isTauri()) return invoke('read_record', { name });
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('records', 'readonly');
    const request = tx.objectStore('records').get(name);
    tx.oncomplete = () => resolve(typeof request.result === 'string' ? request.result : null);
    tx.onabort = () => reject(new Error('Browser storage could not read the saved record.'));
  });
}
async function nativeWrite(
  command: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<CommitReceipt> {
  return invokeOwnedNative({ invoke }, command, args, {
    signal,
    validate: validateCommitReceipt,
    durable: true,
    ignoreCancellationFailure: true,
    failure: nativeWriteFailure,
    abortMessage: 'Save canceled before confirmed publication.',
  });
}
function nativeWriteFailure(error: unknown): never {
  if (isNativeWriteNotCommittedError(error)) throw error;
  if (error === 'health-revision-stale') throw new RecordRevisionConflictError('health');
  if (error === 'checkpoint-revision-stale' || error === 'scan-checkpoint-revision-stale')
    throw new RecordRevisionConflictError('checkpoint');
  if (error === 'catalog-revision-stale') throw new RecordRevisionConflictError('catalog');
  // Native diagnostics can contain provider secrets. Only exact owned storage codes are exposed.
  throw new Error('Storage could not confirm the save. Check available storage and review again.');
}
export async function writeRecord(
  name: RecordName,
  contents: string,
  signal?: AbortSignal,
  expectedCatalogRevision?: string,
): Promise<CommitReceipt> {
  signal?.throwIfAborted();
  if (!boundedUtf8Text(contents, 20 * 1024 * 1024))
    throw new Error('Record exceeds its storage bounds.');
  if (expectedCatalogRevision !== undefined) validateRevision(expectedCatalogRevision);
  if (isTauri())
    return nativeWrite('write_record_receipt', { name, contents, expectedCatalogRevision }, signal);
  return writeIndexedDbRecord(
    await openDatabase(),
    name,
    contents,
    signal,
    expectedCatalogRevision,
  );
}
export async function readRecordPair(): Promise<SavedRecordPair> {
  if (isTauri()) return validateSavedRecordPair(await invoke('read_record_pair'));
  return readIndexedDbRecordPair(await openDatabase());
}
export async function readGuideCaptureSnapshot(signal?: AbortSignal) {
  return readGuideCaptureRecord({ isNative: isTauri, invoke, openDatabase }, signal);
}
export interface ScanHealthSnapshot {
  health: string | null;
  catalogRevision: string;
  healthRevision: string;
}
/** Same atomic CAS snapshot with no catalog/preferences in the native IPC reply. */
export async function readScanHealth(): Promise<ScanHealthSnapshot> {
  const raw: unknown = isTauri()
    ? await invoke('read_scan_health')
    : await readIndexedDbRecordPair(await openDatabase());
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new Error('Saved scan health snapshot is invalid.');
  const input = raw as Partial<ScanHealthSnapshot>;
  if (input.health !== null && !boundedUtf8Text(input.health, 20 * 1024 * 1024))
    throw new Error('Saved scan health snapshot is invalid.');
  validateRevision(input.catalogRevision);
  validateRevision(input.healthRevision);
  return {
    health: input.health as string | null,
    catalogRevision: input.catalogRevision!,
    healthRevision: input.healthRevision!,
  };
}
export async function writeRecordPair(
  records: RecordPair,
  signal?: AbortSignal,
): Promise<CommitReceipt> {
  signal?.throwIfAborted();
  if (
    !boundedUtf8Text(records.catalog, 20 * 1024 * 1024) ||
    !boundedUtf8Text(records.preferences, 20 * 1024 * 1024)
  )
    throw new Error('Paired records exceed their separate storage bounds.');
  for (const value of [records.catalog, records.preferences, records.health])
    if (value !== undefined && !boundedUtf8Text(value, 20 * 1024 * 1024))
      throw new Error('Record exceeds its separate storage bounds.');
  validateUpdateRevisions(records);
  if (isTauri()) {
    const receipt = await nativeWrite('write_record_pair', { ...records }, signal);
    if (records.scanCheckpoint !== undefined) validateRevision(receipt.checkpointRevision);
    return receipt;
  }
  return writeIndexedDbRecordPair(await openDatabase(), records, signal);
}
export async function writeHealth(
  health: string,
  expectedCatalogRevision: string,
  expectedHealthRevision: string,
  signal?: AbortSignal,
): Promise<CommitReceipt> {
  signal?.throwIfAborted();
  if (!boundedUtf8Text(health, 20 * 1024 * 1024))
    throw new Error('Health exceeds its separate storage bounds.');
  validateUpdateRevisions({ health, expectedCatalogRevision, expectedHealthRevision });
  if (isTauri())
    return nativeWrite(
      'write_health',
      { health, expectedCatalogRevision, expectedHealthRevision },
      signal,
    );
  return writeIndexedDbHealth(
    await openDatabase(),
    health,
    expectedCatalogRevision,
    expectedHealthRevision,
    signal,
  );
}
export async function inspectSource(
  url: string,
  allowHttp: boolean,
  signal: AbortSignal,
): Promise<ConfiguredSource> {
  const parsed = new URL(url);
  if (!['https:', 'http:'].includes(parsed.protocol) || (parsed.protocol === 'http:' && !allowHttp))
    throw new Error('Use HTTPS or explicitly allow HTTP for this source.');
  if (isTauri()) {
    signal.throwIfAborted();
    const requestId = crypto.randomUUID();
    const cancel = () => {
      void invoke('cancel_playlist', { requestId }).catch(() => undefined);
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      const result = await invoke<ConfiguredSource>('inspect_source', {
        url,
        allowHttp,
        requestId,
      });
      signal.throwIfAborted();
      const { mime: rawMime, ...configured } = result;
      const mime = normalizeSourceMime(rawMime);
      return { ...configured, ...(mime === undefined ? {} : { mime }) };
    } catch (error) {
      signal.throwIfAborted();
      const status = typeof error === 'string' ? /^http-(\d{3})$/.exec(error) : null;
      if (status) throw new SourceRequestError(Number(status[1]), null);
      throw error;
    } finally {
      signal.removeEventListener('abort', cancel);
    }
  }
  return readConfiguredSource(url, allowHttp, signal);
}

export type { SavedScanCheckpoint, ScanCheckpointMutation } from '../discovery/scan-checkpoint';
export async function readScanCheckpoint(): Promise<SavedScanCheckpoint> {
  if (!isTauri()) return readIndexedDbScanCheckpoint(await openDatabase());
  const raw = await invoke<Partial<SavedScanCheckpoint>>('read_scan_checkpoint');
  if (!raw || (raw.checkpoint !== null && !boundedUtf8Text(raw.checkpoint, 20 * 1024 * 1024)))
    throw new Error('Saved scan checkpoint could not be read.');
  if (
    !['valid', 'invalid', 'absent'].includes(String(raw.checkpointStatus)) ||
    (raw.jobId !== null && (!boundedUtf8Text(raw.jobId, 256) || /https?:\/\//iu.test(raw.jobId))) ||
    (raw.checkpointStatus !== 'valid' && raw.checkpoint !== null) ||
    (raw.checkpointStatus === 'valid' && (raw.checkpoint === null || raw.jobId === null)) ||
    (raw.checkpointStatus === 'absent' && raw.jobId !== null)
  )
    throw new Error('Saved scan checkpoint could not be read.');
  return {
    checkpoint: raw.checkpoint,
    checkpointStatus: raw.checkpointStatus as SavedScanCheckpoint['checkpointStatus'],
    jobId: raw.jobId as string | null,
    checkpointRevision: checkpointRevision(raw.checkpointRevision),
    catalogRevision: checkpointRevision(raw.catalogRevision),
  };
}
export async function writeScanCheckpoint(
  checkpoint: string,
  expectedCatalogRevision: string,
  expectedCheckpointRevision: string,
  signal?: AbortSignal,
): Promise<CommitReceipt> {
  signal?.throwIfAborted();
  if (!boundedUtf8Text(checkpoint, 20 * 1024 * 1024))
    throw new Error('Scan checkpoint exceeds its storage bounds.');
  validateRevision(expectedCatalogRevision);
  validateRevision(expectedCheckpointRevision);
  if (isTauri()) {
    const receipt = await nativeWrite(
      'write_scan_checkpoint',
      { checkpoint, expectedCatalogRevision, expectedCheckpointRevision },
      signal,
    );
    validateRevision(receipt.checkpointRevision);
    return receipt;
  }
  return writeIndexedDbScanCheckpoint(
    await openDatabase(),
    { kind: 'save', checkpoint },
    expectedCatalogRevision,
    expectedCheckpointRevision,
    signal,
  );
}
export async function discardScanCheckpoint(
  jobId: string,
  expectedCatalogRevision: string,
  expectedCheckpointRevision: string,
  signal?: AbortSignal,
): Promise<CommitReceipt> {
  signal?.throwIfAborted();
  if (
    !boundedUtf8Text(jobId, 256) ||
    /https?:\/\//iu.test(jobId) ||
    [...jobId].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  )
    throw new Error('Scan checkpoint identity is invalid.');
  validateRevision(expectedCatalogRevision);
  validateRevision(expectedCheckpointRevision);
  if (isTauri()) {
    const receipt = await nativeWrite(
      'discard_scan_checkpoint',
      { jobId, expectedCatalogRevision, expectedCheckpointRevision },
      signal,
    );
    validateRevision(receipt.checkpointRevision);
    return receipt;
  }
  return writeIndexedDbScanCheckpoint(
    await openDatabase(),
    { kind: 'discard', jobId },
    expectedCatalogRevision,
    expectedCheckpointRevision,
    signal,
  );
}

export async function writeScanCheckpointMutation(
  raw: ScanCheckpointMutation,
  expectedCatalogRevision: string,
  expectedCheckpointRevision: string,
  signal?: AbortSignal,
): Promise<CommitReceipt> {
  signal?.throwIfAborted();
  const mutation = validateScanCheckpointMutation(raw);
  if (mutation.kind === 'save')
    return writeScanCheckpoint(
      mutation.checkpoint,
      expectedCatalogRevision,
      expectedCheckpointRevision,
      signal,
    );
  if (mutation.kind !== 'advance' || !isTauri())
    throw new Error('Native checkpoint progress updates are unavailable.');
  validateRevision(expectedCatalogRevision);
  validateRevision(expectedCheckpointRevision);
  const receipt = await nativeWrite(
    'advance_scan_checkpoint',
    {
      mutation,
      expectedCatalogRevision,
      expectedCheckpointRevision,
    },
    signal,
  );
  validateRevision(receipt.checkpointRevision);
  return receipt;
}
