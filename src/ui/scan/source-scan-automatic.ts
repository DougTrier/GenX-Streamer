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

import { type ScanReview, type ScanSource } from '../../discovery/scan';
import { type HealthObservation } from '../../discovery/health';
import {
  validateBoundedScanResumePlan,
  type BoundedScanResumePlan,
} from '../../application/discovery/bounded-scan-resume';
import { SourceSnapshotFullRecheckEmptyError } from '../../platform/source-snapshot-activation';
import { type Source } from '../../catalog/parser';
import { type PipelineReview } from '../../discovery/pipeline';
import {
  ScanSourcesChanged,
  freezeCapture,
  normalizedScanQuery,
  type AutomaticScanEntry,
  type AutomaticScanOptions,
  type AutomaticScanProgress,
  type BoundedSourceScanResume,
  type HealthCheckBudgetMs,
  type ScanFailure,
  type ScanResumeRefusal,
  type SourceScanHost,
  type SourceScanSnapshot,
} from './source-scan-model';

// Compare validated immutable captures without allocating a whole-review serialization.
// JSON omits optional undefined fields; ordered arrays and every declared value remain exact.
function sameCapturedValue(
  left: unknown,
  right: unknown,
  budget: { remaining: number },
  depth = 0,
): boolean {
  if (--budget.remaining < 0 || depth > 16) return false;
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object')
    return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((item, index) => sameCapturedValue(item, right[index], budget, depth + 1));
  }
  const a = left as Record<string, unknown>,
    b = right as Record<string, unknown>;
  const keysA = Object.keys(a).filter((key) => a[key] !== undefined),
    keysB = Object.keys(b).filter((key) => b[key] !== undefined);
  if (keysA.length !== keysB.length) return false;
  return keysA.every(
    (key) => Object.hasOwn(b, key) && sameCapturedValue(a[key], b[key], budget, depth + 1),
  );
}

// Collection may fill previously unknown format metadata after the UI captures source authority.
// Explicitly declared format, source identity and network grants must still match exactly.
function sameCapturedSource(left: Source, right: Source, budget: { remaining: number }): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    const a = Reflect.get(left, key),
      b = Reflect.get(right, key);
    if ((key === 'contentKind' || key === 'mediaMime') && a === undefined) continue;
    if (!sameCapturedValue(a, b, budget)) return false;
  }
  return true;
}

