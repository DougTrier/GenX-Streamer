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

import {
  parseStoredScanCheckpoint,
  validateScanCheckpointMutation,
  validateStoredCheckpointPublishedTargets,
  validateCheckpointSourceAdmission,
  checkpointRevision,
  fingerprintScanPolicy,
  type ScanCheckpointMutation,
  type SavedScanCheckpoint,
} from '../discovery/scan-checkpoint';
import { parseCatalog, serializeCatalog, type CatalogRecord } from '../catalog';
import { importPreferences } from '../preferences';
import { createBackup } from '../data-transfer';
import {
  fingerprintHealthTarget,
  parseHealthPayload,
  serializeHealthPayload,
  reconcileHealthRecords,
  type HealthTarget,
} from '../catalog/health-record';
import { boundedUtf8Text } from './bounded-text';

export interface CommitReceipt {
  committed: true;
  catalogRevision: string;
  healthRevision: string;
  checkpointRevision?: string;
}
export class RecordRevisionConflictError extends Error {
  constructor(scope: 'catalog' | 'health' | 'data' | 'checkpoint' = 'data') {
    super(`Saved ${scope} changed. Review again before saving.`);
    this.name = 'RecordRevisionConflictError';
  }
}
/** Only conflicts created by owned storage admission qualify for bounded caller rebase. */
export function isRecordRevisionConflict(error: unknown): error is RecordRevisionConflictError {
  return error instanceof RecordRevisionConflictError;
}
export interface RecordPair {
  catalog: string;
  preferences: string;
  health?: string;
  expectedCatalogRevision?: string;
  expectedHealthRevision?: string;
  scanCheckpoint?: ScanCheckpointMutation;
  expectedCheckpointRevision?: string;
}
export interface SavedRecordPair {
  catalog: string | null;
  preferences: string | null;
  health: string | null;
  catalogRevision: string;
  healthRevision: string;
}
interface RecordUpdate {
  catalog?: string;
  preferences?: string;
  health?: string;
  expectedCatalogRevision?: string;
  expectedHealthRevision?: string;
  scanCheckpoint?: ScanCheckpointMutation;
  expectedCheckpointRevision?: string;
}
interface Prepared {
  catalog: string | null;
  preferences: string | null;
  health: string | null;
  catalogChanged: boolean;
  healthChanged: boolean;
  scanCheckpoint?: string | null;
  scanCheckpointJobId?: string;
}
export function validateRevision(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new Error('Saved revision is invalid.');
  return value;
}
const increment = (value: string) => validateRevision((BigInt(value) + 1n).toString());
export function validateCommitReceipt(value: unknown): CommitReceipt {
  const input = value as Partial<CommitReceipt> | null;
  if (!input || input.committed !== true)
    throw new Error('Storage did not return a durable commit receipt.');
  return {
    committed: true,
    catalogRevision: validateRevision(input.catalogRevision),
    healthRevision: validateRevision(input.healthRevision),
    ...(input.checkpointRevision === undefined
      ? {}
      : { checkpointRevision: validateRevision(input.checkpointRevision) }),
  };
}
export function validateSavedRecordPair(value: unknown): SavedRecordPair {
  const input = value as Partial<SavedRecordPair> | null;
  if (!input) throw new Error('Saved record state is invalid.');
  const record = (raw: unknown): string | null => {
    if (raw === null) return null;
    if (!boundedUtf8Text(raw, 20 * 1024 * 1024)) throw new Error('Saved record state is invalid.');
    return raw;
  };
  return {
    catalog: record(input.catalog),
    preferences: record(input.preferences),
    health: record(input.health),
    catalogRevision: validateRevision(input.catalogRevision),
    healthRevision: validateRevision(input.healthRevision),
  };
}
export function validateRecordPair(pair: RecordPair): RecordPair {
  validateUpdateRevisions(pair);
  const record = createBackup(parseCatalog(pair.catalog), importPreferences(pair.preferences));
  return {
    catalog: serializeCatalog(record.catalog),
    preferences: JSON.stringify(record.preferences),
    ...(pair.health !== undefined
      ? { health: serializeHealthPayload(parseHealthPayload(pair.health).records) }
      : {}),
    ...(pair.scanCheckpoint === undefined ? {} : { scanCheckpoint: pair.scanCheckpoint }),
    ...(pair.expectedCheckpointRevision === undefined
      ? {}
      : { expectedCheckpointRevision: validateRevision(pair.expectedCheckpointRevision) }),
    ...(pair.expectedCatalogRevision !== undefined
      ? { expectedCatalogRevision: validateRevision(pair.expectedCatalogRevision) }
      : {}),
    ...(pair.expectedHealthRevision !== undefined
      ? { expectedHealthRevision: validateRevision(pair.expectedHealthRevision) }
      : {}),
  };
}
export function validateUpdateRevisions(input: {
  health?: string;
  expectedCatalogRevision?: string;
  expectedHealthRevision?: string;
  scanCheckpoint?: ScanCheckpointMutation;
  expectedCheckpointRevision?: string;
}): void {
  if (
    input.health !== undefined &&
    (input.expectedCatalogRevision === undefined || input.expectedHealthRevision === undefined)
  )
    throw new Error('Health publication requires both saved revisions.');
  if (
    input.scanCheckpoint !== undefined &&
    (input.expectedCatalogRevision === undefined || input.expectedCheckpointRevision === undefined)
  )
    throw new Error('Scan checkpoint publication requires both saved revisions.');
  if (input.scanCheckpoint !== undefined) validateScanCheckpointMutation(input.scanCheckpoint);
  if (input.expectedCheckpointRevision !== undefined)
    validateRevision(input.expectedCheckpointRevision);
  if (input.expectedCatalogRevision !== undefined) validateRevision(input.expectedCatalogRevision);
  if (input.expectedHealthRevision !== undefined) validateRevision(input.expectedHealthRevision);
}
export async function readIndexedDbRecordPair(database: IDBDatabase): Promise<SavedRecordPair> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('records', 'readonly');
    const store = tx.objectStore('records');
    const keys = ['catalog', 'preferences', 'health', 'catalogRevision', 'healthRevision'] as const;
    const requests = keys.map((key) => store.get(key));
    tx.oncomplete = () => {
      try {
        resolve(
          validateSavedRecordPair(
            Object.fromEntries(
              keys.map((key, index) => [
                key,
                requests[index].result === undefined
                  ? key.endsWith('Revision')
                    ? '0'
                    : null
                  : requests[index].result,
              ]),
            ),
          ),
        );
      } catch {
        reject(new Error('Saved record state is invalid.'));
      }
    };
    tx.onabort = () => reject(new Error('Saved record state could not be read.'));
  });
}
function canonicalCatalog(text: string): CatalogRecord {
  const catalog = parseCatalog(text);
  return {
    ...catalog,
    sources: catalog.sources.map((source) => ({ ...source, allowHttp: source.allowHttp === true })),
  };
}
async function prepare(snapshot: SavedRecordPair, update: RecordUpdate): Promise<Prepared> {
  const catalog = update.catalog ?? snapshot.catalog;
  const preferences = update.preferences ?? snapshot.preferences;
  const current = catalog === null ? null : canonicalCatalog(catalog);
  const normalized = current === null ? null : serializeCatalog(current);
  const oldCatalog =
    snapshot.catalog === null ? null : serializeCatalog(canonicalCatalog(snapshot.catalog));
  const catalogChanged = normalized !== oldCatalog;
  let health = snapshot.health;
  if (catalogChanged || update.health !== undefined) {
    const previous = health === null ? [] : parseHealthPayload(health).records;
    const incoming = update.health === undefined ? [] : parseHealthPayload(update.health).records;
    const channels = new Map(current?.channels.map((channel) => [channel.id, channel]));
    const sources = new Map(current?.sources.map((source) => [source.id, source]));
    const targets = new Map<string, HealthTarget>();
    for (const record of [...previous, ...incoming]) {
      const key = JSON.stringify([record.channelId, record.checkedUrlOrdinal]);
      if (targets.has(key)) continue;
      const channel = channels.get(record.channelId);
      const source = channel && sources.get(channel.sourceId);
      if (!channel || !source || record.checkedUrlOrdinal >= channel.urls.length) continue;
      targets.set(key, {
        channelId: channel.id,
        sourceId: source.id,
        checkedUrlOrdinal: record.checkedUrlOrdinal,
        targetFingerprint: await fingerprintHealthTarget(source, channel, record.checkedUrlOrdinal),
      });
    }
    for (const record of incoming) {
      const current = targets.get(JSON.stringify([record.channelId, record.checkedUrlOrdinal]));
      if (
        !current ||
        current.sourceId !== record.sourceId ||
        current.targetFingerprint !== record.targetFingerprint
      )
        throw new Error('Incoming health belongs to a changed or missing target.');
    }
    const merged = reconcileHealthRecords(previous, incoming, [...targets.values()]);
    health = merged.length || snapshot.health !== null ? serializeHealthPayload(merged) : null;
  }
  let scanCheckpoint: string | null | undefined;
  let scanCheckpointJobId: string | undefined;
  if (update.scanCheckpoint !== undefined) {
    const mutation = update.scanCheckpoint;
    if (mutation.kind === 'save') {
      if (Object.keys(mutation).some((key) => !['kind', 'checkpoint'].includes(key)))
        throw new Error('Invalid scan checkpoint mutation.');
      const checkpoint = await parseStoredScanCheckpoint(mutation.checkpoint);
      if (checkpoint.catalogRevision !== snapshot.catalogRevision)
        throw new RecordRevisionConflictError('catalog');
      const rawPreferences = preferences === null ? {} : JSON.parse(preferences);
      const prefs = preferences === null ? null : importPreferences(preferences);
      await validateCheckpointSourceAdmission(
        checkpoint,
        current?.sources ?? [],
        rawPreferences.reviewedChannelProviders === undefined
          ? null
          : prefs!.reviewedChannelProviders!,
      );
      const policy = await fingerprintScanPolicy({
        providers:
          rawPreferences.reviewedChannelProviders === undefined
            ? null
            : prefs!.reviewedChannelProviders!,
        preferredRegion: prefs?.preferredRegion,
        budgetMs: checkpoint.budgetMs,
        platform: checkpoint.platform,
        observerProfile: checkpoint.observerProfile,
        sourceDefinitions: checkpoint.sourceDefinitions,
      });
      if (policy !== checkpoint.policyFingerprint)
        throw new Error('Scan configuration changed. Rescan before saving.');
      await validateStoredCheckpointPublishedTargets(
        checkpoint,
        current ?? { schemaVersion: 1, sources: [], channels: [] },
      );
      scanCheckpoint = JSON.stringify(checkpoint);
      scanCheckpointJobId = checkpoint.jobId;
    } else if (
      mutation.kind === 'discard' &&
      Object.keys(mutation).every((key) => ['kind', 'jobId'].includes(key)) &&
      boundedUtf8Text(mutation.jobId, 256)
    )
      scanCheckpoint = null;
    else throw new Error('Invalid scan checkpoint mutation.');
  }
  return {
    catalog: normalized,
    preferences,
    health,
    catalogChanged,
    healthChanged: health !== snapshot.health,
    ...(scanCheckpoint === undefined ? {} : { scanCheckpoint }),
    ...(scanCheckpointJobId === undefined ? {} : { scanCheckpointJobId }),
  };
}
function prepareOffThread(
  snapshot: SavedRecordPair,
  update: RecordUpdate,
  signal?: AbortSignal,
): Promise<Prepared> {
  if (typeof Worker === 'undefined') return prepare(snapshot, update);
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const worker = new Worker(new URL('./record-transaction.ts', import.meta.url), {
      type: 'module',
    });
    const cleanup = () => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
    };
    const abort = () => {
      cleanup();
      reject(new DOMException('Storage preparation canceled.', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });
    worker.onmessage = (event: MessageEvent<{ ok: boolean; value: Prepared }>) => {
      cleanup();
      if (event.data.ok) resolve(event.data.value);
      else reject(new Error('Saved health could not be reconciled. Previous records retained.'));
    };
    worker.onerror = () => {
      cleanup();
      reject(new Error('Storage preparation could not finish.'));
    };
    worker.postMessage({ snapshot, update });
    if (signal?.aborted) abort();
  });
}
async function writeUpdate(
  database: IDBDatabase,
  input: RecordUpdate,
  signal?: AbortSignal,
): Promise<CommitReceipt> {
  signal?.throwIfAborted();
  for (const name of ['catalog', 'preferences', 'health'] as const)
    if (input[name] !== undefined && !boundedUtf8Text(input[name], 20 * 1024 * 1024))
      throw new Error('Record exceeds its separate storage bounds.');
  validateUpdateRevisions(input);
  const snapshot = await readIndexedDbRecordPair(database);
  const checkpointSnapshot =
    input.scanCheckpoint === undefined ? undefined : await readIndexedDbScanCheckpoint(database);
  if (
    checkpointSnapshot &&
    (checkpointSnapshot.catalogRevision !== snapshot.catalogRevision ||
      checkpointSnapshot.checkpointRevision !== input.expectedCheckpointRevision)
  )
    throw new RecordRevisionConflictError('checkpoint');
  if (
    input.scanCheckpoint?.kind === 'discard' &&
    checkpointSnapshot?.jobId !== input.scanCheckpoint.jobId
  )
    throw new RecordRevisionConflictError('checkpoint');
  signal?.throwIfAborted();
  if (
    input.expectedCatalogRevision !== undefined &&
    input.expectedCatalogRevision !== snapshot.catalogRevision
  )
    throw new RecordRevisionConflictError('catalog');
  if (
    input.expectedHealthRevision !== undefined &&
    input.expectedHealthRevision !== snapshot.healthRevision
  )
    throw new RecordRevisionConflictError('health');
  const prepared = await prepareOffThread(snapshot, input, signal);
  signal?.throwIfAborted();
  const receipt: CommitReceipt = {
    committed: true,
    catalogRevision: prepared.catalogChanged
      ? increment(snapshot.catalogRevision)
      : snapshot.catalogRevision,
    healthRevision: prepared.healthChanged
      ? increment(snapshot.healthRevision)
      : snapshot.healthRevision,
  };
  if (checkpointSnapshot)
    receipt.checkpointRevision = increment(checkpointSnapshot.checkpointRevision);
  if (prepared.scanCheckpoint)
    prepared.scanCheckpoint = JSON.stringify({
      ...JSON.parse(prepared.scanCheckpoint),
      catalogRevision: receipt.catalogRevision,
    });
  return new Promise((resolve, reject) => {
    const tx = database.transaction('records', 'readwrite', { durability: 'strict' });
    let finished = false;
    let canceled = false;
    let stale = false;
    const finish = (action: () => void) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener('abort', cancel);
      action();
    };
    const cancel = () => {
      canceled = true;
      try {
        tx.abort();
      } catch {
        /* Completion remains the authoritative durable boundary. */
      }
    };
    tx.oncomplete = () => finish(() => resolve(receipt));
    tx.onabort = () =>
      finish(() =>
        reject(
          canceled
            ? new DOMException('Save canceled before publication.', 'AbortError')
            : stale
              ? new RecordRevisionConflictError()
              : new Error('Records could not be saved. Previous data retained.'),
        ),
      );
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      const store = tx.objectStore('records');
      const catalogRevision = store.get('catalogRevision');
      const healthRevision = store.get('healthRevision');
      const savedCheckpointRevision = checkpointSnapshot
        ? store.get('checkpointRevision')
        : undefined;
      const savedPreferences = checkpointSnapshot ? store.get('preferences') : undefined;
      let pending = savedCheckpointRevision ? 4 : 2;
      const admit = () => {
        if (--pending) return;
        try {
          if (signal?.aborted) {
            cancel();
            return;
          }
          if (
            validateRevision(
              catalogRevision.result === undefined ? '0' : catalogRevision.result,
            ) !== snapshot.catalogRevision ||
            validateRevision(healthRevision.result === undefined ? '0' : healthRevision.result) !==
              snapshot.healthRevision ||
            (savedCheckpointRevision &&
              validateRevision(savedCheckpointRevision.result ?? '0') !==
                checkpointSnapshot!.checkpointRevision) ||
            (savedPreferences && (savedPreferences.result ?? null) !== snapshot.preferences)
          ) {
            stale = true;
            tx.abort();
            return;
          }
          const hasRecords =
            input.catalog !== undefined ||
            input.preferences !== undefined ||
            input.health !== undefined;
          for (const name of ['catalog', 'preferences', 'health'] as const) {
            if (!hasRecords) continue;
            if (input.catalog === undefined && input.preferences === undefined && name !== 'health')
              continue;
            if (prepared[name] !== null) store.put(prepared[name], name);
            else store.delete(name);
          }
          if (input.catalog !== undefined || input.preferences !== undefined)
            store.put(receipt.catalogRevision, 'catalogRevision');
          if (hasRecords) store.put(receipt.healthRevision, 'healthRevision');
          if (checkpointSnapshot) {
            if (prepared.scanCheckpoint === null) {
              store.delete('scanCheckpoint');
              store.delete('checkpointJobId');
            } else {
              store.put(prepared.scanCheckpoint, 'scanCheckpoint');
              store.put(prepared.scanCheckpointJobId!, 'checkpointJobId');
            }
            store.put(receipt.checkpointRevision!, 'checkpointRevision');
          }
        } catch {
          try {
            tx.abort();
          } catch {
            /* Await completion if already durable. */
          }
        }
      };
      catalogRevision.onsuccess = admit;
      healthRevision.onsuccess = admit;
      if (savedCheckpointRevision) savedCheckpointRevision.onsuccess = admit;
      if (savedPreferences) savedPreferences.onsuccess = admit;
      if (signal?.aborted) cancel();
    } catch {
      try {
        tx.abort();
      } catch {
        finish(() => reject(new Error('Records could not be saved. Previous data retained.')));
      }
    }
  });
}
/** Catalog/preferences/health and revisions publish in one strict transaction after snapshot CAS. */
export function writeIndexedDbRecordPair(
  database: IDBDatabase,
  input: RecordPair,
  signal?: AbortSignal,
): Promise<CommitReceipt> {
  if (
    !boundedUtf8Text(input.catalog, 20 * 1024 * 1024) ||
    !boundedUtf8Text(input.preferences, 20 * 1024 * 1024)
  )
    return Promise.reject(new Error('Paired records exceed their separate storage bounds.'));
  return writeUpdate(database, input, signal);
}
export function writeIndexedDbRecord(
  database: IDBDatabase,
  name: 'catalog' | 'preferences',
  contents: string,
  signal?: AbortSignal,
  expectedCatalogRevision?: string,
): Promise<CommitReceipt> {
  return writeUpdate(database, { [name]: contents, expectedCatalogRevision }, signal);
}
export function writeIndexedDbHealth(
  database: IDBDatabase,
  health: string,
  expectedCatalogRevision: string,
  expectedHealthRevision: string,
  signal?: AbortSignal,
): Promise<CommitReceipt> {
  return writeUpdate(database, { health, expectedCatalogRevision, expectedHealthRevision }, signal);
}
// The same owned module is its worker entry: large parsing and SHA preparation never hold an IDB transaction open.
if (typeof document === 'undefined' && typeof self !== 'undefined') {
  const worker = self as unknown as {
    onmessage:
      | ((
          event: MessageEvent<
            | { snapshot: SavedRecordPair; update: RecordUpdate }
            | {
                checkpointRead: {
                  value: unknown;
                  jobId: unknown;
                  catalogRevision: string;
                  checkpointRevision: string;
                };
              }
          >,
        ) => void)
      | null;
    postMessage: (value: unknown) => void;
  };
  worker.onmessage = (event) => {
    const work =
      'checkpointRead' in event.data
        ? classifyCheckpoint(event.data.checkpointRead)
        : prepare(event.data.snapshot, event.data.update);
    void work.then(
      (value) => worker.postMessage({ ok: true, value }),
      () => worker.postMessage({ ok: false }),
    );
  };
}

