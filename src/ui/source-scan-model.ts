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

/**
 * The scan screen's types, failures and the comparisons used when a saved
 * scan is resumed. Re-exported by source-scan.ts.
 */
import { type createBoundedScanResumeService } from '../application/bounded-scan-resume-service';
import { type ScanPreparationFailureCode } from '../discovery/selection-failure';
import {
  type ReviewCandidate,
  type ScanReview,
  type ScanSource,
  type StagedScanSelection,
} from '../discovery/scan';
import { type HealthObservation } from '../discovery/health';
import {
  type SavedScanCheckpoint,
  type ScanCheckpoint,
  type ScanCheckpointMutation,
} from '../discovery/scan-checkpoint';
import {
  type ChannelCandidate,
  type ParsedPlaylist,
  type ReconciliationScope,
  type Source,
} from '../catalog/parser';
import { type ReviewedScanHealthContext } from '../discovery/prepare-selection';
import { type GuideEnrichment, type RegisteredGuide } from '../discovery/pipeline';
import { type SavedHealthPage, type SavedHealthQuery } from '../application/health-history';

/** First fixed error code in an error or its causes (native failures are codes); never free text. */
export function scanFailureCode(failure: unknown): string {
  for (let current: unknown = failure, depth = 0; current !== undefined && depth < 4; depth++) {
    const value = current instanceof Error ? current.message : current;
    if (typeof value === 'string' && /^[a-z0-9][a-z0-9-]{1,63}$/u.test(value)) return value;
    if (current instanceof DOMException && current.name === 'AbortError') return 'aborted';
    current = current instanceof Error ? current.cause : undefined;
  }
  return 'unclassified';
}

export type BoundedSourceScanResume = ReturnType<typeof createBoundedScanResumeService>;

export type HealthCheckBudgetMs = 20000 | 45000 | 60000;

export type ScanFailure =
  | 'none'
  | 'catalog-cas'
  | 'configuration-changed'
  | 'cancel-ack'
  | 'capacity'
  | 'publish-failed'
  | 'canceled'
  | 'other';

export interface SourceScanSnapshot {
  readonly schemaVersion: 1;
  readonly phase:
    | 'idle'
    | 'collecting'
    | 'checking'
    | 'publishing'
    | 'paused'
    | 'completed'
    | 'failed'
    | 'disposed';
  readonly total: number;
  readonly checked: number;
  readonly responded: number;
  /** Responding candidate entries with an acknowledged receipt, not unique added catalog rows. */
  readonly published: number;
  readonly lastFailure: ScanFailure;
  /** Bounded internal error code for event history (never text, addresses or names). */
  readonly lastFailureCode?: string;
  readonly preparationFailure?: ScanPreparationFailureCode;
  readonly generation: number;
  readonly busy: boolean;
  /** Actual unsettled host.commit calls; not probes or queued observations. */
  readonly pendingPublications: number;
}

/** Only exact owned messages/codes qualify; payloads and unrecognized errors stay private. */
export function classifyScanFailure(failure: unknown, publication = false): ScanFailure {
  const value =
    typeof failure === 'string' ? failure : failure instanceof Error ? failure.message : '';
  if (
    [
      'catalog-revision-stale',
      'health-revision-stale',
      'checkpoint-revision-stale',
      'Saved catalog changed. Review again before saving.',
      'Saved health changed. Review again before saving.',
      'Saved checkpoint changed. Review again before saving.',
      'Saved data changed. Review again before saving.',
      'Saved channels changed. Rescan before continuing.',
      'Saved channels changed. Scan again before saving.',
      'Saved channels changed. Reopen the app and scan again.',
      'Collection snapshot is obsolete.',
    ].includes(value)
  )
    return 'catalog-cas';
  if (
    [
      'Scan changed',
      'Scan checkpoint changed',
      'Health observer changed',
      'The health observer changed. Check the selection again.',
      'The reviewed source changed. Scan again.',
      'The scan changed. Start it again.',
      'Channel check result is obsolete or belongs to another platform.',
      'Channel check result belongs to another source or candidate.',
    ].includes(value)
  )
    return 'configuration-changed';
  if (
    [
      'Channel check cancellation could not be confirmed.',
      'Program guide cancellation could not be confirmed.',
    ].includes(value)
  )
    return 'cancel-ack';
  if (
    [
      'record-too-large',
      'record-array-too-large',
      'scan-checkpoint-too-large',
      'scan-checkpoint-target-validation-limit',
      'Record exceeds its storage bounds.',
      'Paired records exceed their separate storage bounds.',
      'Record exceeds its separate storage bounds.',
      'Health exceeds its separate storage bounds.',
      'Scan checkpoint exceeds its storage bounds.',
      'Playlist exceeds the 20 MiB limit.',
      'Keep at most 100 saved and discovery sources for one scan.',
      'Automatic channel check scope is invalid or exceeds 100,000 channels.',
    ].includes(value)
  )
    return 'capacity';
  if (
    (failure instanceof Error || failure instanceof DOMException) &&
    failure.name === 'AbortError'
  )
    return 'canceled';
  if (
    publication ||
    [
      'Missing durable receipt',
      'Missing durable receipt.',
      'Missing checkpoint receipt',
      'Storage could not confirm the save. Check available storage and review again.',
      'Channel save did not confirm scan progress.',
    ].includes(value)
  )
    return 'publish-failed';
  return 'other';
}

