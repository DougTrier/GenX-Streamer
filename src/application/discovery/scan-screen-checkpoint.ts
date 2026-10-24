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
  discardScanCheckpoint,
  readScanCheckpoint,
  writeScanCheckpoint,
  writeScanCheckpointMutation,
  type CommitReceipt,
} from '../../platform/records';
import {
  parseStoredCaptureWithPacked as parseScanCheckpointCapture,
  prepareStoredCapture as prepareScanCheckpointCapture,
  restorePackedCapture,
  restoreReferencedCapture,
} from './scan-checkpoint-capture-service';
import {
  canResumeScanCheckpoint,
  fingerprintScanPolicy,
  fingerprintScanSource,
  scanReconstructionFailureCode,
  validateCheckpointSourceAdmission,
} from '../../discovery/scan-checkpoint';
import { reachabilityHealthProfile } from '../health/health-profile';
import { isTauri } from '@tauri-apps/api/core';
import { scanConfiguredSources } from '../../discovery/scan';
import { reorderScanCandidates } from '../../discovery/scan-priority';
import { type SourceScanCheckpointHost } from '../../ui/source-scan-model';
import { type mountSourceScan } from '../../ui/source-scan';
import { type ScanEnvironment } from './scan-controller';
import { type ScanScreenShared } from './scan-screen';

/**
 * The scan screen's checkpoint host: saving, reading, sealing and clearing
 * the saved progress of an automatic scan. Part of the scan screen's wiring.
 */
