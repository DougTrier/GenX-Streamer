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
  SourceScanWindowSizeError,
  type SourceScanHost,
  type SourceScanPublicationChunk,
} from '../ui/source-scan-model';
import { type SelectionSessionAck } from '../discovery/selection-session';
import { readScanCheckpoint, readScanHealth, writeRecordPair } from '../platform/records';
import { nativeScanBatchCommit } from '../platform/scan-batch-commit';
import {
  prepareCompactScanInWorker,
  prepareNativeScanBatchInWorker,
  prepareScanInWorker,
} from '../discovery/selection';
import { decodeSavedHealthOnlyInWorker } from './health-history-read';
import { applyCatalogPatch } from '../discovery/catalog-patch';
import { boundedUtf8Text } from '../platform/bounded-text';
import {
  nativeScanWindowCommit,
  validateScanWindow,
  type ScanWindowFailureCode,
} from '../platform/scan-window-commit';
import { isSelectionWindowSizeError } from '../discovery/selection-window';
import { type createScanPublicationObserver } from './scan-publication-observer';
import { type ScanSource } from '../discovery/scan';
import { type createScanCheckpointProgressCapture } from './scan-checkpoint-capture-service';
import { type ScanEnvironment } from './scan-controller';
import { type ScanPublicationHandle } from './scan-publication-observer';

/** What this part reads from, and writes back to, createScanController. */
export interface ScanPublicationCommitShared {
  readonly publicationTraceByMutation: WeakMap<object, ScanPublicationHandle>;
  readonly scanPublicationObserver: ReturnType<typeof createScanPublicationObserver>;
  readonly scanScope: ScanSource[];
  scanStorageRevision: string;
  readonly checkpointProgressCapture:
    ReturnType<typeof createScanCheckpointProgressCapture> | undefined;
  readonly supportsNativeScanBatch: (signal: AbortSignal) => Promise<boolean>;
  scanNativeFailures: readonly Readonly<{ attempt: number; code: ScanWindowFailureCode }>[];
  readonly scanBatchSettled: () => void;
}

/**
 * Committing a scan's found channels to the catalog, one checked
 * publication at a time. Part of createScanController.
 */
