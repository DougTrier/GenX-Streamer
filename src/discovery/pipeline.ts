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

import type { ParsedPlaylist, Source } from '../catalog/parser';
import { exactCandidateDedup } from '../catalog/collector';
import {
  createHealthObservation,
  reconcileHealth,
  type HealthEvidence,
  type HealthObservation,
} from './health';
import {
  scanConfiguredSources,
  stageScanSelection,
  type ReviewCandidate,
  type ScanReview,
  type ScanSource,
  type StagedScanSelection,
} from './scan';

export interface RegisteredGuide {
  id: string;
  fingerprint: string;
}
export interface ProbeResult {
  candidateKey: string;
  sourceId: string;
  sourceFingerprint: string;
  platform: string;
  evidence: HealthEvidence;
}
export interface GuideEnrichment {
  candidateKey: string;
  guideSourceId: string;
  guideChannelId?: string;
  status: 'suggested' | 'ambiguous' | 'unmatched' | 'unavailable';
}
export interface PipelineProgress {
  phase: 'collect' | 'check' | 'enrich' | 'review';
  completed: number;
  total: number;
}
export interface PipelineOptions {
  sources: readonly ScanSource[];
  guides: readonly RegisteredGuide[];
  query: string;
  platform: string;
  checks: 'all' | readonly string[];
  /** Required for selected checks: captures the exact reviewed candidate before recollection. */
  expectedCandidates?: readonly ReviewCandidate[];
  deadlineMs: number;
  signal?: AbortSignal;
  progress?: (value: PipelineProgress) => void;
}
export interface PipelineReview {
  status: 'review' | 'requires-selection' | 'canceled' | 'stale' | 'failed';
  publishable: boolean;
  catalogRevision: string;
  scan: ScanReview;
  observations: HealthObservation[];
  enrichment: GuideEnrichment[];
  allNotCheckedKeys: string[];
  unenrichedKeys: string[];
  error?: string;
}
export interface PipelineTimer {
  set(callback: () => void, milliseconds: number): unknown;
  clear(handle: unknown): void;
}
export interface PipelineDependencies {
  collect: (source: Source, signal: AbortSignal) => Promise<ParsedPlaylist>;
  probe: (candidate: ReviewCandidate, signal: AbortSignal) => Promise<ProbeResult>;
  enrich: (
    candidate: ReviewCandidate,
    guides: readonly RegisteredGuide[],
    signal: AbortSignal,
  ) => Promise<GuideEnrichment[]>;
  revision: () => string;
  now: () => number;
  timer?: PipelineTimer;
}
export interface CollectionPipeline {
  run(options: PipelineOptions): Promise<PipelineReview>;
  cancel(): Promise<void>;
}
type Reason = 'canceled' | 'stale' | 'deadline' | 'failed' | 'superseded';
interface Job {
  controller: AbortController;
  reason: Reason | null;
  revision: string;
  done: Promise<PipelineReview>;
}
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function opaque(value: unknown, max = 256): asserts value is string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > max ||
    /https?:\/\//iu.test(value) ||
    [...value].some((c) => c.charCodeAt(0) < 32)
  )
    throw new Error('Collection pipeline metadata is invalid.');
}
function optionsCopy(value: PipelineOptions): PipelineOptions {
  if (
    !Array.isArray(value.sources) ||
    !value.sources.length ||
    value.sources.length > 100 ||
    !Array.isArray(value.guides) ||
    value.guides.length > 100 ||
    typeof value.query !== 'string' ||
    value.query.length > 256 ||
    !Number.isInteger(value.deadlineMs) ||
    value.deadlineMs < 1 ||
    value.deadlineMs > 120_000
  )
    throw new Error('Collection pipeline scope or deadline is invalid.');
  opaque(value.platform);
  const sourceIds = new Set<string>();
  const guideIds = new Set<string>();
  for (const entry of value.sources) {
    opaque(entry.source.id);
    opaque(entry.fingerprint);
    if (sourceIds.has(entry.source.id)) throw new Error('Collection sources are repeated.');
    sourceIds.add(entry.source.id);
  }
  for (const guide of value.guides) {
    opaque(guide.id);
    opaque(guide.fingerprint);
    if (guideIds.has(guide.id)) throw new Error('Registered guides are repeated.');
    guideIds.add(guide.id);
  }
  if (value.checks !== 'all') {
    if (
      !Array.isArray(value.checks) ||
      value.checks.length > 1000 ||
      new Set(value.checks).size !== value.checks.length
    )
      throw new Error('Select at most 1,000 distinct candidates to check.');
    for (const key of value.checks) opaque(key);
    if (value.checks.length) {
      if (
        !Array.isArray(value.expectedCandidates) ||
        value.expectedCandidates.length !== value.checks.length ||
        new Set(value.expectedCandidates.map((candidate) => candidate.key)).size !==
          value.checks.length ||
        value.expectedCandidates.some((candidate) => !value.checks.includes(candidate.key))
      )
        throw new Error('Selected checks require their exact reviewed candidate snapshots.');
      for (const candidate of value.expectedCandidates) {
        opaque(candidate.key);
        opaque(candidate.sourceId);
        opaque(candidate.sourceFingerprint);
        opaque(candidate.sessionRevision, 128);
        exactCandidateDedup([candidate.channel]);
      }
    }
  }
  return {
    ...value,
    sources: structuredClone(value.sources),
    guides: structuredClone(value.guides),
    checks: value.checks === 'all' ? 'all' : [...value.checks],
    expectedCandidates: value.expectedCandidates
      ? structuredClone(value.expectedCandidates)
      : undefined,
  };
}
function evidenceValid(value: HealthEvidence): void {
  const allowed: Record<string, string[]> = {
    http: ['kind', 'status', 'contentRecognized'],
    'recognized-media-response': ['kind'],
    decoded: ['kind', 'before', 'after', 'elapsedMilliseconds'],
    timeout: ['kind'],
    unsupported: ['kind'],
    canceled: ['kind'],
    'local-network-unavailable': ['kind'],
    'network-failure': ['kind'],
    'not-checked': ['kind'],
    slow: ['kind'],
    'host-down': ['kind'],
  };
  if (
    !value ||
    typeof value !== 'object' ||
    !allowed[value.kind] ||
    Object.keys(value).some((key) => !allowed[value.kind].includes(key))
  )
    throw new Error('Probe evidence is invalid.');
  if (
    value.kind === 'http' &&
    value.contentRecognized !== undefined &&
    typeof value.contentRecognized !== 'boolean'
  )
    throw new Error('Probe evidence is invalid.');
  if (
    value.kind === 'decoded' &&
    (typeof value.elapsedMilliseconds !== 'number' || !Number.isFinite(value.elapsedMilliseconds))
  )
    throw new Error('Probe evidence is invalid.');
  if (value.kind === 'decoded')
    for (const sample of [value.before, value.after]) {
      if (
        !sample ||
        typeof sample !== 'object' ||
        Object.keys(sample).some(
          (key) => !['mediaTime', 'decodedFrames', 'width', 'height'].includes(key),
        )
      )
        throw new Error('Probe evidence is invalid.');
      if (
        [sample.mediaTime, sample.decodedFrames, sample.width, sample.height].some(
          (number) => typeof number !== 'number' || !Number.isFinite(number),
        )
      )
        throw new Error('Probe evidence is invalid.');
    }
}
function blankScan(options: PipelineOptions, revision: string): ScanReview {
  return {
    sessionRevision: revision,
    query: options.query.trim(),
    status: 'canceled',
    sources: options.sources.map(({ source, fingerprint }) => ({
      sourceId: source.id,
      fingerprint,
      status: 'canceled',
      inspected: 0,
      matched: 0,
      warnings: 0,
    })),
    candidates: [],
    counts: { inspected: 0, matched: 0, failedSources: 0, canceledSources: options.sources.length },
  };
}