export interface AutomaticScanCheckpointSnapshot {
  jobId: string;
  createdAtMs: number;
  review: ScanReview;
  capturedSources: readonly ScanSource[];
  budgetMs: HealthCheckBudgetMs;
  platform: string;
  observerProfile: string;
  observations: HealthObservation[];
  publishedKeys: string[];
  catalogRevision: string;
}

export interface ScanCheckpointCommitContext {
  mutation: ScanCheckpointMutation;
  expectedCheckpointRevision: string;
}

export interface SourceScanCheckpointHost {
  /** Root validates durable current catalog/policy before returning a valid checkpoint. */
  load(signal: AbortSignal): Promise<SavedScanCheckpoint & { parsed?: ScanCheckpoint }>;
  /** Preparation runs off the UI thread; null explicitly admits a RAM-only scan. */
  /** Synchronously captures the immutable review and copied membership arrays before returning. */
  prepare(snapshot: AutomaticScanCheckpointSnapshot, signal: AbortSignal): Promise<string | null>;
  /** Negotiated native progress updates omit the immutable review after its first ACK. */
  prepareMutation?(
    snapshot: AutomaticScanCheckpointSnapshot,
    signal: AbortSignal,
    expectedCheckpointRevision: string,
    publicationLimit?: 64 | 256,
    publicationKeys?: readonly string[],
  ): Promise<ScanCheckpointMutation | null>;
  saveMutation?(
    mutation: ScanCheckpointMutation,
    catalogRevision: string,
    checkpointRevision: string,
    signal: AbortSignal,
  ): Promise<{ committed: true; checkpointRevision: string }>;
  /** Called only for the exact submitted mutation after an actual durable receipt. */
  acknowledgeMutation?(mutation: ScanCheckpointMutation, checkpointRevision: string): void;
  save(
    checkpoint: string,
    catalogRevision: string,
    checkpointRevision: string,
    signal: AbortSignal,
  ): Promise<{ committed: true; checkpointRevision: string }>;
  discard(
    jobId: string,
    catalogRevision: string,
    checkpointRevision: string,
    signal: AbortSignal,
  ): Promise<{ committed: true; checkpointRevision: string }>;
}

/** Freeze one owned capture instead of cloning the full review for every publication. */
export function freezeCapture<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freezeCapture(child, seen);
    Object.freeze(value);
  }
  return value;
}

export interface SourceScanSelectionEpisodeContext {
  readonly generation: number;
  readonly revision: string;
  readonly capturedSources: readonly ScanSource[];
  readonly reconciliationScopes: ReadonlyMap<string, ReconciliationScope>;
}

export interface SourceScanSelectionEpisode {
  readonly episodeId: string;
  readonly supportsWindow?: boolean;
  dispose(): Promise<void>;
}

export interface SourceScanPublicationChunk {
  readonly staged: StagedScanSelection;
  readonly health?: ReviewedScanHealthContext;
}

/** Only a known pre-dispatch wire-size refusal; never use for uncertain native work. */
export class SourceScanWindowSizeError extends Error {
  constructor() {
    super('Scan publication window exceeds its wire bound.');
    this.name = 'SourceScanWindowSizeError';
  }
}

