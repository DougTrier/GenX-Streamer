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
import { listen } from '@tauri-apps/api/event';
import { boundedUtf8Text } from './bounded-text';
import { invokeOwnedNative, type OwnedNativeRuntime } from './owned-native-command';
export interface ArchiveDownloadEntry {
  downloadRef: string;
  fileRef: string;
  titleRef: string;
  title: string;
  fileTitle: string;
  fileName: string;
  sizeBytes: string;
  completedMs: number;
  integrity: 'sha1-verified' | 'size-verified';
  available: boolean;
  cleanupPending?: true;
}
export interface ArchiveDownloadList {
  schemaVersion: 1;
  revision: string;
  entries: ArchiveDownloadEntry[];
}
export interface ArchiveDownloadReceipt {
  schemaVersion: 1;
  committed: true;
  revision: string;
  changed: boolean;
  entry: ArchiveDownloadEntry;
}
export interface ArchiveDownloadRemoveReceipt {
  schemaVersion: 1;
  committed: true;
  revision: string;
  changed: boolean;
  downloadRef: string;
  cleanupPending: boolean;
}
export type ArchiveDownloadPhase = 'preparing' | 'downloading' | 'verifying' | 'saving';
export interface ArchiveDownloadProgress {
  schemaVersion: 1;
  requestId: string;
  fileRef: string;
  jobId: string;
  phase: ArchiveDownloadPhase;
  receivedBytes: string;
  totalBytes: string | null;
}
export interface ArchiveDownloadRuntime extends OwnedNativeRuntime {
  listen(callback: (value: unknown) => void): Promise<() => void>;
}
export class ArchiveDownloadError extends Error {
  constructor(
    readonly category:
      | 'unavailable'
      | 'storage'
      | 'network'
      | 'integrity'
      | 'busy'
      | 'stale'
      | 'cleanup'
      | 'repair'
      | 'failed' = 'failed',
  ) {
    super(
      {
        unavailable: 'Downloads require the installed application.',
        storage:
          'There is not enough usable storage, or the saved file could not be written. Free space and retry.',
        network: 'The video could not download right now. Check your connection and retry.',
        integrity: 'The downloaded video could not be verified. It was not saved.',
        busy: 'Another download is still running. Cancel it before choosing another file.',
        stale: 'The selected file or saved downloads changed. Refresh and try again.',
        cleanup:
          'Download cleanup could not finish. Retry Cancel before starting another download.',
        repair: 'Saved-download recovery could not finish. Refresh downloads before trying again.',
        failed: 'The download could not finish. Your saved videos are preserved.',
      }[category],
    );
  }
}
const invalid = () => new ArchiveDownloadError();
export const downloadRef = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{64}$/u.test(v);
export const downloadRevision = (v: unknown): v is string =>
  typeof v === 'string' && /^(?:0|[1-9][0-9]{0,18})$/u.test(v) && BigInt(v) <= 9223372036854775807n;