/** Read-only owned job. Dependency adapters must settle on abort; cancellation acknowledges actual cleanup, never a detached Promise.race. */
export function createCollectionPipeline(dependencies: PipelineDependencies): CollectionPipeline {
  const timer: PipelineTimer = dependencies.timer ?? {
    set: (callback, delay) => setTimeout(callback, delay),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  let active: Job | null = null;
  let ownedJobs = 0;
  const abort = (job: Job, reason: Reason) => {
    if (!job.reason) job.reason = reason;
    job.controller.abort();
  };
  const revision = () => {
    const value = dependencies.revision();
    opaque(value, 128);
    return value;
  };
  async function execute(
    job: Job,
    options: PipelineOptions,
    previous: Job | null,
  ): Promise<PipelineReview> {
    let scan = blankScan(options, job.revision);
    const observations = new Map<string, HealthObservation>();
    const enriched = new Map<string, GuideEnrichment[]>();
    let terminal: PipelineReview['status'] = 'review';
    let safeError: string | undefined;
    let enrichmentBytes = 0;
    const timestamp = () => {
      const value = dependencies.now();
      if (!Number.isSafeInteger(value) || value < 0)
        throw new Error('Collection clock is invalid.');
      return value;
    };
    const guard = () => {
      if (job.controller.signal.aborted) throw new Error('Collection pipeline canceled.');
      if (revision() !== job.revision) {
        abort(job, 'stale');
        throw new Error('Collection pipeline revision changed.');
      }
    };
    const emit = (phase: PipelineProgress['phase'], completed: number, total: number) => {
      if (job.controller.signal.aborted) return;
      try {
        options.progress?.({ phase, completed, total });
      } catch {
        abort(job, 'failed');
        throw new Error('Collection progress failed.');
      }
    };
    const external = () => abort(job, 'canceled');
    options.signal?.addEventListener('abort', external, { once: true });
    if (options.signal?.aborted) external();
    let deadline: unknown;
    let deadlineSet = false;
    try {
      deadline = timer.set(() => abort(job, 'deadline'), options.deadlineMs);
      deadlineSet = true;
      if (previous) await previous.done;
      guard();
      timestamp();
      emit('collect', 0, options.sources.length);
      scan = await scanConfiguredSources(
        options.sources,
        async (source, signal) => {
          guard();
          const result = await dependencies.collect(source, signal);
          guard();
          return result;
        },
        {
          sessionRevision: job.revision,
          query: options.query,
          signal: job.controller.signal,
          progress: (event) => emit('collect', event.settled, event.total),
        },
      );
      guard();
      const selected =
        options.checks === 'all'
          ? scan.candidates
          : scan.candidates.filter((candidate) => options.checks.includes(candidate.key));
      if (options.checks === 'all' && selected.length > 1000) {
        terminal = 'requires-selection';
        safeError = 'Select at most 1,000 candidates before checking. No subset was sampled.';
      } else {
        if (options.checks !== 'all') {
          const expected = new Map(
            options.expectedCandidates?.map((candidate) => [candidate.key, candidate]),
          );
          if (
            selected.length !== options.checks.length ||
            selected.some((candidate) => {
              const prior = expected.get(candidate.key);
              return (
                !prior ||
                prior.sourceId !== candidate.sourceId ||
                prior.sourceFingerprint !== candidate.sourceFingerprint ||
                prior.sessionRevision !== candidate.sessionRevision ||
                exactCandidateDedup([prior.channel, candidate.channel]).length !== 1
              );
            })
          ) {
            abort(job, 'stale');
            throw new Error('Collection check selection is obsolete.');
          }
        }
        async function phase<T>(
          name: 'check' | 'enrich',
          operation: (candidate: ReviewCandidate) => Promise<T>,
          accept: (candidate: ReviewCandidate, value: T) => void,
        ): Promise<void> {
          let cursor = 0;
          let completed = 0;
          emit(name, 0, selected.length);
          const worker = async () => {
            while (!job.controller.signal.aborted && cursor < selected.length) {
              const candidate = selected[cursor++];
              try {
                guard();
                const value = await operation(structuredClone(candidate));
                guard();
                accept(candidate, value);
                completed++;
                emit(name, completed, selected.length);
              } catch {
                if (!job.controller.signal.aborted) abort(job, 'failed');
                throw new Error('Collection phase failed.');
              }
            }
          };
          const settled = await Promise.allSettled(
            Array.from({ length: Math.min(4, selected.length) }, () => worker()),
          );
          if (settled.some((result) => result.status === 'rejected'))
            throw new Error('Collection phase failed after cleanup.');
          guard();
        }
        await phase(
          'check',
          async (candidate) => {
            try {
              return await dependencies.probe(candidate, job.controller.signal);
            } catch {
              if (job.controller.signal.aborted) throw new Error('Probe canceled.');
              return {
                candidateKey: candidate.key,
                sourceId: candidate.sourceId,
                sourceFingerprint: candidate.sourceFingerprint,
                platform: options.platform,
                evidence: { kind: 'network-failure' },
              } as ProbeResult;
            }
          },
          (candidate, value) => {
            if (
              value.candidateKey !== candidate.key ||
              value.sourceId !== candidate.sourceId ||
              value.sourceFingerprint !== candidate.sourceFingerprint ||
              value.platform !== options.platform
            )
              throw new Error('Probe ownership is obsolete.');
            evidenceValid(value.evidence);
            const identity = {
              channelId: candidate.key,
              sourceId: candidate.sourceId,
              fingerprint: candidate.sourceFingerprint,
            };
            const observed = createHealthObservation(
              identity,
              { platform: options.platform, observedAt: timestamp() },
              value.evidence,
            );
            const reconciled = reconcileHealth(identity, null, observed);
            if (!reconciled.accepted || !reconciled.record)
              throw new Error('Probe evidence was not admitted.');
            observations.set(candidate.key, reconciled.record);
          },
        );
        if (options.guides.length)
          await phase<GuideEnrichment[]>(
            'enrich',
            async (candidate) => {
              try {
                return await dependencies.enrich(
                  candidate,
                  structuredClone(options.guides),
                  job.controller.signal,
                );
              } catch {
                if (job.controller.signal.aborted) throw new Error('Guide enrichment canceled.');
                return options.guides.map((guide) => ({
                  candidateKey: candidate.key,
                  guideSourceId: guide.id,
                  status: 'unavailable',
                }));
              }
            },
            (candidate, values) => {
              if (!Array.isArray(values) || values.length > options.guides.length)
                throw new Error('Guide enrichment exceeds its scope.');
              const seen = new Set<string>();
              const order = new Map(options.guides.map((guide, index) => [guide.id, index]));
              const admitted = values
                .map((value) => {
                  if (
                    !value ||
                    typeof value !== 'object' ||
                    Object.keys(value).some(
                      (key) =>
                        !['candidateKey', 'guideSourceId', 'guideChannelId', 'status'].includes(
                          key,
                        ),
                    ) ||
                    value.candidateKey !== candidate.key ||
                    !order.has(value.guideSourceId) ||
                    seen.has(value.guideSourceId) ||
                    !['suggested', 'ambiguous', 'unmatched', 'unavailable'].includes(value.status)
                  )
                    throw new Error('Guide enrichment ownership is invalid.');
                  opaque(value.guideSourceId);
                  seen.add(value.guideSourceId);
                  if (value.status === 'suggested') {
                    opaque(value.guideChannelId, 16_384);
                  } else if (value.guideChannelId !== undefined)
                    throw new Error('Unresolved guide enrichment cannot choose a channel.');
                  const copy = { ...value };
                  enrichmentBytes += new TextEncoder().encode(JSON.stringify(copy)).byteLength;
                  if (enrichmentBytes > 20 * 1024 * 1024)
                    throw new Error('Guide enrichment exceeds its metadata budget.');
                  return copy;
                })
                .sort(
                  (a, b) =>
                    (order.get(a.guideSourceId) ?? 0) - (order.get(b.guideSourceId) ?? 0) ||
                    compare(a.guideChannelId ?? '', b.guideChannelId ?? ''),
                );
              enriched.set(candidate.key, admitted);
            },
          );
        guard();
        emit('review', scan.candidates.length, scan.candidates.length);
        guard();
      }
    } catch {
      if (!job.reason) abort(job, 'failed');
      terminal = job.reason === 'stale' ? 'stale' : job.reason === 'failed' ? 'failed' : 'canceled';
      safeError =
        job.reason === 'deadline'
          ? 'Collection reached its deadline. Completed checks are retained for review; scan again before saving.'
          : job.reason === 'stale'
            ? 'The catalog changed during collection. Scan again before saving.'
            : job.reason === 'failed'
              ? 'Collection could not finish safely. Previous channels and guide data were retained.'
              : 'Collection was canceled after its owned operations settled.';
      scan = { ...scan, status: 'canceled' };
    } finally {
      if (deadlineSet) {
        try {
          timer.clear(deadline);
        } catch {
          terminal = 'failed';
          safeError = 'Collection deadline cleanup failed. Scan again before saving.';
          scan = { ...scan, status: 'canceled' };
        }
      }
      options.signal?.removeEventListener('abort', external);
      job.controller.abort();
    }
    const orderedObservations = scan.candidates.flatMap((candidate) => {
      const record = observations.get(candidate.key);
      return record ? [record] : [];
    });
    return {
      status: terminal,
      publishable: terminal === 'review',
      catalogRevision: job.revision,
      scan,
      observations: orderedObservations,
      enrichment: scan.candidates.flatMap((candidate) => enriched.get(candidate.key) ?? []),
      allNotCheckedKeys: scan.candidates
        .filter(
          (candidate) =>
            !observations.has(candidate.key) ||
            ['NotChecked', 'Canceled'].includes(observations.get(candidate.key)!.verdict),
        )
        .map((candidate) => candidate.key),
      unenrichedKeys: scan.candidates
        .filter((candidate) => !enriched.get(candidate.key)?.length)
        .map((candidate) => candidate.key),
      ...(safeError ? { error: safeError } : {}),
    };
  }
  return {
    run(input) {
      const options = optionsCopy(input);
      if (ownedJobs >= 2)
        throw new Error('Collection is already restarting. Wait for cancellation to finish.');
      const captured = revision();
      const previous = active;
      if (previous) abort(previous, 'superseded');
      let complete!: (review: PipelineReview) => void;
      const job: Job = {
        controller: new AbortController(),
        reason: null,
        revision: captured,
        done: new Promise<PipelineReview>((resolve) => {
          complete = resolve;
        }),
      };
      active = job;
      ownedJobs++;
      const settle = (review: PipelineReview) => {
        complete(review);
        ownedJobs--;
        if (active === job) active = null;
      };
      void execute(job, options, previous).then(settle, () =>
        settle({
          status: 'failed',
          publishable: false,
          catalogRevision: job.revision,
          scan: blankScan(options, job.revision),
          observations: [],
          enrichment: [],
          allNotCheckedKeys: [],
          unenrichedKeys: [],
          error: 'Collection lifecycle could not finish safely. Previous data was retained.',
        }),
      );
      return job.done;
    },
    async cancel() {
      const owned = active;
      if (!owned) return;
      abort(owned, 'canceled');
      await owned.done;
    },
  };
}
/** Publication remains separate; this returns reviewed data only, never writes it. */
export function stagePipelineSelection(
  review: PipelineReview,
  keys: readonly string[],
  currentRevision: string,
): StagedScanSelection {
  if (
    !review.publishable ||
    review.status !== 'review' ||
    review.catalogRevision !== currentRevision
  )
    throw new Error('This collection job is incomplete or obsolete. Scan again before saving.');
  return stageScanSelection(review.scan, keys, currentRevision);
}