async function sameImmutableScanReview(
  left: ScanReview,
  right: ScanReview,
  signal: AbortSignal,
  assertCurrent: () => void,
): Promise<boolean> {
  const budget = { remaining: 10_000_000 };
  if (
    left.sessionRevision !== right.sessionRevision ||
    left.query !== right.query ||
    left.status !== right.status ||
    left.candidates.length !== right.candidates.length ||
    left.sources.length !== right.sources.length ||
    !sameCapturedValue(left.counts, right.counts, budget)
  )
    return false;
  for (let i = 0; i < left.sources.length; i++) {
    const a = left.sources[i]!,
      b = right.sources[i]!;
    if (
      ['sourceId', 'fingerprint', 'status', 'inspected', 'matched', 'warnings'].some(
        (key) => Reflect.get(a, key) !== Reflect.get(b, key),
      )
    )
      return false;
  }
  for (let i = 0; i < left.candidates.length; i++) {
    if (i % 64 === 0) {
      if (i > 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
      signal.throwIfAborted();
      assertCurrent();
    }
    if (!sameCapturedValue(left.candidates[i], right.candidates[i], budget)) return false;
  }
  signal.throwIfAborted();
  assertCurrent();
  return true;
}

class ContinueRefusal extends Error {
  constructor(readonly reason: ScanResumeRefusal) {
    super('Saved scan cannot continue.');
  }
}

/** What this part reads from, and writes back to, mountSourceScan. */
export interface AutomaticScanRunsEnvironment {
  checkpoint: {
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
  activeAutomaticQuery: string;
  readonly closed: boolean;
  readonly busy: boolean;
  stopWork: Promise<void> | null;
  readonly suspension: Promise<void> | null;
  readonly host: SourceScanHost;
  automaticPresentation: 'inline' | 'dialog';
  backgroundPaused: boolean;
  checkpointRestoreRefused: boolean;
  storedJobId: string | null;
  resumeRefusal: ScanResumeRefusal | undefined;
  automaticMode: boolean;
  readonly showAutomatic: () => void;
  readonly error: HTMLParagraphElement;
  readonly render: () => void;
  summaryCheckpointRevision: string | undefined;
  boundedSaved: { jobId: string; query: string; completed: boolean } | null;
  checkpointAdmissionLoaded: boolean;
  durableCheckpointAvailable: boolean;
  readonly begin: (
    admissionOnly?: boolean,
    preserveCounts?: boolean,
  ) => { signal: AbortSignal; generation: number };
  work: Promise<void>;
  checkpointRevision: string;
  readonly recordFailure: (failure: unknown, publication?: boolean) => void;
  readonly finish: (generation: number, admissionOnly?: boolean) => void;
  readonly owner: number;
  capturedSources: readonly ScanSource[];
  review: ScanReview | null;
  sourceLabels: Map<string, string>;
  readonly checkBudget: HTMLSelectElement;
  scanTotal: number;
  scanChecked: number;
  scanResponded: number;
  scanPublished: number;
  scanPhase: SourceScanSnapshot['phase'];
  savedSummary: AutomaticScanProgress['savedSummary'];
  readonly status: HTMLParagraphElement;
  boundedCleanupRefusal: { service: BoundedSourceScanResume; error: unknown } | null;
  readonly queryMatches: (requested: string | undefined) => boolean;
  scopeRefusal: 'query-changed' | null;
  readonly notifyProgress: () => void;
  fileReview: boolean;
  readonly open: (sources?: readonly ScanSource[], presentation?: 'inline' | 'dialog') => void;
  historyMode: boolean;
  readonly optionsPanel: HTMLDetailsElement;
  readonly query: HTMLInputElement;
  readonly search: HTMLInputElement;
  readonly runScan: () => void;
  pipelineReview: PipelineReview | null;
  readonly health: Map<string, HealthObservation>;
  readonly selected: Set<string>;
  slowPass: boolean;
  scanKind: AutomaticScanProgress['scanKind'];
  boundedResume: BoundedSourceScanResume | null;
  lastFailure: ScanFailure;
  readonly checkCaptured: (
    captured: ScanReview,
    task: { signal: AbortSignal; generation: number },
    preselect: boolean,
  ) => Promise<void>;
  readonly persistCheckpoint: (actualSignal?: AbortSignal) => Promise<void>;
  continueWork: Promise<void> | null;
  readonly pendingPublications: number;
  readonly saving: boolean;
  readonly controller: AbortController | null;
}

/**
 * Automatic scans: starting, continuing, stopping and rescanning them, and
 * loading their saved checkpoint. Part of mountSourceScan.
 */
export function createAutomaticScanRuns(env: AutomaticScanRunsEnvironment) {
  function rescanAutomatic(
    sources?: readonly ScanSource[],
    options: AutomaticScanOptions = {},
  ): void {
    const nextQuery =
      options.query === undefined
        ? (env.checkpoint?.review.query ?? env.activeAutomaticQuery)
        : normalizedScanQuery(options.query);
    if (options.presentation !== undefined && !['inline', 'dialog'].includes(options.presentation))
      throw new Error('Scan presentation is invalid.');
    if (env.closed || env.busy || env.stopWork || env.suspension) return;
    if (env.host.indexedFreshAvailable?.()) {
      // Explicit full recheck stages new work before native activation replaces
      // the exact saved owner under CAS. Ordinary Refresh continues that owner.
      startAutomatic(sources, {
        query: nextQuery,
        presentation: options.presentation,
        intent: 'full-recheck',
      });
      return;
    }
    env.automaticPresentation = options.presentation ?? env.automaticPresentation;
    env.backgroundPaused = false;
    if (env.checkpointRestoreRefused && !env.storedJobId && env.resumeRefusal !== 'missing') {
      env.automaticMode = true;
      env.showAutomatic();
      env.error.textContent =
        'Saved scan ownership could not be verified. Existing channels retained.';
      env.render();
      return;
    }
    if (!env.host.checkpoint || !env.storedJobId) {
      env.resumeRefusal = undefined;
      env.summaryCheckpointRevision = undefined;
      env.checkpoint = null;
      env.boundedSaved = null;
      env.checkpointAdmissionLoaded = true;
      env.checkpointRestoreRefused = false;
      env.durableCheckpointAvailable = true;
      env.activeAutomaticQuery = nextQuery;
      startAutomatic(sources, { query: nextQuery, presentation: env.automaticPresentation });
      return;
    }
    env.automaticMode = true;
    env.showAutomatic();
    const task = env.begin();
    env.work = (async () => {
      let discarded = false;
      try {
        const receipt = await env.host.checkpoint!.discard(
          env.storedJobId!,
          env.host.revision(),
          env.checkpointRevision,
          task.signal,
        );
        if (receipt.committed !== true || !receipt.checkpointRevision)
          throw new Error('Missing checkpoint receipt');
        env.checkpointRevision = receipt.checkpointRevision;
        env.storedJobId = null;
        env.resumeRefusal = undefined;
        env.summaryCheckpointRevision = undefined;
        env.checkpoint = null;
        env.boundedSaved = null;
        env.checkpointAdmissionLoaded = true;
        env.checkpointRestoreRefused = false;
        env.durableCheckpointAvailable = true;
        discarded = true;
      } catch (failure) {
        env.recordFailure(failure);
        env.error.textContent = 'Saved scan could not be cleared. Existing channels retained.';
      } finally {
        env.finish(task.generation);
      }
      if (discarded && !env.closed && !task.signal.aborted) {
        env.activeAutomaticQuery = nextQuery;
        startAutomatic(sources, { query: nextQuery, presentation: env.automaticPresentation });
      }
    })();
  }
  async function loadAutomaticCheckpoint(
    task: {
      signal: AbortSignal;
      generation: number;
    },
    continuing?: { jobId: string | null; revision: string | undefined },
  ): Promise<boolean> {
    if (env.checkpoint && !continuing) return false;
    if (!env.host.checkpoint) {
      if (continuing && !env.checkpoint) throw new ContinueRefusal('missing');
      return env.checkpoint ? false : true;
    }
    if (env.checkpointAdmissionLoaded && !continuing) return true;
    // Only an actual null preparation can authorize this same-session RAM path.
    // A size refusal or a disappeared previously ACKed checkpoint cannot do so.
    const ownedRamOnly =
      !!continuing &&
      !!env.checkpoint &&
      !env.durableCheckpointAvailable &&
      env.storedJobId === null;
    const saved = await env.host.checkpoint!.load(task.signal);
    task.signal.throwIfAborted();
    if (env.closed || task.generation !== env.owner)
      throw new DOMException('Scan entry canceled.', 'AbortError');
    env.checkpointRevision = saved.checkpointRevision;
    env.storedJobId = saved.jobId;
    if (continuing) {
      if (saved.checkpointStatus === 'absent') {
        if (
          ownedRamOnly &&
          env.checkpoint &&
          saved.jobId === null &&
          saved.checkpointRevision === continuing.revision &&
          env.checkpoint.expectedRevision === env.host.revision() &&
          env.checkpoint.platform === env.host.platform?.() &&
          env.checkpoint.profile === env.host.observerProfile?.(env.checkpoint.budgetMs)
        ) {
          env.checkpointAdmissionLoaded = true;
          env.checkpointRestoreRefused = false;
          return false;
        }
        throw new ContinueRefusal('missing');
      }
      if (saved.checkpointStatus !== 'valid' || !saved.parsed)
        throw new ContinueRefusal('unavailable');
      if (
        (continuing.jobId !== null && saved.jobId !== continuing.jobId) ||
        (continuing.revision !== undefined && saved.checkpointRevision !== continuing.revision)
      )
        throw new ContinueRefusal('changed');
    }
    env.checkpointAdmissionLoaded = true;
    if (saved.checkpointStatus === 'absent') {
      return true;
    }
    env.checkpointRestoreRefused = true;
    const parsed = saved.parsed;
    if (
      saved.checkpointStatus !== 'valid' ||
      !parsed ||
      (env.host.now?.() ?? Date.now()) < parsed.createdAtMs ||
      (env.host.now?.() ?? Date.now()) - parsed.createdAtMs >= 86400000 ||
      env.host.platform?.() !== parsed.platform ||
      env.host.observerProfile?.(parsed.budgetMs) !== parsed.observerProfile
    )
      throw new Error('Saved scan unavailable');
    let trustedRam: ReadonlyMap<string, HealthObservation> | undefined;
    if (continuing && env.checkpoint) {
      const retained = env.checkpoint;
      const assertCurrent = () => {
        task.signal.throwIfAborted();
        if (env.closed || task.generation !== env.owner || env.checkpoint !== retained)
          throw new DOMException('Scan entry canceled.', 'AbortError');
        if (
          retained.expectedRevision !== env.host.revision() ||
          retained.platform !== env.host.platform?.() ||
          retained.profile !== env.host.observerProfile?.(retained.budgetMs)
        )
          throw new ContinueRefusal('changed');
      };
      const sourceBudget = { remaining: 100000 };
      const admittedPublished = new Set(parsed.publishedKeys);
      if (
        env.checkpoint.expectedRevision !== env.host.revision() ||
        env.checkpoint.jobId !== parsed.jobId ||
        env.checkpoint.createdAtMs !== parsed.createdAtMs ||
        env.checkpoint.platform !== parsed.platform ||
        env.checkpoint.profile !== parsed.observerProfile ||
        env.checkpoint.budgetMs !== parsed.budgetMs ||
        !(await sameImmutableScanReview(
          env.checkpoint.review,
          parsed.review,
          task.signal,
          assertCurrent,
        )) ||
        env.capturedSources.length !== parsed.sourceDefinitions.length ||
        env.capturedSources.some(
          (entry, index) =>
            !sameCapturedSource(
              entry.source,
              parsed.sourceDefinitions[index]!.source,
              sourceBudget,
            ),
        ) ||
        [...env.checkpoint.published].some((key) => !admittedPublished.has(key))
      )
        throw new ContinueRefusal('changed');
      assertCurrent();
      trustedRam = env.checkpoint.observations;
    }
    env.checkpointRestoreRefused = false;
    env.capturedSources = parsed.sourceDefinitions.map((definition) => ({
      source: definition.source,
      fingerprint: parsed.review.sources.find((source) => source.sourceId === definition.source.id)!
        .fingerprint,
    }));
    env.checkpoint = {
      review: freezeCapture(structuredClone(parsed.review)),
      expectedRevision: env.host.revision(),
      observations: new Map(
        parsed.observations.map((observation) => [
          observation.channelId,
          freezeCapture(structuredClone(observation)),
        ]),
      ),
      published: new Set(parsed.publishedKeys),
      platform: parsed.platform,
      profile: parsed.observerProfile,
      budgetMs: parsed.budgetMs,
      jobId: parsed.jobId,
      createdAtMs: parsed.createdAtMs,
    };
    // The native admission and published set are authoritative. Only still-owned,
    // identical-capture observations absent from that ACKed snapshot may be reused.
    if (trustedRam)
      for (const [key, observation] of trustedRam)
        if (!env.checkpoint.observations.has(key))
          env.checkpoint.observations.set(key, observation);
    env.review = env.checkpoint.review;
    env.activeAutomaticQuery = env.checkpoint.review.query;
    env.sourceLabels = new Map(
      env.capturedSources.map((entry) => [entry.source.id, entry.source.name]),
    );
    env.checkBudget.value = String(parsed.budgetMs);
    env.scanTotal = env.checkpoint.review.candidates.length;
    env.scanChecked = env.checkpoint.observations.size;
    env.scanResponded = [...env.checkpoint.observations.values()].filter((observation) =>
      ['Reachable', 'PlayedHere'].includes(observation.verdict),
    ).length;
    env.scanPublished = env.checkpoint.published.size;
    return false;
  }
  function automaticEntryState(ignoreBusy = false): AutomaticScanEntry {
    if (env.closed || env.checkpointRestoreRefused) return 'unavailable';
    if ((env.busy || env.stopWork) && !ignoreBusy) return 'running';
    if (env.boundedSaved) return env.boundedSaved.completed ? 'completed' : 'unfinished';
    if (!env.checkpoint) return 'fresh';
    if (env.host.revision() !== env.checkpoint.expectedRevision) return 'unavailable';
    const pending =
      env.checkpoint.observations.size < env.checkpoint.review.candidates.length ||
      [...env.checkpoint.observations].some(
        ([key, observation]) =>
          ['Reachable', 'PlayedHere'].includes(observation.verdict) &&
          !env.checkpoint!.published.has(key),
      );
    return pending ? 'unfinished' : 'completed';
  }
  let entryWork: Promise<AutomaticScanEntry> | null = null;
  function prepareAutomaticEntry(): Promise<AutomaticScanEntry> {
    if (env.stopWork) return env.stopWork.then(() => automaticEntryState());
    if (entryWork) return entryWork;
    if (
      env.closed ||
      env.busy ||
      env.stopWork ||
      env.suspension ||
      env.checkpoint ||
      env.boundedSaved ||
      env.checkpointAdmissionLoaded ||
      !env.host.checkpoint
    )
      return Promise.resolve(automaticEntryState());
    const task = env.begin(true);
    const pending = (async () => {
      try {
        await loadAutomaticCheckpoint(task);
      } catch {
        if (!task.signal.aborted && !env.closed) env.checkpointRestoreRefused = true;
      } finally {
        // Admission is read-only: completing this owner is not completing a channel scan.
        env.scanPhase = env.checkpoint
          ? automaticEntryState(true) === 'completed'
            ? 'completed'
            : 'paused'
          : 'idle';
        env.finish(task.generation, true);
      }
      return automaticEntryState();
    })().finally(() => {
      if (entryWork === pending) entryWork = null;
    });
    entryWork = pending;
    env.work = pending.then(() => undefined);
    return pending;
  }
  function startAutomatic(
    sources?: readonly ScanSource[],
    options: AutomaticScanOptions = {},
  ): void {
    const indexedFresh = options.intent !== 'continue' && !!env.host.indexedFreshAvailable?.();
    const continuing = options.intent === 'continue';
    if (
      options.intent !== undefined &&
      !['start', 'continue', 'full-recheck', 'slow'].includes(options.intent)
    )
      throw new Error('Scan intent is invalid.');
    // The Slow list is checked only from indexed sources, never over a running scan.
    if (options.intent === 'slow' && (!indexedFresh || env.busy)) return;
    const continuationScope = {
      jobId: env.checkpoint?.jobId ?? env.storedJobId,
      revision:
        env.checkpoint || env.boundedSaved ? env.checkpointRevision : env.summaryCheckpointRevision,
    };
    const priorCheckpoint = env.checkpoint;
    const priorReview = env.review;
    const priorCapturedSources = env.capturedSources;
    const priorQuery = env.activeAutomaticQuery;
    const priorSavedState = {
      boundedSaved: env.boundedSaved,
      storedJobId: env.storedJobId,
      checkpointRevision: env.checkpointRevision,
      summaryCheckpointRevision: env.summaryCheckpointRevision,
      savedSummary: env.savedSummary,
    };
    const priorCounts = {
      total: env.scanTotal,
      checked: env.scanChecked,
      responded: env.scanResponded,
      published: env.scanPublished,
    };
    const priorStatus = env.status.textContent ?? '';
    const requested = options.query === undefined ? undefined : normalizedScanQuery(options.query);
    if (options.presentation !== undefined && !['inline', 'dialog'].includes(options.presentation))
      throw new Error('Scan presentation is invalid.');
    if (env.closed || env.suspension || env.stopWork || env.boundedCleanupRefusal) return;
    // Presentation is observational: a refused new query must still reach the requested UI.
    env.automaticPresentation = options.presentation ?? env.automaticPresentation;
    if (env.checkpoint) env.automaticMode = true;
    if (env.automaticMode) env.showAutomatic();
    if (
      (env.busy || (!indexedFresh && (env.checkpoint || env.boundedSaved))) &&
      !env.queryMatches(requested)
    )
      return;
    if (env.scopeRefusal) {
      env.scopeRefusal = null;
      env.error.textContent = '';
    }
    if (env.busy) {
      if (env.automaticMode) env.showAutomatic();
      env.notifyProgress();
      return;
    }
    if (!continuing && env.boundedSaved && !indexedFresh) {
      env.showAutomatic();
      env.notifyProgress();
      return;
    }
    if (continuing && env.resumeRefusal !== undefined) {
      env.notifyProgress();
      return;
    }
    env.scopeRefusal = null;
    env.activeAutomaticQuery = indexedFresh
      ? (requested ?? env.activeAutomaticQuery)
      : (env.checkpoint?.review.query ?? requested ?? env.activeAutomaticQuery);
    env.backgroundPaused = false;
    env.fileReview = false;
    env.open(sources, env.automaticPresentation);
    env.automaticMode = true;
    env.historyMode = false;
    env.optionsPanel.open = false;
    env.query.value = env.activeAutomaticQuery;
    env.search.value = '';
    if (env.checkpointRestoreRefused && !continuing && !indexedFresh) {
      env.resumeRefusal = 'unavailable';
      env.error.textContent = 'Saved scan is unavailable. Use Rescan to start a new scan.';
      env.render();
      return;
    }
    if (
      !indexedFresh &&
      !continuing &&
      !env.checkpoint &&
      (!env.host.checkpoint || env.checkpointAdmissionLoaded)
    ) {
      env.resumeRefusal = undefined;
      env.runScan();
      return;
    }
    if (indexedFresh) {
      env.checkpoint = null;
      env.review = null;
      env.pipelineReview = null;
      env.capturedSources = [];
      env.boundedSaved = null;
      env.health.clear();
      env.selected.clear();
    }
    env.slowPass = options.intent === 'slow';
    env.scanKind =
      options.intent === 'slow'
        ? 'slow'
        : options.intent === 'continue'
          ? 'continue'
          : !indexedFresh
            ? undefined
            : options.intent === 'full-recheck'
              ? 'rescan'
              : 'refresh';
    const task = env.begin(false, continuing && !env.checkpoint && !!env.host.createBoundedResume);
    env.work = (async () => {
      let fresh = false;
      let continuedAdmitted = false;
      let boundedCleanupFailure = false;
      try {
        if (indexedFresh || (continuing && !env.checkpoint && env.host.createBoundedResume)) {
          const freshEntry = indexedFresh
            ? await env.host.createIndexedFreshResume!(
                {
                  ...(sources === undefined ? {} : { sources }),
                  query: requested ?? env.activeAutomaticQuery,
                  // The Slow list gets the whole 45 seconds; scans keep the setting.
                  budgetMs: env.slowPass
                    ? 45000
                    : (Number(env.checkBudget.value) as HealthCheckBudgetMs),
                  intent:
                    options.intent === 'full-recheck'
                      ? 'full-recheck'
                      : env.slowPass
                        ? 'slow'
                        : 'refresh',
                },
                task.signal,
              )
            : null;
          if (freshEntry && !freshEntry.service && env.slowPass) {
            // An empty Slow list leaves the finished scan's summary as it was.
            task.signal.throwIfAborted();
            env.checkpoint = priorCheckpoint;
            env.review = priorReview;
            env.capturedSources = priorCapturedSources;
            env.activeAutomaticQuery = priorQuery;
            ({
              boundedSaved: env.boundedSaved,
              storedJobId: env.storedJobId,
              checkpointRevision: env.checkpointRevision,
              summaryCheckpointRevision: env.summaryCheckpointRevision,
              savedSummary: env.savedSummary,
            } = priorSavedState);
            env.scanTotal = priorCounts.total;
            env.scanChecked = priorCounts.checked;
            env.scanResponded = priorCounts.responded;
            env.scanPublished = priorCounts.published;
            env.scanPhase = 'completed';
            env.status.textContent = priorStatus;
            return;
          }
          if (freshEntry && !freshEntry.service) {
            task.signal.throwIfAborted();
            env.checkpoint = null;
            env.review = null;
            env.boundedSaved = null;
            env.storedJobId = null;
            env.scanTotal = env.scanChecked = env.scanResponded = env.scanPublished = 0;
            env.scanPhase = 'completed';
            env.status.textContent =
              'Sources updated. No new or due channels need checking. Saved channels are retained.';
            return;
          }
          const service = freshEntry
            ? freshEntry.service
            : await env.host.createBoundedResume!(
                {
                  jobId: continuationScope.jobId,
                  ...(requested === undefined ? {} : { query: requested }),
                  ...(continuationScope.revision === undefined
                    ? {}
                    : { checkpointRevision: continuationScope.revision }),
                },
                task.signal,
              );
          if (service) {
            env.boundedResume = service;
            let unsubscribe: (() => void) | undefined;
            let operationFailure: { error: unknown } | undefined;
            try {
              await (async () => {
                task.signal.throwIfAborted();
                const plan: BoundedScanResumePlan = validateBoundedScanResumePlan(
                  await service.prepare(),
                );
                task.signal.throwIfAborted();
                if (env.closed || task.generation !== env.owner)
                  throw new DOMException('Scan entry canceled.', 'AbortError');
                if (
                  (!indexedFresh &&
                    continuationScope.jobId !== null &&
                    continuationScope.jobId !== plan.jobId) ||
                  (!indexedFresh &&
                    continuationScope.revision !== undefined &&
                    continuationScope.revision !== plan.revisions.checkpointRevision) ||
                  env.host.platform?.() !== plan.platform ||
                  env.host.observerProfile?.(plan.budgetMs) !== plan.observerProfile ||
                  (env.host.now?.() ?? Date.now()) < plan.createdAtMs ||
                  (env.host.now?.() ?? Date.now()) - plan.createdAtMs >= 86400000
                )
                  throw new ContinueRefusal('changed');
                if (
                  plan.counts.checked === plan.counts.total &&
                  plan.counts.published === plan.counts.responded
                )
                  throw new ContinueRefusal('completed');
                // Only scalars are retained here. No runtime checkpoint/review or health map is hydrated.
                if (indexedFresh) {
                  env.checkpoint = null;
                  env.review = null;
                  env.pipelineReview = null;
                  env.capturedSources = [];
                  env.health.clear();
                  env.selected.clear();
                }
                env.activeAutomaticQuery = plan.query;
                continuedAdmitted = true;
                env.resumeRefusal = undefined;
                env.checkpointRestoreRefused = false;
                env.checkpointAdmissionLoaded = true;
                env.storedJobId = plan.jobId;
                env.checkpointRevision = plan.revisions.checkpointRevision;
                env.boundedSaved = { jobId: plan.jobId, query: plan.query, completed: false };
                const update = (value: ReturnType<BoundedSourceScanResume['snapshot']>) => {
                  if (task.generation !== env.owner) return;
                  env.scanTotal = value.counts.total;
                  env.scanChecked = value.counts.checked;
                  env.scanResponded = value.counts.responded;
                  env.scanPublished = value.counts.published;
                  if (value.revisions) env.checkpointRevision = value.revisions.checkpointRevision;
                  if (value.phase !== 'disposed') {
                    env.boundedSaved!.completed = value.phase === 'completed';
                    env.scanPhase =
                      value.phase === 'completed'
                        ? 'completed'
                        : value.phase === 'checking'
                          ? 'checking'
                          : value.phase === 'failed' || value.phase === 'quarantined'
                            ? 'failed'
                            : 'paused';
                  }
                  if (value.failure !== 'none')
                    env.lastFailure =
                      value.failure === 'commit-unconfirmed'
                        ? 'publish-failed'
                        : value.failure === 'cleanup-unconfirmed'
                          ? 'cancel-ack'
                          : 'other';
                  if (!env.closed) {
                    const label = env.slowPass
                      ? env.scanPhase === 'completed'
                        ? 'Slow channels checked'
                        : env.scanPhase === 'failed'
                          ? 'Slow channel check stopped'
                          : env.scanPhase === 'paused'
                            ? 'Slow channel check paused'
                            : 'Checking slow channels in the background'
                      : env.scanPhase === 'completed'
                        ? 'Scan complete'
                        : env.scanPhase === 'failed'
                          ? 'Scan stopped'
                          : env.scanPhase === 'paused'
                            ? 'Scan paused'
                            : 'Checking channels';
                    env.status.textContent = `${label} | ${env.scanChecked} of ${env.scanTotal} checked | ${env.scanPublished} saved.`;
                    env.error.textContent =
                      value.failure === 'commit-unconfirmed'
                        ? 'Saving scan progress could not be confirmed. Select Finish scan to read saved progress before retrying. Saved channels are retained.'
                        : value.failure === 'cleanup-unconfirmed'
                          ? 'Scan cleanup could not be confirmed. Reopen the app before continuing. Saved channels are retained.'
                          : value.failure === 'probe-unconfirmed'
                            ? // Unconfirmed checks are retried later; while the scan
                              // is still running this is progress, not an error.
                              ['completed', 'failed', 'paused'].includes(env.scanPhase)
                              ? 'Some checks were not confirmed. Finish scan to retry unfinished channels. Your saved channels are retained.'
                              : ''
                            : value.failure === 'admission-failed'
                              ? 'The scan could not restart. Select Finish scan to check saved progress, or Rescan to check your current sources.'
                              : env.scanPhase === 'failed'
                                ? 'Scan stopped before completion. Select Finish scan to check saved progress. Saved channels are retained.'
                                : '';
                    env.render();
                  }
                };
                update({ ...service.snapshot(), counts: plan.counts, revisions: plan.revisions });
                if (!env.queryMatches(requested)) {
                  env.scanPhase = 'paused';
                  return;
                }
                unsubscribe = service.subscribe(update);
                await service.start();
                update(service.snapshot());
              })();
            } catch (failure) {
              operationFailure = { error: failure };
            }
            try {
              await service.dispose();
              if (env.boundedResume === service) env.boundedResume = null;
            } catch (failure) {
              boundedCleanupFailure = true;
              env.boundedCleanupRefusal = { service, error: failure };
              throw failure;
            } finally {
              unsubscribe?.();
            }
            if (operationFailure) throw operationFailure.error;
            return;
          }
          task.signal.throwIfAborted();
          if (indexedFresh || env.boundedSaved) throw new ContinueRefusal('unavailable');
        }
        fresh = await loadAutomaticCheckpoint(task, continuing ? continuationScope : undefined);
        if (continuing) {
          if (fresh || !env.checkpoint) throw new ContinueRefusal('missing');
          const state = automaticEntryState(true);
          if (state === 'completed') throw new ContinueRefusal('completed');
          if (state !== 'unfinished') throw new ContinueRefusal('changed');
          env.resumeRefusal = undefined;
          continuedAdmitted = true;
        }
        if (fresh) return;
        if (!env.queryMatches(requested)) {
          env.scanPhase = 'paused';
          return;
        }
        env.activeAutomaticQuery = env.checkpoint!.review.query;
        await env.checkCaptured(env.checkpoint!.review, task, true);
        await env.persistCheckpoint();
      } catch (failure) {
        if (boundedCleanupFailure) {
          env.recordFailure(failure);
          env.scanPhase = 'failed';
          env.lastFailure = 'cancel-ack';
          env.status.textContent = 'Scan stopped. Cleanup could not be confirmed.';
          env.error.textContent =
            'Scan cleanup could not be confirmed. Reopen the app before continuing. Saved channels are retained.';
          throw failure;
        }
        if (indexedFresh && failure instanceof SourceSnapshotFullRecheckEmptyError) {
          // This exact native refusal proves activation left the prior owner intact.
          // Restore only its existing UI scalars; never reload a complete review graph.
          env.checkpoint = priorCheckpoint;
          env.review = priorReview;
          env.capturedSources = priorCapturedSources;
          env.activeAutomaticQuery = priorQuery;
          env.boundedSaved = priorSavedState.boundedSaved;
          env.storedJobId = priorSavedState.storedJobId;
          env.checkpointRevision = priorSavedState.checkpointRevision;
          env.summaryCheckpointRevision = priorSavedState.summaryCheckpointRevision;
          env.savedSummary = priorSavedState.savedSummary;
          env.scanTotal = priorCounts.total;
          env.scanChecked = priorCounts.checked;
          env.scanResponded = priorCounts.responded;
          env.scanPublished = priorCounts.published;
          env.scanPhase = 'paused';
          env.status.textContent =
            'Full recheck found no matching channels. Previous scan progress is retained.';
          env.error.textContent = failure.message;
          return;
        }
        if (continuing && !continuedAdmitted && !task.signal.aborted && !env.closed) {
          env.resumeRefusal = failure instanceof ContinueRefusal ? failure.reason : 'unavailable';
          env.checkpointRestoreRefused = true;
          env.checkpoint = priorCheckpoint;
          env.review = priorReview;
          env.capturedSources = priorCapturedSources;
          env.activeAutomaticQuery = priorQuery;
          env.scanTotal = priorCounts.total;
          env.scanChecked = priorCounts.checked;
          env.scanResponded = priorCounts.responded;
          env.scanPublished = priorCounts.published;
          env.scanPhase = 'failed';
          env.lastFailure = 'other';
          env.status.textContent = `Previous saved scan${priorQuery ? ` for “${priorQuery}”` : ''} | ${env.scanChecked} of ${env.scanTotal} checked | ${env.scanPublished} saved. This saved scan cannot continue. Select Rescan to check sources again.`;
          env.error.textContent =
            failure instanceof ScanSourcesChanged
              ? `${failure.message} Its ${env.scanPublished} saved channels are kept; Rescan checks the updated sources.`
              : 'Saved scan progress is unavailable for Finish scan.';
          return;
        }
        env.recordFailure(failure);
        env.status.textContent = 'Scan stopped. Added channels retained.';
        env.error.textContent =
          env.lastFailure === 'publish-failed'
            ? 'Channels could not be saved. Saved channels are safe; Finish scan retries from the last saved progress.'
            : task.signal.aborted && env.lastFailure === 'canceled'
              ? ''
              : 'Scan could not resume. Rescan to check the current sources.';
      } finally {
        env.finish(task.generation);
        if (fresh && !continuing && !env.closed && !task.signal.aborted) env.runScan();
      }
    })();
  }
  function continueAutomatic(
    options: Pick<AutomaticScanOptions, 'presentation'> = {},
  ): Promise<void> {
    if (env.continueWork) return env.continueWork;
    if (env.closed || env.suspension) return Promise.resolve();
    if (env.stopWork) return env.stopWork;
    if (env.busy) {
      env.automaticPresentation = options.presentation ?? env.automaticPresentation;
      env.showAutomatic();
      env.notifyProgress();
      return Promise.resolve();
    }
    let resolve!: () => void, reject!: (error: unknown) => void;
    const pending = new Promise<void>((ok, fail) => {
      resolve = ok;
      reject = fail;
    });
    env.continueWork = pending;
    const settle = () => {
      if (env.continueWork === pending) env.continueWork = null;
    };
    void pending.then(settle, settle);
    try {
      startAutomatic(undefined, { ...options, intent: 'continue' });
      void env.work.then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return pending;
  }
  function stopAutomatic(): Promise<void> {
    if (env.stopWork) return env.stopWork;
    if (
      !env.automaticMode ||
      env.closed ||
      (env.resumeRefusal !== undefined && !env.busy && !env.pendingPublications)
    )
      return Promise.resolve();
    env.backgroundPaused = false;
    const pending = env.work;
    const pendingSuspension = env.suspension;
    // Reserve the owner before abort callbacks can synchronously request Stop/Continue.
    const stopping = Promise.resolve()
      .then(async () => {
        if (!env.saving) env.controller?.abort();
        await env.boundedResume?.suspend();
        await pending;
        await pendingSuspension;
        if (env.checkpoint) {
          // An admitted observation can wait on publisher capacity, then miss
          // progress notification when Stop aborts. Joined settled membership
          // is authoritative; canceled/refused checks were never retained here.
          env.scanChecked = env.checkpoint.observations.size;
          env.scanResponded = 0;
          for (const observation of env.checkpoint.observations.values()) {
            env.health.set(observation.channelId, observation);
            if (['Reachable', 'PlayedHere'].includes(observation.verdict)) env.scanResponded++;
          }
          env.scanPublished = env.checkpoint.published.size;
        }
        await env.persistCheckpoint();
      })
      .finally(() => {
        if (env.stopWork === stopping) env.stopWork = null;
        env.host.activity?.(false);
        env.render();
      });
    env.stopWork = stopping;
    env.status.textContent = 'Stopping scan and saving progress…';
    env.render();
    return stopping;
  }
  return {
    rescanAutomatic,
    stopAutomatic,
    prepareAutomaticEntry,
    get entryWork() {
      return entryWork;
    },
    startAutomatic,
    continueAutomatic,
  };
}