/** Operational scan state is deliberately separate from catalog backups and exports. */
async function classifyCheckpoint(input: {
  value: unknown;
  jobId: unknown;
  catalogRevision: string;
  checkpointRevision: string;
}): Promise<SavedScanCheckpoint> {
  const metadata = {
    catalogRevision: input.catalogRevision,
    checkpointRevision: input.checkpointRevision,
  };
  if (input.value === null)
    return { ...metadata, checkpoint: null, checkpointStatus: 'absent', jobId: null };
  const jobId =
    boundedUtf8Text(input.jobId, 256) &&
    !/https?:\/\//iu.test(input.jobId) &&
    ![...input.jobId].some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
    )
      ? input.jobId
      : null;
  try {
    if (!boundedUtf8Text(input.value, 20 * 1024 * 1024)) throw new Error('Invalid checkpoint.');
    const parsed = await parseStoredScanCheckpoint(input.value);
    if (parsed.jobId !== jobId) throw new Error('Invalid checkpoint identity.');
    return { ...metadata, checkpoint: input.value, checkpointStatus: 'valid', jobId };
  } catch {
    return { ...metadata, checkpoint: null, checkpointStatus: 'invalid', jobId };
  }
}
function classifyCheckpointOffThread(
  input: Parameters<typeof classifyCheckpoint>[0],
): Promise<SavedScanCheckpoint> {
  if (typeof Worker === 'undefined') return classifyCheckpoint(input);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./record-transaction.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event: MessageEvent<{ ok: boolean; value: SavedScanCheckpoint }>) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.value);
      else reject(new Error('Saved scan checkpoint could not be read.'));
    };
    worker.onerror = () => {
      worker.terminate();
      reject(new Error('Saved scan checkpoint could not be read.'));
    };
    worker.postMessage({ checkpointRead: input });
  });
}
export function readIndexedDbScanCheckpoint(database: IDBDatabase): Promise<SavedScanCheckpoint> {
  return new Promise((resolve, reject) => {
    const tx = database.transaction('records', 'readonly'),
      store = tx.objectStore('records');
    const checkpoint = store.get('scanCheckpoint'),
      jobId = store.get('checkpointJobId'),
      revision = store.get('checkpointRevision'),
      catalog = store.get('catalogRevision');
    tx.oncomplete = () => {
      try {
        void classifyCheckpointOffThread({
          value: checkpoint.result ?? null,
          jobId: jobId.result ?? null,
          checkpointRevision: checkpointRevision(revision.result ?? '0'),
          catalogRevision: checkpointRevision(catalog.result ?? '0'),
        }).then(resolve, reject);
      } catch {
        reject(new Error('Saved scan checkpoint could not be read.'));
      }
    };
    tx.onabort = () => reject(new Error('Saved scan checkpoint could not be read.'));
  });
}
export function writeIndexedDbScanCheckpoint(
  database: IDBDatabase,
  mutation: ScanCheckpointMutation,
  expectedCatalogRevision: string,
  expectedCheckpointRevision: string,
  signal?: AbortSignal,
): Promise<CommitReceipt> {
  return writeUpdate(
    database,
    { scanCheckpoint: mutation, expectedCatalogRevision, expectedCheckpointRevision },
    signal,
  );
}
