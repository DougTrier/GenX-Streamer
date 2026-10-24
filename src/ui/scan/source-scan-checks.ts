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

import { type ScanCheckpointMutation } from '../../discovery/scan-checkpoint';
import {
  scanReconciliationScopes,
  stageScanSelection,
  type ReviewCandidate,
  type ScanReview,
  type ScanSource,
  type StagedScanSelection,
} from '../../discovery/scan';
import { type HealthObservation } from '../../discovery/health';
import { createScanPublisher } from '../../discovery/scan-publisher';
import { checkOwnedScanCandidates, checkScanCandidates } from '../../discovery/automatic-check';
import {
  createCollectionPipeline,
  type GuideEnrichment,
  type PipelineReview,
} from '../../discovery/pipeline';
import { type ReviewedScanHealthContext } from '../../discovery/prepare-selection';
import {
  SourceScanWindowSizeError,
  freezeCapture,
  type HealthCheckBudgetMs,
  type ScanCheckpointCommitContext,
  type SourceScanHost,
  type SourceScanPublicationChunk,
  type SourceScanSelectionEpisode,
  type SourceScanSnapshot,
} from './source-scan-model';

/** What this part reads from, and writes back to, mountSourceScan. */
export interface ScanChecksEnvironment {
  readonly host: SourceScanHost;
  readonly checkpoint: {
    review: ScanReview;
    expectedRevision: string;
    observations: Map<string, HealthObservation>;
    published: Set<string>;
    platform: string | null;
    profile: string | undefined;
    jobId: string;
    createdAtMs: number;
    budgetMs: HealthCheckBudgetMs;
  } | null;
  durableCheckpointAvailable: boolean;
  readonly capturedSources: readonly ScanSource[];
  checkpointRevision: string;
  readonly error: HTMLParagraphElement;
  readonly closed: boolean;
  storedJobId: string | null;
  readonly recordFailure: (failure: unknown, publication?: boolean) => void;
  scanPhase: SourceScanSnapshot['phase'];
  scanTotal: number;
  readonly automaticMode: boolean;
  automaticChecksComplete: boolean;
  readonly checkBudget: HTMLSelectElement;
  healthScope: {
    platform: string;
    observerProfile: string;
    budgetMs: HealthCheckBudgetMs;
  } | null;
  readonly owner: number;
  pendingPublications: number;
  windowRetryLimit: 64 | 256;
  readonly publish: (
    staged: StagedScanSelection,
    revision: string,
    signal: AbortSignal,
    health?: ReviewedScanHealthContext | undefined,
    checkpoint?: ScanCheckpointCommitContext | undefined,
    episodeId?: string | undefined,
  ) => Promise<{ committed: true; revision: string; checkpointRevision?: string }>;
  scanPublished: number;
  readonly notifyProgress: () => void;
  readonly controller: AbortController | null;
  scanChecked: number;
  scanResponded: number;
  readonly health: Map<string, HealthObservation>;
  readonly status: HTMLParagraphElement;
  readonly selected: Set<string>;
  readonly busy: boolean;
  readonly stopWork: Promise<void> | null;
  readonly suspension: Promise<void> | null;
  review: ScanReview | null;
  readonly begin: (
    admissionOnly?: boolean,
    preserveCounts?: boolean,
  ) => { signal: AbortSignal; generation: number };
  work: Promise<void>;
  readonly finish: (generation: number, admissionOnly?: boolean) => void;
  pipelineReview: PipelineReview | null;
  readonly guideSuggestions: Map<string, GuideEnrichment[]>;
}

/**
 * Checking found channels: saving the scan checkpoint, checking captured
 * candidates, the guide review and the scan pipeline. Part of
 * mountSourceScan.
 */
