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

import type { OwnedNativeRuntime } from '../../platform/owned-native-command';
import type { CommitReceipt } from '../../platform/record-transaction';
import {
  MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES,
  type ScanCheckpoint,
} from '../../discovery/scan-checkpoint';
import { boundedJsonUtf8Bytes } from '../../data-transfer/json-byte-admission';
import type { ScanReview } from '../../discovery/scan';
import {
  createScanCandidateManifestTransport,
  validateScanCandidateManifestEntries,
  ScanCandidateManifestError,
  type ManifestCas,
  type ScanCandidateManifestHeader,
  type ScanCandidateManifestEntry,
  type ScanCandidateManifestPage,
} from './scan-candidate-manifest';
import type { ManifestWorkerCommand, ManifestWorkerReply } from './scan-candidate-manifest-worker';
type WorkerTransport = Pick<
  Worker,
  'postMessage' | 'onmessage' | 'onerror' | 'onmessageerror' | 'terminate'
>;
const fail = () => new ScanCandidateManifestError();
function bridge(signal: AbortSignal, factory: () => WorkerTransport) {
  signal.throwIfAborted();
  const worker = factory();
  let sequence = 0,
    closed = false,
    stopped = false;
  const pending = new Map<
    number,
    { resolve(value: unknown): void; reject(error: Error): void; operation: string }
  >();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    signal.removeEventListener('abort', cancel);
    worker.onmessage = null;
    worker.onerror = null;
    worker.onmessageerror = null;
    worker.terminate();
  };
  const broken = () => {
    for (const item of pending.values()) item.reject(fail());
    pending.clear();
    stop();
  };
  const cancel = () => {
    if (stopped) return;
    try {
      worker.postMessage({ id: ++sequence, operation: 'cancel' });
    } catch {
      broken();
    }
  };
  worker.onerror = broken;
  worker.onmessageerror = broken;
  worker.onmessage = (event: MessageEvent<ManifestWorkerReply>) => {
    const reply = event.data;
    if (!reply || !Number.isSafeInteger(reply.id) || typeof reply.ok !== 'boolean') {
      broken();
      return;
    }
    const item = pending.get(reply.id);
    if (!item) return;
    pending.delete(reply.id);
    if (reply.ok) {
      if (signal.aborted && item.operation !== 'dispose')
        item.reject(new DOMException('Scan manifest canceled.', 'AbortError'));
      else item.resolve(reply.value);
    } else
      item.reject(
        reply.canceled ? new DOMException('Scan manifest canceled.', 'AbortError') : fail(),
      );
  };
  signal.addEventListener('abort', cancel, { once: true });
  const send = (command: Omit<ManifestWorkerCommand, 'id'>) => {
    if (stopped) return Promise.reject(fail());
    const id = ++sequence;
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject, operation: command.operation });
      try {
        worker.postMessage({ ...command, id });
      } catch {
        broken();
      }
    });
  };
  let disposal: Promise<void> | null = null;
  return {
    send,
    dispose() {
      if (disposal) return disposal;
      closed = true;
      const work = (async () => {
        try {
          if (!stopped) await send({ operation: 'dispose' });
        } finally {
          stop();
        }
      })();
      disposal = work;
      return work;
    },
    get closed() {
      return closed;
    },
  };
}
export interface StageScanCandidateManifestInput extends ManifestCas {
  checkpoint: string;
  review: ScanReview;
}
export interface RestoreScanCandidateManifestInput {
  checkpoint: string;
  header: ScanCandidateManifestHeader;
  readPage(startIndex: number, signal: AbortSignal): Promise<ScanCandidateManifestPage>;
}
/** One worker per initial capture or cold restore, with bounded pages and joined teardown. */
export function createScanCandidateManifestClient(
  runtime: OwnedNativeRuntime,
  options: { supportsManifest: boolean; workerFactory?: () => WorkerTransport },
) {
  const transport = createScanCandidateManifestTransport(runtime);
  const factory =
    options.workerFactory ??
    (() =>
      new Worker(new URL('./scan-candidate-manifest-worker.ts', import.meta.url), {
        type: 'module',
      }));
  const requireCapability = () => {
    if (!options.supportsManifest) throw fail();
  };
  return {
    async stageAndSeal(
      input: StageScanCandidateManifestInput,
      signal: AbortSignal,
    ): Promise<CommitReceipt> {
      requireCapability();
      signal.throwIfAborted();
      const checkpoint = input.checkpoint;
      const revisions = {
        expectedCatalogRevision: input.expectedCatalogRevision,
        expectedCheckpointRevision: input.expectedCheckpointRevision,
      };
      const worker = bridge(signal, factory);
      let committed: CommitReceipt | null = null;
      try {
        const info = (await worker.send({
          operation: 'capture-init',
          checkpoint,
        })) as {
          jobId: string;
          reviewDigest: string;
          candidateCount: number;
          sessionRevision: string;
          query: string;
        };
        signal.throwIfAborted();
        let current = await transport.begin(checkpoint, revisions, signal);
        if (
          current.jobId !== info.jobId ||
          current.reviewDigest !== info.reviewDigest ||
          current.candidateCount !== info.candidateCount
        )
          throw fail();
        if (
          input.review.candidates.length !== info.candidateCount ||
          input.review.sessionRevision !== info.sessionRevision ||
          input.review.query !== info.query
        )
          throw fail();
        let nextIndex = 0;
        while (nextIndex < info.candidateCount) {
          signal.throwIfAborted();
          const rows: ScanCandidateManifestEntry[] = [];
          const identities = [];
          let bytes = 2;
          while (nextIndex + rows.length < info.candidateCount && rows.length < 64) {
            const candidate = input.review.candidates[nextIndex + rows.length];
            const row = {
              candidateIndex: nextIndex + rows.length,
              urls: [...candidate.channel.urls],
            };
            const identity = {
              key: candidate.key,
              sourceId: candidate.sourceId,
              sourceFingerprint: candidate.sourceFingerprint,
              sessionRevision: candidate.sessionRevision,
            };
            const size =
              boundedJsonUtf8Bytes(row, MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES - 2048, signal) +
              boundedJsonUtf8Bytes(identity, MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES - 2048, signal);
            if (
              bytes + size + (rows.length ? 1 : 0) >
              MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES - 2048
            )
              break;
            bytes += size + (rows.length ? 1 : 0);
            rows.push(row);
            identities.push(identity);
          }
          if (!rows.length) throw fail();
          boundedJsonUtf8Bytes(
            { operation: 'append', entries: rows, identities },
            MAX_SCAN_CANDIDATE_MANIFEST_PAGE_BYTES,
            signal,
          );
          await worker.send({ operation: 'append', entries: rows, identities });
          current = await transport.append(current, rows, revisions, signal);
          nextIndex += rows.length;
        }
        await worker.send({ operation: 'finish' });
        signal.throwIfAborted();
        committed = await transport.seal(current, revisions, signal);
        return committed;
      } finally {
        // A confirmed native COMMIT cannot be converted into failure by post-commit worker teardown.
        if (committed) await worker.dispose().catch(() => undefined);
        else await worker.dispose();
      }
    },
    async lookup(jobId: string, reviewDigest: string, revisions: ManifestCas, signal: AbortSignal) {
      requireCapability();
      return transport.lookup(jobId, reviewDigest, revisions, signal);
    },
    async readPage(
      header: ScanCandidateManifestHeader,
      startIndex: number,
      revisions: ManifestCas,
      signal: AbortSignal,
    ) {
      requireCapability();
      return transport.readPage(header, startIndex, revisions, signal);
    },
    async restore(
      input: RestoreScanCandidateManifestInput,
      signal: AbortSignal,
    ): Promise<ScanCheckpoint> {
      requireCapability();
      signal.throwIfAborted();
      const worker = bridge(signal, factory);
      try {
        const info = (await worker.send({
          operation: 'restore-init',
          checkpoint: input.checkpoint,
        })) as { jobId: string; reviewDigest: string; candidateCount: number };
        const header = input.header;
        if (
          info.jobId !== header.jobId ||
          info.reviewDigest !== header.reviewDigest ||
          info.candidateCount !== header.candidateCount ||
          header.nextIndex !== header.candidateCount
        )
          throw fail();
        let next = 0;
        while (next < header.candidateCount) {
          signal.throwIfAborted();
          const page = await input.readPage(next, signal);
          signal.throwIfAborted();
          if (
            page.schemaVersion !== 1 ||
            page.manifestId !== header.manifestId ||
            page.manifestRevision !== header.manifestRevision ||
            page.jobId !== header.jobId ||
            page.reviewDigest !== header.reviewDigest ||
            page.startIndex !== next ||
            page.nextIndex !== next + page.entries.length ||
            page.nextIndex > header.candidateCount ||
            !page.entries.length
          )
            throw fail();
          const rows = validateScanCandidateManifestEntries(page.entries);
          await worker.send({ operation: 'append', entries: rows });
          next = page.nextIndex;
        }
        signal.throwIfAborted();
        return (await worker.send({ operation: 'finish' })) as ScanCheckpoint;
      } finally {
        await worker.dispose();
      }
    },
  };
}