function bytes(v: unknown, zero = false): v is string {
  return downloadRevision(v) && BigInt(v) >= (zero ? 0n : 1n) && BigInt(v) <= 68719476736n;
}
function record(v: unknown, keys: string[], optional: string[] = []): Record<string, unknown> {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(v)) ||
    Object.keys(v).some((key) => !keys.includes(key) && !optional.includes(key)) ||
    keys.some((k) => !Object.hasOwn(v, k))
  )
    throw invalid();
  for (const d of Object.values(Object.getOwnPropertyDescriptors(v)))
    if (!('value' in d)) throw invalid();
  return v as Record<string, unknown>;
}
export function validateArchiveDownloadEntry(value: unknown): ArchiveDownloadEntry {
  const r = record(
    value,
    [
      'downloadRef',
      'fileRef',
      'titleRef',
      'title',
      'fileTitle',
      'fileName',
      'sizeBytes',
      'completedMs',
      'integrity',
      'available',
    ],
    ['cleanupPending'],
  );
  if (
    ![r.downloadRef, r.fileRef, r.titleRef].every(downloadRef) ||
    !bytes(r.sizeBytes) ||
    !Number.isSafeInteger(r.completedMs) ||
    (r.completedMs as number) < 0 ||
    !['sha1-verified', 'size-verified'].includes(r.integrity as string) ||
    typeof r.available !== 'boolean' ||
    (Object.hasOwn(r, 'cleanupPending') && (r.cleanupPending !== true || r.available !== false)) ||
    [r.title, r.fileTitle, r.fileName].some(
      (v) =>
        !boundedUtf8Text(v, 1024) ||
        /[\p{Cc}\p{Cf}]/u.test(v as string) ||
        (v as string).includes('://'),
    )
  )
    throw invalid();
  return { ...r } as unknown as ArchiveDownloadEntry;
}
export function validateArchiveDownloadList(value: unknown): ArchiveDownloadList {
  const r = record(value, ['schemaVersion', 'revision', 'entries']);
  if (
    r.schemaVersion !== 1 ||
    !downloadRevision(r.revision) ||
    !Array.isArray(r.entries) ||
    r.entries.length > 256 ||
    new TextEncoder().encode(JSON.stringify(value)).length > 1048576
  )
    throw invalid();
  const entries = r.entries.map(validateArchiveDownloadEntry);
  if (
    new Set(entries.map((e) => e.downloadRef)).size !== entries.length ||
    new Set(entries.map((e) => e.fileRef)).size !== entries.length
  )
    throw invalid();
  return { schemaVersion: 1, revision: r.revision, entries };
}
export function validateArchiveDownloadReceipt(
  value: unknown,
  fileRef: string,
): ArchiveDownloadReceipt {
  const r = record(value, ['schemaVersion', 'committed', 'revision', 'changed', 'entry']);
  const entry = validateArchiveDownloadEntry(r.entry);
  if (
    r.schemaVersion !== 1 ||
    r.committed !== true ||
    !downloadRevision(r.revision) ||
    typeof r.changed !== 'boolean' ||
    entry.fileRef !== fileRef ||
    !entry.available
  )
    throw invalid();
  return { schemaVersion: 1, committed: true, revision: r.revision, changed: r.changed, entry };
}
export function validateArchiveDownloadProgress(value: unknown): ArchiveDownloadProgress {
  const r = record(value, [
    'schemaVersion',
    'requestId',
    'fileRef',
    'jobId',
    'phase',
    'receivedBytes',
    'totalBytes',
  ]);
  if (
    r.schemaVersion !== 1 ||
    typeof r.requestId !== 'string' ||
    !/^[A-Za-z0-9-]{1,128}$/u.test(r.requestId) ||
    !downloadRef(r.fileRef) ||
    !downloadRef(r.jobId) ||
    !['preparing', 'downloading', 'verifying', 'saving'].includes(r.phase as string) ||
    !bytes(r.receivedBytes, true) ||
    (r.totalBytes !== null && !bytes(r.totalBytes)) ||
    (r.totalBytes === null && r.phase !== 'preparing') ||
    (r.totalBytes !== null && BigInt(r.receivedBytes as string) > BigInt(r.totalBytes as string))
  )
    throw invalid();
  return { ...r } as unknown as ArchiveDownloadProgress;
}
export function archiveDownloadFailure(error: unknown): never {
  if (error instanceof ArchiveDownloadError) throw error;
  const fixed: Record<string, ArchiveDownloadError['category']> = {
    'archive-download-no-space': 'storage',
    'archive-download-disk-full': 'storage',
    'archive-download-storage-failed': 'storage',
    'archive-download-storage-busy': 'storage',
    'archive-download-space-exhausted': 'storage',
    'archive-download-space-insufficient': 'storage',
    'archive-download-space-unavailable': 'storage',
    'archive-download-write-failed': 'storage',
    'archive-download-directory-capacity': 'storage',
    'archive-download-limit': 'storage',
    'archive-download-network': 'network',
    'archive-download-timeout': 'network',
    'archive-download-deadline': 'network',
    'archive-download-access-refused': 'network',
    'archive-download-response-refused': 'network',
    'archive-download-dns-failed': 'network',
    'archive-download-dns-join': 'network',
    'archive-download-dns-limit': 'network',
    'archive-download-dns-private': 'network',
    'archive-download-host-refused': 'network',
    'archive-download-path-refused': 'network',
    'archive-download-redirect-limit': 'network',
    'archive-download-truncated': 'network',
    'archive-download-checksum-invalid': 'integrity',
    'archive-download-checksum-mismatch': 'integrity',
    'archive-download-integrity-failed': 'integrity',
    'archive-download-overflow': 'integrity',
    'archive-download-file-corrupt': 'integrity',
    'archive-download-cleanup-failed': 'cleanup',
    'archive-download-file-changed': 'stale',
    'archive-download-conflict': 'stale',
    'archive-download-storage': 'storage',
    'archive-download-busy': 'busy',
    'archive-download-revision-stale': 'stale',
    'archive-revision-stale': 'stale',
    'archive-download-checksum': 'integrity',
    'archive-download-integrity': 'integrity',
    'archive-download-cleanup': 'cleanup',
    'archive-download-repair-required': 'repair',
    'archive-proxy-network': 'network',
    'archive-proxy-timeout': 'network',
    'archive-media-unavailable': 'network',
    'archive-media-access-refused': 'network',
    'archive-media-rate-limited': 'network',
  };
  throw new ArchiveDownloadError(typeof error === 'string' ? (fixed[error] ?? 'failed') : 'failed');
}
export function createArchiveDownloadsAdapter(runtime?: ArchiveDownloadRuntime) {
  const native: ArchiveDownloadRuntime = runtime ?? {
    invoke: (command, args) =>
      isTauri() ? invoke(command, args) : Promise.reject(new ArchiveDownloadError('unavailable')),
    listen: async (callback) => {
      if (!isTauri()) throw new ArchiveDownloadError('unavailable');
      return listen('archive-download-progress', (event) => callback(event.payload));
    },
  };
  const pendingUnlisteners = new Set<() => void>();
  function cleanupListeners() {
    for (const unlisten of pendingUnlisteners) {
      try {
        unlisten();
        pendingUnlisteners.delete(unlisten);
      } catch {
        /* Retain exact callback for actual retry. */
      }
    }
    if (pendingUnlisteners.size) throw new ArchiveDownloadError('cleanup');
  }
  async function owned<T>(
    command: string,
    args: Record<string, unknown>,
    options: Parameters<typeof invokeOwnedNative<T>>[3],
    idFactory = native.idFactory,
  ): Promise<T> {
    let repair = false;
    try {
      return await invokeOwnedNative(
        {
          idFactory,
          invoke: async (name, args) => {
            try {
              return await native.invoke(name, args);
            } catch (error) {
              if (error === 'archive-download-repair-required') repair = true;
              throw error;
            }
          },
        },
        command,
        args,
        options,
      );
    } catch (error) {
      if (repair) throw new ArchiveDownloadError('repair');
      if (
        error instanceof Error &&
        error.message === 'Native command cancellation could not be confirmed.'
      )
        throw new ArchiveDownloadError('cleanup');
      throw error;
    }
  }
  return {
    get cleanupPending() {
      return pendingUnlisteners.size > 0;
    },
    list(signal?: AbortSignal): Promise<ArchiveDownloadList> {
      return owned(
        'list_archive_downloads',
        {},
        { signal, validate: validateArchiveDownloadList, failure: archiveDownloadFailure },
      );
    },
    status(signal?: AbortSignal): Promise<ArchiveDownloadProgress | null> {
      return owned(
        'archive_download_status',
        {},
        {
          signal,
          validate: (v) => (v === null ? null : validateArchiveDownloadProgress(v)),
          failure: archiveDownloadFailure,
        },
      );
    },
    async start(
      fileRef: string,
      expectedRevision: string,
      signal: AbortSignal,
      onProgress: (p: ArchiveDownloadProgress) => void,
    ): Promise<ArchiveDownloadReceipt> {
      if (!downloadRef(fileRef) || !downloadRevision(expectedRevision)) throw invalid();
      signal.throwIfAborted();
      cleanupListeners();
      const requestId = (native.idFactory ?? (() => crypto.randomUUID()))();
      let listening = true;
      let previous: ArchiveDownloadProgress | null = null;
      const phases = ['preparing', 'downloading', 'verifying', 'saving'];
      const unlisten = await native.listen((value) => {
        if (!listening) return;
        try {
          const p = validateArchiveDownloadProgress(value);
          if (p.requestId !== requestId || p.fileRef !== fileRef) return;
          if (
            previous &&
            (p.jobId !== previous.jobId ||
              phases.indexOf(p.phase) < phases.indexOf(previous.phase) ||
              BigInt(p.receivedBytes) < BigInt(previous.receivedBytes) ||
              (previous.totalBytes !== null && p.totalBytes !== previous.totalBytes))
          )
            return;
          previous = p;
          onProgress(Object.freeze({ ...p }));
        } catch {
          /* Untrusted or unrelated event cannot publish state or alter original ownership. */
        }
      });
      try {
        return await owned(
          'start_archive_download',
          { request: { schemaVersion: 1, fileRef, expectedRevision } },
          {
            signal,
            durable: true,
            validate: (v) => validateArchiveDownloadReceipt(v, fileRef),
            failure: archiveDownloadFailure,
          },
          () => requestId,
        );
      } finally {
        listening = false;
        pendingUnlisteners.add(unlisten);
        try {
          cleanupListeners();
        } catch {
          /* Original receipt/error remains truthful; cleanup is retained and blocks next start. */
        }
      }
    },
    remove(
      download: string,
      expectedRevision: string,
      signal?: AbortSignal,
    ): Promise<ArchiveDownloadRemoveReceipt> {
      if (!downloadRef(download) || !downloadRevision(expectedRevision))
        return Promise.reject(invalid());
      return owned(
        'remove_archive_download',
        { request: { schemaVersion: 1, downloadRef: download, expectedRevision } },
        {
          signal,
          durable: true,
          failure: archiveDownloadFailure,
          validate: (value) => {
            const r = record(value, [
              'schemaVersion',
              'committed',
              'revision',
              'changed',
              'downloadRef',
              'cleanupPending',
            ]);
            if (
              r.schemaVersion !== 1 ||
              r.committed !== true ||
              r.downloadRef !== download ||
              !downloadRevision(r.revision) ||
              typeof r.changed !== 'boolean' ||
              typeof r.cleanupPending !== 'boolean' ||
              BigInt(r.revision) !== BigInt(expectedRevision) + (r.changed ? 1n : 0n)
            )
              throw invalid();
            return { ...r } as unknown as ArchiveDownloadRemoveReceipt;
          },
        },
      );
    },
    async stop(): Promise<void> {
      try {
        const r = record(await native.invoke('stop_archive_downloads'), [
          'schemaVersion',
          'stopped',
          'cleanupPending',
        ]);
        if (r.schemaVersion !== 1 || r.stopped !== true || r.cleanupPending !== false)
          throw invalid();
        cleanupListeners();
      } catch {
        throw new ArchiveDownloadError('cleanup');
      }
    },
  };
}
