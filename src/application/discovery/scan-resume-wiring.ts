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

import { type BoundedScanAck, type BoundedScanRevisions } from './bounded-scan-resume';
import { type Source } from '../../catalog';
import { createScanPublicationProjectionReader } from '../../platform/scan-resume-publication-projection';
import { invoke, isTauri } from '@tauri-apps/api/core';
import {
  createBoundedNativeScanResumeTransport,
  type BoundedScanTransportDiagnostic,
} from '../../platform/bounded-scan-resume';
import {
  createBoundedScanResumeService,
  type BoundedScanServiceDiagnostic,
} from './bounded-scan-resume-service';
import { nativeScanCheckpointSummary } from '../../platform/scan-checkpoint-summary';
import { ScanSourcesChanged, sourcesChangedRefusal } from '../../ui/source-scan-model';
import { type mountApplicationScanScreen } from './scan-screen';
import { type createSlowPassGate } from './slow-pass-gate';
import { type createPlaybackProbeGate } from '../health/playback-probe-gate';
import {
  BoundedScanEntryRefusal,
  type BoundedRootStage,
  type ScanEnvironment,
} from './scan-controller';

/** What this part reads from, and writes back to, createScanController. */
export interface ScanResumeWiringShared {
  readonly automaticScanActive: boolean;
  readonly scanBatchThrottle: {
    listed: number;
    guidePending: boolean;
    startedMs: number;
    listPending: boolean;
  };
  readonly SCAN_LIST_BATCH: number;
  readonly sourceScan: ReturnType<typeof mountApplicationScanScreen>['sourceScan'];
  readonly slowPassGate: ReturnType<typeof createSlowPassGate>;
  readonly scanProbeGate: ReturnType<typeof createPlaybackProbeGate>;
  scanStorageRevision: string;
}

/**
 * Resuming a bounded scan from the application: publication sync, the
 * inline scan entry and the bounded resume service. Part of
 * createScanController.
 */