export interface SourceScanHost {
  indexedFreshAvailable?(): boolean;
  createIndexedFreshResume?(
    scope: {
      sources?: readonly ScanSource[];
      query: string;
      budgetMs: HealthCheckBudgetMs;
      /** 'slow': the Slow list only, from the sources as last read. */
      intent: 'refresh' | 'full-recheck' | 'slow';
    },
    signal: AbortSignal,
  ): Promise<{ service: BoundedSourceScanResume | null }>;
  /** Null only before native admission: unsupported capability or a legacy saved format.
   * An enabled bounded admission failure must never fall back to fullgraph recovery. */
  createBoundedResume?(
    scope: { jobId: string | null; checkpointRevision?: string; query?: string },
    signal: AbortSignal,
  ): Promise<BoundedSourceScanResume | null>;
  /** One terminal failed-generation notification; diagnostics cannot alter scan ownership. */
  onDiagnostic?(snapshot: Readonly<SourceScanSnapshot>): void;
  onProgress?(progress: Readonly<AutomaticScanProgress>): void;
  capture(sources?: readonly ScanSource[]): { revision: string; sources: readonly ScanSource[] };
  revision(): string;
  prioritize?(review: ScanReview): ScanReview;
  /** Published alternate names for query matching only. */
  aliases?(channel: ChannelCandidate): readonly string[];
  collect(source: Source, signal: AbortSignal): Promise<ParsedPlaylist>;
  /** Runs only after every collection reader/parser has actually settled. */
  onCollectionSettled?(): void;
  /** Failed setup must join its own partial resources before rejecting. */
  beginSelectionEpisode?(
    context: SourceScanSelectionEpisodeContext,
    signal: AbortSignal,
  ): Promise<SourceScanSelectionEpisode | null>;
  /** Reads the captured immutable file and parses off-thread; never inspects remote URLs. */
  readFileSnapshot?(file: File, source: Source, signal: AbortSignal): Promise<ParsedPlaylist>;
  /** Final revision CAS and selected add/update publication belong to this owner. */
  commit(
    staged: StagedScanSelection,
    revision: string,
    signal: AbortSignal,
    health?: ReviewedScanHealthContext,
    checkpoint?: ScanCheckpointCommitContext,
    episodeId?: string,
  ): Promise<{ committed: true; revision: string; checkpointRevision?: string }>;
  /** One atomic receipt for ordered 1..4 logical chunks, each at most 64 entries. */
  commitWindow?(
    chunks: readonly SourceScanPublicationChunk[],
    revision: string,
    signal: AbortSignal,
    checkpoint?: ScanCheckpointCommitContext,
    episodeId?: string,
  ): Promise<{ committed: true; revision: string; checkpointRevision?: string }>;
  checkpoint?: SourceScanCheckpointHost;
  activity?(active: boolean): void;
  probe?(
    candidate: ReviewCandidate,
    signal: AbortSignal,
    budgetMs?: HealthCheckBudgetMs,
  ): Promise<HealthObservation>;
  guides?(signal: AbortSignal): Promise<RegisteredGuide[]>;
  enrich?(
    candidate: ReviewCandidate,
    guides: readonly RegisteredGuide[],
    signal: AbortSignal,
  ): Promise<GuideEnrichment[]>;
  platform?(): string;
  observerProfile?(budgetMs?: HealthCheckBudgetMs): string;
  now?(): number;
  openGuide?(candidate: ReviewCandidate): void;
  savedHealth?(
    query: SavedHealthQuery & { signal: AbortSignal; budgetMs: HealthCheckBudgetMs },
  ): Promise<SavedHealthPage>;
}

export type ScanResumeRefusal = 'missing' | 'completed' | 'changed' | 'unavailable';

/** Continue refused because channel sources were refreshed, imported or removed
 *  after the scan paused: its saved checks no longer match those sources. */
export class ScanSourcesChanged extends Error {
  constructor() {
    super('Your channel sources were updated after this scan paused.');
  }
}

/** A native Continue refusal because the scan's sources or their grants changed. */
export const sourcesChangedRefusal = (code: string | null | undefined, error: unknown) =>
  /^scan-checkpoint-(policy-stale|source-not-resumable)$/.test(code ?? '')
    ? new ScanSourcesChanged()
    : error;

export interface AutomaticScanOptions {
  /** 'slow' checks the Slow list (streams the 3-second triage left) in the background. */
  intent?: 'start' | 'continue' | 'full-recheck' | 'slow';
  query?: string;
  presentation?: 'inline' | 'dialog';
}

export interface AutomaticScanProgress extends SourceScanSnapshot {
  /** A saved job exists; native admission still validates it when Continue is pressed. */
  canContinue: boolean;
  resumeRefusal?: ScanResumeRefusal;
  /** Cold saved-state display only; never a runtime Resume authority. */
  savedSummary?: 'unfinished' | 'completed' | 'invalid';
  /** This run is the background check of the Slow list. */
  slowPass?: true;
  /** Which kind of run this is, for the panel: Refresh (due channels only),
   * Rescan (everything again), the Slow list, or finishing a saved scan. */
  scanKind?: 'refresh' | 'rescan' | 'slow' | 'continue';
  query: string;
  presentation: 'inline' | 'dialog';
  status: string;
  error: string;
  scopeRefusal: 'query-changed' | null;
}

export function normalizedScanQuery(value: string): string {
  if (typeof value !== 'string' || value.length > 256) throw new Error('Scan query is invalid.');
  const query = value.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (query.length > 256) throw new Error('Scan query is invalid.');
  return query;
}

export type AutomaticScanEntry = 'fresh' | 'unfinished' | 'completed' | 'unavailable' | 'running';