export function createScanPublicationCommit(
  env: ScanEnvironment,
  shared: ScanPublicationCommitShared,
) {
  async function commitScanPublication(
    selection: Parameters<SourceScanHost['commit']>[0],
    revision: string,
    signal: AbortSignal,
    health?: Parameters<SourceScanHost['commit']>[3],
    checkpointContext?: Parameters<SourceScanHost['commit']>[4],
    episodeId?: string,
    windowChunks?: readonly SourceScanPublicationChunk[],
  ) {
    const preparedTrace =
      checkpointContext && shared.publicationTraceByMutation.get(checkpointContext.mutation);
    const trace =
      (preparedTrace && shared.scanPublicationObserver.resume(preparedTrace)) ||
      shared.scanPublicationObserver.begin();
    if (checkpointContext) shared.publicationTraceByMutation.set(checkpointContext.mutation, trace);
    const traceAttempt = shared.scanPublicationObserver.snapshot().generation;
    shared.scanPublicationObserver.step(trace, 'queued');
    const scope = structuredClone(shared.scanScope);
    const expectedCatalogRevision = shared.scanStorageRevision;
    const reviewedHealth = health === undefined ? undefined : structuredClone(health);
    let committedCheckpointRevision: string | undefined;
    let durableSelectionReceipt: SelectionSessionAck | undefined;
    let nativePublicationDispatched = false;
    const episode = episodeId === undefined ? undefined : env.selectionEpisode;
    const work = env.catalogWrites.then(async () => {
      const current = () => {
        signal.throwIfAborted();
        if (
          revision !== String(env.catalogRevision) ||
          selection.sessionRevision !== revision ||
          windowChunks?.some((chunk) => chunk.staged.sessionRevision !== revision)
        )
          throw new Error('Saved channels changed. Scan again before saving.');
      };
      current();
      if (
        episodeId !== undefined &&
        (!episode ||
          episode.id !== episodeId ||
          episode.broken ||
          episode.catalog !== env.catalog ||
          episode.revision !== expectedCatalogRevision)
      )
        throw new Error('Scan preparation changed. Continue the scan again.');
      if (env.importRunning || env.transferBusy)
        throw new Error('Wait for the current import to finish.');
      env.transferBusy = true;
      env.setImportBusy(true);
      const releaseUncommittedWindowCheckpoint = async () => {
        if (!checkpointContext || !shared.checkpointProgressCapture?.hasPendingPreparation) return;
        const actual = await readScanCheckpoint();
        current();
        if (
          actual.catalogRevision !== expectedCatalogRevision ||
          actual.checkpointRevision !== checkpointContext.expectedCheckpointRevision ||
          actual.checkpointStatus === 'invalid'
        )
          throw new Error('Scan progress changed. Reopen the app before continuing.');
        shared.checkpointProgressCapture.releaseUncommittedPreparation(
          checkpointContext.expectedCheckpointRevision,
          actual.checkpointRevision,
        );
      };
      try {
        const snapshot = await env.preferences.settledSnapshot();
        current();
        const boundedBatch =
          selection.sources.reduce((sum, source) => sum + source.candidates.length, 0) <= 64;
        const nativeBatch = boundedBatch && (await shared.supportsNativeScanBatch(signal));
        current();
        if (
          windowChunks &&
          (!episode?.supportsWindow || windowChunks.length < 1 || windowChunks.length > 4)
        )
          throw new Error('Scan window preparation is unavailable. Continue the scan again.');
        if (episode && !nativeBatch)
          throw new Error('Scan preparation is unavailable. Continue the scan again.');
        shared.scanPublicationObserver.step(trace, 'read-revisions', {
          catalogRevision: expectedCatalogRevision,
        });
        const saved = nativeBatch
          ? await nativeScanBatchCommit.revisions(signal)
          : await readScanHealth();
        current();
        if (saved.catalogRevision !== expectedCatalogRevision)
          throw new Error('Saved channels changed. Reopen the app and scan again.');
        const baseCatalog = env.catalog;
        // Compact replies target bounded progressive batches. Large manual imports
        // retain the existing full-transfer path instead of deriving a full-size patch.
        const prepare = boundedBatch ? prepareCompactScanInWorker : prepareScanInWorker;
        shared.scanPublicationObserver.step(trace, 'actor-prepare', {
          healthRevision: saved.healthRevision,
        });
        const prepared =
          windowChunks && episode
            ? await episode.actor.prepareWindow(
                {
                  schemaVersion: 1,
                  chunks: windowChunks.map((chunk) => ({
                    selection: chunk.staged,
                    review: chunk.health,
                  })),
                  preferences: snapshot,
                  expectedCatalogRevision,
                },
                signal,
              )
            : nativeBatch
              ? episode
                ? await episode.actor.prepare(
                    {
                      selection,
                      preferences: snapshot,
                      review: reviewedHealth,
                      expectedCatalogRevision,
                    },
                    signal,
                  )
                : await prepareNativeScanBatchInWorker(
                    baseCatalog,
                    snapshot,
                    selection,
                    scope,
                    signal,
                    reviewedHealth,
                  )
              : await prepare(baseCatalog, snapshot, selection, scope, signal, {
                  previousHealth: (
                    await decodeSavedHealthOnlyInWorker(
                      saved as Awaited<ReturnType<typeof readScanHealth>>,
                      signal,
                    )
                  ).health,
                  review: reviewedHealth,
                });
        current();
        if (env.catalog !== baseCatalog)
          throw new Error('Saved channels changed before scan publication.');
        if (
          episode &&
          (!('preparationId' in prepared) ||
            typeof prepared.preparationId !== 'string' ||
            !('expectedCatalogRevision' in prepared) ||
            prepared.expectedCatalogRevision !== expectedCatalogRevision)
        )
          throw new Error('Scan preparation did not confirm its catalog revision.');
        shared.scanPublicationObserver.step(trace, 'patch-admission');
        const nextCatalog =
          'chunks' in prepared
            ? prepared.chunks.reduce(
                (previous, chunk) =>
                  applyCatalogPatch(
                    previous,
                    chunk.catalogPatch,
                    scope.map((entry) => entry.source),
                  ),
                baseCatalog,
              )
            : 'catalogPatch' in prepared
              ? applyCatalogPatch(
                  baseCatalog,
                  prepared.catalogPatch,
                  scope.map((entry) => entry.source),
                )
              : prepared.record.catalog;
        const preparedPreferences =
          'nextPreferences' in prepared
            ? prepared.nextPreferences
            : 'catalogPatch' in prepared
              ? prepared.preferences
              : prepared.record.preferences;
        // Scan preparation changes sources only. Preserve edits acknowledged
        // while its worker/storage preparation was pending, including audio.
        const latestPreferences = await env.preferences.settledSnapshot();
        current();
        const nextPreferences = {
          ...latestPreferences,
          sources: preparedPreferences.sources,
        };
        const selectedSourceIds = new Set(
          (windowChunks ? windowChunks.flatMap((chunk) => chunk.staged.sources) : selection.sources)
            .filter((source) => source.candidates.length > 0)
            .map((source) => source.sourceId),
        );
        const windowInput =
          'chunks' in prepared
            ? {
                schemaVersion: 1 as const,
                chunks: prepared.chunks,
                authorizedSources: nextCatalog.sources.filter((source) =>
                  selectedSourceIds.has(source.id),
                ),
                nextPreferences,
                expectedCatalogRevision,
                expectedHealthRevision: saved.healthRevision,
                ...(checkpointContext
                  ? {
                      scanCheckpoint: checkpointContext.mutation,
                      expectedCheckpointRevision: checkpointContext.expectedCheckpointRevision,
                    }
                  : {}),
              }
            : undefined;
        shared.scanPublicationObserver.step(trace, 'window-admission');
        if (
          windowInput &&
          !boundedUtf8Text(
            JSON.stringify({ window: windowInput, requestId: '0'.repeat(36) }),
            20 * 1024 * 1024,
          )
        ) {
          // No native write has been dispatched. Release the pending checkpoint only
          // after checking storage; the failed episode's provisional actor is discarded.
          await releaseUncommittedWindowCheckpoint();
          throw new SourceScanWindowSizeError();
        }
        if (windowInput) {
          validateScanWindow(windowInput);
          shared.scanPublicationObserver.step(trace, 'window-admission', {
            wireBytes: new TextEncoder().encode(
              JSON.stringify({ window: windowInput, requestId: '0'.repeat(36) }),
            ).byteLength,
          });
        }
        env.settings = await env.preferences.replaceAtomically(nextPreferences, async () => {
          current();
          nativePublicationDispatched = true;
          shared.scanPublicationObserver.step(trace, 'native-dispatch', { dispatched: true });
          const receipt = windowInput
            ? await nativeScanWindowCommit.commit(windowInput, signal, (code) => {
                shared.scanNativeFailures = Object.freeze([
                  ...shared.scanNativeFailures.slice(-1),
                  Object.freeze({ attempt: traceAttempt, code }),
                ]);
              })
            : 'incomingHealth' in prepared
              ? await nativeScanBatchCommit.commit(
                  {
                    schemaVersion: 1,
                    catalogPatch: prepared.catalogPatch,
                    authorizedSources: nextCatalog.sources.filter((source) =>
                      selectedSourceIds.has(source.id),
                    ),
                    nextPreferences,
                    incomingHealth: prepared.incomingHealth,
                    expectedCatalogRevision,
                    expectedHealthRevision: saved.healthRevision,
                    ...(checkpointContext
                      ? {
                          scanCheckpoint: checkpointContext.mutation,
                          expectedCheckpointRevision: checkpointContext.expectedCheckpointRevision,
                        }
                      : {}),
                  },
                  signal,
                )
              : 'catalogText' in prepared
                ? await writeRecordPair(
                    {
                      catalog: prepared.catalogText,
                      preferences: JSON.stringify(nextPreferences),
                      health: prepared.healthText,
                      expectedCatalogRevision,
                      expectedHealthRevision: saved.healthRevision,
                      ...(checkpointContext
                        ? {
                            scanCheckpoint: checkpointContext.mutation,
                            expectedCheckpointRevision:
                              checkpointContext.expectedCheckpointRevision,
                          }
                        : {}),
                    },
                    signal,
                  )
                : await Promise.reject(new Error('Scan window preparation was not admitted.'));
          shared.scanPublicationObserver.step(trace, 'native-settled', {
            durableCommitted: true,
            catalogRevision: receipt.catalogRevision,
            healthRevision: receipt.healthRevision,
            ...(receipt.checkpointRevision === undefined
              ? {}
              : { checkpointRevision: receipt.checkpointRevision }),
          });
          env.persistedCatalogRevision = receipt.catalogRevision;
          shared.scanStorageRevision = receipt.catalogRevision;
          if (checkpointContext && receipt.checkpointRevision === undefined)
            throw new Error('Channel save did not confirm scan progress.');
          committedCheckpointRevision = receipt.checkpointRevision;
          durableSelectionReceipt = {
            committed: true,
            catalogRevision: receipt.catalogRevision,
            healthRevision: receipt.healthRevision,
          };
        });
        env.catalog = nextCatalog;
        env.catalogRevision++;
        const preparationId =
          'preparationId' in prepared && typeof prepared.preparationId === 'string'
            ? prepared.preparationId
            : undefined;
        if (episode && preparationId && durableSelectionReceipt) {
          episode.catalog = env.catalog;
          episode.revision = durableSelectionReceipt.catalogRevision;
          try {
            shared.scanPublicationObserver.step(trace, 'actor-ack');
            if ('chunks' in prepared)
              await episode.actor.acknowledgeWindow(preparationId, durableSelectionReceipt);
            else await episode.actor.acknowledge(preparationId, durableSelectionReceipt);
          } catch {
            shared.scanPublicationObserver.fail(trace, 'ack-failed');
            // The native write already committed. Preserve its receipt and published membership.
            episode.broken = true;
            await episode.actor.dispose().catch(() => undefined);
            void env.diagnostics.emit({ operation: 'scan', level: 'warning', code: 'scan-failed' });
          }
        }
        shared.scanPublicationObserver.step(trace, 'apply-ui');
        const selected = env.player.snapshot.selection;
        if (
          selected &&
          !env.catalog.channels.some(
            (channel) => channel.id === selected.id && channel.urls.includes(selected.url),
          )
        )
          await env.sharingBridge
            .stop()
            .catch(() => env.notice('Channels saved. Playback cleanup needs attention.'));
        shared.scanBatchSettled();
        if (!checkpointContext) shared.scanPublicationObserver.complete(trace);
        return {
          committed: true as const,
          revision: String(env.catalogRevision),
          ...(committedCheckpointRevision === undefined
            ? {}
            : { checkpointRevision: committedCheckpointRevision }),
        };
      } catch (error) {
        shared.scanPublicationObserver.fail(
          trace,
          signal.aborted
            ? 'canceled'
            : nativePublicationDispatched
              ? 'native-failed'
              : 'admission-refused',
        );
        let failure = error;
        if (windowChunks && !nativePublicationDispatched && isSelectionWindowSizeError(error)) {
          try {
            await releaseUncommittedWindowCheckpoint();
            failure = new SourceScanWindowSizeError();
          } catch (refusal) {
            failure = refusal;
          }
        }
        if (episode && !durableSelectionReceipt) {
          episode.broken = true;
          await episode.actor.quarantine().catch(() => undefined);
        }
        throw failure;
      } finally {
        env.transferBusy = false;
        env.setImportBusy(false);
      }
    });
    env.catalogWrites = work.catch(() => undefined);
    void work.catch(() =>
      shared.scanPublicationObserver.fail(
        trace,
        signal.aborted ? 'canceled' : episode?.broken ? 'actor-failed' : 'unknown',
      ),
    );
    return work;
  }
  return {
    commitScanPublication,
  };
}