export function createScanChecks(env: ScanChecksEnvironment) {
  async function prepareCheckpointMutation(
    signal: AbortSignal,
    publishedKeys?: string[],
    publicationLimit: 64 | 256 = 64,
    publicationKeys?: readonly string[],
  ): Promise<ScanCheckpointMutation | null> {
    if (!env.host.checkpoint || !env.checkpoint || !env.durableCheckpointAvailable) return null;
    if (!env.checkpoint.platform || !env.checkpoint.profile) return null;
    const snapshot = {
      jobId: env.checkpoint.jobId,
      createdAtMs: env.checkpoint.createdAtMs,
      review: env.checkpoint.review,
      capturedSources: structuredClone(env.capturedSources),
      budgetMs: env.checkpoint.budgetMs,
      platform: env.checkpoint.platform,
      observerProfile: env.checkpoint.profile,
      observations: [...env.checkpoint.observations.values()],
      publishedKeys: publishedKeys ?? [...env.checkpoint.published],
      catalogRevision: env.checkpoint.expectedRevision,
    };
    const mutation =
      env.host.checkpoint.prepareMutation && env.host.checkpoint.saveMutation
        ? await env.host.checkpoint.prepareMutation(
            snapshot,
            signal,
            env.checkpointRevision,
            publicationLimit,
            publicationKeys,
          )
        : await env.host.checkpoint
            .prepare(snapshot, signal)
            .then((text) => (text === null ? null : { kind: 'save' as const, checkpoint: text }));
    signal.throwIfAborted();
    if (mutation === null) {
      env.durableCheckpointAvailable = false;
      env.error.textContent =
        'This scan can resume while the app stays open; restart requires Rescan.';
    }
    return mutation;
  }
  async function persistCheckpoint(actualSignal?: AbortSignal): Promise<void> {
    // Native closing has frozen new admission. Previously acknowledged progress
    // remains authoritative; never-acknowledged checks can be repeated on Continue.
    if (env.closed || !env.host.checkpoint || !env.checkpoint || !env.durableCheckpointAvailable)
      return;
    try {
      const signal = actualSignal ?? new AbortController().signal;
      let mutation: ScanCheckpointMutation | null;
      try {
        mutation = await prepareCheckpointMutation(signal);
      } catch (failure) {
        // Close freezes new native admission. This preparation has actually
        // settled; retain the last ACK rather than launching any new write.
        // Dispatched saves and earlier work joins remain outside this handler.
        if (env.closed) return;
        throw failure;
      }
      if (env.closed || mutation === null) return;
      const receipt = env.host.checkpoint.saveMutation
        ? await env.host.checkpoint.saveMutation(
            mutation,
            env.checkpoint.expectedRevision,
            env.checkpointRevision,
            signal,
          )
        : await env.host.checkpoint.save(
            mutation.kind === 'save'
              ? mutation.checkpoint
              : (() => {
                  throw new Error('Checkpoint mutation is unsupported.');
                })(),
            env.checkpoint.expectedRevision,
            env.checkpointRevision,
            signal,
          );
      if (receipt.committed !== true || !receipt.checkpointRevision)
        throw new Error('Missing checkpoint receipt');
      env.checkpointRevision = receipt.checkpointRevision;
      env.host.checkpoint.acknowledgeMutation?.(mutation, receipt.checkpointRevision);
      env.storedJobId = env.checkpoint.jobId;
    } catch (failure) {
      env.recordFailure(failure);
      const message = 'Saved scan could not be updated. Existing channels retained.';
      env.error.textContent = message;
      throw new Error(message, { cause: failure });
    }
  }
  async function checkCaptured(
    captured: ScanReview,
    task: { signal: AbortSignal; generation: number },
    preselect: boolean,
  ): Promise<void> {
    env.scanPhase = 'checking';
    env.scanTotal = captured.candidates.length;
    if (env.automaticMode && captured.candidates.length === 0) {
      env.automaticChecksComplete = true;
      automaticCompletion(captured, 0);
      return;
    }
    const budgetMs =
      env.automaticMode && env.checkpoint
        ? env.checkpoint.budgetMs
        : (Number(env.checkBudget.value) as HealthCheckBudgetMs);
    if (![20000, 45000, 60000].includes(budgetMs)) throw new Error('Channel check time invalid');
    const platform = env.host.platform?.() ?? 'browser-local';
    const observerProfile = env.host.observerProfile?.(budgetMs);
    if (
      !platform ||
      platform === 'native-unavailable' ||
      (observerProfile !== undefined && (!observerProfile.trim() || observerProfile.length > 256))
    )
      throw new Error('Channel check platform unavailable');
    if (observerProfile) env.healthScope = { platform, observerProfile, budgetMs };
    const retained = env.automaticMode ? env.checkpoint : null;
    if (
      retained &&
      (retained.review.sessionRevision !== captured.sessionRevision ||
        env.host.revision() !== retained.expectedRevision ||
        (retained.platform !== null &&
          (retained.platform !== platform || retained.profile !== observerProfile)))
    )
      throw new Error('Scan checkpoint changed');
    if (retained) {
      retained.platform = platform;
      retained.profile = observerProfile;
      if (env.storedJobId !== retained.jobId) {
        // The initial admitted collection must survive a crash before the first publication.
        await persistCheckpoint(task.signal);
        task.signal.throwIfAborted();
        if (env.closed || task.generation !== env.owner || env.checkpoint !== retained)
          throw new Error('Scan changed');
      }
    }
    let expectedRevision = retained?.expectedRevision ?? captured.sessionRevision;
    let published = retained?.published.size ?? 0;
    // Capture variant ambiguity once for the full review, not just each publication batch.
    const reconciliationScopes = scanReconciliationScopes(captured);
    let episode: SourceScanSelectionEpisode | null = null;
    try {
      if (env.automaticMode && env.host.beginSelectionEpisode) {
        episode = await env.host.beginSelectionEpisode(
          {
            generation: task.generation,
            revision: expectedRevision,
            capturedSources: env.capturedSources,
            reconciliationScopes,
          },
          task.signal,
        );
        task.signal.throwIfAborted();
        if (env.closed || task.generation !== env.owner || env.host.revision() !== expectedRevision)
          throw new Error('Scan changed');
        if (episode && (!episode.episodeId.trim() || episode.episodeId.length > 256))
          throw new Error('Selection episode unavailable');
      }

      type Entry = { candidate: ReviewCandidate; observation: HealthObservation };
      const useWindow = !!env.host.commitWindow && episode?.supportsWindow === true;
      const flush = async (batch: readonly Entry[]): Promise<void> => {
        task.signal.throwIfAborted();
        if (env.closed || task.generation !== env.owner || env.host.revision() !== expectedRevision)
          throw new Error('Scan changed');
        if (
          env.healthScope &&
          (env.host.platform?.() !== env.healthScope.platform ||
            env.host.observerProfile?.(env.healthScope.budgetMs) !==
              env.healthScope.observerProfile)
        )
          throw new Error('Health observer changed');

        const chunks: SourceScanPublicationChunk[] = [];
        for (let offset = 0; offset < batch.length; offset += 64) {
          const entries = batch.slice(offset, offset + 64);
          const candidates = entries.map(({ candidate }) => ({
            ...candidate,
            sessionRevision: expectedRevision,
          }));
          const rebased = { ...captured, sessionRevision: expectedRevision, candidates };
          chunks.push({
            staged: stageScanSelection(
              rebased,
              candidates.map((candidate) => candidate.key),
              expectedRevision,
              reconciliationScopes,
            ),
            ...(env.healthScope
              ? {
                  health: structuredClone({
                    ...env.healthScope,
                    candidates,
                    observations: entries.map((entry) => entry.observation),
                  }),
                }
              : {}),
          });
        }
        const checkpointMutation = await prepareCheckpointMutation(
          task.signal,
          retained
            ? [...retained.published, ...batch.map((entry) => entry.candidate.key)]
            : undefined,
          useWindow ? 256 : 64,
          useWindow ? batch.map((entry) => entry.candidate.key) : undefined,
        );
        const checkpointContext =
          checkpointMutation === null
            ? undefined
            : {
                mutation: checkpointMutation,
                expectedCheckpointRevision: env.checkpointRevision,
              };
        let receipt: { committed: true; revision: string; checkpointRevision?: string };
        if (useWindow) {
          env.pendingPublications++;
          try {
            receipt = await env.host.commitWindow!(
              chunks,
              expectedRevision,
              task.signal,
              checkpointContext,
              episode?.episodeId,
            );
          } catch (failure) {
            if (failure instanceof SourceScanWindowSizeError) env.windowRetryLimit = 64;
            env.recordFailure(failure, true);
            throw failure;
          } finally {
            env.pendingPublications--;
          }
        } else {
          receipt = await env.publish(
            chunks[0]!.staged,
            expectedRevision,
            task.signal,
            chunks[0]!.health,
            checkpointContext,
            episode?.episodeId,
          );
        }
        if (receipt.committed !== true || !receipt.revision.trim())
          throw new Error('Missing durable receipt');
        if (checkpointContext) {
          if (!receipt.checkpointRevision) throw new Error('Missing checkpoint receipt');
          env.checkpointRevision = receipt.checkpointRevision;
          env.host.checkpoint?.acknowledgeMutation?.(
            checkpointContext.mutation,
            receipt.checkpointRevision,
          );
          env.storedJobId = retained!.jobId;
        }
        expectedRevision = receipt.revision;
        if (retained) {
          retained.expectedRevision = expectedRevision;
          for (const entry of batch) retained.published.add(entry.candidate.key);
        }
        env.scanPublished += batch.length;
        if (env.host.revision() !== expectedRevision) throw new Error('Scan changed');
        published += batch.length;
        env.notifyProgress();
      };
      const publisher = env.automaticMode
        ? createScanPublisher<Entry>({
            signal: task.signal,
            publish: flush,
            ...(useWindow
              ? {
                  capacity: 256,
                  initialBatchSize: 64,
                  maxBatchSize: env.windowRetryLimit,
                  // Reserve repeated candidate/health DTOs and per-entry wire framing.
                  sizeOf: (entry: Entry) =>
                    new TextEncoder().encode(JSON.stringify(entry)).byteLength * 4 + 4096,
                  maxBytes: 20 * 1024 * 1024,
                }
              : {}),
            failed: (failure) => {
              env.recordFailure(failure, true);
              env.controller?.abort();
            },
          })
        : null;
      const onObservation = publisher
        ? async (candidate: ReviewCandidate, observation: HealthObservation): Promise<void> => {
            task.signal.throwIfAborted();
            if (env.closed || task.generation !== env.owner) throw new Error('Scan changed');
            // Refused/canceled evidence is visible health, not a settled checkpoint result.
            // Continue must recheck it rather than advancing past an untrusted observation.
            if (!['NotChecked', 'Canceled'].includes(observation.verdict))
              retained?.observations.set(candidate.key, freezeCapture(observation));
            if (['Reachable', 'PlayedHere'].includes(observation.verdict))
              await publisher.push({ candidate, observation });
          }
        : undefined;
      let checked: Awaited<ReturnType<typeof checkScanCandidates>>;
      try {
        if (publisher && retained)
          for (const candidate of captured.candidates) {
            const observation = retained.observations.get(candidate.key);
            if (
              observation &&
              !retained.published.has(candidate.key) &&
              ['Reachable', 'PlayedHere'].includes(observation.verdict)
            )
              await publisher.push({ candidate, observation });
          }
        const remaining = retained
          ? {
              ...captured,
              candidates: captured.candidates.filter(
                (candidate) => !retained.observations.has(candidate.key),
              ),
            }
          : captured;
        const alreadyChecked = retained?.observations.size ?? 0;
        const alreadyResponded = retained
          ? [...retained.observations.values()].filter((observation) =>
              ['Reachable', 'PlayedHere'].includes(observation.verdict),
            ).length
          : 0;
        env.scanChecked = alreadyChecked;
        env.scanResponded = alreadyResponded;
        if (retained) {
          // The filtered array/wrapper are new; their children belong to the frozen capture.
          Object.freeze(remaining.candidates);
          Object.freeze(remaining);
        }
        const checker = retained ? checkOwnedScanCandidates : checkScanCandidates;
        checked = await checker(remaining, {
          probe: (candidate, signal, budget) => env.host.probe!(candidate, signal, budget),
          platform,
          budgetMs,
          maxConcurrency: env.automaticMode ? 16 : 4,
          sourcePolicies: env.capturedSources.map(({ source, fingerprint }) => ({
            sourceId: source.id,
            fingerprint,
            allowHttp: source.allowHttp === true,
          })),
          onObservation,
          signal: task.signal,
          now: env.host.now,
          progress: (event) => {
            if (env.closed || task.generation !== env.owner || task.signal.aborted) return;
            if (event.observation)
              env.health.set(
                event.observation.channelId,
                retained?.observations.get(event.observation.channelId) ?? event.observation,
              );
            env.scanChecked = alreadyChecked + event.done;
            env.scanResponded = alreadyResponded + event.responded;
            env.status.textContent = `Checking ${alreadyChecked + event.done} of ${captured.candidates.length} channels \u00b7 ${alreadyResponded + event.responded} responded`;
            env.notifyProgress();
          },
        });
      } catch (failure) {
        // A scan-wide check failure stops queued publication; active native work is still joined below.
        env.controller?.abort();
        throw failure;
      } finally {
        await publisher?.drain();
      }
      task.signal.throwIfAborted();
      if (env.closed || task.generation !== env.owner || env.host.revision() !== expectedRevision)
        throw new Error('Scan changed');
      for (const observed of retained?.observations.values() ?? checked.observations)
        env.health.set(observed.channelId, observed);
      if (preselect) {
        env.selected.clear();
        for (const observed of retained?.observations.values() ?? checked.observations)
          if (['Reachable', 'PlayedHere'].includes(observed.verdict))
            env.selected.add(observed.channelId);
      }
      env.automaticChecksComplete = true;
      if (env.automaticMode) {
        automaticCompletion(captured, published);
        return;
      }
      env.status.textContent = `${checked.eligibleKeys.length} channels responded. ${captured.candidates.length - checked.eligibleKeys.length} could not be verified. Save to add the responding channels.`;
    } finally {
      await episode?.dispose();
    }
  }
  function automaticCompletion(captured: ScanReview, published: number): void {
    const failed = captured.counts.failedSources;
    const unfinished =
      env.checkpoint !== null && env.checkpoint.observations.size < captured.candidates.length;
    if (unfinished) {
      env.automaticChecksComplete = false;
      env.scanPhase = 'paused';
      env.scanChecked = env.checkpoint!.observations.size;
      env.scanResponded = 0;
      for (const observation of env.checkpoint!.observations.values())
        if (observation.verdict === 'Reachable' || observation.verdict === 'PlayedHere')
          env.scanResponded++;
      env.status.textContent = `Scan paused. ${env.scanPublished} channels saved. Finish scan to retry unfinished checks.`;
      env.error.textContent =
        'Some checks were not confirmed. Finish scan to retry unfinished channels. Your saved channels are retained.';
    } else
      env.status.textContent = !captured.candidates.length
        ? 'No channels were collected. Nothing was added.'
        : published === 0
          ? 'No channels responded. Nothing was added.'
          : `${published} ${published === 1 ? 'channel' : 'channels'} saved.`;
    if (failed) {
      const message = `${captured.candidates.length} channels collected. ${failed} of ${captured.sources.length} sources could not be read. Your saved channels were retained. Select Rescan to retry.`;
      env.error.textContent = [message, env.error.textContent].filter(Boolean).join(' ');
    } else if (!captured.candidates.length) {
      env.error.textContent =
        'No supported channels were found. Your saved channels were retained. Select Rescan to retry.';
    }
  }
  function runCheck(): void {
    if (env.busy || env.stopWork || env.suspension || !env.review || !env.host.probe || env.closed)
      return;
    const captured = {
      ...env.review,
      candidates: env.review.candidates.filter((candidate) => env.selected.has(candidate.key)),
    };
    const task = env.begin();
    env.automaticChecksComplete = false;
    env.work = (async () => {
      try {
        await checkCaptured(captured, task, false);
      } catch (failure) {
        env.recordFailure(failure);
        if (!env.closed)
          env.error.textContent = task.signal.aborted
            ? 'Checks canceled. Completed observations retained; rescan before saving.'
            : 'Checks could not finish. Existing channels retained.';
      } finally {
        env.finish(task.generation);
      }
    })();
  }
  function runGuideReview(): void {
    if (env.busy || env.closed || !env.review || !env.host.guides || !env.host.enrich) return;
    const candidates = env.review.candidates.filter((candidate) => env.selected.has(candidate.key));
    if (candidates.length > 1000) {
      env.error.textContent =
        'Choose up to 1,000 channels for this optional guide-suggestion action. The full channel scan is retained.';
      return;
    }
    const captured = env.review;
    const task = env.begin();
    env.status.textContent = 'Optional guide suggestions: this action has a two-minute budget.';
    env.work = (async () => {
      try {
        const checked = await runPipeline(
          env.capturedSources,
          candidates.map((candidate) => candidate.key),
          task.signal,
          captured.query,
          captured.sessionRevision,
          candidates,
          Number(env.checkBudget.value) as HealthCheckBudgetMs,
        );
        if (env.closed || task.generation !== env.owner) return;
        env.pipelineReview = checked;
        if (checked.publishable) {
          env.review = checked.scan;
          for (const observation of checked.observations)
            env.health.set(observation.channelId, observation);
        }
        indexSuggestions();
        env.status.textContent = checked.publishable
          ? 'Guide suggestions ready. Confirm them in Guide before use.'
          : 'Guide suggestions incomplete. Existing channels retained.';
      } catch (failure) {
        env.recordFailure(failure);
        if (!env.closed)
          env.error.textContent = 'Guide suggestions could not finish. Existing channels retained.';
      } finally {
        env.finish(task.generation);
      }
    })();
  }
  function indexSuggestions(): void {
    env.guideSuggestions.clear();
    for (const suggestion of env.pipelineReview?.enrichment ?? []) {
      const values = env.guideSuggestions.get(suggestion.candidateKey) ?? [];
      values.push(suggestion);
      env.guideSuggestions.set(suggestion.candidateKey, values);
    }
  }
  async function runPipeline(
    sources: readonly ScanSource[],
    checks: readonly string[],
    signal: AbortSignal,
    queryText: string,
    expectedRevision: string,
    expectedCandidates?: readonly ReviewCandidate[],
    budgetMs: HealthCheckBudgetMs = 20000,
  ): Promise<PipelineReview> {
    const guides = await env.host.guides!(signal);
    signal.throwIfAborted();
    if (env.host.revision() !== expectedRevision)
      throw new Error('Collection snapshot is obsolete.');
    const platform = env.host.platform?.() ?? 'This platform';
    const pipeline = createCollectionPipeline({
      collect: (source, ownedSignal) => env.host.collect(source, ownedSignal),
      probe: async (candidate, ownedSignal) => {
        if (!env.host.probe)
          return {
            candidateKey: candidate.key,
            sourceId: candidate.sourceId,
            sourceFingerprint: candidate.sourceFingerprint,
            platform,
            evidence: { kind: 'not-checked' },
          };
        const observed = await env.host.probe(candidate, ownedSignal, budgetMs);
        return {
          candidateKey: observed.channelId,
          sourceId: observed.sourceId,
          sourceFingerprint: observed.fingerprint,
          platform: observed.platform,
          evidence: observed.evidence,
        };
      },
      enrich: (candidate, registered, ownedSignal) =>
        env.host.enrich!(candidate, registered, ownedSignal),
      revision: () => env.host.revision(),
      now: () => env.host.now?.() ?? Date.now(),
    });
    return pipeline.run({
      sources,
      guides,
      query: queryText,
      platform,
      checks,
      ...(expectedCandidates ? { expectedCandidates } : {}),
      deadlineMs: 120000,
      signal,
      progress: (event) => {
        if (!env.closed && !signal.aborted)
          env.status.textContent = `${event.phase}: ${event.completed}/${event.total} settled`;
      },
    });
  }
  return {
    checkCaptured,
    persistCheckpoint,
    runCheck,
    runGuideReview,
    indexSuggestions,
  };
}