export function scanScreenCheckpoint(
  shared: ScanScreenShared,
  env: ScanEnvironment,
  // Read when a checkpoint call runs: the scan screen is still being created here.
  sourceScan: () => ReturnType<typeof mountSourceScan>,
): SourceScanCheckpointHost {
  return {
    load: async (signal) => {
      shared.checkpointProgressCapture?.reset();
      shared.resumedCheckpointFormat = null;
      const recovery = shared.scanRecoveryObserver.begin();
      await env.catalogWrites;
      await env.preferences.settledSnapshot();
      signal.throwIfAborted();
      const saved = await readScanCheckpoint().catch((error: unknown) => {
        shared.scanRecoveryObserver.refuse(
          recovery,
          signal.aborted ? 'canceled' : 'read-unavailable',
        );
        throw error;
      });
      signal.throwIfAborted();
      if (saved.catalogRevision !== env.persistedCatalogRevision) {
        shared.scanRecoveryObserver.refuse(recovery, 'saved-catalog-changed');
        throw new Error('Saved channels changed. Reopen the app before scanning.');
      }
      shared.scanStorageRevision = saved.catalogRevision;
      if (saved.checkpointStatus !== 'valid' || saved.checkpoint === null) {
        if (saved.checkpointStatus === 'absent')
          shared.scanRecoveryObserver.step(recovery, 'absent');
        else shared.scanRecoveryObserver.refuse(recovery, 'invalid-checkpoint');
        return saved;
      }
      shared.scanRecoveryObserver.step(recovery, 'decoding');
      const parsed = await parseScanCheckpointCapture(saved.checkpoint, signal).catch(
        (error: unknown) => {
          shared.scanRecoveryObserver.refuse(
            recovery,
            signal.aborted ? 'canceled' : 'invalid-checkpoint',
          );
          throw error;
        },
      );
      shared.scanRecoveryObserver.decoded(
        recovery,
        parsed.schemaVersion,
        parsed.observations.length,
        parsed.schemaVersion === 3 ? parsed.publishedIndices.length : parsed.publishedKeys.length,
      );
      if (parsed.schemaVersion === 3) {
        const capability = await shared.checkpointProgressCapability();
        signal.throwIfAborted();
        if (!capability.packedReference) {
          shared.scanRecoveryObserver.refuse(recovery, 'unsupported-format');
          return { ...saved, checkpoint: null, checkpointStatus: 'invalid' as const };
        }
      }
      shared.scanRecoveryObserver.step(recovery, 'source-authority');
      try {
        await validateCheckpointSourceAdmission(
          parsed,
          env.catalog.sources,
          env.settings.reviewedChannelProviders ?? null,
        );
      } catch {
        signal.throwIfAborted();
        shared.scanRecoveryObserver.refuse(recovery, 'source-settings-changed');
        return { ...saved, checkpoint: null, checkpointStatus: 'invalid' as const };
      }
      shared.scanRecoveryObserver.step(recovery, 'policy');
      const policy = await fingerprintScanPolicy({
        providers: env.settings.reviewedChannelProviders ?? null,
        preferredRegion: env.settings.preferredRegion,
        budgetMs: parsed.budgetMs,
        platform: shared.healthPlatform ?? 'native-unavailable',
        observerProfile: reachabilityHealthProfile(isTauri(), parsed.budgetMs),
        sourceDefinitions: parsed.sourceDefinitions,
      });
      signal.throwIfAborted();
      if (!canResumeScanCheckpoint(parsed, Date.now(), env.persistedCatalogRevision, policy)) {
        shared.scanRecoveryObserver.refuse(recovery, 'expired-or-policy-changed');
        return { ...saved, checkpoint: null, checkpointStatus: 'invalid' as const };
      }
      shared.scanRegion = parsed.preferredRegion
        ? structuredClone(parsed.preferredRegion)
        : undefined;
      shared.scanScope = parsed.sourceDefinitions.map((definition) => ({
        source: structuredClone(definition.source),
        fingerprint: parsed.review.sources.find(
          (source) => source.sourceId === definition.source.id,
        )!.fingerprint,
      }));
      if (parsed.schemaVersion === 2 || parsed.schemaVersion === 3) {
        try {
          if (parsed.schemaVersion === 3) {
            shared.scanRecoveryObserver.step(recovery, 'candidate-storage');
            const client = await shared.candidateManifestClient(signal);
            const revisions = {
              expectedCatalogRevision: saved.catalogRevision,
              expectedCheckpointRevision: saved.checkpointRevision,
            };
            const header = client
              ? await client.lookup(parsed.jobId, parsed.reviewDigest, revisions, signal)
              : null;
            signal.throwIfAborted();
            if (client && header) {
              shared.scanRecoveryObserver.step(recovery, 'candidate-restore');
              const restored = await client.restore(
                {
                  checkpoint: saved.checkpoint,
                  header,
                  readPage: (startIndex, readSignal) =>
                    client.readPage(header, startIndex, revisions, readSignal),
                },
                signal,
              );
              signal.throwIfAborted();
              shared.scanRecoveryObserver.step(recovery, 'catalog-fence');
              if (saved.catalogRevision !== env.persistedCatalogRevision || env.applicationClosing)
                throw new Error('Saved channels changed during scan recovery.');
              shared.manifestBackedJobId = parsed.jobId;
              shared.resumedCheckpointFormat = { jobId: parsed.jobId, schemaVersion: 3 };
              shared.scanRecoveryObserver.step(recovery, 'accepted');
              return { ...saved, parsed: restored };
            }
          }
          shared.scanRecoveryObserver.step(recovery, 'reacquiring');
          shared.scanCollector.reset();
          const acquired = await scanConfiguredSources(shared.scanScope, shared.collectScanSource, {
            sessionRevision: parsed.review.sessionRevision,
            // Resume resolves the captured URLs, even if their current display metadata changed.
            query: '',
            signal,
          });
          signal.throwIfAborted();
          shared.scanRecoveryObserver.step(recovery, 'source-definition');
          for (const definition of parsed.sourceDefinitions) {
            const observed = shared.scanScope.find(
              (entry) => entry.source.id === definition.source.id,
            );
            if (
              !observed ||
              (await fingerprintScanSource(observed.source)) !== definition.definitionFingerprint
            )
              throw new Error('Saved source definition changed.');
          }
          const review = reorderScanCandidates(acquired, shared.scanRegion);
          shared.scanRecoveryObserver.step(recovery, 'immutable-review');
          const restored =
            parsed.schemaVersion === 3
              ? await restorePackedCapture(parsed, review, signal)
              : await restoreReferencedCapture(parsed, review, signal);
          signal.throwIfAborted();
          shared.scanRecoveryObserver.step(recovery, 'catalog-fence');
          // Reacquisition is read-only and never grants a source or repeats settled probes.
          if (saved.catalogRevision !== env.persistedCatalogRevision || env.applicationClosing)
            throw new Error('Saved channels changed during scan recovery.');
          shared.resumedCheckpointFormat = {
            jobId: parsed.jobId,
            schemaVersion: parsed.schemaVersion,
          };
          shared.scanRecoveryObserver.step(recovery, 'accepted');
          return { ...saved, parsed: restored };
        } catch (error) {
          signal.throwIfAborted();
          const stage = shared.scanRecoveryObserver.snapshot().stage;
          shared.scanRecoveryObserver.refuse(
            recovery,
            stage === 'catalog-fence'
              ? 'saved-catalog-changed'
              : stage === 'candidate-storage' || stage === 'candidate-restore'
                ? 'candidate-storage-unavailable'
                : stage === 'immutable-review'
                  ? 'immutable-review-changed'
                  : stage === 'source-definition'
                    ? 'source-settings-changed'
                    : 'source-unavailable',
            stage === 'immutable-review' ? scanReconstructionFailureCode(error) : null,
          );
          return { ...saved, checkpoint: null, checkpointStatus: 'invalid' as const };
        } finally {
          shared.scanCollector.reset();
        }
      }
      shared.resumedCheckpointFormat = {
        jobId: parsed.jobId,
        schemaVersion: parsed.schemaVersion,
      };
      shared.scanRecoveryObserver.step(recovery, 'accepted');
      return { ...saved, parsed };
    },
    prepare: (snapshot, signal) =>
      prepareScanCheckpointCapture(shared.checkpointCaptureInput(snapshot), signal),
    prepareMutation: async (
      snapshot,
      signal,
      expectedCheckpointRevision,
      publicationLimit = 64,
      publicationKeys,
    ) => {
      const trace = publicationKeys?.length
        ? shared.scanPublicationObserver.begin({
            selected: publicationKeys.length,
            chunks: Math.ceil(publicationKeys.length / 64),
            checkpointRevision: expectedCheckpointRevision,
            total: snapshot.review.candidates.length,
            checked: snapshot.observations.length,
            published: sourceScan().snapshot().published,
          })
        : undefined;
      try {
        const owner = await shared.progressCaptureOwner(snapshot.jobId);
        const input = shared.checkpointCaptureInput(snapshot);
        const prepare = async () => {
          const mutation =
            publicationLimit === 256
              ? await owner.prepareWindowMutation(input, publicationKeys ?? [], signal)
              : await owner.prepareMutation(input, signal);
          if (
            mutation?.kind === 'save' &&
            shared.checkpointCaptureMode === 'version3' &&
            shared.resumedCheckpointFormat?.jobId !== snapshot.jobId &&
            shared.manifestBackedJobId !== snapshot.jobId
          ) {
            const client = await shared.candidateManifestClient(signal);
            if (client)
              shared.pendingManifestSeed = {
                checkpoint: mutation.checkpoint,
                jobId: snapshot.jobId,
                review: snapshot.review,
              };
          }
          if (trace && mutation) shared.publicationTraceByMutation.set(mutation, trace);
          return mutation;
        };
        try {
          return await prepare();
        } catch (failure) {
          if (!isTauri() || !owner.hasPendingPreparation) throw failure;
          if (trace) shared.scanPublicationObserver.step(trace, 'checkpoint-reconcile');
          // A canceled publication may have prepared future keys without writing
          // them. Release that preparation only after an authoritative unchanged
          // storage revision; an uncertain/advanced commit requires reopening.
          await env.catalogWrites;
          signal.throwIfAborted();
          const saved = await readScanCheckpoint();
          signal.throwIfAborted();
          if (
            saved.catalogRevision !== env.persistedCatalogRevision ||
            saved.checkpointRevision !== expectedCheckpointRevision ||
            saved.checkpointStatus === 'invalid' ||
            (saved.checkpointStatus === 'valid' && saved.jobId !== snapshot.jobId)
          )
            throw new Error('Scan progress changed. Reopen the app before continuing.', {
              cause: failure,
            });
          owner.releaseUncommittedPreparation(expectedCheckpointRevision, saved.checkpointRevision);
          return prepare();
        }
      } catch (failure) {
        if (trace)
          shared.scanPublicationObserver.fail(
            trace,
            signal.aborted ? 'canceled' : 'checkpoint-failed',
          );
        throw failure;
      }
    },
    acknowledgeMutation: (mutation, revision) => {
      const trace = shared.publicationTraceByMutation.get(mutation);
      if (trace)
        shared.scanPublicationObserver.step(trace, 'checkpoint-ack', {
          checkpointRevision: revision,
        });
      try {
        if (!shared.checkpointProgressCapture)
          throw new Error('Checkpoint capture owner is unavailable.');
        shared.checkpointProgressCapture.acknowledgeMutation(mutation, revision);
        if (trace) shared.scanPublicationObserver.complete(trace);
      } catch (failure) {
        if (trace) shared.scanPublicationObserver.fail(trace, 'ack-failed');
        throw failure;
      }
    },
    saveMutation: async (mutation, revision, checkpointRevision, signal) => {
      const work = env.catalogWrites.then(async () => {
        signal.throwIfAborted();
        if (revision !== String(env.catalogRevision))
          throw new Error('Saved channels changed. Rescan before continuing.');
        await env.preferences.settledSnapshot();
        signal.throwIfAborted();
        let receipt: CommitReceipt;
        if (
          mutation.kind === 'save' &&
          shared.checkpointCaptureMode === 'version3' &&
          shared.pendingManifestSeed
        ) {
          const seed = shared.pendingManifestSeed;
          if (seed.checkpoint !== mutation.checkpoint)
            throw new Error('Saved scan candidates changed before storage.');
          const client = await shared.candidateManifestClient(signal);
          if (!client) throw new Error('Scan candidate storage is unavailable.');
          receipt = await client.stageAndSeal(
            {
              checkpoint: seed.checkpoint,
              review: seed.review,
              expectedCatalogRevision: env.persistedCatalogRevision,
              expectedCheckpointRevision: checkpointRevision,
            },
            signal,
          );
          // This is the actual durable seal ACK; a subsequent abort cannot revoke it.
          shared.manifestBackedJobId = seed.jobId;
          shared.pendingManifestSeed = undefined;
        } else {
          receipt = await writeScanCheckpointMutation(
            mutation,
            env.persistedCatalogRevision,
            checkpointRevision,
            signal,
          );
        }
        if (receipt.checkpointRevision === undefined)
          throw new Error('Scan progress save was not confirmed.');
        return { committed: true as const, checkpointRevision: receipt.checkpointRevision };
      });
      env.catalogWrites = work.catch(() => undefined);
      return work;
    },
    save: async (text, revision, checkpointRevision, signal) => {
      await env.catalogWrites;
      if (revision !== String(env.catalogRevision))
        throw new Error('Saved channels changed. Rescan before continuing.');
      const receipt = await writeScanCheckpoint(
        text,
        shared.scanStorageRevision,
        checkpointRevision,
        signal,
      );
      if (receipt.checkpointRevision === undefined)
        throw new Error('Scan progress save was not confirmed.');
      return { committed: true as const, checkpointRevision: receipt.checkpointRevision };
    },
    discard: async (jobId, revision, checkpointRevision, signal) => {
      await env.catalogWrites;
      if (revision !== String(env.catalogRevision))
        throw new Error('Saved channels changed. Rescan before continuing.');
      const receipt = await discardScanCheckpoint(
        jobId,
        env.persistedCatalogRevision,
        checkpointRevision,
        signal,
      );
      if (receipt.checkpointRevision === undefined)
        throw new Error('Scan progress reset was not confirmed.');
      shared.checkpointProgressCapture?.reset();
      if (shared.manifestBackedJobId === jobId) shared.manifestBackedJobId = null;
      shared.pendingManifestSeed = undefined;
      return { committed: true as const, checkpointRevision: receipt.checkpointRevision };
    },
  };
}