export function createScanResumeWiring(env: ScanEnvironment, shared: ScanResumeWiringShared) {
  // The native capability stays disabled until the complete runtime has been admitted.
  const boundedScanPublicationSync: {
    current:
      | ((
          context: {
            planId: string;
            previousRevisions: BoundedScanRevisions;
            receipt: BoundedScanAck;
            expectedPreferenceSources: readonly Source[];
          },
          signal: AbortSignal,
        ) => Promise<void>)
      | null;
  } = { current: null };
  const readBoundedPublicationProjection = createScanPublicationProjectionReader({ invoke });
  boundedScanPublicationSync.current = async (context, signal) => {
    const base = env.catalog;
    const current = () =>
      env.catalog === base && env.persistedCatalogRevision === context.receipt.catalogRevision;
    const projection = await readBoundedPublicationProjection(
      context.receipt,
      base.sources,
      signal,
    );
    signal.throwIfAborted();
    if (!current()) throw new Error('Saved channels changed before publication adoption.');
    const sourceMap = new Map(base.sources.map((source) => [source.id, source]));
    for (const source of projection.sources) sourceMap.set(source.id, source);
    if (sourceMap.size > 100) throw new Error('Saved source projection exceeds its bound.');
    const indices = new Map(projection.channels.map((channel) => [channel.id, -1]));
    for (let i = 0; projection.channels.length && i < base.channels.length; i++) {
      const channel = base.channels[i]!;
      if (indices.has(channel.id)) indices.set(channel.id, i);
    }
    let additions = 0;
    for (const channel of projection.channels) {
      const index = indices.get(channel.id)!;
      if (index < 0) additions++;
      else if (base.channels[index]!.sourceId !== channel.sourceId)
        throw new Error('Saved channel identity changed source.');
    }
    if (base.channels.length + additions > 100000)
      throw new Error('Saved channel projection exceeds its bound.');
    // Preserve old capture arrays; clone only pointers, not the existing channel object graph.
    const channels = projection.channels.length ? base.channels.slice() : base.channels;
    for (const channel of projection.channels) {
      const index = indices.get(channel.id)!;
      if (index < 0) channels.push(channel);
      else channels[index] = channel;
    }
    const sources = [...sourceMap.values()];
    // Even a health-only/no-source-change receipt must not adopt across a queued source revoke/edit.
    const adoptedSources = await env.preferences.adoptAcknowledgedSources(
      projection.sources,
      context.expectedPreferenceSources,
      current,
    );
    if (!current()) throw new Error('Saved channels changed before publication adoption.');
    env.catalogRevision++;
    if (!projection.channels.length && !projection.sources.length) return;
    env.catalog = { ...base, sources, channels };
    if (projection.sources.length) env.settings = { ...env.settings, sources: [...adoptedSources] };
    env.catalogBrowseViewRevision++;
    if (!env.applicationClosing) {
      if (projection.sources.length) env.renderCatalog();
      else if (shared.automaticScanActive) {
        // Owner rule (October 21, 2026): while a scan runs the list refreshes
        // only after 300 new channels, and the guide waits for the scan's end
        // (flushScanBatchWork). A page the list scrolls into later re-reads
        // itself if the catalog has moved on (catalog-window.ts).
        shared.scanBatchThrottle.listPending = true;
        if (
          env.catalog.channels.length - shared.scanBatchThrottle.listed >=
          shared.SCAN_LIST_BATCH
        ) {
          shared.scanBatchThrottle.listed = env.catalog.channels.length;
          env.browser.search(env.element<HTMLInputElement>('search').value);
        }
        return;
      } else {
        // Existing indexed apply reads the new revision/window; it does not rebuild all search metadata.
        env.browser.search(env.element<HTMLInputElement>('search').value);
        env.guide.catalogChanged();
        env.geographyControls.update();
      }
      env.updateVisibleGuide();
    }
  };
  let boundedResumeCapability: Promise<boolean> | null = null;
  let indexedFreshAvailable = false;
  let boundedScanGeneration = 0;
  let boundedRootDiagnostic: Readonly<{
    stage: BoundedRootStage;
    catalogMatches: boolean;
    importRunning: boolean;
    transferBusy: boolean;
    closing: boolean;
  }> | null = null;
  let boundedTransportDiagnostic: Readonly<BoundedScanTransportDiagnostic> | null = null;
  let boundedTransportFailure: Readonly<BoundedScanTransportDiagnostic> | null = null;
  let boundedTransportFailures = new Map<string, Readonly<BoundedScanTransportDiagnostic>>();
  let boundedServiceDiagnostic: Readonly<BoundedScanServiceDiagnostic> | null = null;
  let boundedServiceFailure: Readonly<BoundedScanServiceDiagnostic> | null = null;
  let boundedServiceFailures = new Map<string, Readonly<BoundedScanServiceDiagnostic>>();
  Object.defineProperty(window, '__GENX_BOUNDED_SCAN__', {
    get: () =>
      Object.freeze({
        schemaVersion: 1,
        generation: boundedScanGeneration,
        root: boundedRootDiagnostic,
        transport: boundedTransportDiagnostic,
        transportFailure: boundedTransportFailure,
        transportFailures: Object.freeze([...boundedTransportFailures.values()]),
        service: boundedServiceDiagnostic,
        serviceFailure: boundedServiceFailure,
        serviceFailures: Object.freeze([...boundedServiceFailures.values()]),
      }),
    configurable: false,
  });
  function supportsBoundedResume(signal: AbortSignal): Promise<boolean> {
    if (!isTauri()) return Promise.resolve(false);
    if (boundedResumeCapability) return boundedResumeCapability;
    const transport = createBoundedNativeScanResumeTransport({
      runtime: { invoke },
      currentFence: () => ({
        expectedCatalogRevision: env.persistedCatalogRevision,
        expectedCheckpointRevision: '0',
      }),
    });
    const pending = transport
      .capabilities(signal)
      .then((supported) => {
        indexedFreshAvailable = supported;
        return supported;
      })
      .catch((error) => {
        if (boundedResumeCapability === pending) boundedResumeCapability = null;
        throw error;
      });
    boundedResumeCapability = pending;
    return pending;
  }
  async function prepareInlineScanEntry(signal: AbortSignal) {
    if (shared.sourceScan.snapshot().busy) return 'running' as const;
    let supported: boolean;
    try {
      supported = await supportsBoundedResume(signal);
    } catch {
      signal.throwIfAborted();
      throw new BoundedScanEntryRefusal();
    }
    if (!supported) return shared.sourceScan.prepareAutomaticEntry();
    let summary: Awaited<ReturnType<typeof nativeScanCheckpointSummary.read>>;
    try {
      summary = await nativeScanCheckpointSummary.read(signal);
    } catch {
      signal.throwIfAborted();
      throw new BoundedScanEntryRefusal();
    }
    signal.throwIfAborted();
    if (summary.checkpointStatus === 'valid' && summary.storedVersion !== 3)
      return shared.sourceScan.prepareAutomaticEntry();
    // Structural saved-state only. Continue still performs full native admission in its owner.
    shared.sourceScan.presentSavedSummary(summary, shared.sourceScan.snapshot().generation);
    return summary.checkpointStatus === 'absent'
      ? ('fresh' as const)
      : summary.checkpointStatus !== 'valid'
        ? ('unavailable' as const)
        : summary.unfinished
          ? ('unfinished' as const)
          : ('completed' as const);
  }
  async function createApplicationBoundedResume(
    scope: { jobId: string | null; checkpointRevision?: string; query?: string; slow?: boolean },
    signal: AbortSignal,
  ) {
    if (!(await supportsBoundedResume(signal))) return null;
    await env.catalogWrites;
    await env.preferences.settledSources();
    signal.throwIfAborted();
    if (env.applicationClosing) throw new DOMException('Scan entry canceled.', 'AbortError');
    const summary = await nativeScanCheckpointSummary.read(signal);
    signal.throwIfAborted();
    if (summary.checkpointStatus === 'valid' && summary.storedVersion !== 3) return null;
    if (
      summary.checkpointStatus === 'valid' &&
      summary.catalogRevision !== env.persistedCatalogRevision
    )
      throw new ScanSourcesChanged();
    if (
      summary.checkpointStatus !== 'valid' ||
      summary.storedVersion !== 3 ||
      (scope.checkpointRevision !== undefined &&
        scope.checkpointRevision !== summary.checkpointRevision)
    )
      throw new Error('Saved scan progress is unavailable for Continue.');
    const synchronize = boundedScanPublicationSync.current;
    if (!synchronize) throw new Error('Bounded scan publication is unavailable.');
    const diagnosticGeneration = ++boundedScanGeneration;
    boundedTransportDiagnostic = boundedTransportFailure = null;
    boundedServiceDiagnostic = boundedServiceFailure = null;
    boundedTransportFailures = new Map();
    boundedServiceFailures = new Map();
    const recordRoot = (stage: BoundedRootStage, expected = env.persistedCatalogRevision) => {
      if (diagnosticGeneration !== boundedScanGeneration) return;
      boundedRootDiagnostic = Object.freeze({
        stage,
        catalogMatches: expected === env.persistedCatalogRevision,
        importRunning: env.importRunning,
        transferBusy: env.transferBusy,
        closing: env.applicationClosing,
      });
    };
    recordRoot('created');
    const transport = createBoundedNativeScanResumeTransport({
      runtime: { invoke },
      onDiagnostic: (event) => {
        if (diagnosticGeneration !== boundedScanGeneration) return;
        boundedTransportDiagnostic = event;
        if (event.code !== null) {
          boundedTransportFailure = event;
          boundedTransportFailures.set(event.command, event);
        }
      },
      currentFence: () => ({
        expectedCatalogRevision: summary.catalogRevision,
        expectedCheckpointRevision: summary.checkpointRevision,
      }),
    });
    let quarantined = false;
    let acknowledgedCounts: BoundedScanAck['counts'] | null = null;
    const current = () => {
      if (quarantined || env.applicationClosing)
        throw new Error('Scan publication synchronization is unavailable.');
    };
    const host = {
      ...transport.host,
      admit: async (...args: Parameters<typeof transport.host.admit>) => {
        // Window negotiation belongs to this episode's transport, not the entry capability cache.
        if (!(await transport.capabilities(args[0])))
          throw new Error('Native scan support changed. Reopen the app before continuing.');
        args[0].throwIfAborted();
        const plan = await transport.host.admit(...args).catch((error: unknown) => {
          throw sourcesChangedRefusal(boundedTransportFailure?.code, error);
        });
        if (scope.jobId !== null && scope.jobId !== plan.jobId) {
          await transport.host.close(plan.planId);
          throw Object.assign(new Error('Saved scan ownership changed before Continue.'), {
            name: 'ScanAdmissionClosedError',
          });
        }
        acknowledgedCounts = { ...plan.counts };
        return plan;
      },
      take: (...args: Parameters<typeof transport.host.take>) => {
        current();
        return transport.host.take(...args);
      },
      probe: (...args: Parameters<typeof transport.host.probe>) => {
        current();
        return (scope.slow ? shared.slowPassGate : shared.scanProbeGate).run(() => {
          current();
          return transport.host.probe(...args);
        }, args[1]);
      },
      commit: (
        planId: string,
        request: Parameters<typeof transport.host.commit>[1],
        commitSignal: AbortSignal,
      ) => {
        recordRoot('commit-queued', request.expectedRevisions.catalogRevision);
        const pending = env.catalogWrites.then(async () => {
          recordRoot('commit-entered', request.expectedRevisions.catalogRevision);
          current();
          commitSignal.throwIfAborted();
          if (
            request.expectedRevisions.catalogRevision !== env.persistedCatalogRevision ||
            env.importRunning ||
            env.transferBusy
          ) {
            recordRoot('root-admission-refused', request.expectedRevisions.catalogRevision);
            throw new Error('Saved channels changed. Continue the scan again.');
          }
          const expectedPreferenceSources = await env.preferences.settledSources();
          recordRoot('preferences-settled', request.expectedRevisions.catalogRevision);
          current();
          commitSignal.throwIfAborted();
          if (request.expectedRevisions.catalogRevision !== env.persistedCatalogRevision)
            throw new Error('Saved channels changed. Continue the scan again.');
          recordRoot('native-commit', request.expectedRevisions.catalogRevision);
          const receipt = await transport.host.commit(planId, request, commitSignal);
          recordRoot('native-acknowledged');
          const sameIndices = (a: readonly number[], b: readonly number[]) =>
            a.length === b.length &&
            new Set(a).size === a.length &&
            a.every((index) => b.includes(index));
          if (
            !acknowledgedCounts ||
            receipt.counts.total !== acknowledgedCounts.total ||
            receipt.counts.checked < acknowledgedCounts.checked ||
            receipt.counts.checked > acknowledgedCounts.checked + request.observations.length ||
            receipt.counts.responded < acknowledgedCounts.responded ||
            receipt.counts.responded > acknowledgedCounts.responded + request.observations.length ||
            receipt.counts.published !==
              acknowledgedCounts.published + request.publicationIndices.length ||
            BigInt(receipt.catalogRevision) < BigInt(request.expectedRevisions.catalogRevision) ||
            BigInt(receipt.catalogRevision) >
              BigInt(request.expectedRevisions.catalogRevision) + 1n ||
            BigInt(receipt.healthRevision) < BigInt(request.expectedRevisions.healthRevision) ||
            BigInt(receipt.healthRevision) >
              BigInt(request.expectedRevisions.healthRevision) + 1n ||
            BigInt(receipt.checkpointRevision) !==
              BigInt(request.expectedRevisions.checkpointRevision) + 1n ||
            !sameIndices(
              receipt.acknowledgedIndices,
              request.observations.map((entry) => entry.candidateIndex),
            ) ||
            !sameIndices(receipt.publicationIndices, request.publicationIndices)
          ) {
            quarantined = true;
            throw new Error(
              'Saved scan receipt could not be confirmed. Reopen the app before continuing.',
            );
          }
          acknowledgedCounts = { ...receipt.counts };
          // A durable receipt remains true even if postcommit projection/adoption fails.
          env.persistedCatalogRevision = receipt.catalogRevision;
          shared.scanStorageRevision = receipt.catalogRevision;
          try {
            await synchronize(
              {
                planId,
                previousRevisions: request.expectedRevisions,
                receipt,
                expectedPreferenceSources,
              },
              new AbortController().signal,
            );
            queueMicrotask(() => {
              if (!env.applicationClosing)
                void env.automaticGuides
                  .request()
                  .catch(() =>
                    env.notice(
                      'Channels saved. Some program guides could not connect; open Guide to retry.',
                    ),
                  );
            });
          } catch {
            recordRoot('projection-refused');
            quarantined = true;
            env.notice('Channels were saved. Reopen the app before continuing this scan.');
            void env.diagnostics.emit({ operation: 'scan', level: 'warning', code: 'scan-failed' });
          }
          return receipt;
        });
        env.catalogWrites = pending.then(
          () => undefined,
          () => undefined,
        );
        return pending;
      },
    };
    return createBoundedScanResumeService(host, {
      signal,
      onDiagnostic: (event) => {
        if (diagnosticGeneration !== boundedScanGeneration) return;
        boundedServiceDiagnostic = event;
        if (!['host-dispatch'].includes(event.stage)) {
          boundedServiceFailure = event;
          boundedServiceFailures.set(event.operation, event);
        }
      },
    });
  }
  return {
    createApplicationBoundedResume,
    get indexedFreshAvailable() {
      return indexedFreshAvailable;
    },
    supportsBoundedResume,
    prepareInlineScanEntry,
  };
}
